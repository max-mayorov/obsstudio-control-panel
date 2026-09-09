/**
 * Shared-secret access control for the API.
 *
 * The app can stop somebody's recording, so the endpoints are gated by a single token.
 * Two decisions are worth stating:
 *
 * 1. The credential travels in a cookie, not an `Authorization` header. `EventSource`
 *    exposes no API for request headers, so a header scheme cannot authenticate the SSE
 *    stream at all, and a token in the query string would end up in access logs.
 *
 * 2. The cookie holds an opaque session id rather than the token itself, so the shared
 *    secret is never stored in a browser. Sessions live in memory and therefore end with
 *    the process, which is the right trade for a single-operator control surface.
 */
import { randomUUID, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'obs_control_session';

const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

const sessions = new Map<string, number>();

/** Compares two secrets without leaking their similarity through timing. */
export function verifyToken(provided: string, expected: string): boolean {
	const a = Buffer.from(provided, 'utf8');
	const b = Buffer.from(expected, 'utf8');
	if (a.length !== b.length) {
		// Still perform a comparison so the failure path costs roughly the same.
		timingSafeEqual(b, b);
		return false;
	}
	return timingSafeEqual(a, b);
}

export function createSession(): string {
	pruneExpired();
	const id = randomUUID();
	sessions.set(id, Date.now() + SESSION_MAX_AGE_MS);
	return id;
}

export function isSessionValid(id: string | undefined): boolean {
	if (!id) return false;
	const expiresAt = sessions.get(id);
	if (expiresAt === undefined) return false;
	if (expiresAt <= Date.now()) {
		sessions.delete(id);
		return false;
	}
	return true;
}

export function destroySession(id: string | undefined): void {
	if (id) sessions.delete(id);
}

export const sessionMaxAgeSeconds = SESSION_MAX_AGE_MS / 1000;

function pruneExpired(): void {
	const now = Date.now();
	for (const [id, expiresAt] of sessions) {
		if (expiresAt <= now) sessions.delete(id);
	}
}
