/**
 * Owns the process's single websocket connection to OBS.
 *
 * Knows about sockets, identification and retries; it does not know what a scene or a
 * recording is. Everything above it (`store`, `service`) works in domain terms and
 * treats this as the only way to reach OBS.
 *
 * Reconnection is deliberately asymmetric: an unreachable OBS is retried forever with
 * capped, jittered backoff, because an operator restarting OBS should see the UI heal
 * itself. A rejected password is terminal — it is a configuration fault, and retrying it
 * every few seconds only fills the log.
 */
import OBSWebSocket, {
	EventSubscription,
	OBSWebSocketError,
	type OBSEventTypes,
	type OBSRequestTypes,
	type OBSResponseTypes
} from 'obs-websocket-js';
import type { ConnectionState } from '$lib/types';
import { ObsRequestError, ObsUnavailableError } from '../errors';
import { loggerFor } from '../log';
import { CloseCode, RPC_VERSION } from './protocol';

const log = loggerFor('obs-client');

/**
 * Only the categories this app renders. The high-volume categories — audio meters,
 * scene item transforms — are excluded, so OBS never sends events we would discard.
 */
const EVENT_SUBSCRIPTIONS =
	EventSubscription.General |
	EventSubscription.Config |
	EventSubscription.Scenes |
	EventSubscription.Outputs;

export interface ObsClientOptions {
	url: string;
	password?: string;
	reconnect: { initialDelayMs: number; maxDelayMs: number };
}

export type ConnectionListener = (state: ConnectionState) => void;

export class ObsClient {
	private readonly obs = new OBSWebSocket();
	private readonly listeners = new Set<ConnectionListener>();
	private state: ConnectionState = { status: 'connecting', attempt: 0 };
	private attempt = 0;
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	private stopped = true;

	constructor(private readonly options: ObsClientOptions) {
		this.obs.on('ConnectionClosed', (error) => this.onConnectionClosed(error));
	}

	get connectionState(): ConnectionState {
		return this.state;
	}

	get identified(): boolean {
		return this.obs.identified;
	}

	/** Begins connecting, and keeps the connection up until `stop()`. */
	start(): void {
		if (!this.stopped) return;
		this.stopped = false;
		this.attempt = 0;
		void this.tryConnect();
	}

	async stop(): Promise<void> {
		this.stopped = true;
		this.clearRetry();
		try {
			await this.obs.disconnect();
		} catch {
			// Disconnecting an already-dead socket is not a failure worth reporting.
		}
	}

	onConnectionChange(listener: ConnectionListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Subscribes to an OBS event; returns an unsubscribe function. */
	onEvent<Type extends keyof OBSEventTypes>(
		type: Type,
		handler: (data: OBSEventTypes[Type]) => void
	): () => void {
		this.obs.on(type, handler as never);
		return () => this.obs.off(type, handler as never);
	}

	/**
	 * Issues a request, translating transport failures into domain errors.
	 *
	 * `ObsRequestError` carries the raw `RequestStatus` code: OBS refusing a request is
	 * different from OBS being unreachable, and callers need to tell them apart.
	 */
	async call<Type extends keyof OBSRequestTypes>(
		requestType: Type,
		requestData?: OBSRequestTypes[Type]
	): Promise<OBSResponseTypes[Type]> {
		if (!this.obs.identified) {
			throw new ObsUnavailableError(`Cannot ${String(requestType)}: not connected to OBS`);
		}
		try {
			return await this.obs.call(requestType, requestData);
		} catch (error) {
			if (error instanceof OBSWebSocketError) {
				throw new ObsRequestError(error.code, error.message, { cause: error });
			}
			throw new ObsUnavailableError(
				error instanceof Error ? error.message : `Request ${String(requestType)} failed`,
				{ cause: error }
			);
		}
	}

	// ------------------------------------------------------------ connection

	private async tryConnect(): Promise<void> {
		if (this.stopped || this.isTerminal()) return;

		this.attempt += 1;
		if (this.state.status !== 'reconnecting') {
			this.setState({ status: 'connecting', attempt: this.attempt });
		}

		try {
			log.info({ attempt: this.attempt, url: this.options.url }, 'attempting to connect to OBS');
			const hello = await this.obs.connect(this.options.url, this.options.password, {
				eventSubscriptions: EVENT_SUBSCRIPTIONS,
				rpcVersion: RPC_VERSION
			});
			// The identify handshake reports the plugin version; the OBS version itself
			// needs a request, and the UI shows both.
			const version = await this.obs.call('GetVersion');

			this.attempt = 0;
			this.setState({
				status: 'connected',
				obsVersion: version.obsVersion,
				websocketVersion: hello.obsWebSocketVersion,
				rpcVersion: hello.negotiatedRpcVersion
			});
			log.info({ url: this.options.url, obsVersion: version.obsVersion }, 'connected to OBS');
		} catch (error) {
			const message = error instanceof Error ? error.message : 'connection failed';
			if (isAuthFailure(error)) {
				this.failAuth(message);
				return;
			}
			log.warn({ attempt: this.attempt, err: message }, 'OBS connection attempt failed');
			this.scheduleReconnect(message);
		}
	}

	private onConnectionClosed(error: OBSWebSocketError): void {
		if (this.stopped || this.isTerminal()) return;
		if (isAuthFailure(error)) {
			this.failAuth(error.message);
			return;
		}
		// Fires both for a dropped established connection and for a failed connect
		// attempt; `scheduleReconnect` is idempotent, so the duplicate is harmless.
		if (this.state.status === 'connected') {
			log.warn({ code: error?.code, reason: error?.message }, 'OBS connection lost');
		}
		this.scheduleReconnect(error?.message || 'connection closed');
	}

	private failAuth(message: string): void {
		this.clearRetry();
		this.setState({ status: 'error', kind: 'auth', message });
		log.error(
			{ url: this.options.url, message },
			'OBS rejected the websocket password - not retrying, fix OBS_PASSWORD and restart'
		);
	}

	private scheduleReconnect(lastError: string): void {
		if (this.stopped || this.retryTimer || this.isTerminal()) return;

		const delay = this.backoffDelay();
		this.setState({
			status: 'reconnecting',
			attempt: this.attempt,
			retryInMs: delay,
			lastError
		});

		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined;
			void this.tryConnect();
		}, delay);
		// Never hold the process open purely to retry a connection.
		this.retryTimer.unref?.();
	}

	/**
	 * Exponential backoff with jitter, so that several instances restarted together do
	 * not retry in lockstep. Jitter spreads each delay across the upper half of its
	 * window, keeping retries prompt while still spread out.
	 */
	private backoffDelay(): number {
		const { initialDelayMs, maxDelayMs } = this.options.reconnect;
		const exponential = Math.min(maxDelayMs, initialDelayMs * 2 ** Math.max(0, this.attempt - 1));
		return Math.round(exponential * (0.5 + Math.random() * 0.5));
	}

	private clearRetry(): void {
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.retryTimer = undefined;
	}

	private isTerminal(): boolean {
		return this.state.status === 'error' && this.state.kind === 'auth';
	}

	private setState(next: ConnectionState): void {
		if (JSON.stringify(next) === JSON.stringify(this.state)) return;
		this.state = next;
		for (const listener of this.listeners) {
			try {
				listener(next);
			} catch (error) {
				log.error({ err: error }, 'connection listener threw');
			}
		}
	}
}

/**
 * True when OBS closed the socket because identification failed — a wrong password, or
 * no password against a server that requires one.
 */
function isAuthFailure(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		(error as { code: unknown }).code === CloseCode.AuthenticationFailed
	);
}
