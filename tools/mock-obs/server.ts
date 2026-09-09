/**
 * A stand-in for OBS Studio's websocket server.
 *
 * Speaks enough of obs-websocket v5 for this application: the Hello/Identify/Identified
 * handshake including the sha256 authentication challenge, the fourteen requests we
 * issue, and the events we subscribe to. It exists so the app can be run, demonstrated
 * and integration-tested with no OBS installed, and so failure modes that are awkward to
 * stage against real OBS — a wrong password, a mid-recording disconnect, an older build
 * that omits `outputPath` on start — become one method call.
 */
import { randomBytes } from 'node:crypto';
import { decode as msgpackDecode, encode as msgpackEncode } from '@msgpack/msgpack';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import {
	CloseCode,
	JSON_SUBPROTOCOL,
	MSGPACK_SUBPROTOCOL,
	OpCode,
	RPC_VERSION,
	RequestStatus,
	authResponse
} from '../../src/lib/server/obs/protocol.js';
import { MockObsState, MockRequestError, type MockEvent, type MockObsOptions } from './state.js';

export interface MockServerOptions extends MockObsOptions {
	host?: string;
	/** 0 asks the OS for a free port; the bound port is returned by `start()`. */
	port?: number;
	/** When set, clients must complete the authentication challenge. */
	password?: string;
}

interface Session {
	socket: WebSocket;
	identified: boolean;
	salt: string;
	challenge: string;
	/** Negotiated encoding. Frames must be encoded per session, not once globally. */
	encoding: 'json' | 'msgpack';
}

/** Rough `eventIntent` bitmasks, matching obs-websocket's EventSubscription values. */
const EVENT_INTENT: Record<string, number> = {
	RecordStateChanged: 64,
	RecordFileChanged: 64,
	CurrentProgramSceneChanged: 4,
	CurrentPreviewSceneChanged: 4,
	SceneListChanged: 4,
	SceneCreated: 4,
	SceneRemoved: 4,
	SceneNameChanged: 4,
	StudioModeStateChanged: 1
};

export class MockObsServer {
	readonly state: MockObsState;
	private readonly options: MockServerOptions;
	private server: WebSocketServer | undefined;
	private readonly sessions = new Set<Session>();

	constructor(options: MockServerOptions = {}) {
		this.options = options;
		this.state = new MockObsState(options);
	}

	/** Starts listening and resolves with the bound port. */
	start(): Promise<number> {
		return new Promise((resolve, reject) => {
			const server = new WebSocketServer({
				host: this.options.host ?? '127.0.0.1',
				port: this.options.port ?? 0,
				// The client picks its encoding by subprotocol, and which one it asks for
				// depends on the build it imported. Refuse anything we do not speak rather
				// than completing the handshake without one: the client then aborts with
				// "Server sent no subprotocol", which is a confusing way to learn this.
				handleProtocols: (protocols) => {
					if (protocols.has(MSGPACK_SUBPROTOCOL)) return MSGPACK_SUBPROTOCOL;
					if (protocols.has(JSON_SUBPROTOCOL)) return JSON_SUBPROTOCOL;
					return false;
				}
			});

			server.on('connection', (socket) => this.onConnection(socket));
			server.on('error', reject);
			server.on('listening', () => {
				const address = server.address();
				resolve(typeof address === 'object' && address ? address.port : 0);
			});

			this.server = server;
		});
	}

