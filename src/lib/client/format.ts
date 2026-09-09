/** Presentation helpers. Pure functions, so they are trivial to test and to reuse. */

/**
 * Splits a duration into the parts the timecode display renders separately: the stable
 * `HH:MM:SS` and a single decimal. Showing one decimal makes an interpolated clock read
 * as live without implying millisecond precision we do not have between samples.
 */
export function formatDuration(ms: number): { hms: string; tenths: string } {
	const total = Math.max(0, Math.floor(ms));
	const hours = Math.floor(total / 3_600_000);
	const minutes = Math.floor((total % 3_600_000) / 60_000);
	const seconds = Math.floor((total % 60_000) / 1000);
	const pad = (value: number) => String(value).padStart(2, '0');
	return {
		hms: `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`,
		tenths: String(Math.floor((total % 1000) / 100))
	};
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(bytes: number): string {
	if (bytes <= 0) return '0 B';
	const exponent = Math.min(UNITS.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
	const value = bytes / 1024 ** exponent;
	return `${value.toFixed(exponent === 0 ? 0 : 1)} ${UNITS[exponent]}`;
}

/** Trims a path to its filename, keeping the full path available for a title attribute. */
export function basename(path: string): string {
	const parts = path.split(/[/\\]/);
	return parts[parts.length - 1] || path;
}
