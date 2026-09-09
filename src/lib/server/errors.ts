/**
 * Domain errors.
 *
 * Services throw these; a single mapper in `http.ts` turns them into status codes. The
 * split exists so services can be tested without a request object, and so one place
 * decides what each failure means over HTTP.
 */
import type { ApiErrorCode } from '$lib/types';

export class AppError extends Error {
	constructor(
		readonly kind: ApiErrorCode,
		message: string,
		options?: { cause?: unknown }
	) {
		super(message, options);
		this.name = new.target.name;
	}
}

/** The OBS socket is not connected: OBS is closed, unreachable, or still starting. */
export class ObsUnavailableError extends AppError {
	constructor(message = 'Not connected to OBS', options?: { cause?: unknown }) {
		super('obs_unavailable', message, options);
	}
}

/** OBS rejected our credentials. A configuration fault, not a transient one. */
export class ObsAuthError extends AppError {
	constructor(message = 'OBS rejected the websocket password', options?: { cause?: unknown }) {
		super('obs_auth', message, options);
	}
}

/**
 * OBS accepted the request but refused to perform it. Carries the raw obs-websocket
 * `RequestStatus` code so callers can recognise specific refusals — "already
 * recording" is a conflict, an unknown scene is a 404 — without string matching.
 */
export class ObsRequestError extends AppError {
	constructor(
		readonly code: number,
		message: string,
		options?: { cause?: unknown }
	) {
		super('obs_error', message, options);
	}
}

/** The requested transition contradicts current state (already recording, and so on). */
export class ConflictError extends AppError {
	constructor(message: string) {
		super('conflict', message);
	}
}

export class NotFoundError extends AppError {
	constructor(message: string) {
		super('not_found', message);
	}
}

export class ValidationError extends AppError {
	constructor(message: string) {
		super('validation', message);
	}
}

export class UnauthorizedError extends AppError {
	constructor(message = 'Authentication required') {
		super('unauthorized', message);
	}
}

/** Maps a domain error to the status code it is reported with. */
export function statusForKind(kind: ApiErrorCode): number {
	switch (kind) {
		case 'validation':
			return 400;
		case 'unauthorized':
			return 401;
		case 'not_found':
			return 404;
		case 'conflict':
			return 409;
		case 'obs_unavailable':
			return 503;
		// A wrong password and a refused request are both failures of the upstream we
		// depend on, not of the caller's request.
		case 'obs_auth':
		case 'obs_error':
			return 502;
		case 'internal':
		default:
			return 500;
	}
}

/** Narrows an unknown thrown value to an AppError, wrapping anything else. */
export function toAppError(error: unknown): AppError {
	if (error instanceof AppError) return error;
	const message = error instanceof Error ? error.message : 'Unexpected error';
	return new AppError('internal', message, { cause: error });
}
