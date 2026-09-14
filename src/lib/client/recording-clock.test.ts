import { beforeEach, describe, expect, it } from 'vitest';
import { RecordingClock } from './recording-clock';

let time: number;
let clock: RecordingClock;

const advance = (ms: number) => (time += ms);
const idle = { active: false, paused: false, durationMs: 0 };
const running = (durationMs: number) => ({ active: true, paused: false, durationMs });
const paused = (durationMs: number) => ({ active: true, paused: true, durationMs });

beforeEach(() => {
	time = 10_000;
	clock = new RecordingClock(() => time);
	clock.sync(idle, true);
});

describe('RecordingClock', () => {
	it('reads zero while idle, however long it has been idle', () => {
		advance(60_000);
		expect(clock.read()).toBe(0);
	});

	it('interpolates between samples and snaps to each new one', () => {
		clock.sync(running(5_000), true);
		advance(400);
		expect(clock.read()).toBe(5_400);

		advance(580);
		clock.sync(running(5_950), true);
		expect(clock.read()).toBe(5_950);
		advance(100);
		expect(clock.read()).toBe(6_050);
	});

	it('ignores a repeated sample, so an unrelated snapshot cannot rewind the display', () => {
		clock.sync(running(5_000), true);
		advance(700);
		clock.sync(running(5_000), true);
		expect(clock.read()).toBe(5_700);
	});

	// Measured on OBS 32.2: outputDuration stays 0 for ~1.1 s after Started, then trails
	// wall clock by a constant ~1 s.
	it('holds a new recording at zero until OBS reports frames', () => {
		clock.sync(running(0), true);
		advance(1_000);
		clock.sync(running(0), true);
		expect(clock.read()).toBe(0);

		advance(1_000);
		clock.sync(running(900), true);
		expect(clock.read()).toBe(900);
		advance(250);
		expect(clock.read()).toBe(1_150);
	});

	it('counts from the start event when the server is not sampling', () => {
		clock.sync(running(0), false);
		advance(1_500);
		expect(clock.read()).toBe(1_500);
	});

	it('starts from the reported duration when joining a recording in progress', () => {
		advance(30_000);
		clock.sync(running(42_000), true);
		expect(clock.read()).toBe(42_000);
		advance(100);
		expect(clock.read()).toBe(42_100);
	});

	it('holds what is on screen when paused rather than jumping back to the last sample', () => {
		clock.sync(running(5_000), true);
		advance(600);
		clock.sync(paused(5_000), true);
		advance(5_000);
		expect(clock.read()).toBe(5_600);
	});

	it('adopts the exact paused duration once OBS reports it', () => {
		clock.sync(running(5_000), true);
		advance(600);
		clock.sync(paused(5_000), true);
		advance(400);
		clock.sync(paused(5_620), true);
		expect(clock.read()).toBe(5_620);
	});

	it('resumes from the paused value however long the pause lasted', () => {
		clock.sync(running(5_000), true);
		advance(600);
		clock.sync(paused(5_000), true);
		advance(400);
		clock.sync(paused(5_620), true);
		advance(30_000);
		clock.sync(paused(5_620), true);

		clock.sync(running(5_620), true);
		advance(300);
		expect(clock.read()).toBe(5_920);
	});

	it('resumes correctly when the pause was shorter than a sampling interval', () => {
		clock.sync(running(5_000), true);
		advance(600);
		clock.sync(paused(5_000), true);
		advance(500);
		clock.sync(running(5_000), true);
		advance(300);
		expect(clock.read()).toBe(5_900);
	});

	it('returns to zero when the recording stops, and holds again for the next one', () => {
		clock.sync(running(5_000), true);
		clock.sync(idle, true);
		expect(clock.read()).toBe(0);

		advance(10_000);
		clock.sync(running(0), true);
		advance(800);
		expect(clock.read()).toBe(0);
	});
});
