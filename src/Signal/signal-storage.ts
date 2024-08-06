import * as libsignal from 'libsignal';
import { proto } from '../../WAProto/index';
import {
	GroupCipher,
	GroupSessionBuilder,
	SenderKeyDistributionMessage,
	SenderKeyRecord,
} from '../../WASignalGroup/index';
import { SignalAuthState } from '../Types/index';
import { E2ESession, SignalRepository } from '../Types/Signal';
import { generateSignalPubKey } from '../Utils/index';

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
