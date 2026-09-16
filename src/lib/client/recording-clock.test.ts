import { beforeEach, describe, expect, it } from 'vitest';
import { RecordingClock } from './recording-clock';

let time: number;
let clock: RecordingClock;

const idle = { active: false, paused: false, stale: false, durationMs: 0 };
const running = (durationMs: number) => ({ active: true, paused: false, stale: false, durationMs });
const paused = (durationMs: number) => ({ active: true, paused: true, stale: false, durationMs });
const stale = (durationMs: number) => ({ active: true, paused: false, stale: true, durationMs });

/** Advances time in animation-sized steps, reading the display as the page would. */
function play(ms: number, step = 100): number[] {
	const shown: number[] = [];
	for (let left = ms; left > 0; left -= step) {
		time += Math.min(step, left);
		shown.push(clock.read());
	}
	return shown;
}

beforeEach(() => {
	time = 10_000;
	clock = new RecordingClock(() => time);
	clock.sync(idle, true);
});

describe('RecordingClock position', () => {
	it('reads zero while idle, however long it has been idle', () => {
		time += 60_000;
		expect(clock.position()).toBe(0);
		expect(clock.read()).toBe(0);
	});

	it('interpolates between samples and re-bases on each new one', () => {
		clock.sync(running(5_000), true);
		time += 400;
		expect(clock.position()).toBe(5_400);

		time += 580;
		clock.sync(running(5_950), true);
		expect(clock.position()).toBe(5_950);
	});

	it('ignores a repeated sample, so an unrelated snapshot cannot rewind the clock', () => {
		clock.sync(running(5_000), true);
		time += 700;
		clock.sync(running(5_000), true);
		expect(clock.position()).toBe(5_700);
	});

	it('holds a new recording at zero until OBS reports frames', () => {
		clock.sync(running(0), true);
		time += 1_000;
		clock.sync(running(0), true);
		expect(clock.position()).toBe(0);

		time += 1_000;
		clock.sync(running(900), true);
		time += 250;
		expect(clock.position()).toBe(1_150);
	});

	it('counts from the start event when the server is not sampling', () => {
		clock.sync(running(0), false);
		time += 1_500;
		expect(clock.position()).toBe(1_500);
	});

	it('adopts the exact paused duration once OBS reports it', () => {
		clock.sync(running(5_000), true);
		time += 600;
		clock.sync(paused(5_000), true);
		time += 400;
		clock.sync(paused(5_620), true);
		expect(clock.position()).toBe(5_620);
	});

	it('holds its position while the recording state is stale', () => {
		clock.sync(running(5_000), true);
		time += 600;
		clock.sync(stale(5_000), true);
		time += 5_000;
		expect(clock.position()).toBe(5_600);
	});
});

