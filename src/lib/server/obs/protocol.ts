/**
 * obs-websocket v5 protocol constants.
 *
 * `obs-websocket-js` exports the op codes but not the request-status or close-code
 * enums, and both matter to us: status codes drive the HTTP error mapping, and close
 * code 4009 is how we tell a wrong password (terminal) from a dropped socket
 * (retry forever). Values are transcribed from the obs-websocket sources,
 * `src/requesthandler/types/RequestStatus.h` and
 * `src/websocketserver/types/WebSocketCloseCode.h`.
 */

export const OpCode = {
	Hello: 0,
	Identify: 1,
	Identified: 2,
	Reidentify: 3,
	Event: 5,
	Request: 6,
	RequestResponse: 7,
	RequestBatch: 8,
	RequestBatchResponse: 9
} as const;

export const CloseCode = {
	DontClose: 0,
	UnknownReason: 4000,
	MessageDecodeError: 4002,
	MissingDataField: 4003,
	InvalidDataFieldType: 4004,
	InvalidDataFieldValue: 4005,
	UnknownOpCode: 4006,
	NotIdentified: 4007,
	AlreadyIdentified: 4008,
	AuthenticationFailed: 4009,
	UnsupportedRpcVersion: 4010,
	SessionInvalidated: 4011,
	UnsupportedFeature: 4012
} as const;

export const RequestStatus = {
	Unknown: 0,
	NoError: 10,
	Success: 100,
	MissingRequestType: 203,
	UnknownRequestType: 204,
	GenericError: 205,
	UnsupportedRequestBatchExecutionType: 206,
	NotReady: 207,
	MissingRequestField: 300,
	MissingRequestData: 301,
	InvalidRequestField: 400,
	InvalidRequestFieldType: 401,
	RequestFieldOutOfRange: 402,
	RequestFieldEmpty: 403,
	TooManyRequestFields: 404,
	OutputRunning: 500,
	OutputNotRunning: 501,
	OutputPaused: 502,
	OutputNotPaused: 503,
	OutputDisabled: 504,
	StudioModeActive: 505,
	StudioModeNotActive: 506,
	ResourceNotFound: 600,
	ResourceAlreadyExists: 601,
	InvalidResourceType: 602,
	NotEnoughResources: 603,
	InvalidResourceState: 604,
	InvalidInputKind: 605,
	ResourceNotConfigurable: 606,
	InvalidFilterKind: 607,
	ResourceCreationFailed: 700,
	ResourceActionFailed: 701,
	RequestProcessingFailed: 702,
	CannotAct: 703
} as const;

/** Values of `RecordStateChanged.outputState`. */
export const OutputState = {
	Starting: 'OBS_WEBSOCKET_OUTPUT_STARTING',
	Started: 'OBS_WEBSOCKET_OUTPUT_STARTED',
	Stopping: 'OBS_WEBSOCKET_OUTPUT_STOPPING',
	Stopped: 'OBS_WEBSOCKET_OUTPUT_STOPPED',
	Paused: 'OBS_WEBSOCKET_OUTPUT_PAUSED',
	Resumed: 'OBS_WEBSOCKET_OUTPUT_RESUMED'
} as const;

/**
 * The two websocket subprotocols obs-websocket offers. Which one a client negotiates
 * depends on the build it imported: in Node, `obs-websocket-js`'s package exports map
 * resolves the default import to the msgpack build, while browsers and the `/json`
 * subpath get JSON. Real OBS accepts both, so the mock does too.
 */
export const JSON_SUBPROTOCOL = 'obswebsocket.json';
export const MSGPACK_SUBPROTOCOL = 'obswebsocket.msgpack';

/** RPC version this application speaks. */
export const RPC_VERSION = 1;

/**
 * The obs-websocket authentication handshake:
 * `base64(sha256(base64(sha256(password + salt)) + challenge))`.
 *
 * Lives here rather than in the mock because both sides need it — the mock to verify,
 * the tests to produce a valid response.
 */
export async function authResponse(
	password: string,
	salt: string,
	challenge: string
): Promise<string> {
	const { createHash } = await import('node:crypto');
	const secret = createHash('sha256')
		.update(password + salt)
		.digest('base64');
	return createHash('sha256')
		.update(secret + challenge)
		.digest('base64');
}

/** Formats milliseconds the way OBS formats `outputTimecode`: `HH:MM:SS.mmm`. */
export function formatTimecode(durationMs: number): string {
	const ms = Math.max(0, Math.floor(durationMs));
	const hours = Math.floor(ms / 3_600_000);
	const minutes = Math.floor((ms % 3_600_000) / 60_000);
	const seconds = Math.floor((ms % 60_000) / 1000);
	const millis = ms % 1000;
	const pad = (n: number, width = 2) => String(n).padStart(width, '0');
	return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(millis, 3)}`;
}
