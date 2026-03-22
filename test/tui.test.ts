import { createTestRenderer, rgb, ui } from "@rezi-ui/core"
import { describe, expect, test } from "bun:test"
import { clampFilePreviewSelectedIndex, consumeSatisfiedFocusRequest, createInitialTuiState, createNoopTuiActions, deriveBootFocusState, ensureFilePreviewScrollTop, filePreviewVisible, groupTransfersByPeer, moveFilePreviewSelection, renderTuiView, scheduleBootNameJump, transferSummaryStats, visiblePanes, withAcceptedDraftInput } from "../src/tui/app"
import type { PeerSnapshot, TransferSnapshot } from "../src/core/session"
import { fallbackName } from "../src/core/protocol"

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

describe("TUI pane visibility", () => {
  test("hides the logs pane by default", () => {
    expect(visiblePanes(false)).toEqual(["peers", "transfers"])
  })

  test("shows the logs pane when events are enabled", () => {
    expect(visiblePanes(true)).toEqual(["peers", "transfers", "logs"])
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

  test("renders the header brand as separate icon and label nodes", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", reconnectSocket: false }, false)
    const view = renderer.render(renderTuiView(state, createNoopTuiActions()))
    const brand = view.findById("brand-title")
    const icon = view.findById("brand-icon")
    const label = view.findById("brand-label")
    const roomIcon = view.findById("new-room")
    const events = view.findById("toggle-events")
    expect(brand === null || icon === null || label === null || roomIcon === null || events === null).toBe(false)
    if (!brand || !icon || !label || !roomIcon || !events) throw new Error("missing header brand nodes")
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
  })

  test("renders a compact footer key-hint strip on the right", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", reconnectSocket: false }, false)
    const view = renderer.render(renderTuiView(state, createNoopTuiActions()))
    const footer = view.findById("footer-shell")
    const hints = view.findById("footer-hints")
    const tab = view.findById("footer-hint-tab")
    const enter = view.findById("footer-hint-enter")
    const esc = view.findById("footer-hint-esc")
    const ctrlc = view.findById("footer-hint-ctrlc")
    expect(footer === null || hints === null || tab === null || enter === null || esc === null || ctrlc === null).toBe(false)
    if (!footer || !hints || !tab || !enter || !esc || !ctrlc) throw new Error("missing footer hint nodes")
    expect(hasRenderedText(view, "Enter commits focused input")).toBe(false)
    expect(hasRenderedText(view, "Ctrl+C quits")).toBe(false)
    expect(hints.kind).toBe("row")
    expect(hints.props.gap).toBe(3)
    expect(tab.kind).toBe("row")
    expect(enter.kind).toBe("row")
    expect(esc.kind).toBe("row")
    expect(ctrlc.kind).toBe("row")
    expect(tab.props.gap).toBe(0)
    expect(enter.props.gap).toBe(0)
    expect(esc.props.gap).toBe(0)
    expect(ctrlc.props.gap).toBe(0)
    const tabKbd = view.nodes.find(node => node.kind === "kbd" && "keys" in node.props && node.props.keys === "tab")
    const enterKbd = view.nodes.find(node => node.kind === "kbd" && "keys" in node.props && node.props.keys === "enter")
    const escKbd = view.nodes.find(node => node.kind === "kbd" && "keys" in node.props && node.props.keys === "esc")
    const ctrlcKbd = view.nodes.find(node => node.kind === "kbd" && "keys" in node.props && node.props.keys === "ctrl+c")
    const focusLabel = view.nodes.find(node => node.kind === "text" && node.text === " focus/accept")
    const commitLabel = view.nodes.find(node => node.kind === "text" && node.text === " accept/add")
    const resetLabel = view.nodes.find(node => node.kind === "text" && node.text === " hide/reset")
    const quitLabel = view.nodes.find(node => node.kind === "text" && node.text === " quit")
    expect(tabKbd === undefined || enterKbd === undefined || escKbd === undefined || ctrlcKbd === undefined || focusLabel === undefined || commitLabel === undefined || resetLabel === undefined || quitLabel === undefined).toBe(false)
    if (!tabKbd || !enterKbd || !escKbd || !ctrlcKbd || !focusLabel || !commitLabel || !resetLabel || !quitLabel) throw new Error("missing footer key or label nodes")
    expect(focusLabel.rect.x).toBe(tabKbd.rect.x + tabKbd.rect.w)
    expect(commitLabel.rect.x).toBe(enterKbd.rect.x + enterKbd.rect.w)
    expect(resetLabel.rect.x).toBe(escKbd.rect.x + escKbd.rect.w)
    expect(quitLabel.rect.x).toBe(ctrlcKbd.rect.x + ctrlcKbd.rect.w)
    expect(view.nodes.some(node => node.text?.includes("focus/accept"))).toBe(true)
    expect(view.nodes.some(node => node.text?.includes("accept/add"))).toBe(true)
    expect(view.nodes.some(node => node.text?.includes("hide/reset"))).toBe(true)
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
      pulse: { state: "open", at: 1, ms: 12, error: "" },
      profile: {
        geo: { city: "Seoul", region: "Seoul", country: "KR" },
        network: { asOrganization: "Edge ISP", colo: "ICN", ip: "203.0.113.5" },
        ua: { browser: "send-cli", os: "linux", device: "desktop" },
        ready: true,
        error: "",
      },
    }
    const view = renderer.render(renderTuiView(state, createNoopTuiActions()))
    expect(view.findText("Signaling") === null).toBe(false)
    expect(view.findText("Pulse") === null).toBe(false)
    expect(view.findText("TURN") === null).toBe(false)
    expect(view.findText("-abc123") === null).toBe(false)
    expect(view.findText("Seoul, Seoul, KR") === null).toBe(false)
    expect(view.findText("Edge ISP · ICN") === null).toBe(false)
    expect(view.findText("send-cli · linux") === null).toBe(false)
    expect(view.findText("203.0.113.5") === null).toBe(false)
    expect(view.toText().includes("open")).toBe(true)
    expect(view.toText().includes("used")).toBe(true)
    expect(view.toText().includes("(open)")).toBe(false)
    expect(view.toText().includes("(used)")).toBe(false)
    expect(view.toText().includes("( open )")).toBe(false)
    expect(view.toText().includes("( used )")).toBe(false)
    expect(view.findText(`save ${state.snapshot.saveDir}`)).toBe(null)
    const signaling = view.findText("Signaling")
    const pulse = view.findText("Pulse")
    const turn = view.findText("TURN")
    expect(signaling === null || pulse === null || turn === null).toBe(false)
    if (!signaling || !pulse || !turn) throw new Error("missing self metric labels")
    for (const metric of [signaling, pulse, turn]) {
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

  test("renders the web-app-style room shell", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", name: "alice", reconnectSocket: false }, false)
    const view = renderer.render(renderTuiView(state, createNoopTuiActions()))
    const newRoom = view.findById("new-room")
    expect(view.findText("Room")).toBe(null)
    expect(view.findText("Signal idle")).toBe(null)
    expect(newRoom === null).toBe(false)
    if (!newRoom) throw new Error("missing new-room button")
    expect("label" in newRoom.props && newRoom.props.label).toBe("🏠")
    expect(view.findById("room-input") === null).toBe(false)
    expect(hasRenderedText(view, "📋")).toBe(false)
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
        { relativePath: "src/main.ts", absolutePath: "/tmp/src/main.ts", fileName: "main.ts", kind: "file", score: 10, indices: [4, 5, 6, 7] },
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
    expect(view.toText().includes("src/main.ts")).toBe(true)
    expect(hasRenderedText(view, "dir")).toBe(true)
    expect(hasRenderedText(view, "(dir)")).toBe(false)
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
    expect(view.findText("alice-p1") === null).toBe(false)
    const rtt = view.findText("RTT")
    const data = view.findText("Data")
    const turnValue = view.findText("used")
    const path = view.findText("Path")
    const pathValue = view.findText("Direct ↔ TURN")
    const connected = view.nodes.find(node => node.kind === "status" && "label" in node.props && node.props.label === "connected")
    const defaults = view.findText("As")
    expect(rtt === null || data === null || turnValue === null || path === null || pathValue === null).toBe(false)
    if (!rtt || !data || !turnValue || !path || !pathValue) throw new Error("missing peer metric nodes")
    expect(connected === undefined || defaults === null).toBe(false)
    if (!connected || !defaults) throw new Error("missing peer status nodes")
    expect(hasRenderedText(view, "12ms")).toBe(true)
    expect(hasRenderedText(view, "open")).toBe(true)
    expect(hasRenderedText(view, "used")).toBe(true)
    expect(hasRenderedText(view, "As")).toBe(true)
    expect(connected.props.status).toBe("online")
    expect(data.rect.y).toBe(rtt.rect.y)
    expect(pathValue.rect.y).toBe(turnValue.rect.y)
    expect(path.rect.y > rtt.rect.y).toBe(true)
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
    expect(hasRenderedText(view, "203.0.113.5")).toBe(true)
    expect(view.findText("Selected")).toBe(null)
    const turn = view.findText("TURN")
    expect(turn === null).toBe(false)
    if (!turn) throw new Error("missing TURN metric label")
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
      profile: { defaults: { autoAcceptIncoming: false, autoSaveIncoming: true } },
    }))

    unsubscribe()

    const view = renderer.render(renderTuiView(state, createNoopTuiActions()))
    expect(hasRenderedText(view, "aS")).toBe(true)
    expect(hasRenderedText(view, "(aS)")).toBe(false)
    expect(hasRenderedText(view, "As")).toBe(false)
    expect(hasRenderedText(view, "(As)")).toBe(false)
  })

  test("keeps the peer checkbox, name text, and status cluster vertically aligned", () => {
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
          profile: { defaults: { autoAcceptIncoming: true, autoSaveIncoming: true } },
          rttMs: 0,
          localCandidateType: "",
          remoteCandidateType: "",
          pathLabel: "—",
        },
      ],
    }
    const view = renderer.render(renderTuiView(state, createNoopTuiActions()))
    const toggle = view.findById("peer-toggle-p1")
    const nameSlot = view.findById("peer-name-slot-p1")
    const nameText = view.findById("peer-name-text-p1")
    const statusCluster = view.findById("peer-status-cluster-p1")
    const status = view.nodes.find(node => node.kind === "status" && "label" in node.props && node.props.label === "connected")
    const autoState = view.findText("AS")
    expect(toggle === null || nameSlot === null || nameText === null || statusCluster === null || status === undefined || autoState === null).toBe(false)
    if (!toggle || !nameSlot || !nameText || !statusCluster || !status || !autoState) throw new Error("missing peer header nodes")
    const toggleCenter = toggle.rect.y + Math.floor(toggle.rect.h / 2)
    const nameTextCenter = nameText.rect.y + Math.floor(nameText.rect.h / 2)
    const statusClusterCenter = statusCluster.rect.y + Math.floor(statusCluster.rect.h / 2)
    expect(toggleCenter).toBe(nameTextCenter)
    expect(statusClusterCenter).toBe(nameTextCenter)
    expect(view.findById("peer-name-shell-p1")).toBe(null)
    expect(view.findById("peer-status-p1")).toBe(null)
    expect("border" in nameSlot.props ? nameSlot.props.border : undefined).toBe("none")
    expect(nameText.props.textOverflow).toBe("ellipsis")
    expect(status.props.status).toBe("online")
    expect(autoState.rect.x).toBe(status.rect.x + status.rect.w + 1)
  })

  test("ellipsizes long peer display names in the single-line header", () => {
    const renderer = createTestRenderer({ viewport: { cols: 86, rows: 40 } })
    const state = createInitialTuiState({ room: "demo", reconnectSocket: false }, false)
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
    const text = view.toText()
    const nameText = view.findById("peer-name-text-p1")
    expect(nameText === null).toBe(false)
    if (!nameText) throw new Error("missing peer name text")
    expect(text.includes("abraham-twddq19g-super-extra-long-peer-label-for-ellipsis")).toBe(false)
    expect(text.includes("…")).toBe(true)
    expect(nameText.rect.w > 0).toBe(true)
    expect(nameText.props.textOverflow).toBe("ellipsis")
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
    const ip = view.findText("203.0.113.5")
    expect(row === null || ip === null).toBe(false)
    if (!row || !ip) throw new Error("missing peer row or IP text")
    expect(ip.rect.y + ip.rect.h).toBe(row.rect.y + row.rect.h - 1)
  })

  test("shows peer counts as selected over active and uses the web-style empty copy", () => {
    const renderer = createWideRenderer()
    const state = createInitialTuiState({ room: "demo", reconnectSocket: false }, false)
    state.snapshot = {
      ...state.snapshot,
      peers: [
        { id: "p1", name: "alice", displayName: "alice-p1", presence: "active", selected: true, selectable: true, ready: true, status: "connected", turn: "stun", turnState: "none", dataState: "open", lastError: "", rttMs: 0, localCandidateType: "", remoteCandidateType: "", pathLabel: "—" },
        { id: "p2", name: "bob", displayName: "bob-p2", presence: "active", selected: false, selectable: true, ready: false, status: "connecting", turn: "stun", turnState: "none", dataState: "connecting", lastError: "", rttMs: 0, localCandidateType: "", remoteCandidateType: "", pathLabel: "—" },
      ],
    }
    const nonEmpty = renderer.render(renderTuiView(state, createNoopTuiActions()))
    expect(nonEmpty.findText("Peers 1/2") === null).toBe(false)

    state.snapshot = { ...state.snapshot, peers: [] }
    const empty = renderer.render(renderTuiView(state, createNoopTuiActions()))
    expect(hasRenderedText(empty, "Waiting for peers in demo...")).toBe(true)
  })

  test("hides the events card by default and shows it when enabled", () => {
    const renderer = createWideRenderer()
    const hidden = renderer.render(renderTuiView(createInitialTuiState({ room: "demo", reconnectSocket: false }, false), createNoopTuiActions()))
    const shown = renderer.render(renderTuiView(createInitialTuiState({ room: "demo", reconnectSocket: false }, true), createNoopTuiActions()))
    expect(hidden.findById("events-card")).toBe(null)
    expect(shown.findById("events-card") === null).toBe(false)
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
})
