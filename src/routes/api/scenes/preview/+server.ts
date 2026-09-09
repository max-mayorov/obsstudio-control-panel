import { apiHandler, readJsonBody } from '$lib/server/http';
import { runtime } from '$lib/server/runtime';
import type { RequestHandler } from './$types';

/** Stages a scene in preview. Studio mode only; 409 otherwise. */
export const POST: RequestHandler = async ({ request, locals }) =>
	apiHandler(locals.requestId, async () => {
		const body = await readJsonBody(request);
		await runtime().service.setPreviewScene(body.name as string);
		return { preview: body.name };
	});
