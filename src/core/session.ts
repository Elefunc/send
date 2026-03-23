import { resolve } from "node:path"
import type { RTCDataChannel, RTCIceCandidateInit, RTCIceServer } from "werift"
import { RTCPeerConnection } from "werift"
import { loadLocalFiles, readFileChunk, saveIncomingFile, type LocalFile } from "./files"
import {
  BASE_ICE_SERVERS,
  BUFFER_HIGH,
  CHUNK,
  FINAL_STATUSES,
  SENDABLE_STATUSES,
  SIGNAL_WS_URL,
  buildCliProfile,
  cleanText,
  cleanInstanceId,
  cleanLocalId,
  cleanName,
  cleanRoom,
  displayPeerName,
  fallbackName,
  formatEta,
  formatRate,
  signalEpoch,
  stamp,
  turnStateLabel,
  type CandidateSignal,
  type DataMessage,
  type DescriptionSignal,
  type Direction,
  type LogEntry,
  type PeerProfile,
  type Presence,
  type SignalMessage,
  type SocketState,
  type TransferStatus,
  uid,
} from "./protocol"

interface PeerState {
  id: string
  name: string
  presence: Presence
  selected: boolean
  remoteInstanceId: string
  polite: boolean
  pc: RTCPeerConnection | null
  dc: RTCDataChannel | null
  rtcEpoch: number
  remoteEpoch: number
  makingOffer: boolean
  createdAt: number
  lastSeenAt: number
  outgoingQueue: string[]
  activeOutgoing: string
  activeIncoming: string
  profile?: PeerProfile
  turnAvailable: boolean
  terminalReason: string
  lastError: string
  connectivity: PeerConnectivitySnapshot
}

interface TransferState {
  id: string
  peerId: string
  peerName: string
  direction: Direction
  status: TransferStatus
  name: string
  size: number
  type: string
  lastModified: number
  totalChunks: number
  chunkSize: number
  bytes: number
  chunks: number
  speed: number
  eta: number
  error: string
  createdAt: number
  updatedAt: number
  startedAt: number
  endedAt: number
  savedAt: number
  savedPath?: string
  file?: LocalFile
  buffers?: Buffer[]
  data?: Buffer
  inFlight: boolean
  cancel: boolean
  cancelReason?: string
  cancelSource?: "local" | "remote"
}

export interface PeerSnapshot {
  id: string
  name: string
  displayName: string
  presence: Presence
  selected: boolean
  selectable: boolean
  ready: boolean
  status: string
  turn: string
  turnState: TurnState
  dataState: string
  lastError: string
  profile?: PeerProfile
  rttMs: number
  localCandidateType: string
  remoteCandidateType: string
  pathLabel: string
}

export interface TransferSnapshot {
  id: string
  peerId: string
  peerName: string
  direction: Direction
  status: TransferStatus
  name: string
  size: number
  bytes: number
  progress: number
  speedText: string
  etaText: string
  error: string
  createdAt: number
  updatedAt: number
  startedAt: number
  endedAt: number
  savedAt: number
  savedPath?: string
}

export interface SessionSnapshot {
  localId: string
  name: string
  room: string
  socketState: SocketState
  turn: string
  turnState: TurnState
  profile?: PeerProfile
  pulse: PulseSnapshot
  saveDir: string
  peers: PeerSnapshot[]
  transfers: TransferSnapshot[]
  logs: LogEntry[]
}

export type SessionEvent =
  | { type: "socket"; socketState: SocketState }
  | { type: "peer"; peer: PeerSnapshot }
  | { type: "transfer"; transfer: TransferSnapshot }
  | { type: "saved"; transfer: TransferSnapshot }
  | { type: "log"; log: LogEntry }

export interface SessionConfig {
  room?: string
  localId?: string
  name?: string
  saveDir?: string
  peerSelectionMemory?: Map<string, boolean>
  autoAcceptIncoming?: boolean
  autoSaveIncoming?: boolean
  turnUrls?: string[]
  turnUsername?: string
  turnCredential?: string
  reconnectSocket?: boolean
}

const LOG_LIMIT = 200
const STATS_POLL_MS = 1000
const PROFILE_URL = "https://ip.rt.ht/"
const PULSE_URL = "https://sig.efn.kr/pulse"

export interface PeerConnectivitySnapshot {
  rttMs: number
  localCandidateType: string
  remoteCandidateType: string
  pathLabel: string
}

export type TurnState = "none" | "idle" | "used"
export type PulseState = "idle" | "checking" | "open" | "error"

export interface PulseSnapshot {
  state: PulseState
  at: number
  ms: number
  error: string
}

const progressOf = (transfer: TransferState) => transfer.size ? Math.max(0, Math.min(100, transfer.bytes / transfer.size * 100)) : FINAL_STATUSES.has(transfer.status as never) ? 100 : 0
const isFinal = (transfer: TransferState) => FINAL_STATUSES.has(transfer.status as never)
export const candidateTypeLabel = (type: string) => ({ host: "Direct", srflx: "NAT", prflx: "NAT", relay: "TURN" }[type] || "—")
const emptyConnectivitySnapshot = (): PeerConnectivitySnapshot => ({ rttMs: Number.NaN, localCandidateType: "", remoteCandidateType: "", pathLabel: "—" })
const emptyPulseSnapshot = (): PulseSnapshot => ({ state: "idle", at: 0, ms: 0, error: "" })

export const sanitizeProfile = (profile?: PeerProfile): PeerProfile => ({
  geo: {
    city: cleanText(profile?.geo?.city, 48),
    region: cleanText(profile?.geo?.region, 48),
    country: cleanText(profile?.geo?.country, 12),
    timezone: cleanText(profile?.geo?.timezone, 48),
  },
  network: {
    colo: cleanText(profile?.network?.colo, 12),
    asOrganization: cleanText(profile?.network?.asOrganization, 72),
    asn: Number(profile?.network?.asn) || 0,
    ip: cleanText(profile?.network?.ip, 80),
  },
  ua: {
    browser: cleanText(profile?.ua?.browser, 32),
    os: cleanText(profile?.ua?.os, 32),
    device: cleanText(profile?.ua?.device, 16),
  },
  defaults: {
    autoAcceptIncoming: typeof profile?.defaults?.autoAcceptIncoming === "boolean" ? profile.defaults.autoAcceptIncoming : undefined,
    autoSaveIncoming: typeof profile?.defaults?.autoSaveIncoming === "boolean" ? profile.defaults.autoSaveIncoming : undefined,
  },
  ready: !!profile?.ready,
  error: cleanText(profile?.error, 120),
})

export const localProfileFromResponse = (data: unknown, error = ""): PeerProfile => {
  const value = data as {
    cf?: { city?: unknown; region?: unknown; country?: unknown; timezone?: unknown; colo?: unknown; asOrganization?: unknown; asn?: unknown }
    hs?: Record<string, unknown>
  } | null
  const cleaned = (input: unknown, max: number) => cleanText(input, max) || undefined
  return sanitizeProfile({
    geo: {
      city: cleaned(value?.cf?.city, 48),
      region: cleaned(value?.cf?.region, 48),
      country: cleaned(value?.cf?.country, 12),
      timezone: cleaned(value?.cf?.timezone, 48),
    },
    network: {
      colo: cleaned(value?.cf?.colo, 12),
      asOrganization: cleaned(value?.cf?.asOrganization, 72),
      asn: Number(value?.cf?.asn) || 0,
      ip: cleaned(value?.hs?.["cf-connecting-ip"] || value?.hs?.["x-real-ip"], 80),
    },
    ua: buildCliProfile().ua,
    ready: !!value?.cf,
    error,
  })
}

export const turnUsageState = (
  hasTurn: boolean,
  peers: Iterable<{ presence?: Presence; pc?: { connectionState?: string | null } | null; connectivity?: Partial<PeerConnectivitySnapshot> | null }>,
): TurnState => {
  if (!hasTurn) return "none"
  for (const peer of peers) {
    if (peer?.presence !== "active") continue
    if (peer?.pc?.connectionState !== "connected") continue
    if (peer?.connectivity?.localCandidateType === "relay") return "used"
  }
  return "idle"
}

