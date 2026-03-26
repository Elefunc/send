import { describe, expect, test } from "bun:test"
import { cpSync, lstatSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

const walkTsFiles = (root: string): string[] =>
  readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name)
    return entry.isDirectory() ? walkTsFiles(path) : entry.isFile() && path.endsWith(".ts") ? [path] : []
  })

const createInstalledPackageShape = () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "send-packaging-"))
  const tempNodeModules = join(tempRoot, "node_modules")
  const sendRoot = join(tempNodeModules, "@elefunc/send")
  mkdirSync(tempNodeModules, { recursive: true })
  for (const entry of readdirSync(resolve(packageRoot, "node_modules"), { withFileTypes: true })) {
    if (entry.name === "@elefunc") continue
    const source = resolve(packageRoot, "node_modules", entry.name)
    const target = join(tempNodeModules, entry.name)
    symlinkSync(source, target, lstatSync(source).isDirectory() ? "dir" : "file")
  }
  mkdirSync(join(tempNodeModules, "@elefunc"), { recursive: true })
  cpSync(resolve(packageRoot, "src"), join(sendRoot, "src"), { recursive: true })
  cpSync(resolve(packageRoot, "runtime"), join(sendRoot, "runtime"), { recursive: true })
  cpSync(resolve(packageRoot, "README.md"), join(sendRoot, "README.md"))
  cpSync(resolve(packageRoot, "LICENSE"), join(sendRoot, "LICENSE"))
  cpSync(resolve(packageRoot, "package.json"), join(sendRoot, "package.json"))
  return { tempRoot, sendRoot }
}

describe("packaged TUI imports", () => {
  test("shipped source never imports repo-local node_modules paths", () => {
    for (const path of walkTsFiles(resolve(packageRoot, "src"))) {
      expect(/(?:\.\.\/)+node_modules\//.test(readFileSync(path, "utf8"))).toBe(false)
    }
  })

  test("tui runtime imports from an installed package layout", async () => {
    const shape = createInstalledPackageShape()
    try {
      const tuiRuntime = await import(pathToFileURL(join(shape.sendRoot, "src/tui/app.ts")).href) as typeof import("../src/tui/app")
      expect(typeof tuiRuntime.startTui).toBe("function")
    } finally {
      rmSync(shape.tempRoot, { recursive: true, force: true })
    }
  })
})
