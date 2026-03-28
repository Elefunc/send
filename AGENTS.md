# `@elefunc/send` CLI Package

## Quick Start

Use the published package directly with `bunx`:

```bash
bunx @elefunc/send@latest
bunx @elefunc/send@latest peers
bunx @elefunc/send@latest offer ./file.txt
bunx @elefunc/send@latest accept
bunx @elefunc/send@latest tui
```

Compile a standalone binary from this package:

```bash
bun install --no-save
bun run build:standalone -- --outfile /tmp/send
/tmp/send --help
```

Compile for a specific Bun target:

```bash
bun run build:standalone -- --outfile /tmp/send --target bun-linux-x64
```

Compile all supported Bun standalone targets into `out/`:

```bash
bun run build:standalone_all
ls out/
```

The compiled binary does not run the app directly from Bun's bundled module graph. It embeds a production runtime tree, extracts it under temp on first launch, and then re-execs the real CLI through `BUN_BE_BUN=1` so runtime behavior matches the normal installed package path.

## What This Package Is

- Package name: `@elefunc/send`
- Runtime requirement: Bun `>= 1.3.11`
- Entry point: `src/index.ts`
- Default behavior: running `send` with no subcommand launches the TUI
- Main dependencies:
  - `cac` for CLI argument parsing
  - `werift` for WebRTC data channels and peer connections
  - `@rezi-ui/core` and `@rezi-ui/node` for the terminal UI

This package is Bun-native. It is not a generic Node CLI.

## Commands

### `send`

No subcommand launches the TUI:

```bash
bunx @elefunc/send@latest
bunx @elefunc/send@latest tui
```

### `send peers`

Lists discovered peers after a configurable wait:

```bash
bunx @elefunc/send@latest peers
bunx @elefunc/send@latest peers --wait 5000 --json
```

Important flags:

- `--room <room>`
- `--self <self>`
- `--wait <ms>`
- `--json`
- `--save-dir <dir>`
- `--turn-url <url>`
- `--turn-username <value>`
- `--turn-credential <value>`

### `send offer [...files]`

Offers one or more local files to eligible peers:

```bash
bunx @elefunc/send@latest offer ./file.txt
bunx @elefunc/send@latest offer ./a.txt ./b.txt --to alice
bunx @elefunc/send@latest offer ./file.txt --wait-peer 10000 --json
```

Important flags:

- `--room <room>`
- `--self <self>`
- `--to <peer>`
- `--wait-peer <ms>`
- `--json`
- `--save-dir <dir>`
- TURN flags

### `send accept`

Waits for incoming transfers and saves them:

```bash
bunx @elefunc/send@latest accept
bunx @elefunc/send@latest accept --save-dir ./downloads
bunx @elefunc/send@latest accept --once --overwrite
```

Important flags:

- `--room <room>`
- `--self <self>`
- `--save-dir <dir>`
- `-o, --overwrite`
- `--once`
- `--json`
- TURN flags

### `send tui`

Launches the Rezi-based terminal UI explicitly:

```bash
bunx @elefunc/send@latest tui
bunx @elefunc/send@latest tui --events
bunx @elefunc/send@latest tui --accept 0 --offer 0 --save 1
```

Important flags:

- `--room <room>`
- `--self <self>`
- `--clean <0|1>`
- `--accept <0|1>`
- `--offer <0|1>`
- `--save <0|1>`
- `--events`
- `--save-dir <dir>`
- `-o, --overwrite`
- TURN flags

TUI overwrite can also be toggled live with `Ctrl+O`.

## Identity, Rooms, and Invites

### Rooms

- `--room` is optional everywhere
- when omitted, a random room is created
- `cleanRoom()` normalizes room ids to lowercase safe text and falls back to a random 8-character id

### Self Identity

`--self` accepts exactly these forms:

- `name`
- `name-id`
- `-id`

Examples:

```bash
bunx @elefunc/send@latest peers --self alice
bunx @elefunc/send@latest offer ./demo.txt --self alice-ab12cd34
bunx @elefunc/send@latest accept --self=-ab12cd34
```

The `id` suffix must be exactly 8 lowercase alphanumeric characters.

### Invites

Invite generation is centralized in `src/core/invite.ts`.

- default web base: `https://rtme.sh/`
- copy helper base: `https://copy.rt.ht/`
- CLI invite text is rendered as `bunx <host> --room ...`
- web invite hashes include room and toggle state
- overwrite is represented in both CLI and web invite output

The TUI uses the same invite helpers for its dropdown, copy actions, and exit/rejoin text.

## Environment Variables

Supported package-level environment variables:

- `SEND_ROOM`
  - fallback room when `--room` is omitted
- `SEND_SELF`
  - fallback self identity when `--self` is omitted
- `SEND_SAVE_DIR`
  - fallback save directory
- `SEND_WEB_URL`
  - override the web invite base URL
- `SEND_TURN_URL`
  - repeatable/comma-separated TURN URL input
- `SEND_TURN_USERNAME`
  - TURN username
- `SEND_TURN_CREDENTIAL`
  - TURN credential
- `SEND_NAME`
  - CLI help display name override
- `SEND_NAME_COLORED`
  - TTY-colored CLI help display name override

Important distinction: `SEND_NAME` is not the peer identity. Identity is controlled by `--self` / `SEND_SELF`.

## Package Layout

### `src/core`

Core session and protocol logic:

