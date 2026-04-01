import { resolve } from "node:path"
import { cleanRoom } from "./protocol"

export const DEFAULT_WEB_URL = "https://rtme.sh/"
export const COPY_SERVICE_URL = "https://copy.rt.ht/"

export type ShareUrlOptions = {
  room: string
  clean?: boolean
  accept?: boolean
  offer?: boolean
  save?: boolean
  overwrite?: boolean
}

export type ShareCliCommandOptions = ShareUrlOptions & {
  self?: string
  events?: boolean
  saveDir?: string
  defaultSaveDir?: string
  turnUrls?: readonly (string | null | undefined)[]
  turnUsername?: string
  turnCredential?: string
}

export type JoinOutputKind = "offer" | "accept"

const hashBool = (value: boolean) => value ? "1" : "0"
const safeShellArgPattern = /^[A-Za-z0-9._/:?=&,+@%-]+$/

const normalizeShareUrlOptions = (options: ShareUrlOptions) => ({
  room: cleanRoom(options.room),
  clean: options.clean ?? true,
  accept: options.accept ?? true,
  offer: options.offer ?? true,
  save: options.save ?? true,
  overwrite: options.overwrite ?? false,
})

const shellQuote = (value: string) => safeShellArgPattern.test(value) ? value : `'${value.replaceAll("'", `'\"'\"'`)}'`

export const appendCliFlag = (args: string[], flag: string, value?: string | null) => {
  const text = `${value ?? ""}`.trim()
  if (!text) return
  args.push(flag, shellQuote(text))
}

export const appendToggleCliFlags = (args: string[], options: ShareUrlOptions) => {
  const normalized = normalizeShareUrlOptions(options)
  if (!normalized.clean) appendCliFlag(args, "--clean", "0")
  if (!normalized.accept) appendCliFlag(args, "--accept", "0")
  if (!normalized.offer) appendCliFlag(args, "--offer", "0")
  if (!normalized.save) appendCliFlag(args, "--save", "0")
  if (normalized.overwrite) args.push("--overwrite")
}

const buildHashParams = (options: ShareUrlOptions, omitDefaults = false) => {
  const normalized = normalizeShareUrlOptions(options)
  const params = new URLSearchParams({ room: normalized.room })
  if (!omitDefaults || !normalized.clean) params.set("clean", hashBool(normalized.clean))
  if (!omitDefaults || !normalized.accept) params.set("accept", hashBool(normalized.accept))
  if (!omitDefaults || !normalized.offer) params.set("offer", hashBool(normalized.offer))
  if (!omitDefaults || !normalized.save) params.set("save", hashBool(normalized.save))
  if (!omitDefaults || normalized.overwrite) params.set("overwrite", hashBool(normalized.overwrite))
  return params
}

export const resolveWebUrlBase = (value = process.env.SEND_WEB_URL) => {
  const candidate = `${value ?? ""}`.trim() || DEFAULT_WEB_URL
  try {
    return new URL(candidate).toString()
  } catch {
    return DEFAULT_WEB_URL
  }
}

export const renderWebUrl = (options: ShareUrlOptions, baseUrl = DEFAULT_WEB_URL, omitDefaults = true) => {
  const url = new URL(baseUrl)
  url.hash = buildHashParams(options, omitDefaults).toString()
  return url.toString()
}

export const schemeLessUrlText = (text: string) => text.replace(/^[a-z]+:\/\//, "")

export const webInviteUrl = (options: ShareUrlOptions, baseUrl = resolveWebUrlBase()) => renderWebUrl(options, baseUrl)

export const inviteWebLabel = (options: ShareUrlOptions, baseUrl = resolveWebUrlBase()) => schemeLessUrlText(webInviteUrl(options, baseUrl))

export const inviteCliPackageName = (baseUrl = resolveWebUrlBase()) => new URL(resolveWebUrlBase(baseUrl)).hostname

export const inviteCliCommand = (options: ShareUrlOptions) => {
  const normalized = normalizeShareUrlOptions(options)
  const args: string[] = []
  appendCliFlag(args, "--room", normalized.room)
  appendToggleCliFlags(args, normalized)
  return args.join(" ")
}

export const inviteCliText = (options: ShareUrlOptions, baseUrl = resolveWebUrlBase()) => `bunx ${inviteCliPackageName(baseUrl)} ${inviteCliCommand(options)}`

export const inviteCopyUrl = (text: string) => `${COPY_SERVICE_URL}#${new URLSearchParams({ text })}`

export const shareTurnCliArgs = (options: Pick<ShareCliCommandOptions, "turnUrls" | "turnUsername" | "turnCredential">) => {
  const turnUrls = [...new Set((options.turnUrls ?? []).map(url => `${url ?? ""}`.trim()).filter(Boolean))]
  if (!turnUrls.length) return []
  const args: string[] = []
  for (const turnUrl of turnUrls) appendCliFlag(args, "--turn-url", turnUrl)
  appendCliFlag(args, "--turn-username", options.turnUsername)
  appendCliFlag(args, "--turn-credential", options.turnCredential)
  return args
}

export const renderCliCommand = (
  options: ShareCliCommandOptions,
  { includeSelf = false, includePrefix = false, packageName }: { includeSelf?: boolean; includePrefix?: boolean; packageName?: string } = {},
) => {
  const normalized = normalizeShareUrlOptions(options)
  const args = includePrefix ? ["bunx", packageName || inviteCliPackageName(DEFAULT_WEB_URL)] : []
  appendCliFlag(args, "--room", normalized.room)
  if (includeSelf) appendCliFlag(args, "--self", options.self)
  appendToggleCliFlags(args, normalized)
  if (options.events) args.push("--events")
  if (options.saveDir && (!options.defaultSaveDir || resolve(options.saveDir) !== options.defaultSaveDir)) appendCliFlag(args, "--folder", options.saveDir)
  args.push(...shareTurnCliArgs(options))
  return args.join(" ")
}

const joinCliLabel = (kind: JoinOutputKind) => kind === "offer" ? "CLI (receive and save):" : "CLI (append file paths at the end):"

const joinCliCommand = (kind: JoinOutputKind, room: string, baseUrl = resolveWebUrlBase()) => {
  const prefix = `bunx ${inviteCliPackageName(baseUrl)}`
  const roomArgs = inviteCliCommand({ room })
  return kind === "offer" ? `${prefix} accept ${roomArgs}` : `${prefix} offer ${roomArgs}`
}

export const joinOutputLines = (kind: JoinOutputKind, room: string, baseUrl = resolveWebUrlBase()) => [
  "Join with:",
  "",
  "Web (open in browser):",
  webInviteUrl({ room }, baseUrl),
  "",
  joinCliLabel(kind),
  joinCliCommand(kind, room, baseUrl),
  "",
  "TUI (interactive terminal UI):",
  inviteCliText({ room }, baseUrl),
  "",
]
