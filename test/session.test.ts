import { describe, expect, test } from "bun:test"
import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { SendSession, connectivitySnapshotFromReport, localProfileFromResponse } from "../src/core/session"

const incomingTransfer = (overrides: Record<string, unknown> = {}) => ({
  id: "t1",
  peerId: "p1",
  peerName: "alice",
  direction: "in",
  status: "pending",
  name: "hello.txt",
  size: 5,
  type: "text/plain",
  lastModified: 0,
  totalChunks: 1,
  chunkSize: 5,
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
  inFlight: false,
  cancel: false,
  buffers: [],
  ...overrides,
})

const outgoingTransfer = (overrides: Record<string, unknown> = {}) => incomingTransfer({
  direction: "out",
  status: "queued",
  buffers: undefined,
  ...overrides,
})

const readyPeer = (messages: string[] = []): any => ({
  id: "p1",
  name: "alice",
  presence: "active",
  selected: true,
  polite: false,
  pc: { connectionState: "connected" },
  dc: { readyState: "open", send: (message: string) => void messages.push(message) },
  rtcEpoch: 1,
  remoteEpoch: 0,
    makingOffer: false,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    outgoingQueue: [] as string[],
    activeOutgoing: "",
    activeIncoming: "",
  turnAvailable: false,
  terminalReason: "",
  lastError: "",
  connectivity: { rttMs: Number.NaN, localCandidateType: "", remoteCandidateType: "", pathLabel: "—" },
})

