import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ObsClient } from '../src/lib/server/obs/client.js';
import { ObsService } from '../src/lib/server/obs/service.js';
import { ObsStore } from '../src/lib/server/obs/store.js';
import {
	ConflictError,
	NotFoundError,
	ObsUnavailableError,
	ValidationError
} from '../src/lib/server/errors.js';
import { MockObsServer } from '../tools/mock-obs/server.js';
import { waitFor } from './helpers.js';

let server: MockObsServer;
let client: ObsClient;
let store: ObsStore;
let service: ObsService;

beforeEach(async () => {
	server = new MockObsServer({ port: 0 });
	const port = await server.start();
	client = new ObsClient({
		url: `ws://127.0.0.1:${port}`,
		reconnect: { initialDelayMs: 50, maxDelayMs: 150 }
	});
	store = new ObsStore(client, 100);
	service = new ObsService(client, store);
	store.start();
	client.start();
	await waitFor(() => store.getSnapshot().connection.status === 'connected', {}, 'connection');
	await waitFor(() => store.getSnapshot().scenes.scenes.length > 0, {}, 'resync');
});

afterEach(async () => {
	store.stop();
	await client.stop();
	await server.stop();
});

describe('recording', () => {
	it('starts and stops, reporting the saved path', async () => {
		await service.startRecording();
		await waitFor(() => store.getSnapshot().recording.active, {}, 'recording');

		const result = await service.stopRecording();
		expect(result.outputPath).toMatch(/\.mkv$/);
	});

	it('reports starting twice as a conflict, not a generic failure', async () => {
		await service.startRecording();
		await expect(service.startRecording()).rejects.toBeInstanceOf(ConflictError);
	});

	it('reports stopping when idle as a conflict', async () => {
		await expect(service.stopRecording()).rejects.toBeInstanceOf(ConflictError);
	});

	it('refuses to pause when nothing is recording', async () => {
		await expect(service.pauseRecording()).rejects.toBeInstanceOf(ConflictError);
	});

	it('refuses to pause twice, and to resume what is not paused', async () => {
		await service.startRecording();
		await expect(service.resumeRecording()).rejects.toBeInstanceOf(ConflictError);

		await service.pauseRecording();
		await expect(service.pauseRecording()).rejects.toBeInstanceOf(ConflictError);

		await service.resumeRecording();
	});
});

describe('scenes', () => {
	it('switches the program scene', async () => {
		await service.setProgramScene('Slides');
		await waitFor(() => store.getSnapshot().scenes.program === 'Slides', {}, 'scene change');
	});

	it('reports an unknown scene as missing rather than as a refusal', async () => {
		await expect(service.setProgramScene('Nope')).rejects.toBeInstanceOf(NotFoundError);
	});

	it('rejects an empty scene name before it reaches OBS', async () => {
		await expect(service.setProgramScene('')).rejects.toBeInstanceOf(ValidationError);
		await expect(service.setProgramScene('   ')).rejects.toBeInstanceOf(ValidationError);
		// Validation happens locally, so OBS is never asked.
		expect(server.countOf('SetCurrentProgramScene')).toBe(0);
	});

	it('refuses preview and transition while studio mode is off', async () => {
		await expect(service.setPreviewScene('Break')).rejects.toBeInstanceOf(ConflictError);
		await expect(service.transition()).rejects.toBeInstanceOf(ConflictError);
	});

	it('stages preview and takes it to air in studio mode', async () => {
		server.apply(() => server.state.setStudioMode(true));
		await waitFor(() => store.getSnapshot().scenes.studioMode, {}, 'studio mode');

		await service.setPreviewScene('Break');
		await waitFor(() => store.getSnapshot().scenes.preview === 'Break', {}, 'preview');
		// Staging must not put the scene on air by itself.
		expect(store.getSnapshot().scenes.program).not.toBe('Break');

		await service.transition();
		await waitFor(() => store.getSnapshot().scenes.program === 'Break', {}, 'transition');
	});
});

describe('when OBS is unreachable', () => {
	it('fails commands as unavailable rather than hanging', async () => {
		await client.stop();
		await expect(service.startRecording()).rejects.toBeInstanceOf(ObsUnavailableError);
		await expect(service.setProgramScene('Slides')).rejects.toBeInstanceOf(ObsUnavailableError);
	});
});
