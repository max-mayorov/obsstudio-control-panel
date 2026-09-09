import { json } from '@sveltejs/kit';
import { runtime } from '$lib/server/runtime';
import type { RequestHandler } from './$types';

/**
 * Liveness for container orchestration.
 *
 * Deliberately 200 even while OBS is unreachable: this reports whether *this* process is
 * healthy. Failing it because OBS is closed would make the container restart in a loop
 * over a condition it cannot fix. The OBS state is in the body for anyone who cares.
 */
export const GET: RequestHandler = () => {
	const { connection } = runtime().store.getSnapshot();
	return json({ status: 'ok', obs: connection.status });
};
