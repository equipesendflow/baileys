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
	generateMessageID,
	generateWAMessage,
	getStatusCodeForMediaRetry,
	getUrlFromDirectPath,
	getWAUploadToServer,
	parseAndInjectE2ESessions,
	unixTimestampSeconds,
} from '../Utils';
import { getUrlInfo } from '../Utils/link-preview';
import {
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
	S_WHATSAPP_NET,
} from '../WABinary';
import { makeGroupsSocket } from './groups';
import { asyncAll, asyncDelay } from '../Utils/parallel';
import { startTimeTracker, trackTime, trackTimeCb } from '../Utils/time-tracker';
import { assert } from '../Utils/assert';

export const makeMessagesSocket = (config: SocketConfig) => {
	const {
		logger,
		linkPreviewImageThumbnailWidth,
		generateHighQualityLinkPreview,
		options: axiosOptions,
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
		groupToggleEphemeral,
	} = sock;

	const userDevicesCache =
		config.userDevicesCache ||
		new NodeCache({
			stdTTL: DEFAULT_CACHE_TTLS.USER_DEVICES, // 5 minutes
			useClones: false,
		});

	const meId = authState.creds.me!.id;
	const { user: meUser, device: meDevice } = jidDecode(meId)!;

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
	const getUSyncDevices = async (jids: string[]) => {
		const deviceResults: string[] = [];
		const users: BinaryNode[] = [];

		for (const jid of jids) {
			const devices = userDevicesCache.get<string[]>(jid);

			if (devices && devices.length > 0) {
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

			users.push({ tag: 'user', attrs: { jid } });
		}

		if (users.length === 0) {
			return deviceResults;
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
				const session = await authState.keys.getOne('session', jidToSignalProtocolAddress(jid));

				if (session) return;

				jidsRequiringFetch.push(jid);
			}),
		);

		return jidsRequiringFetch;
	};

	const assertSessions = async (jids: string[], force = false) => {
		const jidsRequiringFetch = await getJidsRequiringFetch(jids, force);

		if (!jidsRequiringFetch.length) return [];

		try {
			const result = await trackTime(
				'assertSessions query',
				query({
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
							content: jidsRequiringFetch.map(jid => ({
								tag: 'user',
								attrs: { jid },
							})),
						},
					],
				}),
			);

			const finish = startTimeTracker('parseAndInjectE2ESessions');

			await parseAndInjectE2ESessions(result, signalRepository);

			finish();

			console.log('injected jids', jidsRequiringFetch.length);
		} catch (e: any) {
			logger.error(e, 'Error on assertSessions');

			if (e.message === 'not-acceptable') return [];

			throw e;
		}
	};

	const getSenderKeyMap = async (jid: string) => {
		const result = await authState.keys.getOne('sender-key-memory', jid);

		return result || {};
	};

	const getDevices = async (jid: string, options: MessageRelayOptions) => {
		if (options?.participant) {
			return [options.participant.jid];
		}

		if (!jid.endsWith('g.us')) {
			return getUSyncDevices([jid, jidEncode(meUser, 's.whatsapp.net')]);
		}

		const senderKeyMap$ = getSenderKeyMap(jid);

		const groupData = await cachedGroupMetadata(jid);

		assert(groupData, 'group data not found.');

		const participantsList = new Array(groupData.participants.length);

		for (let i = 0; i < groupData.participants.length; i++) {
			participantsList[i] = groupData.participants[i].id;
		}

		const devices = await getUSyncDevices(participantsList);

		const senderKeyMap = await senderKeyMap$;

		const senderKeyJids: string[] = [];

		for (const jid of devices) {
			if (senderKeyMap[jid]) continue;

			senderKeyJids.push(jid);
		}

		return senderKeyJids;
	};

	const saveSenderKeyMemory = async (jid: string, devices: string[], options: MessageRelayOptions) => {
		if (options?.participant) return;
		if (!jid.endsWith('g.us')) return;

		const senderKeyMap = await getSenderKeyMap(jid);

		for (const jid of devices) {
			senderKeyMap[jid] = true;
		}

		await authState.keys.setOne('sender-key-memory', jid, senderKeyMap);
	};

	async function createParticipantNodes(
		stanza: BinaryNode & { content: [(BinaryNode & { content: BinaryNode[] })?, BinaryNode?] },
		devices: string[],
		getBytes: (jid: string) => Buffer,
		message: proto.IMessage,
		options: MessageRelayOptions,
	) {
		const mediatype = getMediaType(message);
		let shouldAddDeviceIdentity = false;
		const participants: BinaryNode[] = [];

		let i = 0;
		for (const jid of devices) {
			try {
				const result = await signalRepository.encryptMessage(jid, getBytes(jid));

				const encNode = makeEncNode(result.type, result.ciphertext);

				if (mediatype) {
					encNode.attrs.mediatype = mediatype;
				}

				if (options?.participant) {
					encNode.attrs.count = options.participant.count;
					stanza.content.push(encNode);
				} else {
					participants.push(makeToNode(jid, encNode));
				}

				if (result.type === 'pkmsg') {
					shouldAddDeviceIdentity = true;
				}
			} catch (e: any) {
				userDevicesCache.del(jidNormalizedUser(jid));

				if (e.message === 'No sessions' || e.message === 'No open session') return;

				logger.error(e, 'failed to encrypt message');
			}

			if (++i % 100 === 0) {
				await asyncDelay(1);
			}
		}

		if (!options?.participant && participants.length) {
			stanza.content.push({
				tag: 'participants',
				attrs: {},
				content: participants,
			});
		}

		if (shouldAddDeviceIdentity) {
			stanza.content.push({
				tag: 'device-identity',
				attrs: {},
				content: encodeSignedDeviceIdentity(authState.creds.account!, true),
			});
		}
	}

	async function createStanzaContent(
		jid: string,
		message: proto.IMessage,
		options: MessageRelayOptions,
		stanza: BinaryNode & { content: [(BinaryNode & { content: BinaryNode[] })?, BinaryNode?] },
		devices: string[],
	) {
		if (jid.endsWith('g.us')) {
			const result = await signalRepository.encryptGroupMessage(jid, meId, encodeWAMessage(message));

			function getSKMessage() {
				const senderKeyDistributionMessage = {
					axolotlSenderKeyDistributionMessage: result.senderKeyDistributionMessage,
					groupId: jid,
				};
				if (options?.participant) {
					message.senderKeyDistributionMessage = senderKeyDistributionMessage;
					return message;
				} else {
					stanza.content.push(makeEncNode('skmsg', result.ciphertext));
					return { senderKeyDistributionMessage };
				}
			}

			const data = encodeWAMessage(getSKMessage());

			return createParticipantNodes(stanza, devices, _jid => data, message, options);
		} else {
			const meMsgBytes = encodeWAMessage({
				deviceSentMessage: {
					destinationJid: jid,
					message,
				},
			});
			const messageBytes = encodeWAMessage(message);

			return createParticipantNodes(
				stanza,
				devices,
				jid => (jid.startsWith(meUser) ? meMsgBytes : messageBytes),
				message,
				options,
			);
		}
	}

	function makeStanza(jid: string, options: MessageRelayOptions) {
		const stanza: BinaryNode & { content: [(BinaryNode & { content: BinaryNode[] })?, BinaryNode?] } = {
			tag: 'message',
			attrs: {
				id: options?.messageId || generateMessageID(),
				type: 'text',
				to: jid,
				...options?.additionalAttributes,
			},
			content: [],
		};

		if (jid.endsWith('g.us')) {
			stanza.attrs.addressing_mode = 'pn';

			if (options?.participant) {
				stanza.attrs.participant = options.participant.jid;
			}
		} else {
			if (options?.participant) {
				stanza.attrs.device_fanout = 'false';
				stanza.attrs.to = options.participant.jid;

				if (options.participant.jid.startsWith(meUser)) {
					stanza.attrs.recipient = jid;
				}
			}
		}

		return stanza;
	}

	async function createStanza(
		jid: string,
		message: proto.IMessage,
		options: MessageRelayOptions,
		devices: string[],
	) {
		const stanza = makeStanza(jid, options);

		await createStanzaContent(jid, message, options, stanza, devices);

		return stanza;
	}

	const relayMessage = async (jid: string, message: proto.IMessage, options: MessageRelayOptions) => {
		const devices = await trackTime('getDevices', getDevices(jid, options));

		await trackTime('assertSessions', assertSessions(devices));

		const stanza = await trackTime('createStanza', createStanza(jid, message, options, devices));

		if (stanza.content.length === 0) {
			return null;
		}

		await sendNode(stanza);

		await saveSenderKeyMemory(jid, devices, options);

		return stanza.attrs.id;
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

function makeToNode(jid: string, node: BinaryNode): BinaryNode {
	return {
		tag: 'to',
		attrs: { jid },
		content: [node],
	};
}

function makeEncNode(type: string, content: Uint8Array): BinaryNode {
	return {
		tag: 'enc',
		attrs: {
			v: '2',
			type,
		},
		content,
	};
}
