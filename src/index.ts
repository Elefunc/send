#!/usr/bin/env bun
import { resolve } from "node:path"
import { cac, type CAC } from "cac"
import { joinOutputLines, type JoinOutputKind } from "./core/invite"
import { cleanRoom, displayPeerName } from "./core/protocol"
import type { SendSession, SessionConfig, SessionEvent } from "./core/session"
import { resolvePeerTargets } from "./core/targeting"
import { ensureSessionRuntimePatches, ensureTuiRuntimePatches } from "../runtime/install"

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
const BINARY_OPTION_FLAGS = {
  clean: "--clean",
  accept: "--accept",
  offer: "--offer",
  save: "--save",
} as const
type BinaryOptionKey = keyof typeof BINARY_OPTION_FLAGS
const binaryOption = (value: unknown, flag: string) => {
  if (value == null) return undefined
  if (value === 1 || value === "1") return true
  if (value === 0 || value === "0") return false
  throw new ExitError(`${flag} must be 0 or 1`, 1)
}
const parseBinaryOptions = <K extends BinaryOptionKey>(options: Record<string, unknown>, keys: readonly K[]) =>
  Object.fromEntries(keys.map(key => [key, binaryOption(options[key], BINARY_OPTION_FLAGS[key])])) as Record<K, boolean | undefined>

const SELF_ID_LENGTH = 8
const SELF_ID_PATTERN = new RegExp(`^[a-z0-9]{${SELF_ID_LENGTH}}$`)
const SELF_HELP_TEXT = "self identity: `name`, `name-id`, or `-id`"
const INVALID_SELF_ID_MESSAGE = `--self id suffix must be exactly ${SELF_ID_LENGTH} lowercase alphanumeric characters`
type CliCommand = ReturnType<CAC["command"]>
const ROOM_SELF_OPTIONS = [
  ["--room <room>", "room id", { default: "<random>" }],
  ["--self <self>", SELF_HELP_TEXT],
] as const
const TURN_OPTIONS = [
  ["--turn-url <url>", "custom TURN url, repeat or comma-separate"],
  ["--turn-username <value>", "custom TURN username"],
  ["--turn-credential <value>", "custom TURN credential"],
] as const
const OVERWRITE_OPTION = ["-o, --overwrite", "overwrite same-name saved files instead of creating copies"] as const
const SAVE_DIR_OPTION = ["--save-dir <dir>", "save directory", { default: "." }] as const
const TUI_TOGGLE_OPTIONS = [
  ["--clean <0|1>", "show only active peers when 1; show terminal peers too when 0", { default: 1 }],
  ["--accept <0|1>", "auto-accept incoming offers: 1 on, 0 off", { default: 1 }],
  ["--offer <0|1>", "auto-offer drafts to matching ready peers: 1 on, 0 off", { default: 1 }],
  ["--save <0|1>", "auto-save completed incoming files: 1 on, 0 off", { default: 1 }],
] as const
export const ACCEPT_SESSION_DEFAULTS = { autoAcceptIncoming: true, autoSaveIncoming: true } as const
type CliOptionDefinition = readonly [flag: string, description: string, config?: { default?: unknown }]
const addOptions = (command: CliCommand, definitions: readonly CliOptionDefinition[]) =>
  definitions.reduce((next, [flag, description, config]) => next.option(flag, description, config), command)
const normalizeCliOptions = (options: Record<string, unknown>) => {
  const normalized = { ...options }
  if (normalized.overwrite == null && normalized.o != null) normalized.overwrite = normalized.o
  delete normalized.h
  delete normalized.o
  return normalized
}
const withTrailingHelpLine = <T extends { outputHelp: () => void }>(target: T) => {
  const outputHelp = target.outputHelp.bind(target)
  target.outputHelp = () => {
    outputHelp()
    console.info("")
  }
  return target
}

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
  const { accept, save } = parseBinaryOptions(options, ["accept", "save"] as const)
  return {
    room,
    ...self,
    saveDir: resolve(`${options.saveDir ?? process.env.SEND_SAVE_DIR ?? "."}`),
    autoAcceptIncoming: accept ?? defaults.autoAcceptIncoming ?? false,
    autoSaveIncoming: save ?? defaults.autoSaveIncoming ?? false,
    overwriteIncoming: !!options.overwrite,
    turnUrls: splitList(options.turnUrl ?? process.env.SEND_TURN_URL),
    turnUsername: `${options.turnUsername ?? process.env.SEND_TURN_USERNAME ?? ""}`.trim() || undefined,
    turnCredential: `${options.turnCredential ?? process.env.SEND_TURN_CREDENTIAL ?? ""}`.trim() || undefined,
  }
}

