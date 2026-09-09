/**
 * Typed access to the API. Every response shares one envelope, so callers deal with a
 * single shape rather than a mix of status codes and payloads.
 */
import type { ApiError, ApiResponse, ObsSnapshot, StopRecordingResult } from '$lib/types';

export class ApiRequestError extends Error {
	constructor(
		readonly status: number,
		readonly detail: ApiError
	) {
		super(detail.message);
		this.name = 'ApiRequestError';
	}
}

async function send<T>(path: string, init?: RequestInit): Promise<T> {
	let response: Response;
	try {
		response = await fetch(path, {
			...init,
			headers: { 'content-type': 'application/json', ...init?.headers }
		});
	} catch (error) {
		// Network-level failure: the server is unreachable, not refusing.
		throw new ApiRequestError(0, {
			code: 'obs_unavailable',
			message: 'Could not reach the server',
			requestId: '-'
		});
	}

	const body = (await response.json().catch(() => null)) as ApiResponse<T> | null;

	if (!body) {
		throw new ApiRequestError(response.status, {
			code: 'internal',
			message: `Unexpected response (${response.status})`,
			requestId: '-'
		});
	}
	if (!body.ok) throw new ApiRequestError(response.status, body.error);
	return body.data;
}

export const api = {
	state: () => send<ObsSnapshot>('/api/state'),

	startRecording: () => send<{ accepted: boolean }>('/api/recording/start', { method: 'POST' }),
	stopRecording: () => send<StopRecordingResult>('/api/recording/stop', { method: 'POST' }),
	pauseRecording: () => send<{ accepted: boolean }>('/api/recording/pause', { method: 'POST' }),
	resumeRecording: () => send<{ accepted: boolean }>('/api/recording/resume', { method: 'POST' }),

	setProgramScene: (name: string) =>
		send<{ program: string }>('/api/scenes/current', {
			method: 'POST',
			body: JSON.stringify({ name })
		}),
	setPreviewScene: (name: string) =>
		send<{ preview: string }>('/api/scenes/preview', {
			method: 'POST',
			body: JSON.stringify({ name })
		}),
	transition: () => send<{ accepted: boolean }>('/api/transition', { method: 'POST' }),

	signIn: (token: string) =>
		send<{ authenticated: boolean }>('/api/session', {
			method: 'POST',
			body: JSON.stringify({ token })
		}),
	signOut: () => send<{ authenticated: boolean }>('/api/session', { method: 'DELETE' })
};