- `files.ts`
  - local file IO, unique naming, overwrite behavior, streamed incoming save handling
- `invite.ts`
  - room/web/CLI invite rendering and toggle serialization
- `paths.ts`
  - path utilities
- `protocol.ts`
  - signaling/data message types, defaults, profile helpers, room/name/id cleanup
- `session.ts`
  - `SendSession`, peer lifecycle, WebRTC, transfers, auto-accept/save, overwrite mode
- `targeting.ts`
  - peer selector resolution for `offer --to`

### `src/tui`

Rezi terminal UI:

- `app.ts`
  - TUI state, actions, layout, footer hints, invite dropdown, live session toggles
- `file-search.ts`
  - workspace file search logic
- `file-search.worker.ts`
  - TUI worker for file preview/search support
- `input-editor.ts`
  - TUI input editing helpers
- `file-search-protocol.ts`
  - worker message types

### `runtime`

Runtime patch layer for Rezi:

- `install.ts`
  - entrypoint for runtime patch installation
- `rezi-files.ts`
  - installed-layout `@rezi-ui/core` file patches
- `rezi-input-caret.ts`
  - Rezi input width/caret verification patch
- `rezi-checkbox-click.ts`
  - checkbox mouse click behavior patch

### `scripts`

Standalone binary support:

- `build-standalone.ts`
  - stages a production install, archives the runtime, and compiles the launcher
- `build-standalone-all.ts`
  - builds the full Bun target matrix into `out/` using `send-<os>-<arch>[-<variant>]` filenames
- `standalone-lib.ts`
  - runtime archive format, extraction, temp cache, and re-exec helpers

### `test`

High-value package tests include:

- `cli.test.ts`
- `session.test.ts`
- `tui.test.ts`
- `runtime-patches.test.ts`
- `rezi-checkbox-click.test.ts`
- `packaging.test.ts`
- `standalone-build.test.ts`

## Architecture Notes

### Signaling and Transport

- websocket signaling endpoint: `wss://sig.efn.kr/ws`
- pulse endpoint: `https://sig.efn.kr/pulse?app=send`
- base ICE servers include Cloudflare and Google STUN
- file transfer runs over WebRTC data channels using Werift

### `SendSession`

`src/core/session.ts` is the package runtime center.

It owns:

- socket state and reconnection
- peer lifecycle and peer snapshots
- WebRTC offer/answer/candidate handling
- outgoing queueing
- incoming transfer state
- streamed disk saves
- auto-accept / auto-save toggles
- overwrite mode
- event emission for CLI JSON output and TUI state updates

### TUI

`src/tui/app.ts` wraps `SendSession` and exposes:

- peer filtering and selection
- draft file queueing
- invite dropdowns
- live toggle controls for accept/save/overwrite
- event log pane
- file preview/search worker
- `Ctrl+O` overwrite toggle

## Runtime Patch Behavior

The package intentionally patches installed `@rezi-ui/core` files at runtime.

Current behavior:

- `ensureSessionRuntimePatches()` is effectively a no-op
- `ensureTuiRuntimePatches()` applies the Rezi file patches before the TUI runtime is imported
- checkbox click behavior is patched separately by `installCheckboxClickPatch()`

These patches exist because this package relies on behavior that upstream Rezi does not currently provide directly.

Important packaging constraint:

- shipped source must not import repo-local `node_modules` paths directly
- `test/packaging.test.ts` enforces this
- `test/runtime-patches.test.ts` verifies the installed-layout patch expectations

## Standalone Binary Notes

Standalone binaries are built by `scripts/build-standalone.ts`.

The current standalone design is:

1. create a fresh temp staging directory
2. copy the shipped runtime tree:
   - `src/`
   - `runtime/`
   - `package.json`
   - `tsconfig.json`
   - `README.md`
   - `LICENSE`
3. run `bun install --production` in the staging directory
4. archive the staged runtime plus production `node_modules`
5. compile a small bootstrap executable
6. on first run, extract the runtime under temp
7. re-exec the real CLI with `BUN_BE_BUN=1`

Why it works this way:

- direct `bun build --compile` of the app hit `$bunfs` module resolution and worker-entry issues
- this launcher design preserves the same installed-package/runtime-patch behavior as `bunx`
- it avoids maintaining a compile-only code path

Operational implications:

- first launch extracts a cached runtime under temp
- later launches reuse the cached extracted tree for the same version/hash
- binaries are large because they embed a production runtime tree

## Development and Validation

Setup:

```bash
bun install --no-save
```

Core checks:

```bash
bun run typecheck
bun test
```

Focused packaging checks:

```bash
bun test ./test/runtime-patches.test.ts
bun test ./test/packaging.test.ts
bun test ./test/standalone-build.test.ts
```

Standalone smoke test:

```bash
bun run build:standalone -- --outfile /tmp/send
/tmp/send --help
/tmp/send peers --wait 0 --json
```

Published-package smoke test pattern:

```bash
bun pm pack
# install the resulting tgz into a fresh temp project
# then run:
bun x send peers --wait 0 --json
```

## Important Constraints

- Bun-only package; do not treat it as a Node-first CLI
- runtime patching assumes an installed package layout exists
- TUI behavior depends on Rezi patches being applied before TUI runtime import
- standalone binaries intentionally preserve the installed-runtime path rather than bypassing it
- invite rendering, room normalization, and self parsing are shared across CLI and TUI; do not fork those rules casually
