import { apiHandler } from '$lib/server/http';
import { runtime } from '$lib/server/runtime';
import type { RequestHandler } from './$types';

/**
 * 202, not 200: OBS has accepted the request, but the UI only shows a recording once
 * OBS reports one through the state stream. The command never writes local state.
 */
export const POST: RequestHandler = async ({ locals }) =>
	apiHandler(
		locals.requestId,
		async () => {
			await runtime().service.startRecording();
			return { accepted: true };
		},
		202
	);
