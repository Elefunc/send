import { describe, expect, test } from "bun:test"
import { access, mkdir, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { sessionRuntime } from "./runtime"

const { SendSession, SessionAbortedError, PULSE_PROBE_INTERVAL_MS, PULSE_STALE_MS, connectivitySnapshotFromPeerConnection, localProfileFromResponse, probeIcePairConsentRtt, signalMetricState } = sessionRuntime
const exists = async (path: string) => access(path).then(() => true, () => false)

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
    expect(session.snapshot().profile?.streamingSaveIncoming).toBe(true)
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
      .map(message => message.profile)

    expect(profiles.at(-1)?.defaults).toEqual({
      autoAcceptIncoming: true,
      autoSaveIncoming: true,
    })
    expect(profiles.at(-1)?.streamingSaveIncoming).toBe(true)
    expect(session.snapshot().profile?.defaults).toEqual({
      autoAcceptIncoming: true,
      autoSaveIncoming: true,
    })
    expect(session.snapshot().profile?.streamingSaveIncoming).toBe(true)
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

  test("replaces same-id peer instances on hello and ignores stale bye from the older instance", async () => {
    const session = new SendSession({ room: "demo", localId: "self", reconnectSocket: false }) as any

    await session.onSignalMessage(JSON.stringify({
      room: "demo",
      from: "peer1",
      to: "*",
      at: Date.now(),
      kind: "hello",
      name: "alice",
      reply: true,
      instanceId: "oldinst1",
    }))
    expect(session.setPeerSelected("peer1", false)).toBe(true)

    await session.onSignalMessage(JSON.stringify({
      room: "demo",
      from: "peer1",
      to: "*",
      at: Date.now(),
      kind: "hello",
      name: "alice",
      reply: true,
      instanceId: "newinst2",
    }))

    expect(session.snapshot().peers[0]?.presence).toBe("active")
    expect(session.snapshot().peers[0]?.selected).toBe(false)

    await session.onSignalMessage(JSON.stringify({
      room: "demo",
      from: "peer1",
      to: "*",
      at: Date.now(),
      kind: "bye",
      instanceId: "oldinst1",
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

  test("shares local TURN config with one peer or all active peers over signaling", async () => {
    const sent: any[] = []
    const session = new SendSession({
      room: "demo",
      localId: "selfzzzz",
      reconnectSocket: false,
      turnUrls: ["turn:turn.example.com:3478"],
      turnUsername: "user",
      turnCredential: "pass",
    }) as any
    session.socket = { readyState: WebSocket.OPEN, send: (message: string) => void sent.push(JSON.parse(message)) }

    await session.onSignalMessage(JSON.stringify({
      room: "demo",
      from: "peer1",
      to: "*",
      at: Date.now(),
      kind: "hello",
      name: "alice",
      reply: true,
    }))
    sent.length = 0

    expect(session.shareTurnWithPeer("peer1")).toBe(true)
    expect(sent[0]?.kind).toBe("turn-share")
    expect(sent[0]?.to).toBe("peer1")
    expect(sent[0]?.iceServers).toEqual([{ urls: "turn:turn.example.com:3478", username: "user", credential: "pass" }])

    await session.onSignalMessage(JSON.stringify({
      room: "demo",
      from: "peer2",
      to: "*",
      at: Date.now(),
      kind: "hello",
      name: "bob",
      reply: true,
    }))

    sent.length = 0
    expect(session.shareTurnWithPeers(["peer2", "peer1", "peer2", "missing"])).toBe(2)
    expect(sent.map(message => message.to)).toEqual(["peer2", "peer1"])
    expect(sent.every(message => message.kind === "turn-share")).toBe(true)
    expect(sent.every(message => JSON.stringify(message.iceServers) === JSON.stringify([{ urls: "turn:turn.example.com:3478", username: "user", credential: "pass" }]))).toBe(true)

    sent.length = 0
    expect(session.shareTurnWithAllPeers()).toBe(2)
    expect(sent[0]?.kind).toBe("turn-share")
    expect(sent[0]?.to).toBe("*")
    expect(sent[0]?.iceServers).toEqual([{ urls: "turn:turn.example.com:3478", username: "user", credential: "pass" }])
  })

  test("applies shared TURN config once, rebroadcasts presence, and forces peer recovery", async () => {
    const sent: any[] = []
    const session = new SendSession({ room: "demo", localId: "selfzzzz", reconnectSocket: false }) as any
    session.socket = { readyState: WebSocket.OPEN, send: (message: string) => void sent.push(JSON.parse(message)) }

    await session.onSignalMessage(JSON.stringify({
      room: "demo",
      from: "peer1",
      to: "*",
      at: Date.now(),
      kind: "hello",
      name: "alice",
      reply: true,
    }))
    sent.length = 0

    await session.onSignalMessage(JSON.stringify({
      room: "demo",
      from: "peer1",
      to: "*",
      at: Date.now(),
      kind: "turn-share",
      iceServers: [{ urls: "turn:turn.example.com:3478", username: "user", credential: "pass" }],
    }))

    expect(session.canShareTurn()).toBe(true)
    expect(session.snapshot().turnState).toBe("idle")
    expect(sent.some(message => message.kind === "profile" && message.turnAvailable === true)).toBe(true)
    expect(sent.some(message => message.kind === "hello" && message.to === "peer1" && message.recovery === true)).toBe(true)

    const baseline = sent.length
    await session.onSignalMessage(JSON.stringify({
      room: "demo",
      from: "peer1",
      to: "*",
      at: Date.now(),
      kind: "turn-share",
      iceServers: [{ urls: "turn:turn.example.com:3478", username: "user", credential: "pass" }],
    }))

    expect(sent.length).toBe(baseline)
  })

  test("aborts a pending socket-open wait immediately when the session closes", async () => {
    const OriginalWebSocket = globalThis.WebSocket
    class HangingWebSocket {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSING = 2
      static CLOSED = 3
      readyState = HangingWebSocket.CONNECTING
      onopen: ((event?: unknown) => void) | null = null
      onmessage: ((event?: unknown) => void) | null = null
      onerror: ((event?: unknown) => void) | null = null
      onclose: ((event?: unknown) => void) | null = null
      constructor(readonly url: string) {}
      send() {}
      close() {
        this.readyState = HangingWebSocket.CLOSED
        this.onclose?.(new Event("close"))
      }
    }
    globalThis.WebSocket = HangingWebSocket as unknown as typeof WebSocket

    try {
      const session = new SendSession({ room: "demo", reconnectSocket: false }) as any
      const connectPromise = session.connect()
      await Bun.sleep(20)
      await session.close()
      const outcome = await Promise.race([
        connectPromise.then(() => "resolved", (error: unknown) => error instanceof SessionAbortedError ? "aborted" : `${error}`),
        Bun.sleep(100).then(() => "timeout"),
      ])
      expect(outcome).toBe("aborted")
    } finally {
      globalThis.WebSocket = OriginalWebSocket
    }
  })

  test("waits for async peer teardown before session close resolves", async () => {
    let resolvePeerClose = () => {}
    const peerClose = new Promise<void>(resolve => { resolvePeerClose = resolve })
    const session = new SendSession({ room: "demo", reconnectSocket: false }) as any
    const peer = readyPeer()
    peer.dc = {
      readyState: "open",
      send() {},
      close() {},
      onopen: () => {},
      onclose: () => {},
      onerror: () => {},
      onmessage: () => {},
    }
    peer.pc = {
      connectionState: "connected",
      close: () => peerClose,
      onicecandidate: () => {},
      ondatachannel: () => {},
      onnegotiationneeded: () => {},
      onconnectionstatechange: () => {},
      oniceconnectionstatechange: () => {},
    }
    session.peers.set("p1", peer)

    const closing = session.close()
    const outcome = await Promise.race([
      closing.then(() => "closed"),
      Bun.sleep(25).then(() => "pending"),
    ])

    expect(outcome).toBe("pending")
    expect(session.pendingRtcCloses.size).toBe(1)

    resolvePeerClose()
    await closing

    expect(session.pendingRtcCloses.size).toBe(0)
  })

  test("detaches peer RTC handlers during session close", async () => {
    let resolvePeerClose = () => {}
    const peerClose = new Promise<void>(resolve => { resolvePeerClose = resolve })
    const session = new SendSession({ room: "demo", reconnectSocket: false }) as any
    const dc: any = {
      readyState: "open",
      send() {},
      close() {},
      onopen: () => {},
      onclose: () => {},
      onerror: () => {},
      onmessage: () => {},
    }
    const pc: any = {
      connectionState: "connected",
      close: () => peerClose,
      onicecandidate: () => {},
      ondatachannel: () => {},
      onnegotiationneeded: () => {},
      onconnectionstatechange: () => {},
      oniceconnectionstatechange: () => {},
    }
    const peer = readyPeer()
    peer.dc = dc
    peer.pc = pc
    session.peers.set("p1", peer)

    const closing = session.close()

    expect(dc.onopen).toBe(null)
    expect(dc.onclose).toBe(null)
    expect(dc.onerror).toBe(null)
    expect(dc.onmessage).toBe(null)
    expect(pc.onicecandidate).toBe(null)
    expect(pc.ondatachannel).toBe(null)
    expect(pc.onnegotiationneeded).toBe(null)
    expect(pc.onconnectionstatechange).toBe(null)
    expect(pc.oniceconnectionstatechange).toBe(null)

    resolvePeerClose()
    await closing
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

  test("overwrites an existing completed incoming file when overwrite mode is enabled", async () => {
    const dir = join(process.cwd(), ".tmp-send-session-overwrite-complete")
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })
    await Bun.write(join(dir, "hello.txt"), "old")
    const session = new SendSession({ room: "demo", saveDir: dir, reconnectSocket: false, overwriteIncoming: true }) as any
    session.transfers.set("t1", incomingTransfer({ status: "complete", data: Buffer.from("hello") }))

    const savedPath = await session.saveTransfer("t1")

    expect(savedPath).toBe(join(dir, "hello.txt"))
    expect(await readFile(savedPath, "utf8")).toBe("hello")
    await rm(dir, { recursive: true, force: true })
  })

  test("streams auto-saved incoming transfers straight to disk from receive start", async () => {
    const dir = join(process.cwd(), ".tmp-send-session-stream")
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })
    const events: any[] = []
    const session = new SendSession({ room: "demo", saveDir: dir, reconnectSocket: false, autoAcceptIncoming: true, autoSaveIncoming: true }) as any
    const peer = readyPeer()
    session.peers.set("p1", peer)
    session.onEvent((event: any) => events.push(event))

    await session.handleTransferControl(peer, { kind: "file-offer", transferId: "t1", name: "hello.txt", size: 5, type: "text/plain", lastModified: 0, chunkSize: 3, totalChunks: 2, to: session.localId })
    const transfer = session.transfers.get("t1")
    expect(transfer.status).toBe("accepted")
    expect(transfer.incomingDisk?.tempPath).toContain("hello.txt.part.")
    await session.handleTransferControl(peer, { kind: "file-start", transferId: "t1", to: session.localId })

    expect(transfer.status).toBe("receiving")
    session.onBinary(peer, Buffer.from("hel"))
    session.onBinary(peer, Buffer.from("lo"))
    await session.handleTransferControl(peer, { kind: "file-end", transferId: "t1", size: 5, totalChunks: 2, to: session.localId })

    expect(transfer.status).toBe("complete")
    expect(transfer.savedAt > 0).toBe(true)
    expect(transfer.savedPath.endsWith("hello.txt")).toBe(true)
    expect(transfer.data).toBe(undefined)
    expect(transfer.buffers).toBe(undefined)
    expect(transfer.incomingDisk).toBe(undefined)
    expect(await readFile(transfer.savedPath, "utf8")).toBe("hello")
    expect(events.some(event => event.type === "saved" && event.transfer.id === "t1" && event.transfer.savedPath === transfer.savedPath)).toBe(true)

    await rm(dir, { recursive: true, force: true })
  })

  test("overwrites the same streamed target path when overwrite mode is enabled", async () => {
    const dir = join(process.cwd(), ".tmp-send-session-stream-overwrite")
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })
    await Bun.write(join(dir, "hello.txt"), "old")
    const session = new SendSession({ room: "demo", saveDir: dir, reconnectSocket: false, autoAcceptIncoming: true, autoSaveIncoming: true, overwriteIncoming: true }) as any
    const peer = readyPeer()
    session.peers.set("p1", peer)

    await session.handleTransferControl(peer, { kind: "file-offer", transferId: "t1", name: "hello.txt", size: 5, type: "text/plain", lastModified: 0, chunkSize: 5, totalChunks: 1, to: session.localId })
    await session.handleTransferControl(peer, { kind: "file-start", transferId: "t1", to: session.localId })
    const transfer = session.transfers.get("t1")

    session.onBinary(peer, Buffer.from("hello"))
    await session.handleTransferControl(peer, { kind: "file-end", transferId: "t1", size: 5, totalChunks: 1, to: session.localId })

    expect(transfer.savedPath).toBe(join(dir, "hello.txt"))
    expect(await readFile(join(dir, "hello.txt"), "utf8")).toBe("hello")
    await rm(dir, { recursive: true, force: true })
  })

  test("lets the last streamed overwrite finisher win for concurrent same-name transfers", async () => {
    const dir = join(process.cwd(), ".tmp-send-session-stream-overwrite-concurrent")
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })
    const session = new SendSession({ room: "demo", saveDir: dir, reconnectSocket: false, autoAcceptIncoming: true, autoSaveIncoming: true, overwriteIncoming: true }) as any
    const peer1 = { ...readyPeer(), id: "p1" }
    const peer2 = { ...readyPeer(), id: "p2" }
    session.peers.set("p1", peer1)
    session.peers.set("p2", peer2)

    await session.handleTransferControl(peer1, { kind: "file-offer", transferId: "t1", name: "hello.txt", size: 5, type: "text/plain", lastModified: 0, chunkSize: 5, totalChunks: 1, to: session.localId })
    await session.handleTransferControl(peer2, { kind: "file-offer", transferId: "t2", name: "hello.txt", size: 5, type: "text/plain", lastModified: 0, chunkSize: 5, totalChunks: 1, to: session.localId })
    await session.handleTransferControl(peer1, { kind: "file-start", transferId: "t1", to: session.localId })
    await session.handleTransferControl(peer2, { kind: "file-start", transferId: "t2", to: session.localId })

    session.onBinary(peer1, Buffer.from("first"))
    session.onBinary(peer2, Buffer.from("later"))
    await session.handleTransferControl(peer1, { kind: "file-end", transferId: "t1", size: 5, totalChunks: 1, to: session.localId })
    await session.handleTransferControl(peer2, { kind: "file-end", transferId: "t2", size: 5, totalChunks: 1, to: session.localId })

    expect(session.transfers.get("t1").savedPath).toBe(join(dir, "hello.txt"))
    expect(session.transfers.get("t2").savedPath).toBe(join(dir, "hello.txt"))
    expect(await readFile(join(dir, "hello.txt"), "utf8")).toBe("later")
    await rm(dir, { recursive: true, force: true })
  })

  test("cleans up a pre-armed direct-to-disk temp file when an accepted transfer fails before file-start", async () => {
    const dir = join(process.cwd(), ".tmp-send-session-stream-prestart-fail")
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })
    const session = new SendSession({ room: "demo", saveDir: dir, reconnectSocket: false, autoAcceptIncoming: true, autoSaveIncoming: true }) as any
    const peer = readyPeer()
    session.peers.set("p1", peer)

    await session.handleTransferControl(peer, { kind: "file-offer", transferId: "t1", name: "hello.txt", size: 5, type: "text/plain", lastModified: 0, chunkSize: 3, totalChunks: 2, to: session.localId })
    const transfer = session.transfers.get("t1")
    const tempPath = transfer.incomingDisk?.tempPath

    expect(transfer.status).toBe("accepted")
    expect(tempPath ? await exists(tempPath) : false).toBe(true)
    await session.handleTransferControl(peer, { kind: "file-error", transferId: "t1", reason: "failed", to: session.localId })
    await Bun.sleep(50)

    expect(transfer.status).toBe("error")
    expect(tempPath ? await exists(tempPath) : false).toBe(false)
    expect(transfer.savedPath).toBe(undefined)
    await rm(dir, { recursive: true, force: true })
  })

  test("removes partial direct-to-disk files when an incoming streamed transfer fails", async () => {
    const dir = join(process.cwd(), ".tmp-send-session-stream-fail")
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })
    const session = new SendSession({ room: "demo", saveDir: dir, reconnectSocket: false, autoAcceptIncoming: true, autoSaveIncoming: true }) as any
    const peer = readyPeer()
    session.peers.set("p1", peer)

    await session.handleTransferControl(peer, { kind: "file-offer", transferId: "t1", name: "hello.txt", size: 5, type: "text/plain", lastModified: 0, chunkSize: 5, totalChunks: 1, to: session.localId })
    await session.handleTransferControl(peer, { kind: "file-start", transferId: "t1", to: session.localId })
    const transfer = session.transfers.get("t1")
    const tempPath = transfer.incomingDisk?.tempPath
    session.onBinary(peer, Buffer.from("hel"))
    await session.handleTransferControl(peer, { kind: "file-error", transferId: "t1", reason: "failed", to: session.localId })
    await Bun.sleep(50)

    expect(transfer.status).toBe("error")
    expect(tempPath ? await exists(tempPath) : false).toBe(false)
    expect(transfer.savedPath).toBe(undefined)

    await rm(dir, { recursive: true, force: true })
  })

  test("does not remove an existing destination when an overwrite-mode streamed transfer fails", async () => {
    const dir = join(process.cwd(), ".tmp-send-session-stream-overwrite-fail")
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })
    await Bun.write(join(dir, "hello.txt"), "old")
    const session = new SendSession({ room: "demo", saveDir: dir, reconnectSocket: false, autoAcceptIncoming: true, autoSaveIncoming: true, overwriteIncoming: true }) as any
    const peer = readyPeer()
    session.peers.set("p1", peer)

    await session.handleTransferControl(peer, { kind: "file-offer", transferId: "t1", name: "hello.txt", size: 5, type: "text/plain", lastModified: 0, chunkSize: 5, totalChunks: 1, to: session.localId })
    await session.handleTransferControl(peer, { kind: "file-start", transferId: "t1", to: session.localId })
    session.onBinary(peer, Buffer.from("hel"))
    await session.handleTransferControl(peer, { kind: "file-error", transferId: "t1", reason: "failed", to: session.localId })
    await Bun.sleep(50)

    expect(await readFile(join(dir, "hello.txt"), "utf8")).toBe("old")
    await rm(dir, { recursive: true, force: true })
  })

  test("falls back to memory buffering when direct-to-disk startup fails before writing begins", async () => {
    const dir = join(process.cwd(), ".tmp-send-session-stream-fallback")
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })
    const session = new SendSession({ room: "demo", saveDir: dir, reconnectSocket: false, autoAcceptIncoming: true, autoSaveIncoming: true }) as any
    const peer = readyPeer()
    session.peers.set("p1", peer)
    session.createIncomingDiskState = async () => {
      throw new Error("disk unavailable")
    }

    await session.handleTransferControl(peer, { kind: "file-offer", transferId: "t1", name: "hello.txt", size: 5, type: "text/plain", lastModified: 0, chunkSize: 5, totalChunks: 1, to: session.localId })
    await session.handleTransferControl(peer, { kind: "file-start", transferId: "t1", to: session.localId })
    const transfer = session.transfers.get("t1")

    session.onBinary(peer, Buffer.from("hello"))
    await session.handleTransferControl(peer, { kind: "file-end", transferId: "t1", size: 5, totalChunks: 1, to: session.localId })
    await Bun.sleep(50)

    expect(transfer.status).toBe("complete")
    expect(transfer.incomingDisk).toBe(undefined)
    expect(transfer.data?.toString("utf8")).toBe("hello")
    expect(transfer.savedPath.endsWith("hello.txt")).toBe(true)

    await rm(dir, { recursive: true, force: true })
  })

  test("keeps an active incoming transfer memory-buffered when auto-save turns on mid-transfer", async () => {
    const dir = join(process.cwd(), ".tmp-send-session-mid-save")
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })
    const session = new SendSession({ room: "demo", saveDir: dir, reconnectSocket: false, autoAcceptIncoming: true, autoSaveIncoming: false }) as any
    const peer = readyPeer()
    session.peers.set("p1", peer)

    await session.handleTransferControl(peer, { kind: "file-offer", transferId: "t1", name: "hello.txt", size: 5, type: "text/plain", lastModified: 0, chunkSize: 5, totalChunks: 1, to: session.localId })
    await session.handleTransferControl(peer, { kind: "file-start", transferId: "t1", to: session.localId })
    const transfer = session.transfers.get("t1")

    expect(transfer.incomingDisk).toBe(undefined)
    await session.setAutoSaveIncoming(true)
    session.onBinary(peer, Buffer.from("hello"))
    await session.handleTransferControl(peer, { kind: "file-end", transferId: "t1", size: 5, totalChunks: 1, to: session.localId })
    await Bun.sleep(50)

    expect(transfer.data?.toString("utf8")).toBe("hello")
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
    expect(profile.streamingSaveIncoming).toBe(true)
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
      expect(session.snapshot().pulse.lastSettledState).toBe("open")
      expect(session.snapshot().pulse.ms >= 0).toBe(true)

      globalThis.fetch = (async () => { throw new Error("pulse down") }) as typeof fetch
      await session.probePulse()
      expect(session.snapshot().pulse.state).toBe("error")
      expect(session.snapshot().pulse.lastSettledState).toBe("error")
      expect(session.snapshot().pulse.error).toContain("pulse down")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("derives a combined signaling metric from socket and pulse state", () => {
    const now = Date.now()
    const idlePulse = { state: "idle", lastSettledState: "idle", at: 0, ms: 0, error: "" } as const
    const freshPulse = { state: "open", lastSettledState: "open", at: now, ms: 8, error: "" } as const

    expect(signalMetricState("idle", idlePulse, now)).toBe("idle")
    expect(signalMetricState("connecting", idlePulse, now)).toBe("connecting")
    expect(signalMetricState("open", { ...idlePulse, state: "checking" }, now)).toBe("checking")
    expect(signalMetricState("open", freshPulse, now)).toBe("open")
    expect(signalMetricState("open", { state: "error", lastSettledState: "error", at: now, ms: 0, error: "pulse down" }, now)).toBe("degraded")
    expect(signalMetricState("open", { ...freshPulse, at: now - PULSE_STALE_MS - 1 }, now)).toBe("degraded")
    expect(signalMetricState("closed", freshPulse, now)).toBe("closed")
    expect(signalMetricState("error", freshPulse, now)).toBe("error")
  })

  test("starts and stops pulse polling with the connect lifecycle", async () => {
    const originalSetInterval = globalThis.setInterval
    const originalClearInterval = globalThis.clearInterval
    const originalFetch = globalThis.fetch
    const OriginalWebSocket = globalThis.WebSocket
    const intervals: Array<{ fn: TimerHandler; ms: number | undefined; args: unknown[] }> = []
    const cleared: unknown[] = []

    class ImmediateWebSocket {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSING = 2
      static CLOSED = 3
      readyState = ImmediateWebSocket.CONNECTING
      onopen: ((event?: unknown) => void) | null = null
      onmessage: ((event?: unknown) => void) | null = null
      onerror: ((event?: unknown) => void) | null = null
      onclose: ((event?: unknown) => void) | null = null
      constructor(readonly url: string) {
        queueMicrotask(() => {
          this.readyState = ImmediateWebSocket.OPEN
          this.onopen?.(new Event("open"))
        })
      }
      send() {}
      close() {
        this.readyState = ImmediateWebSocket.CLOSED
        this.onclose?.(new Event("close"))
      }
    }

    globalThis.setInterval = (((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
      const token = { fn, ms, args }
      intervals.push(token)
      return token as unknown as ReturnType<typeof setInterval>
    })) as unknown as typeof setInterval
    globalThis.clearInterval = (((id?: ReturnType<typeof setInterval>) => {
      cleared.push(id)
    })) as typeof clearInterval
    globalThis.fetch = (async (input: string | URL | Request) => `${input}`.includes("/pulse?") ? new Response("ok") : Response.json({})) as typeof fetch
    globalThis.WebSocket = ImmediateWebSocket as unknown as typeof WebSocket

    try {
      const session = new SendSession({ room: "demo", reconnectSocket: false })
      await session.connect()
      const pulseTimer = intervals.find(timer => timer.ms === PULSE_PROBE_INTERVAL_MS)
      expect(pulseTimer === undefined).toBe(false)
      await session.close()
      expect(cleared).toContain(pulseTimer)
    } finally {
      globalThis.setInterval = originalSetInterval
      globalThis.clearInterval = originalClearInterval
      globalThis.fetch = originalFetch
      globalThis.WebSocket = OriginalWebSocket
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
