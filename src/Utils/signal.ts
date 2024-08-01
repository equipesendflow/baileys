import { KEY_BUNDLE_TYPE } from '../Defaults';
import { SignalRepository } from '../Types';
import {
	AuthenticationCreds,
	AuthenticationState,
	KeyPair,
	SignalIdentity,
	SignalKeyStore,
	SignedKeyPair,
} from '../Types/Auth';
import {
	assertNodeErrorFree,
	BinaryNode,
	getBinaryNodeChild,
	getBinaryNodeChildBuffer,
	getBinaryNodeChildren,
	getBinaryNodeChildUInt,
	jidDecode,
	JidWithDevice,
	S_WHATSAPP_NET,
} from '../WABinary';
import { Curve, generateSignalPubKey } from './crypto';
import { encodeBigEndian } from './generics';
import { asyncAll } from './parallel';
import { chunk } from './utils';

export const createSignalIdentity = (wid: string, accountSignatureKey: Uint8Array): SignalIdentity => {
	return {
		identifier: { name: wid, deviceId: 0 },
		identifierKey: generateSignalPubKey(accountSignatureKey),
	};
};

export const getPreKeys = async ({ get }: SignalKeyStore, min: number, limit: number) => {
	const idList: string[] = [];
	for (let id = min; id < limit; id++) {
		idList.push(id.toString());
	}

	return get('pre-key', idList);
};

export const generateOrGetPreKeys = (creds: AuthenticationCreds, range: number) => {
	const avaliable = creds.nextPreKeyId - creds.firstUnuploadedPreKeyId;
	const remaining = range - avaliable;
	const lastPreKeyId = creds.nextPreKeyId + remaining - 1;
	const newPreKeys: { [id: number]: KeyPair } = {};
	if (remaining > 0) {
		for (let i = creds.nextPreKeyId; i <= lastPreKeyId; i++) {
			newPreKeys[i] = Curve.generateKeyPair();
		}
	}

	return {
		newPreKeys,
		lastPreKeyId,
		preKeysRange: [creds.firstUnuploadedPreKeyId, range] as const,
	};
};

export const xmppSignedPreKey = (key: SignedKeyPair): BinaryNode => ({
	tag: 'skey',
	attrs: {},
	content: [
		{ tag: 'id', attrs: {}, content: encodeBigEndian(key.keyId, 3) },
		{ tag: 'value', attrs: {}, content: key.keyPair.public },
		{ tag: 'signature', attrs: {}, content: key.signature },
	],
});

export const xmppPreKey = (pair: KeyPair, id: number): BinaryNode => ({
	tag: 'key',
	attrs: {},
	content: [
		{ tag: 'id', attrs: {}, content: encodeBigEndian(id, 3) },
		{ tag: 'value', attrs: {}, content: pair?.public },
	],
});

const extractKey = (key: BinaryNode) => {
	if (!key) return undefined;

	return {
		keyId: getBinaryNodeChildUInt(key, 'id', 3)!,
		publicKey: generateSignalPubKey(getBinaryNodeChildBuffer(key, 'value')!)!,
		signature: getBinaryNodeChildBuffer(key, 'signature')!,
	};
};

export const parseAndInjectE2ESessions = async (node: BinaryNode, repository: SignalRepository) => {
	const nodes = getBinaryNodeChildren(getBinaryNodeChild(node, 'list'), 'user');

	for (const node of nodes) {
		assertNodeErrorFree(node);
	}

	const chunks = chunk(nodes, 100);

	for (const nodesChunk of chunks) {
		await asyncAll(
			nodesChunk.map(async node => {
				const signedKey = getBinaryNodeChild(node, 'skey')!;
				const key = getBinaryNodeChild(node, 'key')!;
				const identity = getBinaryNodeChildBuffer(node, 'identity')!;
				const jid = node.attrs.jid;
				const registrationId = getBinaryNodeChildUInt(node, 'registration', 4);

				await repository.injectE2ESession({
					jid,
					session: {
						registrationId: registrationId!,
						identityKey: generateSignalPubKey(identity),
						signedPreKey: extractKey(signedKey)!,
						preKey: extractKey(key)!,
					},
				});
			}),
		);
	}
};

export const extractDeviceJids = (result: BinaryNode, excludeZeroDevices: boolean) => {
	const extracted: JidWithDevice[] = [];

	for (const node of result.content as BinaryNode[]) {
		const list = getBinaryNodeChild(node, 'list')?.content;

		if (!Array.isArray(list)) continue;

		for (const item of list) {
			const user = item.attrs.jid.split('@')[0];
			const devicesNode = getBinaryNodeChild(item, 'devices');
			const deviceListNode = getBinaryNodeChild(devicesNode, 'device-list');

			if (!Array.isArray(deviceListNode?.content)) continue;

			for (const node of deviceListNode!.content) {
				if (node.tag !== 'device') continue;
				const device = +node.attrs.id;

				// ensure that "key-index" is specified for "non-zero" devices, produces a bad req otherwise
				if (device !== 0 && !node.attrs['key-index']) continue;
				if (excludeZeroDevices && device === 0) continue;

				extracted.push({ user, device });
			}
		}
	}

	return extracted;
};

/**
 * get the next N keys for upload or processing
 * @param count number of pre-keys to get or generate
 */
export const getNextPreKeys = async ({ creds, keys }: AuthenticationState, count: number) => {
	const { newPreKeys, lastPreKeyId, preKeysRange } = generateOrGetPreKeys(creds, count);

	const update: Partial<AuthenticationCreds> = {
		nextPreKeyId: Math.max(lastPreKeyId + 1, creds.nextPreKeyId),
		firstUnuploadedPreKeyId: Math.max(creds.firstUnuploadedPreKeyId, lastPreKeyId + 1),
	};

	await keys.set({ 'pre-key': newPreKeys });

	const preKeys = await getPreKeys(keys, preKeysRange[0], preKeysRange[0] + preKeysRange[1]);

	return { update, preKeys };
};

export const getNextPreKeysNode = async (state: AuthenticationState, count: number) => {
	const { creds } = state;
	const { update, preKeys } = await getNextPreKeys(state, count);

	const node: BinaryNode = {
		tag: 'iq',
		attrs: {
			xmlns: 'encrypt',
			type: 'set',
			to: S_WHATSAPP_NET,
		},
		content: [
			{ tag: 'registration', attrs: {}, content: encodeBigEndian(creds.registrationId) },
			{ tag: 'type', attrs: {}, content: KEY_BUNDLE_TYPE },
			{ tag: 'identity', attrs: {}, content: creds.signedIdentityKey.public },
			{ tag: 'list', attrs: {}, content: Object.keys(preKeys).map(k => xmppPreKey(preKeys[+k], +k)) },
			xmppSignedPreKey(creds.signedPreKey),
		],
	};

	return { update, node };
};
