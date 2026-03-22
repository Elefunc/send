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
send peers
send offer ./file.txt
send accept
send tui --events
```

## Rooms

`--room` is optional on all commands. If you omit it, `send` creates a random room and prints or shows it.

## Self Identity

`--self` accepts three forms:

- `name`
- `name-ID`
- `-ID` using the attached CLI form `--self=-ab12cd34`

`SEND_SELF` supports the same raw values, including `SEND_SELF=-ab12cd34`.

The ID suffix must be exactly 8 lowercase alphanumeric characters.

## Examples

```bash
send peers --self alice
send offer ./demo.txt --self alice-ab12cd34
send accept --self=-ab12cd34
SEND_SELF=-ab12cd34 send tui
```

## Development

```bash
bun install
bun run typecheck
bun test
```

The package is Bun-native and keeps its runtime patches in `patches/`.
