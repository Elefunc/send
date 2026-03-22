#!/usr/bin/env bun
import { resolve } from "node:path"
import { cac, type CAC } from "cac"
import { cleanRoom } from "./core/protocol"
import { SendSession, type SessionConfig, type SessionEvent } from "./core/session"
import { resolvePeerTargets } from "./core/targeting"
import { ensureReziInputCaretPatch } from "./tui/rezi-input-caret"

export class ExitError extends Error {
  constructor(message: string, readonly code = 1) {
    super(message)
  }
}

const WAIT_POLL_MS = 125

const toArray = (value: unknown): string[] => value == null ? [] : Array.isArray(value) ? value.flatMap(item => toArray(item)) : [`${value}`]
const splitList = (value: unknown) => toArray(value).flatMap((item: string) => item.split(",")).map((item: string) => item.trim()).filter(Boolean)
const firstNonEmptyText = (...values: unknown[]) => {
  for (const value of values) {
    const text = `${value ?? ""}`.trim()
    if (text) return text
  }
  return undefined
}
const numberOption = (value: unknown, fallback: number) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}
const offerSelectors = (value: unknown) => {
  const selectors = splitList(value)
  return selectors.length ? selectors : ["."]
}
const waitPeerTimeout = (value: unknown) => {
  if (value == null) return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) throw new ExitError("--wait-peer must be a finite non-negative number of milliseconds", 1)
  return parsed
}

const SELF_ID_LENGTH = 8
const SELF_ID_PATTERN = new RegExp(`^[a-z0-9]{${SELF_ID_LENGTH}}$`)
const SELF_HELP_TEXT = "self identity: name, name-ID, or -ID (use --self=-ID)"
const INVALID_SELF_ID_MESSAGE = `--self ID suffix must be exactly ${SELF_ID_LENGTH} lowercase alphanumeric characters`

const requireSelfId = (value: string) => {
  if (!SELF_ID_PATTERN.test(value)) throw new ExitError(INVALID_SELF_ID_MESSAGE, 1)
  return value
}

const parseSelfOption = (value: unknown): Pick<SessionConfig, "name" | "localId"> => {
  const self = `${value ?? ""}`.trim()
  if (!self) return {}
  if (self.startsWith("-")) return { localId: requireSelfId(self.slice(1)) }
  const lastHyphen = self.lastIndexOf("-")
  if (lastHyphen < 0) return { name: self }
  const name = self.slice(0, lastHyphen)
  return { name, localId: requireSelfId(self.slice(lastHyphen + 1)) }
}

export const sessionConfigFrom = (options: Record<string, unknown>, defaults: { autoAcceptIncoming?: boolean; autoSaveIncoming?: boolean }): SessionConfig & { room: string } => {
  const room = cleanRoom(firstNonEmptyText(options.room, process.env.SEND_ROOM))
  const self = parseSelfOption(options.self ?? process.env.SEND_SELF)
  return {
    room,
    ...self,
    saveDir: resolve(`${options.saveDir ?? process.env.SEND_SAVE_DIR ?? "downloads"}`),
    autoAcceptIncoming: defaults.autoAcceptIncoming ?? false,
    autoSaveIncoming: defaults.autoSaveIncoming ?? false,
    turnUrls: splitList(options.turnUrl ?? process.env.SEND_TURN_URL),
    turnUsername: `${options.turnUsername ?? process.env.SEND_TURN_USERNAME ?? ""}`.trim() || undefined,
    turnCredential: `${options.turnCredential ?? process.env.SEND_TURN_CREDENTIAL ?? ""}`.trim() || undefined,
  }
}

export const roomAnnouncement = (room: string, json = false) => json ? JSON.stringify({ type: "room", room }) : `room ${room}`

const printRoomAnnouncement = (room: string, json = false) => console.log(roomAnnouncement(room, json))

const printEvent = (event: SessionEvent) => console.log(JSON.stringify(event))

const attachReporter = (session: SendSession, json = false) => {
  if (json) return session.onEvent(printEvent)
  const seen = new Map<string, string>()
  return session.onEvent(event => {
    if (event.type === "saved") {
      console.log(`saved ${event.transfer.name} -> ${event.transfer.savedPath}`)
      return
    }
    if (event.type !== "transfer") return
    const previous = seen.get(event.transfer.id)
    if (previous === event.transfer.status) return
    seen.set(event.transfer.id, event.transfer.status)
    if (!["offered", "accepted", "sending", "receiving", "complete", "rejected", "cancelled", "error"].includes(event.transfer.status)) return
    const peer = event.transfer.peerName || event.transfer.peerId
    console.log(`${event.transfer.direction === "out" ? "send" : "recv"} ${event.transfer.status} ${event.transfer.name} ${peer}`)
  })
}

