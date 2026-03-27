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

  test("matches exact-name selectors", () => {
    const result = resolvePeerTargets(peers, ["alice"])
    expect(result.ok).toBe(true)
    expect(result.peers.map(peer => peer.id)).toEqual(["a1"])
  })

  test("matches all peers with the same exact name", () => {
    const result = resolvePeerTargets([
      { id: "a1", name: "alice", ready: true, presence: "active" as const },
      { id: "a2", name: "alice", ready: true, presence: "active" as const },
      { id: "b2", name: "bob", ready: true, presence: "active" as const },
    ], ["alice"])
    expect(result.ok).toBe(true)
    expect(result.peers.map(peer => peer.id)).toEqual(["a1", "a2"])
  })

  test("matches name-id selectors by id and ignores the name prefix", () => {
    const result = resolvePeerTargets(peers, ["wrong-a1"])
    expect(result.ok).toBe(true)
    expect(result.peers.map(peer => peer.id)).toEqual(["a1"])
  })

  test("matches -id selectors by id", () => {
    const result = resolvePeerTargets(peers, ["-a1"])
    expect(result.ok).toBe(true)
    expect(result.peers.map(peer => peer.id)).toEqual(["a1"])
  })

  test("does not treat bare ids as id selectors", () => {
    const result = resolvePeerTargets(peers, ["a1"])
    expect(result.ok).toBe(false)
    expect(result.error).toBe("no matching peer for a1")
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

  test("reports not-ready peers matched by exact name", () => {
    const result = resolvePeerTargets([
      { id: "a1", name: "alice", ready: true, presence: "active" as const },
      { id: "a2", name: "alice", ready: false, presence: "active" as const },
    ], ["alice"])
    expect(result.ok).toBe(false)
    expect(result.error).toBe("peer not ready: alice-a2")
  })
})
