import { runParallel } from './parallel';

interface MakeCallbackPartitionOptions<T> {
	list: T[] | null | undefined,
	callback: (ls: T[]) => any,
	partitionLength: number
}

export async function makeCallbackPartitions<T>(
	options: MakeCallbackPartitionOptions<T>
) {
	const { list, callback, partitionLength } = options;

	if (!list?.length) return;

	if (list.length <= partitionLength * 1.5) {
		return callback(list);
	}

	await runParallel((add) => {

		let i = 0;

		while (i < list.length) {
			const length = list.length - i <= partitionLength * 1.5 ? list.length - i : partitionLength

			const ls = list.slice(i, i + length);
			i += length;

			add(callback(ls));
		}

		// const ls = [...list];

		// while (ls.length) {
		// 	const curList = ls.splice(0, ls.length <= partitionLength * 1.5 ? ls.length : partitionLength )

		// 	add(callback(curList));
		// }

	})
}


// const a = [1,2,3,4,5,6,7,8,9,10]

// makeCallbackPartitions({
// 	list: a,
// 	callback: (ls) => console.log(ls),
// 	partitionLength: 7
// })