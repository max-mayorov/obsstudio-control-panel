import { apiHandler, readJsonBody } from '$lib/server/http';
import { runtime } from '$lib/server/runtime';
import type { RequestHandler } from './$types';

/** Cuts a scene to program. In studio mode this goes straight to air. */
export const POST: RequestHandler = async ({ request, locals }) =>
	apiHandler(locals.requestId, async () => {
		const body = await readJsonBody(request);
		await runtime().service.setProgramScene(body.name as string);
		return { program: body.name };
	});
