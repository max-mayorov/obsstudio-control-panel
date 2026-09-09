/**
 * The HTTP edge: one place that decides how a domain error is reported, and one
 * response envelope so the client never has to guess a payload's shape.
 */
import { json } from '@sveltejs/kit';
import type { ApiResponse } from '$lib/types';
import { statusForKind, toAppError } from './errors';
import { logger } from './log';

export function apiSuccess<T>(data: T, status = 200): Response {
	return json({ ok: true, data } satisfies ApiResponse<T>, { status });
}

/**
 * Reports a failure.
 *
 * The `requestId` goes to both the log line and the response, so an error a user reads
 * in a toast can be found in the server log without guesswork. Causes are logged but
 * never returned: they can carry connection strings and stack traces.
 */
export function apiFailure(error: unknown, requestId: string): Response {
	const appError = toAppError(error);
	const status = statusForKind(appError.kind);

	const log = logger.child({ requestId, kind: appError.kind, status });
	if (status >= 500) {
		log.error({ err: appError }, appError.message);
	} else {
		log.warn(appError.message);
	}

	return json(
		{
			ok: false,
			error: { code: appError.kind, message: appError.message, requestId }
		} satisfies ApiResponse<never>,
		{ status }
	);
}

/** Wraps a handler so every route shares the same success and failure shape. */
export async function apiHandler<T>(
	requestId: string,
	handler: () => Promise<T>,
	successStatus = 200
): Promise<Response> {
	try {
		return apiSuccess(await handler(), successStatus);
	} catch (error) {
		return apiFailure(error, requestId);
	}
}

/** Parses a JSON body, turning malformed input into a validation error, not a 500. */
export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
	try {
		const body = await request.json();
		return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}
