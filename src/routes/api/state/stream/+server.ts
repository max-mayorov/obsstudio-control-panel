import { SSE_EVENT } from '$lib/types';
import { loggerFor } from '$lib/server/log';
import { runtime } from '$lib/server/runtime';
import type { RequestHandler } from './$types';

const log = loggerFor('sse');

/**
 * Server-sent events carrying OBS state.
 *
 * Two event types (DESIGN.md section 8): `state` is a whole snapshot, sent whenever
 * anything changes, and `tick` is just the recording numbers at 1 Hz. Snapshots are
 * under a kilobyte, so sending them whole beats diffing — it is idempotent, self-healing
 * after a dropped frame, and has no patch-ordering bugs. Splitting the tick out keeps an
 * active recording from resending the scene list every second.
 *
 * SSE rather than a websocket: the only thing that needs to travel upstream is commands,
 * which POST handles, and EventSource reconnects on its own.
 */
export const GET: RequestHandler = ({ request }) => {
	const { store } = runtime();
	const encoder = new TextEncoder();

	let unsubscribe: (() => void) | undefined;
	let keepAlive: ReturnType<typeof setInterval> | undefined;
	let closed = false;

	const stream = new ReadableStream({
		start(controller) {
			const send = (event: string, data: unknown) => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
				} catch {
					// The client went away between our check and the write.
					cleanup();
				}
			};

			const cleanup = () => {
				if (closed) return;
				closed = true;
				unsubscribe?.();
				if (keepAlive) clearInterval(keepAlive);
			};

			// Send current state immediately so a reconnecting client is correct at once
			// rather than after the next change.
			send(SSE_EVENT.state, store.getSnapshot());

			unsubscribe = store.subscribe({
				onState: (snapshot) => send(SSE_EVENT.state, snapshot),
				onTick: (tick) => send(SSE_EVENT.tick, tick)
			});

			// A comment line keeps intermediaries from closing a stream that is quiet
			// because nothing is happening in OBS.
			keepAlive = setInterval(() => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(': keep-alive\n\n'));
				} catch {
					cleanup();
				}
			}, 25_000);
			keepAlive.unref?.();

			// adapter-node cancels the stream on disconnect, but an aborted request does
			// not always reach it; both paths must release the subscription.
			request.signal.addEventListener('abort', cleanup);
			log.debug('state stream opened');
		},

		cancel() {
			closed = true;
			unsubscribe?.();
			if (keepAlive) clearInterval(keepAlive);
			log.debug('state stream closed');
		}
	});

	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache, no-transform',
			connection: 'keep-alive',
			// Tell nginx not to buffer, which would otherwise defeat streaming entirely.
			'x-accel-buffering': 'no'
		}
	});
};
