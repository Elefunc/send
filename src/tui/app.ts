import { rgb, ui, type BadgeVariant, type VNode } from "@rezi-ui/core"
import { createNodeApp } from "@rezi-ui/node"
import { inspectLocalFile } from "../core/files"
import { SendSession, type PeerSnapshot, type SessionConfig, type SessionSnapshot, type TransferSnapshot } from "../core/session"
import { cleanLocalId, cleanName, cleanRoom, displayPeerName, fallbackName, formatBytes, type LogEntry, peerDefaultsToken, type PeerProfile, uid } from "../core/protocol"
import { FILE_SEARCH_VISIBLE_ROWS, type FileSearchEvent, type FileSearchMatch, type FileSearchRequest } from "./file-search-protocol"
import { deriveFileSearchScope, formatFileSearchDisplayPath, normalizeSearchQuery, offsetFileSearchMatchIndices } from "./file-search"
import { installCheckboxClickPatch } from "../../runtime/rezi-checkbox-click"

type Notice = { text: string; variant: "info" | "success" | "warning" | "error" }
type DraftItem = { id: string; path: string; name: string; size: number; createdAt: number }
type SessionSeed = Omit<SessionConfig, "autoAcceptIncoming" | "autoSaveIncoming"> & { localId: string; name: string; room: string }
type TuiAction = () => void
type TransferSection = { title: string; items: TransferSnapshot[]; clearAction?: "completed" | "failed" }
type TransferSummaryStat = { state: string; label?: string; count: number; size: number; countText?: string; sizeText?: string }
type TransferGroup = { key: string; name: string; items: TransferSnapshot[] }
type DenseSectionChild = VNode | false | null | undefined
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

export type VisiblePane = "peers" | "transfers" | "logs"

export interface TuiState {
  session: SendSession
  sessionSeed: SessionSeed
  snapshot: SessionSnapshot
  focusedId: string | null
  roomInput: string
  nameInput: string
  pendingFocusTarget: string | null
  focusRequestEpoch: number
  bootNameJumpPending: boolean
  draftInput: string
  draftInputKeyVersion: number
  filePreview: FilePreviewState
  drafts: DraftItem[]
  autoOfferOutgoing: boolean
  autoAcceptIncoming: boolean
  autoSaveIncoming: boolean
  hideTerminalPeers: boolean
  eventsExpanded: boolean
  offeringDrafts: boolean
  notice: Notice
}

export interface TuiActions {
  toggleEvents: TuiAction
  jumpToRandomRoom: TuiAction
  commitRoom: TuiAction
  setRoomInput: (value: string) => void
  jumpToNewSelf: TuiAction
  commitName: TuiAction
  setNameInput: (value: string) => void
  toggleSelectReadyPeers: TuiAction
  clearPeerSelection: TuiAction
  toggleHideTerminalPeers: TuiAction
  togglePeer: (peerId: string) => void
  toggleAutoOffer: TuiAction
  toggleAutoAccept: TuiAction
  toggleAutoSave: TuiAction
  setDraftInput: (value: string) => void
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
const DRAFT_INPUT_ID = "draft-input"
const TRANSPARENT_BORDER_STYLE = { fg: rgb(7, 10, 12) } as const
const METRIC_BORDER_STYLE = { fg: rgb(20, 25, 32) } as const
const DEFAULT_WEB_URL = "https://send.rt.ht/"

const countFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })
const percentFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })
const pluralRules = new Intl.PluralRules()

export const visiblePanes = (showEvents: boolean): VisiblePane[] => showEvents ? ["peers", "transfers", "logs"] : ["peers", "transfers"]

const noop = () => {}

const hashBool = (value: boolean) => value ? "1" : "0"

export const resolveWebUrlBase = (value = process.env.SEND_WEB_URL) => {
  const candidate = `${value ?? ""}`.trim() || DEFAULT_WEB_URL
  try {
    return new URL(candidate).toString()
  } catch {
    return DEFAULT_WEB_URL
  }
}