const waitForTargets = async (session: SendSession, selectors: string[], timeoutMs?: number) => {
  const startedAt = Date.now()
  let lastError = "no ready peers"
  for (;;) {
    const snapshot = session.snapshot()
    const result = resolvePeerTargets(snapshot.peers.map(peer => ({ id: peer.id, name: peer.name, ready: peer.ready, presence: peer.presence })), selectors)
    if (result.ok) return result.peers
    lastError = result.error ?? lastError
    if (timeoutMs === 0 || timeoutMs != null && Date.now() - startedAt >= timeoutMs) break
    await Bun.sleep(WAIT_POLL_MS)
  }
  throw new ExitError(lastError, 2)
}

const waitForFinalTransfers = async (session: SendSession, transferIds: string[]) => {
  for (;;) {
    const done = transferIds.every(transferId => {
      const transfer = session.getTransfer(transferId)
      return !!transfer && ["complete", "rejected", "cancelled", "error"].includes(transfer.status)
    })
    if (done) return transferIds.map(transferId => session.getTransfer(transferId)).filter(Boolean)
    await Bun.sleep(125)
  }
}

const handleSignals = (session: SendSession) => {
  const onSignal = async () => {
    await session.close()
    process.exit(130)
  }
  process.once("SIGINT", () => void onSignal())
  process.once("SIGTERM", () => void onSignal())
}

const peersCommand = async (options: Record<string, unknown>) => {
  const session = new SendSession(sessionConfigFrom(options, {}))
  handleSignals(session)
  printRoomAnnouncement(session.room, !!options.json)
  await session.connect()
  await Bun.sleep(numberOption(options.wait, 3000))
  const snapshot = session.snapshot()
  if (options.json) {
    console.log(JSON.stringify({
      room: snapshot.room,
      localId: snapshot.localId,
      name: snapshot.name,
      socketState: snapshot.socketState,
      peers: snapshot.peers,
    }))
  } else if (!snapshot.peers.length) {
    console.log(`no peers in ${snapshot.room}`)
  } else {
    for (const peer of snapshot.peers) console.log(`${peer.ready ? "*" : "-"} ${peer.displayName} ${peer.status}`)
  }
  await session.close()
}

const offerCommand = async (files: string[], options: Record<string, unknown>) => {
  if (!files.length) throw new ExitError("offer requires at least one file path", 1)
  const selectors = offerSelectors(options.to)
  const timeoutMs = waitPeerTimeout(options.waitPeer)
  const session = new SendSession(sessionConfigFrom(options, {}))
  handleSignals(session)
  printRoomAnnouncement(session.room, !!options.json)
  const detachReporter = attachReporter(session, !!options.json)
  await session.connect()
  const targets = await waitForTargets(session, selectors, timeoutMs)
  const transferIds = await session.queueFiles(files, targets.map(peer => peer.id))
  const results = await waitForFinalTransfers(session, transferIds)
  detachReporter()
  await session.close()
  const failed = results.filter(transfer => transfer && ["rejected", "cancelled", "error"].includes(transfer.status))
  if (failed.length) throw new ExitError(failed.map(transfer => `${transfer?.name}:${transfer?.status}`).join(", "), 3)
}

const acceptCommand = async (options: Record<string, unknown>) => {
  const session = new SendSession(sessionConfigFrom(options, { autoAcceptIncoming: true, autoSaveIncoming: true }))
  handleSignals(session)
  printRoomAnnouncement(session.room, !!options.json)
  const detachReporter = attachReporter(session, !!options.json)
  await session.connect()
  if (!options.json) console.log(`listening in ${session.room}`)
  if (options.once) {
    for (;;) {
      const saved = session.snapshot().transfers.find(transfer => transfer.direction === "in" && transfer.savedAt > 0)
      if (saved) break
      await Bun.sleep(125)
    }
    detachReporter()
    await session.close()
    return
  }
  await new Promise(() => {})
}

const tuiCommand = async (options: Record<string, unknown>) => {
  const initialConfig = sessionConfigFrom(options, { autoAcceptIncoming: true, autoSaveIncoming: true })
  await ensureReziInputCaretPatch()
  const { startTui } = await import("./tui/app")
  await startTui(initialConfig, !!options.events)
}

