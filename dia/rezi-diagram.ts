export type ReziDiagnostic = { line: number; column: number; message: string }
export type ReziRect = { left: number; right: number; top: number; bottom: number }

type ReziSegment = { left: number; right: number; line: number }

const boxChars = new Set(["┌", "┐", "└", "┘", "│", "─"])

const splitLines = (text: string) => text.replace(/\r\n/g, "\n").split("\n")

const padRight = (value: string, width: number) => value.length >= width ? value : `${value}${" ".repeat(width - value.length)}`

const collectSegments = (line: string, open: string, close: string, lineNumber: number) => {
  const segments: ReziSegment[] = []
  const diagnostics: ReziDiagnostic[] = []
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] !== open) continue
    const closeIndex = line.indexOf(close, index + 1)
    if (closeIndex < 0) {
      diagnostics.push({ line: lineNumber, column: index + 1, message: `unclosed ${open}${close} border segment` })
      continue
    }
    segments.push({ left: index + 1, right: closeIndex + 1, line: lineNumber })
    index = closeIndex
  }
  return { segments, diagnostics }
}

const overlapsRows = (left: ReziRect, right: ReziRect) => !(left.bottom < right.top || right.bottom < left.top)
const overlapsCols = (left: ReziRect, right: ReziRect) => !(left.right < right.left || right.right < left.left)
const containsRect = (outer: ReziRect, inner: ReziRect) =>
  outer.top < inner.top && outer.bottom > inner.bottom && outer.left < inner.left && outer.right > inner.right

const keyOf = (rect: Pick<ReziRect, "left" | "right">) => `${rect.left}:${rect.right}`

const setExpected = (
  expected: Map<number, Map<number, string>>,
  diagnostics: ReziDiagnostic[],
  line: number,
  column: number,
  value: string,
  message: string,
) => {
  const row = expected.get(line) ?? new Map<number, string>()
  const present = row.get(column)
  if (present && present !== value) diagnostics.push({ line, column, message })
  row.set(column, value)
  expected.set(line, row)
}

const parseRectangles = (lines: string[]) => {
  const diagnostics: ReziDiagnostic[] = []
  const rectangles: ReziRect[] = []
  const open = new Map<string, ReziRect[]>()

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1
    const { segments: tops, diagnostics: topDiagnostics } = collectSegments(lines[index], "┌", "┐", lineNumber)
    const { segments: bottoms, diagnostics: bottomDiagnostics } = collectSegments(lines[index], "└", "┘", lineNumber)
    diagnostics.push(...topDiagnostics, ...bottomDiagnostics)

    for (const top of tops) {
      const stack = open.get(keyOf(top)) ?? []
      stack.push({ left: top.left, right: top.right, top: top.line, bottom: -1 })
      open.set(keyOf(top), stack)
    }

    for (const bottom of bottoms) {
      const stack = open.get(keyOf(bottom))
      const rect = stack?.pop()
      if (!rect) {
        diagnostics.push({ line: bottom.line, column: bottom.left, message: "bottom border has no matching top border" })
        continue
      }
      rectangles.push({ ...rect, bottom: bottom.line })
      if (!stack?.length) open.delete(keyOf(bottom))
    }
  }

  for (const stack of open.values()) {
    for (const rect of stack) diagnostics.push({ line: rect.top, column: rect.left, message: "top border has no matching bottom border" })
  }

  rectangles.sort((left, right) => left.top - right.top || left.left - right.left || left.bottom - right.bottom || left.right - right.right)

  return { rectangles, diagnostics }
}

const findOuterRect = (rectangles: ReziRect[]) =>
  [...rectangles].sort((left, right) => left.top - right.top || left.left - right.left || (right.right - right.left) - (left.right - left.left))[0]

