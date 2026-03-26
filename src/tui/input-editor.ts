import type { ZrevEvent } from "@rezi-ui/core"

const ZR_KEY_LEFT = 22
const ZR_KEY_RIGHT = 23
const ZR_KEY_UP = 20
const ZR_KEY_DOWN = 21
const ZR_KEY_HOME = 12
const ZR_KEY_END = 13
const ZR_KEY_ENTER = 2
const ZR_KEY_A = 65
const ZR_KEY_BACKSPACE = 4
const ZR_KEY_DELETE = 11
const ZR_MOD_SHIFT = 1 << 0
const ZR_MOD_CTRL = 1 << 1

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
const wordClusterRe = /[\p{L}\p{N}_]/u
const spaceClusterRe = /\s/u
const utf8Decoder = new TextDecoder("utf-8", { fatal: false })

type InputSelection = Readonly<{ start: number; end: number }>

export type InputEditAction = Readonly<{
  id: string
  action: "input"
  value: string
  cursor: number
}>

export type InputEditResult = Readonly<{
  nextValue: string
  nextCursor: number
  nextSelectionStart: number | null
  nextSelectionEnd: number | null
  action?: InputEditAction
}>

type InputEditorContext = Readonly<{
  id: string
  value: string
  cursor: number
  selectionStart?: number | null
  selectionEnd?: number | null
  multiline?: boolean
}>

type Grapheme = Readonly<{
  text: string
  start: number
  end: number
}>

const graphemesOf = (value: string): Grapheme[] => {
  const graphemes: Grapheme[] = []
  for (const { index, segment } of graphemeSegmenter.segment(value)) {
    graphemes.push({ text: segment, start: index, end: index + segment.length })
  }
  return graphemes
}

const clampCursor = (value: string, cursor: number) =>
  !Number.isFinite(cursor) ? 0 : Math.max(0, Math.min(value.length, Math.trunc(cursor)))

export const normalizeInputCursor = (value: string, cursor: number) => {
  const clamped = clampCursor(value, cursor)
  if (clamped === 0 || clamped === value.length) return clamped
  let last = 0
  for (const grapheme of graphemesOf(value)) {
    if (grapheme.end === clamped) return clamped
    if (grapheme.end > clamped) return last
    last = grapheme.end
  }
  return value.length
}

const normalizeInputCursorForward = (value: string, cursor: number) => {
  const clamped = clampCursor(value, cursor)
  if (clamped === 0 || clamped === value.length) return clamped
  for (const grapheme of graphemesOf(value)) {
    if (grapheme.end >= clamped) return grapheme.end
  }
  return value.length
}

export const normalizeInputSelection = (value: string, selectionStart: number | null | undefined, selectionEnd: number | null | undefined): InputSelection | null => {
  if (selectionStart == null || selectionEnd == null) return null
  const start = normalizeInputCursor(value, selectionStart)
  const end = normalizeInputCursor(value, selectionEnd)
  return start === end ? null : { start, end }
}

export const getInputSelectionText = (value: string, selectionStart: number | null | undefined, selectionEnd: number | null | undefined) => {
  const selection = normalizeInputSelection(value, selectionStart, selectionEnd)
  if (!selection) return null
  const [start, end] = selection.start <= selection.end ? [selection.start, selection.end] : [selection.end, selection.start]
  return start < end ? value.slice(start, end) : null
}

const normalizeSelectionRange = (selection: InputSelection) =>
  selection.start <= selection.end ? [selection.start, selection.end] as const : [selection.end, selection.start] as const

const resolveSelectionAnchor = (selection: InputSelection, cursor: number) =>
  cursor === selection.start ? selection.end : cursor === selection.end ? selection.start : selection.start

const prevBoundary = (value: string, cursor: number) => {
  const normalized = normalizeInputCursor(value, cursor)
  if (normalized <= 0) return 0
  let last = 0
  for (const grapheme of graphemesOf(value)) {
    if (grapheme.end >= normalized) return last
    last = grapheme.end
  }
  return last
}

