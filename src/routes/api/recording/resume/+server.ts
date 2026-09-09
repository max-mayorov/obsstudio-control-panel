import { apiHandler } from '$lib/server/http';
import { runtime } from '$lib/server/runtime';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals }) =>
	apiHandler(
		locals.requestId,
		async () => {
			await runtime().service.resumeRecording();
			return { accepted: true };
		},
		202
	);
