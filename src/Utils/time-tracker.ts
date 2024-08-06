import { millisecondsToDuration } from './to-duration';

export function startTimeTracker(name: string) {
	const startTime = performance.now();

	return (obs: string = '') => {
		const endTime = performance.now();

		if (obs) name = `${obs} ${name}`;

		console.log(`Track ${name} - Took ${millisecondsToDuration(endTime - startTime)}`);
	};
}

export async function trackTime<T>(name: string, promise: Promise<T> | T): Promise<T> {
	const finish = startTimeTracker(name);
	try {
		const response = await Promise.resolve(promise);

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

export function TrackTime(name?: string) {
	return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
		const originalMethod = descriptor.value;

		descriptor.value = function (...args: any[]) {
			const finish = startTimeTracker(propertyKey || name || '');

			if (originalMethod.constructor.name === 'AsyncFunction') {
				return Promise.resolve(originalMethod.apply(this, args)).finally(finish);
			}

			const res = originalMethod.apply(this, args);

			finish();

			return res;
		};

		return descriptor;
	};
}
