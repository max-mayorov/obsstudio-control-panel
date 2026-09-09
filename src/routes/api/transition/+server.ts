import { apiHandler } from '$lib/server/http';
import { runtime } from '$lib/server/runtime';
import type { RequestHandler } from './$types';

/** Takes preview to program. Studio mode only. */
export const POST: RequestHandler = async ({ locals }) =>
	apiHandler(
		locals.requestId,
		async () => {
			await runtime().service.transition();
			return { accepted: true };
		},
		202
	);