	async stop(): Promise<void> {
		for (const session of this.sessions) session.socket.terminate();
		this.sessions.clear();
		const server = this.server;
		if (!server) return;
		this.server = undefined;
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	/** Number of clients that have completed identification. */
	get clientCount(): number {
		return [...this.sessions].filter((session) => session.identified).length;
	}

	/** Drops every connected client, emulating OBS quitting or the network going away. */
	dropClients(code = CloseCode.SessionInvalidated): void {
		for (const session of this.sessions) session.socket.close(code, 'mock: dropped');
		this.sessions.clear();
	}

	/** Applies a state transition and broadcasts whatever events it produced. */
	apply(transition: () => MockEvent[]): void {
		this.broadcast(transition());
	}

	broadcast(events: MockEvent[]): void {
		for (const event of events) {
			const message = {
				op: OpCode.Event,
				d: {
					eventType: event.eventType,
					eventIntent: EVENT_INTENT[event.eventType] ?? 1,
					eventData: event.eventData
				}
			};
			// Encode once per encoding rather than once per session.
			const frames = new Map<Session['encoding'], string | Uint8Array>();
			for (const session of this.sessions) {
				if (!session.identified) continue;
				let frame = frames.get(session.encoding);
				if (frame === undefined) {
					frame = encodeFrame(session.encoding, message);
					frames.set(session.encoding, frame);
				}
				session.socket.send(frame);
			}
		}
	}

	// ------------------------------------------------------------- handshake

	private onConnection(socket: WebSocket): void {
		const session: Session = {
			socket,
			identified: false,
			salt: randomBytes(16).toString('base64'),
			challenge: randomBytes(16).toString('base64'),
			encoding: socket.protocol === MSGPACK_SUBPROTOCOL ? 'msgpack' : 'json'
		};
		this.sessions.add(session);

		socket.on('close', () => this.sessions.delete(session));
		socket.on('error', () => this.sessions.delete(session));
		socket.on('message', (raw) => {
			void this.onMessage(session, raw);
		});

		this.send(session, OpCode.Hello, {
			obsWebSocketVersion: this.state.obsWebSocketVersion,
			rpcVersion: RPC_VERSION,
			...(this.options.password
				? { authentication: { challenge: session.challenge, salt: session.salt } }
				: {})
		});
	}

	private async onMessage(session: Session, raw: RawData): Promise<void> {
		let message: { op?: number; d?: Record<string, unknown> };
		try {
			message = decodeFrame(session.encoding, raw);
		} catch {
			session.socket.close(CloseCode.MessageDecodeError, 'mock: undecodable frame');
			return;
		}

		switch (message.op) {
			case OpCode.Identify:
				await this.onIdentify(session, message.d ?? {});
				return;
			case OpCode.Reidentify:
				this.send(session, OpCode.Identified, { negotiatedRpcVersion: RPC_VERSION });
				return;
			case OpCode.Request:
				if (!session.identified) {
					session.socket.close(CloseCode.NotIdentified, 'mock: not identified');
					return;
				}
				this.onRequest(session, message.d ?? {});
				return;
			default:
				session.socket.close(CloseCode.UnknownOpCode, `mock: unsupported op ${message.op}`);
		}
	}

	private async onIdentify(session: Session, data: Record<string, unknown>): Promise<void> {
		if (session.identified) {
			session.socket.close(CloseCode.AlreadyIdentified, 'mock: already identified');
			return;
		}
		if (data.rpcVersion !== RPC_VERSION) {
			session.socket.close(CloseCode.UnsupportedRpcVersion, 'mock: unsupported rpc version');
			return;
		}

		const { password } = this.options;
		if (password) {
			const expected = await authResponse(password, session.salt, session.challenge);
			if (data.authentication !== expected) {
				session.socket.close(CloseCode.AuthenticationFailed, 'mock: authentication failed');
				return;
			}
		}

		session.identified = true;
		this.send(session, OpCode.Identified, { negotiatedRpcVersion: RPC_VERSION });
	}

	// --------------------------------------------------------------- requests

	private onRequest(session: Session, data: Record<string, unknown>): void {
		const requestType = String(data.requestType ?? '');
		const requestId = String(data.requestId ?? '');
		const requestData = (data.requestData ?? {}) as Record<string, unknown>;

		try {
			const { responseData, events } = this.dispatch(requestType, requestData);
			this.send(session, OpCode.RequestResponse, {
				requestType,
				requestId,
				requestStatus: { result: true, code: RequestStatus.Success },
				...(responseData ? { responseData } : {})
			});
			// Real OBS emits the resulting events to every client, the requester included.
			this.broadcast(events);
		} catch (error) {
			const failure =
				error instanceof MockRequestError
					? error
					: new MockRequestError(
							RequestStatus.RequestProcessingFailed,
							error instanceof Error ? error.message : 'mock: unknown failure'
						);
			this.send(session, OpCode.RequestResponse, {
				requestType,
				requestId,
				requestStatus: { result: false, code: failure.code, comment: failure.comment }
			});
		}
	}

	private dispatch(
		requestType: string,
		requestData: Record<string, unknown>
	): { responseData?: Record<string, unknown>; events: MockEvent[] } {
		const state = this.state;
		const sceneName = () => {
			const name = requestData.sceneName;
			if (typeof name !== 'string' || name === '') {
				throw new MockRequestError(RequestStatus.MissingRequestField, 'sceneName is required');
			}
			return name;
		};

		switch (requestType) {
			case 'GetVersion':
				return {
					responseData: {
						obsVersion: state.obsVersion,
						obsWebSocketVersion: state.obsWebSocketVersion,
						rpcVersion: RPC_VERSION,
						availableRequests: [],
						supportedImageFormats: ['png', 'jpg'],
						platform: 'mock',
						platformDescription: 'Mock OBS server'
					},
					events: []
				};

			case 'GetSceneList': {
				const program = state.scenes.find((scene) => scene.name === state.program);
				const preview = state.scenes.find((scene) => scene.name === state.preview);
				return {
					responseData: {
						currentProgramSceneName: state.program,
						currentProgramSceneUuid: program?.uuid ?? '',
						currentPreviewSceneName: state.studioMode ? state.preview : '',
						currentPreviewSceneUuid: state.studioMode ? (preview?.uuid ?? '') : '',
						scenes: state.scenePayload()
					},
					events: []
				};
			}

			case 'SetCurrentProgramScene':
				return { events: state.setProgramScene(sceneName()) };

			case 'SetCurrentPreviewScene':
				return { events: state.setPreviewScene(sceneName()) };

			case 'TriggerStudioModeTransition':
				return { events: state.triggerTransition() };

			case 'GetStudioModeEnabled':
				return { responseData: { studioModeEnabled: state.studioMode }, events: [] };

			case 'SetStudioModeEnabled':
				return { events: state.setStudioMode(Boolean(requestData.studioModeEnabled)) };

			case 'CreateScene':
				return { events: state.createScene(sceneName()) };

			case 'RemoveScene':
				return { events: state.removeScene(sceneName()) };

			case 'GetRecordStatus':
				return { responseData: state.recordStatus(), events: [] };

			case 'StartRecord':
				return { events: state.startRecording() };

			case 'StopRecord': {
				const { events, outputPath } = state.stopRecording();
				return { responseData: { outputPath }, events };
			}

			case 'ToggleRecord': {
				if (state.isRecording) {
					const { events } = state.stopRecording();
					return { responseData: { outputActive: false }, events };
				}
				return { responseData: { outputActive: true }, events: state.startRecording() };
			}

			case 'PauseRecord':
				return { events: state.pauseRecording() };

			case 'ResumeRecord':
				return { events: state.resumeRecording() };

			case 'SplitRecordFile':
				return { events: state.splitRecordFile() };

			case 'GetRecordDirectory':
				return { responseData: { recordDirectory: state.getRecordDirectory() }, events: [] };

			case 'SetRecordDirectory':
				state.setRecordDirectory(String(requestData.recordDirectory ?? ''));
				return { events: [] };

			case 'GetProfileParameter': {
				const value = state.getProfileParameter(
					String(requestData.parameterCategory ?? ''),
					String(requestData.parameterName ?? '')
				);
				return {
					responseData: { parameterValue: value, defaultParameterValue: null },
					events: []
				};
			}

			case 'SetProfileParameter':
				state.setProfileParameter(
					String(requestData.parameterCategory ?? ''),
					String(requestData.parameterName ?? ''),
					requestData.parameterValue === null ? null : String(requestData.parameterValue ?? '')
				);
				return { events: [] };

			default:
				throw new MockRequestError(
					RequestStatus.UnknownRequestType,
					`mock does not implement '${requestType}'`
				);
		}
	}

	private send(session: Session, op: number, d: Record<string, unknown>): void {
		session.socket.send(encodeFrame(session.encoding, { op, d }));
	}
}

function encodeFrame(encoding: Session['encoding'], message: unknown): string | Uint8Array {
	return encoding === 'msgpack' ? msgpackEncode(message) : JSON.stringify(message);
}

function decodeFrame(
	encoding: Session['encoding'],
	raw: RawData
): { op?: number; d?: Record<string, unknown> } {
	if (encoding === 'json') {
		return JSON.parse(raw.toString());
	}
	const bytes = Array.isArray(raw)
		? Buffer.concat(raw)
		: Buffer.isBuffer(raw)
			? raw
			: Buffer.from(raw as ArrayBuffer);
	return msgpackDecode(bytes) as { op?: number; d?: Record<string, unknown> };
}
