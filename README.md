# OBS Control

A web control surface for [OBS Studio](https://obsproject.com/): start and stop
recordings, switch scenes, and watch the recording's timecode and filename update live.

Built with SvelteKit (Svelte 5 runes), TypeScript and Tailwind 4, talking to OBS over
[obs-websocket](https://github.com/obsproject/obs-websocket) v5.

---

## Run it in one minute, without OBS

The repository ships a mock obs-websocket server, so you can see the whole thing working
before installing anything:

```bash
npm install
npm run mock      # terminal 1 — a fake OBS on ws://127.0.0.1:4455
npm run dev       # terminal 2 — the app on http://localhost:5173
```

The mock takes typed commands, which is the easiest way to see the live updates. In the
mock's terminal:

```
record start          # the UI starts counting and shows the filename
scene add Interview   # the new scene appears in the browser, unprompted
studio on             # the UI switches to preview/program with a Take button
drop 2000             # lose two seconds of media time, as an overloaded encoder would
kill                  # drop the connection; the app reconnects on its own
help                  # everything else
```

## Run it against real OBS

1. In OBS: **Tools → WebSocket Server Settings → Enable WebSocket server**. Note the port
   (4455 by default) and, if you tick _Enable Authentication_, the password.
2. Point the app at it:

```bash
cp .env.example .env      # then edit OBS_URL / OBS_PASSWORD
npm install
npm run dev
```

For a production build:

```bash
npm run build
node build                # honours HOST and PORT
```

## Docker

```bash
docker compose up                    # against OBS on your machine
docker compose --profile mock up     # against the bundled mock, nothing else needed
```

Then open <http://localhost:3000>.

**Reaching OBS from inside a container** is the step that usually catches people out. The
container's own `localhost` is not your machine's:

| Host OS        | Setting                                                                                                                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS, Windows | `OBS_URL=ws://host.docker.internal:4455` (the default)                                                                                                                                       |
| Linux          | the same, and the compose file already maps `host.docker.internal` to the host gateway. With plain `docker run`, add `--add-host=host.docker.internal:host-gateway` or use `--network host`. |

OBS also has to be listening on an interface the container can reach, not only loopback.

## Configuration

All settings are environment variables, validated at startup — a bad value fails
immediately with a message rather than at the first request.

| Variable                   | Default               | Meaning                                                                                    |
| -------------------------- | --------------------- | ------------------------------------------------------------------------------------------ |
| `OBS_URL`                  | `ws://127.0.0.1:4455` | obs-websocket address. A bare `host:port` is accepted.                                     |
| `OBS_PASSWORD`             | _(empty)_             | Leave empty if OBS authentication is off.                                                  |
| `APP_TOKEN`                | _(empty)_             | Password for **this app**. Empty means no authentication (see below).                      |
| `OBS_POLL_INTERVAL_MS`     | `1000`                | Recording heartbeat. `0` disables it and extrapolates the timecode in the browser instead. |
| `OBS_RECONNECT_INITIAL_MS` | `500`                 | Initial reconnect backoff.                                                                 |
| `OBS_RECONNECT_MAX_MS`     | `15000`               | Maximum reconnect backoff.                                                                 |
| `LOG_LEVEL`                | `info`                | `trace` … `fatal`, or `silent`.                                                            |
| `HOST` / `PORT`            | `127.0.0.1` / `3000`  | Where the production server listens.                                                       |

## Security

**With `APP_TOKEN` unset, the API is unauthenticated**: anyone who can reach the port can
stop your recording. The app logs a warning at startup saying so. Set `APP_TOKEN` and the
UI asks for it before showing anything.

The token is exchanged for an httpOnly session cookie rather than being sent on each
request, because `EventSource` cannot set request headers and so a bearer scheme could not
authenticate the live stream at all. Comparison is constant-time, and the cookie holds an
opaque session id, never the secret itself.

This is a single shared password with no user model, rotation or rate limiting —
appropriate for a control surface on a trusted network, not for the public internet.

## How it works

```
Browser ── POST /api/…  (commands) ──▶ SvelteKit server ──▶ OBS
        ◀─ GET /api/state/stream ────  (one websocket, obs-websocket v5)
           (server-sent events)
```

The server owns a single websocket to OBS. Several browser tabs are views onto one piece
of hardware, not independent clients, and the OBS password never leaves the server.

**OBS is the single source of truth.** Pressing _Start recording_ issues the command and
returns; the display only changes when OBS reports the change over the state stream. This
is why the UI stays correct when somebody presses Record in OBS itself, and it removes the
whole class of optimistic-update bugs.

The layering is strict: HTTP routes never import the OBS client, the service layer knows
nothing about HTTP, and only the store knows the state shape. `DESIGN.md` has the full
reasoning, including the protocol constraints that shaped it.

### Two things worth knowing

**The recording filename is not simply available.** obs-websocket has no request that
returns the path of a recording in progress, and `StartRecord` takes no filename argument.
The path is announced once, in the event fired when recording starts. So:

- Normally the app shows the path OBS itself reported, badged **from OBS**.
- If the app connects to a recording that was _already running_, that event is long gone.
  The app then reconstructs a filename from the record directory and the profile's
  filename template, and badges it **predicted** — it may differ from the real file.
- When the recording stops, OBS returns the true path, and that is always authoritative.

**The timecode is sampled, not merely counted.** OBS emits no timecode event, so the
server samples `GetRecordStatus` once a second over the already-open websocket, and the
browser interpolates between samples for a smooth display. Counting locally would not do:
OBS derives a recording's duration from frame count, so under encoder overload or a disk
stall the recording falls behind wall clock. Re-syncing every second keeps the display
honest. The sampling loop only runs while a recording is active _and_ someone is watching,
so an idle server makes no requests at all.

## API

Every response uses one envelope: `{ok: true, data}` or
`{ok: false, error: {code, message, requestId}}`. The `requestId` also appears in the
server log line for that failure.

| Method            | Path                               | Notes                                            |
| ----------------- | ---------------------------------- | ------------------------------------------------ |
| `GET`             | `/api/state`                       | Current snapshot                                 |
| `GET`             | `/api/state/stream`                | Server-sent events: `state` and `tick`           |
| `POST`            | `/api/recording/start`             | 409 if already recording                         |
| `POST`            | `/api/recording/stop`              | Returns the saved path                           |
| `POST`            | `/api/recording/pause` · `/resume` | 409 if the state does not allow it               |
| `POST`            | `/api/scenes/current`              | `{"name": "..."}`; 404 if unknown                |
| `POST`            | `/api/scenes/preview`              | Studio mode only, 409 otherwise                  |
| `POST`            | `/api/transition`                  | Takes preview to air; studio mode only           |
| `POST` · `DELETE` | `/api/session`                     | Sign in and out                                  |
| `GET`             | `/api/health`                      | Container healthcheck; 200 even when OBS is down |

## Development

```bash
npm run dev            # dev server
npm run mock           # mock OBS, with interactive commands
npm test               # unit and integration tests
npm run check          # svelte-check and TypeScript
npm run format         # prettier
```

Tests run against the mock over a real websocket, so the client, store and service are
exercised end to end — including reconnection, a rejected password, a recording that was
already running, and a mid-recording file split. No OBS installation is needed.

## Known limitations

- A recording already in progress when the app connects can only show a **predicted**
  filename. This is a protocol limitation, not an implementation gap.
- Predicted names expand the filename template using this server's clock and timezone,
  which need not match the machine running OBS.
- `APP_TOKEN` is a single static secret with no rotation or rate limiting.
- Sessions are held in memory, so restarting the server signs everyone out.
- Scene switching acts on OBS's current profile and scene collection; changing either in
  OBS re-syncs the app, but is not otherwise modelled.
