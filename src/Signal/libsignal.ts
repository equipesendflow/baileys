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
import { SignalStorage } from './signal-storage';

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

const jidToSignalSenderKeyName = (group: string, user: string): string => {
	return `${group}::${jidToSignalAddress(user)}::0`;
};
