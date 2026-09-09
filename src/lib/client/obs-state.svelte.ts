/**
 * The browser's view of OBS, held in runes.
 *
 * Two rules shape this class:
 *
 * 1. **Server state is never written locally.** Commands POST and return; the display
 *    changes only when the state stream says OBS changed. A button shows a pending
 *    state, but the truth always arrives from OBS, so the UI stays correct when
 *    somebody presses Record in OBS itself.
 *
 * 2. **The timecode is interpolated between samples, never invented.** The server
 *    samples OBS once a second; between samples we advance a local clock from the last
 *    sample, and every sample snaps back to OBS's value. OBS derives its duration from
 *    frame count, so under encoder overload it falls behind wall clock — extrapolating
 *    without re-syncing would drift away from the real recording.
 */
import { SSE_EVENT, type ObsSnapshot, type RecordingTick } from '$lib/types';
import { ApiRequestError, api } from './api';

export interface Toast {
	id: number;
	kind: 'error' | 'success';
	message: string;
	requestId?: string;
}

/** How often the interpolated timecode is refreshed between server samples. */
const INTERPOLATION_MS = 100;

const TOAST_TTL_MS = 6000;

export class ObsController {
	snapshot = $state<ObsSnapshot>() as ObsSnapshot;
	streamStatus = $state<'connecting' | 'open' | 'closed'>('connecting');
	needsSignIn = $state(false);
	signingIn = $state(false);
	signInError = $state<string | null>(null);
	toasts = $state<Toast[]>([]);

	/** Per-action busy flags, keyed by control, so one pending button never blocks another. */
	pending = $state<Record<string, boolean>>({});

	/** Interpolated recording duration in milliseconds. */
	displayMs = $state(0);

	private source: EventSource | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;
	private sample = { durationMs: 0, at: 0 };
	private nextToastId = 1;

	constructor(initial: ObsSnapshot, authenticated: boolean) {
		this.snapshot = initial;
		this.displayMs = initial.recording.durationMs;
		this.sample = { durationMs: initial.recording.durationMs, at: now() };
		this.needsSignIn = !authenticated;
	}

	// ------------------------------------------------------------- derived

	get connection() {
		return this.snapshot.connection;
	}

	get recording() {
		return this.snapshot.recording;
	}

	get scenes() {
		return this.snapshot.scenes;
	}

	/** True when OBS is reachable and commands can be expected to work. */
	get online(): boolean {
		return this.snapshot.connection.status === 'connected';
	}

	get busy(): boolean {
		return Object.values(this.pending).some(Boolean);
	}

	isPending(key: string): boolean {
		return this.pending[key] === true;
	}

	// -------------------------------------------------------------- stream

	/** Opens the state stream. Safe to call once the component has mounted. */
	start(): void {
		if (this.needsSignIn) return;
		this.openStream();
		this.startInterpolation();
	}

