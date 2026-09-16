/**
 * The authoritative view of OBS held by this process.
 *
 * Everything the browser sees comes from here: the SSE stream pushes snapshots, and the
 * page's server-side load reads the same object, so a freshly loaded page and a
 * long-lived stream cannot disagree.
 *
 * The store is only ever written by OBS — events, and the resync performed on every
 * (re)connection. Commands do not touch it (DESIGN.md D4). That is what keeps the UI
 * correct when someone hits Record in OBS itself rather than in this app.
 */
import type {
	ConnectionState,
	ObsSnapshot,
	RecordingFile,
	RecordingState,
	RecordingTick,
	SceneSummary
} from '$lib/types';
import { loggerFor } from '../log';
import type { ObsClient } from './client';
import { predictRecordingPath, type RecordingPathSources } from './filename';
import { OutputState } from './protocol';

const log = loggerFor('obs-store');

const ZERO_TIMECODE = '00:00:00.000';

export interface ObsStoreSubscriber {
	onState(snapshot: ObsSnapshot): void;
	onTick(tick: RecordingTick): void;
}

function initialSnapshot(heartbeatMs: number): ObsSnapshot {
	return {
		connection: { status: 'connecting', attempt: 0 },
		recording: {
			active: false,
			paused: false,
			stale: true,
			timecode: ZERO_TIMECODE,
			durationMs: 0,
			bytes: 0,
			file: null,
			lastCompleted: null,
			directory: null
		},
		scenes: { scenes: [], program: null, preview: null, studioMode: false, stale: true },
		heartbeatMs,
		serverTime: Date.now()
	};
}

export class ObsStore {
	private snapshot: ObsSnapshot;
	private readonly subscribers = new Set<ObsStoreSubscriber>();
	private readonly disposers: Array<() => void> = [];

	/** Profile values used to predict a filename OBS did not report. */
	private profile: RecordingPathSources = { directory: null, template: null, extension: null };

	private ticker: ReturnType<typeof setInterval> | undefined;
	private sceneResync: ReturnType<typeof setTimeout> | undefined;
	private started = false;

	constructor(
		private readonly client: ObsClient,
		private readonly pollIntervalMs: number
	) {
		this.snapshot = initialSnapshot(pollIntervalMs);
	}

	getSnapshot(): ObsSnapshot {
		return this.snapshot;
	}

	/**
	 * Subscribes to state snapshots and recording ticks. The recording heartbeat only
	 * runs while at least one subscriber is attached, so an idle server polls nothing.
	 */
	subscribe(subscriber: ObsStoreSubscriber): () => void {
		this.subscribers.add(subscriber);
		this.updateTicker();
		return () => {
			this.subscribers.delete(subscriber);
			this.updateTicker();
		};
	}

	/**
	 * Samples the recording numbers once, on demand.
	 *
	 * The heartbeat only runs for stream subscribers, so a client polling `/api/state`
	 * would otherwise read a timecode frozen at whatever the last stream update left
	 * behind. One sample per poll is exactly what such a client is asking for.
	 */
	async refreshRecording(): Promise<void> {
		if (!this.snapshot.recording.active) return;
		if (this.snapshot.connection.status !== 'connected') return;
		await this.tick();
	}

	start(): void {
		if (this.started) return;
		this.started = true;

		this.disposers.push(
			this.client.onConnectionChange((state) => this.onConnectionChange(state)),

			this.client.onEvent('RecordStateChanged', (data) =>
				this.onRecordStateChanged(
					data as { outputActive: boolean; outputState: string; outputPath: string | null }
				)
			),
			this.client.onEvent('RecordFileChanged', (data) => {
				// Emitted when the output rolls over to a new file mid-recording.
				this.setRecordingFile({ path: data.newOutputPath, source: 'obs' });
			}),

			this.client.onEvent('CurrentProgramSceneChanged', (data) =>
				this.patchScenes({ program: data.sceneName })
			),
			this.client.onEvent('CurrentPreviewSceneChanged', (data) =>
				this.patchScenes({ preview: data.sceneName })
			),
			this.client.onEvent('SceneListChanged', (data) =>
				this.patchScenes({ scenes: toSceneSummaries(data.scenes) })
			),
			// Not every OBS build pairs these with SceneListChanged, so re-read the list.
			// The resync is debounced because renaming a scene emits several at once.
			this.client.onEvent('SceneCreated', () => this.scheduleSceneResync()),
			this.client.onEvent('SceneRemoved', () => this.scheduleSceneResync()),
			this.client.onEvent('SceneNameChanged', () => this.scheduleSceneResync()),

			this.client.onEvent('StudioModeStateChanged', (data) => {
				this.patchScenes({ studioMode: data.studioModeEnabled });
				// Preview only becomes meaningful once studio mode is on.
				void this.resyncScenes();
			})
		);
	}

