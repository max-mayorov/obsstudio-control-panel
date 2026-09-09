import { describe, expect, it } from 'vitest';
import {
	AppError,
	ConflictError,
	NotFoundError,
	ObsAuthError,
	ObsRequestError,
	ObsUnavailableError,
	UnauthorizedError,
	ValidationError,
	statusForKind,
	toAppError
} from './errors';

describe('statusForKind', () => {
	it('maps each domain failure to the status that describes it', () => {
		expect(statusForKind('validation')).toBe(400);
		expect(statusForKind('unauthorized')).toBe(401);
		expect(statusForKind('not_found')).toBe(404);
		expect(statusForKind('conflict')).toBe(409);
		expect(statusForKind('internal')).toBe(500);
	});

	it('reports an unreachable OBS as unavailable, not as our own failure', () => {
		expect(statusForKind('obs_unavailable')).toBe(503);
	});

	it('reports OBS refusing us as an upstream failure', () => {
		// A wrong OBS password is a misconfiguration of a dependency, not a bad request
		// from the caller, so it must not surface as 400 or 401.
		expect(statusForKind('obs_auth')).toBe(502);
		expect(statusForKind('obs_error')).toBe(502);
	});
});

describe('error classes', () => {
	it('carry the kind that decides their status', () => {
		expect(new ValidationError('x').kind).toBe('validation');
		expect(new NotFoundError('x').kind).toBe('not_found');
		expect(new ConflictError('x').kind).toBe('conflict');
		expect(new UnauthorizedError().kind).toBe('unauthorized');
		expect(new ObsUnavailableError().kind).toBe('obs_unavailable');
		expect(new ObsAuthError().kind).toBe('obs_auth');
	});

	it('keep the raw OBS status code so callers can recognise a refusal', () => {
		const error = new ObsRequestError(500, 'Output running');
		expect(error.code).toBe(500);
		expect(error.kind).toBe('obs_error');
	});
});

describe('toAppError', () => {
	it('passes domain errors through untouched', () => {
		const original = new ConflictError('already recording');
		expect(toAppError(original)).toBe(original);
	});

	it('wraps anything else as internal, preserving the cause', () => {
		const cause = new Error('socket exploded');
		const wrapped = toAppError(cause);
		expect(wrapped).toBeInstanceOf(AppError);
		expect(wrapped.kind).toBe('internal');
		expect(wrapped.message).toBe('socket exploded');
		expect(wrapped.cause).toBe(cause);
	});

	it('survives a thrown non-error', () => {
		expect(toAppError('nope').kind).toBe('internal');
	});
});
