import { runParallel } from './parallel';

interface MakeCallbackPartitionOptions<T> {
	list: T[] | null | undefined;
	callback: (ls: T[]) => any;
	partitionLength: number;
}

export async function makeChunks<T>(options: MakeCallbackPartitionOptions<T>) {
	const { list, callback, partitionLength } = options;

	if (!list?.length) return;

	if (list.length <= partitionLength * 1.5) {
		return callback(list);
	}

	const promises: Promise<any>[] = [];

	let i = 0;

	while (i < list.length) {
		const length = list.length - i <= partitionLength * 1.5 ? list.length - i : partitionLength;

		const ls = list.slice(i, i + length);
		i += length;

		promises.push(callback(ls));
	}

	return Promise.all(promises);
}

// const a = [1,2,3,4,5,6,7,8,9,10]

// makeCallbackPartitions({
// 	list: a,
// 	callback: (ls) => console.log(ls),
// 	partitionLength: 7
// })

export function removeBufferOnString(inputText: string) {
	let replacedText = inputText;

	//URLs starting with http://, https://, or ftp://
	const replacePattern1 = /"type":\s*"Buffer"\s*,\s*"data":\s*(\[[^\]]*\])/gim;

	replacedText = inputText.replace(replacePattern1, (_, p1) => {
		console.log(p1);
		return `"type": "Buffer", "data": ${JSON.parse(p1).length}`;
	});

	return replacedText;
}

function replaceBufferType(obj) {
	for (const key in obj) {
		if (obj[key] && typeof obj[key] === 'object') {
			if (obj[key].type === 'Buffer' && Array.isArray(obj[key].data)) {
				obj[key].data = obj[key].data.length;
			}
			replaceBufferType(obj[key]);
		}
	}

	return obj;
}

export const BufferJSON = {
	replacer: (_key: any, value: any) => {
		if (Buffer.isBuffer(value) || value instanceof Uint8Array || value?.type === 'Buffer') {
			return { type: 'Buffer', data: Buffer.from(value?.data || value).toString('base64') };
		}

		return value;
	},
	reviver: (_key: any, value: any) => {
		if (typeof value === 'object' && !!value && (value.buffer === true || value.type === 'Buffer')) {
			const val = value.data || value.value;
			const buffer = typeof val === 'string' ? Buffer.from(val, 'base64') : Buffer.from(val || []);
			return { type: 'Buffer', data: buffer.length };
		}

		return value;
	},
};

export function removeBuffer(inputObj: any) {
	// return replaceBufferType(cloneDeep(inputObj))
	if (!inputObj) return null;

	try {
		return JSON.parse(JSON.stringify(inputObj, BufferJSON.replacer, 2), BufferJSON.reviver);
	} catch (e: any) {
		return null;
	}
}
