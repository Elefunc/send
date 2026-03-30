import { resolve } from "node:path"
import { BACKEND_RAW_WRITE_MARKER, rgb, ui, type BackendRawWrite, type BadgeVariant, type TextStyle, type UiEvent, type VNode } from "@rezi-ui/core"
import { inspectLocalFile, inspectLocalPaths } from "../core/files"
import {
  DEFAULT_WEB_URL,
  inviteCliCommand as formatInviteCliCommand,
  inviteCliPackageName as formatInviteCliPackageName,
  inviteCliText as formatInviteCliText,
  inviteCopyUrl as formatInviteCopyUrl,
  inviteWebLabel as formatInviteWebLabel,
  renderCliCommand as renderSharedCliCommand,
  renderWebUrl,
  resolveWebUrlBase as resolveSharedWebUrlBase,
  schemeLessUrlText,
  webInviteUrl as formatWebInviteUrl,
} from "../core/invite"
import { isSessionAbortedError, SendSession, signalMetricState, type PeerSnapshot, type SessionConfig, type SessionSnapshot, type TransferSnapshot } from "../core/session"
import { cleanLocalId, cleanName, cleanRoom, displayPeerName, fallbackName, formatBytes, type LogEntry, peerDefaultsToken, type PeerProfile, uid } from "../core/protocol"
import { FILE_SEARCH_VISIBLE_ROWS, type FileSearchEvent, type FileSearchMatch, type FileSearchRequest } from "./file-search-protocol"
import { deriveFileSearchScope, formatFileSearchDisplayPath, normalizeSearchQuery, offsetFileSearchMatchIndices } from "./file-search"
import { applyInputEditEvent } from "./input-editor"
import { createSendNodeApp, type SendNodeAppConfig } from "./send-node-app"
import { installCheckboxClickPatch } from "../../runtime/rezi-checkbox-click"

type Notice = { text: string; variant: "info" | "success" | "warning" | "error" }
type DraftItem = { id: string; path: string; name: string; size: number; createdAt: number }
type SessionSeed = Omit<SessionConfig, "autoAcceptIncoming" | "autoSaveIncoming"> & { localId: string; name: string; room: string }
type TuiAction = () => void
type TransferSection = { title: string; items: TransferSnapshot[]; clearAction?: "completed" | "failed" }
type TransferSummaryStat = { state: string; label?: string; count: number; size: number; countText?: string; sizeText?: string }
type TransferGroup = { key: string; name: string; items: TransferSnapshot[] }
type DenseSectionChild = VNode | false | null | undefined
type PreviewSegmentRole = "prefix" | "path" | "basename"
type PreviewSegment = { text: string; highlighted: boolean; role: PreviewSegmentRole }
type DraftHistoryState = {
  entries: string[]
  index: number | null
  baseInput: string | null
}
type FilePreviewState = {
  dismissedQuery: string | null
  workspaceRoot: string | null
  displayPrefix: string
  displayQuery: string | null
  pendingQuery: string | null
  waiting: boolean
  error: string | null
  results: FileSearchMatch[]
  selectedIndex: number | null
  scrollTop: number
}
type DenseSectionOptions = {
  id?: string
  key?: string
  title?: string
  titleNode?: VNode
  subtitle?: string
  actions?: readonly VNode[]
  border?: "rounded" | "single" | "none"
  flex?: number
}
type TuiLaunchOptions = { events?: boolean; clean?: boolean; offer?: boolean; draftPaths?: readonly string[] }

export type VisiblePane = "peers" | "transfers" | "logs"

export interface TuiState {
  session: SendSession
  sessionSeed: SessionSeed
  peerSelectionByRoom: Map<string, Map<string, boolean>>
  snapshot: SessionSnapshot
  aboutOpen: boolean
  inviteDropdownOpen: boolean
  peerSearch: string
  focusedId: string | null
  roomInput: string
  nameInput: string
  pendingFocusTarget: string | null
  focusRequestEpoch: number
  bootNameJumpPending: boolean
  draftInput: string
  draftInputKeyVersion: number
  draftHistory: DraftHistoryState
  filePreview: FilePreviewState
  drafts: DraftItem[]
  autoOfferOutgoing: boolean
  autoAcceptIncoming: boolean
  autoSaveIncoming: boolean
  overwriteIncoming: boolean
  hideTerminalPeers: boolean
  eventsExpanded: boolean
  offeringDrafts: boolean
  notice: Notice
}

export interface TuiActions {
  toggleEvents: TuiAction
  openAbout: TuiAction
  closeAbout: TuiAction
  toggleInviteDropdown: TuiAction
  closeInviteDropdown: TuiAction
  copyWebInvite: TuiAction
  copyCliInvite: TuiAction
  copyLogs: TuiAction
  jumpToRandomRoom: TuiAction
  commitRoom: TuiAction
  setRoomInput: (value: string) => void
  jumpToNewSelf: TuiAction
  commitName: TuiAction
  setNameInput: (value: string) => void
  setPeerSearch: (value: string) => void
  toggleSelectReadyPeers: TuiAction
  clearPeerSelection: TuiAction
  toggleHideTerminalPeers: TuiAction
  togglePeer: (peerId: string) => void
  shareTurnWithPeer: (peerId: string) => void
  shareTurnWithAllPeers: TuiAction
  toggleAutoOffer: TuiAction
  toggleAutoAccept: TuiAction
  toggleAutoSave: TuiAction
  toggleOverwrite: TuiAction
  setDraftInput: (value: string, cursor?: number) => void
  addDrafts: TuiAction
  removeDraft: (draftId: string) => void
  clearDrafts: TuiAction
  cancelPendingOffers: TuiAction
  acceptTransfer: (transferId: string) => void
  rejectTransfer: (transferId: string) => void
  cancelTransfer: (transferId: string) => void
  saveTransfer: (transferId: string) => void
  clearCompleted: TuiAction
  clearFailed: TuiAction
  clearLogs: TuiAction
}

const ROOM_INPUT_ID = "room-input"
const NAME_INPUT_ID = "name-input"
const PEER_SEARCH_INPUT_ID = "peer-search-input"
const DRAFT_INPUT_ID = "draft-input"
const ROOM_INVITE_BUTTON_ID = "room-invite-button"
const INVITE_DROPDOWN_ID = "room-invite-dropdown"
const ABOUT_TRIGGER_ID = "open-about"
const TRANSPARENT_BORDER_STYLE = { fg: rgb(7, 10, 12) } as const
const METRIC_BORDER_STYLE = { fg: rgb(20, 25, 32) } as const
const PRIMARY_TEXT_STYLE = { fg: rgb(255, 255, 255) } as const
const HEADING_TEXT_STYLE = { fg: rgb(255, 255, 255), bold: true } as const
const MUTED_TEXT_STYLE = { fg: rgb(159, 166, 178) } as const
const DEFAULT_SAVE_DIR = resolve(process.cwd())
const ABOUT_ELEFUNC_URL = "https://rtme.sh/send"
const ABOUT_TITLE = "About Send"
const ABOUT_INTRO = "Peer-to-Peer Transfers – Web & CLI"
const ABOUT_BULLETS = [
  "• Join a room, see who is there, and filter or select exactly which peers to target before offering files.",
  "• File data does not travel through the signaling service; Send uses lightweight signaling to discover peers and negotiate WebRTC, then transfers directly peer-to-peer when possible, with TURN relay when needed.",
  "• Incoming transfers can be auto-accepted and auto-saved, and same-name files can either stay as numbered copies or overwrite the original when that mode is enabled.",
  "• The CLI streams incoming saves straight to disk in the current save directory, with overwrite available through the CLI flag and the TUI Ctrl+O shortcut.",
  "• Other features include copyable web and CLI invites, rendered-peer filtering and selection, TURN sharing, and live connection insight like signaling state, RTT, data state, and path labels.",
] as const
const TRANSFER_DIRECTION_ARROW = {
  out: { glyph: "↗", style: { fg: rgb(170, 217, 76), bold: true } },
  in: { glyph: "↙", style: { fg: rgb(240, 113, 120), bold: true } },
} as const

const countFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })
const percentFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })
const pluralRules = new Intl.PluralRules()
const DRAFT_HISTORY_LIMIT = 50

export const visiblePanes = (showEvents: boolean): VisiblePane[] => showEvents ? ["peers", "transfers", "logs"] : ["peers", "transfers"]
export const TUI_NODE_APP_CONFIG = Object.freeze({
  executionMode: "inline",
  fpsCap: 30,
  idlePollMs: 50,
} satisfies SendNodeAppConfig)

const noop = () => {}
export const isEditableFocusId = (focusedId: string | null) =>
  focusedId === ROOM_INPUT_ID || focusedId === NAME_INPUT_ID || focusedId === PEER_SEARCH_INPUT_ID || focusedId === DRAFT_INPUT_ID
export const shouldSwallowQQuit = (focusedId: string | null) => !isEditableFocusId(focusedId)

const TUI_QUIT_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const
type TuiQuitSignal = (typeof TUI_QUIT_SIGNALS)[number]
type ProcessSignalLike = {
  on?: (signal: TuiQuitSignal, handler: () => void) => unknown
  off?: (signal: TuiQuitSignal, handler: () => void) => unknown
  removeListener?: (signal: TuiQuitSignal, handler: () => void) => unknown
}
type BunSpawn = (cmd: string[], options: {
  stdin?: "pipe" | "inherit" | "ignore"
  stdout?: "pipe" | "inherit" | "ignore"
  stderr?: "pipe" | "inherit" | "ignore"
}) => { unref?: () => void }
type BunLike = { spawn?: BunSpawn }
type ShareUrlState = Pick<TuiState, "snapshot" | "hideTerminalPeers" | "autoAcceptIncoming" | "autoOfferOutgoing" | "autoSaveIncoming" | "overwriteIncoming">
type ShareCliState = ShareUrlState & Pick<TuiState, "sessionSeed" | "eventsExpanded">
const shareUrlOptions = (state: ShareUrlState) => ({
  room: cleanRoom(state.snapshot.room),
  clean: state.hideTerminalPeers,
  accept: state.autoAcceptIncoming,
  offer: state.autoOfferOutgoing,
  save: state.autoSaveIncoming,
  overwrite: state.overwriteIncoming,
})
const shareCliOptions = (state: ShareCliState) => ({
  ...shareUrlOptions(state),
  self: displayPeerName(state.snapshot.name, state.snapshot.localId),
  events: state.eventsExpanded,
  saveDir: state.snapshot.saveDir,
  defaultSaveDir: DEFAULT_SAVE_DIR,
  turnUrls: state.sessionSeed.turnUrls,
  turnUsername: state.sessionSeed.turnUsername,
  turnCredential: state.sessionSeed.turnCredential,
})
export const resolveWebUrlBase = (value = process.env.SEND_WEB_URL) => resolveSharedWebUrlBase(value)
export const inviteWebLabel = (state: ShareUrlState, baseUrl = resolveWebUrlBase()) => formatInviteWebLabel(shareUrlOptions(state), baseUrl)
export const inviteCliPackageName = (baseUrl = resolveWebUrlBase()) => formatInviteCliPackageName(baseUrl)
export const inviteCliCommand = (state: ShareUrlState) => formatInviteCliCommand(shareUrlOptions(state))
export const inviteCliText = (state: ShareUrlState, baseUrl = resolveWebUrlBase()) => formatInviteCliText(shareUrlOptions(state), baseUrl)
export const inviteCopyUrl = (text: string) => formatInviteCopyUrl(text)
export const buildOsc52ClipboardSequence = (text: string) => text ? `\u001b]52;c;${Buffer.from(text).toString("base64")}\u0007` : ""
export const externalOpenCommand = (url: string, platform = process.platform) =>
  platform === "darwin" ? ["open", url]
    : platform === "win32" ? ["cmd.exe", "/c", "start", "", url]
      : ["xdg-open", url]
const getBackendRawWriter = (backend: unknown): BackendRawWrite | null => {
  const marker = (backend as Record<string, unknown>)[BACKEND_RAW_WRITE_MARKER]
  return typeof marker === "function" ? marker as BackendRawWrite : null
}
const getBunRuntime = () => (globalThis as typeof globalThis & { Bun?: BunLike }).Bun ?? null
export const webInviteUrl = (state: ShareUrlState, baseUrl = resolveWebUrlBase()) => formatWebInviteUrl(shareUrlOptions(state), baseUrl)

