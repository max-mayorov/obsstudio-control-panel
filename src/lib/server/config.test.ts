import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config';

const base = {} as NodeJS.ProcessEnv;

describe('loadConfig', () => {
	it('defaults to OBS on loopback', () => {
		expect(loadConfig(base).obs.url).toBe('ws://127.0.0.1:4455/');
	});

	it('accepts a bare host:port and adds the scheme', () => {
		expect(loadConfig({ OBS_URL: '192.168.1.10:4455' }).obs.url).toBe('ws://192.168.1.10:4455/');
	});

	it('keeps an explicit wss:// URL', () => {
		expect(loadConfig({ OBS_URL: 'wss://obs.example:4455' }).obs.url).toBe(
			'wss://obs.example:4455/'
		);
	});

	it('rejects a non-websocket scheme rather than failing later at connect time', () => {
		expect(() => loadConfig({ OBS_URL: 'http://obs.example' })).toThrow(ConfigError);
	});

	it('treats blank secrets as absent, so an empty env var does not enable auth', () => {
		const config = loadConfig({ OBS_PASSWORD: '   ', APP_TOKEN: '' });
		expect(config.obs.password).toBeUndefined();
		expect(config.auth.token).toBeUndefined();
	});

	it('trims secrets that carry stray whitespace', () => {
		expect(loadConfig({ APP_TOKEN: ' secret ' }).auth.token).toBe('secret');
	});

	it('allows a zero poll interval, which disables the heartbeat', () => {
		expect(loadConfig({ OBS_POLL_INTERVAL_MS: '0' }).obs.pollIntervalMs).toBe(0);
	});

	it('rejects a non-numeric or negative interval at boot', () => {
		expect(() => loadConfig({ OBS_POLL_INTERVAL_MS: 'soon' })).toThrow(ConfigError);
		expect(() => loadConfig({ OBS_POLL_INTERVAL_MS: '-1' })).toThrow(ConfigError);
	});

	it('applies reconnect defaults', () => {
		const { reconnect } = loadConfig(base).obs;
		expect(reconnect).toEqual({ initialDelayMs: 500, maxDelayMs: 15_000 });
	});
});
