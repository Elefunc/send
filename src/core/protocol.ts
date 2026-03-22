import type { RTCIceCandidateInit, RTCSessionDescriptionInit } from "werift"

export const SIGNAL_WS_URL = "wss://sig.efn.kr/ws"
export const BASE_ICE_SERVERS = [
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:stun.l.google.com:19302" },
]

export const CHUNK = 64 * 1024
export const BUFFER_HIGH = 1024 * 1024
export const FINAL_STATUSES = new Set(["complete", "rejected", "cancelled", "error"] as const)
export const SENDABLE_STATUSES = new Set(["queued", "offered", "accepted", "sending", "awaiting-done", "cancelling"] as const)

export type SocketState = "idle" | "connecting" | "open" | "closed" | "error"
export type Presence = "active" | "terminal"
export type Direction = "in" | "out"
export type TransferStatus =
  | "pending"
  | "queued"
  | "offered"
  | "accepted"
  | "receiving"
  | "sending"
  | "awaiting-done"
  | "cancelling"
  | "complete"
  | "rejected"
  | "cancelled"
  | "error"

export interface PeerProfile {
  geo?: {
    city?: string
    region?: string
    country?: string
    timezone?: string
  }
  network?: {
    colo?: string
    asOrganization?: string
    asn?: number
    ip?: string
  }
  ua?: {
    browser?: string
    os?: string
    device?: string
  }
  defaults?: {
    autoAcceptIncoming?: boolean
    autoSaveIncoming?: boolean
  }
  ready?: boolean
  error?: string
}

export interface SignalEnvelope {
  room: string
  from: string
  to: string
  at: string
}

export interface HelloSignal extends SignalEnvelope {
  kind: "hello"
  name: string
  turnAvailable: boolean
  profile?: PeerProfile
  rtcEpoch?: number
  reply?: boolean
}

export interface NameSignal extends SignalEnvelope {
  kind: "name"
  name: string
}

export interface ProfileSignal extends SignalEnvelope {
  kind: "profile"
  name?: string
  turnAvailable?: boolean
  profile?: PeerProfile
  rtcEpoch?: number
}

export interface ByeSignal extends SignalEnvelope {
  kind: "bye"
}

export interface DescriptionSignal extends SignalEnvelope {
  kind: "description"
  name?: string
  turnAvailable?: boolean
  profile?: PeerProfile
  rtcEpoch?: number
  description: RTCSessionDescriptionInit
}

export interface CandidateSignal extends SignalEnvelope {
  kind: "candidate"
  name?: string
  turnAvailable?: boolean
  profile?: PeerProfile
  rtcEpoch?: number
  candidate: RTCIceCandidateInit
}

export type SignalMessage =
  | HelloSignal
  | NameSignal
  | ProfileSignal
  | ByeSignal
  | DescriptionSignal
  | CandidateSignal

export interface DataEnvelope {
  room: string
  from: string
  to: string
  at: string
}

export interface FileOfferMessage extends DataEnvelope {
  kind: "file-offer"
  transferId: string
  name: string
  size: number
  type: string
  lastModified: number
  chunkSize: number
  totalChunks: number
}

export interface FileAcceptMessage extends DataEnvelope {
  kind: "file-accept"
  transferId: string
}

export interface FileStartMessage extends DataEnvelope {
  kind: "file-start"
  transferId: string
}

export interface FileEndMessage extends DataEnvelope {
  kind: "file-end"
  transferId: string
  size: number
  totalChunks: number
}

export interface FileDoneMessage extends DataEnvelope {
  kind: "file-done"
  transferId: string
  size: number
  totalChunks: number
}

export interface FileRejectMessage extends DataEnvelope {
  kind: "file-reject"
  transferId: string
  reason: string
}

export interface FileCancelMessage extends DataEnvelope {
  kind: "file-cancel"
  transferId: string
  reason: string
}

export interface FileErrorMessage extends DataEnvelope {
  kind: "file-error"
  transferId: string
  reason: string
}

export type DataMessage =
  | FileOfferMessage
  | FileAcceptMessage
  | FileStartMessage
  | FileEndMessage
  | FileDoneMessage
  | FileRejectMessage
  | FileCancelMessage
  | FileErrorMessage

export interface LogEntry {
  id: string
  at: number
  kind: string
  level: "info" | "error"
  payload: unknown
}

export const fallbackName = "user"
export const turnStateLabel = (hasTurn: boolean) => hasTurn ? "custom-turn" : "stun"
export const stamp = () => new Date().toISOString()
export const uid = (n = 8) => [...crypto.getRandomValues(new Uint8Array(n))].map(value => (value % 36).toString(36)).join("")

export const cleanText = (value: unknown, max = 72) => `${value ?? ""}`.trim().replace(/\s+/g, " ").slice(0, max)
export const cleanRoom = (value: unknown) => cleanText(value).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || uid(8)
export const cleanName = (value: unknown) => cleanText(value, 24).toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 24) || fallbackName
export const cleanLocalId = (value: unknown) => cleanText(value, 24).toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 24) || uid(8)
export const signalEpoch = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : 0

export const buildCliProfile = (): PeerProfile => ({
  ua: { browser: "send-cli", os: process.platform, device: "desktop" },
  ready: true,
})

export const peerDefaultsToken = (profile?: PeerProfile) => {
  const autoAcceptIncoming = typeof profile?.defaults?.autoAcceptIncoming === "boolean" ? profile.defaults.autoAcceptIncoming : null
  const autoSaveIncoming = typeof profile?.defaults?.autoSaveIncoming === "boolean" ? profile.defaults.autoSaveIncoming : null
  return autoAcceptIncoming === null || autoSaveIncoming === null ? "??" : `${autoAcceptIncoming ? "A" : "a"}${autoSaveIncoming ? "S" : "s"}`
}

export const displayPeerName = (name: string, id: string) => `${cleanName(name)}-${id}`
export const clamp = (value: number) => Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0))

export const formatBytes = (value: number) => {
  const size = Number(value) || 0
  if (!size) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const tier = Math.min(units.length - 1, Math.floor(Math.log(size) / Math.log(1024)))
  const scaled = size / 1024 ** tier
  return `${scaled >= 100 || tier === 0 ? scaled.toFixed(0) : scaled >= 10 ? scaled.toFixed(1) : scaled.toFixed(2)} ${units[tier]}`
}

export const formatRate = (value: number) => value > 0 ? `${formatBytes(value)}/s` : "0 B/s"
export const formatEta = (value: number) => !Number.isFinite(value) || value < 0 ? "—" : value < 1 ? "<1s" : value < 60 ? `${value.toFixed(0)}s` : `${Math.floor(value / 60)}m ${(value % 60).toFixed(0)}s`

export const formatDuration = (value: number) => {
  const ms = Number(value) || 0
  if (!Number.isFinite(ms) || ms <= 0) return "—"
  if (ms < 1000) return "<1s"
  const total = Math.round(ms / 1000)
  if (total < 60) return `${total}s`
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  return hours ? `${hours}h ${`${minutes}`.padStart(2, "0")}m` : `${minutes}m ${`${seconds}`.padStart(2, "0")}s`
}
