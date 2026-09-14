/**
 * The wire contract between the SvelteKit server and the browser.
 *
 * Imported by both sides, so a change to any shape here breaks the build rather than
 * the runtime. Nothing in this file may import from `$lib/server` — it crosses the
 * process boundary and is bundled into the client.
 */

/** How the server's single OBS connection is currently doing. */
export type ConnectionState =
	| { status: 'connecting'; attempt: number }
	| { status: 'connected'; obsVersion: string; websocketVersion: string; rpcVersion: number }
	| { status: 'reconnecting'; attempt: number; retryInMs: number; lastError: string }
	| { status: 'error'; kind: ConnectionErrorKind; message: string };

/**
 * `auth` is terminal — a wrong password is a configuration mistake and retrying it
 * forever achieves nothing. `unreachable` is transient and retried indefinitely.
 */
export type ConnectionErrorKind = 'auth' | 'unreachable';

/**
 * Where a recording's filename came from.
 *
 * - `obs`       — reported by OBS itself (`RecordStateChanged.outputPath`, or
 *                 `RecordFileChanged.newOutputPath` after a split). Authoritative.
 * - `predicted` — reconstructed from the record directory and the profile's filename
 *                 template because we connected mid-recording and missed the event
 *                 that carried the real path. May be wrong; the UI says so.
 */
export type FilenameSource = 'obs' | 'predicted';

export interface RecordingFile {
	path: string;
	source: FilenameSource;
}

export interface CompletedRecording {
	path: string;
	endedAt: number;
}

export interface RecordingState {
	active: boolean;
	paused: boolean;
	/** Formatted by OBS, e.g. "00:01:23.456". */
	timecode: string;
	durationMs: number;
	bytes: number;
	/** Null when idle, or when recording but no filename could be established at all. */
	file: RecordingFile | null;
	/** The last recording that finished this session — always an authoritative path. */
	lastCompleted: CompletedRecording | null;
	/** OBS's configured output directory, shown as context for a predicted filename. */
	directory: string | null;
}

export interface SceneSummary {
	name: string;
	uuid: string;
}

export interface ScenesState {
	scenes: SceneSummary[];
	program: string | null;
	/** Only meaningful while `studioMode` is true. */
	preview: string | null;
	studioMode: boolean;
	/** True while disconnected: the UI keeps showing the last known list, greyed out. */
	stale: boolean;
}

/** The complete server-side view of OBS, sent whole on every change. */
export interface ObsSnapshot {
	connection: ConnectionState;
	recording: RecordingState;
	scenes: ScenesState;
	/**
	 * Interval of the server's recording heartbeat, or 0 when it is disabled and the
	 * browser must extrapolate the timecode from the last snapshot alone.
	 */
	heartbeatMs: number;
	/** Server wall clock, so the client can detect a badly skewed browser clock. */
	serverTime: number;
}

/**
 * The 1 Hz recording heartbeat. Split out from the full snapshot so an active
 * recording does not resend the scene list every second.
 */
export interface RecordingTick {
	timecode: string;
	durationMs: number;
	bytes: number;
	/** Server timestamp of the sample, used as the client's interpolation base. */
	at: number;
}

/** SSE event names on `/api/state/stream`. */
export const SSE_EVENT = {
	state: 'state',
	tick: 'tick'
} as const;

export type ApiErrorCode =
	| 'unauthorized'
	| 'validation'
	| 'not_found'
	| 'conflict'
	| 'obs_unavailable'
	| 'obs_auth'
	| 'obs_error'
	| 'internal';

export interface ApiError {
	code: ApiErrorCode;
	message: string;
	/** Correlates the toast the user sees with the server log line. */
	requestId: string;
}

export type ApiResponse<T> = { ok: true; data: T } | { ok: false; error: ApiError };

/** Body of `POST /api/scenes/current` and `/api/scenes/preview`. */
export interface SetSceneBody {
	name: string;
}

/** Response of `POST /api/recording/stop`. */
export interface StopRecordingResult {
	outputPath: string | null;
}

/**
 * A snapshot representing "we know nothing yet", used before the server has connected
 * and as the placeholder shown to a signed-out client.
 */
export function emptySnapshot(): ObsSnapshot {
	return {
		connection: { status: 'connecting', attempt: 0 },
		recording: {
			active: false,
			paused: false,
			timecode: '00:00:00.000',
			durationMs: 0,
			bytes: 0,
			file: null,
			lastCompleted: null,
			directory: null
		},
		scenes: { scenes: [], program: null, preview: null, studioMode: false, stale: true },
		heartbeatMs: 0,
		serverTime: 0
	};
}
