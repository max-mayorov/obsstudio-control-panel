import {
	SESSION_COOKIE,
	createSession,
	destroySession,
	sessionMaxAgeSeconds,
	verifyToken
} from '$lib/server/auth';
import { config } from '$lib/server/config';
import { UnauthorizedError } from '$lib/server/errors';
import { apiHandler, readJsonBody } from '$lib/server/http';
import type { RequestHandler } from './$types';

/** Exchanges the shared secret for a session cookie. */
export const POST: RequestHandler = async ({ request, cookies, url, locals }) =>
	apiHandler(locals.requestId, async () => {
		const token = config().auth.token;
		if (!token) return { authenticated: true, authRequired: false };

		const body = await readJsonBody(request);
		const provided = typeof body.token === 'string' ? body.token : '';
		if (!verifyToken(provided, token)) {
			throw new UnauthorizedError('Incorrect password');
		}

		cookies.set(SESSION_COOKIE, createSession(), {
			path: '/',
			httpOnly: true,
			sameSite: 'strict',
			// Only demand HTTPS when we are actually being served over it, so a LAN
			// deployment on plain HTTP still works.
			secure: url.protocol === 'https:',
			maxAge: sessionMaxAgeSeconds
		});

		return { authenticated: true, authRequired: true };
	});

export const DELETE: RequestHandler = async ({ cookies, locals }) =>
	apiHandler(locals.requestId, async () => {
		destroySession(cookies.get(SESSION_COOKIE));
		cookies.delete(SESSION_COOKIE, { path: '/' });
		return { authenticated: false };
	});