export class SessionAbortedError extends Error {
  constructor(message = "session aborted") {
    super(message)
    this.name = "SessionAbortedError"
  }
}

export const isSessionAbortedError = (error: unknown): error is SessionAbortedError =>
  error instanceof SessionAbortedError || error instanceof Error && error.name === "SessionAbortedError"

const timeoutSignal = (ms: number, base?: AbortSignal | null) => {
  const timeout = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(ms) : undefined
  if (!base) return timeout
  if (!timeout) return base
  return typeof AbortSignal.any === "function" ? AbortSignal.any([base, timeout]) : base
}

const normalizeCandidateType = (value: unknown) => typeof value === "string" ? value.toLowerCase() : ""
const validCandidateType = (value: string) => ["host", "srflx", "prflx", "relay"].includes(value)

export const activeIcePairFromPeerConnection = (pc: { iceTransports?: unknown[] } | null | undefined) => {
  const transports = Array.isArray(pc?.iceTransports) ? pc.iceTransports as Array<Record<string, any>> : []
  let fallback: { transport: Record<string, any>; connection: Record<string, any>; pair: Record<string, any> } | null = null
  for (const transport of transports) {
    const connection = transport?.connection
    const pair = connection?.nominated
    if (!pair) continue
    fallback ||= { transport, connection, pair }
    const state = `${transport?.state ?? ""}`.toLowerCase()
    if (!state || state === "connected" || state === "completed") return { transport, connection, pair }
  }
  return fallback
}

export const connectivitySnapshotFromPeerConnection = (
  pc: { iceTransports?: unknown[] } | null | undefined,
  previous: PeerConnectivitySnapshot = emptyConnectivitySnapshot(),
): PeerConnectivitySnapshot => {
  const pair = activeIcePairFromPeerConnection(pc)?.pair
  const localCandidateType = normalizeCandidateType(pair?.localCandidate?.type ?? pair?.localCandidate?.candidateType)
  const remoteCandidateType = normalizeCandidateType(pair?.remoteCandidate?.type ?? pair?.remoteCandidate?.candidateType)
  if (!validCandidateType(localCandidateType) || !validCandidateType(remoteCandidateType)) return previous
  return {
    ...previous,
    localCandidateType,
    remoteCandidateType,
    pathLabel: `${candidateTypeLabel(localCandidateType)} ↔ ${candidateTypeLabel(remoteCandidateType)}`,
  }
}

export const probeIcePairConsentRtt = async (connection: Record<string, any> | null | undefined, pair: Record<string, any> | null | undefined) => {
  if (!connection || !pair?.protocol?.request || typeof connection.buildRequest !== "function" || typeof connection.remotePassword !== "string") return Number.NaN
  const request = connection.buildRequest({
    nominate: false,
    localUsername: connection.localUsername,
    remoteUsername: connection.remoteUsername,
    iceControlling: connection.iceControlling,
  })
  const startedAt = performance.now()
  await pair.protocol.request(request, pair.remoteAddr, Buffer.from(connection.remotePassword, "utf8"), 0)
  return performance.now() - startedAt
}

const sameConnectivity = (left: PeerConnectivitySnapshot, right: PeerConnectivitySnapshot) =>
  (left.rttMs === right.rttMs || Number.isNaN(left.rttMs) && Number.isNaN(right.rttMs))
  && left.localCandidateType === right.localCandidateType
  && left.remoteCandidateType === right.remoteCandidateType
  && left.pathLabel === right.pathLabel

const turnServerUrls = (server?: RTCIceServer | null) => (Array.isArray(server?.urls) ? server.urls : [server?.urls]).map(url => `${url ?? ""}`.trim()).filter(url => /^turns?:/i.test(url))
const normalizeTurnServer = (server?: RTCIceServer | null): RTCIceServer | null => {
  const urls = [...new Set(turnServerUrls(server))]
  if (!urls.length) return null
  const username = `${server?.username ?? ""}`.trim()
  const credential = `${server?.credential ?? ""}`.trim()
  return {
    urls: urls[0],
    ...(username ? { username } : {}),
    ...(credential ? { credential } : {}),
  }
}
const turnServerKey = (server?: RTCIceServer | null) => {
  const normalized = normalizeTurnServer(server)
  return normalized ? JSON.stringify({
    urls: turnServerUrls(normalized).sort(),
    username: `${normalized.username ?? ""}`,
    credential: `${normalized.credential ?? ""}`,
  }) : ""
}
const turnServers = (urls: string[], username?: string, credential?: string): RTCIceServer[] =>
  [...new Set(urls.map(url => `${url ?? ""}`.trim()).filter(url => /^turns?:/i.test(url)))]
    .map(url => normalizeTurnServer({ urls: url, ...(username ? { username } : {}), ...(credential ? { credential } : {}) }))
    .filter((server): server is RTCIceServer => !!server)

const messageString = async (value: unknown) => {
  if (typeof value === "string") return value
  if (value instanceof Uint8Array) return new TextDecoder().decode(value)
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value)
  if (value instanceof Blob) return value.text()
  return `${value ?? ""}`
}

export class SendSession {
  readonly instanceId: string
  readonly localId: string
  profile = sanitizeProfile(buildCliProfile())
  readonly saveDir: string
  readonly room: string
  turnAvailable: boolean
  name: string
  socketState: SocketState = "idle"
  pulse: PulseSnapshot = emptyPulseSnapshot()

  private autoAcceptIncoming: boolean
  private autoSaveIncoming: boolean
  private readonly reconnectSocket: boolean
  private iceServers: RTCIceServer[]
  private extraTurnServers: RTCIceServer[]
  private readonly peerSelectionMemory: Map<string, boolean>
  private readonly peers = new Map<string, PeerState>()
  private readonly transfers = new Map<string, TransferState>()
  private readonly logs: LogEntry[] = []
  private readonly subscribers = new Set<() => void>()
  private readonly eventSubscribers = new Set<(event: SessionEvent) => void>()

  private rtcEpochCounter = 0
  private socket: WebSocket | null = null
  private socketToken = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private peerStatsTimer: ReturnType<typeof setInterval> | null = null
  private readonly pendingRtcCloses = new Set<Promise<void>>()
  private lifecycleAbortController: AbortController | null = null
  private stopped = false

  constructor(config: SessionConfig) {
    this.instanceId = cleanInstanceId(uid(10)) || uid(10)
    this.localId = cleanLocalId(config.localId)
    this.room = cleanRoom(config.room)
    this.name = cleanName(config.name ?? fallbackName)
    this.saveDir = resolve(config.saveDir ?? resolve(process.cwd()))
    this.peerSelectionMemory = config.peerSelectionMemory ?? new Map()
    this.autoAcceptIncoming = !!config.autoAcceptIncoming
    this.autoSaveIncoming = !!config.autoSaveIncoming
    this.reconnectSocket = config.reconnectSocket ?? true
    this.extraTurnServers = turnServers(config.turnUrls ?? [], config.turnUsername, config.turnCredential)
    this.iceServers = [...BASE_ICE_SERVERS, ...this.extraTurnServers]
    this.turnAvailable = this.extraTurnServers.length > 0
  }

  subscribe(listener: () => void) {
    this.subscribers.add(listener)
    return () => this.subscribers.delete(listener)
  }

  onEvent(listener: (event: SessionEvent) => void) {
    this.eventSubscribers.add(listener)
    return () => this.eventSubscribers.delete(listener)
  }