const buildExpectedGrid = (rectangles: ReziRect[]) => {
  const diagnostics: ReziDiagnostic[] = []
  const expected = new Map<number, Map<number, string>>()

  for (const rect of rectangles) {
    setExpected(expected, diagnostics, rect.top, rect.left, "┌", "conflicting border corner")
    setExpected(expected, diagnostics, rect.top, rect.right, "┐", "conflicting border corner")
    setExpected(expected, diagnostics, rect.bottom, rect.left, "└", "conflicting border corner")
    setExpected(expected, diagnostics, rect.bottom, rect.right, "┘", "conflicting border corner")

    for (let column = rect.left + 1; column < rect.right; column += 1) {
      setExpected(expected, diagnostics, rect.top, column, "─", "conflicting top border")
      setExpected(expected, diagnostics, rect.bottom, column, "─", "conflicting bottom border")
    }

    for (let line = rect.top + 1; line < rect.bottom; line += 1) {
      setExpected(expected, diagnostics, line, rect.left, "│", "conflicting vertical border")
      setExpected(expected, diagnostics, line, rect.right, "│", "conflicting vertical border")
    }
  }

  return { expected, diagnostics }
}

const validateRectangles = (rectangles: ReziRect[]) => {
  const diagnostics: ReziDiagnostic[] = []
  for (const rect of rectangles) {
    if (rect.right <= rect.left + 1) diagnostics.push({ line: rect.top, column: rect.left, message: "rectangle width must be at least 2 columns" })
    if (rect.bottom <= rect.top + 1) diagnostics.push({ line: rect.top, column: rect.left, message: "rectangle height must be at least 2 rows" })
  }

  for (let index = 0; index < rectangles.length; index += 1) {
    for (let innerIndex = index + 1; innerIndex < rectangles.length; innerIndex += 1) {
      const left = rectangles[index]
      const right = rectangles[innerIndex]
      if (!overlapsRows(left, right) || !overlapsCols(left, right)) continue
      if (containsRect(left, right) || containsRect(right, left)) continue
      diagnostics.push({
        line: right.top,
        column: right.left,
        message: `rectangle ${right.top}:${right.left}-${right.bottom}:${right.right} partially overlaps ${left.top}:${left.left}-${left.bottom}:${left.right}`,
      })
    }
  }
  return diagnostics
}

export const validateReziDiagram = (text: string) => {
  const lines = splitLines(text)
  const { rectangles, diagnostics: parseDiagnostics } = parseRectangles(lines)
  const diagnostics = [...parseDiagnostics, ...validateRectangles(rectangles)]
  const outer = findOuterRect(rectangles)
  if (!outer) {
    diagnostics.push({ line: 1, column: 1, message: "no rectangles found" })
    return { diagnostics, rectangles, outer: null, width: 0 }
  }

  const width = outer.right
  const { expected, diagnostics: expectedDiagnostics } = buildExpectedGrid(rectangles)
  diagnostics.push(...expectedDiagnostics)

  for (let lineNumber = outer.top; lineNumber <= outer.bottom; lineNumber += 1) {
    const line = lines[lineNumber - 1] ?? ""
    if (line.length > width && line.slice(width).trim()) diagnostics.push({ line: lineNumber, column: width + 1, message: "content extends beyond outer ui.page border" })

    const row = expected.get(lineNumber) ?? new Map<number, string>()
    for (const [column, value] of row) {
      if ((line[column - 1] ?? " ") !== value) diagnostics.push({ line: lineNumber, column, message: `expected ${value} at border column` })
    }

    for (let column = 1; column <= Math.min(line.length, width); column += 1) {
      const value = line[column - 1]
      if (boxChars.has(value) && row.get(column) !== value) diagnostics.push({ line: lineNumber, column, message: `stray border character ${value}` })
    }
  }

  return { diagnostics, rectangles, outer, width }
}

export const formatReziDiagnostics = (diagnostics: readonly ReziDiagnostic[]) =>
  diagnostics.map(diagnostic => `L${diagnostic.line}:C${diagnostic.column} ${diagnostic.message}`).join("\n")

const committedRequiredFragments = [
  "main-scroll: ui.box(scroll)",
  "events-shell?: ui.box",
  "events-card: denseSection",
  "ui.button clear",
  "ui.button hide",
  "ui.column(log-row*)",
  "OR ui.empty",
  "ui.box → ui.column(ui.text + tightTag[b]) × 3",
  "draft-preview?: denseSection",
  "ui.text #draft-preview-status",
  "ui.text #draft-preview-error",
  "ui.column(file-preview-row*)",
  "Total?: denseSection → ui.row(tightTag[b]*)",
  "ui.row(tightTag[b]*)",
  "transfer-row*: denseSection",
  "ui.row(tightTag[b] status, tightTag[b] error?)",
  "ui.row(fact-box*)",
  "ui.progress",
  "ui.box(t-border) → ui.checkbox",
  "ui.box(t-border) → ui.row(tightTag[b] + tightTag[b])",
  "ui.row(metric-row-1): ui.box → ui.column(...) × 2",
  "ui.row(metric-row-2): ui.box → ui.column(...) × 2",
  "ui.column(profile lines): ui.text × 4",
]

