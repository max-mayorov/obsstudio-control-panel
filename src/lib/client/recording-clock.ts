import type { RecordingState } from '$lib/types';

type Sample = Pick<RecordingState, 'active' | 'paused' | 'stale' | 'durationMs'>;

/** While absorbing a correction the display runs between 0.5× and 1.5× real time. */
const MAX_SLEW = 0.5;
/** Roughly how long a small correction takes to absorb. */
const CONVERGE_MS = 1000;
/** A gap this large is a different position, such as joining a recording in progress, not lag. */
const SNAP_MS = 2000;

/**
 * The recording duration shown in the browser (DESIGN.md section 8).
 *
 * `position()` is OBS's frame-derived duration, advanced by local time since the last
 * sample. `read()` is what goes on screen: it follows `position()` but never runs
 * backwards and never leaps, because OBS's samples are late in ways that would otherwise
 * show as jumps. Its encoder and muxer hold frames for about half a second before counting
 * them, so after a pause the count keeps rising, and after a resume it is slow to move.
 * The display stops the moment OBS says paused and absorbs every correction by briefly
 * running slower or faster, staying within a fraction of a second of OBS throughout.
 *
 * The rules that shape `position()`:
 *
 * - It re-bases only on a duration OBS has not reported before. Every state snapshot
 *   repeats the last sampled value, so re-basing on each one would knock the display back
 *   by up to a sampling interval whenever something unrelated, such as the scene, changed.
 * - It re-bases on every active/paused transition, whoever caused it, continuing from what
 *   is on screen. Around a pause OBS's count settles unpredictably, sometimes ahead of the
 *   resumed clock and sometimes behind it, so the display carries on from where it stopped
 *   and absorbs whatever the next sample says.
 * - A new recording holds at zero until OBS reports frames. OBS announces the start about
 *   a second before the first frame reaches the file, and its duration stays 0 until then.
 */
export class RecordingClock {
	private active = false;
	private paused = false;
	private stale = true;
	private awaitingFrames = false;
	/** The last duration OBS reported, to tell a new sample from a repeated one. */
	private reportedMs = 0;
	private baseMs = 0;
	private baseAt = 0;
	private shownMs = 0;
	private shownAt = 0;

	constructor(private readonly now: () => number) {}

	/**
	 * Feeds a value from the server, from either a state snapshot or a tick. `sampled` says
	 * whether the server's heartbeat is running; without it no later sample would ever end
	 * the wait for frames, so the clock counts from the start event instead.
	 */
	sync(sample: Sample, sampled: boolean): void {
		const now = this.now();
		// Bring the display up to this instant under the old state, so a pause freezes it
		// where it actually was rather than where the last animation frame left it.
		this.read(now);

		if (!sample.active) {
			this.active = false;
			this.paused = false;
			this.awaitingFrames = false;
			this.reportedMs = 0;
			this.rebase(0, now);
			this.shownMs = 0;
			return;
		}

		const fresh = sample.durationMs !== this.reportedMs;
		this.reportedMs = sample.durationMs;

		if (!this.active) {
			this.active = true;
			this.paused = sample.paused;
			this.stale = sample.stale;
			this.awaitingFrames = sampled && sample.durationMs === 0;
			this.rebase(sample.durationMs, now);
			return;
		}

		if (sample.paused !== this.paused || sample.stale !== this.stale) {
			this.rebase(this.shownMs, now);
			this.paused = sample.paused;
			this.stale = sample.stale;
		}

		if (fresh) {
			this.awaitingFrames = false;
			this.rebase(sample.durationMs, now);
		}
	}

	/** OBS's duration as of `now`: the last sample, advanced by the time since. */
	position(now = this.now()): number {
		if (!this.active) return 0;
		if (this.paused || this.stale || this.awaitingFrames) return this.baseMs;
		return this.baseMs + (now - this.baseAt);
	}

	/** The duration to display, in milliseconds. */
	read(now = this.now()): number {
		const elapsed = Math.max(0, now - this.shownAt);
		this.shownAt = now;

		if (!this.active) return (this.shownMs = 0);
		if (this.paused || this.stale) return this.shownMs;

		const target = this.position(now);
		const unhurried = this.shownMs + elapsed;
		const gap = target - unhurried;
		if (Math.abs(gap) > SNAP_MS) return (this.shownMs = target);

		const pull = gap * (1 - Math.exp(-elapsed / CONVERGE_MS));
		const limit = elapsed * MAX_SLEW;
		this.shownMs = unhurried + Math.min(limit, Math.max(-limit, pull));
		return this.shownMs;
	}

	private rebase(durationMs: number, at: number): void {
		this.baseMs = durationMs;
		this.baseAt = at;
	}
}
