/**
 * The mock's model of OBS: scenes, studio mode, the record output and the profile
 * parameters we read.
 *
 * State transitions return the events they generate rather than emitting them, so this
 * file stays pure and the server owns all transport. Every rejection carries a real
 * obs-websocket `RequestStatus` code, which is what makes the mock useful for testing
 * our HTTP error mapping.
 */
import { randomUUID } from 'node:crypto';
import { RequestStatus, OutputState, formatTimecode } from '../../src/lib/server/obs/protocol.js';
import { buildRecordingPath } from '../../src/lib/server/obs/filename.js';

export interface MockScene {
	name: string;
	uuid: string;
}

export interface MockEvent {
	eventType: string;
	eventData: Record<string, unknown>;
}

export class MockRequestError extends Error {
	constructor(
		readonly code: number,
		readonly comment: string
	) {
		super(comment);
		this.name = 'MockRequestError';
	}
}

export interface MockObsOptions {
	scenes?: string[];
	studioMode?: boolean;
	recordDirectory?: string;
	filenameFormatting?: string;
	recordFormat?: string;
	obsVersion?: string;
	obsWebSocketVersion?: string;
	/**
	 * Emulate an OBS build that leaves `outputPath` null on OUTPUT_STARTED, which is what
	 * the published protocol docs describe. Exercises tier-2 filename prediction.
	 */
	omitOutputPathOnStart?: boolean;
	bytesPerSecond?: number;
	now?: () => number;
}

export class MockObsState {
	private scenesList: MockScene[];
	private programSceneName: string;
	private previewSceneName: string;
	private studio: boolean;

	private readonly recording = {
		active: false,
		paused: false,
		startedAt: 0,
		pausedAt: 0,
		pausedTotalMs: 0,
		/**
		 * Milliseconds of *media* time deliberately lost, emulating dropped frames under
		 * encoder overload. OBS derives duration from frame count, so its timecode falls
		 * behind wall clock when this happens — the reason the app samples rather than
		 * extrapolating (DESIGN.md section 8).
		 */
		droppedMs: 0,
		path: null as string | null
	};

	readonly obsVersion: string;
	readonly obsWebSocketVersion: string;
	readonly omitOutputPathOnStart: boolean;

	private recordDirectory: string;
	private filenameFormatting: string;
	private recordFormat: string;
	private readonly bytesPerSecond: number;
	private readonly now: () => number;

	constructor(options: MockObsOptions = {}) {
		const names = options.scenes ?? ['Wide', 'Close-up', 'Slides', 'Break'];
		this.scenesList = names.map((name) => ({ name, uuid: randomUUID() }));
		this.programSceneName = this.scenesList[0]?.name ?? '';
		this.previewSceneName = this.scenesList[1]?.name ?? this.programSceneName;
		this.studio = options.studioMode ?? false;

		this.obsVersion = options.obsVersion ?? '32.0.1';
		this.obsWebSocketVersion = options.obsWebSocketVersion ?? '5.7.2';
		this.omitOutputPathOnStart = options.omitOutputPathOnStart ?? false;
		this.recordDirectory = options.recordDirectory ?? '/home/user/Videos';
		this.filenameFormatting = options.filenameFormatting ?? '%CCYY-%MM-%DD %hh-%mm-%ss';
		this.recordFormat = options.recordFormat ?? 'mkv';
		this.bytesPerSecond = options.bytesPerSecond ?? 6_000_000;
		this.now = options.now ?? (() => Date.now());
	}

	// ---------------------------------------------------------------- scenes

	get scenes(): MockScene[] {
		return this.scenesList;
	}

	get program(): string {
		return this.programSceneName;
	}

	get preview(): string {
		return this.previewSceneName;
	}

	get studioMode(): boolean {
		return this.studio;
	}

	scenePayload(): Record<string, unknown>[] {
		// OBS lists scenes in reverse UI order; index 0 is the bottom of the list.
		return this.scenesList.map((scene, index) => ({
			sceneName: scene.name,
			sceneUuid: scene.uuid,
			sceneIndex: index
		}));
	}