  snapshot(): SessionSnapshot {
    return {
      localId: this.localId,
      name: this.name,
      room: this.room,
      socketState: this.socketState,
      turn: turnStateLabel(this.turnAvailable),
      turnState: this.selfTurnState(),
      profile: this.advertisedProfile(),
      pulse: { ...this.pulse },
      saveDir: this.saveDir,
      peers: [...this.peers.values()]
        .map(peer => this.peerSnapshot(peer))
        .sort((left, right) => left.presence === right.presence ? left.displayName.localeCompare(right.displayName) : left.presence === "active" ? -1 : 1),
      transfers: [...this.transfers.values()]
        .map(transfer => this.transferSnapshot(transfer))
        .sort((left, right) => right.createdAt - left.createdAt),
      logs: [...this.logs],
    }
  }

  async connect(timeoutMs = 10_000) {
    this.stopped = false
    this.lifecycleAbortController?.abort()
    this.lifecycleAbortController = typeof AbortController === "function" ? new AbortController() : null
    this.startPeerStatsPolling()
    void this.loadLocalProfile()
    void this.probePulse()
    this.connectSocket()
    await this.waitFor(() => this.socketState === "open", timeoutMs, this.lifecycleAbortController?.signal)
  }

  async close() {
    this.stopped = true
    this.stopPeerStatsPolling()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.lifecycleAbortController?.abort()
    this.lifecycleAbortController = null
    if (this.socket?.readyState === WebSocket.OPEN) this.sendSignal({ kind: "bye" })
    const socket = this.socket
    this.socket = null
    this.socketToken += 1
    if (socket) try { socket.close(1000, "normal") } catch {}
    for (const peer of this.peers.values()) this.destroyPeer(peer, "session-close")
    this.notify()
    if (this.pendingRtcCloses.size) await Promise.allSettled([...this.pendingRtcCloses])
  }

  activePeers() {
    return [...this.peers.values()].filter(peer => peer.presence === "active")
  }

  readyPeers() {
    return this.activePeers().filter(peer => this.isPeerReady(peer))
  }

  selectedReadyPeers() {
    return this.readyPeers().filter(peer => peer.selected)
  }

  canShareTurn() {
    return this.extraTurnServers.length > 0
  }

  shareTurnWithPeer(peerId: string) {
    const peer = this.peers.get(peerId)
    if (!peer || peer.presence !== "active" || !this.extraTurnServers.length) return false
    const sent = this.sendSignal({ kind: "turn-share", to: peer.id, iceServers: this.sharedTurnServers() })
    if (sent) this.pushLog("turn:share-sent", { peer: peer.id, scope: "peer" }, "info")
    return sent
  }

  shareTurnWithPeers(peerIds: string[]) {
    if (!this.extraTurnServers.length) return 0
    const iceServers = this.sharedTurnServers()
    const sentPeers: string[] = []
    for (const peerId of new Set(peerIds.filter(Boolean))) {
      const peer = this.peers.get(peerId)
      if (!peer || peer.presence !== "active") continue
      if (!this.sendSignal({ kind: "turn-share", to: peer.id, iceServers })) continue
      sentPeers.push(peer.id)
    }
    if (sentPeers.length) this.pushLog("turn:share-sent", { peers: sentPeers.length, scope: "filtered", peerIds: sentPeers }, "info")
    return sentPeers.length
  }

  shareTurnWithAllPeers() {
    const count = this.activePeers().length
    if (!count || !this.extraTurnServers.length) return 0
    const sent = this.sendSignal({ kind: "turn-share", to: "*", iceServers: this.sharedTurnServers() })
    if (sent) this.pushLog("turn:share-sent", { peers: count, scope: "all" }, "info")
    return sent ? count : 0
  }

  setPeerSelected(peerId: string, selected: boolean) {
    const peer = this.peers.get(peerId)
    if (!peer) return false
    const next = !!selected
    const rememberedChanged = this.rememberPeerSelected(peerId, next)
    if (peer.presence !== "active") return rememberedChanged
    if (peer.selected === next && !rememberedChanged) return false
    peer.selected = next
    this.emit({ type: "peer", peer: this.peerSnapshot(peer) })
    this.notify()
    return true
  }

  togglePeerSelection(peerId: string) {
    const peer = this.peers.get(peerId)
    return peer ? this.setPeerSelected(peerId, !peer.selected) : false
  }

  private sharedTurnServers() {
    return this.extraTurnServers.map(server => normalizeTurnServer(server)).filter((server): server is RTCIceServer => !!server)
  }

  private refreshIceServers() {
    this.turnAvailable = this.extraTurnServers.length > 0
    this.iceServers = [...BASE_ICE_SERVERS, ...this.extraTurnServers]
  }

  private mergeTurnServers(iceServers: RTCIceServer[] = []) {
    const known = new Set(this.extraTurnServers.map(turnServerKey).filter(Boolean))
    const added: RTCIceServer[] = []
    for (const server of iceServers) {
      const normalized = normalizeTurnServer(server)
      if (!normalized) continue
      const key = turnServerKey(normalized)
      if (!key || known.has(key)) continue
      known.add(key)
      added.push(normalized)
    }
    if (!added.length) return 0
    this.extraTurnServers = [...this.extraTurnServers, ...added]
    this.refreshIceServers()
    return added.length
  }

  clearLogs() {
    this.logs.length = 0
    this.notify()
  }

  setName(value: string) {
    const next = cleanName(value)
    if (next === this.name) return this.name
    this.name = next
    this.sendSignal({ kind: "name", name: this.name })
    this.notify()
    return this.name
  }

  async setAutoAcceptIncoming(enabled: boolean) {
    const next = !!enabled
    const changed = next !== this.autoAcceptIncoming
    this.autoAcceptIncoming = next
    if (changed) this.broadcastProfile()
    if (!changed || !next) {
      this.notify()
      return 0
    }
    let accepted = 0
    for (const transfer of this.transfers.values()) {
      if (transfer.direction !== "in" || transfer.status !== "pending") continue
      if (await this.acceptTransfer(transfer.id)) accepted += 1
    }
    this.notify()
    return accepted
  }

  async setAutoSaveIncoming(enabled: boolean) {
    const next = !!enabled
    const changed = next !== this.autoSaveIncoming
    this.autoSaveIncoming = next
    if (changed) this.broadcastProfile()
    if (!changed || !next) {
      this.notify()
      return 0
    }
    let saved = 0
    for (const transfer of this.transfers.values()) {
      if (transfer.direction !== "in" || transfer.status !== "complete" || transfer.savedAt > 0) continue
      if (await this.saveTransfer(transfer.id)) saved += 1
    }
    this.notify()
    return saved
  }

  cancelPendingOffers() {
    let cancelled = 0
    for (const transfer of this.transfers.values()) {
      if (transfer.direction !== "out" || !["queued", "offered"].includes(transfer.status)) continue
      if (this.cancelTransfer(transfer.id)) cancelled += 1
    }
    return cancelled
  }

  clearCompletedTransfers() {
    let cleared = 0
    for (const [transferId, transfer] of this.transfers.entries()) {
      if (transfer.status !== "complete") continue
      this.transfers.delete(transferId)
      cleared += 1
    }
    if (cleared) {
      for (const peer of this.peers.values()) peer.outgoingQueue = peer.outgoingQueue.filter(transferId => this.transfers.has(transferId))
      this.notify()
    }
    return cleared
  }

  clearFailedTransfers() {
    let cleared = 0
    for (const [transferId, transfer] of this.transfers.entries()) {
      if (!["rejected", "cancelled", "error"].includes(transfer.status)) continue
      this.transfers.delete(transferId)
      cleared += 1
    }
    if (cleared) {
      for (const peer of this.peers.values()) peer.outgoingQueue = peer.outgoingQueue.filter(transferId => this.transfers.has(transferId))
      this.notify()
    }
    return cleared
  }

