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
	if (!ms) return '0ms';

	const restMilliseconds = ms % 1000;
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

	if (restMilliseconds && !restSeconds) {
		stringBuilder.push(`${restMilliseconds}ms`);
	} else if (restMilliseconds && restSeconds) {
		stringBuilder.push(`${(restSeconds + restMilliseconds / 1000).toFixed(2)}s`);
	} else if (restSeconds) {
		stringBuilder.push(`${restSeconds}s`);
	}

	return stringBuilder.join(' ');
}

export function safeDivision(a: number, b: number) {
	return b ? a / b : 0;
}
