import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { tuiRuntime, reziCore } from "./runtime"
import type { PeerSnapshot, TransferSnapshot } from "../src/core/session"
import type { LogEntry } from "../src/core/protocol"
import { fallbackName } from "../src/core/protocol"

const { createTestRenderer, rgb, ui } = reziCore
const { TUI_NODE_APP_CONFIG, aboutCliCommand, aboutWebLabel, aboutWebUrl, buildOsc52ClipboardSequence, canAcceptFilePreviewWithRight, canNavigateDraftHistory, clampFilePreviewSelectedIndex, consumeSatisfiedFocusRequest, createInitialTuiState, createNoopTuiActions, createQuitController, deriveBootFocusState, ensureFilePreviewScrollTop, externalOpenCommand, filePreviewVisible, formatLogsForCopy, groupTransfersByPeer, inviteCliText, inviteCopyUrl, inviteWebLabel, isDraftHistoryEntryPoint, isEditableFocusId, moveDraftHistory, moveFilePreviewSelection, previewPathSegments, previewSegmentStyle, pushDraftHistoryEntry, renderTuiView, renderedReadySelectedPeers, resolveLaunchDrafts, resolveWebUrlBase, resumeCliCommand, resumeOutputLines, resumeWebUrl, scheduleBootNameJump, shouldSwallowQQuit, statusToneVariant, transferSummaryStats, visiblePanes, webInviteUrl, withAcceptedDraftInput } = tuiRuntime

const createWideRenderer = () => createTestRenderer({ viewport: { cols: 180, rows: 60 } })
const hasRenderedText = (view: ReturnType<ReturnType<typeof createWideRenderer>["render"]>, value: string) =>
  view.nodes.some(node =>
    node.text === value
      || ("text" in node.props && node.props.text === value)
      || ("label" in node.props && node.props.label === value)
      || ("title" in node.props && node.props.title === value))
const nearestAncestorBox = (view: ReturnType<ReturnType<typeof createWideRenderer>["render"]>, node: typeof view.nodes[number]) =>
  [...view.nodes]
    .filter(candidate => candidate.kind === "box" && candidate.path.length < node.path.length && candidate.path.every((part, index) => part === node.path[index]))
    .sort((left, right) => right.path.length - left.path.length)[0] ?? null

const withEnv = async (values: Record<string, string | undefined>, fn: () => Promise<unknown> | unknown) => {
  const previous = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key])
    if (value == null) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await fn()
  } finally {
    for (const [key, value] of previous) {
      if (value == null) delete process.env[key]
      else process.env[key] = value
    }
  }
}

describe("TUI pane visibility", () => {
  test("hides the logs pane by default", () => {
    expect(visiblePanes(false)).toEqual(["peers", "transfers"])
  })

  test("shows the logs pane when events are enabled", () => {
    expect(visiblePanes(true)).toEqual(["peers", "transfers", "logs"])
  })

  test("pins the TUI Rezi backend config to inline mode at 30 fps", () => {
    expect(TUI_NODE_APP_CONFIG).toEqual({
      executionMode: "inline",
      fpsCap: 30,
      idlePollMs: 50,
    })
  })
})

describe("TUI q quit guard", () => {
  test("allows q typing in editable inputs", () => {
    expect(isEditableFocusId("room-input")).toBe(true)
    expect(isEditableFocusId("name-input")).toBe(true)
    expect(isEditableFocusId("peer-search-input")).toBe(true)
    expect(isEditableFocusId("draft-input")).toBe(true)
    expect(shouldSwallowQQuit("room-input")).toBe(false)
    expect(shouldSwallowQQuit("name-input")).toBe(false)
    expect(shouldSwallowQQuit("peer-search-input")).toBe(false)
    expect(shouldSwallowQQuit("draft-input")).toBe(false)
  })

  test("swallows q quit outside editable inputs", () => {
    expect(isEditableFocusId(null)).toBe(false)
    expect(isEditableFocusId("open-about")).toBe(false)
    expect(isEditableFocusId("peer-share-turn-p1")).toBe(false)
    expect(shouldSwallowQQuit(null)).toBe(true)
    expect(shouldSwallowQQuit("open-about")).toBe(true)
    expect(shouldSwallowQQuit("peer-share-turn-p1")).toBe(true)
  })
})