export const aboutWebUrl = (state: ShareUrlState, baseUrl = DEFAULT_WEB_URL) => renderWebUrl(shareUrlOptions(state), baseUrl)

export const aboutWebLabel = (state: ShareUrlState, baseUrl = DEFAULT_WEB_URL) => schemeLessUrlText(aboutWebUrl(state, baseUrl))

export const aboutCliCommand = (state: ShareCliState) => renderSharedCliCommand(shareCliOptions(state))

export const resumeWebUrl = (state: ShareUrlState, baseUrl = DEFAULT_WEB_URL) => renderWebUrl(shareUrlOptions(state), baseUrl)

export const resumeCliCommand = (state: ShareCliState) => renderSharedCliCommand(shareCliOptions(state), { includeSelf: true, includePrefix: true, packageName: "rtme.sh" })

export const resumeOutputLines = (state: ShareCliState) => [
  "Rejoin with:",
  "",
  "Web",
  resumeWebUrl(state),
  "",
  "CLI",
  resumeCliCommand(state),
  "",
]

export const createQuitController = (processLike: ProcessSignalLike | null = process) => {
  let settled = false
  let resolvePromise = () => {}
  const promise = new Promise<void>(resolve => { resolvePromise = resolve })
  const requestStop = () => {
    if (settled) return false
    settled = true
    resolvePromise()
    return true
  }
  const handler = () => { requestStop() }
  for (const signal of TUI_QUIT_SIGNALS) processLike?.on?.(signal, handler)
  return {
    promise,
    requestStop,
    detach: () => {
      for (const signal of TUI_QUIT_SIGNALS) {
        processLike?.off?.(signal, handler)
        processLike?.removeListener?.(signal, handler)
      }
    },
  }
}

export const createNoopTuiActions = (): TuiActions => ({
  toggleEvents: noop,
  openAbout: noop,
  closeAbout: noop,
  toggleInviteDropdown: noop,
  closeInviteDropdown: noop,
  copyWebInvite: noop,
  copyCliInvite: noop,
  copyLogs: noop,
  jumpToRandomRoom: noop,
  commitRoom: noop,
  setRoomInput: noop,
  jumpToNewSelf: noop,
  commitName: noop,
  setNameInput: noop,
  setPeerSearch: noop,
  toggleSelectReadyPeers: noop,
  clearPeerSelection: noop,
  toggleHideTerminalPeers: noop,
  togglePeer: noop,
  shareTurnWithPeer: noop,
  shareTurnWithAllPeers: noop,
  toggleAutoOffer: noop,
  toggleAutoAccept: noop,
  toggleAutoSave: noop,
  toggleOverwrite: noop,
  setDraftInput: noop,
  addDrafts: noop,
  removeDraft: noop,
  clearDrafts: noop,
  cancelPendingOffers: noop,
  acceptTransfer: noop,
  rejectTransfer: noop,
  cancelTransfer: noop,
  saveTransfer: noop,
  clearCompleted: noop,
  clearFailed: noop,
  clearLogs: noop,
})

const plural = (count: number, noun: string) => `${countFormat.format(count)} ${noun}${pluralRules.select(count) === "one" ? "" : "s"}`
const shortText = (value: unknown, max = 88) => {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}
const formatLogPayloadText = (payload: unknown) => {
  if (typeof payload === "string") return payload
  try {
    return JSON.stringify(payload, null, 2) ?? `${payload}`
  } catch {
    return `${payload}`
  }
}
export const formatLogsForCopy = (logs: readonly LogEntry[]) => logs.map(log => `${timeFormat.format(log.at)} ${log.kind}\n${formatLogPayloadText(log.payload)}`).join("\n\n")
const toggleIntent = (active: boolean) => active ? "success" : "secondary"
const statusKind = (socketState: SessionSnapshot["socketState"]) => socketState === "open" ? "online" : socketState === "connecting" ? "busy" : socketState === "error" ? "offline" : "away"
const peerConnectionStatusKind = (status: string) => ({
  connected: "online",
  connecting: "busy",
  disconnected: "away",
  left: "away",
  failed: "offline",
  closed: "offline",
  idle: "unknown",
  new: "unknown",
}[status] || "unknown") as "online" | "offline" | "away" | "busy" | "unknown"
const transferStatusKind = (status: TransferSnapshot["status"]) => ({
  complete: "online",
  sending: "online",
  receiving: "online",
  "awaiting-done": "online",
  accepted: "busy",
  queued: "busy",
  offered: "busy",
  pending: "busy",
  cancelling: "busy",
  rejected: "offline",
  cancelled: "offline",
  error: "offline",
}[status] || "unknown") as "online" | "offline" | "away" | "busy" | "unknown"
const visiblePeers = (peers: PeerSnapshot[], hideTerminalPeers: boolean) => hideTerminalPeers ? peers.filter(peer => peer.status === "connected") : peers
const peerSearchNeedle = (value: string) => `${value ?? ""}`.trim().toLowerCase()
const peerMatchesSearch = (peer: PeerSnapshot, search: string) => !search || peer.displayName.toLowerCase().includes(search)
export const renderedPeers = (peers: PeerSnapshot[], hideTerminalPeers: boolean, search: string) => {
  const needle = peerSearchNeedle(search)
  return visiblePeers(peers, hideTerminalPeers)
    .filter(peer => peerMatchesSearch(peer, needle))
    .sort((left, right) => left.id.localeCompare(right.id))
}
export const renderedReadySelectedPeers = (peers: PeerSnapshot[], hideTerminalPeers: boolean, search: string) =>
  renderedPeers(peers, hideTerminalPeers, search).filter(peer => peer.selected && peer.ready)
const transferProgress = (transfer: TransferSnapshot) => Math.max(0, Math.min(1, transfer.progress / 100))
const isPendingOffer = (transfer: TransferSnapshot) => transfer.direction === "out" && (transfer.status === "queued" || transfer.status === "offered")
const statusVariant = (status: TransferSnapshot["status"]): BadgeVariant => ({
  draft: "default",
  complete: "success",
  sending: "info",
  receiving: "info",
  accepted: "warning",
  queued: "warning",
  offered: "warning",
  pending: "warning",
  rejected: "error",
  cancelled: "error",
  error: "error",
  cancelling: "warning",
  "awaiting-done": "info",
}[status] || "default") as BadgeVariant
export const statusToneVariant = (value: string): BadgeVariant => ({
  open: "success",
  connected: "success",
  complete: "success",
  accepted: "success",
  receiving: "success",
  sending: "success",
  available: "success",
  used: "success",
  idle: "info",
  connecting: "info",
  offered: "info",
  "awaiting-done": "info",
  queued: "info",
  retrying: "info",
  pending: "warning",
  cancelling: "warning",
  checking: "warning",
  degraded: "warning",
  disconnected: "warning",
  left: "warning",
  rejected: "warning",
  cancelled: "warning",
  absent: "warning",
  none: "warning",
  error: "error",
  failed: "error",
  closed: "error",
}[value] || "default") as BadgeVariant
const joinSummary = (parts: Array<string | undefined>, glue = ", ") => parts.filter(Boolean).join(glue)
const geoSummary = (profile?: PeerProfile) => joinSummary([profile?.geo?.city, profile?.geo?.region, profile?.geo?.country]) || "—"
const netSummary = (profile?: PeerProfile) => joinSummary([profile?.network?.asOrganization, profile?.network?.colo], " · ") || "—"
const uaSummary = (profile?: PeerProfile) => joinSummary([profile?.ua?.browser, profile?.ua?.os, profile?.ua?.device && profile.ua.device !== "desktop" ? profile.ua.device : ""] , " · ") || "—"
const profileIp = (profile?: PeerProfile) => profile?.network?.ip || "—"
const peerDefaultsVariant = (profile?: PeerProfile): BadgeVariant => {
  const token = peerDefaultsToken(profile)
  return token === "AX" ? "success" : token === "as" ? "warning" : token === "??" ? "default" : "info"
}
const TIGHT_TAG_COLORS = {
  default: rgb(89, 194, 255),
  success: rgb(170, 217, 76),
  warning: rgb(242, 169, 59),
  error: rgb(240, 113, 120),
  info: rgb(89, 194, 255),
} as const
const PREVIEW_PREFIX_STYLE = { fg: rgb(112, 121, 136), dim: true } as const
const PREVIEW_PATH_STYLE = { ...MUTED_TEXT_STYLE, dim: true } as const
const PREVIEW_BASENAME_STYLE = PRIMARY_TEXT_STYLE
const PREVIEW_HIGHLIGHT_STYLE = { fg: TIGHT_TAG_COLORS.info, bold: true } as const
const PREVIEW_SELECTED_HIGHLIGHT_STYLE = { fg: TIGHT_TAG_COLORS.success, bold: true } as const
const PREVIEW_SELECTED_MARKER_STYLE = { fg: TIGHT_TAG_COLORS.info, bold: true } as const
const tightTag = (text: string, props: { key?: string; variant?: BadgeVariant; bare?: boolean } = {}) => ui.text(props.bare ? text : `(${text})`, {
  ...(props.key === undefined ? {} : { key: props.key }),
  style: {
    fg: TIGHT_TAG_COLORS[props.variant ?? "default"],
    bold: true,
  },
})
const emptyFilePreviewState = (): FilePreviewState => ({
  dismissedQuery: null,
  workspaceRoot: null,
  displayPrefix: "",
  displayQuery: null,
  pendingQuery: null,
  waiting: false,
  error: null,
  results: [],
  selectedIndex: null,
  scrollTop: 0,
})
const emptyDraftHistoryState = (): DraftHistoryState => ({
  entries: [],
  index: null,
  baseInput: null,
})

const resetDraftHistoryBrowse = (history: DraftHistoryState): DraftHistoryState =>
  history.index == null && history.baseInput == null
    ? history
    : { ...history, index: null, baseInput: null }

export const pushDraftHistoryEntry = (history: DraftHistoryState, value: string, limit = DRAFT_HISTORY_LIMIT): DraftHistoryState => {
  const nextValue = normalizeSearchQuery(value)
  if (!nextValue) return resetDraftHistoryBrowse(history)
  return {
    entries: history.entries[0] === nextValue ? history.entries : [nextValue, ...history.entries].slice(0, limit),
    index: null,
    baseInput: null,
  }
}

export const isDraftHistoryEntryPoint = (value: string, cursor: number, cwd = process.cwd()) => {
  if (cursor !== 0) return false
  const normalized = normalizeSearchQuery(value)
  if (!normalized) return true
  return !deriveFileSearchScope(value, cwd)?.query
}

export const canNavigateDraftHistory = (history: DraftHistoryState, value: string, cursor: number, cwd = process.cwd()) =>
  cursor === 0 && (history.index != null || (history.entries.length > 0 && isDraftHistoryEntryPoint(value, cursor, cwd)))

export const moveDraftHistory = (history: DraftHistoryState, value: string, direction: -1 | 1) => {
  if (!history.entries.length) return { history, value, changed: false }
  if (history.index == null) {
    if (direction > 0) return { history, value, changed: false }
    const nextIndex = 0
    return {
      history: { ...history, index: nextIndex, baseInput: value },
      value: history.entries[nextIndex]!,
      changed: history.entries[nextIndex] !== value,
    }
  }
  if (direction < 0) {
    const nextIndex = Math.min(history.entries.length - 1, history.index + 1)
    return {
      history: nextIndex === history.index ? history : { ...history, index: nextIndex },
      value: history.entries[nextIndex]!,
      changed: nextIndex !== history.index || history.entries[nextIndex] !== value,
    }
  }
  if (history.index === 0) {
    const nextValue = history.baseInput ?? ""
    return {
      history: resetDraftHistoryBrowse(history),
      value: nextValue,
      changed: nextValue !== value || history.index != null,
    }
  }
  const nextIndex = history.index - 1
  return {
    history: { ...history, index: nextIndex },
    value: history.entries[nextIndex]!,
    changed: history.entries[nextIndex] !== value,
  }
}

type FocusControllerState = Pick<TuiState, "pendingFocusTarget" | "focusRequestEpoch" | "bootNameJumpPending">

export const deriveBootFocusState = (name: string, focusRequestEpoch = 0): FocusControllerState => {
  const normalizedName = cleanName(name)
  const customSelfName = normalizedName !== fallbackName
  return {
    pendingFocusTarget: customSelfName ? DRAFT_INPUT_ID : NAME_INPUT_ID,
    focusRequestEpoch,
    bootNameJumpPending: !customSelfName,
  }
}

