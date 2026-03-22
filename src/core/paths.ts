import { homedir } from "node:os"
import { resolve } from "node:path"

const normalizePathInput = (value: string) => value.replace(/\\/gu, "/")

export const isHomeDirectoryPath = (value: string) => {
  const normalized = normalizePathInput(value)
  return normalized === "~" || normalized.startsWith("~/")
}

export const expandHomePath = (value: string, home = homedir()) => {
  const normalized = normalizePathInput(value)
  if (normalized === "~") return home
  if (normalized.startsWith("~/")) return resolve(home, normalized.slice(2))
  return null
}

export const resolveUserPath = (value: string, cwd = process.cwd(), home = homedir()) =>
  expandHomePath(value, home) ?? resolve(cwd, value)