export const roomAnnouncement = (room: string, self: string, json = false) =>
  json ? JSON.stringify({ type: "room", room, self }) : `room ${room}\nself ${self}`

const printRoomAnnouncement = (room: string, self: string, json = false) => console.log(roomAnnouncement(room, self, json))

export const commandAnnouncement = (kind: JoinOutputKind, room: string, self: string, json = false) =>
  json ? roomAnnouncement(room, self, true) : [roomAnnouncement(room, self), "", ...joinOutputLines(kind, room)].join("\n")

const printCommandAnnouncement = (kind: JoinOutputKind, room: string, self: string, json = false) => console.log(commandAnnouncement(kind, room, self, json))
export const readyStatusLine = (room: string, json = false) => json ? "" : `ready in ${room}`
const printReadyStatus = (room: string, json = false) => {
  const line = readyStatusLine(room, json)
  if (line) console.log(line)
}

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

let sessionRuntimePromise: Promise<typeof import("./core/session")> | null = null
let tuiRuntimePromise: Promise<typeof import("./tui/app")> | null = null

const loadSessionRuntime = () => {
  if (sessionRuntimePromise) return sessionRuntimePromise
  sessionRuntimePromise = (async () => {
    await ensureSessionRuntimePatches()
    return import("./core/session")
  })()
  return sessionRuntimePromise
}

const loadTuiRuntime = () => {
  if (tuiRuntimePromise) return tuiRuntimePromise
  tuiRuntimePromise = (async () => {
    await ensureTuiRuntimePatches()
    return import("./tui/app")
  })()
  return tuiRuntimePromise
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
  const { SendSession } = await loadSessionRuntime()
  const session = new SendSession(sessionConfigFrom(options, {}))
  handleSignals(session)
  printRoomAnnouncement(session.room, displayPeerName(session.name, session.localId), !!options.json)
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
  const { SendSession } = await loadSessionRuntime()
  const session = new SendSession(sessionConfigFrom(options, {}))
  handleSignals(session)
  printCommandAnnouncement("offer", session.room, displayPeerName(session.name, session.localId), !!options.json)
  const detachReporter = attachReporter(session, !!options.json)
  await session.connect()
  printReadyStatus(session.room, !!options.json)
  const targets = await waitForTargets(session, selectors, timeoutMs)
  const transferIds = await session.queueFiles(files, targets.map(peer => peer.id))
  const results = await waitForFinalTransfers(session, transferIds)
  detachReporter()
  await session.close()
  const failed = results.filter(transfer => transfer && ["rejected", "cancelled", "error"].includes(transfer.status))
  if (failed.length) throw new ExitError(failed.map(transfer => `${transfer?.name}:${transfer?.status}`).join(", "), 3)
}

