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
const BROADCAST_SELECTOR_ERROR = "broadcast selector `.` cannot be combined with specific peers"

const uniquePeers = (peers: TargetPeer[]) => [...new Map(peers.map(peer => [peer.id, peer])).values()]
const normalizeName = (value: unknown) => cleanText(value, 24).toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 24)
const parseSelector = (selector: string) => {
  const hyphen = selector.lastIndexOf("-")
  return hyphen < 0
    ? { raw: selector, kind: "name" as const, value: normalizeName(selector) }
    : { raw: selector, kind: "id" as const, value: selector.slice(hyphen + 1) }
}
const matchesSelector = (peer: Pick<TargetPeer, "id" | "name">, selector: ReturnType<typeof parseSelector>) =>
  selector.kind === "name" ? normalizeName(peer.name) === selector.value : peer.id === selector.value
export const normalizePeerSelectors = (selectors: string[]) => {
  const requested = [...new Set(selectors.map(selector => `${selector ?? ""}`.trim()).filter(Boolean))]
  return requested.length ? requested : [BROADCAST_SELECTOR]
}

export const validatePeerSelectors = (selectors: string[]) => {
  const normalized = normalizePeerSelectors(selectors)
  return normalized.includes(BROADCAST_SELECTOR) && normalized.length > 1
    ? { ok: false as const, selectors: normalized, error: BROADCAST_SELECTOR_ERROR }
    : { ok: true as const, selectors: normalized }
}

export const peerMatchesSelectors = (peer: Pick<TargetPeer, "id" | "name">, selectors: string[]) => {
  const normalized = normalizePeerSelectors(selectors)
  if (normalized.includes(BROADCAST_SELECTOR)) return normalized.length === 1
  return normalized.map(parseSelector).some(selector => matchesSelector(peer, selector))
}

export const resolvePeerTargets = (peers: TargetPeer[], selectors: string[]): ResolveTargetsResult => {
  const active = peers.filter(peer => peer.presence === "active")
  const validated = validatePeerSelectors(selectors)
  if (!validated.ok) return { ok: false, peers: [], error: validated.error }
  const { selectors: normalized } = validated
  if (normalized.includes(BROADCAST_SELECTOR)) {
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
