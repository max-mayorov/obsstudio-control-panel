import { runtime } from '$lib/server/runtime';
import type { LayoutServerLoad } from './$types';

/**
 * Seeds the page with real OBS state so the first paint is correct, rather than showing
 * a disconnected shell that corrects itself once the stream opens.
 *
 * Nothing is returned to a client without a session: state is only sent once the caller
 * has proved it may see it.
 */
export const load: LayoutServerLoad = async ({ locals }) => ({
	snapshot: locals.authenticated ? await runtime().service.snapshot() : null,
	authRequired: locals.authRequired,
	authenticated: locals.authenticated
});
