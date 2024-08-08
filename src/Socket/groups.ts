import { proto } from '../../WAProto';
import {
	GroupMetadata,
	GroupParticipant,
	ParticipantAction,
	SocketConfig,
	WAMessageKey,
	WAMessageStubType,
} from '../Types';
import { generateMessageID, unixTimestampSeconds } from '../Utils';
import {
	BinaryNode,
	getBinaryNodeChild,
	getBinaryNodeChildren,
	getBinaryNodeChildString,
	getBinaryNodeContentString,
	jidEncode,
	jidNormalizedUser,
} from '../WABinary';
import { makeChatsSocket } from './chats';

export const makeGroupsSocket = (config: SocketConfig) => {
	const sock = makeChatsSocket(config);
	const { authState, ev, query, upsertMessage } = sock;

	const groupQuery = async (jid: string, type: 'get' | 'set', content: BinaryNode[]) =>
		query({
			tag: 'iq',
			attrs: {
				type,
				xmlns: 'w:g2',
				to: jid,
			},
			content,
		});

	const groupMetadata = async (jid: string) => {
		const result = await groupQuery(jid, 'get', [{ tag: 'query', attrs: { request: 'interactive' } }]);
		return extractResultGroupMetadata(result);
	};

	async function groupFetchAllParticipatingContent() {
		const result = await query({
			tag: 'iq',
			attrs: {
				to: '@g.us',
				xmlns: 'w:g2',
				type: 'get',
			},
			content: [
				{
					tag: 'participating',
					attrs: {},
					content: [
						{ tag: 'participants', attrs: {} },
						{ tag: 'description', attrs: {} },
					],
				},
			],
		});

		const groupsChild = getBinaryNodeChild(result, 'groups');

		if (!groupsChild?.content) return null;
		if (!Array.isArray(groupsChild?.content)) return null;

		return groupsChild.content;
	}

	async function groupFetchAllParticipating() {
		const content = await groupFetchAllParticipatingContent();

		if (!content) throw new Error('failed to fetch group content');

		const data: { [_: string]: GroupMetadata } = {};

		for (const groupNode of content) {
			if (groupNode.tag !== 'group') continue;
			if (groupNode.content === undefined) continue;

			const group = extractGroupMetadata(groupNode);

			data[group.id] = group;
		}

		return data;
	}

	return {
		...sock,
		groupMetadata,
		groupCreate: async (subject: string, participants: string[]) => {
			const key = generateMessageID();
			const result = await groupQuery('@g.us', 'set', [
				{
					tag: 'create',
					attrs: {
						subject,
						key,
					},
					content: participants.map(jid => ({
						tag: 'participant',
						attrs: { jid },
					})),
				},
			]);
			return extractResultGroupMetadata(result);
		},
		communityCreate: async (subject: string) => {
			const result = await groupQuery('g.us', 'set', [
				{
					tag: 'create',
					attrs: {
						subject,
					},
					content: [
						{
							tag: 'parent',
							attrs: {
								default_membership_approval_mode: 'request_required',
							},
						},
					],
				},
			]);

			return extractResultGroupMetadata(result);
		},
		communityGetSubGroups: async (jid: string) => {
			const result = await groupQuery(jid, 'get', [{ tag: 'sub_groups', attrs: {} }]);

			const subGroups = getBinaryNodeChild(result, 'sub_groups');

			const subGroupsGroups = getBinaryNodeChildren(subGroups, 'group');

			return subGroupsGroups.map(group => {
				return {
					id: group.attrs.id + '@g.us',
					subject: group.attrs.subject,
					subjectTime: group.attrs.s_t,
					size: group.attrs.size,
					default: !!getBinaryNodeChild(group, 'default_sub_group'),
				};
			});
		},
		communityDeactivate: async (jid: string) => {
			const result = await groupQuery(jid, 'set', [{ tag: 'delete_parent', attrs: {} }]);

			return getBinaryNodeChild(result, 'delete')?.attrs.reason;
		},
		groupLeave: async (id: string) => {
			await groupQuery('@g.us', 'set', [
				{
					tag: 'leave',
					attrs: {},
					content: [{ tag: 'group', attrs: { id } }],
				},
			]);
		},
		groupUpdateSubject: async (jid: string, subject: string) => {
			await groupQuery(jid, 'set', [
				{
					tag: 'subject',
					attrs: {},
					content: Buffer.from(subject, 'utf-8'),
				},
			]);
		},
		groupParticipantsUpdate: async (jid: string, participants: string[], action: ParticipantAction) => {
			const result = await groupQuery(jid, 'set', [
				{
					tag: action,
					attrs: {},
					content: participants.map(jid => ({
						tag: 'participant',
						attrs: { jid },
					})),
				},
			]);
			const node = getBinaryNodeChild(result, action);
			const participantsAffected = getBinaryNodeChildren(node!, 'participant');
			return participantsAffected.map(p => {
				return { status: p.attrs.error || '200', jid: p.attrs.jid };
			});
		},
		groupUpdateDescription: async (jid: string, description?: string) => {
			const metadata = await groupMetadata(jid);
			const prev = metadata.descId ?? null;

			await groupQuery(jid, 'set', [
				{
					tag: 'description',
					attrs: {
						...(description ? { id: generateMessageID() } : { delete: 'true' }),
						...(prev ? { prev } : {}),
					},
					content: description
						? [{ tag: 'body', attrs: {}, content: Buffer.from(description, 'utf-8') }]
						: undefined,
				},
			]);
		},
		groupInviteCode: async (jid: string) => {
			const result = await groupQuery(jid, 'get', [{ tag: 'invite', attrs: {} }]);
			const inviteNode = getBinaryNodeChild(result, 'invite');
			return inviteNode?.attrs.code;
		},
		groupRevokeInvite: async (jid: string) => {
			const result = await groupQuery(jid, 'set', [{ tag: 'invite', attrs: {} }]);
			const inviteNode = getBinaryNodeChild(result, 'invite');
			return inviteNode?.attrs.code;
		},
		groupAcceptInvite: async (code: string) => {
			const results = await groupQuery('@g.us', 'set', [{ tag: 'invite', attrs: { code } }]);
			const result = getBinaryNodeChild(results, 'group');
			return result?.attrs.jid;
		},
		/**
		 * accept a GroupInviteMessage
		 * @param key the key of the invite message, or optionally only provide the jid of the person who sent the invite
		 * @param inviteMessage the message to accept
		 */
		groupAcceptInviteV4: ev.createBufferedFunction(
			async (key: string | WAMessageKey, inviteMessage: proto.IGroupInviteMessage) => {
				key = typeof key === 'string' ? { remoteJid: key } : key;
				const results = await groupQuery(inviteMessage.groupJid!, 'set', [
					{
						tag: 'accept',
						attrs: {
							code: inviteMessage.inviteCode!,
							expiration: inviteMessage.inviteExpiration!.toString(),
							admin: key.remoteJid!,
						},
					},
				]);

				// if we have the full message key
				// update the invite message to be expired
				if (key.id) {
					// create new invite message that is expired
					inviteMessage = proto.GroupInviteMessage.fromObject(inviteMessage);
					inviteMessage.inviteExpiration = 0;
					inviteMessage.inviteCode = '';
					ev.emit('messages.update', [
						{
							key,
							update: {
								message: {
									groupInviteMessage: inviteMessage,
								},
							},
						},
					]);
				}

				// generate the group add message
				await upsertMessage(
					{
						key: {
							remoteJid: inviteMessage.groupJid,
							id: generateMessageID(),
							fromMe: false,
							participant: key.remoteJid,
						},
						messageStubType: WAMessageStubType.GROUP_PARTICIPANT_ADD,
						messageStubParameters: [authState.creds.me!.id],
						participant: key.remoteJid,
						messageTimestamp: unixTimestampSeconds(),
					},
					'notify',
				);

				return results.attrs.from;
			},
		),
		groupGetInviteInfo: async (code: string) => {
			const results = await groupQuery('@g.us', 'get', [{ tag: 'invite', attrs: { code } }]);
			return extractResultGroupMetadata(results);
		},
		groupToggleEphemeral: async (jid: string, ephemeralExpiration: number) => {
			const content: BinaryNode = ephemeralExpiration
				? { tag: 'ephemeral', attrs: { expiration: ephemeralExpiration.toString() } }
				: { tag: 'not_ephemeral', attrs: {} };
			await groupQuery(jid, 'set', [content]);
		},
		groupSettingUpdate: async (
			jid: string,
			setting: 'announcement' | 'not_announcement' | 'locked' | 'unlocked',
		) => {
			await groupQuery(jid, 'set', [{ tag: setting, attrs: {} }]);
		},
		groupFetchAllParticipatingContent,
		groupFetchAllParticipating,
	};
};

