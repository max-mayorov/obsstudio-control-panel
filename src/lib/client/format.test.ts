import { describe, expect, it } from 'vitest';
import { basename, formatBytes, formatDuration } from './format';

describe('formatDuration', () => {
	it('splits into stable digits and a single decimal', () => {
		expect(formatDuration(3_723_400)).toEqual({ hms: '01:02:03', tenths: '4' });
	});

	it('pads every field', () => {
		expect(formatDuration(0)).toEqual({ hms: '00:00:00', tenths: '0' });
	});

	it('clamps a negative duration rather than rendering nonsense', () => {
		expect(formatDuration(-500)).toEqual({ hms: '00:00:00', tenths: '0' });
	});

	it('keeps counting past 24 hours instead of wrapping', () => {
		expect(formatDuration(25 * 3_600_000).hms).toBe('25:00:00');
	});
});

describe('formatBytes', () => {
	it('reports whole bytes without a decimal', () => {
		expect(formatBytes(512)).toBe('512 B');
	});

	it('scales to sensible units', () => {
		expect(formatBytes(1024)).toBe('1.0 KB');
		expect(formatBytes(1024 ** 3 * 2.5)).toBe('2.5 GB');
	});

	it('renders nothing recorded as zero', () => {
		expect(formatBytes(0)).toBe('0 B');
	});
});

describe('basename', () => {
	it('extracts the filename from posix and windows paths', () => {
		expect(basename('/home/me/Videos/a b.mkv')).toBe('a b.mkv');
		expect(basename('C:\\Users\\me\\a.mkv')).toBe('a.mkv');
	});

	it('returns the input when there is no separator', () => {
		expect(basename('a.mkv')).toBe('a.mkv');
	});
});