const nextBoundary = (value: string, cursor: number) => {
  const normalized = normalizeInputCursor(value, cursor)
  if (normalized >= value.length) return value.length
  for (const grapheme of graphemesOf(value)) {
    if (grapheme.end > normalized) return grapheme.end
  }
  return value.length
}

const classifyCluster = (cluster: string) =>
  cluster.length === 0 ? "other"
  : wordClusterRe.test(cluster) ? "word"
  : spaceClusterRe.test(cluster) ? "space"
  : "other"

const nextWordBoundary = (value: string, cursor: number) => {
  if (cursor >= value.length) return value.length
  const graphemes = graphemesOf(value)
  let index = graphemes.findIndex(grapheme => grapheme.end > cursor)
  if (index < 0) return value.length
  if (classifyCluster(graphemes[index]!.text) === "word") {
    while (index < graphemes.length && classifyCluster(graphemes[index]!.text) === "word") index += 1
    return index < graphemes.length ? graphemes[index]!.start : value.length
  }
  while (index < graphemes.length && classifyCluster(graphemes[index]!.text) !== "word") index += 1
  while (index < graphemes.length && classifyCluster(graphemes[index]!.text) === "word") index += 1
  return index < graphemes.length ? graphemes[index]!.start : value.length
}

const prevWordBoundary = (value: string, cursor: number) => {
  if (cursor <= 0) return 0
  const graphemes = graphemesOf(value)
  const clamped = clampCursor(value, cursor)
  let previousClass: "word" | "space" | "other" | null = null
  let currentWordRunStart = 0
  let lastCompletedWordRunStart = -1
  for (const grapheme of graphemes) {
    if (grapheme.end > clamped) break
    const clusterClass = classifyCluster(grapheme.text)
    if (clusterClass === "word") {
      if (previousClass !== "word") currentWordRunStart = grapheme.start
    } else if (previousClass === "word") {
      lastCompletedWordRunStart = currentWordRunStart
    }
    previousClass = clusterClass
    if (grapheme.end === clamped) break
  }
  return previousClass === "word" ? currentWordRunStart : lastCompletedWordRunStart >= 0 ? lastCompletedWordRunStart : 0
}

const asUnicodeScalarString = (codepoint: number) => {
  if (!Number.isFinite(codepoint)) return "\ufffd"
  const scalar = Math.trunc(codepoint)
  return scalar < 0 || scalar > 0x10ffff || scalar >= 0xd800 && scalar <= 0xdfff ? "\ufffd" : String.fromCodePoint(scalar)
}

const removeCrLf = (value: string) => value.replaceAll(/[\r\n]/g, "")

const normalizeLineBreaks = (value: string) => value.replaceAll(/\r\n?/g, "\n")