	private find(name: string): MockScene {
		const scene = this.scenesList.find((candidate) => candidate.name === name);
		if (!scene) {
			throw new MockRequestError(RequestStatus.ResourceNotFound, `No scene named '${name}'`);
		}
		return scene;
	}

	setProgramScene(name: string): MockEvent[] {
		const scene = this.find(name);
		if (this.programSceneName === name) return [];
		this.programSceneName = name;
		return [
			{
				eventType: 'CurrentProgramSceneChanged',
				eventData: { sceneName: scene.name, sceneUuid: scene.uuid }
			}
		];
	}

	setPreviewScene(name: string): MockEvent[] {
		if (!this.studio) {
			throw new MockRequestError(RequestStatus.StudioModeNotActive, 'Studio mode is not active');
		}
		const scene = this.find(name);
		if (this.previewSceneName === name) return [];
		this.previewSceneName = name;
		return [
			{
				eventType: 'CurrentPreviewSceneChanged',
				eventData: { sceneName: scene.name, sceneUuid: scene.uuid }
			}
		];
	}

	triggerTransition(): MockEvent[] {
		if (!this.studio) {
			throw new MockRequestError(RequestStatus.StudioModeNotActive, 'Studio mode is not active');
		}
		return this.setProgramScene(this.previewSceneName);
	}

	setStudioMode(enabled: boolean): MockEvent[] {
		if (this.studio === enabled) return [];
		this.studio = enabled;
		return [{ eventType: 'StudioModeStateChanged', eventData: { studioModeEnabled: enabled } }];
	}

	createScene(name: string): MockEvent[] {
		if (this.scenesList.some((scene) => scene.name === name)) {
			throw new MockRequestError(RequestStatus.ResourceAlreadyExists, `Scene '${name}' exists`);
		}
		const scene: MockScene = { name, uuid: randomUUID() };
		this.scenesList = [...this.scenesList, scene];
		return [
			{
				eventType: 'SceneCreated',
				eventData: { sceneName: scene.name, sceneUuid: scene.uuid, isGroup: false }
			},
			{ eventType: 'SceneListChanged', eventData: { scenes: this.scenePayload() } }
		];
	}

	removeScene(name: string): MockEvent[] {
		const scene = this.find(name);
		this.scenesList = this.scenesList.filter((candidate) => candidate.name !== name);
		const events: MockEvent[] = [
			{
				eventType: 'SceneRemoved',
				eventData: { sceneName: scene.name, sceneUuid: scene.uuid, isGroup: false }
			},
			{ eventType: 'SceneListChanged', eventData: { scenes: this.scenePayload() } }
		];
		// OBS moves program on to a surviving scene; mirroring that keeps our state honest.
		if (this.programSceneName === name && this.scenesList[0]) {
			events.push(...this.setProgramScene(this.scenesList[0].name));
		}
		return events;
	}

	renameScene(from: string, to: string): MockEvent[] {
		const scene = this.find(from);
		scene.name = to;
		if (this.programSceneName === from) this.programSceneName = to;
		if (this.previewSceneName === from) this.previewSceneName = to;
		return [
			{
				eventType: 'SceneNameChanged',
				eventData: { sceneUuid: scene.uuid, oldSceneName: from, sceneName: to }
			},
			{ eventType: 'SceneListChanged', eventData: { scenes: this.scenePayload() } }
		];
	}

	// ------------------------------------------------------------- recording

	get isRecording(): boolean {
		return this.recording.active;
	}

	private durationMs(): number {
		if (!this.recording.active) return 0;
		const pausedFor = this.recording.paused ? this.now() - this.recording.pausedAt : 0;
		const elapsed =
			this.now() -
			this.recording.startedAt -
			this.recording.pausedTotalMs -
			pausedFor -
			this.recording.droppedMs;
		return Math.max(0, elapsed);
	}

	recordStatus() {
		const durationMs = this.durationMs();
		return {
			outputActive: this.recording.active,
			outputPaused: this.recording.paused,
			outputTimecode: formatTimecode(durationMs),
			outputDuration: durationMs,
			outputBytes: Math.floor((durationMs / 1000) * this.bytesPerSecond)
		};
	}