describe("TUI view", () => {
  test("scrollable Rezi boxes shift overflowing content when scrollY is set", () => {
    const renderer = createWideRenderer()
    const view = renderer.render(ui.box({
      id: "scroll-box",
      width: 20,
      height: 5,
      overflow: "scroll",
      scrollY: 2,
    }, Array.from({ length: 6 }, (_, index) => ui.text(`row${index}`))))
    const text = view.toText()
    expect(text.includes("row0")).toBe(false)
    expect(text.includes("row1")).toBe(false)
    expect(text.includes("row2")).toBe(true)
    expect(text.includes("row3")).toBe(true)
  })

  test("single-line Rezi inputs reserve a trailing caret cell", () => {
    const renderer = createWideRenderer()
    const view = renderer.render(ui.input({ id: "field", value: "user", onInput: () => {} }))
    const field = view.findById("field")
    expect(field === null).toBe(false)
    if (!field) throw new Error("missing input node")
    expect(field.rect.w).toBe("user".length + 3)
  })

  test("requests initial focus on the self name input when using the fallback name", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", reconnectSocket: false }, false)
    const view = renderer.render(renderTuiView(state, createNoopTuiActions()))
    const trap = view.findById("focus-request-0")
    expect(state.pendingFocusTarget).toBe("name-input")
    expect(trap === null).toBe(false)
    if (!trap) throw new Error("missing boot focus trap")
    expect(trap.kind).toBe("focusTrap")
    expect(trap.props.initialFocus).toBe("name-input")
  })

  test("requests initial focus on the files input when using a custom self name", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", name: "alice", reconnectSocket: false }, false)
    const view = renderer.render(renderTuiView(state, createNoopTuiActions()))
    const trap = view.findById("focus-request-0")
    expect(state.pendingFocusTarget).toBe("draft-input")
    expect(trap === null).toBe(false)
    if (!trap) throw new Error("missing boot focus trap")
    expect(trap.kind).toBe("focusTrap")
    expect(trap.props.initialFocus).toBe("draft-input")
  })

  test("reissues a new focus request when the one-shot name jump targets the files input", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", reconnectSocket: false }, false)
    const actions = createNoopTuiActions()
    const initial = renderer.render(renderTuiView(state, actions))
    const initialTrap = initial.findById("focus-request-0")
    expect(initialTrap === null).toBe(false)
    if (!initialTrap) throw new Error("missing initial focus trap")
    expect(initialTrap.props.initialFocus).toBe("name-input")
    Object.assign(state, consumeSatisfiedFocusRequest(state, "name-input"))
    const consumed = renderer.render(renderTuiView(state, actions))
    expect(consumed.findById("focus-request-0")).toBe(null)
    Object.assign(state, scheduleBootNameJump(state))
    const jumped = renderer.render(renderTuiView(state, actions))
    const jumpTrap = jumped.findById("focus-request-1")
    expect(state.pendingFocusTarget).toBe("draft-input")
    expect(jumpTrap === null).toBe(false)
    if (!jumpTrap) throw new Error("missing jump focus trap")
    expect(jumpTrap.props.initialFocus).toBe("draft-input")
  })

  test("generates one room for the initial TUI state when room is omitted", () => {
    const state = createInitialTuiState({ reconnectSocket: false }, false)
    expect(state.sessionSeed.room.length > 0).toBe(true)
    expect(state.sessionSeed.room).toBe(state.roomInput)
    expect(state.session.room).toBe(state.sessionSeed.room)
    expect(state.snapshot.room).toBe(state.sessionSeed.room)
  })

  test("uses a minimal launch notice in the left footer", () => {
    const state = createInitialTuiState({ room: "demo", reconnectSocket: false }, false)
    expect(state.notice.text).toBe("Tab focus")
    expect(state.notice.text.includes("Enter commits focused input")).toBe(false)
    expect(state.notice.text.includes("Ctrl+C quits")).toBe(false)
    expect(state.notice.text.includes("q quits")).toBe(false)
  })

  test("seeds the peer filter from TUI launch options", () => {
    const state = createInitialTuiState({ room: "demo", reconnectSocket: false }, false, { filter: "Alpha Beta" })
    expect(state.peerSearch).toBe("Alpha Beta")
  })

  test("uses send-tui for the initial local session profile", () => {
    const state = createInitialTuiState({ room: "demo", reconnectSocket: false }, false)
    expect(state.session.snapshot().profile?.ua?.browser).toBe("send-tui")
    expect(state.snapshot.profile?.ua?.browser).toBe("send-tui")
  })

  test("renders the header brand as separate icon and label nodes", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", reconnectSocket: false }, false)
    const view = renderer.render(renderTuiView(state, createNoopTuiActions()))
    const brand = view.findById("brand-title")
    const icon = view.findById("brand-icon")
    const label = view.findById("brand-label")
    const roomIcon = view.findById("new-room")
    const events = view.findById("toggle-events")
    const about = view.findById("open-about")
    expect(brand === null || icon === null || label === null || roomIcon === null || events === null || about === null).toBe(false)
    if (!brand || !icon || !label || !roomIcon || !events || !about) throw new Error("missing header brand nodes")
    expect(brand.kind).toBe("row")
    expect(brand.props.items).toBe("center")
    expect(icon.kind).toBe("button")
    expect(roomIcon.kind).toBe(icon.kind)
    expect(icon.rect.w).toBe(roomIcon.rect.w)
    expect(icon.rect.h).toBe(roomIcon.rect.h)
    expect(icon.props.dsVariant).toBe("ghost")
    expect(icon.props.intent).toBe("secondary")
    expect(icon.props.focusable).toBe(false)
    expect(view.nodes.some(node => node.text === "📤 Send")).toBe(false)
    expect(hasRenderedText(view, "📤")).toBe(true)
    expect(hasRenderedText(view, "Send")).toBe(true)
    expect(events.rect.x < about.rect.x).toBe(true)
    expect(about.kind).toBe("button")
    expect(about.props.label).toBe("About")
  })

  test("renders an About modal with the shared Send copy and no share links", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", name: "alice", localId: "12345678", reconnectSocket: false }, false)
    state.aboutOpen = true
    const view = renderer.render(renderTuiView(state, createNoopTuiActions()))
    const modal = view.findById("about-modal")
    const close = view.findById("close-about")
    const elefunc = view.findById("about-elefunc-link")
    const intro = view.findById("about-intro")
    const bullet1 = view.findById("about-bullet-1")
    const bullet2 = view.findById("about-bullet-2")
    const bullet3 = view.findById("about-bullet-3")
    const bullet4 = view.findById("about-bullet-4")
    const bullet5 = view.findById("about-bullet-5")
    expect(modal === null || close === null || elefunc === null || intro === null || bullet1 === null || bullet2 === null || bullet3 === null || bullet4 === null || bullet5 === null).toBe(false)
    if (!modal || !close || !elefunc || !intro || !bullet1 || !bullet2 || !bullet3 || !bullet4 || !bullet5) throw new Error("missing about modal nodes")
    expect(modal.kind).toBe("modal")
    expect(modal.props.title).toBe("About Send")
    expect(modal.props.frameStyle).toEqual({ background: rgb(0, 0, 0) })
    expect(modal.props.backdrop).toEqual({ variant: "none" })
    expect(modal.props.initialFocus).toBe("close-about")
    expect(modal.props.returnFocusTo).toBe("open-about")
    expect(intro.props.wrap).toBe(true)
    expect(bullet1.props.wrap).toBe(true)
    expect(bullet2.props.wrap).toBe(true)
    expect(bullet3.props.wrap).toBe(true)
    expect(bullet4.props.wrap).toBe(true)
    expect(bullet5.props.wrap).toBe(true)
    expect(hasRenderedText(view, "Peer-to-peer file transfer")).toBe(false)
    expect(hasRenderedText(view, "Peer-to-Peer Transfers – Web & CLI")).toBe(true)
    expect(hasRenderedText(view, "• Join a room, see who is there, and filter or select exactly which peers to target before offering files.")).toBe(true)
    expect(hasRenderedText(view, "• File data does not travel through the signaling service; Send uses lightweight signaling to discover peers and negotiate WebRTC, then transfers directly peer-to-peer when possible, with TURN relay when needed.")).toBe(true)
    expect(hasRenderedText(view, "• Incoming transfers can be auto-accepted and auto-saved, and same-name files can either stay as numbered copies or overwrite the original when that mode is enabled.")).toBe(true)
    expect(hasRenderedText(view, "• The CLI streams incoming saves straight to disk in the current save directory, with overwrite available through the CLI flag and the TUI Ctrl+O shortcut.")).toBe(true)
    expect(hasRenderedText(view, "• Other features include copyable web and CLI invites, rendered-peer filtering and selection, TURN sharing, and live connection insight like signaling state, RTT, data state, and path labels.")).toBe(true)
    expect(hasRenderedText(view, "Join the same room, see who is there, and offer files directly to selected peers.")).toBe(false)
    expect(hasRenderedText(view, "Send uses lightweight signaling to discover peers and negotiate WebRTC. Files move over WebRTC data channels, using direct paths when possible and TURN relay when needed.")).toBe(false)
    expect(hasRenderedText(view, "--self alice-12345678")).toBe(false)
    expect(hasRenderedText(view, "Elefunc, Inc.")).toBe(false)
    expect(hasRenderedText(view, "What it is")).toBe(false)
    expect(hasRenderedText(view, "What it does")).toBe(false)
    expect(hasRenderedText(view, "How it works")).toBe(false)
    expect(hasRenderedText(view, "Who made it")).toBe(false)
    expect(hasRenderedText(view, "Under the hood")).toBe(false)
    expect(view.findById("about-current-cli")).toBe(null)
    expect(view.findById("about-current-web-link")).toBe(null)
    expect(view.findById("about-cli-label")).toBe(null)
    expect(view.findById("about-web-link-label")).toBe(null)
    expect(elefunc.kind).toBe("link")
    expect(elefunc.props.label).toBe("rtme.sh/send")
    expect(elefunc.props.accessibleLabel).toBe("Open rtme.sh Send page")
    expect(elefunc.props.url).toBe("https://rtme.sh/send")
    expect(close.kind).toBe("button")
    expect(close.props.label).toBe("Close")
  })

  test("renders a compact footer key-hint strip on the right", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", reconnectSocket: false }, false)
    const view = renderer.render(renderTuiView(state, createNoopTuiActions()))
    const footer = view.findById("footer-shell")
    const hints = view.findById("footer-hints")
    const tab = view.findById("footer-hint-tab")
    const enter = view.findById("footer-hint-enter")
    const ctrlo = view.findById("footer-hint-ctrl-o")
    const ctrlc = view.findById("footer-hint-ctrlc")
    const tabKeycap = view.findById("footer-hint-tab-keycap")
    const enterKeycap = view.findById("footer-hint-enter-keycap")
    const ctrlOKeycap = view.findById("footer-hint-ctrl-o-keycap")
    const ctrlCKeycap = view.findById("footer-hint-ctrlc-keycap")
    expect(footer === null || hints === null || tab === null || enter === null || ctrlo === null || ctrlc === null || tabKeycap === null || enterKeycap === null || ctrlOKeycap === null || ctrlCKeycap === null).toBe(false)
    if (!footer || !hints || !tab || !enter || !ctrlo || !ctrlc || !tabKeycap || !enterKeycap || !ctrlOKeycap || !ctrlCKeycap) throw new Error("missing footer hint nodes")
    expect(hasRenderedText(view, "Enter commits focused input")).toBe(false)
    expect(hasRenderedText(view, "Ctrl+C quits")).toBe(false)
    expect(hints.kind).toBe("row")
    expect(hints.props.gap).toBe(3)
    expect(tab.kind).toBe("row")
    expect(enter.kind).toBe("row")
    expect(ctrlo.kind).toBe("row")
    expect(ctrlc.kind).toBe("row")
    expect(tab.props.gap).toBe(0)
    expect(enter.props.gap).toBe(0)
    expect(ctrlo.props.gap).toBe(0)
    expect(ctrlc.props.gap).toBe(0)
    const tabKbd = view.nodes.find(node => node.kind === "kbd" && "keys" in node.props && node.props.keys === "tab")
    const enterKbd = view.nodes.find(node => node.kind === "kbd" && "keys" in node.props && node.props.keys === "enter")
    const ctrlOKbd = view.nodes.find(node => node.kind === "kbd" && "keys" in node.props && node.props.keys === "ctrl+o")
    const ctrlcKbd = view.nodes.find(node => node.kind === "kbd" && "keys" in node.props && node.props.keys === "ctrl+c")
    const focusLabel = view.nodes.find(node => node.kind === "text" && node.text === " focus/accept")
    const commitLabel = view.nodes.find(node => node.kind === "text" && node.text === " accept/add")
    const overwriteLabel = view.nodes.find(node => node.kind === "text" && node.text === " overwrite")
    const quitLabel = view.nodes.find(node => node.kind === "text" && node.text === " quit")
    expect(tabKbd === undefined || enterKbd === undefined || ctrlOKbd === undefined || ctrlcKbd === undefined || focusLabel === undefined || commitLabel === undefined || overwriteLabel === undefined || quitLabel === undefined).toBe(false)
    if (!tabKbd || !enterKbd || !ctrlOKbd || !ctrlcKbd || !focusLabel || !commitLabel || !overwriteLabel || !quitLabel) throw new Error("missing footer key or label nodes")
    expect(tabKeycap.rect.w).toBe("[tab]".length)
    expect(enterKeycap.rect.w).toBe("[enter]".length)
    expect(ctrlOKeycap.rect.w).toBe("[ctrl+o]".length)
    expect(ctrlCKeycap.rect.w).toBe("[ctrl+c]".length)
    expect(focusLabel.rect.x).toBe(tabKbd.rect.x + tabKbd.rect.w)
    expect(commitLabel.rect.x).toBe(enterKbd.rect.x + enterKbd.rect.w)
    expect(overwriteLabel.rect.x).toBe(ctrlOKbd.rect.x + ctrlOKbd.rect.w)
    expect(quitLabel.rect.x).toBe(ctrlcKbd.rect.x + ctrlcKbd.rect.w)
    expect(view.toText().includes("[ctrl+o] overwrite")).toBe(true)
    expect(view.toText().includes("[ctrl+c] quit")).toBe(true)
    expect(view.nodes.some(node => node.text?.includes("focus/accept"))).toBe(true)
    expect(view.nodes.some(node => node.text?.includes("accept/add"))).toBe(true)
    expect(view.nodes.some(node => node.text?.includes("overwrite"))).toBe(true)
    expect(view.nodes.some(node => node.text?.includes("hide/reset"))).toBe(false)
    expect(view.nodes.some(node => node.text?.includes("quit"))).toBe(true)
  })

  test("renders inline room and self inputs", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", name: "alice", reconnectSocket: false }, false)
    const view = renderer.render(renderTuiView(state, createNoopTuiActions()))
    expect(view.findById("room-input") === null).toBe(false)
    expect(view.findById("name-input") === null).toBe(false)
    expect(view.findById("draft-input") === null).toBe(false)
  })

  test("renders the fallback self name as an empty field with a `user` placeholder", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", reconnectSocket: false }, false)
    const view = renderer.render(renderTuiView(state, createNoopTuiActions()))
    const nameInput = view.findById("name-input")
    expect(nameInput === null).toBe(false)
    if (!nameInput) throw new Error("missing name input")
    expect(state.snapshot.name).toBe(fallbackName)
    expect(state.nameInput).toBe("")
    expect(nameInput.props.value).toBe("")
    expect(nameInput.props.placeholder).toBe(fallbackName)
  })

  test("renders custom self names visibly", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", name: "alice", reconnectSocket: false }, false)
    const view = renderer.render(renderTuiView(state, createNoopTuiActions()))
    const nameInput = view.findById("name-input")
    expect(nameInput === null).toBe(false)
    if (!nameInput) throw new Error("missing name input")
    expect(state.nameInput).toBe("alice")
    expect(nameInput.props.value).toBe("alice")
    expect(nameInput.props.placeholder).toBe(fallbackName)
  })

  test("room and self inputs keep one visible cell after the current text", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", reconnectSocket: false }, false)
    const view = renderer.render(renderTuiView(state, createNoopTuiActions()))
    const roomInput = view.findById("room-input")
    const nameInput = view.findById("name-input")
    expect(roomInput === null || nameInput === null).toBe(false)
    if (!roomInput || !nameInput) throw new Error("missing room or name input")
    expect(roomInput.rect.w > state.roomInput.length + 2).toBe(true)
    expect(nameInput.rect.w > state.nameInput.length + 2).toBe(true)
  })

  test("renders the web-app-style self card metrics and profile lines", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", name: "alice", reconnectSocket: false }, false)
    state.snapshot = {
      ...state.snapshot,
      localId: "abc123",
      socketState: "open",
      turnState: "used",
      pulse: { state: "open", lastSettledState: "open", at: Date.now(), ms: 12, error: "" },
      profile: {
        geo: { city: "Seoul", region: "Seoul", country: "KR" },
        network: { asOrganization: "Edge ISP", colo: "ICN", ip: "203.0.113.5" },
        ua: { browser: "send-tui", os: "linux", device: "desktop" },
        defaults: { autoAcceptIncoming: true, autoSaveIncoming: true, overwriteIncoming: true },
        streamingSaveIncoming: true,
        ready: true,
        error: "",
      },
    }
    const view = renderer.render(renderTuiView(state, createNoopTuiActions()))
    expect(view.findText("Signaling") === null).toBe(false)
    expect(view.findText("Pulse")).toBe(null)
    expect(view.findText("TURN") === null).toBe(false)
    expect(view.findText("-abc123") === null).toBe(false)
    expect(view.findText("AW") === null).toBe(false)
    expect(view.findText("Seoul, Seoul, KR") === null).toBe(false)
    expect(view.findText("Edge ISP · ICN") === null).toBe(false)
    expect(view.findText("send-tui · linux") === null).toBe(false)
    const selfIp = view.nodes.find(node => node.kind === "link" && "label" in node.props && node.props.label === "203.0.113.5")
    expect(selfIp === undefined).toBe(false)
    if (!selfIp) throw new Error("missing self IP link")
    expect(selfIp.props.url).toBe("https://gi.rt.ht/:203.0.113.5")
    expect(view.toText().includes("open")).toBe(true)
    expect(view.toText().includes("used")).toBe(true)
    expect(view.toText().includes("AW")).toBe(true)
    expect(view.toText().includes("(open)")).toBe(false)
    expect(view.toText().includes("(used)")).toBe(false)
    expect(view.toText().includes("(AW)")).toBe(false)
    expect(view.toText().includes("( open )")).toBe(false)
    expect(view.toText().includes("( used )")).toBe(false)
    expect(view.toText().includes("( AW )")).toBe(false)
    expect(view.findText(`save ${state.snapshot.saveDir}`)).toBe(null)
    const signaling = view.findText("Signaling")
    const turn = view.findText("TURN")
    expect(signaling === null || turn === null).toBe(false)
    if (!signaling || !turn) throw new Error("missing self metric labels")
    for (const metric of [signaling, turn]) {
      const box = nearestAncestorBox(view, metric)
      expect(box === null).toBe(false)
      if (!box) throw new Error("missing self metric box")
      expect("border" in box.props ? box.props.border : undefined).toBe("single")
      const borderStyle = "borderStyle" in box.props ? box.props.borderStyle : null
      expect(borderStyle === null || typeof borderStyle !== "object").toBe(false)
      if (!borderStyle || typeof borderStyle !== "object") throw new Error("missing self metric border style")
      expect("fg" in borderStyle ? borderStyle.fg : null).toBe(rgb(20, 25, 32))
    }
  })

  test("renders self auto-defaults from the advertised local profile", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", reconnectSocket: false }, false)
    state.autoAcceptIncoming = true
    state.autoSaveIncoming = true
    state.snapshot = {
      ...state.snapshot,
      localId: "abc123",
      profile: {
        ...state.snapshot.profile,
        defaults: { autoAcceptIncoming: false, autoSaveIncoming: true, overwriteIncoming: true },
        streamingSaveIncoming: true,
      },
    }

    const view = renderer.render(renderTuiView(state, createNoopTuiActions()))
    expect(view.findText("-abc123") === null).toBe(false)
    expect(view.findText("aW") === null).toBe(false)
    expect(view.findText("AX")).toBe(null)
    expect(view.toText().includes("(aW)")).toBe(false)
  })

  test("maps degraded signaling to a warning badge tone", () => {
    expect(statusToneVariant("degraded")).toBe("warning")
  })

  test("renders the web-app-style self shell with the 🙂 prefix control", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", name: "alice", reconnectSocket: false }, false)
    const view = renderer.render(renderTuiView(state, createNoopTuiActions()))
    const newSelf = view.findById("new-self")
    expect(view.findText("Self")).toBe(null)
    expect(view.findText("New ID")).toBe(null)
    expect(newSelf === null).toBe(false)
    if (!newSelf) throw new Error("missing new-self button")
    expect("label" in newSelf.props && newSelf.props.label).toBe("🙂")
    expect(view.findById("name-input") === null).toBe(false)
  })

  test("renders the web-app-style room shell with an invite dropdown button", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", name: "alice", reconnectSocket: false }, false)
    const view = renderer.render(renderTuiView(state, createNoopTuiActions()))
    const newRoom = view.findById("new-room")
    const inviteSlot = view.findById("room-invite-slot")
    const inviteButton = view.findById("room-invite-button")
    expect(view.findText("Room")).toBe(null)
    expect(view.findText("Signal idle")).toBe(null)
    expect(newRoom === null || inviteSlot === null || inviteButton === null).toBe(false)
    if (!newRoom || !inviteSlot || !inviteButton) throw new Error("missing room row controls")
    expect("label" in newRoom.props && newRoom.props.label).toBe("🏠")
    expect(view.findById("room-input") === null).toBe(false)
    expect(inviteSlot.kind).toBe("row")
    expect(inviteSlot.props.width).toBe(newRoom.rect.w)
    expect(inviteButton.kind).toBe("button")
    expect(inviteButton.props.label).toBe("📋")
    expect(inviteButton.props.accessibleLabel).toBe("Open invite links")
    expect(inviteButton.rect.x - inviteSlot.rect.x).toBe(inviteSlot.rect.x + inviteSlot.rect.w - (inviteButton.rect.x + inviteButton.rect.w))
    expect(hasRenderedText(view, "📋")).toBe(true)
  })

  test("renders invite dropdown labels from the committed state and current toggles", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", reconnectSocket: false }, false)
    state.roomInput = "draft-room"
    state.hideTerminalPeers = false
    state.autoAcceptIncoming = false
    state.autoOfferOutgoing = false
    state.autoSaveIncoming = false
    state.inviteDropdownOpen = true
    const view = renderer.render(renderTuiView(state, createNoopTuiActions()))
    const inviteDropdown = view.findById("room-invite-dropdown")
    expect(inviteDropdown === null).toBe(false)
    if (!inviteDropdown) throw new Error("missing room invite dropdown")
    expect(inviteDropdown.kind).toBe("dropdown")
    expect(inviteDropdown.props.anchorId).toBe("room-invite-button")
    expect(inviteDropdown.props.position).toBe("below-end")
    expect(inviteDropdown.props.items).toEqual([
      { id: "cli", label: "CLI", shortcut: "bunx rtme.sh --room demo --clean 0 --accept 0 --offer 0 --save 0" },
      { id: "web", label: "WEB", shortcut: "rtme.sh/#room=demo&clean=0&accept=0&offer=0&save=0" },
    ])
  })

  test("includes overwrite state in invite previews when enabled", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", reconnectSocket: false, overwriteIncoming: true }, false)
    state.inviteDropdownOpen = true
    const view = renderer.render(renderTuiView(state, createNoopTuiActions()))
    const inviteDropdown = view.findById("room-invite-dropdown")
    expect(inviteDropdown === null).toBe(false)
    if (!inviteDropdown) throw new Error("missing room invite dropdown")
    expect(inviteDropdown.props.items).toEqual([
      { id: "cli", label: "CLI", shortcut: "bunx rtme.sh --room demo --overwrite" },
      { id: "web", label: "WEB", shortcut: "rtme.sh/#room=demo&overwrite=1" },
    ])
  })

  test("includes the active peer filter in invite previews and share outputs", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", name: "alice", localId: "12345678", reconnectSocket: false }, true, { filter: "Alpha Beta" })
    state.inviteDropdownOpen = true
    const view = renderer.render(renderTuiView(state, createNoopTuiActions()))
    const inviteDropdown = view.findById("room-invite-dropdown")
    expect(inviteDropdown === null).toBe(false)
    if (!inviteDropdown) throw new Error("missing room invite dropdown")
    expect(inviteDropdown.props.items).toEqual([
      { id: "cli", label: "CLI", shortcut: "bunx rtme.sh --room demo --filter 'Alpha Beta'" },
      { id: "web", label: "WEB", shortcut: "rtme.sh/#room=demo&filter=Alpha+Beta" },
    ])
    expect(webInviteUrl(state)).toBe("https://rtme.sh/#room=demo&filter=Alpha+Beta")
    expect(inviteWebLabel(state)).toBe("rtme.sh/#room=demo&filter=Alpha+Beta")
    expect(inviteCliText(state)).toBe("bunx rtme.sh --room demo --filter 'Alpha Beta'")
    expect(aboutWebUrl(state)).toBe("https://rtme.sh/#room=demo&filter=Alpha+Beta")
    expect(aboutWebLabel(state)).toBe("rtme.sh/#room=demo&filter=Alpha+Beta")
    expect(aboutCliCommand(state)).toBe("--room demo --filter 'Alpha Beta' --events")
    expect(resumeWebUrl(state)).toBe("https://rtme.sh/#room=demo&filter=Alpha+Beta")
    expect(resumeCliCommand(state)).toBe("bunx rtme.sh --room demo --self alice-12345678 --filter 'Alpha Beta' --events")
    expect(resumeOutputLines(state)).toEqual([
      "Rejoin with:",
      "",
      "Web",
      "https://rtme.sh/#room=demo&filter=Alpha+Beta",
      "",
      "CLI",
      "bunx rtme.sh --room demo --self alice-12345678 --filter 'Alpha Beta' --events",
      "",
    ])
  })

  test("uses SEND_WEB_URL for the room invite link base and falls back on invalid values", async () => {
    await withEnv({ SEND_WEB_URL: "https://example.com/send/" }, () => {
      const state = createInitialTuiState({ room: "demo", reconnectSocket: false }, false)
      expect(resolveWebUrlBase()).toBe("https://example.com/send/")
      expect(webInviteUrl(state)).toBe("https://example.com/send/#room=demo")
    })

    await withEnv({ SEND_WEB_URL: "not a valid url" }, () => {
      const state = createInitialTuiState({ room: "demo", reconnectSocket: false }, false)
      expect(resolveWebUrlBase()).toBe("https://rtme.sh/")
      expect(webInviteUrl(state)).toBe("https://rtme.sh/#room=demo")
    })
  })

  test("renders scheme-less WEB preview labels and host-derived CLI invite text", async () => {
    const state = createInitialTuiState({ room: "demo", reconnectSocket: false }, false)
    expect(inviteWebLabel(state)).toBe("rtme.sh/#room=demo")
    expect(inviteCliText(state)).toBe("bunx rtme.sh --room demo")

    await withEnv({ SEND_WEB_URL: "https://example.com/send/" }, () => {
      expect(inviteWebLabel(state)).toBe("example.com/send/#room=demo")
      expect(inviteCliText(state)).toBe("bunx example.com --room demo")
    })
  })

  test("includes overwrite in scheme-less WEB labels and CLI invite text when enabled", () => {
    const state = createInitialTuiState({ room: "demo", reconnectSocket: false, overwriteIncoming: true }, false)
    expect(inviteWebLabel(state)).toBe("rtme.sh/#room=demo&overwrite=1")
    expect(inviteCliText(state)).toBe("bunx rtme.sh --room demo --overwrite")
  })

  test("builds copy service URLs and OSC 52 clipboard sequences for invite payloads", () => {
    expect(inviteCopyUrl("bunx rtme.sh --room demo")).toBe("https://copy.rt.ht/#text=bunx+rtme.sh+--room+demo")
    expect(buildOsc52ClipboardSequence("copy me")).toBe("\u001b]52;c;Y29weSBtZQ==\u0007")
    expect(buildOsc52ClipboardSequence("")).toBe("")
  })

  test("builds cross-platform external open commands for copy fallback URLs", () => {
    expect(externalOpenCommand("https://copy.rt.ht/#text=demo", "darwin")).toEqual(["open", "https://copy.rt.ht/#text=demo"])
    expect(externalOpenCommand("https://copy.rt.ht/#text=demo", "win32")).toEqual(["cmd.exe", "/c", "start", "", "https://copy.rt.ht/#text=demo"])
    expect(externalOpenCommand("https://copy.rt.ht/#text=demo", "linux")).toEqual(["xdg-open", "https://copy.rt.ht/#text=demo"])
  })

  test("omits default values from the About web link and CLI command, but keeps room", () => {
    const state = createInitialTuiState({ room: "demo", name: "alice", localId: "12345678", reconnectSocket: false }, false)
    expect(aboutWebUrl(state)).toBe("https://rtme.sh/#room=demo")
    expect(aboutWebLabel(state)).toBe("rtme.sh/#room=demo")
    expect(aboutCliCommand(state)).toBe("--room demo")
  })

  test("includes only non-default current values in the About web link and CLI command", () => {
    const state = createInitialTuiState({
      room: "demo",
      name: "alice",
      localId: "12345678",
      reconnectSocket: false,
      saveDir: "/tmp/send files",
      turnUrls: ["turn:turn.example.com:3478", "turns:turn.example.com:5349?transport=tcp"],
      turnUsername: "user",
      turnCredential: "pass",
    }, false)
    state.hideTerminalPeers = false
    state.autoAcceptIncoming = false
    state.autoOfferOutgoing = false
    state.autoSaveIncoming = false
    state.eventsExpanded = true
    expect(aboutWebUrl(state)).toBe("https://rtme.sh/#room=demo&clean=0&accept=0&offer=0&save=0")
    expect(aboutCliCommand(state)).toBe("--room demo --clean 0 --accept 0 --offer 0 --save 0 --events --folder '/tmp/send files' --turn-url turn:turn.example.com:3478 --turn-url turns:turn.example.com:5349?transport=tcp --turn-username user --turn-credential pass")
  })

  test("does not include peer-shared TURN in the About CLI command", () => {
    const state = createInitialTuiState({ room: "demo", name: "alice", localId: "12345678", reconnectSocket: false }, false)
    state.snapshot = { ...state.snapshot, turnState: "idle", turn: "idle" }
    expect(aboutCliCommand(state)).toBe("--room demo")
  })

  test("prints full revival web and CLI outputs for TUI exit", () => {
    const state = createInitialTuiState({
      room: "demo",
      name: "alice",
      localId: "12345678",
      reconnectSocket: false,
      saveDir: "/tmp/send files",
      turnUrls: ["turn:turn.example.com:3478"],
      turnUsername: "user",
      turnCredential: "pass",
    }, true)
    state.hideTerminalPeers = false
    state.autoAcceptIncoming = false
    state.autoOfferOutgoing = false
    state.autoSaveIncoming = false

    expect(resumeWebUrl(state)).toBe("https://rtme.sh/#room=demo&clean=0&accept=0&offer=0&save=0")
    expect(resumeCliCommand(state)).toBe("bunx rtme.sh --room demo --self alice-12345678 --clean 0 --accept 0 --offer 0 --save 0 --events --folder '/tmp/send files' --turn-url turn:turn.example.com:3478 --turn-username user --turn-credential pass")
    expect(resumeOutputLines(state)).toEqual([
      "Rejoin with:",
      "",
      "Web",
      "https://rtme.sh/#room=demo&clean=0&accept=0&offer=0&save=0",
      "",
      "CLI",
      "bunx rtme.sh --room demo --self alice-12345678 --clean 0 --accept 0 --offer 0 --save 0 --events --folder '/tmp/send files' --turn-url turn:turn.example.com:3478 --turn-username user --turn-credential pass",
      "",
    ])
  })

  test("includes overwrite in TUI exit revival web and CLI outputs when enabled", () => {
    const state = createInitialTuiState({ room: "demo", name: "alice", localId: "12345678", reconnectSocket: false, overwriteIncoming: true }, false)

    expect(resumeWebUrl(state)).toBe("https://rtme.sh/#room=demo&overwrite=1")
    expect(resumeCliCommand(state)).toBe("bunx rtme.sh --room demo --self alice-12345678 --overwrite")
  })

  test("does not include peer-shared TURN in the TUI exit revival CLI output", () => {
    const state = createInitialTuiState({ room: "demo", name: "alice", localId: "12345678", reconnectSocket: false }, false)
    state.snapshot = { ...state.snapshot, turnState: "idle", turn: "idle" }

    expect(resumeWebUrl(state)).toBe("https://rtme.sh/#room=demo")
    expect(resumeCliCommand(state)).toBe("bunx rtme.sh --room demo --self alice-12345678")
    expect(resumeOutputLines(state)).toEqual([
      "Rejoin with:",
      "",
      "Web",
      "https://rtme.sh/#room=demo",
      "",
      "CLI",
      "bunx rtme.sh --room demo --self alice-12345678",
      "",
    ])
  })

  test("quit controller resolves from terminal signals and detaches listeners", async () => {
    const processLike = new EventEmitter() as EventEmitter & {
      on: (signal: "SIGINT" | "SIGTERM" | "SIGHUP", handler: () => void) => unknown
      off: (signal: "SIGINT" | "SIGTERM" | "SIGHUP", handler: () => void) => unknown
    }
    processLike.off = processLike.removeListener.bind(processLike)
    const quit = createQuitController(processLike)

    processLike.emit("SIGINT")
    await quit.promise
    expect(quit.requestStop()).toBe(false)
    expect(processLike.listenerCount("SIGINT")).toBe(1)

    quit.detach()
    expect(processLike.listenerCount("SIGINT")).toBe(0)
    expect(processLike.listenerCount("SIGTERM")).toBe(0)
    expect(processLike.listenerCount("SIGHUP")).toBe(0)
  })

  test("quit controller resolves only once for repeated local stop requests", async () => {
    const quit = createQuitController(null)
    expect(quit.requestStop()).toBe(true)
    expect(quit.requestStop()).toBe(false)
    await quit.promise
  })

  test("renders grouped file actions with gaps between Offer, Accept|Save, and Clear", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", reconnectSocket: false }, false)
    const view = renderer.render(renderTuiView(state, createNoopTuiActions()))
    const filesActions = view.findById("files-actions")
    const modeActions = view.findById("files-mode-actions")
    const offer = view.findById("toggle-offer")
    const accept = view.findById("toggle-accept")
    const save = view.findById("toggle-save")
    const clear = view.findById("clear-drafts")
    expect(filesActions === null || modeActions === null || offer === null || accept === null || save === null || clear === null).toBe(false)
    if (!filesActions || !modeActions || !offer || !accept || !save || !clear) throw new Error("missing file action nodes")
    expect(filesActions.props.gap).toBe(1)
    expect(modeActions.props.gap).toBe(0)
    expect(accept.rect.x < save.rect.x).toBe(true)
    expect(save.rect.x < clear.rect.x).toBe(true)
    expect("disabled" in clear.props ? clear.props.disabled : false).toBe(false)
  })

  test("does not render the fake Files dropzone", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", reconnectSocket: false }, false)
    const view = renderer.render(renderTuiView(state, createNoopTuiActions()))
    expect(view.findById("draft-input") === null).toBe(false)
    expect(view.findById("files-dropzone")).toBe(null)
    expect(view.findById("files-actions") === null).toBe(false)
    expect(view.findText("Drop files")).toBe(null)
    expect(view.findText("Enter file paths above and press Add.")).toBe(null)
    expect(view.findText("Add draft paths here. Offer auto-sends drafts to selected ready peers when enabled.")).toBe(null)
    expect(view.findText("No draft paths")).toBe(null)
  })

  test("resolves launch draft paths into startup drafts and notices", async () => {
    const dir = join(process.cwd(), ".tmp-send-tui-launch-drafts")
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })
    const first = join(dir, "one.txt")
    const second = join(dir, "two.txt")
    const folder = join(dir, "nested")
    const missing = join(dir, "missing.txt")
    await Bun.write(first, "one")
    await Bun.write(second, "hello")
    await mkdir(folder, { recursive: true })

    try {
      const success = await resolveLaunchDrafts([first, second])
      expect(success.drafts.map(draft => [draft.path, draft.name, draft.size])).toEqual([
        [first, "one.txt", 3],
        [second, "two.txt", 5],
      ])
      expect(success.notice).toEqual({ text: "Added 2 draft files.", variant: "success" })

      const mixed = await resolveLaunchDrafts([first, folder, missing])
      expect(mixed.drafts.map(draft => [draft.path, draft.name, draft.size])).toEqual([
        [first, "one.txt", 3],
      ])
      expect(mixed.notice).toEqual({ text: "Added 1 draft file · skipped 2 invalid paths.", variant: "warning" })

      const failed = await resolveLaunchDrafts([folder, missing])
      expect(failed.drafts).toEqual([])
      expect(failed.notice).toEqual({ text: "Skipped 2 invalid paths.", variant: "error" })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("renders a file preview popup under the Files input when focused", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", reconnectSocket: false }, false)
    state.focusedId = "draft-input"
    state.draftInput = "main"
    state.filePreview = {
      dismissedQuery: null,
      workspaceRoot: "/tmp",
      displayPrefix: "",
      displayQuery: "main",
      pendingQuery: "main",
      waiting: false,
      error: null,
      selectedIndex: 0,
      scrollTop: 0,
      results: [
        { relativePath: "src/main.ts", absolutePath: "/tmp/src/main.ts", fileName: "main.ts", kind: "file", size: 1024, score: 10, indices: [4, 5, 6, 7] },
        { relativePath: "src/main", absolutePath: "/tmp/src/main", fileName: "main", kind: "directory", score: 9, indices: [4, 5, 6, 7] },
      ],
    }
    const view = renderer.render(renderTuiView(state, createNoopTuiActions()))
    const previewPath = view.findById("file-preview-path-0")
    const status = view.findById("draft-preview-status")
    const error = view.findById("draft-preview-error")
    expect(view.findById("draft-preview") === null).toBe(false)
    expect(view.findById("file-preview-row-0") === null).toBe(false)
    expect(view.findById("file-preview-row-1") === null).toBe(false)
    expect(status === null || error === null).toBe(false)
    expect(previewPath === null).toBe(false)
    if (!previewPath || !status || !error) throw new Error("missing preview nodes")
    expect(previewPath.kind).toBe("row")
    expect(status.kind).toBe("text")
    expect(error.kind).toBe("text")
    expect(status.text).toBe("2 matches")
    expect(error.text).toBe(" ")
    const pathSegments = view.nodes
      .filter(node => node.kind === "text" && node.path.length > previewPath.path.length && previewPath.path.every((part, pathIndex) => node.path[pathIndex] === part))
      .map(node => [node.text, node.props.style ?? null])
    const row = view.findById("file-preview-row-0")
    const marker = view.nodes.find(node => node.kind === "text" && node.text === ">" && row && node.path.length > row.path.length && row.path.every((part, pathIndex) => node.path[pathIndex] === part))
    expect(pathSegments).toEqual([
      ["src/", { fg: rgb(159, 166, 178), dim: true }],
      ["main", { fg: rgb(170, 217, 76), bold: true }],
      [".ts", { fg: rgb(255, 255, 255) }],
    ])
    expect(marker?.props.style).toEqual({ fg: rgb(89, 194, 255), bold: true })
    expect(view.toText().includes("src/main.ts")).toBe(true)
    expect(hasRenderedText(view, "1.00 KB")).toBe(true)
    expect(hasRenderedText(view, "dir")).toBe(true)
    expect(hasRenderedText(view, "(dir)")).toBe(false)
    expect(hasRenderedText(view, "0 B")).toBe(false)
    expect(view.findText("loading...")).toBe(null)
  })

  test("hides the file preview when the query is dismissed or the input is unfocused", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", reconnectSocket: false }, false)
    state.focusedId = "draft-input"
    state.draftInput = "main"
    state.filePreview = {
      dismissedQuery: "main",
      workspaceRoot: "/tmp",
      displayPrefix: "",
      displayQuery: "main",
      pendingQuery: "main",
      waiting: false,
      error: null,
      selectedIndex: 0,
      scrollTop: 0,
      results: [
        { relativePath: "src/main.ts", absolutePath: "/tmp/src/main.ts", fileName: "main.ts", kind: "file", score: 10, indices: [4, 5, 6, 7] },
      ],
    }
    const dismissed = renderer.render(renderTuiView(state, createNoopTuiActions()))
    expect(dismissed.findById("draft-preview")).toBe(null)
    state.filePreview.dismissedQuery = null
    state.focusedId = "name-input"
    const unfocused = renderer.render(renderTuiView(state, createNoopTuiActions()))
    expect(unfocused.findById("draft-preview")).toBe(null)
  })

  test("renders traversal, home, and absolute preview rows in the same path style the user typed", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", reconnectSocket: false }, false)
    state.focusedId = "draft-input"
    state.draftInput = "../mai"
    state.filePreview = {
      dismissedQuery: null,
      workspaceRoot: "/tmp",
      displayPrefix: "../",
      displayQuery: "mai",
      pendingQuery: "mai",
      waiting: false,
      error: null,
      selectedIndex: 0,
      scrollTop: 0,
      results: [
        { relativePath: "main.ts", absolutePath: "/tmp/main.ts", fileName: "main.ts", kind: "file", score: 10, indices: [0, 1, 2] },
      ],
    }
    let view = renderer.render(renderTuiView(state, createNoopTuiActions()))
    expect(view.toText().includes("../main.ts")).toBe(true)

    state.draftInput = "~/mai"
    state.filePreview = {
      dismissedQuery: null,
      workspaceRoot: "/tmp",
      displayPrefix: "~/",
      displayQuery: "mai",
      pendingQuery: "mai",
      waiting: false,
      error: null,
      selectedIndex: 0,
      scrollTop: 0,
      results: [
        { relativePath: "main.ts", absolutePath: "/tmp/main.ts", fileName: "main.ts", kind: "file", score: 10, indices: [0, 1, 2] },
      ],
    }
    view = renderer.render(renderTuiView(state, createNoopTuiActions()))
    expect(view.toText().includes("~/main.ts")).toBe(true)

    state.draftInput = "/tmp/mai"
    state.filePreview = {
      dismissedQuery: null,
      workspaceRoot: "/tmp",
      displayPrefix: "/tmp/",
      displayQuery: "mai",
      pendingQuery: "mai",
      waiting: false,
      error: null,
      selectedIndex: 0,
      scrollTop: 0,
      results: [
        { relativePath: "main.ts", absolutePath: "/tmp/main.ts", fileName: "main.ts", kind: "file", score: 10, indices: [0, 1, 2] },
      ],
    }
    view = renderer.render(renderTuiView(state, createNoopTuiActions()))
    expect(view.toText().includes("/tmp/main.ts")).toBe(true)
  })

  test("accepting a file preview completion remounts and refocuses the files input", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", reconnectSocket: false }, false)
    state.focusedId = "draft-input"
    state.draftInput = "mai"
    state.filePreview = {
      dismissedQuery: null,
      workspaceRoot: "/tmp",
      displayPrefix: "",
      displayQuery: "mai",
      pendingQuery: "mai",
      waiting: false,
      error: null,
      selectedIndex: 0,
      scrollTop: 0,
      results: [
        { relativePath: "src/main.ts", absolutePath: "/tmp/src/main.ts", fileName: "main.ts", kind: "file", score: 10, indices: [4, 5, 6, 7] },
      ],
    }
    const before = renderer.render(renderTuiView(state, createNoopTuiActions()))
    const beforeInput = before.findById("draft-input")
    expect(beforeInput === null).toBe(false)
    if (!beforeInput) throw new Error("missing initial draft input")
    expect(beforeInput.props.key).toBe("draft-input-0")

    const accepted = withAcceptedDraftInput(
      state,
      "src/main.ts",
      {
        dismissedQuery: "src/main.ts",
        workspaceRoot: null,
        displayPrefix: "",
        displayQuery: null,
        pendingQuery: null,
        waiting: false,
        error: null,
        results: [],
        selectedIndex: null,
        scrollTop: 0,
      },
      { text: "Selected src/main.ts.", variant: "success" },
    )
    const after = renderer.render(renderTuiView(accepted, createNoopTuiActions()))
    const afterInput = after.findById("draft-input")
    const trap = after.findById("focus-request-1")
    expect(afterInput === null || trap === null).toBe(false)
    if (!afterInput || !trap) throw new Error("missing accepted draft input or focus trap")
    expect(accepted.draftInput).toBe("src/main.ts")
    expect(accepted.draftInputKeyVersion).toBe(1)
    expect(accepted.pendingFocusTarget).toBe("draft-input")
    expect(accepted.focusRequestEpoch).toBe(1)
    expect(afterInput.props.key).toBe("draft-input-1")
    expect(trap.props.initialFocus).toBe("draft-input")
  })

  test("accepting a directory preview completion also remounts the files input while keeping preview state active", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", reconnectSocket: false }, false)
    const accepted = withAcceptedDraftInput(
      { ...state, focusedId: "draft-input" },
      "src/",
      {
        dismissedQuery: null,
        workspaceRoot: "/tmp/src",
        displayPrefix: "src/",
        displayQuery: "",
        pendingQuery: "",
        waiting: true,
        error: null,
        results: [],
        selectedIndex: null,
        scrollTop: 0,
      },
      { text: "Browsing src/", variant: "info" },
    )
    const view = renderer.render(renderTuiView(accepted, createNoopTuiActions()))
    const input = view.findById("draft-input")
    const trap = view.findById("focus-request-1")
    expect(input === null || trap === null).toBe(false)
    if (!input || !trap) throw new Error("missing directory-accepted draft input or focus trap")
    expect(accepted.draftInput).toBe("src/")
    expect(accepted.filePreview.workspaceRoot).toBe("/tmp/src")
    expect(accepted.filePreview.waiting).toBe(true)
    expect(accepted.draftInputKeyVersion).toBe(1)
    expect(input.props.key).toBe("draft-input-1")
    expect(trap.props.initialFocus).toBe("draft-input")
  })

  test("uses dedicated status and error rows while searching and on preview errors", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", reconnectSocket: false }, false)
    state.focusedId = "draft-input"
    state.draftInput = "main"
    state.filePreview = {
      dismissedQuery: null,
      workspaceRoot: "/tmp",
      displayPrefix: "",
      displayQuery: "main",
      pendingQuery: "main",
      waiting: true,
      error: null,
      selectedIndex: 0,
      scrollTop: 0,
      results: [
        { relativePath: "src/main.ts", absolutePath: "/tmp/src/main.ts", fileName: "main.ts", kind: "file", score: 10, indices: [4, 5, 6, 7] },
      ],
    }
    let view = renderer.render(renderTuiView(state, createNoopTuiActions()))
    const status = view.findById("draft-preview-status")
    const error = view.findById("draft-preview-error")
    expect(status === null || error === null).toBe(false)
    if (!status || !error) throw new Error("missing preview status or error row")
    expect(status.text).toBe("searching...")
    expect(error.text).toBe(" ")
    expect(view.findById("file-preview-row-0") === null).toBe(false)
    expect(view.findText("loading...")).toBe(null)

    state.filePreview.waiting = false
    state.filePreview.error = "unreadable directory"
    view = renderer.render(renderTuiView(state, createNoopTuiActions()))
    const errorAfterFailure = view.findById("draft-preview-error")
    expect(errorAfterFailure === null).toBe(false)
    if (!errorAfterFailure) throw new Error("missing preview error row after failure")
    expect(errorAfterFailure.text).toBe("unreadable directory")
    expect(view.findById("file-preview-row-0") === null).toBe(false)
  })

  test("shows no matches in the dedicated status row", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", reconnectSocket: false }, false)
    state.focusedId = "draft-input"
    state.draftInput = "main"
    state.filePreview = {
      dismissedQuery: null,
      workspaceRoot: "/tmp",
      displayPrefix: "",
      displayQuery: "main",
      pendingQuery: "main",
      waiting: false,
      error: null,
      selectedIndex: null,
      scrollTop: 0,
      results: [],
    }
    const view = renderer.render(renderTuiView(state, createNoopTuiActions()))
    const status = view.findById("draft-preview-status")
    expect(status === null).toBe(false)
    if (!status) throw new Error("missing preview status row")
    expect(status.text).toBe("no matches")
  })

  test("keeps the Files Add button vertically aligned with the input", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", reconnectSocket: false }, false)
    const view = renderer.render(renderTuiView(state, createNoopTuiActions()))
    const row = view.findById("files-input-row")
    const input = view.findById("draft-input")
    const add = view.findById("add-drafts")
    expect(row === null || input === null || add === null).toBe(false)
    if (!row || !input || !add) throw new Error("missing Files input row nodes")
    const inputCenter = input.rect.y + Math.floor(input.rect.h / 2)
    const addCenter = add.rect.y + Math.floor(add.rect.h / 2)
    expect(addCenter).toBe(inputCenter)
  })

  test("renders draft rows with filename, size, and a close button", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", reconnectSocket: false }, false)
    state.drafts = [
      { id: "d1", path: "/tmp/alpha.txt", name: "alpha.txt", size: 1024, createdAt: 1 },
    ]
    const view = renderer.render(renderTuiView(state, createNoopTuiActions()))
    expect(view.findById("drafts-view") === null).toBe(false)
    expect(view.findText("alpha.txt") === null).toBe(false)
    expect(hasRenderedText(view, "1.00 KB")).toBe(true)
    expect(view.findText("/tmp/alpha.txt")).toBe(null)
    expect(hasRenderedText(view, "✕")).toBe(true)
  })

  test("renders a Total summary when multiple drafts exist", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", reconnectSocket: false }, false)
    state.drafts = [
      { id: "d1", path: "/tmp/alpha.txt", name: "alpha.txt", size: 1024, createdAt: 1 },
      { id: "d2", path: "/tmp/bravo.bin", name: "bravo.bin", size: 2048, createdAt: 2 },
    ]
    const view = renderer.render(renderTuiView(state, createNoopTuiActions()))
    expect(view.findById("drafts-summary") === null).toBe(false)
    expect(view.findText("Total") === null).toBe(false)
    expect(hasRenderedText(view, "draft 2 3.00 KB")).toBe(true)
    expect(hasRenderedText(view, "(draft 2 3.00 KB)")).toBe(false)
  })

  test("uses a dense shell layout with a sidebar gutter", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", name: "alice", reconnectSocket: false }, false)
    const view = renderer.render(renderTuiView(state, createNoopTuiActions()))
    const header = view.findById("header-shell")
    const body = view.findById("body-shell")
    const sidebar = view.findById("sidebar")
    const main = view.findById("main-scroll")
    const footer = view.findById("footer-shell")
    const brand = view.findById("brand-title")
    const room = view.findById("room-card")
    const self = view.findById("self-card")
    const peers = view.findById("peers-card")
    expect(brand === null).toBe(false)
    expect(header === null || body === null || sidebar === null || main === null || footer === null || room === null || self === null || peers === null || brand === null).toBe(false)
    if (!header || !body || !sidebar || !main || !footer || !room || !self || !peers || !brand) throw new Error("missing shell nodes")
    expect(header.rect.x).toBe(0)
    expect(header.rect.y).toBe(0)
    expect(body.rect.x).toBe(0)
    expect(body.rect.y).toBe(header.rect.y + header.rect.h)
    expect(body.rect.h).toBe(60 - header.rect.h - footer.rect.h)
    expect(sidebar.rect.w).toBe(45)
    expect(sidebar.rect.h).toBe(body.rect.h)
    expect(main.kind).toBe("box")
    expect("border" in main.props ? main.props.border : undefined).toBe("none")
    expect(main.rect.x).toBe(sidebar.rect.x + sidebar.rect.w + 1)
    expect(main.rect.h).toBe(body.rect.h)
    expect(room.rect.x).toBe(self.rect.x)
    expect(self.rect.x).toBe(peers.rect.x)
    expect(self.rect.y).toBe(room.rect.y + room.rect.h)
    expect(peers.rect.y).toBe(self.rect.y + self.rect.h)
    expect(peers.rect.y + peers.rect.h).toBe(sidebar.rect.y + sidebar.rect.h)
    expect(footer.rect.x).toBe(0)
    expect(footer.rect.y).toBe(body.rect.y + body.rect.h)
  })

  test("lets the peers list fill the remaining sidebar height and scroll", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", reconnectSocket: false }, false)
    state.snapshot = {
      ...state.snapshot,
      peers: Array.from({ length: 8 }, (_, index) => ({
        id: `p${index + 1}`,
        name: `peer${index + 1}`,
        displayName: `peer${index + 1}-p${index + 1}`,
        presence: "active",
        selected: true,
        selectable: true,
        ready: true,
        status: "connected",
        turn: "custom-turn",
        turnState: "idle",
        dataState: "open",
        lastError: "",
        rttMs: 29,
        localCandidateType: "host",
        remoteCandidateType: "srflx",
        pathLabel: "Direct ↔ NAT",
        profile: {
          geo: { city: "Seoul", region: "Seoul", country: "KR" },
          network: { asOrganization: "Edge ISP", colo: "ICN", ip: `203.0.113.${index + 1}` },
          ua: { browser: "send-cli", os: "linux", device: "desktop" },
          ready: true,
          error: "",
        },
      })),
    }
    const view = renderer.render(renderTuiView(state, createNoopTuiActions()))
    const peers = view.findById("peers-card")
    const peerList = view.findById("peers-list")
    expect(peers === null || peerList === null).toBe(false)
    if (!peers || !peerList) throw new Error("missing peers card or list")
    expect(peerList.kind).toBe("box")
    expect(peerList.props.overflow).toBe("scroll")
    expect("border" in peerList.props ? peerList.props.border : undefined).toBe("none")
    expect("maxHeight" in peerList.props ? peerList.props.maxHeight : undefined).toBe(undefined)
    expect(peerList.rect.h > 20).toBe(true)
    expect(peerList.rect.y + peerList.rect.h).toBe(peers.rect.y + peers.rect.h - 1)
  })

  test("renders web-app-style peer rows with metrics and profile lines", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", reconnectSocket: false }, false)
    state.snapshot = {
      ...state.snapshot,
      peers: [
        {
          id: "p1",
          name: "alice",
          displayName: "alice-p1",
          presence: "active",
          selected: true,
          selectable: true,
          ready: true,
          status: "connected",
          turn: "custom-turn",
          turnState: "used",
          dataState: "open",
          lastError: "",
          profile: {
            geo: { city: "Seoul", region: "Seoul", country: "KR" },
            network: { asOrganization: "Edge ISP", colo: "ICN", ip: "203.0.113.5" },
            ua: { browser: "send-cli", os: "linux", device: "desktop" },
            defaults: { autoAcceptIncoming: true, autoSaveIncoming: false },
            streamingSaveIncoming: true,
            ready: true,
            error: "",
          },
          rttMs: 12,
          localCandidateType: "host",
          remoteCandidateType: "relay",
          pathLabel: "Direct ↔ TURN",
        },
      ],
    }
    const view = renderer.render(renderTuiView(state, createNoopTuiActions()))
    expect(view.findById("peer-toggle-p1") === null).toBe(false)
    const shareButton = view.findById("peer-share-turn-p1")
    expect(shareButton === null).toBe(false)
    if (!shareButton) throw new Error("missing peer share button")
    expect(shareButton.kind).toBe("button")
    expect(shareButton.props.label).toBe("alice-p1")
    expect(shareButton.props.dsVariant).toBe("ghost")
    expect(shareButton.props.px).toBe(0)
    expect((shareButton.props as any).intent).toBe(undefined)
    expect((shareButton.props as any).style).toEqual({ fg: rgb(255, 255, 255) })
    expect((shareButton.props as any).focusConfig?.indicator).toBe("none")
    expect((shareButton.props as any).focusConfig?.showHint).toBe(false)
    expect((shareButton.props as any).focusConfig?.contentStyle).toBe(undefined)
    const peerRow = view.findById("peer-row-p1")
    expect(peerRow === null).toBe(false)
    if (!peerRow) throw new Error("missing peer row")
    const peerRowText = (value: string) => view.nodes.find(node =>
      node.kind === "text"
      && node.text === value
      && node.path.length > peerRow.path.length
      && peerRow.path.every((part, index) => node.path[index] === part))
    const rtt = peerRowText("RTT")
    const data = peerRowText("Data")
    const turn = peerRowText("TURN")
    const turnValue = view.findText("used")
    const path = peerRowText("Path")
    const pathValue = view.findText("Direct ↔ TURN")
    const connected = view.nodes.find(node => node.kind === "status" && "label" in node.props && node.props.label === "connected")
    const defaults = view.findText("As")
    expect(rtt === null || data === null || turn === null || turnValue === null || path === null || pathValue === null).toBe(false)
    if (!rtt || !data || !turn || !turnValue || !path || !pathValue) throw new Error("missing peer metric nodes")
    expect(connected === undefined || defaults === null).toBe(false)
    if (!connected || !defaults) throw new Error("missing peer status nodes")
    expect(hasRenderedText(view, "12ms")).toBe(true)
    expect(hasRenderedText(view, "open")).toBe(true)
    expect(hasRenderedText(view, "used")).toBe(true)
    expect(hasRenderedText(view, "As")).toBe(true)
    expect(connected.props.status).toBe("online")
    expect(turn.rect.y).toBe(rtt.rect.y)
    expect(data.rect.y > rtt.rect.y).toBe(true)
    expect(path.rect.y).toBe(data.rect.y)
    expect(pathValue.rect.y > rtt.rect.y).toBe(true)
    expect(defaults.rect.x).toBe(connected.rect.x + connected.rect.w + 1)
    expect(hasRenderedText(view, "(connected)")).toBe(false)
    expect(hasRenderedText(view, "(open)")).toBe(false)
    expect(hasRenderedText(view, "(used)")).toBe(false)
    expect(hasRenderedText(view, "( open )")).toBe(false)
    expect(hasRenderedText(view, "(As)")).toBe(false)
    expect(hasRenderedText(view, "( As )")).toBe(false)
    expect(hasRenderedText(view, "Direct ↔ TURN")).toBe(true)
    expect(hasRenderedText(view, "Seoul, Seoul, KR")).toBe(true)
    expect(hasRenderedText(view, "Edge ISP · ICN")).toBe(true)
    const peerIp = view.nodes.find(node => node.kind === "link" && "label" in node.props && node.props.label === "203.0.113.5")
    expect(peerIp === undefined).toBe(false)
    if (!peerIp) throw new Error("missing peer IP link")
    expect(peerIp.props.url).toBe("https://gi.rt.ht/:203.0.113.5")
    expect(view.findText("Selected")).toBe(null)
    for (const metric of [rtt, data, turn, path]) {
      const box = nearestAncestorBox(view, metric)
      expect(box === null).toBe(false)
      if (!box) throw new Error("missing peer metric box")
      expect("border" in box.props ? box.props.border : undefined).toBe("single")
      const borderStyle = "borderStyle" in box.props ? box.props.borderStyle : null
      expect(borderStyle === null || typeof borderStyle !== "object").toBe(false)
      if (!borderStyle || typeof borderStyle !== "object") throw new Error("missing peer metric border style")
      expect("fg" in borderStyle ? borderStyle.fg : null).toBe(rgb(20, 25, 32))
    }
  })

  test("keeps missing IP profile rows as plain dashes", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", reconnectSocket: false }, false)
    state.snapshot = {
      ...state.snapshot,
      profile: {
        ...state.snapshot.profile,
        network: { ...(state.snapshot.profile?.network || {}), ip: "" },
      },
      peers: [
        {
          id: "p1",
          name: "alice",
          displayName: "alice-p1",
          presence: "active",
          selected: true,
          selectable: true,
          ready: true,
          status: "connected",
          turn: "custom-turn",
          turnState: "used",
          dataState: "open",
          lastError: "",
          profile: {
            geo: { city: "Seoul", region: "Seoul", country: "KR" },
            network: { asOrganization: "Edge ISP", colo: "ICN", ip: "" },
            ua: { browser: "send-cli", os: "linux", device: "desktop" },
            defaults: { autoAcceptIncoming: true, autoSaveIncoming: false },
            ready: true,
            error: "",
          },
          rttMs: 12,
          localCandidateType: "host",
          remoteCandidateType: "relay",
          pathLabel: "Direct ↔ TURN",
        },
      ],
    }
    const view = renderer.render(renderTuiView(state, createNoopTuiActions()))
    expect(view.nodes.some(node => node.kind === "link" && "label" in node.props && node.props.label === "")).toBe(false)
    expect(view.nodes.filter(node => node.kind === "text" && node.text === "—").length >= 2).toBe(true)
  })

  test("renders unknown peer auto-defaults as ??", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", reconnectSocket: false }, false)
    state.snapshot = {
      ...state.snapshot,
      peers: [
        {
          id: "p1",
          name: "alice",
          displayName: "alice-p1",
          presence: "active",
          selected: true,
          selectable: true,
          ready: true,
          status: "connected",
          turn: "stun",
          turnState: "idle",
          dataState: "open",
          lastError: "",
          profile: {
            geo: { city: "Seoul", region: "Seoul", country: "KR" },
            network: { asOrganization: "Edge ISP", colo: "ICN", ip: "203.0.113.5" },
            ua: { browser: "send-cli", os: "linux", device: "desktop" },
            ready: true,
            error: "",
          },
          rttMs: 12,
          localCandidateType: "host",
          remoteCandidateType: "relay",
          pathLabel: "Direct ↔ TURN",
        },
      ],
    }
    const view = renderer.render(renderTuiView(state, createNoopTuiActions()))
    expect(hasRenderedText(view, "??")).toBe(true)
    expect(hasRenderedText(view, "(??)")).toBe(false)
  })

  test("renders the latest peer auto-defaults after consecutive remote profile updates", async () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", localId: "self", reconnectSocket: false }, false)
    const session = state.session as any
    state.snapshot = session.snapshot()
    const unsubscribe = session.subscribe(() => {
      state.snapshot = session.snapshot()
    })

    await session.onSignalMessage(JSON.stringify({
      room: state.snapshot.room,
      from: "peer1",
      to: "*",
      at: Date.now(),
      kind: "profile",
      name: "alice",
      profile: { defaults: { autoAcceptIncoming: true, autoSaveIncoming: false } },
    }))
    await session.onSignalMessage(JSON.stringify({
      room: state.snapshot.room,
      from: "peer1",
      to: "*",
      at: Date.now(),
      kind: "profile",
      name: "alice",
      profile: { defaults: { autoAcceptIncoming: false, autoSaveIncoming: true, overwriteIncoming: true }, streamingSaveIncoming: true },
    }))

    unsubscribe()

    state.hideTerminalPeers = false
    const view = renderer.render(renderTuiView(state, createNoopTuiActions()))
    expect(hasRenderedText(view, "aW")).toBe(true)
    expect(hasRenderedText(view, "(aW)")).toBe(false)
    expect(hasRenderedText(view, "As")).toBe(false)
    expect(hasRenderedText(view, "(As)")).toBe(false)
  })

  test("keeps the peer checkbox, share button, and status cluster vertically aligned", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", reconnectSocket: false }, false)
    state.snapshot = {
      ...state.snapshot,
      peers: [
        {
          id: "p1",
          name: "alice",
          displayName: "alice-p1",
          presence: "active",
          selected: true,
          selectable: true,
          ready: true,
          status: "connected",
          turn: "custom-turn",
          turnState: "idle",
          dataState: "open",
          lastError: "",
          profile: { defaults: { autoAcceptIncoming: true, autoSaveIncoming: true }, streamingSaveIncoming: true },
          rttMs: 0,
          localCandidateType: "",
          remoteCandidateType: "",
          pathLabel: "—",
        },
      ],
    }
    const view = renderer.render(renderTuiView(state, createNoopTuiActions()))
    const toggle = view.findById("peer-toggle-p1")
    const peerRow = view.findById("peer-row-p1")
    const nameSlot = view.findById("peer-name-slot-p1")
    const shareButton = view.findById("peer-share-turn-p1")
    const statusCluster = view.findById("peer-status-cluster-p1")
    const status = view.nodes.find(node => node.kind === "status" && "label" in node.props && node.props.label === "connected")
    const autoState = view.nodes.find(node =>
      node.kind === "text"
      && node.text === "AX"
      && !!peerRow
      && node.path.length > peerRow.path.length
      && peerRow.path.every((part, index) => node.path[index] === part))
    expect(toggle === null || peerRow === null || nameSlot === null || shareButton === null || statusCluster === null || status === undefined || autoState === undefined).toBe(false)
    if (!toggle || !peerRow || !nameSlot || !shareButton || !statusCluster || !status || !autoState) throw new Error("missing peer header nodes")
    const toggleCenter = toggle.rect.y + Math.floor(toggle.rect.h / 2)
    const shareButtonCenter = shareButton.rect.y + Math.floor(shareButton.rect.h / 2)
    const statusClusterCenter = statusCluster.rect.y + Math.floor(statusCluster.rect.h / 2)
    expect(toggleCenter).toBe(shareButtonCenter)
    expect(statusClusterCenter).toBe(shareButtonCenter)
    expect(view.findById("peer-name-shell-p1")).toBe(null)
    expect(view.findById("peer-status-p1")).toBe(null)
    expect("border" in nameSlot.props ? nameSlot.props.border : undefined).toBe("none")
    expect(shareButton.props.label).toBe("alice-p1")
    expect(shareButton.props.disabled).toBe(undefined)
    expect(shareButton.props.focusable).toBe(false)
    expect(status.props.status).toBe("online")
    expect(autoState.rect.x).toBe(status.rect.x + status.rect.w + 1)
  })

  test("renders long peer display names through the share button", () => {
    const renderer = createTestRenderer({ viewport: { cols: 86, rows: 40 } })
    const state = createInitialTuiState({ room: "demo", reconnectSocket: false, turnUrls: ["turn:turn.example.com:3478"] }, false)
    state.snapshot = {
      ...state.snapshot,
      peers: [
        {
          id: "p1",
          name: "abraham",
          displayName: "abraham-twddq19g-super-extra-long-peer-label-for-ellipsis",
          presence: "active",
          selected: true,
          selectable: true,
          ready: true,
          status: "connected",
          turn: "custom-turn",
          turnState: "idle",
          dataState: "open",
          lastError: "",
          rttMs: 37,
          localCandidateType: "",
          remoteCandidateType: "",
          pathLabel: "Direct ↔ NAT",
        },
      ],
    }
    const view = renderer.render(renderTuiView(state, createNoopTuiActions()))
    const shareButton = view.findById("peer-share-turn-p1")
    expect(shareButton === null).toBe(false)
    if (!shareButton) throw new Error("missing peer share button")
    expect(shareButton.rect.w > 0).toBe(true)
    expect(shareButton.props.label).toBe("abraham-twddq19g-super-extra-long-peer-label-for-ellipsis")
    expect(shareButton.props.disabled).toBe(undefined)
    expect(shareButton.props.focusable).toBe(true)
  })

  test("pads the peer checkbox away from the left border", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", reconnectSocket: false }, false)
    state.snapshot = {
      ...state.snapshot,
      peers: [
        {
          id: "p1",
          name: "alice",
          displayName: "alice-p1",
          presence: "active",
          selected: false,
          selectable: true,
          ready: true,
          status: "connected",
          turn: "custom-turn",
          turnState: "idle",
          dataState: "open",
          lastError: "",
          rttMs: 0,
          localCandidateType: "",
          remoteCandidateType: "",
          pathLabel: "—",
        },
      ],
    }
    const view = renderer.render(renderTuiView(state, createNoopTuiActions()))
    const row = view.findById("peer-row-p1")
    const slot = view.findById("peer-toggle-slot-p1")
    const toggle = view.findById("peer-toggle-p1")
    expect(row === null || slot === null || toggle === null).toBe(false)
    if (!row || !slot || !toggle) throw new Error("missing peer row checkbox nodes")
    expect("border" in slot.props ? slot.props.border : undefined).toBe("single")
    const borderStyle = "borderStyle" in slot.props ? slot.props.borderStyle : null
    expect(borderStyle === null || typeof borderStyle !== "object").toBe(false)
    if (!borderStyle || typeof borderStyle !== "object") throw new Error("missing peer checkbox slot border style")
    expect("fg" in borderStyle ? borderStyle.fg : null).toBe(rgb(7, 10, 12))
    expect(toggle.rect.x > row.rect.x + 1).toBe(true)
    expect(toggle.rect.x > slot.rect.x).toBe(true)
  })

  test("does not render a focus arrow before the peer checkbox", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", reconnectSocket: false }, false)
    state.snapshot = {
      ...state.snapshot,
      peers: [
        {
          id: "p1",
          name: "alice",
          displayName: "alice-p1",
          presence: "active",
          selected: true,
          selectable: true,
          ready: true,
          status: "connected",
          turn: "custom-turn",
          turnState: "idle",
          dataState: "open",
          lastError: "",
          rttMs: 0,
          localCandidateType: "",
          remoteCandidateType: "",
          pathLabel: "—",
        },
      ],
    }
    const view = renderer.render(renderTuiView(state, createNoopTuiActions()), { focusedId: "peer-toggle-p1" })
    const text = view.toText()
    expect(text.includes("▸ [x]")).toBe(false)
    expect(text.includes("> [x]")).toBe(false)
    expect(text.includes("[x]")).toBe(true)
  })

  test("does not leave a blank line under the peer IP line", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", reconnectSocket: false }, false)
    state.snapshot = {
      ...state.snapshot,
      peers: [
        {
          id: "p1",
          name: "alice",
          displayName: "alice-p1",
          presence: "active",
          selected: true,
          selectable: true,
          ready: true,
          status: "connected",
          turn: "custom-turn",
          turnState: "idle",
          dataState: "open",
          lastError: "",
          profile: {
            geo: { city: "Seoul", region: "Seoul", country: "KR" },
            network: { asOrganization: "Edge ISP", colo: "ICN", ip: "203.0.113.5" },
            ua: { browser: "send-cli", os: "linux", device: "desktop" },
            ready: true,
            error: "",
          },
          rttMs: 0,
          localCandidateType: "",
          remoteCandidateType: "",
          pathLabel: "—",
        },
      ],
    }
    const view = renderer.render(renderTuiView(state, createNoopTuiActions()))
    const row = view.findById("peer-row-p1")
    const ip = view.nodes.find(node => node.kind === "link" && "label" in node.props && node.props.label === "203.0.113.5")
    expect(row === null || ip === undefined).toBe(false)
    if (!row || !ip) throw new Error("missing peer row or IP link")
    expect(ip.rect.y + ip.rect.h).toBe(row.rect.y + row.rect.h - 1)
  })

  test("shows peer counts as selected over rendered peers and uses filter-aware empty copy", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", reconnectSocket: false }, false)
    state.snapshot = {
      ...state.snapshot,
      peers: [
        { id: "p2", name: "bob", displayName: "bob-p2", presence: "active", selected: true, selectable: true, ready: true, status: "connected", turn: "stun", turnState: "none", dataState: "open", lastError: "", rttMs: 0, localCandidateType: "", remoteCandidateType: "", pathLabel: "—" },
        { id: "p3", name: "carol", displayName: "carol-p3", presence: "active", selected: true, selectable: true, ready: false, status: "new", turn: "stun", turnState: "none", dataState: "—", lastError: "", rttMs: 0, localCandidateType: "", remoteCandidateType: "", pathLabel: "—" },
        { id: "p1", name: "alice", displayName: "alice-p1", presence: "terminal", selected: true, selectable: false, ready: false, status: "left", turn: "stun", turnState: "none", dataState: "closed", lastError: "", rttMs: 0, localCandidateType: "", remoteCandidateType: "", pathLabel: "—" },
      ],
    }
    const nonEmpty = renderer.render(renderTuiView(state, createNoopTuiActions()))
    const shareAll = nonEmpty.findById("share-turn-all-peers")
    const countText = nonEmpty.findById("peers-count-text")
    const search = nonEmpty.findById("peer-search-input")
    expect(shareAll === null || countText === null).toBe(false)
    expect(search === null).toBe(false)
    if (!shareAll || !countText || !search) throw new Error("missing peers header controls")
    expect(shareAll.kind).toBe("button")
    expect(shareAll.props.label).toBe("Peers")
    expect(shareAll.props.dsVariant).toBe("ghost")
    expect(shareAll.props.px).toBe(0)
    expect((shareAll.props as any).intent).toBe(undefined)
    expect((shareAll.props as any).style).toEqual({ fg: rgb(255, 255, 255), bold: true })
    expect((shareAll.props as any).focusConfig?.indicator).toBe("none")
    expect((shareAll.props as any).focusConfig?.showHint).toBe(false)
    expect((shareAll.props as any).focusConfig?.contentStyle).toBe(undefined)
    expect(search.kind).toBe("input")
    expect(search.props.placeholder).toBe("filter")
    expect(countText.text).toBe("1/1")
    expect(shareAll.props.disabled).toBe(undefined)
    expect(shareAll.props.focusable).toBe(false)
    expect(nonEmpty.findById("peer-row-p2") === null).toBe(false)
    expect(nonEmpty.findById("peer-row-p3")).toBe(null)
    expect(nonEmpty.findById("peer-row-p1")).toBe(null)

    state.peerSearch = "zzz"
    const filtered = renderer.render(renderTuiView(state, createNoopTuiActions()))
    const filteredCount = filtered.findById("peers-count-text")
    expect(filteredCount === null).toBe(false)
    if (!filteredCount) throw new Error("missing filtered peer count text")
    expect(filteredCount.text).toBe("0/0")
    expect(hasRenderedText(filtered, "No peers match current filters.")).toBe(true)

    state.snapshot = { ...state.snapshot, peers: [] }
    state.peerSearch = ""
    const empty = renderer.render(renderTuiView(state, createNoopTuiActions()))
    expect(hasRenderedText(empty, "Waiting for peers in demo...")).toBe(true)
  })

  test("sorts peers by id and filters them by name-id substring", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", reconnectSocket: false }, false)
    state.snapshot = {
      ...state.snapshot,
      peers: [
        { id: "p2", name: "bob", displayName: "bob-p2", presence: "active", selected: true, selectable: true, ready: true, status: "connected", turn: "stun", turnState: "none", dataState: "open", lastError: "", rttMs: 0, localCandidateType: "", remoteCandidateType: "", pathLabel: "—" },
        { id: "p1", name: "alice", displayName: "alice-p1", presence: "active", selected: true, selectable: true, ready: true, status: "connected", turn: "stun", turnState: "none", dataState: "open", lastError: "", rttMs: 0, localCandidateType: "", remoteCandidateType: "", pathLabel: "—" },
      ],
    }

    const ordered = renderer.render(renderTuiView(state, createNoopTuiActions()))
    const p1 = ordered.findById("peer-row-p1")
    const p2 = ordered.findById("peer-row-p2")
    expect(p1 === null || p2 === null).toBe(false)
    if (!p1 || !p2) throw new Error("missing peer rows")
    expect(p1.rect.y < p2.rect.y).toBe(true)

    state.peerSearch = "bob-p2"
    const filtered = renderer.render(renderTuiView(state, createNoopTuiActions()))
    expect(filtered.findById("peer-row-p1")).toBe(null)
    expect(filtered.findById("peer-row-p2") === null).toBe(false)
  })

  test("applies launch-time peer filters to the rendered list", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", reconnectSocket: false }, false, { filter: "bob-p2" })
    state.snapshot = {
      ...state.snapshot,
      peers: [
        { id: "p2", name: "bob", displayName: "bob-p2", presence: "active", selected: true, selectable: true, ready: true, status: "connected", turn: "stun", turnState: "none", dataState: "open", lastError: "", rttMs: 0, localCandidateType: "", remoteCandidateType: "", pathLabel: "—" },
        { id: "p1", name: "alice", displayName: "alice-p1", presence: "active", selected: true, selectable: true, ready: true, status: "connected", turn: "stun", turnState: "none", dataState: "open", lastError: "", rttMs: 0, localCandidateType: "", remoteCandidateType: "", pathLabel: "—" },
      ],
    }

    const filtered = renderer.render(renderTuiView(state, createNoopTuiActions()))
    expect(filtered.findById("peer-row-p1")).toBe(null)
    expect(filtered.findById("peer-row-p2") === null).toBe(false)
  })

  test("scopes UI offering targets to rendered selected ready peers", () => {
    const peers: PeerSnapshot[] = [
      { id: "p2", name: "bob", displayName: "bob-p2", presence: "active", selected: true, selectable: true, ready: true, status: "connected", turn: "stun", turnState: "none", dataState: "open", lastError: "", rttMs: 0, localCandidateType: "", remoteCandidateType: "", pathLabel: "—" },
      { id: "p1", name: "alice", displayName: "alice-p1", presence: "active", selected: true, selectable: true, ready: true, status: "connected", turn: "stun", turnState: "none", dataState: "open", lastError: "", rttMs: 0, localCandidateType: "", remoteCandidateType: "", pathLabel: "—" },
      { id: "p3", name: "carol", displayName: "carol-p3", presence: "active", selected: true, selectable: true, ready: true, status: "connected", turn: "stun", turnState: "none", dataState: "open", lastError: "", rttMs: 0, localCandidateType: "", remoteCandidateType: "", pathLabel: "—" },
    ]

    expect(renderedReadySelectedPeers(peers, true, "").map(peer => peer.id)).toEqual(["p1", "p2", "p3"])
    expect(renderedReadySelectedPeers(peers, true, "carol").map(peer => peer.id)).toEqual(["p3"])
    expect(renderedReadySelectedPeers(peers, true, "zzz")).toEqual([])
  })

  test("enables TURN share buttons only when self TURN is configured", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", reconnectSocket: false, turnUrls: ["turn:turn.example.com:3478"] }, false)
    state.snapshot = {
      ...state.snapshot,
      turnState: "idle",
      peers: [
        { id: "p1", name: "alice", displayName: "alice-p1", presence: "active", selected: true, selectable: true, ready: true, status: "connected", turn: "stun", turnState: "none", dataState: "open", lastError: "", rttMs: 0, localCandidateType: "", remoteCandidateType: "", pathLabel: "—" },
      ],
    }
    let view = renderer.render(renderTuiView(state, createNoopTuiActions()))
    const enabledShareAll = view.findById("share-turn-all-peers")
    const enabledPeerShare = view.findById("peer-share-turn-p1")
    expect(enabledShareAll === null || enabledPeerShare === null).toBe(false)
    if (!enabledShareAll || !enabledPeerShare) throw new Error("missing enabled TURN share buttons")
    expect(enabledShareAll.props.disabled).toBe(undefined)
    expect(enabledPeerShare.props.disabled).toBe(undefined)
    expect(enabledShareAll.props.focusable).toBe(true)
    expect(enabledPeerShare.props.focusable).toBe(true)

    const withoutTurn = createInitialTuiState({ room: "demo", reconnectSocket: false }, false)
    withoutTurn.snapshot = state.snapshot
    view = renderer.render(renderTuiView(withoutTurn, createNoopTuiActions()))
    const disabledShareAll = view.findById("share-turn-all-peers")
    const disabledPeerShare = view.findById("peer-share-turn-p1")
    expect(disabledShareAll === null || disabledPeerShare === null).toBe(false)
    if (!disabledShareAll || !disabledPeerShare) throw new Error("missing disabled TURN share buttons")
    expect(disabledShareAll.props.disabled).toBe(undefined)
    expect(disabledPeerShare.props.disabled).toBe(undefined)
    expect(disabledShareAll.props.focusable).toBe(false)
    expect(disabledPeerShare.props.focusable).toBe(false)

    const filteredState = createInitialTuiState({ room: "demo", reconnectSocket: false, turnUrls: ["turn:turn.example.com:3478"] }, false)
    filteredState.snapshot = state.snapshot
    filteredState.peerSearch = "zzz"
    view = renderer.render(renderTuiView(filteredState, createNoopTuiActions()))
    const filteredShareAll = view.findById("share-turn-all-peers")
    expect(filteredShareAll === null).toBe(false)
    if (!filteredShareAll) throw new Error("missing filtered TURN share-all button")
    expect(filteredShareAll.props.focusable).toBe(false)
  })

  test("hides the events card by default and shows it when enabled", () => {
    const renderer = createWideRenderer()
    const hidden = renderer.render(renderTuiView(createInitialTuiState({ room: "demo", reconnectSocket: false }, false), createNoopTuiActions()))
    const shown = renderer.render(renderTuiView(createInitialTuiState({ room: "demo", reconnectSocket: false }, true), createNoopTuiActions()))
    expect(hidden.findById("events-card")).toBe(null)
    expect(shown.findById("events-card") === null).toBe(false)
  })

  test("aligns the single visible Events card with Files and removes extra shell borders", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", reconnectSocket: false }, true)
    const view = renderer.render(renderTuiView(state, createNoopTuiActions()))
    const files = view.findById("files-card")
    const shell = view.findById("events-shell")
    const events = view.findById("events-card")
    const viewport = view.findById("events-viewport")
    expect(files === null || shell === null || events === null || viewport === null).toBe(false)
    if (!files || !shell || !events || !viewport) throw new Error("missing Files or Events nodes")
    expect(files.rect.y).toBe(events.rect.y)
    expect(events.rect.x).toBe(shell.rect.x)
    expect(events.props.border).toBe("rounded")
    expect(shell.props.border).toBe("none")
    expect(viewport.props.border).toBe("none")
  })

  test("renders event Copy alongside Clear and disables it when there are no logs", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", reconnectSocket: false }, true)
    const empty = renderer.render(renderTuiView(state, createNoopTuiActions()))
    const emptyCopy = empty.findById("copy-events")
    const emptyClear = empty.findById("clear-events")
    expect(emptyCopy === null || emptyClear === null).toBe(false)
    if (!emptyCopy || !emptyClear) throw new Error("missing event action buttons")
    expect("disabled" in emptyCopy.props ? emptyCopy.props.disabled : false).toBe(true)
    expect("disabled" in emptyClear.props ? emptyClear.props.disabled : false).toBe(true)

    state.snapshot = {
      ...state.snapshot,
      logs: [{ id: "l1", at: Date.UTC(2024, 0, 2, 3, 4, 5), kind: "signal:in", level: "info", payload: { room: "demo" } }],
    }
    const populated = renderer.render(renderTuiView(state, createNoopTuiActions()))
    const populatedCopy = populated.findById("copy-events")
    expect(populatedCopy === null).toBe(false)
    if (!populatedCopy) throw new Error("missing populated copy button")
    expect("disabled" in populatedCopy.props ? populatedCopy.props.disabled : true).toBe(false)
  })

  test("formats copied events with local time headers and expanded payload blocks", () => {
    const logs: LogEntry[] = [
      { id: "l1", at: Date.UTC(2024, 0, 2, 3, 4, 5), kind: "signal:in", level: "info", payload: { room: "demo", ok: true } },
      { id: "l2", at: Date.UTC(2024, 0, 2, 3, 4, 6), kind: "note", level: "error", payload: "plain text" },
    ]
    const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    expect(formatLogsForCopy(logs)).toBe([
      `${time.format(logs[0].at)} signal:in`,
      "{",
      '  "room": "demo",',
      '  "ok": true',
      "}",
      "",
      `${time.format(logs[1].at)} note`,
      "plain text",
    ].join("\n"))
  })

  test("does not render empty transfer sections", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", reconnectSocket: false }, false)
    const view = renderer.render(renderTuiView(state, createNoopTuiActions()))
    expect(view.findById("pending-card")).toBe(null)
    expect(view.findById("transfers-card")).toBe(null)
    expect(view.findById("completed-card")).toBe(null)
    expect(view.findById("failed-card")).toBe(null)
  })

  test("renders colored diagonal transfer direction arrows and title-line status badges", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", reconnectSocket: false }, false)
    state.snapshot = {
      ...state.snapshot,
      transfers: [
        { id: "t1", peerId: "p1", peerName: "alice", direction: "out", status: "complete", name: "one.txt", size: 1024, bytes: 1024, progress: 100, speedText: "1 KB/s", etaText: "—", error: "", createdAt: 1, updatedAt: 2, startedAt: 2, endedAt: 3, savedAt: 0 },
        { id: "t2", peerId: "p2", peerName: "bob", direction: "in", status: "error", name: "two.txt", size: 2048, bytes: 1024, progress: 50, speedText: "1 KB/s", etaText: "2s", error: "failed", createdAt: 4, updatedAt: 5, startedAt: 5, endedAt: 7, savedAt: 0 },
      ],
    }
    const view = renderer.render(renderTuiView(state, createNoopTuiActions()))
    const outgoingArrow = view.nodes.find(node => node.kind === "text" && node.text === "↗")
    const incomingArrow = view.nodes.find(node => node.kind === "text" && node.text === "↙")
    const outgoingName = view.nodes.find(node => node.kind === "text" && node.text === " one.txt")
    const incomingName = view.nodes.find(node => node.kind === "text" && node.text === " two.txt")
    const outgoingTitleRow = view.findById("transfer-title-row-t1")
    const incomingTitleRow = view.findById("transfer-title-row-t2")
    const outgoingTitleMain = view.findById("transfer-title-main-t1")
    const incomingTitleMain = view.findById("transfer-title-main-t2")
    const outgoingBadges = view.findById("transfer-badges-t1")
    const incomingBadges = view.findById("transfer-badges-t2")
    const outgoingStatus = view.nodes.find(node => node.kind === "status" && "label" in node.props && node.props.label === "complete")
    const incomingStatus = view.nodes.find(node => node.kind === "status" && "label" in node.props && node.props.label === "error")
    const incomingErrorTag = view.nodes.find(node => node.kind === "text" && node.text === "error")
    expect(outgoingArrow === undefined || incomingArrow === undefined).toBe(false)
    expect(outgoingName === undefined || incomingName === undefined).toBe(false)
    expect(outgoingTitleRow === null || incomingTitleRow === null || outgoingTitleMain === null || incomingTitleMain === null || outgoingBadges === null || incomingBadges === null || outgoingStatus === undefined || incomingStatus === undefined || incomingErrorTag === undefined).toBe(false)
    if (!outgoingArrow || !incomingArrow || !outgoingName || !incomingName || !outgoingTitleRow || !incomingTitleRow || !outgoingTitleMain || !incomingTitleMain || !outgoingBadges || !incomingBadges || !outgoingStatus || !incomingStatus || !incomingErrorTag) throw new Error("missing transfer title nodes")
    expect(hasRenderedText(view, "→")).toBe(false)
    expect(hasRenderedText(view, "←")).toBe(false)
    expect(outgoingArrow.props.style).toEqual({ fg: rgb(170, 217, 76), bold: true })
    expect(incomingArrow.props.style).toEqual({ fg: rgb(240, 113, 120), bold: true })
    expect(outgoingName.props.variant).toBe("heading")
    expect(incomingName.props.variant).toBe("heading")
    expect(outgoingStatus.props.status).toBe("online")
    expect(incomingStatus.props.status).toBe("offline")
    expect(outgoingBadges.rect.y).toBe(outgoingTitleRow.rect.y)
    expect(incomingBadges.rect.y).toBe(incomingTitleRow.rect.y)
    expect(outgoingStatus.rect.y).toBe(outgoingName.rect.y)
    expect(incomingStatus.rect.y).toBe(incomingName.rect.y)
    expect(incomingErrorTag.rect.y).toBe(incomingName.rect.y)
    expect(outgoingBadges.rect.x > outgoingTitleMain.rect.x + outgoingTitleMain.rect.w).toBe(true)
    expect(incomingBadges.rect.x > incomingTitleMain.rect.x + incomingTitleMain.rect.w).toBe(true)
    expect(outgoingBadges.rect.x + outgoingBadges.rect.w === outgoingTitleRow.rect.x + outgoingTitleRow.rect.w).toBe(true)
    expect(incomingBadges.rect.x + incomingBadges.rect.w === incomingTitleRow.rect.x + incomingTitleRow.rect.w).toBe(true)
  })

  test("anchors per-transfer action buttons to the bottom of the footer row instead of the title row", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", reconnectSocket: false }, false)
    state.snapshot = {
      ...state.snapshot,
      transfers: [
        { id: "t1", peerId: "p1", peerName: "alice", direction: "in", status: "pending", name: "one.txt", size: 1024, bytes: 0, progress: 0, speedText: "—", etaText: "—", error: "", createdAt: 1, updatedAt: 1, startedAt: 0, endedAt: 0, savedAt: 0 },
        { id: "t2", peerId: "p2", peerName: "bob", direction: "out", status: "sending", name: "two.txt", size: 2048, bytes: 1024, progress: 50, speedText: "1 KB/s", etaText: "2s", error: "", createdAt: 2, updatedAt: 3, startedAt: 3, endedAt: 0, savedAt: 0 },
      ],
    }
    const view = renderer.render(renderTuiView(state, createNoopTuiActions()))
    const pendingTitleRow = view.findById("transfer-title-row-t1")
    const pendingFooterRow = view.findById("transfer-footer-row-t1")
    const pendingLiveRow = view.findById("transfer-live-row-t1")
    const pendingActions = view.findById("transfer-actions-t1")
    const accept = view.findById("accept-t1")
    const reject = view.findById("reject-t1")
    const sendingTitleRow = view.findById("transfer-title-row-t2")
    const sendingFooterRow = view.findById("transfer-footer-row-t2")
    const sendingLiveRow = view.findById("transfer-live-row-t2")
    const sendingActions = view.findById("transfer-actions-t2")
    const cancel = view.findById("cancel-t2")
    expect(pendingTitleRow === null || pendingFooterRow === null || pendingLiveRow === null || pendingActions === null || accept === null || reject === null || sendingTitleRow === null || sendingFooterRow === null || sendingLiveRow === null || sendingActions === null || cancel === null).toBe(false)
    if (!pendingTitleRow || !pendingFooterRow || !pendingLiveRow || !pendingActions || !accept || !reject || !sendingTitleRow || !sendingFooterRow || !sendingLiveRow || !sendingActions || !cancel) throw new Error("missing transfer footer action nodes")
    expect(pendingActions.rect.y + pendingActions.rect.h).toBe(pendingFooterRow.rect.y + pendingFooterRow.rect.h)
    expect(sendingActions.rect.y + sendingActions.rect.h).toBe(sendingFooterRow.rect.y + sendingFooterRow.rect.h)
    expect(pendingActions.rect.y + pendingActions.rect.h).toBe(pendingLiveRow.rect.y + pendingLiveRow.rect.h)
    expect(sendingActions.rect.y + sendingActions.rect.h).toBe(sendingLiveRow.rect.y + sendingLiveRow.rect.h)
    expect(accept.rect.y).toBe(pendingActions.rect.y)
    expect(reject.rect.y).toBe(pendingActions.rect.y)
    expect(cancel.rect.y).toBe(sendingActions.rect.y)
    expect(pendingActions.rect.y > pendingTitleRow.rect.y).toBe(true)
    expect(sendingActions.rect.y > sendingTitleRow.rect.y).toBe(true)
    expect(pendingActions.rect.x > pendingLiveRow.rect.x + pendingLiveRow.rect.w).toBe(true)
    expect(sendingActions.rect.x > sendingLiveRow.rect.x + sendingLiveRow.rect.w).toBe(true)
  })

  test("renders transfer error callouts above the bottom-anchored footer actions", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", reconnectSocket: false }, false)
    state.snapshot = {
      ...state.snapshot,
      transfers: [
        { id: "t1", peerId: "p1", peerName: "alice", direction: "out", status: "sending", name: "one.txt", size: 1024, bytes: 512, progress: 50, speedText: "1 KB/s", etaText: "1s", error: "network stalled", createdAt: 1, updatedAt: 2, startedAt: 2, endedAt: 0, savedAt: 0 },
      ],
    }
    const view = renderer.render(renderTuiView(state, createNoopTuiActions()))
    const card = view.findById("transfer-card-t1")
    const errorBox = view.findById("transfer-error-t1")
    const footerRow = view.findById("transfer-footer-row-t1")
    const actionRow = view.findById("transfer-actions-t1")
    const cancel = view.findById("cancel-t1")
    expect(card === null || errorBox === null || footerRow === null || actionRow === null || cancel === null).toBe(false)
    if (!card || !errorBox || !footerRow || !actionRow || !cancel) throw new Error("missing transfer error or footer nodes")
    expect(errorBox.rect.y + errorBox.rect.h <= footerRow.rect.y).toBe(true)
    expect(actionRow.rect.y + actionRow.rect.h).toBe(footerRow.rect.y + footerRow.rect.h)
    expect(footerRow.rect.y + footerRow.rect.h <= card.rect.y + card.rect.h).toBe(true)
    expect(cancel.rect.y).toBe(actionRow.rect.y)
  })

  test("renders transfer facts inside the same dim-bordered boxes as peer metrics", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", reconnectSocket: false }, false)
    state.snapshot = {
      ...state.snapshot,
      peers: [
        { id: "p1", name: "alice", displayName: "alice-p1", presence: "active", selected: true, selectable: true, ready: true, status: "connected", turn: "custom-turn", turnState: "used", dataState: "open", lastError: "", rttMs: 12, localCandidateType: "host", remoteCandidateType: "relay", pathLabel: "Direct ↔ TURN" },
      ],
      transfers: [
        { id: "t1", peerId: "p1", peerName: "alice", direction: "out", status: "complete", name: "one.txt", size: 1024, bytes: 1024, progress: 100, speedText: "1 KB/s", etaText: "—", error: "", createdAt: 1, updatedAt: 2, startedAt: 2, endedAt: 3, savedAt: 0 },
      ],
    }
    const view = renderer.render(renderTuiView(state, createNoopTuiActions()))
    const size = view.findText("Size")
    const speed = view.findText("Speed")
    expect(size === null || speed === null).toBe(false)
    if (!size || !speed) throw new Error("missing transfer fact labels")
    for (const metric of [size, speed]) {
      const box = nearestAncestorBox(view, metric)
      expect(box === null).toBe(false)
      if (!box) throw new Error("missing transfer fact box")
      expect("border" in box.props ? box.props.border : undefined).toBe("single")
      const borderStyle = "borderStyle" in box.props ? box.props.borderStyle : null
      expect(borderStyle === null || typeof borderStyle !== "object").toBe(false)
      if (!borderStyle || typeof borderStyle !== "object") throw new Error("missing transfer fact border style")
      expect("fg" in borderStyle ? borderStyle.fg : null).toBe(rgb(20, 25, 32))
    }
  })

  test("maps waiting transfer statuses to busy ui.status badges in the title row", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", reconnectSocket: false }, false)
    state.snapshot = {
      ...state.snapshot,
      transfers: [
        { id: "t1", peerId: "p1", peerName: "alice", direction: "out", status: "queued", name: "one.txt", size: 1024, bytes: 0, progress: 0, speedText: "—", etaText: "—", error: "", createdAt: 1, updatedAt: 1, startedAt: 0, endedAt: 0, savedAt: 0 },
        { id: "t2", peerId: "p2", peerName: "bob", direction: "in", status: "pending", name: "two.txt", size: 2048, bytes: 0, progress: 0, speedText: "—", etaText: "—", error: "", createdAt: 2, updatedAt: 2, startedAt: 0, endedAt: 0, savedAt: 0 },
      ],
    }
    const view = renderer.render(renderTuiView(state, createNoopTuiActions()))
    const queuedStatus = view.nodes.find(node => node.kind === "status" && "label" in node.props && node.props.label === "queued")
    const pendingStatus = view.nodes.find(node => node.kind === "status" && "label" in node.props && node.props.label === "pending")
    const queuedName = view.nodes.find(node => node.kind === "text" && node.text === " one.txt")
    const pendingName = view.nodes.find(node => node.kind === "text" && node.text === " two.txt")
    expect(queuedStatus === undefined || pendingStatus === undefined || queuedName === undefined || pendingName === undefined).toBe(false)
    if (!queuedStatus || !pendingStatus || !queuedName || !pendingName) throw new Error("missing waiting transfer status nodes")
    expect(queuedStatus.props.status).toBe("busy")
    expect(pendingStatus.props.status).toBe("busy")
    expect(queuedStatus.rect.y).toBe(queuedName.rect.y)
    expect(pendingStatus.rect.y).toBe(pendingName.rect.y)
  })

  test("renders a Pending header Cancel button for outgoing queued or offered transfers", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", reconnectSocket: false }, false)
    state.snapshot = {
      ...state.snapshot,
      transfers: [
        { id: "t1", peerId: "p1", peerName: "alice", direction: "out", status: "queued", name: "one.txt", size: 1024, bytes: 0, progress: 0, speedText: "—", etaText: "—", error: "", createdAt: 1, updatedAt: 1, startedAt: 0, endedAt: 0, savedAt: 0 },
        { id: "t2", peerId: "p2", peerName: "bob", direction: "in", status: "pending", name: "two.txt", size: 2048, bytes: 0, progress: 0, speedText: "—", etaText: "—", error: "", createdAt: 2, updatedAt: 2, startedAt: 0, endedAt: 0, savedAt: 0 },
      ],
    }
    const view = renderer.render(renderTuiView(state, createNoopTuiActions()))
    const pending = view.findById("pending-card")
    const cancel = view.findById("cancel-pending")
    expect(pending === null || cancel === null).toBe(false)
    if (!pending || !cancel) throw new Error("missing pending card or cancel action")
    expect("disabled" in cancel.props ? cancel.props.disabled : true).toBe(false)
  })

  test("disables the Pending header Cancel button when only incoming pending transfers exist", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", reconnectSocket: false }, false)
    state.snapshot = {
      ...state.snapshot,
      transfers: [
        { id: "t1", peerId: "p1", peerName: "alice", direction: "in", status: "pending", name: "one.txt", size: 1024, bytes: 0, progress: 0, speedText: "—", etaText: "—", error: "", createdAt: 1, updatedAt: 1, startedAt: 0, endedAt: 0, savedAt: 0 },
      ],
    }
    const view = renderer.render(renderTuiView(state, createNoopTuiActions()))
    const cancel = view.findById("cancel-pending")
    expect(cancel === null).toBe(false)
    if (!cancel) throw new Error("missing pending cancel action")
    expect("disabled" in cancel.props ? cancel.props.disabled : false).toBe(true)
  })

  test("renders grouped transfer summaries when multiple peers exist in a section", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", reconnectSocket: false }, false)
    state.snapshot = {
      ...state.snapshot,
      peers: [
        { id: "p1", name: "alice", displayName: "alice-p1", presence: "active", selected: true, selectable: true, ready: true, status: "connected", turn: "custom-turn", turnState: "used", dataState: "open", lastError: "", rttMs: 12, localCandidateType: "host", remoteCandidateType: "relay", pathLabel: "Direct ↔ TURN" },
        { id: "p2", name: "bob", displayName: "bob-p2", presence: "active", selected: true, selectable: true, ready: true, status: "connected", turn: "stun", turnState: "idle", dataState: "open", lastError: "", rttMs: 22, localCandidateType: "srflx", remoteCandidateType: "host", pathLabel: "NAT ↔ Direct" },
      ],
      transfers: [
        { id: "t1", peerId: "p1", peerName: "alice", direction: "out", status: "complete", name: "one.txt", size: 1024, bytes: 1024, progress: 100, speedText: "1 KB/s", etaText: "—", error: "", createdAt: 1, updatedAt: 2, startedAt: 2, endedAt: 3, savedAt: 0 },
        { id: "t2", peerId: "p2", peerName: "bob", direction: "out", status: "complete", name: "two.txt", size: 2048, bytes: 2048, progress: 100, speedText: "2 KB/s", etaText: "—", error: "", createdAt: 4, updatedAt: 5, startedAt: 5, endedAt: 7, savedAt: 0 },
      ],
    }
    const view = renderer.render(renderTuiView(state, createNoopTuiActions()))
    expect(view.findById("completed-card") === null).toBe(false)
    expect(view.findText("Total") === null).toBe(false)
    expect(view.findText("alice-p1") === null).toBe(false)
    expect(view.findText("bob-p2") === null).toBe(false)
  })
})

