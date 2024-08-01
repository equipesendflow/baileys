import { Boom } from '@hapi/boom';
import NodeCache from 'node-cache';
import { proto } from '../../WAProto';
import { DEFAULT_CACHE_TTLS, WA_DEFAULT_EPHEMERAL } from '../Defaults';
import {
	AnyMessageContent,
	MediaConnInfo,
	MessageReceiptType,
	MessageRelayOptions,
	MiscMessageGenerationOptions,
	SocketConfig,
	WAMessageKey,
} from '../Types';
import {
	aggregateMessageKeysNotFromMe,
	assertMediaContent,
	bindWaitForEvent,
	decryptMediaRetryData,
	encodeSignedDeviceIdentity,
	encodeWAMessage,
	encryptMediaRetryRequest,
	extractDeviceJids,
	generateMessageID,
	generateWAMessage,
	getStatusCodeForMediaRetry,
	getUrlFromDirectPath,
	getWAUploadToServer,
	parseAndInjectE2ESessions,
	participantListHashV2,
	unixTimestampSeconds,
} from '../Utils';
import { getUrlInfo } from '../Utils/link-preview';
import {
	areJidsSameUser,
	BinaryNode,
	BinaryNodeAttributes,
	getBinaryNodeChild,
	getBinaryNodeChildren,
	isJidGroup,
	isJidUser,
	jidDecode,
	jidEncode,
	jidNormalizedUser,
	jidToSignalProtocolAddress,
	JidWithDevice,
	S_WHATSAPP_NET,
} from '../WABinary';
import { makeGroupsSocket } from './groups';
import ListType = proto.ListMessage.ListType;
import { chunk } from '../Utils/utils';
import { asyncAll } from '../Utils/parallel';

