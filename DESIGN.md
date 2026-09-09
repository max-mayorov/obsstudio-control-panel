# System Design — OBS Control App

## 1. Constraints that actually shape the design

Four properties of the obs-websocket v5 protocol drove most of what follows:

1. **OBS pushes state changes as events, but never pushes timecode.** There is no periodic
   progress event. `GetRecordStatus` must be polled for `outputTimecode` / `outputDuration`.
2. **No request returns the path of an in-progress recording.** `GetRecordStatus` returns
   `outputActive`, `outputPaused`, `outputTimecode`, `outputDuration`, `outputBytes` — no path.
   `GetRecordDirectory` returns the folder only. `StartRecord` takes no parameters at all.
3. **The path arrives as an event, once.** Current obs-websocket emits `outputPath` on
   `RecordStateChanged` for both `OUTPUT_STARTED` and `OUTPUT_STOPPED`
   (`EventHandler_Outputs.cpp` calls `GetLastRecordFileName()` for both states). The published
   protocol docs still say *"if record stopped, `null` otherwise"* — the docs are stale relative
   to the source, and older builds behave as documented.
   `RecordFileChanged.newOutputPath` (obs-websocket ≥ 5.5.0) covers mid-recording file splits.
4. **Therefore: connecting while a recording is already running means the filename is
   unrecoverable** — the only message that carried it has been and gone. This needs a fallback
   (§7), not a bug report.

A single connection to OBS also means the *server*, not the browser, must own the session:
several browser tabs are views onto one piece of hardware, not independent clients.

## 2. Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **Server owns one OBS connection**, configured by env vars | Password never reaches the browser; one socket regardless of tab count; reconnect logic in one place |
| D2 | **Fullstack SvelteKit + `adapter-node`** (SSR, not SPA) | Brief asks for API routes in SvelteKit; SSR renders first paint with real OBS state, so no "disconnected" flash |
| D3 | **SSE server→browser, POST browser→server** | One-way push is all we need; `EventSource` reconnects natively; no custom WS server alongside Vite |
| D4 | **OBS is the single source of truth; commands never write local state** | Store mutates only from OBS events + resync. Eliminates optimistic-state divergence |
| D5 | **Three-tier filename resolution with visible provenance** | Never presents a guess as fact (§7) |
| D6 | **Mock obs-websocket server ships with the repo** | Runs, demos and tests with zero OBS installed; makes auth failure, disconnects and scene creation reproducible |
| D7 | TypeScript, Svelte 5 runes, Tailwind 4 (Vite plugin, CSS-first) | Brief requires Tailwind; runes satisfy the state-management bonus |
| D8 | **Studio mode detected and honoured** | Off → click cuts to program. On → Preview/Program columns, click sets preview, explicit Transition. A control surface must never hard-cut live by surprise |
| D9 | **Shared-secret auth via httpOnly cookie** | The app can stop someone's recording. Cookie, not header — forced by `EventSource` (§10.1) |
| D10 | **Pause/resume exposed** alongside start/stop | `outputPaused` must be modelled for correct timecode anyway; exposing it closes a visible gap cheaply |

## 3. Component map

```
┌───────────────────────────────── browser ─────────────────────────────────┐
│ routes/+page.svelte                                                       │
│   components/  ConnectionBadge · RecordPanel · ScenePicker                 │
│                FilenameCard · Timecode · Toaster                          │
│   lib/client/obs-state.svelte.ts   runes store, fed by SSE                 │
│   lib/client/commands.ts           POST wrappers + per-action pending flag │
│   lib/client/stream.ts             EventSource lifecycle + backoff         │
└──────────┬──────────────────────────────────────────┬─────────────────────┘
     POST /api/recording/* , /api/scenes/*         GET /api/state/stream (SSE)
┌──────────▼──────────────────────────────────────────▼─────────────────────┐
│ SvelteKit server (node)                                                   │
│                                                                           │
│   hooks.server.ts            auth guard · connection bootstrap             │
│   routes/api/**/+server.ts   HTTP adapter — validate, call, map errors     │
│         │                    (never imports obs-websocket-js)              │
│   lib/server/obs/service.ts  use-cases: startRecording, setScene, …        │
│         │                    throws domain errors, knows no HTTP           │
│   lib/server/obs/store.ts    authoritative ObsState + pub/sub + poll ticker│
│   lib/server/obs/filename.ts three-tier filename resolution                │
│   lib/server/obs/client.ts   socket lifecycle, auth, reconnect, call()/on()│
│   lib/server/config.ts       env parsing + validation at boot              │
│   lib/server/log.ts          structured logging, redacts secrets           │
└────────────────────────────┬──────────────────────────────────────────────┘
                             │ obs-websocket v5 (RPC v1) over ws://
                   ┌─────────▼─────────┐
                   │ OBS Studio        │   or   tools/mock-obs (dev/test/demo)
                   └───────────────────┘
```