export const consumeSatisfiedFocusRequest = <T extends FocusControllerState>(state: T, focusedId: string | null): T =>
  state.pendingFocusTarget !== null && state.pendingFocusTarget === focusedId
    ? { ...state, pendingFocusTarget: null }
    : state

export const scheduleBootNameJump = <T extends FocusControllerState>(state: T): T =>
  state.bootNameJumpPending
    ? {
        ...state,
        pendingFocusTarget: DRAFT_INPUT_ID,
        focusRequestEpoch: state.focusRequestEpoch + 1,
        bootNameJumpPending: false,
      }
    : state

const visibleNameInput = (name: string) => cleanName(name) === fallbackName ? "" : cleanName(name)

const normalizeSessionSeed = (config: SessionConfig): SessionSeed => ({
  ...config,
  localId: cleanLocalId(config.localId ?? uid(8)),
  name: cleanName(config.name ?? fallbackName),
  room: cleanRoom(config.room),
})

const roomPeerSelectionMemory = (peerSelectionByRoom: Map<string, Map<string, boolean>>, room: string) => {
  const roomKey = cleanRoom(room)
  let selectionMemory = peerSelectionByRoom.get(roomKey)
  if (!selectionMemory) {
    selectionMemory = new Map<string, boolean>()
    peerSelectionByRoom.set(roomKey, selectionMemory)
  }
  return selectionMemory
}

const makeSession = (seed: SessionSeed, autoAcceptIncoming: boolean, autoSaveIncoming: boolean, peerSelectionMemory: Map<string, boolean>) => new SendSession({
  ...seed,
  peerSelectionMemory,
  autoAcceptIncoming,
  autoSaveIncoming,
})

const transferSections = (snapshot: SessionSnapshot): TransferSection[] => {
  const pending = snapshot.transfers.filter(transfer => transfer.direction === "in" && transfer.status === "pending" || transfer.direction === "out" && (transfer.status === "queued" || transfer.status === "offered"))
  const active = snapshot.transfers.filter(transfer => !["pending", "queued", "offered", "complete", "rejected", "cancelled", "error"].includes(transfer.status))
  const completed = snapshot.transfers.filter(transfer => transfer.status === "complete")
  const failed = snapshot.transfers.filter(transfer => ["rejected", "cancelled", "error"].includes(transfer.status))
  return [
    { title: "Pending", items: pending },
    { title: "Transfers", items: active },
    { title: "Completed", items: completed, clearAction: "completed" },
    { title: "Failed", items: failed, clearAction: "failed" },
  ]
}

const formatClockTime = (value: number) => value ? timeFormat.format(new Date(value)) : "—"

export const formatDuration = (value: number) => {
  const ms = Number(value) || 0
  const total = Math.round(ms / 1000)
  if (!Number.isFinite(ms) || ms <= 0) return "—"
  if (ms < 1000) return "<1s"
  if (total < 60) return `${total}s`
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor(total % 3600 / 60)
  const seconds = total % 60
  return hours ? `${hours}h ${`${minutes}`.padStart(2, "0")}m` : `${minutes}m ${`${seconds}`.padStart(2, "0")}s`
}

export const transferActualDurationMs = (transfer: TransferSnapshot, now = Date.now()) => transfer.startedAt ? Math.max(0, (transfer.endedAt || transfer.updatedAt || now) - transfer.startedAt) : Number.NaN
export const transferWaitDurationMs = (transfer: TransferSnapshot, now = Date.now()) => Math.max(0, (transfer.startedAt || now) - transfer.createdAt)
export const filePreviewVisible = (state: Pick<TuiState, "focusedId" | "draftInput" | "filePreview">) =>
  state.focusedId === DRAFT_INPUT_ID && !!normalizeSearchQuery(state.draftInput) && state.filePreview.dismissedQuery !== state.draftInput
export const canAcceptFilePreviewWithRight = (state: Pick<TuiState, "focusedId" | "draftInput" | "filePreview">, cursor: number) =>
  state.focusedId === DRAFT_INPUT_ID
  && cursor === state.draftInput.length
  && filePreviewVisible(state)
  && state.filePreview.selectedIndex != null
  && !!state.filePreview.results[state.filePreview.selectedIndex]
export const clampFilePreviewSelectedIndex = (selectedIndex: number | null, resultCount: number) =>
  !resultCount ? null : selectedIndex == null ? 0 : Math.max(0, Math.min(resultCount - 1, selectedIndex))
export const ensureFilePreviewScrollTop = (selectedIndex: number | null, scrollTop: number, resultCount: number, visibleRows = FILE_SEARCH_VISIBLE_ROWS) => {
  if (!resultCount || selectedIndex == null) return 0
  const maxScrollTop = Math.max(0, resultCount - visibleRows)
  if (selectedIndex < scrollTop) return selectedIndex
  if (selectedIndex >= scrollTop + visibleRows) return Math.min(maxScrollTop, selectedIndex - visibleRows + 1)
  return Math.max(0, Math.min(maxScrollTop, scrollTop))
}
export const moveFilePreviewSelection = (preview: FilePreviewState, direction: -1 | 1) => {
  if (!preview.results.length) return preview
  const nextIndex = preview.selectedIndex == null
    ? direction > 0 ? 0 : preview.results.length - 1
    : (preview.selectedIndex + direction + preview.results.length) % preview.results.length
  return {
    ...preview,
    selectedIndex: nextIndex,
    scrollTop: ensureFilePreviewScrollTop(nextIndex, preview.scrollTop, preview.results.length),
  }
}

const visibleFilePreviewResults = (preview: FilePreviewState) => preview.results.slice(preview.scrollTop, preview.scrollTop + FILE_SEARCH_VISIBLE_ROWS)
const selectedFilePreviewMatch = (state: TuiState) => {
  const index = state.filePreview.selectedIndex
  return index == null ? null : state.filePreview.results[index] ?? null
}
export const previewPathSegments = (value: string, prefixLength: number, indices: number[]) => {
  const marks = new Set(indices)
  const chars = Array.from(value)
  const basenameStart = Math.max(prefixLength, value.lastIndexOf("/") + 1)
  const segments: PreviewSegment[] = []
  let current = ""
  let highlighted = false
  let role: PreviewSegmentRole = "basename"
  for (let index = 0; index < chars.length; index += 1) {
    const nextHighlighted = marks.has(index)
    const nextRole = index < prefixLength ? "prefix" : index < basenameStart ? "path" : "basename"
    if (current && (nextHighlighted !== highlighted || nextRole !== role)) {
      segments.push({ text: current, highlighted, role })
      current = ""
    }
    current += chars[index]
    highlighted = nextHighlighted
    role = nextRole
  }
  if (current) segments.push({ text: current, highlighted, role })
  return segments
}
export const previewSegmentStyle = (segment: PreviewSegment, selected: boolean): TextStyle =>
  segment.highlighted
    ? selected ? PREVIEW_SELECTED_HIGHLIGHT_STYLE : PREVIEW_HIGHLIGHT_STYLE
    : segment.role === "prefix"
      ? PREVIEW_PREFIX_STYLE
      : segment.role === "path"
        ? PREVIEW_PATH_STYLE
        : PREVIEW_BASENAME_STYLE

export const summarizeStates = <T,>(items: T[], stateOf: (item: T) => string = item => `${(item as { status?: string }).status ?? "idle"}`, sizeOf: (item: T) => number = item => Number((item as { size?: number }).size) || 0, defaults: string[] = []): TransferSummaryStat[] => {
  const order = ["draft", "pending", "queued", "offered", "accepted", "receiving", "sending", "awaiting-done", "cancelling", "complete", "rejected", "cancelled", "error"]
  const buckets = new Map(defaults.map(state => [state, { state, count: 0, size: 0 } satisfies TransferSummaryStat]))
  for (const item of items) {
    const state = stateOf(item) || "idle"
    const size = Number(sizeOf(item)) || 0
    if (!buckets.has(state)) buckets.set(state, { state, count: 0, size: 0 })
    const bucket = buckets.get(state)!
    bucket.count += 1
    bucket.size += size
  }
  return [...buckets.values()].sort((left, right) => {
    const leftIndex = order.indexOf(left.state)
    const rightIndex = order.indexOf(right.state)
    return (leftIndex < 0 ? order.length : leftIndex) - (rightIndex < 0 ? order.length : rightIndex) || left.state.localeCompare(right.state)
  })
}

export const transferSummaryStats = (items: TransferSnapshot[], now = Date.now()): TransferSummaryStat[] => {
  let totalDuration = 0
  let durationCount = 0
  for (const transfer of items) {
    const duration = transferActualDurationMs(transfer, now)
    if (!Number.isFinite(duration)) continue
    totalDuration += duration
    durationCount += 1
  }
  return [
    ...summarizeStates(items),
    { state: "duration", label: "duration", count: durationCount, size: 0, countText: durationCount ? formatDuration(totalDuration) : "—", sizeText: "" },
  ]
}

export const groupTransfersByPeer = (transfers: TransferSnapshot[], peers: PeerSnapshot[]): TransferGroup[] => {
  const peersById = new Map(peers.map(peer => [peer.id, peer] as const))
  const groups = new Map<string, TransferGroup>()
  for (const transfer of transfers) {
    const key = transfer.peerId || `${transfer.direction}:${transfer.peerName || transfer.id}`
    if (!groups.has(key)) {
      const peer = peersById.get(transfer.peerId)
      groups.set(key, {
        key,
        name: peer?.displayName ?? displayPeerName(transfer.peerName || fallbackName, transfer.peerId),
        items: [],
      })
    }
    groups.get(key)!.items.push(transfer)
  }
  return [...groups.values()]
}

export const createInitialTuiState = (initialConfig: SessionConfig, showEvents = false, launchOptions: Pick<TuiLaunchOptions, "clean" | "offer"> = {}): TuiState => {
  const sessionSeed = normalizeSessionSeed(initialConfig)
  const autoAcceptIncoming = initialConfig.autoAcceptIncoming ?? true
  const autoSaveIncoming = initialConfig.autoSaveIncoming ?? true
  const overwriteIncoming = !!initialConfig.overwriteIncoming
  const peerSelectionByRoom = new Map<string, Map<string, boolean>>()
  const session = makeSession(sessionSeed, autoAcceptIncoming, autoSaveIncoming, roomPeerSelectionMemory(peerSelectionByRoom, sessionSeed.room))
  const focusState = deriveBootFocusState(sessionSeed.name)
  return {
    session,
    sessionSeed,
    peerSelectionByRoom,
    snapshot: session.snapshot(),
    aboutOpen: false,
    inviteDropdownOpen: false,
    peerSearch: "",
    focusedId: null,
    roomInput: sessionSeed.room,
    nameInput: visibleNameInput(sessionSeed.name),
    ...focusState,
    draftInput: "",
    draftInputKeyVersion: 0,
    draftHistory: emptyDraftHistoryState(),
    filePreview: emptyFilePreviewState(),
    drafts: [],
    autoOfferOutgoing: launchOptions.offer ?? true,
    autoAcceptIncoming,
    autoSaveIncoming,
    overwriteIncoming,
    hideTerminalPeers: launchOptions.clean ?? true,
    eventsExpanded: showEvents,
    offeringDrafts: false,
    notice: { text: "Tab focus", variant: "info" },
  }
}

const toggleButton = (id: string, label: string, active: boolean, onPress: TuiAction, disabled = false) => ui.button({
  id,
  label,
  disabled,
  onPress,
  intent: toggleIntent(active),
  dsVariant: active ? "solid" : "outline",
})

const actionButton = (id: string, label: string, onPress: TuiAction, intent: "secondary" | "warning" | "danger" | "success" | "primary" | "link" = "secondary", disabled = false) => ui.button({
  id,
  label,
  disabled,
  onPress,
  intent,
  dsVariant: intent === "secondary" ? "outline" : "soft",
})

const ghostButton = (id: string, label: string, onPress?: TuiAction, options: { disabled?: boolean; focusable?: boolean } = {}) => ui.button({
  id,
  label,
  ...(options.disabled === undefined ? {} : { disabled: options.disabled }),
  ...(options.focusable === undefined ? {} : { focusable: options.focusable }),
  ...(onPress === undefined ? {} : { onPress }),
  intent: "secondary",
  dsVariant: "ghost",
})