export const makeMessagesSocket = (config: SocketConfig) => {
	const {
		logger,
		linkPreviewImageThumbnailWidth,
		generateHighQualityLinkPreview,
		options: axiosOptions,
		patchMessageBeforeSending,
		cachedGroupMetadata,
	} = config;
	const sock = makeGroupsSocket(config);
	const {
		ev,
		authState,
		processingMutex,
		signalRepository,
		upsertMessage,
		query,
		fetchPrivacySettings,
		generateMessageTag,
		sendNode,
		groupMetadata,
		groupToggleEphemeral,
	} = sock;

	const userDevicesCache =
		config.userDevicesCache ||
		new NodeCache({
			stdTTL: DEFAULT_CACHE_TTLS.USER_DEVICES, // 5 minutes
			useClones: false,
		});

	let mediaConn: Promise<MediaConnInfo>;
	const refreshMediaConn = async (forceGet = false) => {
		const media = await mediaConn;
		if (!media || forceGet || new Date().getTime() - media.fetchDate.getTime() > media.ttl * 1000) {
			mediaConn = (async () => {
				const result = await query({
					tag: 'iq',
					attrs: {
						type: 'set',
						xmlns: 'w:m',
						to: S_WHATSAPP_NET,
					},
					content: [{ tag: 'media_conn', attrs: {} }],
				});
				const mediaConnNode = getBinaryNodeChild(result, 'media_conn');
				const node: MediaConnInfo = {
					hosts: getBinaryNodeChildren(mediaConnNode, 'host').map(({ attrs }) => ({
						hostname: attrs.hostname,
						maxContentLengthBytes: +attrs.maxContentLengthBytes,
					})),
					auth: mediaConnNode!.attrs.auth,
					ttl: +mediaConnNode!.attrs.ttl,
					fetchDate: new Date(),
				};
				logger.debug('fetched media conn');
				return node;
			})();
		}

		return mediaConn;
	};

	/**
	 * generic send receipt function
	 * used for receipts of phone call, read, delivery etc.
	 * */
	const sendReceipt = async (
		jid: string,
		participant: string | undefined,
		messageIds: string[],
		type: MessageReceiptType,
	) => {
		const node: BinaryNode = {
			tag: 'receipt',
			attrs: {
				id: messageIds[0],
			},
		};
		const isReadReceipt = type === 'read' || type === 'read-self';
		if (isReadReceipt) {
			node.attrs.t = unixTimestampSeconds().toString();
		}

		if (type === 'sender' && isJidUser(jid)) {
			node.attrs.recipient = jid;
			node.attrs.to = participant!;
		} else {
			node.attrs.to = jid;
			if (participant) {
				node.attrs.participant = participant;
			}
		}

		if (type) {
			node.attrs.type = type;
		}

		const remainingMessageIds = messageIds.slice(1);
		if (remainingMessageIds.length) {
			node.content = [
				{
					tag: 'list',
					attrs: {},
					content: remainingMessageIds.map(id => ({
						tag: 'item',
						attrs: { id },
					})),
				},
			];
		}

		logger.debug({ attrs: node.attrs, messageIds }, 'sending receipt for messages');
		await sendNode(node).catch(e => logger.error(e, 'failed to send receipt'));
	};

	/** Correctly bulk send receipts to multiple chats, participants */
	const sendReceipts = async (keys: WAMessageKey[], type: MessageReceiptType) => {
		const recps = aggregateMessageKeysNotFromMe(keys);
		for (const { jid, participant, messageIds } of recps) {
			await sendReceipt(jid, participant, messageIds, type);
		}
	};

	/** Bulk read messages. Keys can be from different chats & participants */
	const readMessages = async (keys: WAMessageKey[]) => {
		const privacySettings = await fetchPrivacySettings();
		// based on privacy settings, we have to change the read type
		const readType = privacySettings.readreceipts === 'all' ? 'read' : 'read-self';
		await sendReceipts(keys, readType);
	};

	/** Fetch all the devices we've to send a message to */
	const getUSyncDevices = async (
		jids: string[],
		deviceResults: string[],
		useCache: boolean,
		ignoreZeroDevices: boolean,
	) => {
		const users: BinaryNode[] = [];

		for (let jid of jids) {
			if (useCache) {
				const devices = userDevicesCache.get<string[]>(jid);

				if (devices?.length) {
					deviceResults.push(...devices);

					continue;
				}

				// if (devices?.length) {
				// 	const phash = participantListHashV2(devices || []);
				// 	users.push({
				// 		tag: 'user',
				// 		attrs: { jid },
				// 		content: [
				// 			{
				// 				tag: 'devices',
				// 				attrs: {
				// 					device_hash: phash,
				// 				},
				// 			},
				// 		],
				// 	});
				// }
			}

			users.push({ tag: 'user', attrs: { jid } });
		}

		const iq: BinaryNode = {
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'get',
				xmlns: 'usync',
			},
			content: [
				{
					tag: 'usync',
					attrs: {
						sid: generateMessageTag(),
						mode: 'query',
						last: 'true',
						index: '0',
						context: 'message',
					},
					content: [
						{
							tag: 'query',
							attrs: {},
							content: [
								{
									tag: 'devices',
									attrs: { version: '2' },
								},
							],
						},
						{ tag: 'list', attrs: {}, content: users },
					],
				},
			],
		};

		const result = await query(iq);

		const { user: meUser, device: meDevice } = jidDecode(authState.creds.me!.id)!;

		for (const node of result.content as BinaryNode[]) {
			const list = getBinaryNodeChild(node, 'list')?.content;

			if (!Array.isArray(list)) continue;

			for (const item of list) {
				const jid = item.attrs.jid;
				const user = jid.split('@')[0];
				const devicesNode = getBinaryNodeChild(item, 'devices');
				const deviceListNode = getBinaryNodeChild(devicesNode, 'device-list');

				if (!Array.isArray(deviceListNode?.content)) continue;

				const devices: string[] = [];

				for (const node of deviceListNode!.content) {
					if (node.tag !== 'device') continue;

					const device = +node.attrs.id;

					// ensure that "key-index" is specified for "non-zero" devices, produces a bad req otherwise
					if (device !== 0 && !node.attrs['key-index']) continue;
					if (ignoreZeroDevices && device === 0) continue;
					if (user === meUser && device === meDevice) continue;

					devices.push(jidEncode(user, 's.whatsapp.net', device));
				}

				if (devices.length === 0) continue;

				userDevicesCache.set(jid, devices);
				deviceResults.push(...devices);
			}
		}

		return deviceResults;
	};

	const getJidsRequiringFetch = async (jids: string[], force: boolean) => {
		if (force) return jids;

		const jidsRequiringFetch: string[] = [];

		await asyncAll(
			jids.map(async jid => {
				const signalId = jidToSignalProtocolAddress(jid);

				const sessions = await authState.keys.get('session', [signalId]);

				if (sessions[signalId]) return;

				jidsRequiringFetch.push(jid);
			}),
		);

		return jidsRequiringFetch;
	};

	const assertSessions = async (jids: string[], force: boolean) => {
		const jidsRequiringFetch = await getJidsRequiringFetch(jids, force);

		const chunks = chunk(jidsRequiringFetch, 200, 0.5);

		await Promise.all(
			chunks.map(async ls => {
				const result = await query({
					tag: 'iq',
					attrs: {
						xmlns: 'encrypt',
						type: 'get',
						to: S_WHATSAPP_NET,
					},
					content: [
						{
							tag: 'key',
							attrs: {},
							content: ls.map(jid => ({
								tag: 'user',
								attrs: { jid },
							})),
						},
					],
				});

				await parseAndInjectE2ESessions(result, signalRepository);
			}),
		);
	};

	const createParticipantNodes = async (
		jids: string[],
		message: proto.IMessage,
		extraAttrs?: BinaryNode['attrs'],
	) => {
		const data = encodeWAMessage(message);

		let shouldIncludeDeviceIdentity = false;

		const nodes = await Promise.all(
			jids.map(async jid => {
				const { type, ciphertext } = await signalRepository.encryptMessage({ jid, data });

				if (type === 'pkmsg') {
					shouldIncludeDeviceIdentity = true;
				}

				const node: BinaryNode = {
					tag: 'to',
					attrs: { jid },
					content: [
						{
							tag: 'enc',
							attrs: {
								v: '2',
								type,
								...(extraAttrs || {}),
							},
							content: ciphertext,
						},
					],
				};

				return node;
			}),
		);

		return { nodes, shouldIncludeDeviceIdentity };
	};

	const relayMessage = async (jid: string, message: proto.IMessage, options: MessageRelayOptions) => {
		let { messageId: msgId, participant, additionalAttributes, useUserDevicesCache } = options;

		const meId = authState.creds.me!.id;

		const { user: myUser } = jidDecode(meId)!;

		let shouldIncludeDeviceIdentity = false;

		const { user, server } = jidDecode(jid)!;
		const isGroup = server === 'g.us';
		msgId = msgId || generateMessageID();
		useUserDevicesCache = useUserDevicesCache !== false;

		const participants: BinaryNode[] = [];
		const destinationJid = jidEncode(user, isGroup ? 'g.us' : 's.whatsapp.net');
		const binaryNodeContent: BinaryNode[] = [];
		const devices: string[] = [];

		if (participant) {
			// when the retry request is not for a group
			// only send to the specific device that asked for a retry
			// otherwise the message is sent out to every device that should be a recipient
			if (!isGroup) {
				additionalAttributes = { ...additionalAttributes, device_fanout: 'false' };
			}

			devices.push(participant.jid);
		}

		const mediaType = getMediaType(message);

		if (isGroup) {
			const [_, senderKeyMap, { ciphertext, senderKeyDistributionMessage }] = await Promise.all([
				(async () => {
					if (participant) return;
					if (!cachedGroupMetadata) return;

					const groupData = await cachedGroupMetadata(jid, !useUserDevicesCache);

					if (!groupData) {
						throw new Error('group data not found.');
					}

					const participantsList = groupData.participants.map(p => p.id);

					await getUSyncDevices(participantsList, devices, true, false);
				})(),
				(async () => {
					if (participant) {
						return {};
					}

					const result = await authState.keys.get('sender-key-memory', [jid]);
					return result[jid] || {};
				})(),
				(async () => {
					const bytes = encodeWAMessage(message);

					const { ciphertext, senderKeyDistributionMessage } =
						await signalRepository.encryptGroupMessage({
							group: destinationJid,
							data: bytes,
							meId,
						});

					return { ciphertext, senderKeyDistributionMessage };
				})(),
			]);

			const senderKeyJids: string[] = participant ? devices : [];

			if (!participant) {
				// ensure a connection is established with every device
				for (const jid of devices) {
					if (senderKeyMap[jid]) continue;

					senderKeyJids.push(jid);

					// store that this person has had the sender keys sent to them
					senderKeyMap[jid] = true;
				}
			}

			// if there are some participants with whom the session has not been established
			// if there are, we re-send the senderkey
			if (senderKeyJids.length) {
				const senderKeyMsg: proto.IMessage = {
					senderKeyDistributionMessage: {
						axolotlSenderKeyDistributionMessage: senderKeyDistributionMessage,
						groupId: destinationJid,
					},
				};

				if (participant) {
					message.senderKeyDistributionMessage = senderKeyMsg.senderKeyDistributionMessage;
				}

				await assertSessions(senderKeyJids, false);

				const result = await createParticipantNodes(
					senderKeyJids,
					participant ? message : senderKeyMsg,
					mediaType ? { mediatype: mediaType } : undefined,
				);

				shouldIncludeDeviceIdentity ||= result.shouldIncludeDeviceIdentity;

				participants.push(...result.nodes);
			}

			if (!participant) {
				const enc: BinaryNode = {
					tag: 'enc',
					attrs: { v: '2', type: 'skmsg' },
					content: ciphertext,
				};

				binaryNodeContent.push(enc);
			}

			if (!participant) {
				authState.keys.set({ 'sender-key-memory': { [jid]: senderKeyMap } });
			}
		} else {
			if (!participant) {
				devices.push(jid);
				devices.push(jidEncode(myUser, 's.whatsapp.net'));

				await getUSyncDevices(devices, devices, !!useUserDevicesCache, true);
			}

			const allJids: string[] = [];
			const meJids: string[] = [];
			const otherJids: string[] = [];

			for (const jid of devices) {
				const isMe = jidDecode(jid)?.user === myUser;

				if (isMe) {
					meJids.push(jid);
				} else {
					otherJids.push(jid);
				}

				allJids.push(jid);
			}

			await assertSessions(allJids, false);

			const meMsg: proto.IMessage = {
				deviceSentMessage: {
					destinationJid,
					message,
				},
			};

			const [
				{ nodes: meNodes, shouldIncludeDeviceIdentity: s1 },
				{ nodes: otherNodes, shouldIncludeDeviceIdentity: s2 },
			] = await Promise.all([
				createParticipantNodes(meJids, meMsg, mediaType ? { mediatype: mediaType } : undefined),
				createParticipantNodes(otherJids, message, mediaType ? { mediatype: mediaType } : undefined),
			]);

			participants.push(...meNodes);
			participants.push(...otherNodes);

			shouldIncludeDeviceIdentity = shouldIncludeDeviceIdentity || s1 || s2;
		}

		if (participants.length === 1 && participant) {
			const enc = getBinaryNodeChild(participants[0], 'enc')!;
			enc.attrs.count = `${participant.count}`;
			binaryNodeContent.push(enc);
		} else if (participants.length) {
			binaryNodeContent.push({
				tag: 'participants',
				attrs: {},
				content: participants,
			});
		}

		const stanza: BinaryNode = {
			tag: 'message',
			attrs: {
				id: msgId!,
				type: 'text',
				...(additionalAttributes || {}),
			},
			content: binaryNodeContent,
		};

		if (isGroup) {
			stanza.attrs.addressing_mode = 'pn';
		}

		// if (phash) {
		// 	stanza.attrs.phash = phash;
		// }

		// if the participant to send to is explicitly specified (generally retry recp)
		// ensure the message is only sent to that person
		// if a retry receipt is sent to everyone -- it'll fail decryption for everyone else who received the msg
		if (participant) {
			if (isJidGroup(destinationJid)) {
				stanza.attrs.to = destinationJid;
				stanza.attrs.participant = participant.jid;
			} else if (areJidsSameUser(participant.jid, meId)) {
				stanza.attrs.to = participant.jid;
				stanza.attrs.recipient = destinationJid;
			} else {
				stanza.attrs.to = participant.jid;
			}
		} else {
			stanza.attrs.to = destinationJid;
		}

		if (shouldIncludeDeviceIdentity) {
			(stanza.content as BinaryNode[]).push({
				tag: 'device-identity',
				attrs: {},
				content: encodeSignedDeviceIdentity(authState.creds.account!, true),
			});
		}

		await sendNode(stanza);

		return msgId;
	};

	const getMessageType = (message: proto.IMessage) => {
		const mediaType = getMediaType(message);

		if (mediaType) {
			return 'media';
		} else if (message.reactionMessage) {
			return 'reaction';
		}

		return 'text';
	};

	const getMediaType = (message: proto.IMessage) => {
		if (message.imageMessage) {
			return 'image';
		} else if (message.videoMessage) {
			return message.videoMessage.gifPlayback ? 'gif' : 'video';
		} else if (message.audioMessage) {
			return message.audioMessage.ptt ? 'ptt' : 'audio';
		} else if (message.contactMessage) {
			return 'vcard';
		} else if (message.documentMessage) {
			return 'document';
		} else if (message.contactsArrayMessage) {
			return 'contact_array';
		} else if (message.liveLocationMessage) {
			return 'livelocation';
		} else if (message.stickerMessage) {
			return 'sticker';
		} else if (message.listMessage) {
			return 'list';
		} else if (message.listResponseMessage) {
			return 'list_response';
		} else if (message.buttonsResponseMessage) {
			return 'buttons_response';
		} else if (message.orderMessage) {
			return 'order';
		} else if (message.productMessage) {
			return 'product';
		} else if (message.interactiveResponseMessage) {
			return 'native_flow_response';
		}
	};

	const getButtonType = (message: proto.IMessage) => {
		if (message.buttonsMessage) {
			return 'buttons';
		} else if (message.buttonsResponseMessage) {
			return 'buttons_response';
		} else if (message.interactiveResponseMessage) {
			return 'interactive_response';
		} else if (message.listMessage) {
			return 'list';
		} else if (message.listResponseMessage) {
			return 'list_response';
		}
	};

	const getButtonArgs = (message: proto.IMessage): BinaryNode['attrs'] => {
		if (message.templateMessage) {
			// TODO: Add attributes
			return {};
		} else if (message.listMessage) {
			const type = message.listMessage.listType;
			if (!type) {
				throw new Boom('Expected list type inside message');
			}
			return { v: '2', type: ListType[type].toLowerCase() };
		} else {
			return {};
		}
	};

	const getPrivacyTokens = async (jids: string[]) => {
		const t = unixTimestampSeconds().toString();
		const result = await query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'set',
				xmlns: 'privacy',
			},
			content: [
				{
					tag: 'tokens',
					attrs: {},
					content: jids.map(jid => ({
						tag: 'token',
						attrs: {
							jid: jidNormalizedUser(jid),
							t,
							type: 'trusted_contact',
						},
					})),
				},
			],
		});

		return result;
	};

	const waUploadToServer = getWAUploadToServer(config, refreshMediaConn);

	const waitForMsgMediaUpdate = bindWaitForEvent(ev, 'messages.media-update');

	return {
		...sock,
		getUSyncDevices,
		getPrivacyTokens,
		assertSessions,
		relayMessage,
		sendReceipt,
		sendReceipts,
		readMessages,
		refreshMediaConn,
		waUploadToServer,
		fetchPrivacySettings,
		updateMediaMessage: async (message: proto.IWebMessageInfo) => {
			const content = assertMediaContent(message.message);
			const mediaKey = content.mediaKey!;
			const meId = authState.creds.me!.id;
			const node = encryptMediaRetryRequest(message.key, mediaKey, meId);

			let error: Error | undefined = undefined;
			await Promise.all([
				sendNode(node),
				waitForMsgMediaUpdate(update => {
					const result = update.find(c => c.key.id === message.key.id);
					if (result) {
						if (result.error) {
							error = result.error;
						} else {
							try {
								const media = decryptMediaRetryData(result.media!, mediaKey, result.key.id!);
								if (media.result !== proto.MediaRetryNotification.ResultType.SUCCESS) {
									const resultStr = proto.MediaRetryNotification.ResultType[media.result];
									throw new Boom(`Media re-upload failed by device (${resultStr})`, {
										data: media,
										statusCode: getStatusCodeForMediaRetry(media.result) || 404,
									});
								}

								content.directPath = media.directPath;
								content.url = getUrlFromDirectPath(content.directPath!);

								logger.debug(
									{ directPath: media.directPath, key: result.key },
									'media update successful',
								);
							} catch (err) {
								error = err;
							}
						}

						return true;
					}
				}),
			]);

			if (error) {
				throw error;
			}

			ev.emit('messages.update', [{ key: message.key, update: { message: message.message } }]);

			return message;
		},
		sendMessage: async (
			jid: string,
			content: AnyMessageContent,
			options: MiscMessageGenerationOptions = {},
		) => {
			const userJid = authState.creds.me!.id;
			if (
				typeof content === 'object' &&
				'disappearingMessagesInChat' in content &&
				typeof content['disappearingMessagesInChat'] !== 'undefined' &&
				isJidGroup(jid)
			) {
				const { disappearingMessagesInChat } = content;
				const value =
					typeof disappearingMessagesInChat === 'boolean'
						? disappearingMessagesInChat
							? WA_DEFAULT_EPHEMERAL
							: 0
						: disappearingMessagesInChat;
				await groupToggleEphemeral(jid, value);
			} else {
				const fullMsg = await generateWAMessage(jid, content, {
					logger,
					userJid,
					getUrlInfo: async text => {
						if (!options.detectLinks) {
							return undefined;
						}

						return getUrlInfo(text, {
							thumbnailWidth: linkPreviewImageThumbnailWidth,
							fetchOpts: {
								timeout: 3_000,
								...(axiosOptions || {}),
							},
							logger,
							uploadImage: generateHighQualityLinkPreview ? waUploadToServer : undefined,
						});
					},
					upload: waUploadToServer,
					mediaCache: config.mediaCache,
					options: config.options,
					...options,
				});
				const isDeleteMsg = 'delete' in content && !!content.delete;
				const isEditMsg = 'edit' in content && !!content.edit;
				const isPinMsg = 'pin' in content && !!content.pin;

				const additionalAttributes: BinaryNodeAttributes = {};

				// required for delete
				if (isDeleteMsg) {
					// if the chat is a group, and I am not the author, then delete the message as an admin
					if (isJidGroup(content.delete?.remoteJid as string) && !content.delete?.fromMe) {
						additionalAttributes.edit = '8';
					} else {
						additionalAttributes.edit = '7';
					}
				} else if (isEditMsg) {
					additionalAttributes.edit = '1';
				} else if (isPinMsg) {
					additionalAttributes.edit = '1';
				}

				await relayMessage(jid, fullMsg.message!, {
					messageId: fullMsg.key.id!,
					cachedGroupMetadata: options.cachedGroupMetadata,
					additionalAttributes,
				});
				if (config.emitOwnEvents) {
					process.nextTick(() => {
						processingMutex.mutex(() => upsertMessage(fullMsg, 'append'));
					});
				}

				return fullMsg;
			}
		},
		prepareMessage: async (
			jid: string,
			content: AnyMessageContent,
			options: MiscMessageGenerationOptions = {},
		) => {
			const userJid = authState.creds.me!.id;

			const fullMsg = await generateWAMessage(jid, content, {
				logger,
				userJid,
				upload: waUploadToServer,
				mediaCache: config.mediaCache,
				options: config.options,
				...options,
			});

			return fullMsg;
		},
	};
};