## 4. Boundaries — what each layer may not do

These rules are what keep the thing testable:

- **Routes may not import `obs-websocket-js`.** They translate HTTP↔domain and nothing else.
  Every route body is ~10 lines. Swapping the OBS SDK touches one directory.
- **`service.ts` may not know about HTTP.** It throws typed domain errors
  (`ObsUnavailable`, `ObsConflict`, `SceneNotFound`, …); one mapper turns those into status
  codes. Services are unit-testable with no request object.
- **`client.ts` may not know domain semantics.** It owns the socket — connect, identify,
  backoff, `call()`, `on()`, connection-state emission. It does not know what a scene is.
- **Only `store.ts` knows the state shape.** Both the SSE stream and the SSR `load` read from
  it, so page-load state and streamed state cannot drift apart.
- **Commands do not mutate the store** (D4). `POST /api/recording/start` issues `StartRecord`
  and returns; the UI updates when OBS emits `RecordStateChanged`. Per-button *pending* state is
  client-local and clears on the next snapshot.

## 5. Dependencies

**External runtime:** OBS Studio ≥ 28 with the bundled obs-websocket 5.x server enabled
(Tools → WebSocket Server Settings), reachable over TCP. Live filename display (§7 tier 1)
needs a build recent enough to populate `outputPath` on start; older builds degrade to tier 2.

**Packages** — one runtime dependency of substance:

| Package | Role |
|---|---|
| `obs-websocket-js` ^5 | OBS protocol client. The *only* non-framework runtime dependency |
| `@sveltejs/kit`, `svelte` ^5, `@sveltejs/adapter-node` | Framework + Node deployment target |
| `tailwindcss` ^4, `@tailwindcss/vite` | Styling (required by the brief) |
| `typescript`, `vite`, `vitest` | Build and test |
| `ws` *(dev only)* | Mock OBS server |

**Internal import direction** — strictly one-way, no cycles:

```
routes/api  ─▶ service ─▶ client ─▶ obs-websocket-js
     │            │
     └──▶ store ◀─┘          config, log ◀── everything
lib/client/* ─▶ lib/types.ts ◀─ lib/server/*     (shared DTOs, the wire contract)
```

`lib/types.ts` is the single source of truth for the browser↔server contract, imported by both
sides so a shape change breaks the build rather than the runtime.

