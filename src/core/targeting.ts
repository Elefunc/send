import { cleanText, displayPeerName } from "./protocol"

export interface TargetPeer {
  id: string
  name: string
  ready: boolean
  presence: "active" | "terminal"
}

export interface ResolveTargetsResult {
  ok: boolean
  peers: TargetPeer[]
  error?: string
}

const BROADCAST_SELECTOR = "."

const uniquePeers = (peers: TargetPeer[]) => [...new Map(peers.map(peer => [peer.id, peer])).values()]
const normalizeName = (value: unknown) => cleanText(value, 24).toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 24)
const parseSelector = (selector: string) => {
  const hyphen = selector.lastIndexOf("-")
  return hyphen < 0
    ? { raw: selector, kind: "name" as const, value: normalizeName(selector) }
    : { raw: selector, kind: "id" as const, value: selector.slice(hyphen + 1) }
}
const matchesSelector = (peer: TargetPeer, selector: ReturnType<typeof parseSelector>) =>
  selector.kind === "name" ? normalizeName(peer.name) === selector.value : peer.id === selector.value

export const resolvePeerTargets = (peers: TargetPeer[], selectors: string[]): ResolveTargetsResult => {
  const active = peers.filter(peer => peer.presence === "active")
  const requested = [...new Set(selectors.filter(Boolean))]
  const normalized = requested.length ? requested : [BROADCAST_SELECTOR]
  if (normalized.includes(BROADCAST_SELECTOR)) {
    if (normalized.length > 1) return { ok: false, peers: [], error: "broadcast selector `.` cannot be combined with specific peers" }
    const ready = active.filter(peer => peer.ready)
    return ready.length ? { ok: true, peers: ready } : { ok: false, peers: [], error: "no ready peers" }
  }
  const parsed = normalized.map(parseSelector)
  const missing = parsed.filter(selector => !active.some(peer => matchesSelector(peer, selector))).map(selector => selector.raw)
  if (missing.length) return { ok: false, peers: [], error: `no matching peer for ${missing.join(", ")}` }
  const matches = uniquePeers(active.flatMap(peer => parsed.some(selector => matchesSelector(peer, selector)) ? [peer] : []))
  const notReady = matches.filter(peer => !peer.ready)
  if (notReady.length) return { ok: false, peers: [], error: `peer not ready: ${notReady.map(peer => displayPeerName(peer.name, peer.id)).join(", ")}` }
  return { ok: true, peers: matches }
}
