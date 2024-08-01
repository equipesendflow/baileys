import { millisecondsToDuration } from './to-duration';

export function startTimeTracker(name: string) {
	const startTime = Date.now();

	return (obs: string = '') => {
		const endTime = Date.now();

		if (obs) name = `${obs} ${name}`;

		console.log(`Track ${name} - Took ${millisecondsToDuration(endTime - startTime)}`);
	};
}

export async function trackTime<T>(name: string, promise: Promise<T>): Promise<T> {
	const finish = startTimeTracker(name);
	try {
		const response = await promise;

		finish();

		return response;
	} catch (e: any) {
		finish();
		throw e;
	}
}

export function trackTimeCb<T>(name: string, callback: (...args: any[]) => Promise<T> | T) {
	return async (...args: any[]) => {
		const finish = startTimeTracker(name);
		try {
			const response = await Promise.resolve(callback(...args));

			finish();

			return response;
		} catch (e: any) {
			finish();
			throw e;
		}
	};
}