	private newRecordingPath(): string {
		return buildRecordingPath({
			directory: this.recordDirectory,
			template: this.filenameFormatting,
			extension: this.recordFormat,
			at: new Date(this.now())
		});
	}

	startRecording(): MockEvent[] {
		if (this.recording.active) {
			throw new MockRequestError(RequestStatus.OutputRunning, 'Record output is already active');
		}
		this.recording.active = true;
		this.recording.paused = false;
		this.recording.startedAt = this.now();
		this.recording.pausedTotalMs = 0;
		this.recording.pausedAt = 0;
		this.recording.droppedMs = 0;
		this.recording.path = this.newRecordingPath();

		return [
			this.recordEvent(OutputState.Starting, null),
			this.recordEvent(OutputState.Started, this.omitOutputPathOnStart ? null : this.recording.path)
		];
	}

	stopRecording(): { events: MockEvent[]; outputPath: string } {
		if (!this.recording.active) {
			throw new MockRequestError(RequestStatus.OutputNotRunning, 'Record output is not active');
		}
		const outputPath = this.recording.path ?? '';
		const events = [
			this.recordEvent(OutputState.Stopping, null),
			this.recordEvent(OutputState.Stopped, outputPath)
		];
		this.recording.active = false;
		this.recording.paused = false;
		this.recording.path = null;
		return { events, outputPath };
	}

	pauseRecording(): MockEvent[] {
		if (!this.recording.active) {
			throw new MockRequestError(RequestStatus.OutputNotRunning, 'Record output is not active');
		}
		if (this.recording.paused) {
			throw new MockRequestError(RequestStatus.OutputPaused, 'Record output is already paused');
		}
		this.recording.paused = true;
		this.recording.pausedAt = this.now();
		return [this.recordEvent(OutputState.Paused, null)];
	}

	resumeRecording(): MockEvent[] {
		if (!this.recording.active) {
			throw new MockRequestError(RequestStatus.OutputNotRunning, 'Record output is not active');
		}
		if (!this.recording.paused) {
			throw new MockRequestError(RequestStatus.OutputNotPaused, 'Record output is not paused');
		}
		this.recording.pausedTotalMs += this.now() - this.recording.pausedAt;
		this.recording.paused = false;
		this.recording.pausedAt = 0;
		return [this.recordEvent(OutputState.Resumed, null)];
	}

	splitRecordFile(): MockEvent[] {
		if (!this.recording.active) {
			throw new MockRequestError(RequestStatus.OutputNotRunning, 'Record output is not active');
		}
		this.recording.path = this.newRecordingPath();
		return [{ eventType: 'RecordFileChanged', eventData: { newOutputPath: this.recording.path } }];
	}

	/** Emulates encoder overload: media time falls behind wall clock by `ms`. */
	dropFrames(ms: number): void {
		this.recording.droppedMs += Math.max(0, ms);
	}

	private recordEvent(outputState: string, outputPath: string | null): MockEvent {
		return {
			eventType: 'RecordStateChanged',
			eventData: {
				outputActive: outputState === OutputState.Started || outputState === OutputState.Starting,
				outputState,
				outputPath
			}
		};
	}

	// --------------------------------------------------------------- profile

	getProfileParameter(category: string, name: string): string | null {
		if (category === 'Output' && name === 'FilenameFormatting') return this.filenameFormatting;
		if (category === 'Output' && name === 'OverwriteIfExists') return 'false';
		if (category === 'SimpleOutput' && name === 'RecFormat2') return this.recordFormat;
		if (category === 'AdvOut' && name === 'RecFormat2') return this.recordFormat;
		return null;
	}

	setProfileParameter(category: string, name: string, value: string | null): void {
		if (category === 'Output' && name === 'FilenameFormatting' && value) {
			this.filenameFormatting = value;
		}
	}

	getRecordDirectory(): string {
		return this.recordDirectory;
	}

	setRecordDirectory(directory: string): void {
		this.recordDirectory = directory;
	}
}