## 6. State model

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
  stale: boolean;   // true while disconnected — UI greys out but keeps last known
};
```

`file.source` is the honesty mechanism: a predicted path is badged as predicted.

## 7. The filename problem

Given §1.2–1.4, resolution is tiered and best-source-wins:

1. **`obs` (authoritative).** `RecordStateChanged{outputState: OUTPUT_STARTED}.outputPath`, plus
   `RecordFileChanged.newOutputPath` on splits. No version sniffing: if the field is populated we
   use it, otherwise we fall through.
2. **`predicted` (only when tier 1 yielded nothing).** For connecting mid-recording, or older
   builds. Compose `GetRecordDirectory` with
   `GetProfileParameter('Output','FilenameFormatting')`, expand the `%CCYY-%MM-%DD %hh-%mm-%ss`
   tokens against the recording start time (`now − outputDuration`), append the container
   extension from the profile. Badged **predicted**, because dedupe suffixes and remuxing can
   make it wrong — and because token expansion uses the *OBS machine's* clock and timezone,
   which the protocol does not expose and which our container may not share.
3. **Final path on stop.** `StopRecord`'s response and `RecordStateChanged{OUTPUT_STOPPED}` both
   carry the true path → promoted to `lastCompleted`, always authoritative.

### 7.1 Considered and rejected: prescribing the filename

v4 had `SetFilenameFormatting` / `SetRecordingFolder`; v5 removed them, and `StartRecord` takes
no parameters. The equivalent today is to write the profile before starting:

```
SetProfileParameter('Output', 'FilenameFormatting', <name>) ; StartRecord
```

Rejected. It makes only *our own* starts deterministic — the mid-recording-connect case in §1.4
is untouched — while adding a persistent mutation of the user's OBS profile that must be read,
overwritten and restored, with an undefined answer for "restore when?" if the process dies
mid-recording. A literal name also collides on the second recording, resolved by OBS as an
overwrite or a dedupe suffix depending on `Output/OverwriteIfExists`. Since tier 1 already
returns the authoritative path on current builds, this buys nothing it does not also cost.

## 8. Real-time updates

**Two SSE event types:**
- `state` — full snapshot on any change. Snapshots are <1 KB, so full-state beats patches:
  idempotent, self-healing, no patch-ordering bugs.
- `tick` — `{timecode, durationMs, bytes}` only, 1 Hz, **only while recording is active**.

**Timecode: why a request loop on an event-driven connection.** The OBS connection is a single
persistent websocket; this is one request message on it per second, not connection churn. Two
findings force it:

*There is no event to subscribe to.* Of the 59 events in the protocol, every output-related one
is a state **transition** — `RecordStateChanged`, `RecordFileChanged`, `StreamStateChanged`,
`ReplayBufferStateChanged`, `VirtualcamStateChanged`, `ReplayBufferSaved`. No progress or stats
event exists; `outputTimecode` and `outputBytes` are `GetRecordStatus` response fields only.

*Client-side extrapolation alone is wrong, not merely imprecise.* OBS derives the duration from
frame count, not wall clock:

```cpp
// Utils::Obs::NumberHelper::GetOutputDuration
uint64_t frameTimeNs = video_output_get_frame_time(video);
int totalFrames = obs_output_get_total_frames(output);
return util_mul_div64(totalFrames, frameTimeNs, 1000000ULL);
```

Under encoder overload or a disk stall OBS drops frames, and media time falls behind real time.
A wall-clock timer would read `05:00` while the file is 4:52 — diverging precisely when the
operator needs the truth. `outputBytes` has no client-side equivalent at all.

So we do both, each for what it is good at: **1 Hz resync for truth, client interpolation from a
monotonic base for smoothness**, resyncing every tick. Polling alone would need ~10 Hz to look
smooth — 10× the traffic for a worse answer. Interpolation halts while `paused`.
`OBS_POLL_INTERVAL_MS` is configurable; `0` disables the loop and falls back to pure
extrapolation.

**Idle cost is zero:** the poll ticker runs only when a recording is active *and* at least one
SSE subscriber is attached.

**Scenes need no polling.** `SceneListChanged`, `SceneCreated`, `SceneRemoved`,
`SceneNameChanged`, `CurrentProgramSceneChanged`, `CurrentPreviewSceneChanged` and
`StudioModeStateChanged` satisfy the "newly created scenes in OBS" bonus directly. We subscribe
to a narrow `EventSubscription` bitmask (General | Config | Scenes | Outputs), excluding the
high-volume categories.

**On every (re)connect:** full resync — `GetVersion`, `GetSceneList`, `GetRecordStatus`,
`GetRecordDirectory`, `GetStudioModeEnabled`, profile params — then one broadcast snapshot.
Events missed while disconnected therefore cannot leave stale state on screen.

## 9. Reconnection

Module-level singleton, guarded against Vite HMR duplication. Started from the `init` hook so
state is warm before the first request. Reconnect uses exponential backoff with jitter, capped
at 15 s, retrying indefinitely — an operator restarting OBS should see the UI recover on its
own. Auth rejection is *terminal*, not retried: it is a configuration error, and hammering a
rejecting server achieves nothing. The UI distinguishes the two.

## 10. HTTP surface

| Method | Path | Success | Failure modes |
|---|---|---|---|
| GET | `/api/state` | 200 snapshot | 503 never connected |
| GET | `/api/state/stream` | 200 SSE | — |
| POST | `/api/recording/start` | 202 | 409 already recording, 503 OBS down |
| POST | `/api/recording/stop` | 200 `{outputPath}` | 409 not recording, 503 |
| POST | `/api/recording/pause` · `/resume` | 202 | 409 wrong state |
| POST | `/api/scenes/current` `{name}` | 200 | 400 bad body, 404 unknown scene, 503 |
| POST | `/api/scenes/preview` `{name}` | 200 | 409 studio mode off, 404 unknown scene |
| POST | `/api/transition` | 202 | 409 studio mode off |
| POST | `/api/session` `{token}` | 204 + `Set-Cookie` | 401 bad token |
| GET | `/api/health` | 200 | — (container healthcheck) |

Envelope: `{ok: true, data}` / `{ok: false, error: {code, message, requestId}}`. The `requestId`
is logged server-side and shown in the toast, so any UI error traces to a log line.

**Error mapping.** obs-websocket returns numeric `RequestStatus` codes, which
`obs-websocket-js` does not re-export as a named enum — so we keep our own table:
socket down → 503 · auth rejected → 502, surfaced as a configuration error rather than a
transient · output already/not running → 409 · unknown scene → 404 · schema violation → 400 ·
anything else from OBS → 502. Secrets are redacted from logs and never appear in a response.

### 10.1 Authentication

A shared secret (`APP_TOKEN`) gates every `/api` route via one `handle` hook.

**The mechanism is a cookie, not a header, and that is forced:** `EventSource` exposes no API
for request headers, so an `Authorization:` scheme cannot authenticate the SSE stream, and a
token in the query string would leak into access logs. So `POST /api/session` exchanges the
token for an httpOnly, `SameSite=Strict` cookie (`Secure` under TLS) that the browser attaches
to both `fetch` and `EventSource` automatically. Comparison is constant-time.

If `APP_TOKEN` is unset the guard is disabled, a warning is logged at boot and the UI shows an
"unauthenticated" banner — so a first run needs no setup while the mechanism stays exercised by
tests. Default bind is loopback.

## 11. Mock OBS (`tools/mock-obs`)

A `ws` server speaking the v5 handshake (Hello → Identify → Identified, including the sha256
auth challenge) and the ~14 requests/events this app uses. Scriptable over a small control
endpoint, to drive the cases real OBS makes painful to reproduce: wrong password · unreachable
server · disconnect mid-recording · a scene created in OBS while the UI is open · a file split ·
an OBS build that omits `outputPath` on start, exercising tier 2. Doubles as the integration-test
fixture and lets a reviewer run everything with no OBS installed.

## 12. Packaging

Multi-stage Dockerfile (build → prune → `node:22-alpine`, non-root, HEALTHCHECK on
`/api/health`). `docker-compose.yml` carries a `mock` profile, so `docker compose --profile mock
up` demonstrates the app end-to-end without OBS.

Container→OBS networking is the documented gotcha: macOS/Windows use
`OBS_URL=ws://host.docker.internal:4455`; Linux needs
`--add-host=host.docker.internal:host-gateway` or `--network host`.

## 13. Testing

- **Unit (vitest):** state reducer (event → snapshot transitions), filename token expansion,
  error mapper, constant-time token comparison. Pure functions, no I/O.
- **Integration:** service + client against the mock over a real socket — exercises the whole
  server stack including reconnect, auth failure and mid-recording disconnect.

## 14. Known limitations

- A recording already in progress when the app connects can only show a **predicted** filename
  (§1.4). Protocol limitation, not an implementation gap.
- Predicted names use our clock, not the OBS machine's; they can be wrong across a timezone
  boundary. Badged accordingly.
- The shared secret is a single static token with no user model, rotation or rate limiting —
  appropriate for a LAN control surface, not for exposure to the internet.
- Recording controls act on OBS's *current* profile; changing profile in OBS mid-session
  re-syncs state but is not otherwise modelled.
