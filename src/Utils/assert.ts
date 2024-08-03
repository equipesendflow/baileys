export class AssertError extends Error {
	code = 'assert-error';
	data: Record<string, any> | null = null;

	constructor(message: string, code = 'assert-error', data?: Record<string, any>) {
		super(message);
		this.name = 'AssertError';
		this.code = code || 'assert-error';
		this.data = data || null;
	}
}

export function assert(condition: any, message: string): asserts condition {
	if (!condition) {
		throw new AssertError(message || '');
	}
}
