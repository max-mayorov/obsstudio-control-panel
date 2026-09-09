# System Design — OBS Control App

Status: draft for review. Decisions marked **[D]** are settled; **[?]** are open.

## 1. Constraints that actually shape the design

Four findings from the obs-websocket v5 protocol drove most of what follows:

1. **OBS pushes state changes as events, but never pushes timecode.** There is no periodic
   progress event. `GetRecordStatus` must be polled for `outputTimecode` / `outputDuration`.
2. **There is no request that returns the path of an in-progress recording.**
   `GetRecordStatus` returns `outputActive`, `outputPaused`, `outputTimecode`, `outputDuration`,
   `outputBytes` — no path. `GetRecordDirectory` returns the folder only.
3. **The path arrives as an event, once.** Current obs-websocket emits `outputPath` on
   `RecordStateChanged` for both `OUTPUT_STARTED` and `OUTPUT_STOPPED`
   (`EventHandler_Outputs.cpp` calls `GetLastRecordFileName()` for both states). Published
   docs still say "if record stopped, `null` otherwise" — the docs are stale relative to the
   source. Older builds behave as documented.
   `RecordFileChanged.newOutputPath` (obs-websocket ≥ 5.5.0) covers mid-recording file splits.
4. **Consequence:** if the app connects *while a recording is already running*, it has missed the
   only message that carried the filename. This is unrecoverable via the protocol and needs a
   fallback (§6).

A single connection to OBS also means the server, not the browser, must own the OBS session —
several browser tabs are views onto one shared piece of hardware, not independent clients.

## 2. Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **Server owns one OBS connection**, configured by env vars | Password never reaches the browser; one socket regardless of tab count; reconnect logic lives in one place |
| D2 | **Fullstack SvelteKit + `adapter-node`** (SSR, not SPA) | Brief asks for API routes in SvelteKit; SSR renders the first paint with real OBS state, so no "disconnected" flash |
| D3 | **SSE for server→browser push**, POST for browser→server commands | One-way push is all we need; `EventSource` reconnects natively; no custom WS server alongside Vite |
| D4 | **OBS is the single source of truth; commands never write local state** | Store mutates only from OBS events + resync. Removes optimistic-state divergence entirely |
| D5 | **Three-tier filename resolution with visible provenance** | Honest UI: never presents a guess as fact (§6) |
| D6 | **Mock obs-websocket server ships with the repo** | App runs, demos and tests with zero OBS installed; lets us test auth failure, disconnects, scene creation |
| D7 | TypeScript, Svelte 5 runes, Tailwind 4 (Vite plugin, CSS-first) | Brief requires Tailwind; runes satisfy the state-management bonus |
| D8 | **Studio mode detected and honoured** | Off → click cuts to program. On → Preview/Program columns, click sets preview, explicit Transition. A control surface must never hard-cut live by surprise |
| D9 | **Shared-secret auth via httpOnly cookie** (§8.1) | The app can stop someone's recording. Cookie, not header — see the `EventSource` constraint below |
| D10 | **Pause/resume exposed** alongside start/stop | `outputPaused` has to be modelled for correct timecode anyway; exposing it closes a visible gap for ~20 lines |

## 3. Component map

```
┌───────────────────────────────── browser ─────────────────────────────────┐
│ routes/+page.svelte                                                       │
│   components/  ConnectionBadge · RecordPanel · ScenePicker                │
│                FilenameCard · Timecode · Toaster                          │
│   lib/client/obs-state.svelte.ts   runes store, fed by SSE                │
│   lib/client/commands.ts           POST wrappers + per-action pending flag │
│   lib/client/stream.ts             EventSource lifecycle + backoff         │
└──────────┬──────────────────────────────────────────┬─────────────────────┘
     POST /api/recording/* , /api/scenes/current   GET /api/state/stream (SSE)
┌──────────▼──────────────────────────────────────────▼─────────────────────┐
│ SvelteKit server (node)                                                   │
│                                                                           │
│   routes/api/**/+server.ts   HTTP adapter — validate, call, map errors     │
│         │                    (never imports obs-websocket-js)             │
│   lib/server/obs/service.ts  use-cases: startRecording, setScene, …        │
│         │                    throws domain errors, never HTTP concerns     │
│   lib/server/obs/store.ts    authoritative ObsState + pub/sub + poll ticker│
│   lib/server/obs/filename.ts three-tier filename resolution                │
│   lib/server/obs/client.ts   socket lifecycle, auth, reconnect, call()/on()│
│   lib/server/config.ts       env parsing + validation at boot              │
│   lib/server/log.ts          structured logging, redacts password          │
└────────────────────────────┬──────────────────────────────────────────────┘
                             │ obs-websocket v5 (RPC v1) over ws://
                   ┌─────────▼─────────┐
                   │ OBS Studio        │   or   tools/mock-obs (dev/test/demo)
                   └───────────────────┘
```

## 4. Boundaries — what each layer may not do

These are the rules that keep the thing testable:

- **Routes may not import `obs-websocket-js`.** They translate HTTP↔domain and nothing else.
  Every route body is ~10 lines. Swapping the OBS SDK touches one directory.
- **`service.ts` may not know about HTTP.** It throws typed domain errors
  (`ObsUnavailable`, `ObsConflict`, `SceneNotFound`, …); a single mapper turns those into
  status codes. Services are unit-testable with no request object.
- **`client.ts` may not know about domain semantics.** It owns the socket: connect, identify,
  backoff, `call()`, `on()`, and connection-state emission. It does not know what a scene is.
- **Only `store.ts` knows the state shape.** Both the SSE stream and the SSR `load` read from
  it, so page-load state and streamed state cannot drift apart.
- **Commands do not mutate the store** (D4). `POST /api/recording/start` issues `StartRecord`
  and returns; the UI updates when OBS emits `RecordStateChanged`. Per-button *pending* state is
  client-local and clears on the next snapshot.

## 5. State model

```ts
type ConnectionState =
  | { status: 'connecting'; attempt: number }
  | { status: 'connected'; obsVersion: string; rpcVersion: number }
  | { status: 'reconnecting'; attempt: number; retryInMs: number; lastError: string }
  | { status: 'error'; kind: 'auth' | 'unreachable'; message: string };

type RecordingState = {
  active: boolean; paused: boolean;
  timecode: string; durationMs: number; bytes: number;
  file: { path: string; source: 'obs' | 'predicted' } | null;
  lastCompleted: { path: string; endedAt: number } | null;
};

type ScenesState = {
  scenes: { name: string; uuid: string }[];
  program: string | null; preview: string | null; studioMode: boolean;
  stale: boolean;   // true while disconnected — UI greys out, keeps last known
};
```

`file.source` is the honesty mechanism: the UI badges a predicted path as predicted.

## 6. The filename problem

Given §1.2–1.4, resolution is tiered, best source wins:

1. **`obs` (authoritative).** `RecordStateChanged{outputState: OUTPUT_STARTED}.outputPath`, and
   `RecordFileChanged.newOutputPath` on splits. Works on current OBS. No version sniffing:
   if the field is populated we use it, otherwise we fall through.
2. **`predicted` (fallback, only when tier 1 gave nothing).** Used when the app connects
   mid-recording or talks to an older build. Compose
   `GetRecordDirectory` + `GetProfileParameter('Output','FilenameFormatting')`, expand the
   `%CCYY-%MM-%DD %hh-%mm-%ss` tokens against the recording start time
   (`now − outputDuration`), append the container extension from the profile. Labelled
   **predicted** in the UI, because dedupe suffixes and remuxing can make it wrong.
3. **Final path on stop.** `StopRecord`'s response and `RecordStateChanged{OUTPUT_STOPPED}`
   both carry the true path → promoted to `lastCompleted`, always authoritative.

**Caveat on tier 2 that tier 1 does not have:** token expansion uses the *OBS machine's* local
clock and timezone. Our server may be in a container running UTC. The protocol exposes no way to
read OBS's timezone, so a predicted name can be hours off. This is precisely why tier 2 is
labelled, not presented as fact.

### 6.1 Prescribing the filename instead of discovering it  **[?]**

