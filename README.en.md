# Splash Web

Local operations console for **Splash** (config · status · restart). It binds to `127.0.0.1` by default, **never exposes admin over the network**, and has **no general-purpose shell** — only allowlisted Splash CLI flags are surfaced.

License: Apache-2.0 (compatible with [incoai/splash](https://github.com/incoai/splash)).

[中文](README.md) | English

## Open the admin page in 3 steps

```bash
cd /path/to/splash-web
npm install
npm start
```

Then open: **http://127.0.0.1:8000/admin**

> Only one public port, `8000`: the admin UI lives at `/admin`, and Splash's API / chat traffic is reverse-proxied through the same port.
> Splash itself is launched by this tool on an upstream port (default `18000`, config field `upstreamPort`).
> Override with env vars: `SPLASH_WEB_PORT=18080`, `SPLASH_WEB_UPSTREAM_PORT=18001`.

If startup reports the port is in use (common cause: a Splash you started by hand earlier is holding `8000`), stop that process first and let splash-web own `8000` and manage Splash. It will **not** fall back to `8787`.

## Model files: reuse, never re-download

"Select model path" scans and lists:

1. `~/.lmstudio/models` (typical LM Studio download directory)
2. `~/.omlx/models` (oMLX model directory)

You can also type any other **local** path or `OWNER/REPO[:VARIANT]` into the field. The console **never** downloads models and never creates a separate cache directory.

- **Local directory** (picked from the list or starting with `/` or `~`): goes through Splash's `prepare_local_model`, then `python -m server.server <prepared> --model <owner/repo>`, reusing `~/.lmstudio/models` / `~/.omlx/models`.
- **HF `owner/repo`**: still uses `splash serve --model …`.
- **DFlash2**: a switch plus draft selection in the config. When enabled, local prepare passes `draft=` and `splash serve` passes `--draft-model`. When disabled, no draft is forced.

## Sampling parameters (temperature / top_p / top_k)

Splash's `serve` has **no** sampling CLI flags — these values exist only in **each request's JSON body**. splash-web therefore fills in defaults at the reverse-proxy layer:

| Admin field | Request field | Splash native default when omitted | Allowed range |
|---|---|---|---|
| Temperature | `temperature` | `1.0` | `[0, 2]`, 0 = greedy |
| Top-P | `top_p` | `0.95` | `(0, 1]` |
| Top-K | `top_k` | `20` | `-1` / `0` = disabled, or a positive integer |

Rules:

- Only fields the client **did not** send are filled in; explicitly provided values (including `null`) are left untouched.
- Applies only to `/v1/chat/completions`, `/v1/completions`, `/v1/responses`, and `/v1/messages`, and only when `Content-Type` is JSON.
- Bodies over 8 MB are not buffered and are streamed through as-is (vision inputs can be large).
- Changes take effect on the next request — **no Splash restart needed**.
- The `x-splash-web-sampling` response header lists what was filled in, for troubleshooting.
- Turning off "enable injection" disables all intervention and restores Splash's native defaults.

Factory defaults are intentionally identical to Splash's native defaults, so leaving injection on changes nothing out of the box.

Source: Splash 1.4.0 `libexec/server/frontend.py` (`SAMPLING_NUMBERS` / `TOP_K_DEFAULT`).

## What it does

| Capability | Description |
|------------|-------------|
| Config | Model path, public port, `--max-memory` / `--max-context` and other day-to-day options; saving tells you a restart is required |
| Sampling | Temperature / top_p / top_k, filled in by the proxy, no restart |
| Status | Ready, generation speed (tok/s), concurrency/queue at a glance; tells "stalled" apart from "working" |
| Restart | One-click safe restart of the Splash **this tool launched**; failures come with a readable reason |
| Ports | One public port; conflicts explained in plain language |

## Speed metrics (Decode / Prefill tok/s)

The algorithm follows the **time-based sliding window** of [pi-token-speed](https://github.com/gsanhueza/pi-token-speed):

- Sampling: while the admin page is open, `/status` is read once per second, taking the cumulative counters `metrics.decode_output_tokens` / `metrics.prefill_input_tokens`.
- Window: 1000 ms by default; speed = tokens gained in the window × 1000 / actual elapsed span.
- Floor: the span is clamped to at least 100 ms (matching `MIN_SLIDING_WINDOW`) so a burst after a pause cannot inflate the rate.
- Display: the main value is the live window reading from roughly the last second (refreshed every second); a lighter "avg xxx" follows it, computed from the last reset. No other metric shows an average.
- Refresh cadence: the admin page polls `/status` every second and records one sample per second; if the previous poll has not returned, the next one is skipped so a stuck upstream does not pile up requests.
- Average accumulation: upstream `*_tokens` / `*_wall_ms` deltas are summed into `~/.config/splash-web/speed-stats.json`; it survives restarts of splash-web and Splash.
- Manual reset: the "Refresh" button clears the average and restarts accumulation from that moment (automatic polling never resets it).
- Precision: one decimal place (`123.46 → 123.5`).
- Idle: sampling stops 60 seconds after the admin page goes away, so upstream is no longer polled.

So the numbers are **measured throughput over roughly the last second** and will move with load. If you wonder why they move, look at the "active requests / queue" rows first.

## What it will not do

- No chat UI rebuild, no HF downloader, no menu-bar app
- It will not kill a Splash started **externally** (read-only status plus a hint to stop it yourself)
- It will not run arbitrary commands or scripts

## Safe restart and DRY_RUN

- Processes are spawned with `child_process.spawn(..., { shell: false })`; arguments are validated against an allowlist.
- Config file: `~/.config/splash-web/config.json`
- For unattended use, or to avoid loading a large model:

```bash
SPLASH_WEB_DRY_RUN=1 npm start
```

It still listens on the public port and serves `/admin`; "Start/Restart" only renders the allowlisted command and does **not** actually spawn `splash serve`; non-`/admin` proxy requests return an explanation / 503.

## Prerequisites

Splash installed locally (e.g. via Homebrew at `/opt/homebrew/bin/splash`), with `splash serve --help` working in a terminal.

## Development

```bash
npm test
npm run dev
```
