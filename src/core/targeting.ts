import { cleanName, displayPeerName } from "./protocol"

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

const matchesSelector = (peer: TargetPeer, selector: string) => selector === peer.id || selector === displayPeerName(peer.name, peer.id) || selector === cleanName(peer.name)

export const resolvePeerTargets = (peers: TargetPeer[], selectors: string[]): ResolveTargetsResult => {
  const active = peers.filter(peer => peer.presence === "active")
  const ready = active.filter(peer => peer.ready)
  const requested = [...new Set(selectors.filter(Boolean))]
  const normalized = requested.length ? requested : [BROADCAST_SELECTOR]
  if (normalized.includes(BROADCAST_SELECTOR)) {
    if (normalized.length > 1) return { ok: false, peers: [], error: "broadcast selector `.` cannot be combined with specific peers" }
    return ready.length ? { ok: true, peers: ready } : { ok: false, peers: [], error: "no ready peers" }
  }
  const matches = uniquePeers(active.filter(peer => normalized.some(selector => matchesSelector(peer, selector))))
  if (matches.length !== normalized.length) {
    const missing = normalized.filter(selector => !matches.some(peer => matchesSelector(peer, selector)))
    return { ok: false, peers: [], error: `no matching peer for ${missing.join(", ")}` }
  }
  const notReady = matches.filter(peer => !peer.ready)
  if (notReady.length) return { ok: false, peers: [], error: `peer not ready: ${notReady.map(peer => displayPeerName(peer.name, peer.id)).join(", ")}` }
  return { ok: true, peers: matches }
}
