import { describe, expect, test } from "bun:test"
import { cleanName, cleanRoom, displayPeerName, peerDefaultsToken, SIGNAL_PULSE_URL, signalSocketUrl } from "../src/core/protocol"

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

  test("peerDefaultsToken encodes accept/save defaults, streaming capability, and overwrite state", () => {
    expect(peerDefaultsToken({ defaults: { autoAcceptIncoming: true, autoSaveIncoming: true }, streamingSaveIncoming: true })).toBe("AX")
    expect(peerDefaultsToken({ defaults: { autoAcceptIncoming: false, autoSaveIncoming: true }, streamingSaveIncoming: true })).toBe("aX")
    expect(peerDefaultsToken({ defaults: { autoAcceptIncoming: true, autoSaveIncoming: true, overwriteIncoming: true }, streamingSaveIncoming: true })).toBe("AW")
    expect(peerDefaultsToken({ defaults: { autoAcceptIncoming: false, autoSaveIncoming: true, overwriteIncoming: true }, streamingSaveIncoming: true })).toBe("aW")
    expect(peerDefaultsToken({ defaults: { autoAcceptIncoming: true, autoSaveIncoming: true }, streamingSaveIncoming: false })).toBe("AS")
    expect(peerDefaultsToken({ defaults: { autoAcceptIncoming: false, autoSaveIncoming: true } })).toBe("aS")
    expect(peerDefaultsToken({ defaults: { autoAcceptIncoming: true, autoSaveIncoming: true, overwriteIncoming: true }, streamingSaveIncoming: false })).toBe("AS")
    expect(peerDefaultsToken({ defaults: { autoAcceptIncoming: true, autoSaveIncoming: false }, streamingSaveIncoming: true })).toBe("As")
    expect(peerDefaultsToken({ defaults: { autoAcceptIncoming: true, autoSaveIncoming: false, overwriteIncoming: true }, streamingSaveIncoming: true })).toBe("As")
    expect(peerDefaultsToken({ defaults: { autoAcceptIncoming: false, autoSaveIncoming: false } })).toBe("as")
    expect(peerDefaultsToken()).toBe("??")
  })

  test("signal URLs always include the send app query", () => {
    expect(SIGNAL_PULSE_URL).toBe("https://sig.efn.kr/pulse?app=send")
    expect(signalSocketUrl("demo room")).toBe("wss://sig.efn.kr/ws?i=demo+room&app=send")
  })
})
