/**
 * Environment configuration, parsed and validated once at startup.
 *
 * Reads `process.env` directly rather than SvelteKit's `$env` modules: the values are
 * needed by the OBS client and the mock server outside a request context, and this keeps
 * every module here runnable under plain vitest with no build step.
 */

export interface AppConfig {
	obs: {
		url: string;
		password: string | undefined;
		/** 0 disables the recording heartbeat entirely (see DESIGN.md §8). */
		pollIntervalMs: number;
		reconnect: { initialDelayMs: number; maxDelayMs: number };
	};
	auth: {
		/** Undefined means the API is unauthenticated; a warning is logged at boot. */
		token: string | undefined;
	};
	logLevel: string;
}

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ConfigError';
	}
}

function integer(env: NodeJS.ProcessEnv, key: string, fallback: number, min = 0): number {
	const raw = env[key];
	if (raw === undefined || raw === '') return fallback;

	const value = Number(raw);
	if (!Number.isInteger(value) || value < min) {
		throw new ConfigError(`${key} must be an integer >= ${min}, received ${JSON.stringify(raw)}`);
	}
	return value;
}

/** Normalises a host:port or bare URL into a `ws://` URL OBS will accept. */
function obsUrl(env: NodeJS.ProcessEnv): string {
	const raw = (env.OBS_URL ?? 'ws://127.0.0.1:4455').trim();
	const candidate = /^wss?:\/\//i.test(raw) ? raw : `ws://${raw}`;

	let parsed: URL;
	try {
		parsed = new URL(candidate);
	} catch {
		throw new ConfigError(`OBS_URL is not a valid URL: ${JSON.stringify(raw)}`);
	}

	if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
		throw new ConfigError(`OBS_URL must use ws:// or wss://, received ${parsed.protocol}//`);
	}
	return parsed.toString();
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
	const password = env.OBS_PASSWORD?.trim();
	const token = env.APP_TOKEN?.trim();

	return {
		obs: {
			url: obsUrl(env),
			password: password ? password : undefined,
			pollIntervalMs: integer(env, 'OBS_POLL_INTERVAL_MS', 1000),
			reconnect: {
				initialDelayMs: integer(env, 'OBS_RECONNECT_INITIAL_MS', 500, 100),
				maxDelayMs: integer(env, 'OBS_RECONNECT_MAX_MS', 15_000, 100)
			}
		},
		auth: { token: token ? token : undefined },
		logLevel: env.LOG_LEVEL ?? 'info'
	};
}

let cached: AppConfig | undefined;

/** The process-wide config, parsed on first use. */
export function config(): AppConfig {
	cached ??= loadConfig();
	return cached;
}
