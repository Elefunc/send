import { readFileSync, writeFileSync } from "node:fs"
import { fixReziDiagram } from "./rezi-diagram"

const reziPath = new URL("./rezi.txt", import.meta.url)
const current = readFileSync(reziPath, "utf8")
const fixed = fixReziDiagram(current)

if (fixed !== current) {
  writeFileSync(reziPath, fixed)
  console.log(`fixed ${reziPath}`)
} else {
  console.log(`already aligned ${reziPath}`)
}