export const extractResultGroupMetadata = (result: BinaryNode) => {
	const group = getBinaryNodeChild(result, 'group')!;

	return extractGroupMetadata(group);
};

export const extractGroupMetadata = (group: BinaryNode) => {
	if (!Array.isArray(group?.content)) throw new Error('group node is not an array');

	const metadata = {
		id: group.attrs.id.includes('@') ? group.attrs.id : jidEncode(group.attrs.id, 'g.us'),
		subject: group.attrs.subject,
		subjectOwner: group.attrs.s_o,
		subjectTime: +group.attrs.s_t,
		creation: +group.attrs.creation,
		owner: group.attrs.creator ? jidNormalizedUser(group.attrs.creator) : undefined,
		restrict: false,
		announce: false,
		isCommunity: false,
		isCommunityAnnounce: false,
		joinApprovalMode: false,
		participants: [],
		memberAddMode: false,
	} as GroupMetadata;

	for (const node of group.content) {
		switch (node.tag) {
			case 'announcement':
				metadata.announce = true;
				break;
			case 'locked':
				metadata.restrict = true;
				break;
			case 'ephemeral':
				if (!node.attrs.expiration) continue;

				metadata.ephemeralDuration = +node.attrs.expiration;
				break;
			case 'participant':
				metadata.participants.push({
					id: node.attrs.jid,
					admin: (node.attrs.type || null) as GroupParticipant['admin'],
					lid: node.attrs.lid,
				});
				break;
			case 'description':
				metadata.desc = getBinaryNodeChildString(node, 'body');
				metadata.descId = node.attrs.id;
				break;
			case 'incognito':
				metadata.incognito = true;
				break;
			case 'default_sub_group':
				metadata.isCommunityAnnounce = true;
				break;
			case 'linked_parent':
				metadata.linkedParent = node.attrs.jid;
				break;
			case 'allow_non_admin_sub_group_creation':
				metadata.allowNonAdminSubGroupCreation = true;
				break;
			case 'membership_approval_mode':
				metadata.joinApprovalMode = true;
				break;
			case 'member_add_mode':
				metadata.memberAddMode = getBinaryNodeContentString(node) === 'all_member_add';
				break;
			case 'parent':
				metadata.isCommunity = true;

				if (node.attrs.default_membership_approval_mode) {
					metadata.joinApprovalMode = true;
				}

				break;
		}
	}

	metadata.size = metadata.participants.length;

	return metadata;
};

export const extractGroupId = (group: BinaryNode) => {
	return group.attrs.id.includes('@') ? group.attrs.id : jidEncode(group.attrs.id, 'g.us');
};
