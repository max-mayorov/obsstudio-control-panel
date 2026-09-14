import type { RecordingState } from '$lib/types';

type Sample = Pick<RecordingState, 'active' | 'paused' | 'durationMs'>;

/**
 * The recording duration shown in the browser: OBS's frame-derived value, interpolated
 * between the server's samples. Local time only ever fills the gap between two samples.
 *
 * Three rules keep the display from jumping (DESIGN.md section 8):
 *
 * - It re-bases only on a duration OBS has not reported before. Every state snapshot
 *   repeats the last sampled value, so re-basing on each one would knock the display back
 *   by up to a sampling interval whenever something unrelated, such as the scene, changed.
 * - It re-bases on every active/paused transition, whoever caused it, continuing from what
 *   is on screen. Samples taken during a pause all repeat one value, so without this the
 *   clock would resume from the start of the pause and leap forward by its length.
 * - A new recording holds at zero until OBS reports frames. OBS announces the start about
 *   a second before the first frame reaches the file, and its duration stays 0 until then;
 *   counting from the announcement would run ahead of the file and snap back later.
 */
export class RecordingClock {
	private active = false;
	private paused = false;
	private awaitingFrames = false;
	/** The last duration OBS reported, to tell a new sample from a repeated one. */
	private reportedMs = 0;
	private baseMs = 0;
	private baseAt = 0;

	constructor(private readonly now: () => number) {}

	/**
	 * Feeds a value from the server, from either a state snapshot or a tick. `sampled` says
	 * whether the server's heartbeat is running; without it no later sample would ever end
	 * the wait for frames, so the clock counts from the start event instead.
	 */
	sync(sample: Sample, sampled: boolean): void {
		const now = this.now();

		if (!sample.active) {
			this.active = false;
			this.paused = false;
			this.awaitingFrames = false;
			this.reportedMs = 0;
			this.rebase(0, now);
			return;
		}

		const fresh = sample.durationMs !== this.reportedMs;
		this.reportedMs = sample.durationMs;

		if (!this.active) {
			this.active = true;
			this.paused = sample.paused;
			this.awaitingFrames = sampled && sample.durationMs === 0;
			this.rebase(sample.durationMs, now);
			return;
		}

		if (sample.paused !== this.paused) {
			this.rebase(this.read(now), now);
			this.paused = sample.paused;
		}

		if (fresh) {
			this.awaitingFrames = false;
			this.rebase(sample.durationMs, now);
		}
	}

	/** The duration to display, in milliseconds. */
	read(now = this.now()): number {
		if (!this.active) return 0;
		if (this.paused || this.awaitingFrames) return this.baseMs;
		return this.baseMs + (now - this.baseAt);
	}

	private rebase(durationMs: number, at: number): void {
		this.baseMs = durationMs;
		this.baseAt = at;
	}
}
