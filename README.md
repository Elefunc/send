# @elefunc/send

Browser-compatible file transfer CLI and TUI built with Bun, WebRTC, and Rezi.

## Requirements

- Bun `>= 1.3.11`

## Install

```bash
bun add -g @elefunc/send
```

## Usage

```bash
send
send peers
send offer ./file.txt
send accept
send tui
```

When no subcommand is provided, `send` launches the TUI by default.

## Rooms

`--room` is optional on all commands. If you omit it, `send` creates a random room and prints or shows it.

In the TUI, the room row includes a `📋` invite link that opens the equivalent web app URL for the current committed room and toggle state.

## Command Scope

Not every command has a flag-for-flag TUI dual. CLI automation stays command-specific:

- `peers`: `--wait`, `--json`
- `offer`: `--to`, `--wait-peer`, `--json`
- `accept`: `--from`, `--N`, `--json`

Save-path controls only matter where incoming files are written, so `--folder` and `--overwrite` are relevant on `accept` and `tui`.

## Self Identity

`--self` accepts three forms:

- `name`
- `name-id`
- `-id` using the attached CLI form `--self=-ab12cd34`

`SEND_SELF` supports the same raw values, including `SEND_SELF=-ab12cd34`.

The `id` suffix must be exactly 8 lowercase alphanumeric characters.

## Examples

```bash
send peers --self alice
send offer ./demo.txt --self alice-ab12cd34
send accept --self=-ab12cd34
send accept --from alice --N 1
SEND_SELF=-ab12cd34 send tui
```

## Development

```bash
bun install
bun run typecheck
bun test
```

The package is Bun-native and keeps its runtime patches in `runtime/`.
