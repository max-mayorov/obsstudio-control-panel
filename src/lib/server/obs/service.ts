/**
 * Use cases, expressed in domain terms.
 *
 * Knows nothing about HTTP: it takes plain arguments and throws domain errors, which is
 * what lets it be tested without a request object. Its main job is turning OBS's numeric
 * `RequestStatus` refusals into errors that carry meaning — "already recording" is a
 * conflict, an unknown scene is a missing resource — so routes never inspect OBS codes.
 */
import type { ObsSnapshot, StopRecordingResult } from '$lib/types';
import { ConflictError, NotFoundError, ObsRequestError, ValidationError } from '../errors';
import { loggerFor } from '../log';
import type { ObsClient } from './client';
import { RequestStatus } from './protocol';
import type { ObsStore } from './store';

const log = loggerFor('obs-service');

/** Maps specific OBS refusal codes onto domain errors. */
type RefusalMap = Partial<Record<number, () => Error>>;

export class ObsService {
	constructor(
		private readonly client: ObsClient,
		private readonly store: ObsStore
	) {}

	/**
	 * The current state, with the recording numbers refreshed first so a caller polling
	 * this endpoint sees a timecode that actually advances.
	 */
	async snapshot(): Promise<ObsSnapshot> {
		await this.store.refreshRecording();
		return this.store.getSnapshot();
	}

	/** The last known state, without contacting OBS. For cheap reads like healthchecks. */
	peek(): ObsSnapshot {
		return this.store.getSnapshot();
	}

	async startRecording(): Promise<void> {
		log.info('start recording requested');
		await this.run(() => this.client.call('StartRecord'), {
			[RequestStatus.OutputRunning]: () => new ConflictError('A recording is already running'),
			[RequestStatus.OutputDisabled]: () =>
				new ConflictError('The record output is disabled in OBS')
		});
	}

	async stopRecording(): Promise<StopRecordingResult> {
		log.info('stop recording requested');
		const response = await this.run(() => this.client.call('StopRecord'), {
			[RequestStatus.OutputNotRunning]: () => new ConflictError('No recording is running')
		});
		return { outputPath: response.outputPath || null };
	}

	async pauseRecording(): Promise<void> {
		await this.run(() => this.client.call('PauseRecord'), {
			[RequestStatus.OutputNotRunning]: () => new ConflictError('No recording is running'),
			[RequestStatus.OutputPaused]: () => new ConflictError('The recording is already paused')
		});
	}

	async resumeRecording(): Promise<void> {
		await this.run(() => this.client.call('ResumeRecord'), {
			[RequestStatus.OutputNotRunning]: () => new ConflictError('No recording is running'),
			[RequestStatus.OutputNotPaused]: () => new ConflictError('The recording is not paused')
		});
	}

	/**
	 * Cuts the named scene to program.
	 *
	 * In studio mode this bypasses preview and goes straight to air, which is why the UI
	 * routes clicks to `setPreviewScene` instead while studio mode is on.
	 */
	async setProgramScene(name: string): Promise<void> {
		const sceneName = requireSceneName(name);
		log.info({ sceneName }, 'program scene change requested');
		await this.run(() => this.client.call('SetCurrentProgramScene', { sceneName }), {
			[RequestStatus.ResourceNotFound]: () => new NotFoundError(`No scene named '${sceneName}'`)
		});
	}

	async setPreviewScene(name: string): Promise<void> {
		const sceneName = requireSceneName(name);
		await this.run(() => this.client.call('SetCurrentPreviewScene', { sceneName }), {
			[RequestStatus.ResourceNotFound]: () => new NotFoundError(`No scene named '${sceneName}'`),
			[RequestStatus.StudioModeNotActive]: () =>
				new ConflictError('Studio mode is not active, so there is no preview to set')
		});
	}

	/** Takes the preview scene to program. Studio mode only. */
	async transition(): Promise<void> {
		log.info('studio transition requested');
		await this.run(() => this.client.call('TriggerStudioModeTransition'), {
			[RequestStatus.StudioModeNotActive]: () =>
				new ConflictError('Studio mode is not active, so there is nothing to transition')
		});
	}

	/**
	 * Runs an OBS request, translating the refusals we have a better word for. Anything
	 * unmapped keeps its `ObsRequestError`, reported as an upstream failure rather than
	 * being flattened into a generic 500.
	 */
	private async run<T>(operation: () => Promise<T>, refusals: RefusalMap = {}): Promise<T> {
		try {
			return await operation();
		} catch (error) {
			if (error instanceof ObsRequestError) {
				const mapped = refusals[error.code];
				if (mapped) throw mapped();
			}
			throw error;
		}
	}
}

function requireSceneName(name: unknown): string {
	if (typeof name !== 'string' || name.trim() === '') {
		throw new ValidationError('A non-empty scene name is required');
	}
	return name;
}