describe("SendSession mutators", () => {
  test("uses the provided localId and sanitizes names", () => {
    const session = new SendSession({ room: "demo", localId: "self-42", name: " Alice Cooper ", reconnectSocket: false })
    expect(session.snapshot().localId).toBe("self42")
    expect(session.setName(" New Name ")).toBe("newname")
    expect(session.snapshot().name).toBe("newname")
    expect(session.snapshot().profile?.ua?.browser).toBe("send-cli")
    expect(session.snapshot().profile?.defaults).toEqual({
      autoAcceptIncoming: false,
      autoSaveIncoming: false,
    })
    expect(session.snapshot().pulse.state).toBe("idle")
    expect(session.snapshot().turnState).toBe("none")
  })

  test("rebroadcasts advertised profile defaults when auto-accept and auto-save change", async () => {
    const sent: string[] = []
    const session = new SendSession({ room: "demo", reconnectSocket: false }) as any
    session.socket = { readyState: WebSocket.OPEN, send: (message: string) => void sent.push(message) }

    await session.setAutoAcceptIncoming(true)
    await session.setAutoSaveIncoming(true)

    const profiles = sent
      .map(message => JSON.parse(message))
      .filter(message => message.kind === "profile")
      .map(message => message.profile?.defaults)

    expect(profiles.at(-1)).toEqual({
      autoAcceptIncoming: true,
      autoSaveIncoming: true,
    })
    expect(session.snapshot().profile?.defaults).toEqual({
      autoAcceptIncoming: true,
      autoSaveIncoming: true,
    })
  })

  test("notifies subscribers for consecutive inbound profile updates", async () => {
    const session = new SendSession({ room: "demo", localId: "self", reconnectSocket: false }) as any
    const snapshots: Array<{ autoAcceptIncoming?: boolean; autoSaveIncoming?: boolean } | undefined> = []
    session.subscribe(() => {
      const next = session.snapshot().peers[0]?.profile?.defaults
      if (JSON.stringify(snapshots.at(-1)) !== JSON.stringify(next)) snapshots.push(next)
    })

    await session.onSignalMessage(JSON.stringify({
      room: "demo",
      from: "peer1",
      to: "*",
      at: Date.now(),
      kind: "profile",
      name: "alice",
      profile: { defaults: { autoAcceptIncoming: true, autoSaveIncoming: false } },
    }))
    await session.onSignalMessage(JSON.stringify({
      room: "demo",
      from: "peer1",
      to: "*",
      at: Date.now(),
      kind: "profile",
      name: "alice",
      profile: { defaults: { autoAcceptIncoming: false, autoSaveIncoming: true } },
    }))

    expect(snapshots).toEqual([
      { autoAcceptIncoming: true, autoSaveIncoming: false },
      { autoAcceptIncoming: false, autoSaveIncoming: true },
    ])
    expect(session.snapshot().peers[0]?.profile?.defaults).toEqual({
      autoAcceptIncoming: false,
      autoSaveIncoming: true,
    })
  })

  test("notifies subscribers for inbound name updates", async () => {
    const session = new SendSession({ room: "demo", localId: "self", reconnectSocket: false }) as any
    const names: string[] = []
    session.subscribe(() => {
      const name = session.snapshot().peers[0]?.name
      if (name && names.at(-1) !== name) names.push(name)
    })

    await session.onSignalMessage(JSON.stringify({
      room: "demo",
      from: "peer1",
      to: "*",
      at: Date.now(),
      kind: "hello",
      name: "alice",
      reply: true,
    }))
    await session.onSignalMessage(JSON.stringify({
      room: "demo",
      from: "peer1",
      to: "*",
      at: Date.now(),
      kind: "name",
      name: "bob",
    }))

    expect(names).toEqual(["user", "alice", "bob"])
    expect(session.snapshot().peers[0]?.name).toBe("bob")
  })

  test("enabling auto-accept accepts current pending transfers", async () => {
    const sent: string[] = []
    const session = new SendSession({ room: "demo", reconnectSocket: false }) as any
    session.peers.set("p1", readyPeer(sent))
    const peer = session.snapshot().peers[0]
    expect(peer.status).toBe("connected")
    expect(peer.dataState).toBe("open")
    expect(peer.turnState).toBe("none")
    expect(peer.selectable).toBe(true)
    session.transfers.set("t1", incomingTransfer())
    const accepted = await session.setAutoAcceptIncoming(true)
    expect(accepted).toBe(1)
    expect(session.transfers.get("t1").status).toBe("accepted")
    expect(JSON.parse(sent[0]).kind).toBe("file-accept")
  })

  test("enabling auto-save saves current completed incoming transfers", async () => {
    const dir = join(process.cwd(), ".tmp-send-session-test")
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })
    const session = new SendSession({ room: "demo", saveDir: dir, reconnectSocket: false }) as any
    session.transfers.set("t1", incomingTransfer({ status: "complete", data: Buffer.from("hello") }))
    const saved = await session.setAutoSaveIncoming(true)
    const transfer = session.transfers.get("t1")
    expect(saved).toBe(1)
    expect(transfer.savedAt > 0).toBe(true)
    expect(transfer.savedPath.endsWith("hello.txt")).toBe(true)
    await rm(dir, { recursive: true, force: true })
  })

  test("clears completed and failed transfers without touching active ones", () => {
    const session = new SendSession({ room: "demo", reconnectSocket: false }) as any
    const peer = readyPeer()
    peer.outgoingQueue = ["done", "failed", "active"]
    session.peers.set("p1", peer)
    session.transfers.set("done", incomingTransfer({ id: "done", status: "complete" }))
    session.transfers.set("failed", incomingTransfer({ id: "failed", status: "error" }))
    session.transfers.set("active", incomingTransfer({ id: "active", status: "receiving" }))
    expect(session.clearCompletedTransfers()).toBe(1)
    expect(session.transfers.has("done")).toBe(false)
    expect(session.transfers.has("failed")).toBe(true)
    expect(session.clearFailedTransfers()).toBe(1)
    expect(session.transfers.has("failed")).toBe(false)
    expect(session.transfers.has("active")).toBe(true)
    expect(peer.outgoingQueue).toEqual(["active"])
  })

  test("cancels only outgoing queued and offered transfers from pending offers", () => {
    const session = new SendSession({ room: "demo", reconnectSocket: false }) as any
    const peer = readyPeer()
    peer.dc = null
    peer.outgoingQueue = ["queued", "offered", "accepted"]
    session.peers.set("p1", peer)
    session.transfers.set("queued", outgoingTransfer({ id: "queued", peerId: "p1", status: "queued" }))
    session.transfers.set("offered", outgoingTransfer({ id: "offered", peerId: "p1", status: "offered" }))
    session.transfers.set("accepted", outgoingTransfer({ id: "accepted", peerId: "p1", status: "accepted" }))
    session.transfers.set("incoming", incomingTransfer({ id: "incoming", peerId: "p1", status: "pending" }))

    expect(session.cancelPendingOffers()).toBe(2)
    expect(session.transfers.get("queued").status).toBe("cancelled")
    expect(session.transfers.get("offered").status).toBe("cancelled")
    expect(session.transfers.get("accepted").status).toBe("accepted")
    expect(session.transfers.get("incoming").status).toBe("pending")
    expect(peer.outgoingQueue).toEqual(["accepted"])
  })

  test("extracts connectivity path labels from getStats-style reports", () => {
    const report = new Map([
      ["transport-1", { id: "transport-1", type: "transport", selectedCandidatePairId: "pair-1" }],
      ["pair-1", { id: "pair-1", type: "candidate-pair", localCandidateId: "local-1", remoteCandidateId: "remote-1", currentRoundTripTime: 0.125 }],
      ["local-1", { id: "local-1", type: "local-candidate", candidateType: "host" }],
      ["remote-1", { id: "remote-1", type: "remote-candidate", candidateType: "relay" }],
    ])
    expect(connectivitySnapshotFromReport(report)).toEqual({
      rttMs: 125,
      localCandidateType: "host",
      remoteCandidateType: "relay",
      pathLabel: "Direct ↔ TURN",
    })
  })

  test("falls back to a succeeded candidate pair on the active transport when selectedCandidatePairId misses", () => {
    const report = [
      { id: "transport-1", type: "transport", selectedCandidatePairId: "candidate-pair_host_srflx" },
      { id: "local-1", type: "local-candidate", candidateType: "host" },
      { id: "remote-1", type: "remote-candidate", candidateType: "srflx" },
      { id: "pair-1", type: "candidate-pair", transportId: "transport-1", localCandidateId: "local-1", remoteCandidateId: "remote-1", state: "succeeded", currentRoundTripTime: 0.055 },
    ]
    expect(connectivitySnapshotFromReport(report)).toEqual({
      rttMs: 55,
      localCandidateType: "host",
      remoteCandidateType: "srflx",
      pathLabel: "Direct ↔ NAT",
    })
  })

  test("keeps the previous RTT when a later stats sample omits round-trip time", () => {
    const previous = { rttMs: 55, localCandidateType: "host", remoteCandidateType: "srflx", pathLabel: "Direct ↔ NAT" }
    const report = [
      { id: "transport-1", type: "transport", selectedCandidatePairId: "pair-1" },
      { id: "local-1", type: "local-candidate", candidateType: "host" },
      { id: "remote-1", type: "remote-candidate", candidateType: "relay" },
      { id: "pair-1", type: "candidate-pair", localCandidateId: "local-1", remoteCandidateId: "remote-1", state: "succeeded" },
    ]
    expect(connectivitySnapshotFromReport(report, previous)).toEqual({
      rttMs: 55,
      localCandidateType: "host",
      remoteCandidateType: "relay",
      pathLabel: "Direct ↔ TURN",
    })
  })

  test("patched werift transport stats use matching selected pair ids", async () => {
    const { RTCIceTransport } = await import("../node_modules/werift/lib/webrtc/src/transport/ice.js")
    const { RTCDtlsTransport } = await import("../node_modules/werift/lib/webrtc/src/transport/dtls.js")
    const pair = {
      localCandidate: { foundation: "host" },
      remoteCandidate: { foundation: "relay" },
      nominated: true,
      state: "succeeded",
      packetsSent: 0,
      packetsReceived: 0,
      bytesSent: 0,
      bytesReceived: 0,
      rtt: 0.021,
    }
    const iceStats = await RTCIceTransport.prototype.getStats.call({
      id: "ice-1",
      localCandidates: [],
      connection: { remoteCandidates: [], candidatePairs: [pair] },
    }) as Array<{ type?: string; id?: string }>
    const pairStat = iceStats.find(stat => stat.type === "candidate-pair")
    expect(pairStat?.id).toBe("candidate-pair_host_relay")

    const dtlsStats = await RTCDtlsTransport.prototype.getStats.call({
      id: "dtls-1",
      bytesSent: 0,
      bytesReceived: 0,
      packetsSent: 0,
      packetsReceived: 0,
      state: "connected",
      iceTransport: {
        state: "connected",
        connection: { nominated: pair },
        getStats: async () => iceStats,
      },
      localCertificate: null,
      remoteParameters: null,
      role: "auto",
    }) as Array<{ type?: string; selectedCandidatePairId?: string }>
    const transportStat = dtlsStats.find(stat => stat.type === "transport")
    expect(transportStat?.selectedCandidatePairId).toBe(pairStat?.id)
  })

  test("derives local TURN usage from active relay connectivity", () => {
    const session = new SendSession({ room: "demo", turnUrls: ["turn:turn.example.com:3478"], reconnectSocket: false }) as any
    const peer = readyPeer()
    peer.connectivity = { rttMs: 12, localCandidateType: "relay", remoteCandidateType: "host", pathLabel: "TURN ↔ Direct" }
    session.peers.set("p1", peer)
    expect(session.snapshot().turnState).toBe("used")
  })

  test("derives peer data state, turn state, and selectability from peer state", () => {
    const session = new SendSession({ room: "demo", reconnectSocket: false }) as any
    const peer = readyPeer()
    peer.turnAvailable = true
    peer.connectivity = { rttMs: 22, localCandidateType: "host", remoteCandidateType: "relay", pathLabel: "Direct ↔ TURN" }
    session.peers.set("p1", peer)
    const active = session.snapshot().peers[0]
    expect(active.dataState).toBe("open")
    expect(active.turnState).toBe("used")
    expect(active.selectable).toBe(true)

    peer.dc = null
    peer.pc = { connectionState: "disconnected" }
    const disconnected = session.snapshot().peers[0]
    expect(disconnected.status).toBe("disconnected")
    expect(disconnected.dataState).toBe("—")
    expect(disconnected.selectable).toBe(false)
  })

  test("sanitizes local profile payloads like the web app", () => {
    const profile = localProfileFromResponse({
      cf: { city: "Seoul", region: "Seoul", country: "KR", colo: "ICN", asOrganization: "Edge ISP", asn: 64512 },
      hs: { "cf-connecting-ip": "203.0.113.5" },
    })
    expect(profile.geo?.city).toBe("Seoul")
    expect(profile.geo?.region).toBe("Seoul")
    expect(profile.geo?.country).toBe("KR")
    expect(profile.network?.colo).toBe("ICN")
    expect(profile.network?.asOrganization).toBe("Edge ISP")
    expect(profile.network?.asn).toBe(64512)
    expect(profile.network?.ip).toBe("203.0.113.5")
    expect(profile.ua?.browser).toBe("send-cli")
    expect(profile.ready).toBe(true)
  })

  test("loads local profile data into the session snapshot", async () => {
    const session = new SendSession({ room: "demo", reconnectSocket: false }) as any
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request) => {
      if (`${input}` !== "https://ip.rt.ht/") throw new Error(`unexpected fetch ${input}`)
      return new Response(JSON.stringify({
        cf: { city: "Seoul", region: "Seoul", country: "KR", colo: "ICN", asOrganization: "Edge ISP", asn: 64512 },
        hs: { "cf-connecting-ip": "203.0.113.5" },
      }), { headers: { "content-type": "application/json" } })
    }) as typeof fetch
    try {
      await session.loadLocalProfile()
      const profile = session.snapshot().profile
      expect(profile?.geo?.city).toBe("Seoul")
      expect(profile?.geo?.region).toBe("Seoul")
      expect(profile?.geo?.country).toBe("KR")
      expect(profile?.network?.colo).toBe("ICN")
      expect(profile?.network?.asOrganization).toBe("Edge ISP")
      expect(profile?.network?.ip).toBe("203.0.113.5")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("records pulse probe success and failure", async () => {
    const session = new SendSession({ room: "demo", reconnectSocket: false }) as any
    const originalFetch = globalThis.fetch
    try {
      globalThis.fetch = (async () => new Response("ok")) as typeof fetch
      await session.probePulse()
      expect(session.snapshot().pulse.state).toBe("open")
      expect(session.snapshot().pulse.ms >= 0).toBe(true)

      globalThis.fetch = (async () => { throw new Error("pulse down") }) as typeof fetch
      await session.probePulse()
      expect(session.snapshot().pulse.state).toBe("error")
      expect(session.snapshot().pulse.error).toContain("pulse down")
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