describe('RecordingClock display', () => {
	it('jumps straight to a recording already in progress', () => {
		time += 30_000;
		clock.sync(running(42_000), true);
		expect(clock.read()).toBe(42_000);
		play(1_000);
		expect(clock.read()).toBeCloseTo(43_000);
	});

	it('runs at real speed when the samples agree with it', () => {
		clock.sync(running(5_000), true);
		clock.read();
		play(980);
		clock.sync(running(5_980), true);
		expect(play(500).at(-1)).toBeCloseTo(6_480);
	});

	it('absorbs a late sample by slowing down rather than jumping back', () => {
		clock.sync(running(5_000), true);
		clock.read();
		play(1_000);
		clock.sync(running(5_600), true);

		const shown = play(3_000);
		expect(shown[0]).toBeGreaterThan(6_000);
		for (const [i, value] of shown.entries()) {
			if (i > 0) expect(value - shown[i - 1]).toBeGreaterThanOrEqual(50);
		}
		expect(Math.abs(shown.at(-1)! - clock.position())).toBeLessThan(30);
	});

	it('stops the moment OBS pauses and ignores the frames OBS counts afterwards', () => {
		clock.sync(running(5_000), true);
		clock.read();
		play(600);
		clock.sync(paused(5_000), true);
		const frozen = clock.read();
		expect(frozen).toBeCloseTo(5_600);

		play(400);
		clock.sync(paused(6_100), true);
		expect(play(5_000).every((value) => value === frozen)).toBe(true);
	});

	it('resumes from the value on screen however long the pause lasted', () => {
		clock.sync(running(5_000), true);
		clock.read();
		play(600);
		clock.sync(paused(5_000), true);
		play(30_000);
		clock.sync(paused(6_100), true);

		clock.sync(running(6_100), true);
		expect(play(300).at(-1)).toBeCloseTo(5_900);
	});

	it('resumes from the value on screen when a stale recording becomes fresh', () => {
		clock.sync(running(5_000), true);
		clock.read();
		play(600);
		clock.sync(stale(5_000), true);
		const frozen = clock.read();
		play(30_000);
		clock.sync(stale(6_100), true);

		clock.sync(running(6_100), true);
		expect(play(300).at(-1)).toBeCloseTo(frozen + 300);
	});

	it('returns to zero when the recording stops', () => {
		clock.sync(running(5_000), true);
		play(500);
		clock.sync(idle, true);
		expect(clock.read()).toBe(0);
	});

	/**
	 * Recorded from OBS 32.2 (NVENC, 60 fps) through the app: a start, a pause for about
	 * seven seconds, a resume and a stop. Times are the browser's arrival times; OBS's
	 * count trails wall clock, keeps rising for a second after the pause, and is slow to
	 * move again after the resume.
	 */
	it('replays a real recording without ever running backwards or leaping', () => {
		const trace: Array<[at: number, active: boolean, paused: boolean, durationMs: number]> = [
			[7709, true, false, 0],
			[8713, true, false, 0],
			[9724, true, false, 983],
			[10736, true, false, 1983],
			[11752, true, false, 2999],
			[12752, true, false, 4016],
			[13768, true, false, 5033],
			[14777, true, false, 6033],
			[15781, true, false, 7033],
			[16791, true, false, 8049],
			[17703, true, true, 8049],
			[17800, true, true, 9033],
			[18802, true, true, 9516],
			[19813, true, true, 9516],
			[24870, true, true, 9516],
			[25025, true, false, 9516],
			[25882, true, false, 9983],
			[26896, true, false, 10899],
			[27899, true, false, 11899],
			[28905, true, false, 12899],
			[29918, true, false, 13933],
			[30935, true, false, 14933],
			[31945, true, false, 15949],
			[32958, true, false, 16966],
			[33969, true, false, 17983],
			[34984, true, false, 18983],
			[35990, true, false, 19983],
			[37000, true, false, 21016]
		];

		time = 7_700;
		clock = new RecordingClock(() => time);
		clock.sync(idle, true);
		clock.read();

		const frames: Array<{ at: number; shown: number; paused: boolean }> = [];
		let next = 0;
		let isPaused = false;
		for (let frame = 7_800; frame <= 37_500; frame += 100) {
			while (next < trace.length && trace[next][0] <= frame) {
				const [at, active, pausedNow, durationMs] = trace[next++];
				time = at;
				clock.sync({ active, paused: pausedNow, durationMs }, true);
				isPaused = pausedNow;
			}
			time = frame;
			frames.push({ at: frame, shown: clock.read(), paused: isPaused });
		}

		for (let i = 1; i < frames.length; i++) {
			const step = frames[i].shown - frames[i - 1].shown;
			expect(step).toBeGreaterThanOrEqual(0);
			expect(step).toBeLessThanOrEqual(150);
			if (!frames[i].paused && !frames[i - 1].paused) expect(step).toBeGreaterThanOrEqual(50);
			if (frames[i].paused && frames[i - 1].paused) expect(step).toBe(0);
		}
		expect(Math.abs(clock.read() - clock.position())).toBeLessThan(50);
	});
});