`StartRecord` accepts **no parameters** — there is no way to pass a filename with the start
request. v4 had `SetFilenameFormatting` / `SetRecordingFolder`; v5 removed them in favour of the
generic profile API (obs-websocket issue #1062). The equivalent is therefore:

```
SetProfileParameter('Output', 'FilenameFormatting', <name or template>)
SetRecordDirectory(<dir>)          // optional
StartRecord
```

This makes recordings *we* start deterministic — we know the name by construction, with no event
and no guessing. It does **not** cover a recording already running when we connect, and it comes
with real costs:

- It **mutates the user's OBS profile**, persistently. Correct use requires reading the old value,
  writing ours, and restoring it — with a defined answer for "restore when?" if we crash mid-record.
- A literal (non-templated) name collides on the second recording; OBS then either overwrites or
  appends a dedupe suffix depending on `Output/OverwriteIfExists` — so we would be wrong again
  unless we keep a timestamp token, which reintroduces the clock-skew caveat above.
- The container extension still comes from the recording-format profile parameter, not from
  `FilenameFormatting`.

Tier 1 already resolves the common case authoritatively on current OBS, so prescribing buys
little as a *detection* mechanism. It is more interesting as an opt-in **feature** — "name this
recording" — which is a separate decision, tracked in §13.

## 7. Real-time updates

**Push (server→browser), two SSE event types:**
- `state` — full snapshot, sent on any change. Snapshots are <1 KB, so full-state beats patches:
  idempotent, self-healing, no patch-ordering bugs.
- `tick` — `{timecode, durationMs, bytes}` only, 1 Hz, **only while recording is active**.

**Timecode:** server polls `GetRecordStatus` at 1 Hz while recording; the client interpolates
between ticks from a monotonic base so the display moves smoothly without hammering OBS, and
resyncs on every tick. Interpolation pauses when `paused` is true.

**Idle cost is zero:** the poll ticker runs only when a recording is active *and* at least one
SSE subscriber is attached. No subscribers → no polling.

**Scenes** need no polling: `SceneListChanged`, `SceneCreated`, `SceneRemoved`,
`SceneNameChanged`, `CurrentProgramSceneChanged`, `CurrentPreviewSceneChanged` and
`StudioModeStateChanged` cover the bonus requirement ("newly created scenes in OBS") directly.
We subscribe to a narrow `EventSubscription` bitmask (General | Config | Scenes | Outputs) to
avoid high-volume categories.

**On every (re)connect:** full resync — `GetVersion`, `GetSceneList`, `GetRecordStatus`,
`GetRecordDirectory`, `GetStudioModeEnabled`, profile params — then broadcast one snapshot.
Missing an event while disconnected can therefore never leave stale state on screen.

## 8. HTTP surface

| Method | Path | Success | Failure modes |
|---|---|---|---|
| GET | `/api/state` | 200 snapshot | 503 when never connected |
| GET | `/api/state/stream` | 200 SSE | — |
| POST | `/api/recording/start` | 202 | 409 already recording, 503 OBS down |
| POST | `/api/recording/stop` | 200 `{outputPath}` | 409 not recording, 503 |
| POST | `/api/recording/pause` `/resume` | 202 | 409 wrong state |
| POST | `/api/scenes/current` `{name}` | 200 | 400 bad body, 404 unknown scene, 503 |
| POST | `/api/scenes/preview` `{name}` | 200 | 409 studio mode off, 404 unknown scene |
| POST | `/api/transition` | 202 | 409 studio mode off |
| POST | `/api/session` `{token}` | 204 + `Set-Cookie` | 401 bad token |
| GET | `/api/health` | 200 | — (container healthcheck) |

Envelope: `{ok: true, data}` / `{ok: false, error: {code, message, requestId}}`.
`requestId` is logged server-side and shown in the toast, so a UI error can be traced to a log line.

**Error mapping.** obs-websocket returns numeric `RequestStatus` codes; `obs-websocket-js` does
not export them as a named enum, so we keep our own table and map:
socket down → 503 · auth rejected → 502 (operator misconfiguration, surfaced as a config error
in the UI, never as a transient) · output already/not running → 409 · unknown scene → 404 ·
schema violation → 400 · anything else from OBS → 502. Passwords are redacted from all logs and
never appear in a response.

### 8.1 Authentication

A shared secret (`APP_TOKEN`) gates every `/api` route via a single `handle` hook in
`hooks.server.ts`.

**The mechanism is a cookie, not a header, and that is forced by the design:** `EventSource`
exposes no API for request headers, so a `Authorization:`-style scheme cannot authenticate the
SSE stream. Putting the token in the query string would leak it into access logs. So:
`POST /api/session` exchanges the token for an httpOnly, `SameSite=Strict` cookie
(`Secure` when served over TLS), which the browser then attaches to both `fetch` and
`EventSource` automatically. Comparison is constant-time.

If `APP_TOKEN` is unset the guard is disabled, a warning is logged at boot and the UI shows an
"unauthenticated" banner — so a reviewer's first run needs no setup, while the mechanism is
present and exercised by tests. Default bind is loopback.

## 9. Mock OBS (`tools/mock-obs`)

A `ws` server speaking the v5 handshake (Hello → Identify → Identified, incl. the sha256
auth challenge) and the ~12 requests/events this app uses. Scriptable over a small control
endpoint so we can drive the cases real OBS makes painful to reproduce:
wrong password · server unreachable · disconnect mid-recording · a scene created in OBS while
the UI is open · a file split. Doubles as the fixture for integration tests and lets a reviewer
run the app with no OBS installed.

## 10. Packaging

Multi-stage Dockerfile (build → prune → `node:22-alpine` runtime, non-root, HEALTHCHECK on
`/api/health`). `docker-compose.yml` with a `mock` profile so `docker compose --profile mock up`
demonstrates the app end-to-end without OBS.

Container→OBS networking is the documented gotcha: macOS/Windows use
`OBS_URL=ws://host.docker.internal:4455`; Linux needs
`--add-host=host.docker.internal:host-gateway` or `--network host`.

## 11. Testing

- **Unit (vitest):** state reducer (event → snapshot transitions), filename token expansion,
  error mapper, constant-time token comparison. Pure functions, no I/O.
- **Integration:** service + client against the mock over a real socket — exercises the whole
  server stack including reconnect, auth failure and mid-recording disconnect.

## 12. Open questions

- **Opt-in "name this recording"** (§6.1) — feature, or leave it out?
- Whether `DESIGN.md` and `ASSIGNMENT.md` ship in the submitted repository.
- Logger: `pino` + `pino-pretty` vs a ~40-line structured logger with no dependency.
- CI workflow — out of the agreed scope, trivial to add later.
