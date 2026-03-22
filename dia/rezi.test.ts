import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fixReziDiagram, formatReziDiagnostics, validateCommittedReziContent, validateReziDiagram } from "./rezi-diagram"

const fixture = (text: string) => {
  const lines = text
    .replace(/\r\n/g, "\n")
    .replace(/^\s*\n/u, "")
    .replace(/\n\s*$/u, "")
    .split("\n")
  const margin = Math.min(...lines.filter(line => line.trim()).map(line => line.match(/^ */u)?.[0].length ?? 0))
  return lines.map(line => line.slice(margin)).join("\n")
}

describe("rezi diagram validator", () => {
  test("accepts a valid nested rectangle layout", () => {
    const diagram = fixture(`
      ┌──────────┐
      │ outer    │
      │ ┌──────┐ │
      │ │ in   │ │
      │ └──────┘ │
      └──────────┘
    `)
    expect(validateReziDiagram(diagram).diagnostics).toEqual([])
  })

  test("reports drifting right borders on interior lines", () => {
    const diagram = fixture(`
      ┌──────────┐
      │ outer    │
      │ bad
      └──────────┘
    `)
    const { diagnostics } = validateReziDiagram(diagram)
    expect(diagnostics.length > 0).toBe(true)
    expect(formatReziDiagnostics(diagnostics)).toContain("expected │ at border column")
  })

  test("reports a bottom border that closes at the wrong columns", () => {
    const diagram = fixture(`
      ┌──────┐
      │ outer│
      └─────┘
    `)
    const { diagnostics } = validateReziDiagram(diagram)
    expect(diagnostics.length > 0).toBe(true)
    expect(formatReziDiagnostics(diagnostics)).toContain("top border has no matching bottom border")
  })

  test("accepts sibling boxes on the same row", () => {
    const diagram = fixture(`
      ┌───────────────┐
      │ ┌───┐ ┌───┐   │
      │ │ a │ │ b │   │
      │ └───┘ └───┘   │
      └───────────────┘
    `)
    expect(validateReziDiagram(diagram).diagnostics).toEqual([])
  })

  test("auto-fixes drifting borders deterministically", () => {
    const drifting = fixture(`
      ┌──────────┐
      │ outer    │
      │ bad
      └──────────┘
    `)
    expect(fixReziDiagram(drifting)).toBe([
      "┌──────────┐",
      "│ outer    │",
      "│ bad      │",
      "└──────────┘",
    ].join("\n"))
  })

  test("the committed rezi.txt is valid and already fixed", () => {
    const reziPath = new URL("./rezi.txt", import.meta.url)
    const rezi = readFileSync(reziPath, "utf8")
    expect(validateReziDiagram(rezi).diagnostics).toEqual([])
    expect(validateCommittedReziContent(rezi)).toEqual([])
    expect(fixReziDiagram(rezi)).toBe(rezi)
  })
})