const TEXT_BUTTON_FOCUS_CONFIG = { indicator: "none", showHint: false } as const

const textButton = (id: string, label: string, onPress?: TuiAction, options: { focusable?: boolean; accessibleLabel?: string } = {}) => ui.button({
  id,
  label,
  ...(onPress === undefined ? {} : { onPress }),
  ...(options.focusable === undefined ? {} : { focusable: options.focusable }),
  ...(options.accessibleLabel === undefined ? {} : { accessibleLabel: options.accessibleLabel }),
  px: 0,
  dsVariant: "ghost",
  style: PRIMARY_TEXT_STYLE,
  focusConfig: TEXT_BUTTON_FOCUS_CONFIG,
})

const headingTextButton = (id: string, label: string, onPress?: TuiAction, options: { focusable?: boolean; accessibleLabel?: string } = {}) => ui.button({
  id,
  label,
  ...(onPress === undefined ? {} : { onPress }),
  ...(options.focusable === undefined ? {} : { focusable: options.focusable }),
  ...(options.accessibleLabel === undefined ? {} : { accessibleLabel: options.accessibleLabel }),
  px: 0,
  dsVariant: "ghost",
  style: HEADING_TEXT_STYLE,
  focusConfig: TEXT_BUTTON_FOCUS_CONFIG,
})

const denseSection = (options: DenseSectionOptions, children: readonly DenseSectionChild[]) => ui.box({
  ...(options.id === undefined ? {} : { id: options.id }),
  ...(options.key === undefined ? {} : { key: options.key }),
  ...(options.flex === undefined ? {} : { flex: options.flex }),
  border: options.border ?? "rounded",
  p: 0,
}, [
  ui.column({ gap: 0, ...(options.flex === undefined ? {} : { height: "full" as const }) }, [
    options.title !== undefined || options.titleNode !== undefined || (options.actions?.length ?? 0) > 0
      ? ui.row({ gap: 0, items: "center", wrap: true }, [
          options.titleNode ?? (options.title !== undefined ? ui.text(options.title, { variant: "heading" }) : null),
          (options.actions?.length ?? 0) > 0 ? ui.spacer({ flex: 1 }) : null,
          ...(options.actions ?? []),
        ])
      : null,
    options.subtitle !== undefined ? ui.text(options.subtitle, { dim: true }) : null,
    ...children,
  ]),
])

const renderHeaderBrand = () => ui.row({ id: "brand-title", gap: 1, items: "center" }, [
  ghostButton("brand-icon", "📤", undefined, { focusable: false }),
  ui.text("Send", { id: "brand-label", variant: "heading" }),
])

const renderHeader = (state: TuiState, actions: TuiActions) => denseSection({
  id: "header-shell",
  titleNode: renderHeaderBrand(),
  actions: [
    toggleButton("toggle-events", "Events", state.eventsExpanded, actions.toggleEvents),
    actionButton(ABOUT_TRIGGER_ID, "About", actions.openAbout),
  ],
}, [])

const renderAboutModal = (_state: TuiState, actions: TuiActions) => {
  return ui.modal({
  id: "about-modal",
  title: ABOUT_TITLE,
  content: ui.column({ gap: 1 }, [
    ui.text(ABOUT_INTRO, { id: "about-intro", variant: "heading", wrap: true }),
    ...ABOUT_BULLETS.map((line, index) => ui.text(line, { id: `about-bullet-${index + 1}`, wrap: true })),
  ]),
  actions: [
    ui.link({
      id: "about-elefunc-link",
      label: "rtme.sh/send",
      accessibleLabel: "Open rtme.sh Send page",
      url: ABOUT_ELEFUNC_URL,
    }),
    actionButton("close-about", "Close", actions.closeAbout, "primary"),
  ],
  width: 72,
  maxWidth: 84,
  minWidth: 54,
  frameStyle: { background: rgb(0, 0, 0) },
  backdrop: { variant: "none" },
  initialFocus: "close-about",
  returnFocusTo: ABOUT_TRIGGER_ID,
  onClose: actions.closeAbout,
})
}

const renderInviteDropdown = (state: TuiState, actions: TuiActions) => ui.dropdown({
  id: INVITE_DROPDOWN_ID,
  anchorId: ROOM_INVITE_BUTTON_ID,
  position: "below-end",
  items: [
    { id: "cli", label: "CLI", shortcut: inviteCliText(state) },
    { id: "web", label: "WEB", shortcut: inviteWebLabel(state) },
  ],
  onSelect: item => { if (item.id === "web") actions.copyWebInvite(); if (item.id === "cli") actions.copyCliInvite() },
  onClose: actions.closeInviteDropdown,
})

const renderRoomCard = (state: TuiState, actions: TuiActions) => denseSection({
  id: "room-card",
}, [
  ui.row({ gap: 0, items: "center" }, [
    ghostButton("new-room", "🏠", actions.jumpToRandomRoom),
    ui.box({ flex: 1 }, [
      ui.input({
        id: ROOM_INPUT_ID,
        value: state.roomInput,
        placeholder: "room",
        onInput: value => actions.setRoomInput(value),
        onBlur: actions.commitRoom,
      }),
    ]),
    ui.row({ id: "room-invite-slot", width: 6, justify: "center", items: "center" }, [
      ui.button({
        id: ROOM_INVITE_BUTTON_ID,
        label: "📋",
        accessibleLabel: "Open invite links",
        onPress: actions.toggleInviteDropdown,
        dsVariant: "ghost",
        intent: "secondary",
      }),
    ]),
  ]),
])

const renderSelfMetric = (label: string, value: string) => ui.box({ flex: 1, minWidth: 12, border: "single", borderStyle: METRIC_BORDER_STYLE }, [
  ui.column({ gap: 0 }, [
    ui.text(label, { variant: "caption" }),
    tightTag(value || "—", { variant: statusToneVariant(value), bare: true }),
  ]),
])

const renderSelfProfileLine = (value: string) => ui.text(value || "—")
const ipLookupUrl = (value: string) => value ? `https://gi.rt.ht/:${encodeURIComponent(value)}` : null
const renderIpProfileLine = (value: string) => {
  const ip = value || ""
  const url = ipLookupUrl(ip)
  return url
    ? ui.link({ label: ip, url, accessibleLabel: `Open IP lookup for ${ip}` })
    : ui.text("—")
}
const formatPeerRtt = (value: number) => Number.isFinite(value) ? `${countFormat.format(Math.round(value))}ms` : "—"
const renderPeerMetric = (label: string, value: string, asTag = false) => ui.box({ flex: 1, minWidth: 10, border: "single", borderStyle: METRIC_BORDER_STYLE }, [
  ui.column({ gap: 0 }, [
    ui.text(label, { variant: "caption" }),
    asTag ? tightTag(value || "—", { variant: statusToneVariant(value), bare: true }) : ui.text(value || "—"),
  ]),
])

const renderSelfCard = (state: TuiState, actions: TuiActions) => denseSection({
  id: "self-card",
}, [
  ui.row({ gap: 0, items: "center" }, [
    ghostButton("new-self", "🙂", actions.jumpToNewSelf),
    ui.box({ flex: 1 }, [
      ui.input({
        id: NAME_INPUT_ID,
        value: state.nameInput,
        placeholder: fallbackName,
        onInput: value => actions.setNameInput(value),
        onBlur: actions.commitName,
      }),
    ]),
    ui.text(`-${state.snapshot.localId}`),
  ]),
  ui.row({ gap: 0, wrap: true }, [
    renderSelfMetric("Signaling", signalMetricState(state.snapshot.socketState, state.snapshot.pulse)),
    renderSelfMetric("TURN", state.snapshot.turnState),
  ]),
  ui.column({ gap: 0 }, [
    renderSelfProfileLine(geoSummary(state.snapshot.profile)),
    renderSelfProfileLine(netSummary(state.snapshot.profile)),
    renderSelfProfileLine(uaSummary(state.snapshot.profile)),
    renderIpProfileLine(profileIp(state.snapshot.profile)),
  ]),
])

const renderPeerRow = (peer: PeerSnapshot, turnShareEnabled: boolean, actions: TuiActions) => denseSection({
  id: `peer-row-${peer.id}`,
  key: peer.id,
}, [
  ui.column({ gap: 0 }, [
    ui.row({ id: `peer-head-${peer.id}`, gap: 0, items: "center" }, [
      ui.box({ id: `peer-toggle-slot-${peer.id}`, width: 7, pl: 1, border: "single", borderStyle: TRANSPARENT_BORDER_STYLE }, [
        ui.checkbox({
          id: `peer-toggle-${peer.id}`,
          checked: peer.selectable && peer.selected,
          disabled: !peer.selectable,
          accessibleLabel: `select ${peer.displayName}`,
          focusConfig: { indicator: "none", showHint: false },
          onChange: checked => {
            if (checked !== peer.selected) actions.togglePeer(peer.id)
          },
        }),
      ]),
      ui.box({ id: `peer-name-slot-${peer.id}`, flex: 1, minWidth: 0, border: "none" }, [
        textButton(`peer-share-turn-${peer.id}`, peer.displayName, turnShareEnabled && peer.presence === "active" ? () => actions.shareTurnWithPeer(peer.id) : undefined, {
          focusable: turnShareEnabled && peer.presence === "active",
          accessibleLabel: `share TURN with ${peer.displayName}`,
        }),
      ]),
      ui.row({ id: `peer-status-cluster-${peer.id}`, gap: 1, items: "center" }, [
        ui.status(peerConnectionStatusKind(peer.status), { label: peer.status || "unknown", showLabel: true }),
        tightTag(peerDefaultsToken(peer.profile), { variant: peerDefaultsVariant(peer.profile), bare: true }),
      ]),
    ]),
    ui.row({ gap: 0 }, [
      renderPeerMetric("RTT", formatPeerRtt(peer.rttMs)),
      renderPeerMetric("TURN", peer.turnState, true),
    ]),
    ui.row({ gap: 0 }, [
      renderPeerMetric("Data", peer.dataState, true),
      renderPeerMetric("Path", peer.pathLabel || "—"),
    ]),
    ui.column({ gap: 0 }, [
      renderSelfProfileLine(geoSummary(peer.profile)),
      renderSelfProfileLine(netSummary(peer.profile)),
      renderSelfProfileLine(uaSummary(peer.profile)),
      renderIpProfileLine(profileIp(peer.profile)),
    ]),
    peer.lastError ? ui.callout(peer.lastError, { variant: "error" }) : null,
  ]),
])

const renderPeersCard = (state: TuiState, actions: TuiActions) => {
  const peers = renderedPeers(state.snapshot.peers, state.hideTerminalPeers, state.peerSearch)
  const activeCount = peers.filter(peer => peer.presence === "active").length
  const selectedCount = peers.filter(peer => peer.selectable && peer.selected).length
  const canShareTurn = state.session.canShareTurn()
  return denseSection({
    id: "peers-card",
    titleNode: ui.row({ id: "peers-title-row", gap: 1, items: "center" }, [
      headingTextButton("share-turn-all-peers", "Peers", canShareTurn && !!activeCount ? actions.shareTurnWithAllPeers : undefined, {
        focusable: canShareTurn && !!activeCount,
        accessibleLabel: "share TURN with matching active peers",
      }),
      ui.text(`${selectedCount}/${peers.length}`, { id: "peers-count-text", variant: "heading" }),
    ]),
    flex: 1,
    actions: [
      actionButton("select-ready-peers", "All", actions.toggleSelectReadyPeers),
      actionButton("clear-peer-selection", "None", actions.clearPeerSelection),
      toggleButton("toggle-clean-peers", "Clean", state.hideTerminalPeers, actions.toggleHideTerminalPeers),
    ],
  }, [
    ui.input({
      id: PEER_SEARCH_INPUT_ID,
      value: state.peerSearch,
      placeholder: "filter",
      onInput: value => actions.setPeerSearch(value),
    }),
    ui.box({ id: "peers-list", flex: 1, minHeight: 0, overflow: "scroll", border: "none" }, [
      peers.length
        ? ui.column({ gap: 0 }, peers.map(peer => renderPeerRow(peer, canShareTurn, actions)))
        : ui.empty(state.snapshot.peers.length ? "No peers match current filters." : `Waiting for peers in ${state.snapshot.room}...`),
    ]),
  ])
}