type CliHandlers = {
  peers: typeof peersCommand
  offer: typeof offerCommand
  accept: typeof acceptCommand
  tui: typeof tuiCommand
}

const defaultCliHandlers: CliHandlers = {
  peers: peersCommand,
  offer: offerCommand,
  accept: acceptCommand,
  tui: tuiCommand,
}

export const createCli = (handlers: CliHandlers = defaultCliHandlers) => {
  const cli = cac("send")
  cli.usage("[command] [options]")

  cli
    .command("peers", "list discovered peers")
    .option("--room <room>", "room id; omit to create a random room")
    .option("--self <self>", SELF_HELP_TEXT)
    .option("--wait <ms>", "discovery wait in milliseconds")
    .option("--json", "print a json snapshot")
    .option("--save-dir <dir>", "save directory")
    .option("--turn-url <url>", "custom TURN url, repeat or comma-separate")
    .option("--turn-username <value>", "custom TURN username")
    .option("--turn-credential <value>", "custom TURN credential")
    .action(handlers.peers)

  cli
    .command("offer [...files]", "offer files to browser-compatible peers")
    .option("--room <room>", "room id; omit to create a random room")
    .option("--self <self>", SELF_HELP_TEXT)
    .option("--to <peer>", "target peer id or name-suffix, or `.` for all ready peers; default: `.`")
    .option("--wait-peer <ms>", "wait for eligible peers in milliseconds; omit to wait indefinitely")
    .option("--json", "emit ndjson events")
    .option("--save-dir <dir>", "save directory")
    .option("--turn-url <url>", "custom TURN url, repeat or comma-separate")
    .option("--turn-username <value>", "custom TURN username")
    .option("--turn-credential <value>", "custom TURN credential")
    .action(handlers.offer)

  cli
    .command("accept", "receive and save files")
    .option("--room <room>", "room id; omit to create a random room")
    .option("--self <self>", SELF_HELP_TEXT)
    .option("--save-dir <dir>", "save directory")
    .option("--once", "exit after the first saved incoming transfer")
    .option("--json", "emit ndjson events")
    .option("--turn-url <url>", "custom TURN url, repeat or comma-separate")
    .option("--turn-username <value>", "custom TURN username")
    .option("--turn-credential <value>", "custom TURN credential")
    .action(handlers.accept)

  cli
    .command("tui", "launch the interactive terminal UI")
    .option("--room <room>", "room id; omit to create a random room")
    .option("--self <self>", SELF_HELP_TEXT)
    .option("--events", "show the event log pane")
    .option("--save-dir <dir>", "save directory")
    .option("--turn-url <url>", "custom TURN url, repeat or comma-separate")
    .option("--turn-username <value>", "custom TURN username")
    .option("--turn-credential <value>", "custom TURN credential")
    .action(handlers.tui)

  cli.help(sections => {
    const usage = sections.find(section => section.title === "Usage:")
    if (usage) usage.body = "  $ send [command] [options]"
    const moreInfoIndex = sections.findIndex(section => section.title?.startsWith("For more info"))
    const defaultSection = {
      title: "Default",
      body: "  send with no command launches the terminal UI (same as `send tui`).",
    }
    if (moreInfoIndex < 0) sections.push(defaultSection)
    else sections.splice(moreInfoIndex, 0, defaultSection)
  })

  return cli
}

const explicitCommand = (cli: CAC, argv: string[]) => {
  const command = argv[2]
  if (!command || command.startsWith("-")) return undefined
  if (cli.commands.some(entry => entry.isMatched(command))) return command
  throw new ExitError(`Unknown command \`${command}\``, 1)
}

export const runCli = async (argv = process.argv, handlers: CliHandlers = defaultCliHandlers) => {
  const cli = createCli(handlers)
  const command = explicitCommand(cli, argv)
  const parsed = cli.parse(argv, { run: false }) as { options: Record<string, unknown> }
  const helpRequested = !!parsed.options.help || !!parsed.options.h
  if (!command && !helpRequested) {
    await handlers.tui(parsed.options)
    return
  }
  await cli.runMatchedCommand()
}

const main = async () => {
  try {
    await runCli()
  } catch (error) {
    if (error instanceof ExitError) {
      console.error(error.message)
      process.exit(error.code)
    }
    console.error(error instanceof Error ? error.message : `${error}`)
    process.exit(1)
  }
}

if ((import.meta as ImportMeta & { main?: boolean }).main) void main()
