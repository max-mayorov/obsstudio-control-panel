import { describe, expect, it } from 'vitest';
import { createSession, destroySession, isSessionValid, verifyToken } from './auth';

describe('verifyToken', () => {
	it('accepts the matching secret', () => {
		expect(verifyToken('hunter2', 'hunter2')).toBe(true);
	});

	it('rejects a different secret of the same length', () => {
		expect(verifyToken('hunter3', 'hunter2')).toBe(false);
	});

	it('rejects secrets of different lengths without throwing', () => {
		// timingSafeEqual throws on length mismatch, so the guard must handle it rather
		// than letting a short guess crash the request.
		expect(verifyToken('short', 'considerably-longer')).toBe(false);
		expect(verifyToken('', 'x')).toBe(false);
	});

	it('handles multi-byte characters by comparing bytes', () => {
		expect(verifyToken('pässwörd', 'pässwörd')).toBe(true);
		expect(verifyToken('pässwörd', 'passwörd')).toBe(false);
	});
});

describe('sessions', () => {
	it('issues opaque ids that validate', () => {
		const id = createSession();
		expect(id).not.toHaveLength(0);
		expect(isSessionValid(id)).toBe(true);
	});

	it('issues a distinct id each time', () => {
		expect(createSession()).not.toBe(createSession());
	});

	it('rejects unknown and absent ids', () => {
		expect(isSessionValid('not-a-session')).toBe(false);
		expect(isSessionValid(undefined)).toBe(false);
	});

	it('forgets a destroyed session', () => {
		const id = createSession();
		destroySession(id);
		expect(isSessionValid(id)).toBe(false);
	});
});