const renderDraftRow = (draft: DraftItem, actions: TuiActions) => ui.row({ key: draft.id, gap: 0, items: "center" }, [
  ui.box({ flex: 1 }, [
    ui.column({ gap: 0 }, [
      ui.text(draft.name),
      ui.text(formatBytes(draft.size), { style: { dim: true } }),
    ]),
  ]),
  actionButton(`remove-draft-${draft.id}`, "✕", () => actions.removeDraft(draft.id), "warning"),
])

const renderDraftSummary = (drafts: DraftItem[]) => denseSection({
  id: "drafts-summary",
  title: "Total",
  border: "single",
}, [
  ui.row({ gap: 1, wrap: true }, summarizeStates(drafts, () => "draft", draft => draft.size, ["draft"]).map(renderSummaryStat)),
])

const renderHighlightedPreviewPath = (value: string, prefixLength: number, indices: number[], selected: boolean, options: { id?: string; key?: string; flex?: number } = {}) => ui.row({
  gap: 0,
  wrap: true,
  ...(options.id === undefined ? {} : { id: options.id }),
  ...(options.key === undefined ? {} : { key: options.key }),
  ...(options.flex === undefined ? {} : { flex: options.flex }),
}, previewPathSegments(value, prefixLength, indices).map((segment, index) =>
  ui.text(segment.text, { key: `segment-${index}`, style: previewSegmentStyle(segment, selected) }),
))

const renderFilePreviewRow = (match: FileSearchMatch, index: number, selected: boolean, displayPrefix: string) => ui.row({
  id: `file-preview-row-${index}`,
  key: `${match.kind}:${match.relativePath}`,
  gap: 1,
  wrap: true,
}, [
  ui.text(selected ? ">" : " ", { style: selected ? PREVIEW_SELECTED_MARKER_STYLE : PREVIEW_PATH_STYLE }),
  renderHighlightedPreviewPath(
    formatFileSearchDisplayPath(displayPrefix, match.relativePath),
    Array.from(formatFileSearchDisplayPath(displayPrefix, "")).length,
    offsetFileSearchMatchIndices(displayPrefix, match.indices),
    selected,
    { id: `file-preview-path-${index}`, flex: 1 },
  ),
  match.kind === "file" && typeof match.size === "number" ? ui.text(formatBytes(match.size), { style: { dim: true } }) : null,
  match.kind === "directory" ? tightTag("dir", { variant: "info", bare: true }) : null,
])

const renderFilePreview = (state: TuiState) => {
  if (!filePreviewVisible(state)) return null
  const preview = state.filePreview
  const rows = visibleFilePreviewResults(preview)
  const matchCountText = `${countFormat.format(preview.results.length)} ${preview.results.length === 1 ? "match" : "matches"}`
  const statusText = preview.waiting
    ? "searching..."
    : preview.results.length
      ? matchCountText
      : "no matches"
  return denseSection({
    id: "draft-preview",
    border: "single",
  }, [
    ui.text(statusText, { id: "draft-preview-status", style: { dim: true } }),
    ui.text(preview.error || " ", { id: "draft-preview-error", style: { dim: true } }),
    rows.length ? ui.column({ gap: 0 }, rows.map((match, offset) => renderFilePreviewRow(match, preview.scrollTop + offset, preview.selectedIndex === preview.scrollTop + offset, preview.displayPrefix))) : null,
  ])
}

const renderSummaryStat = (stat: TransferSummaryStat) => {
  const countText = stat.countText ?? countFormat.format(stat.count)
  const sizeText = stat.sizeText ?? (stat.size ? formatBytes(stat.size) : "")
  const text = `${stat.label || stat.state} ${countText}${sizeText ? ` ${sizeText}` : ""}`
  const variant = stat.state === "duration" ? "default" : statusVariant(stat.state as TransferSnapshot["status"])
  return tightTag(text, { variant, bare: true })
}

const transferActionButtons = (transfer: TransferSnapshot, actions: TuiActions): VNode[] => {
  if (transfer.status === "pending") {
    return [
      actionButton(`reject-${transfer.id}`, "Reject", () => actions.rejectTransfer(transfer.id), "warning"),
      actionButton(`accept-${transfer.id}`, "Accept", () => actions.acceptTransfer(transfer.id), "success"),
    ]
  }
  if (!["complete", "rejected", "cancelled", "error"].includes(transfer.status)) {
    return [actionButton(`cancel-${transfer.id}`, "Cancel", () => actions.cancelTransfer(transfer.id), "warning")]
  }
  if (transfer.direction === "in" && transfer.status === "complete" && !transfer.savedAt) {
    return [actionButton(`save-${transfer.id}`, "Save", () => actions.saveTransfer(transfer.id), "success")]
  }
  return []
}

const renderTransferFact = (label: string, value: string) => ui.box({ minWidth: 12, border: "single", borderStyle: METRIC_BORDER_STYLE }, [
  ui.column({ gap: 0 }, [
    ui.text(label, { variant: "caption" }),
    ui.text(value),
  ]),
])

const transferPathLabel = (transfer: TransferSnapshot, peersById: Map<string, PeerSnapshot>) => peersById.get(transfer.peerId)?.pathLabel || "—"

const renderTransferRow = (transfer: TransferSnapshot, peersById: Map<string, PeerSnapshot>, actions: TuiActions, now = Date.now()) => {
  const hasStarted = !!transfer.startedAt
  const directionArrow = TRANSFER_DIRECTION_ARROW[transfer.direction]
  const actionButtons = transferActionButtons(transfer, actions)
  const facts = [
    renderTransferFact("Size", formatBytes(transfer.size)),
    renderTransferFact("Path", transferPathLabel(transfer, peersById)),
    renderTransferFact("Created", formatClockTime(transfer.createdAt)),
    !hasStarted ? renderTransferFact("Waiting", formatDuration(transferWaitDurationMs(transfer, now))) : null,
    hasStarted ? renderTransferFact("Start", formatClockTime(transfer.startedAt)) : null,
    hasStarted ? renderTransferFact("End", formatClockTime(transfer.endedAt)) : null,
    hasStarted ? renderTransferFact("Duration", formatDuration(transferActualDurationMs(transfer, now))) : null,
  ].filter(Boolean) as VNode[]

  return denseSection({
    id: `transfer-card-${transfer.id}`,
    key: transfer.id,
    titleNode: ui.row({ id: `transfer-title-row-${transfer.id}`, gap: 1, items: "center", wrap: true }, [
      ui.box({ id: `transfer-title-main-slot-${transfer.id}`, flex: 1, minWidth: 0, border: "none" }, [
        ui.row({ id: `transfer-title-main-${transfer.id}`, gap: 0, items: "center", wrap: true }, [
          ui.text(directionArrow.glyph, { style: directionArrow.style }),
          ui.text(` ${transfer.name}`, { variant: "heading" }),
        ]),
      ]),
      ui.row({ id: `transfer-badges-${transfer.id}`, gap: 1, items: "center", wrap: true }, [
        ui.status(transferStatusKind(transfer.status), { label: transfer.status, showLabel: true }),
        transfer.error ? tightTag("error", { variant: "error", bare: true }) : null,
      ]),
    ]),
  }, [
    ui.row({ gap: 0, wrap: true }, facts),
    ui.progress(transferProgress(transfer), { showPercent: true, label: `${percentFormat.format(transfer.progress)}%` }),
    transfer.error
      ? ui.box({ id: `transfer-error-${transfer.id}`, border: "none" }, [
          ui.callout(transfer.error, { variant: "error" }),
        ])
      : null,
    ui.row({ id: `transfer-footer-row-${transfer.id}`, gap: 1, items: "end", wrap: true }, [
      ui.box({ id: `transfer-live-slot-${transfer.id}`, flex: 1, minWidth: 0, border: "none" }, [
        ui.row({ id: `transfer-live-row-${transfer.id}`, gap: 0, wrap: true }, [
          renderTransferFact("Speed", hasStarted ? transfer.speedText : "—"),
          renderTransferFact("ETA", transfer.status === "sending" || transfer.status === "receiving" ? transfer.etaText : "—"),
        ]),
      ]),
      actionButtons.length
        ? ui.row({ id: `transfer-actions-${transfer.id}`, gap: 1, items: "end", wrap: true }, actionButtons)
        : null,
    ]),
  ])
}

const renderTransferGroup = (group: TransferGroup, peersById: Map<string, PeerSnapshot>, actions: TuiActions, now = Date.now()) => denseSection({
  key: `group-${group.key}`,
  title: group.name,
}, [
  ui.row({ gap: 1, wrap: true }, transferSummaryStats(group.items, now).map(renderSummaryStat)),
  ui.column({ gap: 0 }, group.items.map(transfer => renderTransferRow(transfer, peersById, actions, now))),
])

const renderTransferSection = (section: TransferSection, peersById: Map<string, PeerSnapshot>, actions: TuiActions, now = Date.now()) => {
  if (!section.items.length) return null
  const groups = groupTransfersByPeer(section.items, [...peersById.values()])
  const pendingOfferCount = section.title === "Pending" ? section.items.filter(isPendingOffer).length : 0
  const children: VNode[] = []
  if (groups.length > 1) {
    children.push(denseSection({ key: `${section.title}-total`, title: "Total" }, [
      ui.row({ gap: 1, wrap: true }, transferSummaryStats(section.items, now).map(renderSummaryStat)),
    ]))
  }
  children.push(...groups.map(group => renderTransferGroup(group, peersById, actions, now)))
  return denseSection({
    id: `${section.title.toLowerCase()}-card`,
    title: section.title,
    actions: section.title === "Pending"
      ? [actionButton("cancel-pending", "Cancel", actions.cancelPendingOffers, "warning", pendingOfferCount === 0)]
      : section.clearAction === "completed"
        ? [actionButton("clear-completed", "Clear", actions.clearCompleted, "warning")]
        : section.clearAction === "failed"
          ? [actionButton("clear-failed", "Clear", actions.clearFailed, "warning")]
          : [],
  }, children)
}

const renderFilesCard = (state: TuiState, actions: TuiActions) => denseSection({
  id: "files-card",
  title: "Files",
  actions: [
    ui.row({ id: "files-actions", gap: 1, items: "center", wrap: true }, [
      toggleButton("toggle-offer", "Offer", state.autoOfferOutgoing, actions.toggleAutoOffer),
      ui.row({ id: "files-mode-actions", gap: 0, items: "center" }, [
        toggleButton("toggle-accept", "Accept", state.autoAcceptIncoming, actions.toggleAutoAccept),
        toggleButton("toggle-save", "Save", state.autoSaveIncoming, actions.toggleAutoSave),
      ]),
      actionButton("clear-drafts", "Clear", actions.clearDrafts, "warning"),
    ]),
  ],
}, [
  ui.row({ id: "files-input-row", gap: 0, items: "center" }, [
    ui.box({ flex: 1 }, [
      ui.input({
        id: DRAFT_INPUT_ID,
        key: `draft-input-${state.draftInputKeyVersion}`,
        value: state.draftInput,
        placeholder: "path/to/file.txt",
        onInput: (value, cursor) => actions.setDraftInput(value, cursor),
      }),
    ]),
    actionButton("add-drafts", "Add", actions.addDrafts, "primary", !state.draftInput.trim()),
  ]),
  renderFilePreview(state),
  state.offeringDrafts ? ui.row({ gap: 0, items: "center" }, [ui.spinner({ label: "Offering drafts..." })]) : null,
  state.drafts.length > 1 ? renderDraftSummary(state.drafts) : null,
  state.drafts.length
    ? ui.box({ id: "drafts-view", maxHeight: 10, overflow: "scroll" }, [
        ui.column({ gap: 0 }, state.drafts.map(draft => renderDraftRow(draft, actions))),
      ])
    : null,
])

const renderLogRow = (log: LogEntry) => denseSection({
  key: log.id,
  title: log.kind,
  subtitle: timeFormat.format(log.at),
}, [
  ui.text(shortText(log.payload), { style: { dim: true } }),
])

const renderEventsCard = (state: TuiState, actions: TuiActions) => denseSection({
  id: "events-card",
  title: "Events",
  actions: [
    actionButton("copy-events", "Copy", actions.copyLogs, "secondary", !state.snapshot.logs.length),
    actionButton("clear-events", "Clear", actions.clearLogs, "warning", !state.snapshot.logs.length),
  ],
}, [
  ui.box({ id: "events-viewport", maxHeight: 24, overflow: "scroll", border: "none" }, [
    state.snapshot.logs.length
      ? ui.column({ gap: 0 }, state.snapshot.logs.slice(0, 20).map(renderLogRow))
      : ui.empty("No events"),
  ]),
])