	stop(): void {
		this.closeStream();
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	private openStream(): void {
		if (typeof EventSource === 'undefined' || this.source) return;

		this.streamStatus = 'connecting';
		const source = new EventSource('/api/state/stream');
		this.source = source;

		source.addEventListener('open', () => {
			this.streamStatus = 'open';
		});

		source.addEventListener(SSE_EVENT.state, (event) => {
			const snapshot = parse<ObsSnapshot>(event);
			if (!snapshot) return;
			this.snapshot = snapshot;
			this.syncClock(snapshot.recording.durationMs, snapshot.recording.active);
		});

		source.addEventListener(SSE_EVENT.tick, (event) => {
			const tick = parse<RecordingTick>(event);
			if (!tick) return;
			this.snapshot.recording.timecode = tick.timecode;
			this.snapshot.recording.durationMs = tick.durationMs;
			this.snapshot.recording.bytes = tick.bytes;
			this.syncClock(tick.durationMs, true);
		});

		source.addEventListener('error', () => {
			// EventSource reconnects by itself; reflect the gap rather than fighting it.
			this.streamStatus = source.readyState === EventSource.CLOSED ? 'closed' : 'connecting';
		});
	}

	private closeStream(): void {
		this.source?.close();
		this.source = undefined;
		this.streamStatus = 'closed';
	}

	// ------------------------------------------------------- timecode clock

	/**
	 * Re-bases the local clock on a value from the server.
	 *
	 * Only an actually different duration re-bases. Every state snapshot carries the
	 * recording numbers, so re-basing on all of them would rewind the display by up to a
	 * sampling interval each time an unrelated thing changed — switching a scene during a
	 * recording would visibly knock the timecode backwards.
	 */
	private syncClock(durationMs: number, active: boolean): void {
		if (!active) {
			this.sample = { durationMs: 0, at: now() };
			this.displayMs = 0;
			return;
		}
		if (durationMs === this.sample.durationMs) return;
		this.sample = { durationMs, at: now() };
		this.displayMs = durationMs;
	}

	private startInterpolation(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			const { active, paused } = this.snapshot.recording;
			if (!active) {
				this.displayMs = 0;
				return;
			}
			// While paused, hold whatever is on screen and wait for the server's next
			// sample to correct it. Recomputing from the last sample would jump the
			// display backwards at the moment of pausing, then forwards again a second
			// later when the authoritative value arrived.
			if (paused) return;
			this.displayMs = this.sample.durationMs + (now() - this.sample.at);
		}, INTERPOLATION_MS);
	}

	// ------------------------------------------------------------ commands

	startRecording() {
		return this.run('record', () => api.startRecording());
	}

	stopRecording() {
		return this.run(
			'record',
			() => api.stopRecording(),
			(result) => (result.outputPath ? `Saved ${result.outputPath}` : 'Recording stopped')
		);
	}

	pauseRecording() {
		return this.run('pause', () => api.pauseRecording());
	}

	resumeRecording() {
		return this.run('pause', () => api.resumeRecording());
	}

	setProgramScene(name: string) {
		return this.run(`scene:${name}`, () => api.setProgramScene(name));
	}

	setPreviewScene(name: string) {
		return this.run(`scene:${name}`, () => api.setPreviewScene(name));
	}

	transition() {
		return this.run('transition', () => api.transition());
	}

	async signIn(token: string): Promise<void> {
		this.signingIn = true;
		this.signInError = null;
		try {
			await api.signIn(token);
			this.needsSignIn = false;
			this.snapshot = await api.state();
			this.start();
		} catch (error) {
			this.signInError =
				error instanceof ApiRequestError ? error.detail.message : 'Could not sign in';
		} finally {
			this.signingIn = false;
		}
	}

	async signOut(): Promise<void> {
		await api.signOut().catch(() => undefined);
		this.stop();
		this.needsSignIn = true;
	}

	/**
	 * Runs a command, tracking its pending flag and surfacing failures as toasts.
	 * Success is deliberately quiet except where there is something to report, such as
	 * the path a finished recording was written to.
	 */
	private async run<T>(
		key: string,
		operation: () => Promise<T>,
		describeSuccess?: (result: T) => string | undefined
	): Promise<void> {
		this.pending[key] = true;
		try {
			const result = await operation();
			const message = describeSuccess?.(result);
			if (message) this.toast('success', message);
		} catch (error) {
			if (error instanceof ApiRequestError) {
				if (error.status === 401) {
					this.needsSignIn = true;
					this.stop();
				}
				this.toast('error', error.detail.message, error.detail.requestId);
			} else {
				this.toast('error', 'Unexpected error');
			}
		} finally {
			this.pending[key] = false;
		}
	}

	// -------------------------------------------------------------- toasts

	toast(kind: Toast['kind'], message: string, requestId?: string): void {
		const id = this.nextToastId++;
		this.toasts = [...this.toasts, { id, kind, message, requestId }];
		setTimeout(() => this.dismiss(id), TOAST_TTL_MS);
	}

	dismiss(id: number): void {
		this.toasts = this.toasts.filter((toast) => toast.id !== id);
	}
}

function now(): number {
	// Monotonic where available, so a system clock adjustment cannot make the timecode
	// jump backwards mid-recording.
	return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function parse<T>(event: Event): T | null {
	try {
		return JSON.parse((event as MessageEvent<string>).data) as T;
	} catch {
		return null;
	}
}
