export function asyncDelay(ms: number) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

export async function asyncAllSettled<T>(list: T[]) {
	if (!list.length) return Promise.resolve([]);
	const responses = await Promise.allSettled(list);

	for (const response of responses) {
		if (response.status === 'rejected') {
			console.error(response);
		}
	}

	return responses;
}

export function parallel() {
	const list: Promise<any>[] = [];

	return {
		promises: list,
		add(item: any | any[]) {
			if (item instanceof Array) {
				for (const promise of item) {
					list.push(Promise.resolve(promise));
				}
			} else if (item instanceof Function) {
				list.push(Promise.resolve(item()));
			} else {
				list.push(Promise.resolve(item));
			}
		},
		wait() {
			return asyncAllSettled(list);
		},
	};
}

export async function runParallel(callback: (add: (promise: any) => Promise<any>) => any) {
	const list: Promise<any>[] = [];

	function add(promise: any) {
		let item = Promise.resolve(promise);

		if (promise instanceof Function) {
			item = Promise.resolve(promise());
			list.push(item);
		} else {
			item = Promise.resolve(promise);
			list.push(item);
		}

		return item;
	}

	await callback(add);

	return asyncAllSettled(list);
}