const footerKeycapWidth = (keycap: string) => keycap.length + 2

const renderFooterHint = (id: string, keycap: string, label: string) => ui.row({ id, gap: 0, items: "center" }, [
  ui.box({ id: `${id}-keycap`, width: footerKeycapWidth(keycap), border: "none" }, [
    ui.kbd(keycap),
  ]),
  ui.text(` ${label}`, { style: { dim: true } }),
])

const renderFooter = (state: TuiState) => ui.statusBar({
  id: "footer-shell",
  left: [ui.callout(state.notice.text, { variant: state.notice.variant })],
  right: [
    ui.toolbar({ id: "footer-hints", gap: 3 }, [
      renderFooterHint("footer-hint-tab", "tab", "focus/accept"),
      renderFooterHint("footer-hint-enter", "enter", "accept/add"),
      renderFooterHint("footer-hint-ctrl-o", "ctrl+o", "overwrite"),
      renderFooterHint("footer-hint-ctrlc", "ctrl+c", "quit"),
    ]),
  ],
})

export const renderTuiView = (state: TuiState, actions: TuiActions): VNode => {
  const peers = visiblePeers(state.snapshot.peers, state.hideTerminalPeers)
  const peersById = new Map(peers.map(peer => [peer.id, peer] as const))
  const now = Date.now()
  const transferCards = transferSections(state.snapshot)
    .map(section => renderTransferSection(section, peersById, actions, now))
    .filter((section): section is VNode => !!section)

  const page = ui.page({
    header: renderHeader(state, actions),
    body: ui.row({ id: "body-shell", gap: 1, items: "stretch", flex: 1, minHeight: 0 }, [
      ui.column({ id: "sidebar", width: 45, minWidth: 36, maxWidth: 51, gap: 0, minHeight: 0 }, [
        renderRoomCard(state, actions),
        renderSelfCard(state, actions),
        renderPeersCard(state, actions),
      ]),
      ui.box({ id: "main-scroll", flex: 1, minHeight: 0, overflow: "scroll", border: "none" }, [
        ui.column({ gap: 0 }, [
          renderFilesCard(state, actions),
          ...transferCards,
        ]),
      ]),
      state.eventsExpanded ? ui.box({ id: "events-shell", width: 28, minHeight: 0, border: "none" }, [renderEventsCard(state, actions)]) : null,
    ]),
    footer: renderFooter(state),
    p: 0,
    gap: 0,
  })

  const basePage = state.pendingFocusTarget
    ? ui.focusTrap({
        id: `focus-request-${state.focusRequestEpoch}`,
        key: `focus-request-${state.focusRequestEpoch}`,
        active: true,
        initialFocus: state.pendingFocusTarget,
      }, [page])
    : page

  const overlays = [
    state.inviteDropdownOpen && !state.aboutOpen ? renderInviteDropdown(state, actions) : null,
    state.aboutOpen ? renderAboutModal(state, actions) : null,
  ].filter((overlay): overlay is VNode => !!overlay)

  return overlays.length ? ui.layers([basePage, ...overlays]) : basePage
}

const withNotice = (state: TuiState, notice: Notice): TuiState => ({ ...state, notice })

export const withAcceptedDraftInput = (state: TuiState, draftInput: string, filePreview: FilePreviewState, notice: Notice): TuiState =>
  withNotice({
    ...state,
    draftInput,
    draftInputKeyVersion: state.draftInputKeyVersion + 1,
    draftHistory: resetDraftHistoryBrowse(state.draftHistory),
    filePreview,
    pendingFocusTarget: DRAFT_INPUT_ID,
    focusRequestEpoch: state.focusRequestEpoch + 1,
  }, notice)

export const resolveLaunchDrafts = async (paths: readonly string[]) => {
  const draftPaths = paths.map(path => `${path}`.trim()).filter(Boolean)
  if (!draftPaths.length) return { drafts: [] as DraftItem[], notice: null as Notice | null }
  const { files, errors } = await inspectLocalPaths(draftPaths)
  const createdAt = Date.now()
  const drafts = files.map((file, index) => ({
    id: uid(10),
    path: file.path,
    name: file.name,
    size: file.size,
    createdAt: createdAt + index,
  }))
  if (!drafts.length) {
    return {
      drafts,
      notice: { text: `Skipped ${plural(errors.length, "invalid path")}.`, variant: "error" } satisfies Notice,
    }
  }
  if (errors.length) {
    return {
      drafts,
      notice: { text: `Added ${plural(drafts.length, "draft file")} · skipped ${plural(errors.length, "invalid path")}.`, variant: "warning" } satisfies Notice,
    }
  }
  return {
    drafts,
    notice: { text: `Added ${plural(drafts.length, "draft file")}.`, variant: "success" } satisfies Notice,
  }
}

