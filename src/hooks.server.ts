/**
 * Server hooks: start the OBS connection once, tag every request, and gate the API.
 */
import { randomUUID } from 'node:crypto';
import type { Handle, ServerInit } from '@sveltejs/kit';
import { SESSION_COOKIE, isSessionValid } from '$lib/server/auth';
import { config } from '$lib/server/config';
import { UnauthorizedError } from '$lib/server/errors';
import { apiFailure } from '$lib/server/http';
import { logger } from '$lib/server/log';
import { runtime } from '$lib/server/runtime';

/** Endpoints reachable without a session: signing in, and the container healthcheck. */
const PUBLIC_API_PATHS = new Set(['/api/session', '/api/health']);

export const init: ServerInit = async () => {
	// Connect at startup rather than on first request, so the UI has real state to
	// render the moment anybody opens it.
	runtime();

	if (!config().auth.token) {
		logger.warn(
			'APP_TOKEN is not set: the API is unauthenticated and anyone who can reach ' +
				'this port can start or stop recordings. Set APP_TOKEN to require a password.'
		);
	}
};

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.requestId = randomUUID();

	const token = config().auth.token;
	event.locals.authRequired = Boolean(token);
	event.locals.authenticated = !token || isSessionValid(event.cookies.get(SESSION_COOKIE));

	if (
		event.url.pathname.startsWith('/api') &&
		!PUBLIC_API_PATHS.has(event.url.pathname) &&
		!event.locals.authenticated
	) {
		return apiFailure(new UnauthorizedError(), event.locals.requestId);
	}

	return resolve(event);
};
