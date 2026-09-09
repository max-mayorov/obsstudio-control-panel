import { afterEach, describe, expect, it } from 'vitest';
import type { ObsSnapshot, RecordingTick } from '../src/lib/types.js';
import { ObsClient } from '../src/lib/server/obs/client.js';
import { ObsStore } from '../src/lib/server/obs/store.js';
import { MockObsServer, type MockServerOptions } from '../tools/mock-obs/server.js';
import { waitFor } from './helpers.js';

const POLL_MS = 60;

let server: MockObsServer | undefined;
let client: ObsClient | undefined;
let store: ObsStore | undefined;

afterEach(async () => {
	store?.stop();
	await client?.stop();
	await server?.stop();
	server = undefined;
	client = undefined;
	store = undefined;
});

/** Brings up a mock, a client and a store, connected and resynced. */
async function bootstrap(options: MockServerOptions = {}) {
	server = new MockObsServer({ port: 0, ...options });
	const port = await server.start();
	client = new ObsClient({
		url: `ws://127.0.0.1:${port}`,
		reconnect: { initialDelayMs: 50, maxDelayMs: 150 }
	});
	store = new ObsStore(client, POLL_MS);
	store.start();
	client.start();

	await waitFor(() => store!.getSnapshot().connection.status === 'connected', {}, 'connection');
	await waitFor(() => store!.getSnapshot().scenes.scenes.length > 0, {}, 'scene resync');
	return { server, client, store };
}

/** Collects snapshots and ticks pushed to a subscriber. */
function collect(target: ObsStore) {
	const states: ObsSnapshot[] = [];
	const ticks: RecordingTick[] = [];
	const unsubscribe = target.subscribe({
		onState: (snapshot) => states.push(snapshot),
		onTick: (tick) => ticks.push(tick)
	});
	return { states, ticks, unsubscribe };
}