export const webInviteUrl = (
  state: Pick<TuiState, "snapshot" | "hideTerminalPeers" | "autoAcceptIncoming" | "autoOfferOutgoing" | "autoSaveIncoming">,
  baseUrl = resolveWebUrlBase(),
) => {
  const url = new URL(baseUrl)
  url.hash = new URLSearchParams({
    room: cleanRoom(state.snapshot.room),
    clean: hashBool(state.hideTerminalPeers),
    accept: hashBool(state.autoAcceptIncoming),
    offer: hashBool(state.autoOfferOutgoing),
    save: hashBool(state.autoSaveIncoming),
  }).toString()
  return url.toString()
}

export const createNoopTuiActions = (): TuiActions => ({
  toggleEvents: noop,
  jumpToRandomRoom: noop,
  commitRoom: noop,
  setRoomInput: noop,
  jumpToNewSelf: noop,
  commitName: noop,
  setNameInput: noop,
  toggleSelectReadyPeers: noop,
  clearPeerSelection: noop,
  toggleHideTerminalPeers: noop,
  togglePeer: noop,
  toggleAutoOffer: noop,
  toggleAutoAccept: noop,
  toggleAutoSave: noop,
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
const visiblePeers = (peers: PeerSnapshot[], hideTerminalPeers: boolean) => hideTerminalPeers ? peers.filter(peer => peer.presence === "active") : peers
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
const statusToneVariant = (value: string): BadgeVariant => ({
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
  return token === "AS" ? "success" : token === "as" ? "warning" : token === "??" ? "default" : "info"
}
const TIGHT_TAG_COLORS = {
  default: rgb(89, 194, 255),
  success: rgb(170, 217, 76),
  warning: rgb(242, 169, 59),
  error: rgb(240, 113, 120),
  info: rgb(89, 194, 255),
} as const
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

const makeSession = (seed: SessionSeed, autoAcceptIncoming: boolean, autoSaveIncoming: boolean) => new SendSession({
  ...seed,
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
const highlightedSegments = (value: string, indices: number[]) => {
  const marks = new Set(indices)
  const chars = Array.from(value)
  const segments: Array<{ text: string; highlighted: boolean }> = []
  let current = ""
  let highlighted = false
  for (let index = 0; index < chars.length; index += 1) {
    const nextHighlighted = marks.has(index)
    if (current && nextHighlighted !== highlighted) {
      segments.push({ text: current, highlighted })
      current = ""
    }
    current += chars[index]
    highlighted = nextHighlighted
  }
  if (current) segments.push({ text: current, highlighted })
  return segments
}

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

export const createInitialTuiState = (initialConfig: SessionConfig, showEvents = false): TuiState => {
  const sessionSeed = normalizeSessionSeed(initialConfig)
  const autoAcceptIncoming = initialConfig.autoAcceptIncoming ?? true
  const autoSaveIncoming = initialConfig.autoSaveIncoming ?? true
  const session = makeSession(sessionSeed, autoAcceptIncoming, autoSaveIncoming)
  const focusState = deriveBootFocusState(sessionSeed.name)
  return {
    session,
    sessionSeed,
    snapshot: session.snapshot(),
    focusedId: null,
    roomInput: sessionSeed.room,
    nameInput: visibleNameInput(sessionSeed.name),
    ...focusState,
    draftInput: "",
    draftInputKeyVersion: 0,
    filePreview: emptyFilePreviewState(),
    drafts: [],
    autoOfferOutgoing: true,
    autoAcceptIncoming,
    autoSaveIncoming,
    hideTerminalPeers: true,
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
  actions: [toggleButton("toggle-events", "Events", state.eventsExpanded, actions.toggleEvents)],
}, [])

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
      ui.link({
        id: "room-invite-link",
        label: "📋",
        accessibleLabel: "Open invite link",
        url: webInviteUrl(state),
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
    renderSelfMetric("Signaling", state.snapshot.socketState),
    renderSelfMetric("Pulse", state.snapshot.pulse.state),
    renderSelfMetric("TURN", state.snapshot.turnState),
  ]),
  ui.column({ gap: 0 }, [
    renderSelfProfileLine(geoSummary(state.snapshot.profile)),
    renderSelfProfileLine(netSummary(state.snapshot.profile)),
    renderSelfProfileLine(uaSummary(state.snapshot.profile)),
    renderSelfProfileLine(profileIp(state.snapshot.profile)),
  ]),
])

const renderPeerRow = (peer: PeerSnapshot, actions: TuiActions) => denseSection({
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
        ui.text(peer.displayName, {
          id: `peer-name-text-${peer.id}`,
          textOverflow: "ellipsis",
        }),
      ]),
      ui.row({ id: `peer-status-cluster-${peer.id}`, gap: 1, items: "center" }, [
        ui.status(peerConnectionStatusKind(peer.status), { label: peer.status || "unknown", showLabel: true }),
        tightTag(peerDefaultsToken(peer.profile), { variant: peerDefaultsVariant(peer.profile), bare: true }),
      ]),
    ]),
    ui.row({ gap: 0 }, [
      renderPeerMetric("RTT", formatPeerRtt(peer.rttMs)),
      renderPeerMetric("Data", peer.dataState, true),
    ]),
    ui.row({ gap: 0 }, [
      renderPeerMetric("TURN", peer.turnState, true),
      renderPeerMetric("Path", peer.pathLabel || "—"),
    ]),
    ui.column({ gap: 0 }, [
      renderSelfProfileLine(geoSummary(peer.profile)),
      renderSelfProfileLine(netSummary(peer.profile)),
      renderSelfProfileLine(uaSummary(peer.profile)),
      renderSelfProfileLine(profileIp(peer.profile)),
    ]),
    peer.lastError ? ui.callout(peer.lastError, { variant: "error" }) : null,
  ]),
])

