import { describe, expect, it } from 'vitest';
import {
	buildRecordingPath,
	expandFilenameTemplate,
	hasUnresolvedTokens,
	joinRecordPath,
	predictRecordingPath
} from './filename';

const AT = new Date(2026, 8, 9, 14, 5, 3); // 2026-09-09 14:05:03 local

describe('expandFilenameTemplate', () => {
	it('expands the OBS default template', () => {
		expect(expandFilenameTemplate('%CCYY-%MM-%DD %hh-%mm-%ss', AT)).toBe('2026-09-09 14-05-03');
	});

	it('does not read %MM as %M followed by a literal M', () => {
		// Single-pass matching with longest alternatives first is what prevents the
		// month token from decaying into minutes.
		expect(expandFilenameTemplate('%MM', AT)).toBe('09');
		expect(expandFilenameTemplate('%M', AT)).toBe('05');
		expect(expandFilenameTemplate('%MM%M', AT)).toBe('0905');
	});

	it('supports the named and 12-hour tokens', () => {
		expect(expandFilenameTemplate('%a %A %b %B %I%p', AT)).toBe('Wed Wednesday Sep September 02PM');
	});

	it('emits a literal percent for %%', () => {
		expect(expandFilenameTemplate('100%% done', AT)).toBe('100% done');
	});

	it('leaves unknown tokens verbatim so an approximation looks approximate', () => {
		const expanded = expandFilenameTemplate('%CCYY %FPS', AT);
		expect(expanded).toBe('2026 %FPS');
		expect(hasUnresolvedTokens(expanded)).toBe(true);
	});

	it('reports fully resolved templates as resolved', () => {
		expect(hasUnresolvedTokens(expandFilenameTemplate('%CCYY-%MM', AT))).toBe(false);
	});
});

describe('joinRecordPath', () => {
	it('keeps a Windows record path a Windows path', () => {
		expect(joinRecordPath('C:\\Users\\me\\Videos', 'a.mkv')).toBe('C:\\Users\\me\\Videos\\a.mkv');
	});

	it('uses forward slashes elsewhere and tolerates a trailing separator', () => {
		expect(joinRecordPath('/home/me/Videos/', 'a.mkv')).toBe('/home/me/Videos/a.mkv');
	});
});

describe('buildRecordingPath', () => {
	it('assembles directory, expanded template and extension', () => {
		expect(
			buildRecordingPath({
				directory: '/videos',
				template: '%CCYY-%MM-%DD',
				extension: 'mp4',
				at: AT
			})
		).toBe('/videos/2026-09-09.mp4');
	});
});

describe('predictRecordingPath', () => {
	it('predicts from directory, template and container', () => {
		expect(
			predictRecordingPath(
				{ directory: '/videos', template: '%CCYY-%MM-%DD %hh-%mm-%ss', extension: 'mkv' },
				AT
			)
		).toBe('/videos/2026-09-09 14-05-03.mkv');
	});

	it('falls back to mkv when the profile names no container', () => {
		expect(predictRecordingPath({ directory: '/v', template: 'rec', extension: null }, AT)).toBe(
			'/v/rec.mkv'
		);
	});

	it('returns null rather than a partial guess when inputs are missing', () => {
		expect(
			predictRecordingPath({ directory: null, template: 'x', extension: 'mkv' }, AT)
		).toBeNull();
		expect(
			predictRecordingPath({ directory: '/v', template: null, extension: 'mkv' }, AT)
		).toBeNull();
	});
});
