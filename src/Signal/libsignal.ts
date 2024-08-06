import * as libsignal from 'libsignal';
import { proto } from '../../WAProto/index';
import {
	GroupCipher,
	GroupSessionBuilder,
	SenderKeyDistributionMessage,
	SenderKeyRecord,
} from '../../WASignalGroup';
import { SignalAuthState } from '../Types';
import { E2ESession, SignalRepository } from '../Types/Signal';
import { generateSignalPubKey } from '../Utils';

export class LibSignalRepository implements SignalRepository {
	storage: SignalStorage;

	constructor(public auth: SignalAuthState) {
		this.storage = new SignalStorage(auth);
	}

	decryptGroupMessage(group: string, authorJid: string, msg: Uint8Array) {
		const senderName = jidToSignalSenderKeyName(group, authorJid);
		const cipher = new GroupCipher(this.storage, senderName);

		return cipher.decrypt(msg);
	}

	async processSenderKeyDistributionMessage(item: proto.ISenderKeyDistributionMessage, authorJid: string) {
		const builder = new GroupSessionBuilder(this.storage);
		const senderName = jidToSignalSenderKeyName(item.groupId!, authorJid);

		const senderMsg = new SenderKeyDistributionMessage(
			null,
			null,
			null,
			null,
			item.axolotlSenderKeyDistributionMessage,
		);

		const senderKey = await this.auth.keys.getOne('sender-key', senderName);

		if (!senderKey) {
			await this.storage.storeSenderKey(senderName, new SenderKeyRecord());
		}

		await builder.process(senderName, senderMsg);
	}

	async decryptMessage(jid: string, type: 'pkmsg' | 'msg', ciphertext: Uint8Array) {
		const addr = jidToSignalProtocolAddress(jid);
		const session = new libsignal.SessionCipher(this.storage, addr);

		switch (type) {
			case 'pkmsg':
				return session.decryptPreKeyWhisperMessage(ciphertext);
			case 'msg':
				return session.decryptWhisperMessage(ciphertext);
		}
	}

	async encryptMessage(jid: string, data: Uint8Array) {
		const addr = jidToSignalProtocolAddress(jid);
		const cipher = new libsignal.SessionCipher(this.storage, addr);

		const result = await cipher.encrypt(data);

		return {
			type: (result.type === 3 ? 'pkmsg' : 'msg') as 'pkmsg' | 'msg',
			ciphertext: Buffer.from(result.body, 'binary'),
		};
	}

	async encryptGroupMessage(group: string, meId: string, data: Uint8Array) {
		const senderName = jidToSignalSenderKeyName(group, meId);
		const builder = new GroupSessionBuilder(this.storage);

		const senderKey = await this.auth.keys.getOne('sender-key', senderName);

		if (!senderKey) {
			await this.storage.storeSenderKey(senderName, new SenderKeyRecord());
		}

		const senderKeyDistributionMessage = await builder.create(senderName);
		const session = new GroupCipher(this.storage, senderName);
		const ciphertext = await session.encrypt(data);

		return {
			ciphertext,
			senderKeyDistributionMessage: senderKeyDistributionMessage.serialize(),
		};
	}

	async injectE2ESession(jid: string, session: E2ESession) {
		const cipher = new libsignal.SessionBuilder(this.storage, jidToSignalProtocolAddress(jid));

		await cipher.initOutgoing(session);
	}
}

const jidToSignalAddress = (jid: string) => jid.split('@')[0];

const jidToSignalProtocolAddress = (jid: string) => {
	return new libsignal.ProtocolAddress(jidToSignalAddress(jid), 0);
};

export function jidToSignalProtocolAddressString(jid: string) {
	return `${jid.split('@')[0]}.0`;
}

const jidToSignalSenderKeyName = (group: string, user: string): string => {
	return `${group}::${jidToSignalAddress(user)}::0`;
};

export class SignalStorage {
	constructor(public auth: SignalAuthState) {}

	async loadSession(id: string) {
		const session = await this.auth.keys.getOne('session', id);

		if (!session) return;

		return libsignal.SessionRecord.deserialize(session);
	}

	async storeSession(id: string, session: libsignal.SessionRecord) {
		await this.auth.keys.setOne('session', id, session.serialize());
	}

	isTrustedIdentity() {
		return true;
	}

	async loadPreKey(id: number | string) {
		const key = await this.auth.keys.getOne('pre-key', id.toString());

		if (!key) return;

		return {
			privKey: Buffer.from(key.private),
			pubKey: Buffer.from(key.public),
		};
	}

	removePreKey(id: number) {
		return this.auth.keys.setOne('pre-key', id.toString(), null);
	}

	loadSignedPreKey() {
		return {
			privKey: Buffer.from(this.auth.creds.signedPreKey.keyPair.private),
			pubKey: Buffer.from(this.auth.creds.signedPreKey.keyPair.public),
		};
	}

	async loadSenderKey(keyId: string) {
		const key = await this.auth.keys.getOne('sender-key', keyId);

		if (!key) return;

		return new SenderKeyRecord(key);
	}

	async storeSenderKey(keyId: string, key: SenderKeyRecord) {
		await this.auth.keys.setOne('sender-key', keyId, key.serialize());
	}

	getOurRegistrationId() {
		return this.auth.creds.registrationId;
	}

	getOurIdentity() {
		return {
			privKey: Buffer.from(this.auth.creds.signedIdentityKey.private),
			pubKey: generateSignalPubKey(this.auth.creds.signedIdentityKey.public),
		};
	}
}
