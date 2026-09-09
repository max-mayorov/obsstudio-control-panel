import { apiHandler } from '$lib/server/http';
import { runtime } from '$lib/server/runtime';
import type { RequestHandler } from './$types';

/**
 * The current snapshot.
 *
 * Same object the SSE stream pushes, so a client that cannot hold a stream open can fall
 * back to polling this without a second code path on the server.
 */
export const GET: RequestHandler = async ({ locals }) =>
	apiHandler(locals.requestId, async () => runtime().service.snapshot());
