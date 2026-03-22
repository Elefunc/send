import { ensureReziFilePatches } from "./rezi-files"
import { ensureReziInputCaretPatch } from "./rezi-input-caret"

let sessionInstallPromise: Promise<void> | null = null
let tuiInstallPromise: Promise<void> | null = null

export const ensureSessionRuntimePatches = () => {
  if (sessionInstallPromise) return sessionInstallPromise
  sessionInstallPromise = Promise.resolve()
  return sessionInstallPromise
}

export const ensureTuiRuntimePatches = () => {
  if (tuiInstallPromise) return tuiInstallPromise
  tuiInstallPromise = (async () => {
    await ensureReziFilePatches()
    await ensureReziInputCaretPatch()
  })()
  return tuiInstallPromise
}

export const ensureRuntimeFilePatches = ensureTuiRuntimePatches
