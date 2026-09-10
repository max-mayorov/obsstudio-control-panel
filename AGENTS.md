# AGENTS.md

Guidance for coding agents working in this repository. Human-facing setup lives in
`README.md`; the reasoning behind the architecture, including the obs-websocket protocol
constraints that shaped it, lives in `DESIGN.md`.

## What this is

A SvelteKit web app that controls OBS Studio over
[obs-websocket](https://github.com/obsproject/obs-websocket) v5: start/stop/pause
recording, switch scenes, and show the recording's filename and timecode live.

## Commands

```bash
npm run dev            # dev server on :5173
npm run mock           # mock OBS on ws://127.0.0.1:4455 — start this first
npm test               # vitest, all suites
npm run check          # svelte-check + TypeScript (must be 0 errors, 0 warnings)
npm run format         # prettier
npm run build && npm start   # production build, then serve on :3000
```

A single test file or case:

```bash
npx vitest run tests/obs-store.test.ts
npx vitest run -t 'predicts the filename'
```

**No OBS installation is needed for anything above.** Tests spin up the mock in-process;
`npm run mock` gives the dev server something to talk to. The mock takes typed commands on
stdin (`record start`, `scene add X`, `studio on`, `drop 2000`, `kill`, `help`) — that is
the fastest way to exercise live-update behaviour by hand.

## Architecture

```
Browser ── POST /api/…  (commands) ──▶ SvelteKit server ──▶ OBS
        ◀─ GET /api/state/stream ────  (one websocket, obs-websocket v5)
           (server-sent events)
```

Layers, outermost first. Each may only depend on the one below it:

| Path                            | Role                                           | May not                   |
| ------------------------------- | ---------------------------------------------- | ------------------------- |
| `src/routes/api/**`             | HTTP adapter: validate, call, map errors       | import `obs-websocket-js` |
| `src/lib/server/obs/service.ts` | Use cases, throws domain errors                | know about HTTP           |
| `src/lib/server/obs/store.ts`   | Authoritative state + pub/sub + heartbeat      | —                         |
| `src/lib/server/obs/client.ts`  | Socket lifecycle, auth, reconnect, `call`/`on` | know what a scene is      |

`src/lib/types.ts` is the browser↔server wire contract, imported by both sides — change a
shape there and the build breaks rather than the runtime. It must never import from
`$lib/server`.

## Invariants — do not break these without reading DESIGN.md first

**OBS is the single source of truth; commands never write local state.**
`POST /api/recording/start` issues `StartRecord` and returns. The store changes only when
OBS emits an event or a resync reads new values, and the browser changes only when the
stream says so. Buttons carry a client-local _pending_ flag, never an optimistic value.
This is what keeps the UI correct when somebody presses Record in OBS itself, and it
removes optimistic-rollback bugs entirely. Adding "update the UI immediately" would
reintroduce them.

**The timecode heartbeat is not redundant polling.** obs-websocket has no progress or
timecode event — every output event is a state _transition_ — so `outputTimecode` and
`outputBytes` can only be fetched. And OBS derives duration from frame count
(`totalFrames × frameTime`), so under encoder overload it falls behind wall clock;
counting locally without re-syncing would drift away from the real recording. The server
samples once a second over the already-open socket, only while a recording is active _and_
a stream subscriber is attached, and the browser interpolates between samples. Do not
replace it with pure client-side extrapolation.

**Authentication is a cookie because `EventSource` cannot set request headers.** A bearer
scheme cannot authenticate the SSE stream at all, and a token in a query string lands in
access logs. `POST /api/session` exchanges the shared secret for an httpOnly session
cookie holding an opaque id. Do not "modernise" this to an `Authorization` header.

**The recording filename is tiered, and predictions are labelled.** No request returns the
path of a recording in progress and `StartRecord` takes no filename argument; OBS announces
the path once, in the event fired when recording starts. So: use OBS's value when it gives
one (`source: 'obs'`), reconstruct from the record directory and profile template when we
connected mid-recording (`source: 'predicted'`, badged in the UI), and take the
authoritative path on stop. Never present a prediction as fact. `DESIGN.md` §7.1 records
why prescribing the name via `SetProfileParameter` was rejected.

**Resync publishes one snapshot.** On every (re)connection the store fetches scenes,
profile and record status in parallel and patches once. Patching per-response would let
subscribers observe a half-resynced state and would cost three stream frames instead of
one.

**Reconnection is asymmetric.** An unreachable OBS retries forever with capped, jittered
backoff. A rejected password (close code 4009) is terminal — it cannot fix itself, and
retrying only fills the log.

## Things that will otherwise waste your time

- **`obs-websocket-js` resolves its default Node import to the _msgpack_ build**, not JSON,
  and it aborts the handshake if the server does not echo a matching subprotocol. The mock
  therefore negotiates both. A JSON-only test double fails to connect at all, with the
  unhelpful message `Server sent no subprotocol`.
- **Svelte/Kit options live in `svelte.config.ts`, and `sveltekit()` in `vite.config.ts`
  must stay argument-free.** Passing options to the plugin makes Kit ignore
  `svelte.config.*` entirely (Kit ≥ 2.62), so the adapter would silently disappear and
  the build would emit no `build/` directory. Note the shape differs between the two
  places: in the standalone file the adapter belongs under `kit`, not at the top level.
- **`vitest.config.ts` deliberately does not load the SvelteKit plugin** — everything under
  test is plain TypeScript — so `$lib` is aliased by hand there. Server modules read
  `process.env` directly rather than `$env/*` for the same reason.
- **Tailwind 4 is configured in CSS.** The palette is the `@theme` block in `src/app.css`;
  there is no `tailwind.config.js`.
- **Protocol constants are hand-transcribed** into `src/lib/server/obs/protocol.ts` because
  `obs-websocket-js` exports the op codes but not `RequestStatus` or the close codes. Both
  drive behaviour: status codes become HTTP statuses, close code 4009 makes auth terminal.
- **`runtime()` caches on `globalThis`**, not in a module variable — Vite reloads modules on
  change, and a module singleton would leak a new OBS connection on every edit.
- **`/api/health` returns 200 while OBS is down** by design; it reports whether this process
  is serving, so a container does not restart in a loop because somebody closed OBS.

## Conventions

Tabs, single quotes, 100 columns — enforced by Prettier; run `npm run format` before
committing. Errors are the classes in `src/lib/server/errors.ts`, and one mapper
(`statusForKind`) decides every status code; do not throw `error(404)` from a route.
Every API response uses the `{ok, data}` / `{ok, error}` envelope, and the `requestId` in a
failure also appears in the server log line for it.

Tests live beside the unit they cover (`*.test.ts`) for pure logic, and in `tests/` for
anything that drives the mock over a real socket.
