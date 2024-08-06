import { Boom } from '@hapi/boom';
import { proto } from '../../WAProto';
import { BinaryNode } from './types';

export const getBinaryNodeChildren = (node: BinaryNode | undefined, childTag: string) => {
	if (!Array.isArray(node?.content)) return [];

	return node!.content.filter(item => item.tag === childTag);
};

export const getAllBinaryNodeChildren = (node: BinaryNode) => {
	if (!Array.isArray(node?.content)) return [];

	return node.content;
};

export const getBinaryNodeChild = (node: BinaryNode | undefined, childTag: string) => {
	if (!Array.isArray(node?.content)) return;

	return node?.content.find(item => item.tag === childTag);
};

export const getBinaryNodeChildBuffer = (node: BinaryNode | undefined, childTag: string) => {
	const child = getBinaryNodeChild(node, childTag)?.content;

	if (!Buffer.isBuffer(child) && !(child instanceof Uint8Array)) return;

	return child;
};

export const getBinaryNodeBuffer = (node: BinaryNode | undefined) => {
	if (!Buffer.isBuffer(node?.content) && !(node?.content instanceof Uint8Array)) return;

	return node?.content;
};

export const getBinaryNodeContentString = (node: BinaryNode) => {
	const content = node.content;
	if (Buffer.isBuffer(content) || content instanceof Uint8Array) {
		return Buffer.from(content).toString('utf-8');
	} else if (typeof content === 'string') {
		return content;
	}
	return null;
};

export const getBinaryNodeChildString = (node: BinaryNode | undefined, childTag: string) => {
	const child = getBinaryNodeChild(node, childTag)?.content;

	if (Buffer.isBuffer(child) || child instanceof Uint8Array) {
		return Buffer.from(child).toString('utf-8');
	} else if (typeof child === 'string') {
		return child;
	}
};

export const getBinaryNodeChildUInt = (node: BinaryNode, childTag: string, length: number) => {
	const buff = getBinaryNodeChildBuffer(node, childTag);

	if (!buff) return;

	return bufferToUInt(buff, length);
};

export const getBinaryNodeUInt = (node: BinaryNode, length: number) => {
	const buff = getBinaryNodeBuffer(node);

	if (!buff) return;

	return bufferToUInt(buff, length);
};

export const assertNodeErrorFree = (node: BinaryNode) => {
	const errNode = getBinaryNodeChild(node, 'error');

	if (!errNode) return;

	throw new Boom(errNode.attrs.text || 'Unknown error', { data: +errNode.attrs.code });
};

export const reduceBinaryNodeToDictionary = (node: BinaryNode, tag: string) => {
	const nodes = getBinaryNodeChildren(node, tag);
	const dict = nodes.reduce((dict, node) => {
		dict[node.attrs.name || node.attrs.config_code] = node.attrs.value || node.attrs.config_value;
		return dict;
	}, {} as { [_: string]: string });
	return dict;
};

export const getBinaryNodeMessages = (node: BinaryNode) => {
	if (!Array.isArray(node.content)) return [];

	const msgs: proto.WebMessageInfo[] = [];

	for (const item of node.content) {
		if (item.tag !== 'message') continue;

		msgs.push(proto.WebMessageInfo.decode(item.content as Buffer));
	}

	return msgs;
};

export function bufferToUInt(e: Uint8Array | Buffer, t: number) {
	let a = 0;
	for (let i = 0; i < t; i++) {
		a = 256 * a + e[i];
	}

	return a;
}