	stop(): void {
		this.started = false;
		for (const dispose of this.disposers) dispose();
		this.disposers.length = 0;
		this.stopTicker();
		if (this.sceneResync) clearTimeout(this.sceneResync);
		this.sceneResync = undefined;
	}

	// ------------------------------------------------------------ connection

	private onConnectionChange(connection: ConnectionState): void {
		log.info({ connection }, 'Connection state changed');
		this.patch({ connection });
		if (connection.status === 'connected') {
			this.resync();
			return;
		}

		// Keep the last known scene list on screen but mark it stale, so the UI can grey
		// it out instead of flashing empty every time OBS restarts.
		this.patchScenes({ stale: true });
		this.patchRecording({ stale: true });
		this.updateTicker();
	}

	/**
	 * Re-reads everything after a (re)connection, then publishes it as a single snapshot.
	 *
	 * Any event missed while disconnected is corrected here, which is why the store never
	 * needs to detect gaps. Patching once rather than per-response matters: a partial
	 * resync would otherwise be visible to subscribers — a scene list already refreshed
	 * while the record directory was still null — and would cost three stream frames
	 * where one will do.
	 */
	private async resync(): Promise<void> {
		try {
			const [scenes, profile, status] = await Promise.all([
				this.fetchScenes(),
				this.fetchProfile(),
				this.client.call('GetRecordStatus')
			]);

			this.profile = profile;

			// A recording already running when we connected has lost the only message
			// that carried its path, so predict one and mark it as predicted.
			let file = this.snapshot.recording.file;
			if (status.outputActive && !file) {
				file = predictedFile(profile, new Date(Date.now() - status.outputDuration));
				if (file) log.info({ path: file.path }, 'predicted filename for a running recording');
			} else if (!status.outputActive) {
				file = null;
			}

			this.patch({
				scenes,
				recording: {
					...this.snapshot.recording,
					directory: profile.directory,
					active: status.outputActive,
					paused: status.outputPaused,
					stale: false,
					timecode: status.outputTimecode,
					durationMs: status.outputDuration,
					bytes: status.outputBytes,
					file
				}
			});

			this.updateTicker();
			log.debug('resynced OBS state');
		} catch (error) {
			log.warn({ err: error }, 'resync failed; will retry on next connection');
		}
	}

	private async fetchScenes(): Promise<ObsSnapshot['scenes']> {
		const [list, studio] = await Promise.all([
			this.client.call('GetSceneList'),
			this.client.call('GetStudioModeEnabled')
		]);
		return {
			scenes: toSceneSummaries(list.scenes),
			program: list.currentProgramSceneName || null,
			preview: studio.studioModeEnabled ? list.currentPreviewSceneName || null : null,
			studioMode: studio.studioModeEnabled,
			stale: false
		};
	}

	private async resyncScenes(): Promise<void> {
		this.patchScenes(await this.fetchScenes());
	}

	private async fetchProfile(): Promise<RecordingPathSources> {
		const directory = await this.client
			.call('GetRecordDirectory')
			.then((response) => response.recordDirectory)
			.catch(() => null);

		const template = await this.profileParameter('Output', 'FilenameFormatting');
		// Simple and Advanced output modes keep the container in different sections.
		const mode = await this.profileParameter('Output', 'Mode');
		const extension = await this.profileParameter(
			mode === 'Advanced' ? 'AdvOut' : 'SimpleOutput',
			'RecFormat2'
		);

		return { directory, template, extension };
	}

	private async profileParameter(category: string, name: string): Promise<string | null> {
		try {
			const response = await this.client.call('GetProfileParameter', {
				parameterCategory: category,
				parameterName: name
			});
			return response.parameterValue ?? response.defaultParameterValue ?? null;
		} catch {
			// A profile that does not define the parameter is normal, not an error.
			return null;
		}
	}

	private async resyncRecording(): Promise<void> {
		const status = await this.client.call('GetRecordStatus');

		// If a recording is already running we have missed the event carrying its path,
		// and no request will return it. Predict, and mark the prediction as such.
		let file = this.snapshot.recording.file;
		if (status.outputActive && !file) {
			const startedAt = new Date(Date.now() - status.outputDuration);
			const predicted = predictRecordingPath(this.profile, startedAt);
			file = predicted ? { path: predicted, source: 'predicted' } : null;
			if (predicted) {
				log.info({ path: predicted }, 'predicted filename for a recording already in progress');
			}
		} else if (!status.outputActive) {
			file = null;
		}

		this.patchRecording({
			active: status.outputActive,
			paused: status.outputPaused,
			timecode: status.outputTimecode,
			durationMs: status.outputDuration,
			bytes: status.outputBytes,
			file
		});
		this.updateTicker();
	}

	// ---------------------------------------------------------------- events

