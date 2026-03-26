import { describe, expect, test } from "bun:test"

import { applyInputEditEvent, normalizeInputCursor } from "../src/tui/input-editor"

const key = (overrides: Partial<Extract<import("@rezi-ui/core").ZrevEvent, { kind: "key" }>> = {}): Extract<import("@rezi-ui/core").ZrevEvent, { kind: "key" }> => ({
  kind: "key",
  timeMs: 0,
  key: 0,
  mods: 0,
  action: "down",
  ...overrides,
})

describe("input-editor", () => {
  test("normalizes cursor to grapheme boundaries", () => {
    expect(normalizeInputCursor("A👨‍👩‍👧‍👦B", 2)).toBe(1)
    expect(normalizeInputCursor("A👨‍👩‍👧‍👦B", 20)).toBe("A👨‍👩‍👧‍👦B".length)
  })

  test("moves by grapheme boundaries on arrow keys", () => {
    const value = "A👨‍👩‍👧‍👦B"
    const moveRight = applyInputEditEvent(key({ key: 23 }), { id: "field", value, cursor: 1, selectionStart: null, selectionEnd: null, multiline: false })
    const moveLeft = applyInputEditEvent(key({ key: 22 }), { id: "field", value, cursor: value.length - 1, selectionStart: null, selectionEnd: null, multiline: false })
    expect(moveRight?.nextCursor).toBe(value.length - 1)
    expect(moveLeft?.nextCursor).toBe(1)
  })

  test("strips line breaks from single-line paste", () => {
    const pasted = applyInputEditEvent(
      { kind: "paste", timeMs: 0, bytes: new TextEncoder().encode("foo\r\nbar\nbaz") },
      { id: "field", value: ">", cursor: 1, selectionStart: null, selectionEnd: null, multiline: false },
    )
    expect(pasted?.nextValue).toBe(">foobarbaz")
    expect(pasted?.action?.value).toBe(">foobarbaz")
  })

  test("moves by word on ctrl+left and ctrl+right", () => {
    const value = "src/my file.ts"
    const moveRight = applyInputEditEvent(key({ key: 23, mods: 1 << 1 }), { id: "field", value, cursor: 0, selectionStart: null, selectionEnd: null, multiline: false })
    const moveLeft = applyInputEditEvent(key({ key: 22, mods: 1 << 1 }), { id: "field", value, cursor: value.length, selectionStart: null, selectionEnd: null, multiline: false })
    expect(moveRight?.nextCursor).toBe(3)
    expect(moveLeft?.nextCursor).toBe(12)
  })
})
