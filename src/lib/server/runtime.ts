/**
 * Process-wide wiring: one OBS client, one store, one service.
 *
 * Held on `globalThis` rather than in a module-level variable because Vite reloads
 * modules on change in development; a plain module singleton would leak a new websocket
 * connection to OBS on every edit.
 */
import { config } from './config';
import { logger } from './log';
import { ObsClient } from './obs/client';
import { ObsService } from './obs/service';
import { ObsStore } from './obs/store';

export interface Runtime {
	client: ObsClient;
	store: ObsStore;
	service: ObsService;
}

const RUNTIME_KEY = '__obsControlRuntime__';

export function runtime(): Runtime {
	const globals = globalThis as Record<string, unknown>;
	const existing = globals[RUNTIME_KEY] as Runtime | undefined;
	if (existing) return existing;

	const settings = config();
	const client = new ObsClient({
		url: settings.obs.url,
		password: settings.obs.password,
		reconnect: settings.obs.reconnect
	});
	const store = new ObsStore(client, settings.obs.pollIntervalMs);
	const service = new ObsService(client, store);

	// The store subscribes before the client connects, so the first connection's resync
	// is observed rather than missed.
	store.start();
	client.start();

	logger.info(
		{
			url: settings.obs.url,
			authentication: settings.obs.password ? 'password' : 'none',
			pollIntervalMs: settings.obs.pollIntervalMs
		},
		'OBS runtime started'
	);

	const created: Runtime = { client, store, service };
	globals[RUNTIME_KEY] = created;
	return created;
}