	private onRecordStateChanged(data: {
		outputActive: boolean;
		outputState: string;
		outputPath: string | null;
	}): void {
		switch (data.outputState) {
			case OutputState.Started: {
				// Current OBS reports the path here. Older builds send null, in which case
				// we fall back to prediction rather than showing nothing.
				const file: RecordingFile | null = data.outputPath
					? { path: data.outputPath, source: 'obs' }
					: predictedFile(this.profile, new Date());

				this.patchRecording({
					active: true,
					paused: false,
					file,
					timecode: ZERO_TIMECODE,
					durationMs: 0,
					bytes: 0
				});
				break;
			}

			case OutputState.Stopped: {
				this.patchRecording({
					active: false,
					paused: false,
					file: null,
					lastCompleted: data.outputPath
						? { path: data.outputPath, endedAt: Date.now() }
						: this.snapshot.recording.lastCompleted,
					timecode: ZERO_TIMECODE,
					durationMs: 0,
					bytes: 0
				});
				break;
			}

			case OutputState.Paused:
				this.patchRecording({ paused: true });
				break;

			case OutputState.Resumed:
				this.patchRecording({ paused: false });
				break;

			default:
				// STARTING and STOPPING are transitional; the settled state follows.
				break;
		}
		this.updateTicker();
	}

	private setRecordingFile(file: RecordingFile): void {
		this.patchRecording({ file });
	}

	private scheduleSceneResync(): void {
		if (this.sceneResync) return;
		this.sceneResync = setTimeout(() => {
			this.sceneResync = undefined;
			void this.resyncScenes().catch((error) => log.debug({ err: error }, 'scene resync failed'));
		}, 50);
		this.sceneResync.unref?.();
	}

	// --------------------------------------------------------------- ticker

	/**
	 * OBS emits no timecode event, so the recording heartbeat is a request loop over the
	 * open socket (DESIGN.md section 8). It runs only while a recording is active and
	 * somebody is watching, and stops the moment either stops being true.
	 */
	private updateTicker(): void {
		const wanted =
			this.pollIntervalMs > 0 &&
			this.snapshot.recording.active &&
			this.subscribers.size > 0 &&
			this.snapshot.connection.status === 'connected';

		if (wanted && !this.ticker) {
			this.ticker = setInterval(() => void this.tick(), this.pollIntervalMs);
			this.ticker.unref?.();
		} else if (!wanted && this.ticker) {
			this.stopTicker();
		}
	}

	private stopTicker(): void {
		if (this.ticker) clearInterval(this.ticker);
		this.ticker = undefined;
	}

	private async tick(): Promise<void> {
		try {
			const status = await this.client.call('GetRecordStatus');

			// Normally the numbers move and the flags do not. If a state event was missed,
			// this is where we notice and fall back to a full snapshot.
			if (
				status.outputActive !== this.snapshot.recording.active ||
				status.outputPaused !== this.snapshot.recording.paused
			) {
				await this.resyncRecording();
				return;
			}

			this.snapshot = {
				...this.snapshot,
				recording: {
					...this.snapshot.recording,
					timecode: status.outputTimecode,
					durationMs: status.outputDuration,
					bytes: status.outputBytes
				},
				serverTime: Date.now()
			};

			this.emitTick({
				timecode: status.outputTimecode,
				durationMs: status.outputDuration,
				bytes: status.outputBytes,
				at: this.snapshot.serverTime
			});
		} catch (error) {
			// A failed sample is not worth a state change: the connection listener already
			// reports a dropped socket, and the next tick either works or the ticker stops.
			log.debug({ err: error }, 'recording heartbeat failed');
		}
	}

	// ---------------------------------------------------------------- patching

	private patch(partial: Partial<ObsSnapshot>): void {
		this.snapshot = { ...this.snapshot, ...partial, serverTime: Date.now() };
		this.emitState();
	}

	private patchRecording(partial: Partial<RecordingState>): void {
		this.patch({ recording: { ...this.snapshot.recording, ...partial } });
	}

	private patchScenes(partial: Partial<ObsSnapshot['scenes']>): void {
		this.patch({ scenes: { ...this.snapshot.scenes, ...partial } });
	}

	private emitState(): void {
		for (const subscriber of this.subscribers) {
			try {
				subscriber.onState(this.snapshot);
			} catch (error) {
				log.error({ err: error }, 'state subscriber threw');
			}
		}
	}

	private emitTick(tick: RecordingTick): void {
		for (const subscriber of this.subscribers) {
			try {
				subscriber.onTick(tick);
			} catch (error) {
				log.error({ err: error }, 'tick subscriber threw');
			}
		}
	}
}

function predictedFile(sources: RecordingPathSources, startedAt: Date): RecordingFile | null {
	const path = predictRecordingPath(sources, startedAt);
	return path ? { path, source: 'predicted' } : null;
}

function toSceneSummaries(scenes: unknown[]): SceneSummary[] {
	return scenes
		.map((scene) => scene as { sceneName?: unknown; sceneUuid?: unknown })
		.filter((scene) => typeof scene.sceneName === 'string')
		.map((scene) => ({
			name: scene.sceneName as string,
			uuid: typeof scene.sceneUuid === 'string' ? scene.sceneUuid : ''
		}));
}
