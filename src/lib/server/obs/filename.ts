/**
 * Recording filename handling.
 *
 * OBS names recordings from a profile-level template such as `%CCYY-%MM-%DD %hh-%mm-%ss`.
 * We need to expand that template in two places: the mock server, which generates real
 * paths, and tier-2 filename prediction, used when we connect to a recording that was
 * already running and therefore missed the event carrying its true path.
 *
 * See DESIGN.md section 7 for why prediction exists and why it is always labelled.
 */

/**
 * Tokens are matched in one pass with the longest alternatives first, which is what
 * keeps `%MM` (month) from being read as `%M` (minute) followed by a literal `M`.
 * A second pass over already-substituted text could corrupt values that happen to
 * contain a percent sign, so there is deliberately only one.
 */
const TOKEN = /%(CCYY|YY|MM|DD|hh|mm|ss|%|[aAbBdHIjmMpSyY])/g;

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_SHORT = [
	'Jan',
	'Feb',
	'Mar',
	'Apr',
	'May',
	'Jun',
	'Jul',
	'Aug',
	'Sep',
	'Oct',
	'Nov',
	'Dec'
];
const MONTH_LONG = [
	'January',
	'February',
	'March',
	'April',
	'May',
	'June',
	'July',
	'August',
	'September',
	'October',
	'November',
	'December'
];

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/**
 * Expands an OBS filename template against a point in time.
 *
 * Unknown tokens are left verbatim rather than dropped: a prediction that visibly still
 * contains `%FPS` is obviously approximate, which is better than one that silently
 * differs from the real file by a missing segment.
 *
 * Note the timezone caveat from DESIGN.md section 7: `at` is interpreted in *this*
 * process's local time, which is not necessarily the machine running OBS.
 */
export function expandFilenameTemplate(template: string, at: Date): string {
	return template.replace(TOKEN, (match, token: string) => {
		switch (token) {
			case 'CCYY':
			case 'Y':
				return String(at.getFullYear());
			case 'YY':
			case 'y':
				return pad(at.getFullYear() % 100);
			case 'MM':
			case 'm':
				return pad(at.getMonth() + 1);
			case 'DD':
			case 'd':
				return pad(at.getDate());
			case 'hh':
			case 'H':
				return pad(at.getHours());
			case 'mm':
			case 'M':
				return pad(at.getMinutes());
			case 'ss':
			case 'S':
				return pad(at.getSeconds());
			case 'I':
				return pad(at.getHours() % 12 === 0 ? 12 : at.getHours() % 12);
			case 'p':
				return at.getHours() < 12 ? 'AM' : 'PM';
			case 'a':
				return WEEKDAY_SHORT[at.getDay()];
			case 'A':
				return WEEKDAY_LONG[at.getDay()];
			case 'b':
				return MONTH_SHORT[at.getMonth()];
			case 'B':
				return MONTH_LONG[at.getMonth()];
			case 'j':
				return pad(dayOfYear(at), 3);
			case '%':
				return '%';
			default:
				return match;
		}
	});
}

function dayOfYear(at: Date): number {
	const startOfYear = new Date(at.getFullYear(), 0, 0);
	return Math.floor((at.getTime() - startOfYear.getTime()) / 86_400_000);
}

/** True if the expanded template still contains tokens we could not resolve. */
export function hasUnresolvedTokens(expanded: string): boolean {
	return /%[A-Za-z]/.test(expanded);
}

/**
 * Joins a directory and filename with the separator already used by the directory,
 * so a Windows record path stays a Windows path when our server runs on Linux.
 */
export function joinRecordPath(directory: string, filename: string): string {
	const separator = directory.includes('\\') && !directory.includes('/') ? '\\' : '/';
	const trimmed = directory.replace(/[/\\]+$/, '');
	return `${trimmed}${separator}${filename}`;
}

/** Builds a full recording path the way OBS would, given a template and format. */
export function buildRecordingPath(options: {
	directory: string;
	template: string;
	extension: string;
	at: Date;
}): string {
	const name = expandFilenameTemplate(options.template, options.at);
	return joinRecordPath(options.directory, `${name}.${options.extension}`);
}
