import { readFile, writeFile } from "node:fs/promises"

type Replacement = readonly [before: string, after: string]
type FilePatch = { relativeUrl: string; replacements: readonly Replacement[] }

const REZI_FILE_PATCHES: readonly FilePatch[] = [
  {
    relativeUrl: "./layout/kinds/box.js",
    replacements: [
      [
        'import { validateBoxProps } from "../validateProps.js";',
        'import { validateBoxProps } from "../validateProps.js";\nconst OVERFLOW_CONTENT_LIMIT = 2147483647;',
      ],
      [
        'const ch = clampNonNegative(outerHLimit - bt - bb - spacing.top - spacing.bottom);\n            // Children are laid out as a Column inside the content rect.',
        'const ch = clampNonNegative(outerHLimit - bt - bb - spacing.top - spacing.bottom);\n            const flowMeasureH = propsRes.value.overflow === "scroll" ? OVERFLOW_CONTENT_LIMIT : ch;\n            // Children are laid out as a Column inside the content rect.',
      ],
      [
        'const innerRes = measureNode(columnNode, cw, ch, "column");',
        'const innerRes = measureNode(columnNode, cw, flowMeasureH, "column");',
      ],
      [
        'const columnNode = getSyntheticColumn(vnode, propsRes.value.gap);\n                // The synthetic column wrapper must fill the box content rect so that\n                // percentage constraints resolve against the actual available space.\n                const innerRes = layoutNode(columnNode, cx, cy, cw, ch, "column", cw, ch);',
        'const columnNode = getSyntheticColumn(vnode, propsRes.value.gap);\n                const flowMeasureH = propsRes.value.overflow === "scroll" ? OVERFLOW_CONTENT_LIMIT : ch;\n                const flowMeasureRes = measureNode(columnNode, cw, flowMeasureH, "column");\n                if (!flowMeasureRes.ok)\n                    return flowMeasureRes;\n                const flowLayoutH = propsRes.value.overflow === "scroll"\n                    ? Math.max(ch, flowMeasureRes.value.h)\n                    : ch;\n                // The synthetic column wrapper must fill the box content rect so that\n                // percentage constraints resolve against the actual available space.\n                const innerRes = layoutNode(columnNode, cx, cy, cw, flowLayoutH, "column", cw, flowLayoutH, flowMeasureRes.value);',
      ],
    ],
  },
  {
    relativeUrl: "./app/widgetRenderer.js",
    replacements: [
      [
        "    scrollOverrides = new Map();",
        "    scrollOverrides = new Map();\n    hasPendingScrollOverride = false;",
      ],
      [
        "            scrollOverrides: this.scrollOverrides,\n            findScrollableAncestors: (targetId) => this.findScrollableAncestors(targetId),",
        '            scrollOverrides: this.scrollOverrides,\n            markScrollOverrideDirty: () => {\n                this.hasPendingScrollOverride = true;\n            },\n            findScrollableAncestors: (targetId) => this.findScrollableAncestors(targetId),',
      ],
      [
        "        return Object.freeze([]);\n    }\n    applyScrollOverridesToVNode(vnode, overrides = this",
        '        return Object.freeze([]);\n    }\n    syncScrollOverridesFromLayoutTree() {\n        if (!this.committedRoot || !this.layoutTree) {\n            this.scrollOverrides.clear();\n            return;\n        }\n        const nextOverrides = new Map();\n        const stack = [\n            {\n                runtimeNode: this.committedRoot,\n                layoutNode: this.layoutTree,\n            },\n        ];\n        while (stack.length > 0) {\n            const frame = stack.pop();\n            if (!frame)\n                continue;\n            const runtimeNode = frame.runtimeNode;\n            const layoutNode = frame.layoutNode;\n            const props = runtimeNode.vnode.props;\n            const nodeId = typeof props.id === "string" && props.id.length > 0 ? props.id : null;\n            if (nodeId !== null && props.overflow === "scroll" && layoutNode.meta) {\n                const meta = layoutNode.meta;\n                const hasScrollableAxis = meta.contentWidth > meta.viewportWidth || meta.contentHeight > meta.viewportHeight;\n                if (hasScrollableAxis) {\n                    nextOverrides.set(nodeId, Object.freeze({\n                        scrollX: meta.scrollX,\n                        scrollY: meta.scrollY,\n                    }));\n                }\n            }\n            const childCount = Math.min(runtimeNode.children.length, layoutNode.children.length);\n            for (let i = childCount - 1; i >= 0; i--) {\n                const runtimeChild = runtimeNode.children[i];\n                const layoutChild = layoutNode.children[i];\n                if (!runtimeChild || !layoutChild)\n                    continue;\n                stack.push({\n                    runtimeNode: runtimeChild,\n                    layoutNode: layoutChild,\n                });\n            }\n        }\n        this.scrollOverrides.clear();\n        for (const [nodeId, override] of nextOverrides) {\n            this.scrollOverrides.set(nodeId, override);\n        }\n    }\n    applyScrollOverridesToVNode(vnode, overrides = this',
      ],
      [
        "        if (override) {",
        '        if (override && propsForRead.overflow === "scroll") {',
      ],
      [
        "            if (this.scrollOverrides.size > 0)",
        "            if (this.hasPendingScrollOverride)",
      ],
      [
        "                this.scrollOverrides.clear();",
        "                this.hasPendingScrollOverride = false;",
      ],
      [
        "                this.layoutTree = nextLayoutTree;",
        "                this.layoutTree = nextLayoutTree;\n                this.syncScrollOverridesFromLayoutTree();",
      ],
    ],
  },
  {
    relativeUrl: "./app/widgetRenderer/mouseRouting.js",
    replacements: [[
      "            ctx.scrollOverrides.set(nodeId, {\n                scrollX: r.nextScrollX ?? meta.scrollX,\n                scrollY: r.nextScrollY ?? meta.scrollY,\n            });\n            return ROUTE_RENDER;",
      '            ctx.scrollOverrides.set(nodeId, {\n                scrollX: r.nextScrollX ?? meta.scrollX,\n                scrollY: r.nextScrollY ?? meta.scrollY,\n            });\n            ctx.markScrollOverrideDirty?.();\n            return ROUTE_RENDER;',
    ]],
  },
] as const

let patchedRoots: Set<string> | null = null

const applyFilePatch = async (baseUrl: string, patch: FilePatch) => {
  const fileUrl = new URL(patch.relativeUrl, baseUrl)
  const source = await readFile(fileUrl, "utf8")
  let next = source
  for (const [before, after] of patch.replacements) {
    if (next.includes(after)) continue
    if (!next.includes(before)) throw new Error(`Unsupported @rezi-ui/core runtime patch target at ${fileUrl.href}`)
    next = next.replace(before, after)
  }
  if (next !== source) await writeFile(fileUrl, next)
}

export const ensureReziFilePatches = async () => {
  const baseUrl = await import.meta.resolve("@rezi-ui/core")
  patchedRoots ??= new Set<string>()
  if (patchedRoots.has(baseUrl)) return
  for (const patch of REZI_FILE_PATCHES) await applyFilePatch(baseUrl, patch)
  patchedRoots.add(baseUrl)
}
