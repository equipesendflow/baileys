export function secondsToDuration(secs: number) {
	const hours = Math.floor(secs / 3600);
	const minutes = Math.floor((secs - hours * 3600) / 60);
	const seconds = secs - hours * 3600 - minutes * 60;

	const stringBuilder: string[] = [];

	if (hours) {
		stringBuilder.push(`${hours}h`);
	}

	if (minutes) {
		stringBuilder.push(`${minutes}min`);
	}

	if (seconds) {
		stringBuilder.push(`${seconds}s`);
	}

	return stringBuilder.slice(0, 2).join(' ');
}

export function millisecondsToDuration(ms: number) {
	if (!ms) return '0µs';

	const restMicroseconds = Math.floor((ms * 1000) % 1000);
	const restMilliseconds = Math.floor(ms % 1000);
	const totalSeconds = Math.floor(safeDivision(ms, 1000));
	const restSeconds = Math.floor(totalSeconds % 60);
	const totalMinutes = Math.floor(safeDivision(totalSeconds, 60));
	const restMinutes = Math.floor(totalMinutes % 60);
	const totalHours = Math.floor(safeDivision(totalMinutes, 60));

	const stringBuilder: string[] = [];

	if (totalHours) {
		stringBuilder.push(`${totalHours}h`);
	}

	if (restMinutes) {
		stringBuilder.push(`${restMinutes}m`);
	}

	if (restSeconds) {
		stringBuilder.push(`${restSeconds}s`);
	}

	if (restMilliseconds) {
		stringBuilder.push(`${restMilliseconds}ms`);
	}

	if (restMicroseconds) {
		stringBuilder.push(`${restMicroseconds}µs`);
	}

	return stringBuilder.join(' ');
}

export function safeDivision(a: number, b: number) {
	return b ? a / b : 0;
}
