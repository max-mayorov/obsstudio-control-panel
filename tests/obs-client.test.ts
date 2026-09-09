import { afterEach, describe, expect, it } from 'vitest';
import { MockObsServer } from '../tools/mock-obs/server.js';
import { ObsClient } from '../src/lib/server/obs/client.js';
import { ObsRequestError, ObsUnavailableError } from '../src/lib/server/errors.js';
import { RequestStatus } from '../src/lib/server/obs/protocol.js';
import { waitFor } from './helpers.js';

const RECONNECT = { initialDelayMs: 50, maxDelayMs: 150 };

let server: MockObsServer | undefined;
let client: ObsClient | undefined;

afterEach(async () => {
	await client?.stop();
	await server?.stop();
	client = undefined;
	server = undefined;
});

async function startPair(options: { password?: string; clientPassword?: string } = {}) {
	server = new MockObsServer({ port: 0, password: options.password });
	const port = await server.start();
	client = new ObsClient({
		url: `ws://127.0.0.1:${port}`,
		password: options.clientPassword,
		reconnect: RECONNECT
	});
	return { server, client };
}

describe('ObsClient', () => {
	it('connects and reports both OBS and websocket versions', async () => {
		const { client } = await startPair();
		client.start();

		await waitFor(() => client.connectionState.status === 'connected', {}, 'connection');

		const state = client.connectionState;
		expect(state).toMatchObject({ status: 'connected', rpcVersion: 1 });
		if (state.status !== 'connected') throw new Error('unreachable');
		expect(state.obsVersion).toBe('32.0.1');
		expect(state.websocketVersion).toBe('5.7.2');
	});

	it('refuses to retry a rejected password', async () => {
		const { client } = await startPair({ password: 'correct', clientPassword: 'wrong' });

		const seen: string[] = [];
		client.onConnectionChange((state) => seen.push(state.status));
		client.start();

		await waitFor(() => client.connectionState.status === 'error', {}, 'auth failure');
		expect(client.connectionState).toMatchObject({ status: 'error', kind: 'auth' });

		// A wrong password is a configuration fault. Confirm it stays terminal rather
		// than sliding back into a retry loop.
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(client.connectionState.status).toBe('error');
		expect(seen).not.toContain('reconnecting');
	});

	it('authenticates when the password is right', async () => {
		const { client } = await startPair({ password: 'correct', clientPassword: 'correct' });
		client.start();
		await waitFor(() => client.connectionState.status === 'connected', {}, 'connection');
		expect(client.identified).toBe(true);
	});

	it('reports OBS refusals with their RequestStatus code', async () => {
		const { client } = await startPair();
		client.start();
		await waitFor(() => client.connectionState.status === 'connected', {}, 'connection');

		await client.call('StartRecord');
		const error = await client.call('StartRecord').catch((e) => e);

		expect(error).toBeInstanceOf(ObsRequestError);
		expect((error as ObsRequestError).code).toBe(RequestStatus.OutputRunning);
	});

	it('rejects requests made while disconnected rather than queueing them', async () => {
		const { client } = await startPair();
		// Deliberately not started: nothing should be buffered for a later flush.
		await expect(client.call('GetVersion')).rejects.toBeInstanceOf(ObsUnavailableError);
	});

	it('reconnects by itself after OBS drops the connection', async () => {
		const { server, client } = await startPair();
		client.start();
		await waitFor(() => client.connectionState.status === 'connected', {}, 'first connection');

		server.dropClients();

		await waitFor(() => client.connectionState.status !== 'connected', {}, 'disconnect');
		await waitFor(
			() => client.connectionState.status === 'connected',
			{ timeoutMs: 8000 },
			'reconnection'
		);
		expect(client.identified).toBe(true);
	});

	it('keeps retrying while OBS is unreachable', async () => {
		client = new ObsClient({
			// Port 1 is reserved and never listening.
			url: 'ws://127.0.0.1:1',
			reconnect: RECONNECT
		});
		client.start();

		await waitFor(
			() => client!.connectionState.status === 'reconnecting',
			{},
			'reconnecting state'
		);
		const state = client.connectionState;
		if (state.status !== 'reconnecting') throw new Error('unreachable');
		expect(state.attempt).toBeGreaterThan(0);
		expect(state.retryInMs).toBeLessThanOrEqual(RECONNECT.maxDelayMs);
	});
});