  async queueFiles(paths: string[], peerIds: string[]) {
    const files = await loadLocalFiles(paths)
    const peers = peerIds.map(peerId => this.peers.get(peerId)).filter((peer): peer is PeerState => !!peer && this.isPeerReady(peer))
    if (!files.length) throw new Error("no files to offer")
    if (!peers.length) throw new Error("no ready peers selected")
    const created: string[] = []
    for (const peer of peers) {
      for (const file of files) {
        const transfer = this.buildOutgoingTransfer(peer, file)
        this.transfers.set(transfer.id, transfer)
        peer.outgoingQueue.push(transfer.id)
        created.push(transfer.id)
        this.emit({ type: "transfer", transfer: this.transferSnapshot(transfer) })
      }
      this.flushOffers(peer)
    }
    this.notify()
    return created
  }

  async offerToSelectedPeers(paths: string[]) {
    return this.queueFiles(paths, this.selectedReadyPeers().map(peer => peer.id))
  }

  async acceptTransfer(transferId: string) {
    const transfer = this.transfers.get(transferId)
    if (!transfer || transfer.direction !== "in" || isFinal(transfer)) return false
    const peer = this.peers.get(transfer.peerId)
    if (!peer || !this.isPeerReady(peer)) return false
    if (!this.sendDataControl(peer, { kind: "file-accept", transferId })) return false
    transfer.status = "accepted"
    this.noteTransfer(transfer)
    this.emit({ type: "transfer", transfer: this.transferSnapshot(transfer) })
    this.notify()
    return true
  }

  rejectTransfer(transferId: string, reason = "rejected") {
    const transfer = this.transfers.get(transferId)
    if (!transfer || transfer.direction !== "in" || isFinal(transfer)) return false
    const peer = this.peers.get(transfer.peerId)
    if (peer) this.sendDataControl(peer, { kind: "file-reject", transferId, reason })
    this.completeTransfer(transfer, "rejected", reason)
    return true
  }

  cancelTransfer(transferId: string) {
    const transfer = this.transfers.get(transferId)
    if (!transfer || isFinal(transfer)) return false
    const peer = this.peers.get(transfer.peerId)
    transfer.cancel = true
    transfer.cancelSource = "local"
    transfer.cancelReason = transfer.direction === "out" ? "sender cancelled" : "receiver cancelled"

    if (transfer.direction === "out") {
      if (transfer.status === "queued" || transfer.status === "offered" || transfer.status === "accepted") {
        if (transfer.status !== "queued" && peer) this.sendDataControl(peer, { kind: "file-cancel", transferId, reason: transfer.cancelReason })
        this.completeTransfer(transfer, "cancelled", transfer.cancelReason)
        if (peer) this.pumpSender(peer)
        return true
      }
      if (transfer.inFlight) {
        transfer.status = "cancelling"
        this.emit({ type: "transfer", transfer: this.transferSnapshot(transfer) })
        this.notify()
        return true
      }
    }

    if (transfer.direction === "in") {
      if (transfer.status === "pending") return this.rejectTransfer(transfer.id, transfer.cancelReason)
      if (transfer.status === "accepted") {
        if (peer) this.sendDataControl(peer, { kind: "file-cancel", transferId, reason: transfer.cancelReason })
        this.completeTransfer(transfer, "cancelled", transfer.cancelReason)
        return true
      }
      if (transfer.status === "receiving") {
        if (peer) this.sendDataControl(peer, { kind: "file-cancel", transferId, reason: transfer.cancelReason })
        transfer.status = "cancelling"
        this.emit({ type: "transfer", transfer: this.transferSnapshot(transfer) })
        this.notify()
        return true
      }
    }

    if (peer) this.sendDataControl(peer, { kind: "file-cancel", transferId, reason: transfer.cancelReason })
    this.completeTransfer(transfer, "cancelled", transfer.cancelReason)
    return true
  }

  async saveTransfer(transferId: string) {
    const transfer = this.transfers.get(transferId)
    if (!transfer || transfer.direction !== "in" || transfer.status !== "complete") return null
    if (!transfer.data && transfer.buffers?.length) transfer.data = Buffer.concat(transfer.buffers)
    if (!transfer.data) return null
    transfer.savedPath ||= await saveIncomingFile(this.saveDir, transfer.name, transfer.data)
    transfer.savedAt ||= Date.now()
    const snapshot = this.transferSnapshot(transfer)
    this.pushLog("transfer:saved", { transferId: transfer.id, path: transfer.savedPath })
    this.emit({ type: "saved", transfer: snapshot })
    this.notify()
    return transfer.savedPath
  }

  getTransfer(transferId: string) {
    return this.transfers.get(transferId)
  }

