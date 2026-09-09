import { apiHandler } from '$lib/server/http';
import { runtime } from '$lib/server/runtime';
import type { RequestHandler } from './$types';

/** Returns the finished file's path, which OBS only reveals on stop. */
export const POST: RequestHandler = async ({ locals }) =>
	apiHandler(locals.requestId, async () => runtime().service.stopRecording());