export const startTui = async (initialConfig: SessionConfig, launchOptions: TuiLaunchOptions = {}) => {
  await installCheckboxClickPatch()
  const launchDrafts = await resolveLaunchDrafts(launchOptions.draftPaths ?? [])
  const baseInitialState = createInitialTuiState(initialConfig, !!launchOptions.events, launchOptions)
  const initialState = {
    ...baseInitialState,
    drafts: launchDrafts.drafts.length ? launchDrafts.drafts : baseInitialState.drafts,
    notice: launchDrafts.notice ?? baseInitialState.notice,
  }
  const app = createSendNodeApp<TuiState>({ initialState, config: TUI_NODE_APP_CONFIG })
  const quitController = createQuitController()
  let state = initialState
  let unsubscribe = () => {}
  let stopping = false
  let cleanedUp = false
  let updateQueued = false
  const previewBaseRoot = process.cwd()
  let previewWorker: Worker | null = null
  let previewSessionId: string | null = null
  let previewSessionRoot: string | null = null
  let draftCursor = state.draftInput.length
  let draftCursorBeforeEvent = draftCursor
  let osc52SupportPromise: Promise<boolean> | null = null

  const ensureOsc52Support = () => osc52SupportPromise ??= app.backend.getCaps().then(caps => caps.supportsOsc52, () => false)
  const openExternalUrl = (url: string) => {
    try {
      const bun = getBunRuntime()
      const child = bun?.spawn?.(externalOpenCommand(url), { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
      if (!child) return false
      child.unref?.()
      return true
    } catch {
      return false
    }
  }
  const copyTextPayload = async (payload: string, notices: { copied: string; opened: string; failed: string }, finish = (notice: Notice) => commit(current => withNotice(current, notice))) => {
    const rawWrite = getBackendRawWriter(app.backend)
    if (rawWrite && await ensureOsc52Support()) {
      const sequence = buildOsc52ClipboardSequence(payload)
      if (sequence) {
        try {
          rawWrite(sequence)
          finish({ text: notices.copied, variant: "success" })
          return
        } catch {}
      }
    }
    const opened = openExternalUrl(inviteCopyUrl(payload))
    finish(opened
      ? { text: notices.opened, variant: "info" }
      : { text: notices.failed, variant: "error" })
  }
  const copyInvitePayload = async (payload: string, label: "WEB" | "CLI") => {
    const closeDropdown = (notice: Notice) => commit(current => withNotice({ ...current, inviteDropdownOpen: false }, notice))
    await copyTextPayload(payload, {
      copied: `Copied ${label} invite.`,
      opened: `Opened ${label} copy link.`,
      failed: `Unable to copy ${label} invite.`,
    }, closeDropdown)
  }

  const flushUpdate = () => {
    if (updateQueued || stopping || cleanedUp) return
    updateQueued = true
    queueMicrotask(() => {
      updateQueued = false
      if (stopping || cleanedUp) return
      try {
        app.update(state)
      } catch (error) {
        const message = error instanceof Error ? error.message : `${error}`
        if (message.includes("lifecycle operation already in flight")) {
          setTimeout(flushUpdate, 0)
          return
        }
        if (message.includes("app is Disposed")) return
        throw error
      }
    })
  }

  const commit = (updater: TuiState | ((prev: Readonly<TuiState>) => TuiState)) => {
    state = typeof updater === "function" ? updater(state) : updater
    flushUpdate()
    return state
  }

  const requestStop = () => {
    if (stopping) return
    stopping = true
    quitController.requestStop()
  }

  const resetFilePreview = (overrides: Partial<FilePreviewState> = {}): FilePreviewState => ({
    ...emptyFilePreviewState(),
    ...overrides,
  })
  const exitDraftHistoryBrowse = () => commit(current =>
    current.draftHistory.index == null && current.draftHistory.baseInput == null
      ? current
      : { ...current, draftHistory: resetDraftHistoryBrowse(current.draftHistory) })

  const ensurePreviewSession = (workspaceRoot: string) => {
    if (previewWorker && previewSessionId && previewSessionRoot === workspaceRoot) return
    if (previewWorker || previewSessionId) stopPreviewSession()
    previewSessionId = uid(8)
    previewSessionRoot = workspaceRoot
    previewWorker = new Worker(new URL("./file-search.worker.ts", import.meta.url).href, { type: "module" })
    previewWorker.onmessage = ({ data }: MessageEvent<FileSearchEvent>) => {
      if (!previewSessionId || data.sessionId !== previewSessionId) return
      if (data.type === "update") {
        commit(current => {
          if (current.filePreview.pendingQuery !== data.query || current.filePreview.workspaceRoot !== previewSessionRoot) return current
          const selectedIndex = clampFilePreviewSelectedIndex(current.filePreview.selectedIndex, data.matches.length)
          return {
            ...current,
            filePreview: {
              ...current.filePreview,
              displayQuery: data.query,
              pendingQuery: data.query,
              waiting: !data.walkComplete,
              error: null,
              results: data.matches,
              selectedIndex,
              scrollTop: ensureFilePreviewScrollTop(selectedIndex, current.filePreview.scrollTop, data.matches.length),
            },
          }
        })
        return
      }
      if (data.type === "complete") {
        commit(current => {
          if (current.filePreview.pendingQuery !== data.query || current.filePreview.workspaceRoot !== previewSessionRoot) return current
          return {
            ...current,
            filePreview: {
              ...current.filePreview,
              displayQuery: data.query,
              waiting: false,
              error: null,
            },
          }
        })
        return
      }
      commit(current => {
        if (current.filePreview.pendingQuery !== data.query || current.filePreview.workspaceRoot !== previewSessionRoot) return current
        return {
          ...current,
          filePreview: {
            ...current.filePreview,
            waiting: false,
            error: data.message,
            displayQuery: data.query,
          },
        }
      })
    }
    previewWorker.onerror = event => {
      commit(current => ({
        ...current,
        filePreview: {
          ...current.filePreview,
          waiting: false,
          error: event.message || "File preview worker failed.",
        },
      }))
    }
    previewWorker.postMessage({
      type: "create-session",
      sessionId: previewSessionId,
      workspaceRoot,
    } satisfies FileSearchRequest)
  }

  const stopPreviewSession = () => {
    if (!previewWorker || !previewSessionId) return
    previewWorker.postMessage({ type: "dispose-session", sessionId: previewSessionId } satisfies FileSearchRequest)
    previewWorker.terminate()
    previewWorker = null
    previewSessionId = null
    previewSessionRoot = null
  }

  const requestFilePreview = (value: string) => {
    const scope = deriveFileSearchScope(value, previewBaseRoot)
    if (!scope) {
      stopPreviewSession()
      return null
    }
    ensurePreviewSession(scope.workspaceRoot)
    if (!previewWorker || !previewSessionId) return
    previewWorker.postMessage({ type: "update-query", sessionId: previewSessionId, query: scope.query } satisfies FileSearchRequest)
    return scope
  }

  const applyDraftInputValue = (value: string, options: { cursor?: number; history?: DraftHistoryState } = {}) => {
    const nextValue = normalizeSearchQuery(value)
    if (options.cursor !== undefined) draftCursor = Math.min(options.cursor, nextValue.length)
    const scope = deriveFileSearchScope(nextValue, previewBaseRoot)
    const shouldDispose = !scope || state.filePreview.dismissedQuery === nextValue
    commit(current => {
      const draftHistory = options.history ?? resetDraftHistoryBrowse(current.draftHistory)
      if (!scope) return { ...current, draftInput: nextValue, draftHistory, filePreview: resetFilePreview() }
      const shouldDismiss = current.filePreview.dismissedQuery === nextValue
      const rootChanged = current.filePreview.workspaceRoot !== scope.workspaceRoot
      const basePreview = rootChanged ? resetFilePreview() : current.filePreview
      return {
        ...current,
        draftInput: nextValue,
        draftHistory,
        filePreview: {
          ...basePreview,
          workspaceRoot: scope.workspaceRoot,
          displayPrefix: scope.displayPrefix,
          dismissedQuery: shouldDismiss ? current.filePreview.dismissedQuery : null,
          pendingQuery: shouldDismiss ? current.filePreview.pendingQuery : scope.query,
          waiting: shouldDismiss ? false : true,
          error: null,
        },
      }
    })
    if (shouldDispose) {
      stopPreviewSession()
      return
    }
    requestFilePreview(nextValue)
  }

  const updateDraftInput = (value: string, cursor = draftCursor) => {
    applyDraftInputValue(value, { cursor })
  }

  const recallDraftHistory = (direction: -1 | 1) => {
    const next = moveDraftHistory(state.draftHistory, state.draftInput, direction)
    if (!next.changed) return false
    draftCursorBeforeEvent = 0
    applyDraftInputValue(next.value, { cursor: 0, history: next.history })
    return true
  }

  const acceptSelectedFilePreview = () => {
    const match = selectedFilePreviewMatch(state)
    if (!match || !filePreviewVisible(state)) return false
    const displayPath = formatFileSearchDisplayPath(state.filePreview.displayPrefix, match.relativePath)
    if (match.kind === "directory") {
      const nextValue = `${displayPath}/`
      const nextScope = deriveFileSearchScope(nextValue, previewBaseRoot)
      if (!nextScope) return false
      commit(current => withAcceptedDraftInput(current, nextValue, {
        ...resetFilePreview(),
        workspaceRoot: nextScope.workspaceRoot,
        displayPrefix: nextScope.displayPrefix,
        dismissedQuery: null,
        pendingQuery: nextScope.query,
        waiting: true,
        error: null,
        selectedIndex: null,
        scrollTop: 0,
      }, { text: `Browsing ${nextValue}`, variant: "info" }))
      draftCursor = nextValue.length
      draftCursorBeforeEvent = draftCursor
      requestFilePreview(nextValue)
      return true
    }
    commit(current => withAcceptedDraftInput(
      current,
      displayPath,
      resetFilePreview({ dismissedQuery: displayPath }),
      { text: `Selected ${displayPath}.`, variant: "success" },
    ))
    draftCursor = displayPath.length
    draftCursorBeforeEvent = draftCursor
    stopPreviewSession()
    return true
  }

  const maybeOfferDrafts = () => {
    if (!state.autoOfferOutgoing || !state.drafts.length || state.offeringDrafts) return
    const targetPeerIds = renderedReadySelectedPeers(state.snapshot.peers, state.hideTerminalPeers, state.peerSearch).map(peer => peer.id)
    if (!targetPeerIds.length) return
    const session = state.session
    const pendingDrafts = [...state.drafts]
    commit(current => ({ ...current, offeringDrafts: true }))
    void session.queueFiles(pendingDrafts.map(draft => draft.path), targetPeerIds).then(
      ids => {
        if (state.session !== session) return
        const offeredIds = new Set(pendingDrafts.map(draft => draft.id))
        commit(current => withNotice({
          ...current,
          drafts: current.drafts.filter(draft => !offeredIds.has(draft.id)),
          offeringDrafts: false,
        }, { text: `Queued ${plural(ids.length, "transfer")}.`, variant: "success" }))
      },
      error => {
        if (state.session !== session) return
        commit(current => withNotice({ ...current, offeringDrafts: false }, { text: `${error}`, variant: "error" }))
      },
    )
  }

  const bindSession = (session: SendSession) => {
    unsubscribe()
    unsubscribe = session.subscribe(() => {
      commit(current => current.session === session ? { ...current, snapshot: session.snapshot() } : current)
      maybeOfferDrafts()
    })
    commit(current => current.session === session ? { ...current, snapshot: session.snapshot() } : current)
    void session.connect().catch(error => {
      if (state.session !== session || stopping || cleanedUp || isSessionAbortedError(error)) return
      commit(current => withNotice(current, { text: `${error}`, variant: "error" }))
    })
  }

  const replaceSession = (nextSeed: SessionSeed, text: string, options: { reseedBootFocus?: boolean } = {}) => {
    const previousSession = state.session
    const nextSession = makeSession(nextSeed, state.autoAcceptIncoming, state.autoSaveIncoming, roomPeerSelectionMemory(state.peerSelectionByRoom, nextSeed.room))
    stopPreviewSession()
    commit(current => withNotice({
      ...current,
      session: nextSession,
      sessionSeed: nextSeed,
      peerSelectionByRoom: current.peerSelectionByRoom,
      snapshot: nextSession.snapshot(),
      inviteDropdownOpen: false,
      peerSearch: "",
      roomInput: nextSeed.room,
      nameInput: visibleNameInput(nextSeed.name),
      draftInput: "",
      draftHistory: resetDraftHistoryBrowse(current.draftHistory),
      filePreview: resetFilePreview(),
      drafts: [],
      offeringDrafts: false,
      overwriteIncoming: !!nextSeed.overwriteIncoming,
      ...(options.reseedBootFocus
        ? deriveBootFocusState(nextSeed.name, current.focusRequestEpoch + 1)
        : {
            pendingFocusTarget: current.pendingFocusTarget,
            focusRequestEpoch: current.focusRequestEpoch,
            bootNameJumpPending: current.bootNameJumpPending,
        }),
    }, { text, variant: "success" }))
    draftCursor = 0
    draftCursorBeforeEvent = 0
    bindSession(nextSession)
    void previousSession.close()
  }

  const commitRoom = () => {
    const nextRoom = cleanRoom(state.roomInput)
    if (nextRoom === state.sessionSeed.room) {
      commit(current => current.roomInput === nextRoom ? current : withNotice({ ...current, roomInput: nextRoom }, { text: `Room ${nextRoom}.`, variant: "info" }))
      return
    }
    replaceSession({ ...state.sessionSeed, room: nextRoom }, `Joined room ${nextRoom}.`)
    draftCursor = 0
  }

  const commitName = () => {
    const nextName = state.session.setName(state.nameInput)
    commit(current => scheduleBootNameJump(withNotice({
      ...current,
      nameInput: visibleNameInput(nextName),
      sessionSeed: { ...current.sessionSeed, name: nextName },
      snapshot: current.session.snapshot(),
    }, { text: `Self name is ${nextName}.`, variant: "success" })))
  }

  const addDrafts = () => {
    const submittedInput = state.draftInput
    if (!normalizeSearchQuery(submittedInput)) {
      commit(current => withNotice(current, { text: "No file paths entered.", variant: "warning" }))
      return
    }
    void inspectLocalFile(submittedInput).then(file => {
      const shouldDispose = state.draftInput === submittedInput
      const created = {
        id: uid(10),
        path: file.path,
        name: file.name,
        size: file.size,
        createdAt: Date.now(),
      }
      commit(current => withNotice({
        ...current,
        draftInput: current.draftInput === submittedInput ? "" : current.draftInput,
        draftHistory: pushDraftHistoryEntry(current.draftHistory, submittedInput),
        filePreview: current.draftInput === submittedInput ? resetFilePreview() : current.filePreview,
        drafts: [...current.drafts, created],
      }, { text: `Added ${plural(1, "draft file")}.`, variant: "success" }))
      if (shouldDispose) {
        draftCursor = 0
        draftCursorBeforeEvent = 0
      }
      if (shouldDispose) stopPreviewSession()
      maybeOfferDrafts()
    }, error => {
      commit(current => withNotice(current, { text: `${error}`, variant: "error" }))
    })
  }

  const actions: TuiActions = {
    toggleEvents: () => commit(current => ({ ...withNotice(current, { text: current.eventsExpanded ? "Events hidden." : "Events shown.", variant: "info" }), eventsExpanded: !current.eventsExpanded })),
    openAbout: () => commit(current => ({ ...current, aboutOpen: true, inviteDropdownOpen: false })),
    closeAbout: () => commit(current => ({ ...current, aboutOpen: false })),
    toggleInviteDropdown: () => commit(current => ({ ...current, inviteDropdownOpen: !current.inviteDropdownOpen })),
    closeInviteDropdown: () => commit(current => current.inviteDropdownOpen ? { ...current, inviteDropdownOpen: false } : current),
    copyWebInvite: () => { void copyInvitePayload(webInviteUrl(state), "WEB") },
    copyCliInvite: () => { void copyInvitePayload(inviteCliText(state), "CLI") },
    copyLogs: () => {
      const payload = formatLogsForCopy(state.snapshot.logs)
      if (!payload) return
      void copyTextPayload(payload, {
        copied: "Copied events.",
        opened: "Opened event copy link.",
        failed: "Unable to copy events.",
      })
    },
    jumpToRandomRoom: () => replaceSession({ ...state.sessionSeed, room: uid(8) }, "Joined a new room."),
    commitRoom,
    setRoomInput: value => commit(current => ({ ...current, roomInput: value })),
    jumpToNewSelf: () => replaceSession({ ...state.sessionSeed, localId: cleanLocalId(uid(8)) }, "Started a fresh self ID.", { reseedBootFocus: true }),
    commitName,
    setNameInput: value => commit(current => ({ ...current, nameInput: value })),
    setPeerSearch: value => commit(current => ({ ...current, peerSearch: value })),
    toggleSelectReadyPeers: () => {
      const peers = renderedPeers(state.snapshot.peers, state.hideTerminalPeers, state.peerSearch)
      let changed = 0
      for (const peer of peers) if (state.session.setPeerSelected(peer.id, peer.presence === "active" && peer.ready)) changed += 1
      commit(current => withNotice(current, { text: changed ? "Selected matching ready peers." : "No matching ready peers to select.", variant: changed ? "success" : "info" }))
      maybeOfferDrafts()
    },
    clearPeerSelection: () => {
      const peers = renderedPeers(state.snapshot.peers, state.hideTerminalPeers, state.peerSearch)
      let changed = 0
      for (const peer of peers) if (state.session.setPeerSelected(peer.id, false)) changed += 1
      commit(current => withNotice(current, { text: changed ? `Cleared ${plural(changed, "matching peer selection")}.` : "No matching peer selections to clear.", variant: changed ? "warning" : "info" }))
    },
    toggleHideTerminalPeers: () => commit(current => withNotice({ ...current, hideTerminalPeers: !current.hideTerminalPeers }, { text: current.hideTerminalPeers ? "All peers shown." : "Only connected peers shown.", variant: "info" })),
    togglePeer: peerId => {
      state.session.togglePeerSelection(peerId)
      maybeOfferDrafts()
    },
    shareTurnWithPeer: peerId => {
      const peer = state.snapshot.peers.find(item => item.id === peerId)
      const sent = state.session.shareTurnWithPeer(peerId)
      commit(current => withNotice(current, {
        text: !state.session.canShareTurn()
          ? "TURN is not configured."
          : sent
            ? `Shared TURN with ${peer?.displayName ?? peerId}.`
            : `Unable to share TURN with ${peer?.displayName ?? peerId}.`,
        variant: !state.session.canShareTurn() ? "info" : sent ? "success" : "warning",
      }))
    },
    shareTurnWithAllPeers: () => {
      const targetPeerIds = renderedPeers(state.snapshot.peers, state.hideTerminalPeers, state.peerSearch)
        .filter(peer => peer.presence === "active")
        .map(peer => peer.id)
      const shared = state.session.shareTurnWithPeers(targetPeerIds)
      commit(current => withNotice(current, {
        text: !state.session.canShareTurn()
          ? "TURN is not configured."
          : shared
            ? `Shared TURN with ${plural(shared, "matching peer")}.`
            : "No matching active peers to share TURN with.",
        variant: !state.session.canShareTurn() ? "info" : shared ? "success" : "info",
      }))
    },
    toggleAutoOffer: () => {
      commit(current => withNotice({ ...current, autoOfferOutgoing: !current.autoOfferOutgoing }, { text: !state.autoOfferOutgoing ? "Auto-offer on." : "Auto-offer off.", variant: !state.autoOfferOutgoing ? "success" : "warning" }))
      maybeOfferDrafts()
    },
    toggleAutoAccept: () => {
      const next = !state.autoAcceptIncoming
      commit(current => ({ ...current, autoAcceptIncoming: next }))
      void state.session.setAutoAcceptIncoming(next).then(
        count => commit(current => withNotice(current, { text: next ? `Auto-accept on${count ? ` · accepted ${plural(count, "transfer")}` : ""}.` : "Auto-accept off.", variant: next ? "success" : "warning" })),
        error => commit(current => withNotice(current, { text: `${error}`, variant: "error" })),
      )
    },
    toggleAutoSave: () => {
      const next = !state.autoSaveIncoming
      commit(current => ({ ...current, autoSaveIncoming: next }))
      void state.session.setAutoSaveIncoming(next).then(
        count => commit(current => withNotice(current, { text: next ? `Auto-save on${count ? ` · saved ${plural(count, "transfer")}` : ""}.` : "Auto-save off.", variant: next ? "success" : "warning" })),
        error => commit(current => withNotice(current, { text: `${error}`, variant: "error" })),
      )
    },
    toggleOverwrite: () => {
      const next = !state.overwriteIncoming
      state.session.setOverwriteIncoming(next)
      commit(current => withNotice({
        ...current,
        overwriteIncoming: next,
        sessionSeed: { ...current.sessionSeed, overwriteIncoming: next },
      }, { text: next ? "Overwrite on." : "Overwrite off.", variant: next ? "success" : "warning" }))
    },
    setDraftInput: (value, cursor) => updateDraftInput(value, cursor),
    addDrafts,
    removeDraft: draftId => commit(current => withNotice({ ...current, drafts: current.drafts.filter(draft => draft.id !== draftId) }, { text: "Draft removed.", variant: "warning" })),
    clearDrafts: () => commit(current => withNotice({ ...current, drafts: [] }, { text: current.drafts.length ? `Cleared ${plural(current.drafts.length, "draft file")}.` : "No drafts to clear.", variant: current.drafts.length ? "warning" : "info" })),
    cancelPendingOffers: () => {
      const cancelled = state.session.cancelPendingOffers()
      commit(current => withNotice(current, {
        text: cancelled ? `Cancelled ${plural(cancelled, "pending offer")}.` : "No pending offers to cancel.",
        variant: cancelled ? "warning" : "info",
      }))
    },
    acceptTransfer: transferId => {
      const transfer = state.snapshot.transfers.find(item => item.id === transferId)
      void state.session.acceptTransfer(transferId).then(ok => {
        commit(current => withNotice(current, { text: ok ? `Accepted ${transfer?.name ?? "transfer"}.` : `Unable to accept ${transfer?.name ?? "transfer"}.`, variant: ok ? "success" : "error" }))
      })
    },
    rejectTransfer: transferId => {
      const transfer = state.snapshot.transfers.find(item => item.id === transferId)
      const ok = state.session.rejectTransfer(transferId)
      commit(current => withNotice(current, { text: ok ? `Rejected ${transfer?.name ?? "transfer"}.` : `Unable to reject ${transfer?.name ?? "transfer"}.`, variant: ok ? "warning" : "error" }))
    },
    cancelTransfer: transferId => {
      const transfer = state.snapshot.transfers.find(item => item.id === transferId)
      const ok = state.session.cancelTransfer(transferId)
      commit(current => withNotice(current, { text: ok ? `Cancelled ${transfer?.name ?? "transfer"}.` : `Unable to cancel ${transfer?.name ?? "transfer"}.`, variant: ok ? "warning" : "error" }))
    },
    saveTransfer: transferId => {
      const transfer = state.snapshot.transfers.find(item => item.id === transferId)
      void state.session.saveTransfer(transferId).then(path => {
        commit(current => withNotice(current, { text: path ? `Saved ${transfer?.name ?? "transfer"} to ${path}.` : `Unable to save ${transfer?.name ?? "transfer"}.`, variant: path ? "success" : "error" }))
      })
    },
    clearCompleted: () => {
      const cleared = state.session.clearCompletedTransfers()
      commit(current => withNotice(current, { text: cleared ? `Cleared ${plural(cleared, "completed transfer")}.` : "No completed transfers to clear.", variant: cleared ? "warning" : "info" }))
    },
    clearFailed: () => {
      const cleared = state.session.clearFailedTransfers()
      commit(current => withNotice(current, { text: cleared ? `Cleared ${plural(cleared, "failed transfer")}.` : "No failed transfers to clear.", variant: cleared ? "warning" : "info" }))
    },
    clearLogs: () => {
      state.session.clearLogs()
      commit(current => withNotice(current, { text: "Events cleared.", variant: "warning" }))
    },
  }

  app.view(model => renderTuiView(model, actions))
  app.onEvent((event: UiEvent) => {
    if (event.kind !== "engine" || state.focusedId !== DRAFT_INPUT_ID) return
    draftCursorBeforeEvent = draftCursor
    const edit = applyInputEditEvent(event.event, {
      id: DRAFT_INPUT_ID,
      value: state.draftInput,
      cursor: draftCursor,
      selectionStart: null,
      selectionEnd: null,
      multiline: false,
    })
    if (!edit) return
    draftCursor = edit.nextCursor
    if (!edit.action && state.draftHistory.index != null && draftCursor !== 0) exitDraftHistoryBrowse()
  })
  app.onFocusChange(info => {
    const previousFocusedId = state.focusedId
    commit(current => {
      const next = { ...current, focusedId: info.id }
      return info.id === current.pendingFocusTarget ? consumeSatisfiedFocusRequest(next, info.id) : next
    })
    if (previousFocusedId === DRAFT_INPUT_ID && info.id !== DRAFT_INPUT_ID) {
      stopPreviewSession()
      commit(current => ({
        ...current,
        draftHistory: resetDraftHistoryBrowse(current.draftHistory),
        filePreview: resetFilePreview({
          dismissedQuery: current.filePreview.dismissedQuery === current.draftInput ? current.draftInput : null,
        }),
      }))
      return
    }
    if (info.id === DRAFT_INPUT_ID) {
      const scope = deriveFileSearchScope(state.draftInput, previewBaseRoot)
      if (scope && state.filePreview.dismissedQuery !== state.draftInput && (state.filePreview.pendingQuery !== scope.query || state.filePreview.workspaceRoot !== scope.workspaceRoot || state.filePreview.displayPrefix !== scope.displayPrefix)) {
        commit(current => ({
          ...current,
          filePreview: {
            ...(current.filePreview.workspaceRoot === scope.workspaceRoot ? current.filePreview : resetFilePreview()),
            workspaceRoot: scope.workspaceRoot,
            displayPrefix: scope.displayPrefix,
            pendingQuery: scope.query,
            waiting: true,
            error: null,
          },
        }))
        requestFilePreview(state.draftInput)
      }
    }
  })
  app.keys({
    "ctrl+c": { description: "Quit", handler: requestStop },
    q: {
      description: "no-op",
      when: ctx => shouldSwallowQQuit(ctx.focusedId),
      handler: noop,
    },
    tab: {
      description: "Accept focused preview row",
      when: ctx => ctx.focusedId === DRAFT_INPUT_ID && !!selectedFilePreviewMatch(state) && filePreviewVisible(state),
      handler: () => {
        acceptSelectedFilePreview()
      },
    },
    right: {
      description: "Accept focused preview row at end of Files input",
      when: ctx => canAcceptFilePreviewWithRight(state, draftCursorBeforeEvent) && ctx.focusedId === DRAFT_INPUT_ID,
      handler: () => {
        acceptSelectedFilePreview()
      },
    },
    up: {
      description: "Recall history or move file preview selection up",
      when: ctx => ctx.focusedId === DRAFT_INPUT_ID && (canNavigateDraftHistory(state.draftHistory, state.draftInput, draftCursorBeforeEvent, previewBaseRoot) || filePreviewVisible(state) && state.filePreview.results.length > 0),
      handler: () => {
        if (canNavigateDraftHistory(state.draftHistory, state.draftInput, draftCursorBeforeEvent, previewBaseRoot) && recallDraftHistory(-1)) return
        commit(current => ({ ...current, filePreview: moveFilePreviewSelection(current.filePreview, -1) }))
      },
    },
    down: {
      description: "Recall history or move file preview selection down",
      when: ctx => ctx.focusedId === DRAFT_INPUT_ID && (canNavigateDraftHistory(state.draftHistory, state.draftInput, draftCursorBeforeEvent, previewBaseRoot) || filePreviewVisible(state) && state.filePreview.results.length > 0),
      handler: () => {
        if (canNavigateDraftHistory(state.draftHistory, state.draftInput, draftCursorBeforeEvent, previewBaseRoot) && recallDraftHistory(1)) return
        commit(current => ({ ...current, filePreview: moveFilePreviewSelection(current.filePreview, 1) }))
      },
    },
    "ctrl+p": {
      description: "Move file preview selection up",
      when: ctx => ctx.focusedId === DRAFT_INPUT_ID && filePreviewVisible(state) && state.filePreview.results.length > 0,
      handler: () => {
        commit(current => ({ ...current, filePreview: moveFilePreviewSelection(current.filePreview, -1) }))
      },
    },
    "ctrl+n": {
      description: "Move file preview selection down",
      when: ctx => ctx.focusedId === DRAFT_INPUT_ID && filePreviewVisible(state) && state.filePreview.results.length > 0,
      handler: () => {
        commit(current => ({ ...current, filePreview: moveFilePreviewSelection(current.filePreview, 1) }))
      },
    },
    "ctrl+o": {
      description: "Toggle overwrite mode",
      handler: () => {
        actions.toggleOverwrite()
      },
    },
    enter: {
      description: "Commit focused input",
      when: ctx => ctx.focusedId === ROOM_INPUT_ID || ctx.focusedId === NAME_INPUT_ID || ctx.focusedId === DRAFT_INPUT_ID,
      handler: ctx => {
        if (ctx.focusedId === ROOM_INPUT_ID) commitRoom()
        if (ctx.focusedId === NAME_INPUT_ID) commitName()
        if (ctx.focusedId === DRAFT_INPUT_ID && !acceptSelectedFilePreview()) addDrafts()
      },
    },
    escape: {
      description: "Reset focused input",
      when: ctx => ctx.focusedId === ROOM_INPUT_ID || ctx.focusedId === NAME_INPUT_ID || ctx.focusedId === DRAFT_INPUT_ID,
      handler: ctx => {
        if (ctx.focusedId === ROOM_INPUT_ID) commit(current => withNotice({ ...current, roomInput: current.sessionSeed.room }, { text: "Room input reset.", variant: "warning" }))
        if (ctx.focusedId === NAME_INPUT_ID) commit(current => withNotice({ ...current, nameInput: visibleNameInput(current.snapshot.name) }, { text: "Name input reset.", variant: "warning" }))
        if (ctx.focusedId === DRAFT_INPUT_ID && filePreviewVisible(state)) {
          stopPreviewSession()
          exitDraftHistoryBrowse()
          commit(current => withNotice({
            ...current,
            filePreview: resetFilePreview({ dismissedQuery: current.draftInput }),
          }, { text: "File preview hidden.", variant: "warning" }))
        } else if (ctx.focusedId === DRAFT_INPUT_ID) {
          stopPreviewSession()
          draftCursor = 0
          commit(current => withNotice({ ...current, draftInput: "", draftHistory: resetDraftHistoryBrowse(current.draftHistory), filePreview: resetFilePreview() }, { text: "Draft input cleared.", variant: "warning" }))
        }
      },
    },
  })

  const stop = async () => {
    if (cleanedUp) return
    cleanedUp = true
    stopping = true
    unsubscribe()
    stopPreviewSession()
    try {
      await app.stop()
    } catch {}
    await state.session.close()
  }

  const printResumeOutput = async () => {
    const output = `${resumeOutputLines(state).join("\n")}\n`
    await new Promise<void>(resolve => process.stdout.write(output, () => resolve()))
  }

  try {
    bindSession(state.session)
    await app.start()
    void ensureOsc52Support()
    await quitController.promise
  } finally {
    try {
      await stop()
    } finally {
      try {
        app.dispose()
      } finally {
        await printResumeOutput()
        quitController.detach()
      }
    }
  }
}