const committedForbiddenPatterns = [
  /\bvents-shell\?: ui\.box/u,
  /\bvents-card: denseSection/u,
  /(^|[^u])i\.text title/u,
  /(^|[^u])i\.button clear/u,
  /(^|[^u])i\.button hide/u,
  /O│ ui\.empty/u,
  /│ransfer-row\*: denseSection/u,
  /(^|[^u])i\.row\(tightTag\[b\] status, tightTag\[b\] error\?\)/u,
  /(^|[^u])i\.row\(fact-box\*\)/u,
  /(^|[^u])i\.progress/u,
  /(^|[^u])i\.callout\?/u,
  /ui\.text×4/u,
  /ui\.box → ui\.column\(ui\.text \+ ui\.tag\) × 3/u,
  /Total\?: denseSection → ui\.row\(ui\.tag\*\)/u,
  /ui\.row\(ui\.tag\*\)/u,
  /ui\.row\(ui\.tag status, ui\.tag error\?\)/u,
  /ui\.checkbox\s+ui\.box\(border\) → ui\.row\(\.\.\.\)\s+ui\.tag/u,
  /ui\.row\(metrics\): ui\.box → ui\.column\(\.\.\.\) × 4/u,
]

export const validateCommittedReziContent = (text: string) => {
  const diagnostics: ReziDiagnostic[] = []
  const lines = splitLines(text)

  for (const fragment of committedRequiredFragments) {
    if (text.includes(fragment)) continue
    diagnostics.push({ line: 1, column: 1, message: `missing required content: ${fragment}` })
  }

  for (const pattern of committedForbiddenPatterns) {
    for (let index = 0; index < lines.length; index += 1) {
      const match = lines[index].match(pattern)
      if (!match?.index && match?.index !== 0) continue
      diagnostics.push({ line: index + 1, column: match.index + 1, message: `broken content fragment: ${match[0]}` })
      break
    }
  }

  return diagnostics
}

export const fixReziDiagram = (text: string) => {
  const lines = splitLines(text)
  const { rectangles, diagnostics: parseDiagnostics } = parseRectangles(lines)
  if (parseDiagnostics.length) throw new Error(formatReziDiagnostics(parseDiagnostics))

  const outer = findOuterRect(rectangles)
  if (!outer) throw new Error("No rectangles found in rezi diagram.")

  const overlapDiagnostics = validateRectangles(rectangles)
  if (overlapDiagnostics.length) throw new Error(formatReziDiagnostics(overlapDiagnostics))

  const width = outer.right
  for (let lineNumber = outer.top; lineNumber <= outer.bottom; lineNumber += 1) {
    const line = lines[lineNumber - 1] ?? ""
    if (line.length > width && line.slice(width).trim()) throw new Error(`L${lineNumber}:C${width + 1} content extends beyond outer ui.page border`)
  }

  const { expected, diagnostics: expectedDiagnostics } = buildExpectedGrid(rectangles)
  if (expectedDiagnostics.length) throw new Error(formatReziDiagnostics(expectedDiagnostics))

  for (let lineNumber = outer.top; lineNumber <= outer.bottom; lineNumber += 1) {
    const padded = padRight(lines[lineNumber - 1] ?? "", width).slice(0, width).split("")
    const row = expected.get(lineNumber) ?? new Map<number, string>()

    for (let column = 1; column <= width; column += 1) {
      if (boxChars.has(padded[column - 1]) && !row.has(column)) padded[column - 1] = " "
    }

    for (const [column, value] of row) padded[column - 1] = value
    lines[lineNumber - 1] = padded.join("").replace(/\s+$/u, "")
  }

  return lines.join("\n")
}
