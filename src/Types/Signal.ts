import { proto } from '../../WAProto';

type PreKey = {
	keyId: number;
	publicKey: Uint8Array;
};

type SignedPreKey = PreKey & {
	signature: Uint8Array;
};

export type E2ESession = {
	registrationId: number;
	identityKey: Uint8Array | Buffer;
	signedPreKey: SignedPreKey;
	preKey: PreKey;
};

export type SignalRepository = {
	decryptGroupMessage(group: string, authorJid: string, msg: Uint8Array): Promise<Uint8Array>;
	processSenderKeyDistributionMessage(
		item: proto.ISenderKeyDistributionMessage,
		authorJid: string,
	): Promise<void>;
	decryptMessage(jid: string, type: 'pkmsg' | 'msg', ciphertext: Uint8Array): Promise<Uint8Array>;
	encryptMessage(
		jid: string,
		data: Uint8Array,
	): Promise<{
		type: 'pkmsg' | 'msg';
		ciphertext: Uint8Array;
	}>;
	encryptGroupMessage(
		group: string,
		meId: string,
		data: Uint8Array,
	): Promise<{
		senderKeyDistributionMessage: Uint8Array;
		ciphertext: Uint8Array;
	}>;
	injectE2ESession(jid: string, session: E2ESession): Promise<void>;
};