describe("TUI grouping helpers", () => {
  const peers: PeerSnapshot[] = [
    { id: "p1", name: "alice", displayName: "alice-p1", presence: "active", selected: true, selectable: true, ready: true, status: "connected", turn: "custom-turn", turnState: "used", dataState: "open", lastError: "", rttMs: 0, localCandidateType: "host", remoteCandidateType: "relay", pathLabel: "Direct ↔ TURN" },
    { id: "p2", name: "bob", displayName: "bob-p2", presence: "active", selected: true, selectable: true, ready: true, status: "connected", turn: "stun", turnState: "idle", dataState: "open", lastError: "", rttMs: 0, localCandidateType: "srflx", remoteCandidateType: "host", pathLabel: "NAT ↔ Direct" },
  ]
  const transfers: TransferSnapshot[] = [
    { id: "t1", peerId: "p1", peerName: "alice", direction: "out", status: "complete", name: "one.txt", size: 1024, bytes: 1024, progress: 100, speedText: "1 KB/s", etaText: "—", error: "", createdAt: 10_000, updatedAt: 20_000, startedAt: 20_000, endedAt: 30_000, savedAt: 0 },
    { id: "t2", peerId: "p1", peerName: "alice", direction: "in", status: "error", name: "two.txt", size: 2048, bytes: 1024, progress: 50, speedText: "1 KB/s", etaText: "2s", error: "failed", createdAt: 40_000, updatedAt: 50_000, startedAt: 50_000, endedAt: 60_000, savedAt: 0 },
    { id: "t3", peerId: "p2", peerName: "bob", direction: "out", status: "complete", name: "three.txt", size: 4096, bytes: 4096, progress: 100, speedText: "4 KB/s", etaText: "—", error: "", createdAt: 70_000, updatedAt: 80_000, startedAt: 80_000, endedAt: 90_000, savedAt: 0 },
  ]

  test("groups transfers by peer display name", () => {
    expect(groupTransfersByPeer(transfers, peers)).toEqual([
      { key: "p1", name: "alice-p1", items: [transfers[0], transfers[1]] },
      { key: "p2", name: "bob-p2", items: [transfers[2]] },
    ])
  })

  test("summarizes counts, sizes, and duration", () => {
    expect(transferSummaryStats([transfers[0], transfers[1]], 100_000)).toEqual([
      { state: "complete", count: 1, size: 1024 },
      { state: "error", count: 1, size: 2048 },
      { state: "duration", label: "duration", count: 2, size: 0, countText: "20s", sizeText: "" },
    ])
  })
})

