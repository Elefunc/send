import { describe, expect, test } from "bun:test"
import { cleanName, cleanRoom, displayPeerName, peerDefaultsToken } from "../src/core/protocol"

describe("protocol cleaners", () => {
  test("cleanRoom normalizes room ids", () => {
    expect(cleanRoom(" Hello Send Room! ")).toBe("hello-send-room")
  })

  test("cleanName strips to compact id-safe values", () => {
    expect(cleanName(" Alice Cooper ")).toBe("alicecooper")
  })

  test("displayPeerName keeps browser-compatible suffix form", () => {
    expect(displayPeerName("Alice", "abc123")).toBe("alice-abc123")
  })

  test("peerDefaultsToken encodes accept/save defaults with per-letter case", () => {
    expect(peerDefaultsToken({ defaults: { autoAcceptIncoming: true, autoSaveIncoming: true } })).toBe("AS")
    expect(peerDefaultsToken({ defaults: { autoAcceptIncoming: true, autoSaveIncoming: false } })).toBe("As")
    expect(peerDefaultsToken({ defaults: { autoAcceptIncoming: false, autoSaveIncoming: true } })).toBe("aS")
    expect(peerDefaultsToken({ defaults: { autoAcceptIncoming: false, autoSaveIncoming: false } })).toBe("as")
    expect(peerDefaultsToken()).toBe("??")
  })
})