describe('ObsStore', () => {
	it('resyncs scenes, studio mode and the record directory on connect', async () => {
		const { store } = await bootstrap();
		const snapshot = store.getSnapshot();

		expect(snapshot.scenes.scenes.map((scene) => scene.name)).toEqual([
			'Wide',
			'Close-up',
			'Slides',
			'Break'
		]);
		expect(snapshot.scenes.program).toBe('Wide');
		expect(snapshot.scenes.studioMode).toBe(false);
		expect(snapshot.scenes.stale).toBe(false);
		expect(snapshot.recording.directory).toBe('/home/user/Videos');
	});

	it('takes the filename from OBS when OBS reports one', async () => {
		const { server, store } = await bootstrap();
		server.apply(() => server.state.startRecording());

		await waitFor(() => store.getSnapshot().recording.active, {}, 'recording to start');

		const { file } = store.getSnapshot().recording;
		expect(file?.source).toBe('obs');
		expect(file?.path).toMatch(/^\/home\/user\/Videos\/.+\.mkv$/);
	});

	it('predicts the filename when OBS omits it, and says the value is predicted', async () => {
		// Emulates an older OBS, matching what the published protocol docs describe.
		const { server, store } = await bootstrap({ omitOutputPathOnStart: true });
		server.apply(() => server.state.startRecording());

		await waitFor(() => store.getSnapshot().recording.active, {}, 'recording to start');

		const { file } = store.getSnapshot().recording;
		expect(file?.source).toBe('predicted');
		expect(file?.path).toMatch(/^\/home\/user\/Videos\/.+\.mkv$/);
	});

	it('predicts the filename for a recording that was already running when we connected', async () => {
		const mock = (server = new MockObsServer({ port: 0 }));
		const port = await mock.start();
		// The recording starts before anything connects, so the event carrying its path
		// is gone by the time the store exists. This is the case no request can recover.
		mock.state.startRecording();

		const obsClient = (client = new ObsClient({
			url: `ws://127.0.0.1:${port}`,
			reconnect: { initialDelayMs: 50, maxDelayMs: 150 }
		}));
		const obsStore = (store = new ObsStore(obsClient, POLL_MS));
		obsStore.start();
		obsClient.start();

		await waitFor(() => obsStore.getSnapshot().recording.active, {}, 'recording state');

		const { file } = obsStore.getSnapshot().recording;
		expect(file?.source).toBe('predicted');
		expect(file?.path).toMatch(/\.mkv$/);
	});

	it('replaces a predicted path with the authoritative one when recording stops', async () => {
		const { server, store } = await bootstrap({ omitOutputPathOnStart: true });
		server.apply(() => server.state.startRecording());
		await waitFor(() => store.getSnapshot().recording.active, {}, 'recording to start');

		const { events, outputPath } = server.state.stopRecording();
		server.broadcast(events);

		await waitFor(() => !store.getSnapshot().recording.active, {}, 'recording to stop');
		expect(store.getSnapshot().recording.lastCompleted?.path).toBe(outputPath);
		expect(store.getSnapshot().recording.file).toBeNull();
	});

	it('follows a mid-recording file split', async () => {
		const { server, store } = await bootstrap();
		server.apply(() => server.state.startRecording());
		await waitFor(() => store.getSnapshot().recording.active, {}, 'recording to start');
		const first = store.getSnapshot().recording.file?.path;

		server.apply(() => server.state.splitRecordFile());

		await waitFor(
			() => store.getSnapshot().recording.file?.path !== first,
			{},
			'file to roll over'
		);
		expect(store.getSnapshot().recording.file?.source).toBe('obs');
	});

	it('reflects a scene created in OBS without being asked', async () => {
		const { server, store } = await bootstrap();
		server.apply(() => server.state.createScene('Interview'));

		await waitFor(
			() => store.getSnapshot().scenes.scenes.some((scene) => scene.name === 'Interview'),
			{},
			'new scene'
		);
	});

	it('tracks studio mode and the preview scene', async () => {
		const { server, store } = await bootstrap();
		server.apply(() => server.state.setStudioMode(true));

		await waitFor(() => store.getSnapshot().scenes.studioMode, {}, 'studio mode');
		await waitFor(() => store.getSnapshot().scenes.preview !== null, {}, 'preview scene');

		server.apply(() => server.state.setPreviewScene('Break'));
		await waitFor(() => store.getSnapshot().scenes.preview === 'Break', {}, 'preview change');
	});

	it('emits ticks while recording and a subscriber is attached', async () => {
		const { server, store } = await bootstrap();
		const sink = collect(store);

		server.apply(() => server.state.startRecording());
		await waitFor(() => sink.ticks.length >= 2, {}, 'recording ticks');

		expect(sink.ticks[0].timecode).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
		expect(sink.ticks.at(-1)!.durationMs).toBeGreaterThan(0);
		sink.unsubscribe();
	});

	it('stops sampling OBS once nobody is watching', async () => {
		const { server, store } = await bootstrap();
		const sink = collect(store);

		server.apply(() => server.state.startRecording());
		await waitFor(() => sink.ticks.length >= 2, {}, 'recording ticks');

		sink.unsubscribe();
		server.resetCounts();
		await new Promise((resolve) => setTimeout(resolve, POLL_MS * 5));

		// Still recording, but no subscriber: an idle server must not poll OBS.
		expect(store.getSnapshot().recording.active).toBe(true);
		expect(server.countOf('GetRecordStatus')).toBe(0);
	});

	it('never samples at all when the heartbeat is disabled', async () => {
		const mock = (server = new MockObsServer({ port: 0 }));
		const port = await mock.start();
		const obsClient = (client = new ObsClient({
			url: `ws://127.0.0.1:${port}`,
			reconnect: { initialDelayMs: 50, maxDelayMs: 150 }
		}));
		const obsStore = (store = new ObsStore(obsClient, 0)); // OBS_POLL_INTERVAL_MS=0
		obsStore.start();
		obsClient.start();
		await waitFor(() => obsStore.getSnapshot().connection.status === 'connected', {}, 'connect');

		const sink = collect(obsStore);
		mock.apply(() => mock.state.startRecording());
		await waitFor(() => obsStore.getSnapshot().recording.active, {}, 'recording');
		mock.resetCounts();
		await new Promise((resolve) => setTimeout(resolve, 200));

		expect(mock.countOf('GetRecordStatus')).toBe(0);
		expect(sink.ticks).toHaveLength(0);
		sink.unsubscribe();
	});

	it('marks scenes stale when OBS goes away, keeping the last known list', async () => {
		const { server, store } = await bootstrap();
		expect(store.getSnapshot().scenes.scenes).not.toHaveLength(0);

		server.dropClients();

		await waitFor(() => store.getSnapshot().scenes.stale, {}, 'stale marking');
		// The list survives so the UI can grey it out rather than flash empty.
		expect(store.getSnapshot().scenes.scenes).not.toHaveLength(0);
	});
});