const acceptCommand = async (options: Record<string, unknown>) => {
  const { SendSession } = await loadSessionRuntime()
  const session = new SendSession(sessionConfigFrom(options, ACCEPT_SESSION_DEFAULTS))
  handleSignals(session)
  printCommandAnnouncement("accept", session.room, displayPeerName(session.name, session.localId), !!options.json)
  const detachReporter = attachReporter(session, !!options.json)
  await session.connect()
  printReadyStatus(session.room, !!options.json)
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
  const initialConfig = sessionConfigFrom(options, ACCEPT_SESSION_DEFAULTS)
  const { clean, offer } = parseBinaryOptions(options, ["clean", "offer"] as const)
  const { startTui } = await loadTuiRuntime()
  await startTui(initialConfig, {
    events: !!options.events,
    clean: clean ?? true,
    offer: offer ?? true,
  })
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

const fileNamePart = (value: string) => value.replace(/^.*[\\/]/, "") || value
const HELP_NAME_COLOR = "\x1b[38;5;214m"
const HELP_NAME_RESET = "\x1b[0m"
const colorCliHelpName = (value: string) => `${HELP_NAME_COLOR}${value}${HELP_NAME_RESET}`
const cliHelpPlainName = () => process.env.SEND_NAME?.trim() || fileNamePart(Bun.main)
const cliHelpDisplayName = () => {
  const name = cliHelpPlainName()
  if (!process.stdout.isTTY) return name
  return process.env.SEND_NAME_COLORED?.trim() || colorCliHelpName(name)
}

export const createCli = (handlers: CliHandlers = defaultCliHandlers) => {
  const name = cliHelpDisplayName()
  const cli = cac(name)
  cli.usage("[command] [options]")

  withTrailingHelpLine(addOptions(cli.command("peers", "list discovered peers").ignoreOptionDefaultValue(), [
    ...ROOM_SELF_OPTIONS,
    ["--wait <ms>", "discovery wait in milliseconds", { default: 3000 }],
    ["--json", "print a json snapshot"],
    SAVE_DIR_OPTION,
    ...TURN_OPTIONS,
  ])).action(options => handlers.peers(normalizeCliOptions(options)))

  withTrailingHelpLine(addOptions(cli.command("offer [...files]", "offer files to browser-compatible peers").ignoreOptionDefaultValue(), [
    ...ROOM_SELF_OPTIONS,
    ["--to <peer>", "target `name`, `name-id`, or `-id`", { default: "." }],
    ["--wait-peer <ms>", "wait for eligible peers in milliseconds", { default: "<infinite>" }],
    ["--json", "emit ndjson events"],
    SAVE_DIR_OPTION,
    ...TURN_OPTIONS,
  ])).action((files, options) => handlers.offer(files, normalizeCliOptions(options)))

  withTrailingHelpLine(addOptions(cli.command("accept", "receive and save files").ignoreOptionDefaultValue(), [
    ...ROOM_SELF_OPTIONS,
    SAVE_DIR_OPTION,
    OVERWRITE_OPTION,
    ["--once", "exit after the first saved incoming transfer"],
    ["--json", "emit ndjson events"],
    ...TURN_OPTIONS,
  ])).action(options => handlers.accept(normalizeCliOptions(options)))

  withTrailingHelpLine(addOptions(cli.command("tui", "launch the interactive terminal UI").ignoreOptionDefaultValue(), [
    ...ROOM_SELF_OPTIONS,
    ...TUI_TOGGLE_OPTIONS,
    ["--events", "show the event log pane"],
    SAVE_DIR_OPTION,
    OVERWRITE_OPTION,
    ...TURN_OPTIONS,
  ])).action(options => handlers.tui(normalizeCliOptions(options)))

  cli.help(sections => {
    const usage = sections.find(section => section.title === "Usage:")
    if (usage) usage.body = `  $ ${name} [command] [options]`
    const moreInfoIndex = sections.findIndex(section => section.title?.startsWith("For more info"))
    const defaultSection = {
      title: "Default",
      body: `  ${name} with no command launches the terminal UI (same as \`${name} tui\`).`,
    }
    if (moreInfoIndex < 0) sections.push(defaultSection)
    else sections.splice(moreInfoIndex, 0, defaultSection)
  })
  withTrailingHelpLine(cli.globalCommand)

  return cli
}

const argvPrefix = (argv: string[]) => [argv[0] ?? process.argv[0] ?? "bun", argv[1] ?? process.argv[1] ?? cliHelpPlainName()]
const printSubcommandHelp = (argv: string[], handlers: CliHandlers, subcommand: string) =>
  void createCli(handlers).parse([...argvPrefix(argv), subcommand, "--help"], { run: false })

const explicitCommand = (argv: string[], handlers: CliHandlers) => {
  const cli = createCli(handlers)
  cli.showHelpOnExit = false
  cli.parse(argv, { run: false })
  if (cli.matchedCommandName) return cli.matchedCommandName
  if (cli.args[0]) throw new ExitError(`Unknown command \`${cli.args[0]}\``, 1)
  return undefined
}

export const runCli = async (argv = process.argv, handlers: CliHandlers = defaultCliHandlers) => {
  const cli = createCli(handlers)
  const command = explicitCommand(argv, handlers)
  const parsed = cli.parse(argv, { run: false }) as { options: Record<string, unknown> }
  const helpRequested = !!parsed.options.help || !!parsed.options.h
  if (!command) {
    if (helpRequested) {
      printSubcommandHelp(argv, handlers, "tui")
      return
    }
    await handlers.tui(normalizeCliOptions(parsed.options))
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