const renderPeersCard = (state: TuiState, actions: TuiActions) => {
  const peers = visiblePeers(state.snapshot.peers, state.hideTerminalPeers)
  const activeCount = state.snapshot.peers.filter(peer => peer.presence === "active").length
  const selectedCount = state.snapshot.peers.filter(peer => peer.selectable && peer.selected).length
  return denseSection({
    id: "peers-card",
    title: `Peers ${selectedCount}/${activeCount}`,
    flex: 1,
    actions: [
      actionButton("select-ready-peers", "All", actions.toggleSelectReadyPeers),
      actionButton("clear-peer-selection", "None", actions.clearPeerSelection),
      toggleButton("toggle-clean-peers", "Clean", state.hideTerminalPeers, actions.toggleHideTerminalPeers),
    ],
  }, [
    ui.box({ id: "peers-list", flex: 1, minHeight: 0, overflow: "scroll", border: "none" }, [
      peers.length
        ? ui.column({ gap: 0 }, peers.map(peer => renderPeerRow(peer, actions)))
        : ui.empty(`Waiting for peers in ${state.snapshot.room}...`),
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

const renderHighlightedPreviewPath = (value: string, indices: number[], options: { id?: string; key?: string; flex?: number } = {}) => ui.row({
  gap: 0,
  wrap: true,
  ...(options.id === undefined ? {} : { id: options.id }),
  ...(options.key === undefined ? {} : { key: options.key }),
  ...(options.flex === undefined ? {} : { flex: options.flex }),
}, highlightedSegments(value, indices).map((segment, index) =>
  ui.text(segment.text, { key: `segment-${index}`, ...(segment.highlighted ? { style: { bold: true } } : {}) }),
))

const renderFilePreviewRow = (match: FileSearchMatch, index: number, selected: boolean, displayPrefix: string) => ui.row({
  id: `file-preview-row-${index}`,
  key: `${match.kind}:${match.relativePath}`,
  gap: 1,
  wrap: true,
}, [
  ui.text(selected ? ">" : " "),
  renderHighlightedPreviewPath(
    formatFileSearchDisplayPath(displayPrefix, match.relativePath),
    offsetFileSearchMatchIndices(displayPrefix, match.indices),
    { id: `file-preview-path-${index}`, flex: 1 },
  ),
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

const renderTransferFact = (label: string, value: string) => ui.box({ minWidth: 12 }, [
  ui.column({ gap: 0 }, [
    ui.text(label, { variant: "caption" }),
    ui.text(value),
  ]),
])

const transferPathLabel = (transfer: TransferSnapshot, peersById: Map<string, PeerSnapshot>) => peersById.get(transfer.peerId)?.pathLabel || "—"

const renderTransferRow = (transfer: TransferSnapshot, peersById: Map<string, PeerSnapshot>, actions: TuiActions, now = Date.now()) => {
  const hasStarted = !!transfer.startedAt
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
    key: transfer.id,
    title: `${transfer.direction === "out" ? "→" : "←"} ${transfer.name}`,
    actions: transferActionButtons(transfer, actions),
  }, [
    ui.row({ gap: 1, wrap: true }, [
      tightTag(transfer.status, { variant: statusVariant(transfer.status), bare: true }),
      transfer.error ? tightTag("error", { variant: "error", bare: true }) : null,
    ]),
    ui.row({ gap: 0, wrap: true }, facts),
    ui.progress(transferProgress(transfer), { showPercent: true, label: `${percentFormat.format(transfer.progress)}%` }),
    ui.row({ gap: 0, wrap: true }, [
      renderTransferFact("Speed", hasStarted ? transfer.speedText : "—"),
      renderTransferFact("ETA", transfer.status === "sending" || transfer.status === "receiving" ? transfer.etaText : "—"),
    ]),
    transfer.error ? ui.callout(transfer.error, { variant: "error" }) : null,
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
        onInput: value => actions.setDraftInput(value),
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
    actionButton("clear-events", "Clear", actions.clearLogs, "warning", !state.snapshot.logs.length),
    actionButton("hide-events", "Hide", actions.toggleEvents),
  ],
}, [
  ui.box({ maxHeight: 24, overflow: "scroll" }, [
    state.snapshot.logs.length
      ? ui.column({ gap: 0 }, state.snapshot.logs.slice(0, 20).map(renderLogRow))
      : ui.empty("No events"),
  ]),
])

const renderFooterHint = (id: string, keycap: string, label: string) => ui.row({ id, gap: 0, items: "center" }, [
  ui.kbd(keycap),
  ui.text(` ${label}`, { style: { dim: true } }),
])

const renderFooter = (state: TuiState) => ui.statusBar({
  id: "footer-shell",
  left: [ui.callout(state.notice.text, { variant: state.notice.variant })],
  right: [
    ui.toolbar({ id: "footer-hints", gap: 3 }, [
      renderFooterHint("footer-hint-tab", "tab", "focus/accept"),
      renderFooterHint("footer-hint-enter", "enter", "accept/add"),
      renderFooterHint("footer-hint-esc", "esc", "hide/reset"),
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
      state.eventsExpanded ? ui.box({ id: "events-shell", width: 28, minHeight: 0 }, [renderEventsCard(state, actions)]) : null,
    ]),
    footer: renderFooter(state),
    p: 0,
    gap: 0,
  })

  return state.pendingFocusTarget
    ? ui.focusTrap({
        id: `focus-request-${state.focusRequestEpoch}`,
        key: `focus-request-${state.focusRequestEpoch}`,
        active: true,
        initialFocus: state.pendingFocusTarget,
      }, [page])
    : page
}

const withNotice = (state: TuiState, notice: Notice): TuiState => ({ ...state, notice })

export const withAcceptedDraftInput = (state: TuiState, draftInput: string, filePreview: FilePreviewState, notice: Notice): TuiState =>
  withNotice({
    ...state,
    draftInput,
    draftInputKeyVersion: state.draftInputKeyVersion + 1,
    filePreview,
    pendingFocusTarget: DRAFT_INPUT_ID,
    focusRequestEpoch: state.focusRequestEpoch + 1,
  }, notice)

export const startTui = async (initialConfig: SessionConfig, showEvents = false) => {
  await installCheckboxClickPatch()
  const initialState = createInitialTuiState(initialConfig, showEvents)
  const app = createNodeApp<TuiState>({ initialState })
  let state = initialState
  let unsubscribe = () => {}
  let stopping = false
  let cleanedUp = false
  let updateQueued = false
  const previewBaseRoot = process.cwd()
  let previewWorker: Worker | null = null
  let previewSessionId: string | null = null
  let previewSessionRoot: string | null = null

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
    void app.stop()
  }

  const resetFilePreview = (overrides: Partial<FilePreviewState> = {}): FilePreviewState => ({
    ...emptyFilePreviewState(),
    ...overrides,
  })

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

  const updateDraftInput = (value: string) => {
    const scope = deriveFileSearchScope(value, previewBaseRoot)
    const shouldDispose = !scope || state.filePreview.dismissedQuery === value
    commit(current => {
      if (!scope) return { ...current, draftInput: value, filePreview: resetFilePreview() }
      const shouldDismiss = current.filePreview.dismissedQuery === value
      const rootChanged = current.filePreview.workspaceRoot !== scope.workspaceRoot
      const basePreview = rootChanged ? resetFilePreview() : current.filePreview
      return {
        ...current,
        draftInput: value,
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
    requestFilePreview(value)
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
      requestFilePreview(nextValue)
      return true
    }
    commit(current => withAcceptedDraftInput(
      current,
      displayPath,
      resetFilePreview({ dismissedQuery: displayPath }),
      { text: `Selected ${displayPath}.`, variant: "success" },
    ))
    stopPreviewSession()
    return true
  }

  const maybeOfferDrafts = () => {
    if (!state.autoOfferOutgoing || !state.drafts.length || state.offeringDrafts) return
    if (!state.snapshot.peers.some(peer => peer.presence === "active" && peer.ready && peer.selected)) return
    const session = state.session
    const pendingDrafts = [...state.drafts]
    commit(current => ({ ...current, offeringDrafts: true }))
    void session.offerToSelectedPeers(pendingDrafts.map(draft => draft.path)).then(
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
      if (state.session !== session) return
      commit(current => withNotice(current, { text: `${error}`, variant: "error" }))
    })
  }

  const replaceSession = (nextSeed: SessionSeed, text: string, options: { reseedBootFocus?: boolean } = {}) => {
    const previousSession = state.session
    const nextSession = makeSession(nextSeed, state.autoAcceptIncoming, state.autoSaveIncoming)
    stopPreviewSession()
    commit(current => withNotice({
      ...current,
      session: nextSession,
      sessionSeed: nextSeed,
      snapshot: nextSession.snapshot(),
      roomInput: nextSeed.room,
      nameInput: visibleNameInput(nextSeed.name),
      draftInput: "",
      filePreview: resetFilePreview(),
      drafts: [],
      offeringDrafts: false,
      ...(options.reseedBootFocus
        ? deriveBootFocusState(nextSeed.name, current.focusRequestEpoch + 1)
        : {
            pendingFocusTarget: current.pendingFocusTarget,
            focusRequestEpoch: current.focusRequestEpoch,
            bootNameJumpPending: current.bootNameJumpPending,
          }),
    }, { text, variant: "success" }))
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
        filePreview: current.draftInput === submittedInput ? resetFilePreview() : current.filePreview,
        drafts: [...current.drafts, created],
      }, { text: `Added ${plural(1, "draft file")}.`, variant: "success" }))
      if (shouldDispose) stopPreviewSession()
      maybeOfferDrafts()
    }, error => {
      commit(current => withNotice(current, { text: `${error}`, variant: "error" }))
    })
  }

  const actions: TuiActions = {
    toggleEvents: () => commit(current => ({ ...withNotice(current, { text: current.eventsExpanded ? "Events hidden." : "Events shown.", variant: "info" }), eventsExpanded: !current.eventsExpanded })),
    jumpToRandomRoom: () => replaceSession({ ...state.sessionSeed, room: uid(8) }, "Joined a new room."),
    commitRoom,
    setRoomInput: value => commit(current => ({ ...current, roomInput: value })),
    jumpToNewSelf: () => replaceSession({ ...state.sessionSeed, localId: cleanLocalId(uid(8)) }, "Started a fresh self ID.", { reseedBootFocus: true }),
    commitName,
    setNameInput: value => commit(current => ({ ...current, nameInput: value })),
    toggleSelectReadyPeers: () => {
      let changed = 0
      for (const peer of state.snapshot.peers) if (peer.presence === "active" && state.session.setPeerSelected(peer.id, peer.ready)) changed += 1
      commit(current => withNotice(current, { text: changed ? "Selected ready peers." : "No ready peers to select.", variant: changed ? "success" : "info" }))
      maybeOfferDrafts()
    },
    clearPeerSelection: () => {
      let changed = 0
      for (const peer of state.snapshot.peers) if (state.session.setPeerSelected(peer.id, false)) changed += 1
      commit(current => withNotice(current, { text: changed ? `Cleared ${plural(changed, "peer selection")}.` : "No peer selections to clear.", variant: changed ? "warning" : "info" }))
    },
    toggleHideTerminalPeers: () => commit(current => withNotice({ ...current, hideTerminalPeers: !current.hideTerminalPeers }, { text: current.hideTerminalPeers ? "Terminal peers shown." : "Terminal peers hidden.", variant: "info" })),
    togglePeer: peerId => {
      state.session.togglePeerSelection(peerId)
      maybeOfferDrafts()
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
    setDraftInput: value => updateDraftInput(value),
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
    tab: {
      description: "Accept focused preview row",
      when: ctx => ctx.focusedId === DRAFT_INPUT_ID && !!selectedFilePreviewMatch(state) && filePreviewVisible(state),
      handler: () => {
        acceptSelectedFilePreview()
      },
    },
    up: {
      description: "Move file preview selection up",
      when: ctx => ctx.focusedId === DRAFT_INPUT_ID && filePreviewVisible(state) && state.filePreview.results.length > 0,
      handler: () => {
        commit(current => ({ ...current, filePreview: moveFilePreviewSelection(current.filePreview, -1) }))
      },
    },
    down: {
      description: "Move file preview selection down",
      when: ctx => ctx.focusedId === DRAFT_INPUT_ID && filePreviewVisible(state) && state.filePreview.results.length > 0,
      handler: () => {
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
          commit(current => withNotice({
            ...current,
            filePreview: resetFilePreview({ dismissedQuery: current.draftInput }),
          }, { text: "File preview hidden.", variant: "warning" }))
        } else if (ctx.focusedId === DRAFT_INPUT_ID) {
          stopPreviewSession()
          commit(current => withNotice({ ...current, draftInput: "", filePreview: resetFilePreview() }, { text: "Draft input cleared.", variant: "warning" }))
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
    await state.session.close()
  }

  const onSignal = () => requestStop()
  process.once("SIGINT", onSignal)
  process.once("SIGTERM", onSignal)

  try {
    bindSession(state.session)
    await app.run()
  } finally {
    process.off("SIGINT", onSignal)
    process.off("SIGTERM", onSignal)
    await stop()
    app.dispose()
  }
}
