import { describe, expect, test } from "bun:test"
import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { sessionRuntime } from "./runtime"

const { SendSession, connectivitySnapshotFromPeerConnection, probeIcePairConsentRtt, localProfileFromResponse } = sessionRuntime

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

  test("selects first-time peers by default", async () => {
    const session = new SendSession({ room: "demo", localId: "self", reconnectSocket: false }) as any

    await session.onSignalMessage(JSON.stringify({
      room: "demo",
      from: "peer1",
      to: "*",
      at: Date.now(),
      kind: "hello",
      name: "alice",
      reply: true,
    }))

    expect(session.snapshot().peers[0]?.selected).toBe(true)
  })

  test("remembers deselected peers across leave and same-id rejoin", async () => {
    const session = new SendSession({ room: "demo", localId: "self", reconnectSocket: false }) as any

    await session.onSignalMessage(JSON.stringify({
      room: "demo",
      from: "peer1",
      to: "*",
      at: Date.now(),
      kind: "hello",
      name: "alice",
      reply: true,
    }))
    expect(session.setPeerSelected("peer1", false)).toBe(true)

    await session.onSignalMessage(JSON.stringify({
      room: "demo",
      from: "peer1",
      to: "*",
      at: Date.now(),
      kind: "bye",
    }))
    expect(session.snapshot().peers[0]?.presence).toBe("terminal")
    expect(session.snapshot().peers[0]?.selected).toBe(false)

    await session.onSignalMessage(JSON.stringify({
      room: "demo",
      from: "peer1",
      to: "*",
      at: Date.now(),
      kind: "hello",
      name: "alice",
      reply: true,
    }))

    expect(session.snapshot().peers[0]?.presence).toBe("active")
    expect(session.snapshot().peers[0]?.selected).toBe(false)
  })

  test("reuses remembered peer selection across session instances in the same room", async () => {
    const peerSelectionMemory = new Map<string, boolean>([["peer1", false]])
    const session = new SendSession({ room: "demo", localId: "self", reconnectSocket: false, peerSelectionMemory }) as any

    await session.onSignalMessage(JSON.stringify({
      room: "demo",
      from: "peer1",
      to: "*",
      at: Date.now(),
      kind: "hello",
      name: "alice",
      reply: true,
    }))
    expect(session.snapshot().peers[0]?.selected).toBe(false)

    expect(session.setPeerSelected("peer1", true)).toBe(true)
    expect(peerSelectionMemory.get("peer1")).toBe(true)

    const nextSession = new SendSession({ room: "demo", localId: "self", reconnectSocket: false, peerSelectionMemory }) as any
    await nextSession.onSignalMessage(JSON.stringify({
      room: "demo",
      from: "peer1",
      to: "*",
      at: Date.now(),
      kind: "hello",
      name: "alice",
      reply: true,
    }))

    expect(nextSession.snapshot().peers[0]?.selected).toBe(true)
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

  test("extracts connectivity path labels from nominated ICE pairs", () => {
    const snapshot = connectivitySnapshotFromPeerConnection({
      iceTransports: [{ state: "completed", connection: { nominated: { localCandidate: { type: "host" }, remoteCandidate: { type: "relay" } } } }],
    })
    expect(Number.isNaN(snapshot.rttMs)).toBe(true)
    expect(snapshot.localCandidateType).toBe("host")
    expect(snapshot.remoteCandidateType).toBe("relay")
    expect(snapshot.pathLabel).toBe("Direct ↔ TURN")
  })

  test("falls back to any nominated pair when transport state is unavailable", () => {
    const snapshot = connectivitySnapshotFromPeerConnection({
      iceTransports: [{ connection: { nominated: { localCandidate: { candidateType: "host" }, remoteCandidate: { candidateType: "prflx" } } } }],
    })
    expect(snapshot.localCandidateType).toBe("host")
    expect(snapshot.remoteCandidateType).toBe("prflx")
    expect(snapshot.pathLabel).toBe("Direct ↔ NAT")
  })

  test("keeps the previous connectivity snapshot when no nominated pair is available", () => {
    const previous = { rttMs: 55, localCandidateType: "host", remoteCandidateType: "srflx", pathLabel: "Direct ↔ NAT" }
    expect(connectivitySnapshotFromPeerConnection({ iceTransports: [{ state: "checking", connection: {} }] }, previous)).toEqual(previous)
  })

  test("updates peer path from the nominated ICE pair during connectivity refresh", async () => {
    const session = new SendSession({ room: "demo", reconnectSocket: false }) as any
    const peer = readyPeer()
    peer.pc = {
      connectionState: "connected",
      iceTransports: [{
        state: "completed",
        connection: {
          localUsername: "local",
          remoteUsername: "remote",
          remotePassword: "pw",
          iceControlling: true,
          buildRequest: () => ({}),
          nominated: {
            remoteAddr: "127.0.0.1:0",
            localCandidate: { type: "host" },
            remoteCandidate: { type: "host" },
            protocol: { request: async () => {} },
          },
        },
      }],
    }
    session.peers.set("p1", peer)

    await session.refreshPeerStats()

    expect(session.snapshot().peers[0]?.localCandidateType).toBe("host")
    expect(session.snapshot().peers[0]?.remoteCandidateType).toBe("host")
    expect(session.snapshot().peers[0]?.pathLabel).toBe("Direct ↔ Direct")
  })

  test("probes ICE consent RTT directly from the nominated pair", async () => {
    const calls: Array<{ request: unknown; remoteAddr: unknown; password: string }> = []
    const rttMs = await probeIcePairConsentRtt({
      localUsername: "local",
      remoteUsername: "remote",
      remotePassword: "pw",
      iceControlling: true,
      buildRequest: (input: unknown) => ({ built: input }),
    }, {
      remoteAddr: "127.0.0.1:3478",
      protocol: {
        request: async (request: unknown, remoteAddr: unknown, password: Buffer) => {
          calls.push({ request, remoteAddr, password: password.toString("utf8") })
          await Bun.sleep(5)
        },
      },
    })

    expect(Number.isFinite(rttMs)).toBe(true)
    expect(rttMs >= 5).toBe(true)
    expect(calls).toEqual([{
      request: { built: { nominate: false, localUsername: "local", remoteUsername: "remote", iceControlling: true } },
      remoteAddr: "127.0.0.1:3478",
      password: "pw",
    }])
  })

  test("updates peer RTT from consent probes during connectivity refresh", async () => {
    const session = new SendSession({ room: "demo", reconnectSocket: false }) as any
    const peer = readyPeer()
    const requests: unknown[] = []
    peer.pc = {
      connectionState: "connected",
      iceTransports: [{
        state: "completed",
        connection: {
          localUsername: "local",
          remoteUsername: "remote",
          remotePassword: "pw",
          iceControlling: true,
          buildRequest: (input: unknown) => ({ built: input }),
          nominated: {
            remoteAddr: "127.0.0.1:3478",
            localCandidate: { type: "host" },
            remoteCandidate: { type: "relay" },
            protocol: {
              request: async (request: unknown) => {
                requests.push(request)
                await Bun.sleep(5)
              },
            },
          },
        },
      }],
    }
    session.peers.set("p1", peer)

    await session.refreshPeerStats()

    const snapshot = session.snapshot().peers[0]
    expect(snapshot.pathLabel).toBe("Direct ↔ TURN")
    expect(Number.isFinite(snapshot.rttMs)).toBe(true)
    expect(snapshot.rttMs > 0).toBe(true)
    expect(requests).toEqual([{ built: { nominate: false, localUsername: "local", remoteUsername: "remote", iceControlling: true } }])
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

  test("ignores local profile JSON results that complete after close", async () => {
    const session = new SendSession({ room: "demo", reconnectSocket: false }) as any
    const originalFetch = globalThis.fetch
    const originalJson = Response.prototype.json
    let resolveJson = (_value: unknown) => {}
    let jsonPending = false
    globalThis.fetch = (async () => new Response(null, {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch
    Response.prototype.json = function () {
      return new Promise(resolve => {
        jsonPending = true
        resolveJson = resolve
      })
    }
    try {
      const pending = session.loadLocalProfile()
      await Bun.sleep(0)
      await session.close()
      const afterClose = session.snapshot().profile
      if (jsonPending) resolveJson({
        cf: { city: "Busan", region: "Busan", country: "KR", colo: "PUS", asOrganization: "Late ISP", asn: 64513 },
        hs: { "cf-connecting-ip": "198.51.100.7" },
      })
      await pending
      expect(session.snapshot().profile).toEqual(afterClose)
      expect(session.snapshot().logs.length).toBe(0)
    } finally {
      Response.prototype.json = originalJson
      globalThis.fetch = originalFetch
    }
  })

  test("does not overwrite pulse state after close aborts a pending probe", async () => {
    const session = new SendSession({ room: "demo", reconnectSocket: false }) as any
    const originalFetch = globalThis.fetch
    let aborted = false
    globalThis.fetch = (((_input: string | URL | Request, init?: RequestInit) => new Promise((_resolve, reject) => {
      const signal = init?.signal as AbortSignal | undefined
      if (signal?.aborted) {
        aborted = true
        reject(new Error("aborted"))
        return
      }
      signal?.addEventListener("abort", () => {
        aborted = true
        reject(new Error("aborted"))
      }, { once: true })
    })) as typeof fetch)
    try {
      const pending = session.probePulse()
      expect(session.snapshot().pulse.state).toBe("checking")
      await session.close()
      const afterClose = session.snapshot().pulse
      await pending
      expect(aborted).toBe(true)
      expect(session.snapshot().pulse).toEqual(afterClose)
      expect(session.snapshot().logs.length).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