describe("TUI focus helpers", () => {
  test("derives boot focus from fallback and custom names", () => {
    expect(deriveBootFocusState(fallbackName)).toEqual({
      pendingFocusTarget: "name-input",
      focusRequestEpoch: 0,
      bootNameJumpPending: true,
    })
    expect(deriveBootFocusState("alice")).toEqual({
      pendingFocusTarget: "draft-input",
      focusRequestEpoch: 0,
      bootNameJumpPending: false,
    })
  })

  test("consumes a satisfied focus request only when the target matches", () => {
    const state = { pendingFocusTarget: "name-input", focusRequestEpoch: 3, bootNameJumpPending: true }
    expect(consumeSatisfiedFocusRequest(state, "draft-input")).toEqual(state)
    expect(consumeSatisfiedFocusRequest(state, "name-input")).toEqual({
      ...state,
      pendingFocusTarget: null,
    })
  })

  test("schedules the one-shot post-name jump only once", () => {
    const initial = deriveBootFocusState(fallbackName)
    const jumped = scheduleBootNameJump(initial)
    expect(jumped).toEqual({
      pendingFocusTarget: "draft-input",
      focusRequestEpoch: 1,
      bootNameJumpPending: false,
    })
    expect(scheduleBootNameJump(jumped)).toEqual(jumped)
  })
})

