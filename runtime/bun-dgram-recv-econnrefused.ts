import { createRequire } from "node:module"
import type { Socket } from "node:dgram"

const require = createRequire(import.meta.url)

const CREATE_SOCKET_PATCHED = Symbol.for("@elefunc/send/runtime/dgram-create-socket-patched")
const SOCKET_ERROR_HANDLER_PATCHED = Symbol.for("@elefunc/send/runtime/dgram-socket-error-handler-patched")

type DgramModule = {
  createSocket: (...args: unknown[]) => Socket
}

type PatchedCreateSocket = DgramModule["createSocket"] & {
  [CREATE_SOCKET_PATCHED]?: true
}

type PatchedSocket = Socket & {
  [SOCKET_ERROR_HANDLER_PATCHED]?: true
}

export const AFFECTED_BUN_DGRAM_RECV_ECONNREFUSED_VERSIONS = new Set(["1.3.12"])

const bunVersion = () => process.versions.bun

export function isAffectedBunDgramRecvEconnrefusedVersion(version?: string) {
  const resolvedVersion = arguments.length === 0 ? bunVersion() : version
  return AFFECTED_BUN_DGRAM_RECV_ECONNREFUSED_VERSIONS.has(resolvedVersion ?? "")
}

const shouldIgnoreUdpRecvConnectionRefused = (error: unknown) => {
  if (!(error instanceof Error)) return false
  const code = "code" in error ? `${error.code ?? ""}` : ""
  const syscall = "syscall" in error ? `${error.syscall ?? ""}` : ""
  return code === "ECONNREFUSED" && syscall === "recv"
}

const rethrowAsync = (error: Error) => {
  queueMicrotask(() => {
    throw error
  })
}

const ensureSocketErrorHandler = (socket: Socket) => {
  const patchedSocket = socket as PatchedSocket
  if (patchedSocket[SOCKET_ERROR_HANDLER_PATCHED]) return socket
  socket.on("error", (error: Error) => {
    if (shouldIgnoreUdpRecvConnectionRefused(error)) return
    if (socket.listenerCount("error") > 1) return
    rethrowAsync(error)
  })
  patchedSocket[SOCKET_ERROR_HANDLER_PATCHED] = true
  return socket
}

const patchDgramModule = (moduleId: "dgram" | "node:dgram") => {
  const dgramModule = require(moduleId) as DgramModule
  const currentCreateSocket = dgramModule.createSocket as PatchedCreateSocket
  if (typeof currentCreateSocket !== "function" || currentCreateSocket[CREATE_SOCKET_PATCHED]) return
  const wrappedCreateSocket: PatchedCreateSocket = function (this: unknown, ...args: unknown[]) {
    return ensureSocketErrorHandler(currentCreateSocket.apply(this, args))
  }
  wrappedCreateSocket[CREATE_SOCKET_PATCHED] = true
  dgramModule.createSocket = wrappedCreateSocket
}

export const ensureBunDgramRecvEconnrefusedPatch = async () => {
  if (!isAffectedBunDgramRecvEconnrefusedVersion()) return
  patchDgramModule("node:dgram")
  patchDgramModule("dgram")
}