  async waitFor(predicate: () => boolean, timeoutMs: number, signal?: AbortSignal | null) {
    if (predicate()) return
    if (signal?.aborted) throw new SessionAbortedError()
    await new Promise<void>((resolveWait, rejectWait) => {
      let unsubscribe = () => {}
      const cleanup = () => {
        clearTimeout(timeout)
        signal?.removeEventListener("abort", onAbort)
        unsubscribe()
      }
      const onAbort = () => {
        cleanup()
        rejectWait(new SessionAbortedError())
      }
      const timeout = setTimeout(() => {
        cleanup()
        rejectWait(new Error(`timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      unsubscribe = this.subscribe(() => {
        if (!predicate()) return
        cleanup()
        resolveWait()
      })
      signal?.addEventListener("abort", onAbort, { once: true })
      if (signal?.aborted) onAbort()
    })
  }

  async waitForTransfers(transferIds: string[], timeoutMs: number) {
    await this.waitFor(() => transferIds.every(transferId => {
      const transfer = this.transfers.get(transferId)
      return !!transfer && isFinal(transfer)
    }), timeoutMs)
    return transferIds.map(transferId => this.transfers.get(transferId)).filter((transfer): transfer is TransferState => !!transfer)
  }

  private nextRtcEpoch() {
    this.rtcEpochCounter += 1
    return this.rtcEpochCounter
  }

  private notify() {
    for (const listener of this.subscribers) listener()
  }

  private emit(event: SessionEvent) {
    for (const listener of this.eventSubscribers) listener(event)
  }

  private startPeerStatsPolling() {
    if (this.peerStatsTimer) return
    this.peerStatsTimer = setInterval(() => void this.refreshPeerStats(), STATS_POLL_MS)
  }

  private stopPeerStatsPolling() {
    if (!this.peerStatsTimer) return
    clearInterval(this.peerStatsTimer)
    this.peerStatsTimer = null
  }

  private async refreshPeerStats() {
    if (this.stopped) return
    let dirty = false
    for (const peer of this.peers.values()) {
      if (peer.presence !== "active") continue
      dirty = await this.refreshPeerConnectivity(peer) || dirty
    }
    if (dirty) this.notify()
  }

  private async refreshPeerConnectivity(peer: PeerState) {
    const activePair = activeIcePairFromPeerConnection(peer.pc as { iceTransports?: unknown[] } | null | undefined)
    const next = connectivitySnapshotFromPeerConnection(peer.pc as { iceTransports?: unknown[] } | null | undefined, peer.connectivity)
    const rttMs = await probeIcePairConsentRtt(activePair?.connection, activePair?.pair).catch(() => Number.NaN)
    if (Number.isFinite(rttMs)) next.rttMs = rttMs
    if (sameConnectivity(peer.connectivity, next)) return false
    peer.connectivity = next
    this.emit({ type: "peer", peer: this.peerSnapshot(peer) })
    return true
  }

  private pushLog(kind: string, payload: unknown, level: "info" | "error" = "info") {
    const log = { id: uid(6), at: Date.now(), kind, level, payload }
    this.logs.unshift(log)
    this.logs.length = Math.min(this.logs.length, LOG_LIMIT)
    this.emit({ type: "log", log })
    this.notify()
  }

  private peerSnapshot(peer: PeerState): PeerSnapshot {
    return {
      id: peer.id,
      name: peer.name || fallbackName,
      displayName: displayPeerName(peer.name || fallbackName, peer.id),
      presence: peer.presence,
      selected: peer.selected,
      selectable: this.peerSelectable(peer),
      ready: this.isPeerReady(peer),
      status: this.peerStatus(peer),
      turn: turnStateLabel(peer.turnAvailable),
      turnState: this.peerTurnState(peer),
      dataState: this.peerDataState(peer),
      lastError: peer.lastError,
      profile: peer.profile,
      rttMs: peer.connectivity.rttMs,
      localCandidateType: peer.connectivity.localCandidateType,
      remoteCandidateType: peer.connectivity.remoteCandidateType,
      pathLabel: peer.connectivity.pathLabel,
    }
  }

  private selfTurnState(): TurnState {
    return turnUsageState(this.turnAvailable, this.peers.values())
  }

  private transferSnapshot(transfer: TransferState): TransferSnapshot {
    return {
      id: transfer.id,
      peerId: transfer.peerId,
      peerName: transfer.peerName,
      direction: transfer.direction,
      status: transfer.status,
      name: transfer.name,
      size: transfer.size,
      bytes: transfer.bytes,
      progress: progressOf(transfer),
      speedText: formatRate(transfer.speed),
      etaText: formatEta(transfer.eta),
      error: transfer.error,
      createdAt: transfer.createdAt,
      updatedAt: transfer.updatedAt,
      startedAt: transfer.startedAt,
      endedAt: transfer.endedAt,
      savedAt: transfer.savedAt,
      savedPath: transfer.savedPath,
    }
  }

  private peerStatus(peer: PeerState) {
    if (peer.presence === "terminal") return peer.terminalReason || "closed"
    if (peer.pc) return peer.pc.connectionState
    return "idle"
  }

  private peerDataState(peer: PeerState) {
    if (peer.dc?.readyState) return peer.dc.readyState
    if (peer.presence === "terminal" || peer.pc?.connectionState === "closed") return "closed"
    return "—"
  }

  private peerTurnState(peer: PeerState): TurnState {
    if (!peer.turnAvailable) return "none"
    return peer.connectivity.remoteCandidateType === "relay" ? "used" : "idle"
  }

  private peerSelectable(peer: PeerState) {
    if (peer.presence === "terminal") return false
    return !["closed", "failed", "disconnected"].includes(this.peerStatus(peer))
  }

  private isPeerReady(peer: PeerState) {
    return peer.presence === "active" && peer.pc?.connectionState === "connected" && peer.dc?.readyState === "open"
  }

  private noteTransfer(transfer: TransferState) {
    transfer.updatedAt = Date.now()
    const elapsed = Math.max((transfer.updatedAt - (transfer.startedAt || transfer.createdAt)) / 1000, 0.001)
    transfer.speed = transfer.bytes / elapsed
    transfer.eta = transfer.speed ? Math.max(0, (transfer.size - transfer.bytes) / transfer.speed) : Infinity
  }

  private completeTransfer(transfer: TransferState, status: TransferStatus, error = "") {
    transfer.status = status
    transfer.error = error
    transfer.inFlight = false
    transfer.endedAt = Date.now()
    this.noteTransfer(transfer)
    if (status !== "complete" && transfer.direction === "in") {
      transfer.buffers = []
      transfer.data = undefined
    }

    const peer = this.peers.get(transfer.peerId)
    if (peer) {
      if (peer.activeOutgoing === transfer.id) peer.activeOutgoing = ""
      if (peer.activeIncoming === transfer.id) peer.activeIncoming = ""
      peer.outgoingQueue = peer.outgoingQueue.filter(queuedId => queuedId !== transfer.id || SENDABLE_STATUSES.has(this.transfers.get(queuedId)?.status as never))
      if (transfer.direction === "out") queueMicrotask(() => this.pumpSender(peer))
    }

    const snapshot = this.transferSnapshot(transfer)
    this.emit({ type: "transfer", transfer: snapshot })
    if (status === "complete" && transfer.direction === "in" && this.autoSaveIncoming) void this.saveTransfer(transfer.id)
    this.notify()
  }

  private connectSocket() {
    if (this.stopped) return
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    const token = ++this.socketToken
    const socket = new WebSocket(`${SIGNAL_WS_URL}?i=${encodeURIComponent(this.room)}`)
    this.socket = socket
    this.socketState = "connecting"
    this.emit({ type: "socket", socketState: this.socketState })
    this.notify()

    socket.onopen = () => {
      if (token !== this.socketToken || this.stopped) return
      this.socketState = "open"
      this.emit({ type: "socket", socketState: this.socketState })
      this.pushLog("signal:socket-open", { room: this.room, localId: this.localId })
      this.sendSignal({ kind: "hello", ...this.presencePayload({}) })
      this.broadcastProfile()
      this.notify()
    }

    socket.onmessage = async event => {
      if (token !== this.socketToken || this.stopped) return
      await this.onSignalMessage(await messageString(event.data))
    }

    socket.onerror = () => {
      if (token !== this.socketToken || this.stopped) return
      this.socketState = "error"
      this.emit({ type: "socket", socketState: this.socketState })
      this.notify()
    }

    socket.onclose = () => {
      if (token !== this.socketToken || this.stopped) return
      this.socketState = "closed"
      this.emit({ type: "socket", socketState: this.socketState })
      this.notify()
      if (this.reconnectSocket) this.reconnectTimer = setTimeout(() => this.connectSocket(), 2000)
    }
  }

  private async loadLocalProfile() {
    try {
      const response = await fetch(PROFILE_URL, { cache: "no-store", signal: timeoutSignal(4000, this.lifecycleAbortController?.signal) })
      if (!response.ok) throw new Error(`profile ${response.status}`)
      const data = await response.json()
      if (this.stopped) return
      this.profile = localProfileFromResponse(data)
    } catch (error) {
      if (this.stopped) return
      this.profile = localProfileFromResponse(null, `${error}`)
      this.pushLog("profile:error", { error: `${error}` }, "error")
    }
    if (this.stopped) return
    this.broadcastProfile()
    this.notify()
  }

  private async probePulse() {
    const startedAt = performance.now()
    this.pulse = { ...this.pulse, state: "checking", error: "" }
    this.notify()
    try {
      const response = await fetch(PULSE_URL, { cache: "no-store", signal: timeoutSignal(3500, this.lifecycleAbortController?.signal) })
      if (!response.ok) throw new Error(`pulse ${response.status}`)
      if (this.stopped) return
      this.pulse = { state: "open", at: Date.now(), ms: performance.now() - startedAt, error: "" }
    } catch (error) {
      if (this.stopped) return
      this.pulse = { state: "error", at: Date.now(), ms: 0, error: `${error}` }
      this.pushLog("pulse:error", { error: `${error}` }, "error")
    }
    if (this.stopped) return
    this.notify()
  }

  private presencePayload(extra: Record<string, unknown>) {
    return { name: this.name, turnAvailable: this.turnAvailable, profile: this.advertisedProfile(), ...extra }
  }

  private advertisedProfile(profile = this.profile) {
    return sanitizeProfile({
      ...(profile ?? {}),
      defaults: {
        autoAcceptIncoming: this.autoAcceptIncoming,
        autoSaveIncoming: this.autoSaveIncoming,
      },
    })
  }

  private broadcastProfile() {
    this.sendSignal({ kind: "profile", profile: this.advertisedProfile(), turnAvailable: this.turnAvailable })
  }

  private sendSignal(payload: { kind: string; to?: string; [key: string]: unknown }) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false
    const message = { room: this.room, from: this.localId, to: "*", at: stamp(), instanceId: this.instanceId, ...payload }
    this.socket.send(JSON.stringify(message))
    this.pushLog("signal:out", message)
    return true
  }

  private sendPeerHello(peer: PeerState, extra: Record<string, unknown> = {}) {
    return this.sendSignal({ kind: "hello", to: peer.id, ...this.presencePayload({ rtcEpoch: peer.rtcEpoch, ...extra }) })
  }

  private sendDataControl(peer: PeerState, payload: { kind: string; [key: string]: unknown }, channel = peer.dc, rtcEpoch = peer.rtcEpoch) {
    if (!this.isCurrentPeerChannel(peer, channel, rtcEpoch)) return false
    const activeChannel = channel!
    const message = { room: this.room, from: this.localId, to: peer.id, at: stamp(), ...payload }
    activeChannel.send(JSON.stringify(message))
    this.pushLog("data:out", message)
    return true
  }

  private isCurrentPeerChannel(peer: PeerState | undefined, channel: RTCDataChannel | null | undefined, rtcEpoch = peer?.rtcEpoch) {
    return !!peer && !!channel && peer.rtcEpoch === rtcEpoch && peer.dc === channel && channel.readyState === "open"
  }

  private peerSelected(peerId: string) {
    return this.peerSelectionMemory.get(peerId) ?? true
  }

  private rememberPeerSelected(peerId: string, selected: boolean) {
    const next = !!selected
    const previous = this.peerSelectionMemory.get(peerId)
    this.peerSelectionMemory.set(peerId, next)
    return previous !== next
  }

  private buildPeer(remoteId: string, remoteInstanceId = "") {
    const peer: PeerState = {
      id: remoteId,
      name: fallbackName,
      presence: "active",
      selected: this.peerSelected(remoteId),
      remoteInstanceId: cleanInstanceId(remoteInstanceId),
      polite: this.localId > remoteId,
      pc: null,
      dc: null,
      rtcEpoch: 0,
      remoteEpoch: 0,
      makingOffer: false,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      outgoingQueue: [],
      activeOutgoing: "",
      activeIncoming: "",
      turnAvailable: false,
      terminalReason: "",
      lastError: "",
      connectivity: emptyConnectivitySnapshot(),
    }
    this.peers.set(remoteId, peer)
    this.ensurePeerConnection(peer, "create")
    this.emit({ type: "peer", peer: this.peerSnapshot(peer) })
    this.notify()
    return peer
  }

  private resetPeerInstance(peer: PeerState, remoteInstanceId: string) {
    peer.remoteInstanceId = remoteInstanceId
    peer.remoteEpoch = 0
    peer.selected = this.peerSelected(peer.id)
    peer.presence = "active"
    peer.terminalReason = ""
    peer.lastError = ""
    peer.turnAvailable = false
    peer.connectivity = emptyConnectivitySnapshot()
    this.failPeerTransfers(peer, "peer-restarted")
    this.closePeerRTC(peer)
    this.pushLog("peer:instance-replaced", { peer: peer.id, instanceId: remoteInstanceId })
  }

  private acceptPeerInstance(peer: PeerState, remoteInstanceId: unknown, kind: string) {
    const nextInstanceId = cleanInstanceId(remoteInstanceId)
    if (!nextInstanceId) return true
    if (!peer.remoteInstanceId) {
      peer.remoteInstanceId = nextInstanceId
      return true
    }
    if (peer.remoteInstanceId === nextInstanceId) return true
    if (kind !== "hello") return false
    this.resetPeerInstance(peer, nextInstanceId)
    return true
  }

  private syncPeerPresence(peer: PeerState, name?: string, profile?: PeerProfile, turnAvailable?: boolean) {
    const wasTerminal = peer.presence === "terminal"
    peer.lastSeenAt = Date.now()
    peer.presence = "active"
    peer.terminalReason = ""
    if (wasTerminal) peer.selected = this.peerSelected(peer.id)
    if (name != null) {
      peer.name = cleanName(name)
      for (const transfer of this.transfers.values()) if (transfer.peerId === peer.id) transfer.peerName = peer.name
    }
    if (typeof turnAvailable === "boolean") peer.turnAvailable = turnAvailable
    if (profile) peer.profile = sanitizeProfile(profile)
    this.emit({ type: "peer", peer: this.peerSnapshot(peer) })
    return peer
  }

  private syncPeerSignal(peer: PeerState, kind: string, remoteEpoch = 0, recovery = false) {
    const epoch = signalEpoch(remoteEpoch)
    if (epoch && epoch < peer.remoteEpoch) return null
    if (epoch) peer.remoteEpoch = epoch
    if (kind !== "bye" && (recovery || !peer.pc || peer.pc.connectionState === "closed" || peer.dc?.readyState === "closed")) this.ensurePeerConnection(peer, `signal:${kind}`)
    return peer
  }

  private restartPeerConnection(peer: PeerState, reason: string, announceRecovery = false) {
    this.ensurePeerConnection(peer, reason)
    if (announceRecovery) this.sendPeerHello(peer, { recovery: true })
    this.emit({ type: "peer", peer: this.peerSnapshot(peer) })
    this.notify()
  }

  private ensurePeerConnection(peer: PeerState, reason: string) {
    const epoch = this.nextRtcEpoch()
    peer.rtcEpoch = epoch
    peer.lastError = ""
    peer.makingOffer = false
    this.closePeerRTC(peer)
    const pc = new RTCPeerConnection({ iceServers: this.iceServers })
    peer.pc = pc
    pc.onicecandidate = ({ candidate }) => {
      if (peer.rtcEpoch !== epoch || !candidate) return
      this.sendSignal({ kind: "candidate", to: peer.id, rtcEpoch: epoch, candidate: candidate.toJSON() })
    }
    pc.ondatachannel = ({ channel }) => {
      if (peer.rtcEpoch !== epoch) return
      this.attachChannel(peer, channel, epoch)
    }
    pc.onnegotiationneeded = async () => {
      if (peer.rtcEpoch !== epoch || peer.pc !== pc) return
      try {
        peer.makingOffer = true
        await pc.setLocalDescription()
        if (peer.rtcEpoch !== epoch || peer.pc !== pc || !pc.localDescription) return
        this.sendSignal({ kind: "description", to: peer.id, rtcEpoch: epoch, description: pc.localDescription.toSdp() })
      } catch (error) {
        peer.lastError = `${error}`
        this.pushLog("rtc:negotiation-error", { peer: peer.id, reason, error: `${error}` }, "error")
        this.failPeerTransfers(peer, "failed")
      } finally {
        if (peer.rtcEpoch === epoch) peer.makingOffer = false
        this.emit({ type: "peer", peer: this.peerSnapshot(peer) })
        this.notify()
      }
    }
    pc.onconnectionstatechange = () => {
      if (peer.rtcEpoch !== epoch) return
      peer.lastSeenAt = Date.now()
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        peer.lastError ||= pc.connectionState
        this.failPeerTransfers(peer, pc.connectionState)
      }
      if (pc.connectionState === "connected") void this.refreshPeerStats()
      this.emit({ type: "peer", peer: this.peerSnapshot(peer) })
      this.notify()
    }
    pc.oniceconnectionstatechange = () => {
      if (peer.rtcEpoch !== epoch) return
      peer.lastSeenAt = Date.now()
      if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") void this.refreshPeerStats()
      this.emit({ type: "peer", peer: this.peerSnapshot(peer) })
      this.notify()
    }
    if (this.localId < peer.id) this.attachChannel(peer, pc.createDataChannel("data", { ordered: true }), epoch)
    this.pushLog("rtc:peer-open", { peer: peer.id, reason, rtcEpoch: epoch })
    return peer
  }

  private attachChannel(peer: PeerState, channel: RTCDataChannel, epoch: number) {
    if (peer.rtcEpoch !== epoch) {
      try { channel.close() } catch {}
      return
    }
    channel.bufferedAmountLowThreshold = CHUNK
    peer.dc = channel
    channel.onopen = () => {
      if (peer.rtcEpoch !== epoch) return
      peer.lastSeenAt = Date.now()
      this.pushLog("dc:open", { peer: peer.id, rtcEpoch: epoch })
      this.flushOffers(peer)
      this.pumpSender(peer)
      void this.refreshPeerStats()
      this.emit({ type: "peer", peer: this.peerSnapshot(peer) })
      this.notify()
    }
    channel.onclose = () => {
      if (peer.rtcEpoch !== epoch) return
      peer.lastSeenAt = Date.now()
      if (peer.presence === "active") peer.lastError ||= "channel closed"
      this.emit({ type: "peer", peer: this.peerSnapshot(peer) })
      this.notify()
    }
    channel.onerror = event => {
      if (peer.rtcEpoch !== epoch) return
      peer.lastError = `${event.error ?? "channel error"}`
      this.emit({ type: "peer", peer: this.peerSnapshot(peer) })
      this.notify()
    }
    channel.onmessage = ({ data }) => void this.onDataMessage(peer, data)
  }

  private trackRtcClose(closeTask: Promise<void> | null | undefined) {
    if (!closeTask) return
    const task = closeTask.catch(() => {}).finally(() => {
      this.pendingRtcCloses.delete(task)
    })
    this.pendingRtcCloses.add(task)
  }

  private closePeerRTC(peer: PeerState) {
    const dc = peer.dc
    const pc = peer.pc
    peer.dc = null
    peer.pc = null
    if (dc) {
      ;(dc as any).onopen = null
      ;(dc as any).onclose = null
      ;(dc as any).onerror = null
      ;(dc as any).onmessage = null
    }
    if (pc) {
      ;(pc as any).onicecandidate = null
      ;(pc as any).ondatachannel = null
      ;(pc as any).onnegotiationneeded = null
      ;(pc as any).onconnectionstatechange = null
      ;(pc as any).oniceconnectionstatechange = null
    }
    try { dc?.close() } catch {}
    this.trackRtcClose(pc ? Promise.resolve().then(() => pc.close()) : null)
  }

  private failPeerTransfers(peer: PeerState, reason: string) {
    for (const transfer of this.transfers.values()) if (transfer.peerId === peer.id && !isFinal(transfer)) this.completeTransfer(transfer, "error", reason)
  }

  private destroyPeer(peer: PeerState, reason: string) {
    peer.presence = "terminal"
    peer.selected = false
    peer.terminalReason = reason
    this.failPeerTransfers(peer, reason)
    this.closePeerRTC(peer)
    this.emit({ type: "peer", peer: this.peerSnapshot(peer) })
  }

  private async onSignalMessage(raw: string) {
    const message = JSON.parse(raw) as SignalMessage
    if (message.room !== this.room || message.from === this.localId || (message.to && message.to !== "*" && message.to !== this.localId)) return
    this.pushLog("signal:in", message)
    const peer = this.peers.get(message.from) ?? (message.kind === "bye" ? null : this.buildPeer(message.from, message.instanceId))
    if (peer && !this.acceptPeerInstance(peer, message.instanceId, message.kind)) return

    if (message.kind === "hello") {
      if (!peer) return
      const synced = this.syncPeerSignal(this.syncPeerPresence(peer, message.name, message.profile, message.turnAvailable), "hello", message.rtcEpoch, !!message.recovery)
      if (synced && !message.reply) this.sendPeerHello(synced, { reply: true })
      this.notify()
      return
    }
    if (message.kind === "name") {
      if (!peer) return
      this.syncPeerPresence(peer, message.name)
      this.notify()
      return
    }
    if (message.kind === "profile") {
      if (!peer) return
      this.syncPeerSignal(this.syncPeerPresence(peer, message.name, message.profile, message.turnAvailable), "profile", message.rtcEpoch)
      this.notify()
      return
    }
    if (message.kind === "bye") {
      if (peer) this.destroyPeer(peer, "peer-left")
      this.notify()
      return
    }
    if (message.kind === "turn-share") {
      if (!peer) return
      this.syncPeerPresence(peer)
      const added = this.mergeTurnServers(message.iceServers)
      if (added) {
        this.pushLog("turn:share-applied", { peer: peer.id, added }, "info")
        this.broadcastProfile()
        this.restartPeerConnection(peer, "turn-share", true)
      }
      this.notify()
      return
    }
    if (message.kind === "description") {
      await this.onDescriptionSignal(message)
      return
    }
    if (message.kind === "candidate") {
      await this.onCandidateSignal(message)
      return
    }
  }

  private async onDescriptionSignal(message: DescriptionSignal) {
    const existing = this.peers.get(message.from) ?? this.buildPeer(message.from, message.instanceId)
    if (!this.acceptPeerInstance(existing, message.instanceId, message.kind)) return
    const peer = this.syncPeerSignal(this.syncPeerPresence(existing, message.name, message.profile, message.turnAvailable), "description", message.rtcEpoch)
    if (!peer?.pc) return
    const offerCollision = message.description.type === "offer" && !peer.makingOffer && peer.pc.signalingState !== "stable"
    if (!peer.polite && offerCollision) return
    try {
      await peer.pc.setRemoteDescription(message.description)
      if (message.description.type === "offer") {
        await peer.pc.setLocalDescription()
        if (peer.pc.localDescription) this.sendSignal({ kind: "description", to: peer.id, rtcEpoch: peer.rtcEpoch, description: peer.pc.localDescription.toSdp() })
      }
    } catch (error) {
      peer.lastError = `${error}`
      this.pushLog("rtc:description-error", { peer: peer.id, error: `${error}` }, "error")
      this.failPeerTransfers(peer, "failed")
    }
    this.emit({ type: "peer", peer: this.peerSnapshot(peer) })
    this.notify()
  }

  private async onCandidateSignal(message: CandidateSignal) {
    const existing = this.peers.get(message.from) ?? this.buildPeer(message.from, message.instanceId)
    if (!this.acceptPeerInstance(existing, message.instanceId, message.kind)) return
    const peer = this.syncPeerSignal(this.syncPeerPresence(existing, message.name, message.profile, message.turnAvailable), "candidate", message.rtcEpoch)
    if (!peer?.pc) return
    try {
      await peer.pc.addIceCandidate(message.candidate as RTCIceCandidateInit)
    } catch (error) {
      this.pushLog("rtc:candidate-error", { peer: peer.id, error: `${error}` }, "error")
    }
    this.emit({ type: "peer", peer: this.peerSnapshot(peer) })
    this.notify()
  }

  private buildOutgoingTransfer(peer: PeerState, file: LocalFile): TransferState {
    return {
      id: uid(12),
      peerId: peer.id,
      peerName: peer.name,
      direction: "out",
      status: "queued",
      name: file.name,
      size: file.size,
      type: file.type,
      lastModified: file.lastModified,
      totalChunks: Math.ceil(file.size / CHUNK),
      chunkSize: CHUNK,
      bytes: 0,
      chunks: 0,
      speed: 0,
      eta: Infinity,
      error: "",
      createdAt: Date.now(),
      updatedAt: 0,
      startedAt: 0,
      endedAt: 0,
      savedAt: 0,
      file,
      inFlight: false,
      cancel: false,
    }
  }

  private flushOffers(peer: PeerState) {
    if (!this.isCurrentPeerChannel(peer, peer.dc)) return
    const queued = peer.outgoingQueue.map(transferId => this.transfers.get(transferId)).filter((transfer): transfer is TransferState => !!transfer && transfer.status === "queued")
    for (const transfer of queued) {
      transfer.status = "offered"
      if (!this.sendDataControl(peer, {
        kind: "file-offer",
        transferId: transfer.id,
        name: transfer.name,
        size: transfer.size,
        type: transfer.type,
        lastModified: transfer.lastModified,
        chunkSize: transfer.chunkSize,
        totalChunks: transfer.totalChunks,
      })) {
        transfer.status = "queued"
        continue
      }
      this.emit({ type: "transfer", transfer: this.transferSnapshot(transfer) })
    }
    this.notify()
  }

  private pumpSender(peer: PeerState) {
    if (peer.activeOutgoing || !this.isCurrentPeerChannel(peer, peer.dc)) return
    const transfer = peer.outgoingQueue.map(transferId => this.transfers.get(transferId)).find((next): next is TransferState => !!next && next.status === "accepted")
    if (!transfer || !peer.dc) return
    peer.activeOutgoing = transfer.id
    if (!this.sendDataControl(peer, { kind: "file-start", transferId: transfer.id }, peer.dc, peer.rtcEpoch)) {
      peer.activeOutgoing = ""
      this.notify()
      return
    }
    void this.sendFile(peer, transfer, peer.dc, peer.rtcEpoch)
  }

  private async waitForDrain(peer: PeerState, transfer: TransferState, channel: RTCDataChannel, rtcEpoch: number) {
    while (channel.bufferedAmount > BUFFER_HIGH) {
      this.assertSendAttempt(peer, transfer, channel, rtcEpoch)
      await Bun.sleep(10)
    }
  }

  private assertSendAttempt(peer: PeerState, transfer: TransferState, channel: RTCDataChannel, rtcEpoch: number) {
    if (transfer.cancel) throw new Error(transfer.cancelReason || "cancelled")
    if (peer.activeOutgoing !== transfer.id || !this.isCurrentPeerChannel(peer, channel, rtcEpoch)) throw new Error("closed")
  }

  private async sendFile(peer: PeerState, transfer: TransferState, channel: RTCDataChannel, rtcEpoch: number) {
    transfer.status = "sending"
    transfer.startedAt ||= Date.now()
    transfer.inFlight = true
    this.noteTransfer(transfer)
    this.emit({ type: "transfer", transfer: this.transferSnapshot(transfer) })
    this.notify()
    try {
      for (let offset = 0; offset < transfer.size; offset += CHUNK) {
        this.assertSendAttempt(peer, transfer, channel, rtcEpoch)
        await this.waitForDrain(peer, transfer, channel, rtcEpoch)
        const chunk = await readFileChunk(transfer.file!, offset, CHUNK)
        this.assertSendAttempt(peer, transfer, channel, rtcEpoch)
        channel.send(chunk)
        transfer.bytes += chunk.byteLength
        transfer.chunks += 1
        this.noteTransfer(transfer)
        this.notify()
      }
      this.assertSendAttempt(peer, transfer, channel, rtcEpoch)
      transfer.status = "awaiting-done"
      transfer.inFlight = false
      this.noteTransfer(transfer)
      this.emit({ type: "transfer", transfer: this.transferSnapshot(transfer) })
      if (!this.sendDataControl(peer, { kind: "file-end", transferId: transfer.id, size: transfer.size, totalChunks: transfer.totalChunks }, channel, rtcEpoch)) throw new Error("closed")
    } catch (error) {
      transfer.inFlight = false
      if (transfer.cancel) {
        const reason = transfer.cancelReason || "cancelled"
        if (transfer.cancelSource !== "remote") this.sendDataControl(peer, { kind: "file-cancel", transferId: transfer.id, reason }, channel, rtcEpoch)
        this.completeTransfer(transfer, "cancelled", reason)
      } else {
        const reason = `${error}`.includes("closed") ? "closed" : `${error}`
        if (reason !== "closed") this.sendDataControl(peer, { kind: "file-error", transferId: transfer.id, reason }, channel, rtcEpoch)
        this.completeTransfer(transfer, "error", reason)
      }
    }
  }

  private async onDataMessage(peer: PeerState, raw: string | Buffer) {
    peer.lastSeenAt = Date.now()
    if (typeof raw === "string") {
      const message = JSON.parse(raw) as DataMessage
      await this.handleTransferControl(peer, message)
      return
    }
    this.onBinary(peer, raw)
  }

  private onBinary(peer: PeerState, data: Buffer) {
    const transfer = this.transfers.get(peer.activeIncoming)
    if (!transfer || transfer.status !== "receiving") return
    transfer.buffers ||= []
    transfer.buffers.push(data)
    transfer.bytes += data.byteLength
    transfer.chunks += 1
    this.noteTransfer(transfer)
    this.notify()
  }

  private async handleTransferControl(peer: PeerState, message: DataMessage) {
    if (message.to && message.to !== this.localId && message.to !== "*") return
    this.pushLog("data:in", message)
    switch (message.kind) {
      case "file-offer": {
        if (!this.transfers.has(message.transferId)) {
          const transfer: TransferState = {
            id: message.transferId,
            peerId: peer.id,
            peerName: peer.name,
            direction: "in",
            status: "pending",
            name: message.name,
            size: message.size,
            type: message.type,
            lastModified: message.lastModified,
            totalChunks: message.totalChunks || Math.ceil(message.size / (message.chunkSize || CHUNK)),
            chunkSize: message.chunkSize || CHUNK,
            bytes: 0,
            chunks: 0,
            speed: 0,
            eta: Infinity,
            error: "",
            createdAt: Date.now(),
            updatedAt: 0,
            startedAt: 0,
            endedAt: 0,
            savedAt: 0,
            buffers: [],
            inFlight: false,
            cancel: false,
          }
          this.transfers.set(message.transferId, transfer)
          this.emit({ type: "transfer", transfer: this.transferSnapshot(transfer) })
        }
        if (this.autoAcceptIncoming) await this.acceptTransfer(message.transferId)
        break
      }
      case "file-accept": {
        const transfer = this.transfers.get(message.transferId)
        if (transfer && transfer.direction === "out" && transfer.status === "offered") {
          transfer.status = "accepted"
          this.noteTransfer(transfer)
          this.emit({ type: "transfer", transfer: this.transferSnapshot(transfer) })
          this.pumpSender(peer)
        }
        break
      }
      case "file-start": {
        const transfer = this.transfers.get(message.transferId)
        if (transfer && transfer.direction === "in" && transfer.status === "accepted") {
          peer.activeIncoming = transfer.id
          transfer.status = "receiving"
          transfer.startedAt ||= Date.now()
          transfer.buffers = []
          this.noteTransfer(transfer)
          this.emit({ type: "transfer", transfer: this.transferSnapshot(transfer) })
        }
        break
      }
      case "file-reject": {
        const transfer = this.transfers.get(message.transferId)
        if (transfer) this.completeTransfer(transfer, "rejected", message.reason)
        break
      }
      case "file-end": {
        const transfer = this.transfers.get(message.transferId)
        if (!transfer || transfer.direction !== "in") break
        if (transfer.status === "cancelling") {
          this.completeTransfer(transfer, "cancelled", transfer.cancelReason || "cancelled")
          break
        }
        if (transfer.status !== "receiving") {
          this.completeTransfer(transfer, "error", `unexpected end while ${transfer.status}`)
          break
        }
        const data = Buffer.concat(transfer.buffers || [])
        if (data.byteLength !== message.size) {
          const reason = `size mismatch: ${data.byteLength} vs ${message.size}`
          this.sendDataControl(peer, { kind: "file-error", transferId: transfer.id, reason })
          this.completeTransfer(transfer, "error", reason)
          break
        }
        transfer.data = data
        transfer.buffers = []
        this.sendDataControl(peer, { kind: "file-done", transferId: transfer.id, size: transfer.bytes, totalChunks: transfer.chunks })
        this.completeTransfer(transfer, "complete")
        break
      }
      case "file-done": {
        const transfer = this.transfers.get(message.transferId)
        if (transfer && transfer.direction === "out") this.completeTransfer(transfer, "complete")
        break
      }
      case "file-cancel":
      case "file-error": {
        const transfer = this.transfers.get(message.transferId)
        if (!transfer || isFinal(transfer)) break
        const status = message.kind === "file-error" ? "error" : "cancelled"
        if (transfer.direction === "out" && transfer.inFlight) {
          transfer.cancel = true
          transfer.cancelReason = message.reason
          transfer.cancelSource = "remote"
          if (status === "cancelled") transfer.status = "cancelling"
          this.emit({ type: "transfer", transfer: this.transferSnapshot(transfer) })
          this.notify()
        } else {
          this.completeTransfer(transfer, status, message.reason)
        }
        break
      }
    }
    this.notify()
  }
}