export const applyInputEditEvent = (event: ZrevEvent, ctx: InputEditorContext): InputEditResult | null => {
  const { id, value } = ctx
  const multiline = ctx.multiline === true
  const selection = normalizeInputSelection(value, ctx.selectionStart, ctx.selectionEnd)
  const cursor = normalizeInputCursor(value, ctx.cursor)
  const [selectionMin, selectionMax] = selection ? normalizeSelectionRange(selection) : [cursor, cursor]

  const result = (nextValue: string, nextCursor: number, nextSelectionStart: number | null, nextSelectionEnd: number | null): InputEditResult =>
    nextValue === value
      ? { nextValue, nextCursor, nextSelectionStart, nextSelectionEnd }
      : { nextValue, nextCursor, nextSelectionStart, nextSelectionEnd, action: { id, action: "input", value: nextValue, cursor: nextCursor } }

  if (event.kind === "key") {
    if (event.action !== "down" && event.action !== "repeat") return null
    const hasShift = (event.mods & ZR_MOD_SHIFT) !== 0
    const hasCtrl = (event.mods & ZR_MOD_CTRL) !== 0
    if (event.key === ZR_KEY_A && hasCtrl && !hasShift) {
      return value.length === 0
        ? { nextValue: value, nextCursor: 0, nextSelectionStart: null, nextSelectionEnd: null }
        : { nextValue: value, nextCursor: value.length, nextSelectionStart: 0, nextSelectionEnd: value.length }
    }
    if (event.key === ZR_KEY_LEFT || event.key === ZR_KEY_RIGHT || event.key === ZR_KEY_HOME || event.key === ZR_KEY_END || event.key === ZR_KEY_UP || event.key === ZR_KEY_DOWN) {
      if (event.key === ZR_KEY_UP || event.key === ZR_KEY_DOWN) return multiline ? { nextValue: value, nextCursor: cursor, nextSelectionStart: null, nextSelectionEnd: null } : null
      const moveCursor = (active: number) =>
        event.key === ZR_KEY_LEFT ? hasCtrl ? prevWordBoundary(value, active) : prevBoundary(value, active)
        : event.key === ZR_KEY_RIGHT ? hasCtrl ? nextWordBoundary(value, active) : nextBoundary(value, active)
        : event.key === ZR_KEY_HOME ? 0
        : value.length
      if (hasShift) {
        const anchor = selection ? resolveSelectionAnchor(selection, cursor) : cursor
        const moved = moveCursor(cursor)
        return moved === anchor
          ? { nextValue: value, nextCursor: moved, nextSelectionStart: null, nextSelectionEnd: null }
          : { nextValue: value, nextCursor: moved, nextSelectionStart: anchor, nextSelectionEnd: moved }
      }
      if (selection) {
        const collapsed = event.key === ZR_KEY_LEFT || event.key === ZR_KEY_HOME ? selectionMin : selectionMax
        return { nextValue: value, nextCursor: collapsed, nextSelectionStart: null, nextSelectionEnd: null }
      }
      return { nextValue: value, nextCursor: moveCursor(cursor), nextSelectionStart: null, nextSelectionEnd: null }
    }
    if (event.key === ZR_KEY_BACKSPACE) {
      if (selection) {
        const nextValue = value.slice(0, selectionMin) + value.slice(selectionMax)
        const nextCursor = normalizeInputCursor(nextValue, selectionMin)
        return result(nextValue, nextCursor, null, null)
      }
      if (cursor === 0) return { nextValue: value, nextCursor: cursor, nextSelectionStart: null, nextSelectionEnd: null }
      const start = prevBoundary(value, cursor)
      const nextValue = value.slice(0, start) + value.slice(cursor)
      return result(nextValue, normalizeInputCursor(nextValue, start), null, null)
    }
    if (event.key === ZR_KEY_DELETE) {
      if (selection) {
        const nextValue = value.slice(0, selectionMin) + value.slice(selectionMax)
        const nextCursor = normalizeInputCursor(nextValue, selectionMin)
        return result(nextValue, nextCursor, null, null)
      }
      if (cursor === value.length) return { nextValue: value, nextCursor: cursor, nextSelectionStart: null, nextSelectionEnd: null }
      const end = nextBoundary(value, cursor)
      const nextValue = value.slice(0, cursor) + value.slice(end)
      return result(nextValue, normalizeInputCursor(nextValue, cursor), null, null)
    }
    if (event.key === ZR_KEY_ENTER && multiline) {
      const nextValue = `${value.slice(0, selectionMin)}\n${value.slice(selectionMax)}`
      return result(nextValue, normalizeInputCursorForward(nextValue, selectionMin + 1), null, null)
    }
    return null
  }

  if (event.kind === "text") {
    let inserted = asUnicodeScalarString(event.codepoint)
    if ((inserted === "\n" || inserted === "\r") && !multiline) return null
    if (inserted === "\n" || inserted === "\r") inserted = "\n"
    const nextValue = value.slice(0, selectionMin) + inserted + value.slice(selectionMax)
    return result(nextValue, normalizeInputCursorForward(nextValue, selectionMin + inserted.length), null, null)
  }

  if (event.kind === "paste") {
    const inserted = multiline ? normalizeLineBreaks(utf8Decoder.decode(event.bytes)) : removeCrLf(utf8Decoder.decode(event.bytes))
    if (!inserted) return null
    const nextValue = value.slice(0, selectionMin) + inserted + value.slice(selectionMax)
    return result(nextValue, normalizeInputCursorForward(nextValue, selectionMin + inserted.length), null, null)
  }

  return null
}
