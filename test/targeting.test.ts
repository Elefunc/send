import { describe, expect, test } from "bun:test"
import { resolvePeerTargets } from "../src/core/targeting"

const peers = [
  { id: "a1", name: "alice", ready: true, presence: "active" as const },
  { id: "b2", name: "bob", ready: true, presence: "active" as const },
  { id: "c3", name: "carol", ready: false, presence: "active" as const },
]

describe("resolvePeerTargets", () => {
  test("selects all ready peers for the broadcast selector", () => {
    const result = resolvePeerTargets(peers, ["."])
    expect(result.ok).toBe(true)
    expect(result.peers.map(peer => peer.id)).toEqual(["a1", "b2"])
  })

  test("matches name-suffix selectors", () => {
    const result = resolvePeerTargets(peers, ["alice-a1"])
    expect(result.ok).toBe(true)
    expect(result.peers.map(peer => peer.id)).toEqual(["a1"])
  })

  test("rejects mixing the broadcast selector with specific peers", () => {
    const result = resolvePeerTargets(peers, [".", "alice-a1"])
    expect(result.ok).toBe(false)
    expect(result.error).toContain("broadcast selector")
  })

  test("reports when no ready peers are available for broadcast", () => {
    const result = resolvePeerTargets([{ id: "c3", name: "carol", ready: false, presence: "active" as const }], ["."])
    expect(result.ok).toBe(false)
    expect(result.error).toBe("no ready peers")
  })
})