describe("TUI file preview helpers", () => {
  test("shows the preview only while the files input is focused with a non-empty non-dismissed query", () => {
    expect(filePreviewVisible({
      focusedId: "draft-input",
      draftInput: "main",
      filePreview: {
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
      },
    })).toBe(true)
    expect(filePreviewVisible({
      focusedId: "name-input",
      draftInput: "main",
      filePreview: {
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
      },
    })).toBe(false)
    expect(filePreviewVisible({
      focusedId: "draft-input",
      draftInput: "main",
      filePreview: {
        dismissedQuery: "main",
        workspaceRoot: null,
        displayPrefix: "",
        displayQuery: null,
        pendingQuery: null,
        waiting: false,
        error: null,
        results: [],
        selectedIndex: null,
        scrollTop: 0,
      },
    })).toBe(false)
  })

  test("accepts the selected preview row with right only when the files cursor starts at the end", () => {
    const state = {
      focusedId: "draft-input",
      draftInput: "mai",
      filePreview: {
        dismissedQuery: null,
        workspaceRoot: "/tmp",
        displayPrefix: "",
        displayQuery: "mai",
        pendingQuery: "mai",
        waiting: false,
        error: null,
        results: [
          { relativePath: "src/main.ts", absolutePath: "/tmp/src/main.ts", fileName: "main.ts", kind: "file" as const, score: 10, indices: [4, 5, 6, 7] },
        ],
        selectedIndex: 0,
        scrollTop: 0,
      },
    }
    expect(canAcceptFilePreviewWithRight(state, 3)).toBe(true)
    expect(canAcceptFilePreviewWithRight(state, 2)).toBe(false)
  })

  test("does not accept preview with right when the preview is hidden, unselected, or another input is focused", () => {
    const preview = {
      dismissedQuery: null,
      workspaceRoot: "/tmp",
      displayPrefix: "",
      displayQuery: "mai",
      pendingQuery: "mai",
      waiting: false,
      error: null,
      results: [
        { relativePath: "src/main.ts", absolutePath: "/tmp/src/main.ts", fileName: "main.ts", kind: "file" as const, score: 10, indices: [4, 5, 6, 7] },
      ],
      selectedIndex: 0,
      scrollTop: 0,
    }
    expect(canAcceptFilePreviewWithRight({ focusedId: "room-input", draftInput: "mai", filePreview: preview }, 3)).toBe(false)
    expect(canAcceptFilePreviewWithRight({ focusedId: "draft-input", draftInput: "mai", filePreview: { ...preview, dismissedQuery: "mai" } }, 3)).toBe(false)
    expect(canAcceptFilePreviewWithRight({ focusedId: "draft-input", draftInput: "mai", filePreview: { ...preview, selectedIndex: null } }, 3)).toBe(false)
  })

  test("clamps preview selection and keeps the selected row visible", () => {
    expect(clampFilePreviewSelectedIndex(null, 3)).toBe(0)
    expect(clampFilePreviewSelectedIndex(10, 3)).toBe(2)
    expect(ensureFilePreviewScrollTop(7, 0, 12, 8)).toBe(0)
    expect(ensureFilePreviewScrollTop(8, 0, 12, 8)).toBe(1)
  })

  test("moves the preview selection with wraparound", () => {
    const movedDown = moveFilePreviewSelection({
      dismissedQuery: null,
      workspaceRoot: "/tmp/src",
      displayPrefix: "src/",
      displayQuery: "main",
      pendingQuery: "main",
      waiting: false,
      error: null,
      results: [
        { relativePath: "src/main.ts", absolutePath: "/tmp/src/main.ts", fileName: "main.ts", kind: "file", score: 10, indices: [4] },
        { relativePath: "src/main.test.ts", absolutePath: "/tmp/src/main.test.ts", fileName: "main.test.ts", kind: "file", score: 9, indices: [4] },
      ],
      selectedIndex: null,
      scrollTop: 0,
    }, 1)
    expect(movedDown.selectedIndex).toBe(0)
    const movedUp = moveFilePreviewSelection({ ...movedDown, selectedIndex: 0 }, -1)
    expect(movedUp.selectedIndex).toBe(1)
  })

  test("splits preview paths into prefix, path, and basename segments", () => {
    expect(previewPathSegments("../src/main.ts", 3, [7, 8, 9, 10])).toEqual([
      { text: "../", highlighted: false, role: "prefix" },
      { text: "src/", highlighted: false, role: "path" },
      { text: "main", highlighted: true, role: "basename" },
      { text: ".ts", highlighted: false, role: "basename" },
    ])
  })

  test("maps preview segment styles to muted, primary, and selected highlight colors", () => {
    expect(previewSegmentStyle({ text: "../", highlighted: false, role: "prefix" }, false)).toEqual({ fg: rgb(112, 121, 136), dim: true })
    expect(previewSegmentStyle({ text: "src/", highlighted: false, role: "path" }, false)).toEqual({ fg: rgb(159, 166, 178), dim: true })
    expect(previewSegmentStyle({ text: "main", highlighted: false, role: "basename" }, false)).toEqual({ fg: rgb(255, 255, 255) })
    expect(previewSegmentStyle({ text: "main", highlighted: true, role: "basename" }, false)).toEqual({ fg: rgb(89, 194, 255), bold: true })
    expect(previewSegmentStyle({ text: "main", highlighted: true, role: "basename" }, true)).toEqual({ fg: rgb(170, 217, 76), bold: true })
  })

  test("stores successful draft submissions newest-first and normalizes quoted paths", () => {
    const pushed = pushDraftHistoryEntry({ entries: [], index: null, baseInput: null }, "\"src\\main.ts\"")
    expect(pushed).toEqual({ entries: ["src/main.ts"], index: null, baseInput: null })
    expect(pushDraftHistoryEntry(pushed, "'src\\main.ts'")).toEqual(pushed)
    expect(pushDraftHistoryEntry(pushed, "docs/readme.md")).toEqual({
      entries: ["docs/readme.md", "src/main.ts"],
      index: null,
      baseInput: null,
    })
  })

  test("enters draft history only from home-state inputs and keeps browsing while the caret stays at zero", () => {
    expect(isDraftHistoryEntryPoint("", 0)).toBe(true)
    expect(isDraftHistoryEntryPoint("src/", 0)).toBe(true)
    expect(isDraftHistoryEntryPoint("\"src/\"", 0)).toBe(true)
    expect(isDraftHistoryEntryPoint("src/main", 0)).toBe(false)
    expect(isDraftHistoryEntryPoint("src/", 1)).toBe(false)
    expect(canNavigateDraftHistory({ entries: ["src/main.ts"], index: null, baseInput: null }, "src/", 0)).toBe(true)
    expect(canNavigateDraftHistory({ entries: ["src/main.ts"], index: 0, baseInput: "" }, "src/main.ts", 0)).toBe(true)
    expect(canNavigateDraftHistory({ entries: ["src/main.ts"], index: 0, baseInput: "" }, "src/main.ts", 1)).toBe(false)
  })

  test("cycles draft history and restores the base input when moving back down past the newest entry", () => {
    const history = { entries: ["src/main.ts", "docs/readme.md"], index: null, baseInput: null }
    const entered = moveDraftHistory(history, "", -1)
    expect(entered).toEqual({
      history: { entries: ["src/main.ts", "docs/readme.md"], index: 0, baseInput: "" },
      value: "src/main.ts",
      changed: true,
    })
    const older = moveDraftHistory(entered.history, entered.value, -1)
    expect(older).toEqual({
      history: { entries: ["src/main.ts", "docs/readme.md"], index: 1, baseInput: "" },
      value: "docs/readme.md",
      changed: true,
    })
    const newer = moveDraftHistory(older.history, older.value, 1)
    expect(newer).toEqual({
      history: { entries: ["src/main.ts", "docs/readme.md"], index: 0, baseInput: "" },
      value: "src/main.ts",
      changed: true,
    })
    const restored = moveDraftHistory(newer.history, newer.value, 1)
    expect(restored).toEqual({
      history: { entries: ["src/main.ts", "docs/readme.md"], index: null, baseInput: null },
      value: "",
      changed: true,
    })
  })
})
