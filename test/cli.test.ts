import { resolve } from "node:path"
import { describe, expect, test } from "bun:test"
import { createCli, roomAnnouncement, runCli, sessionConfigFrom } from "../src/index"

const captureConsole = async (fn: () => Promise<unknown> | unknown) => {
  const messages: string[] = []
  const format = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value)
  const push = (...args: unknown[]) => void messages.push(args.map(format).join(" "))
  const originalInfo = console.info
  const originalLog = console.log
  const originalError = console.error
  console.info = push
  console.log = push
  console.error = push
  try {
    await fn()
    return messages.join("\n")
  } finally {
    console.info = originalInfo
    console.log = originalLog
    console.error = originalError
  }
}

const rejectMessage = async (fn: () => Promise<unknown>) => {
  try {
    await fn()
    return ""
  } catch (error) {
    return error instanceof Error ? error.message : `${error}`
  }
}

const throwMessage = (fn: () => unknown) => {
  try {
    fn()
    return ""
  } catch (error) {
    return error instanceof Error ? error.message : `${error}`
  }
}

const withEnv = async (values: Record<string, string | undefined>, fn: () => Promise<unknown> | unknown) => {
  const previous = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key])
    if (value == null) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await fn()
  } finally {
    for (const [key, value] of previous) {
      if (value == null) delete process.env[key]
      else process.env[key] = value
    }
  }
}

const createHandlerSpies = () => {
  const calls: Array<{ name: "peers" | "offer" | "accept" | "tui"; args: unknown[] }> = []
  return {
    calls,
    handlers: {
      peers: async (options: Record<string, unknown>) => void calls.push({ name: "peers", args: [options] }),
      offer: async (files: string[], options: Record<string, unknown>) => void calls.push({ name: "offer", args: [files, options] }),
      accept: async (options: Record<string, unknown>) => void calls.push({ name: "accept", args: [options] }),
      tui: async (options: Record<string, unknown>) => void calls.push({ name: "tui", args: [options] }),
    },
  }
}

describe("CLI surface", () => {
  test("session config generates a random room when none is provided", () => {
    const config = sessionConfigFrom({}, {})
    expect(config.room.length > 0).toBe(true)
    expect(/^[a-z0-9._-]+$/.test(config.room)).toBe(true)
  })

  test("session config prefers explicit room over SEND_ROOM", async () => {
    await withEnv({ SEND_ROOM: "from-env" }, () => {
      const config = sessionConfigFrom({ room: "from-cli" }, {})
      expect(config.room).toBe("from-cli")
    })
  })

  test("session config falls back to SEND_ROOM when room is omitted", async () => {
    await withEnv({ SEND_ROOM: "from-env" }, () => {
      const config = sessionConfigFrom({}, {})
      expect(config.room).toBe("from-env")
    })
  })

  test("session config treats empty room values as omitted", async () => {
    await withEnv({ SEND_ROOM: "from-env" }, () => {
      const config = sessionConfigFrom({ room: "   " }, {})
      expect(config.room).toBe("from-env")
    })
  })

  test("session config parses --accept and --save binary values", () => {
    const config = sessionConfigFrom({ accept: "0", save: "1" }, { autoAcceptIncoming: true, autoSaveIncoming: false })
    expect(config.autoAcceptIncoming).toBe(false)
    expect(config.autoSaveIncoming).toBe(true)
  })

  test("session config keeps default accept/save values when flags are omitted", () => {
    const config = sessionConfigFrom({}, { autoAcceptIncoming: true, autoSaveIncoming: true })
    expect(config.autoAcceptIncoming).toBe(true)
    expect(config.autoSaveIncoming).toBe(true)
  })

  test("session config defaults saveDir to the current working directory", () => {
    const config = sessionConfigFrom({}, {})
    expect(config.saveDir).toBe(resolve(process.cwd()))
  })

  test("session config rejects invalid binary toggle values", () => {
    expect(throwMessage(() => sessionConfigFrom({ accept: "2" }, { autoAcceptIncoming: true }))).toBe("--accept must be 0 or 1")
    expect(throwMessage(() => sessionConfigFrom({ save: "maybe" }, { autoSaveIncoming: true }))).toBe("--save must be 0 or 1")
  })

  test("session config parses --self name values", () => {
    const config = sessionConfigFrom({ self: "alice" }, {})
    expect(config.name).toBe("alice")
    expect(config.localId === undefined).toBe(true)
  })

  test("session config parses --self name-ID values", () => {
    const config = sessionConfigFrom({ self: "alice-ab12cd34" }, {})
    expect(config.name).toBe("alice")
    expect(config.localId).toBe("ab12cd34")
  })

  test("session config parses --self ID-only values without setting an explicit name", () => {
    const config = sessionConfigFrom({ self: "-ab12cd34" }, {})
    expect(config.name === undefined).toBe(true)
    expect(config.localId).toBe("ab12cd34")
  })

  test("session config prefers explicit --self over SEND_SELF", async () => {
    await withEnv({ SEND_SELF: "envuser-zz99yy88" }, () => {
      const config = sessionConfigFrom({ self: "cliuser-ab12cd34" }, {})
      expect(config.name).toBe("cliuser")
      expect(config.localId).toBe("ab12cd34")
    })
  })

  test("session config falls back to SEND_SELF when --self is omitted", async () => {
    await withEnv({ SEND_SELF: "envuser-ab12cd34" }, () => {
      const config = sessionConfigFrom({}, {})
      expect(config.name).toBe("envuser")
      expect(config.localId).toBe("ab12cd34")
    })
  })

  test("session config falls back to SEND_SELF for ID-only values", async () => {
    await withEnv({ SEND_SELF: "-ab12cd34" }, () => {
      const config = sessionConfigFrom({}, {})
      expect(config.name === undefined).toBe(true)
      expect(config.localId).toBe("ab12cd34")
    })
  })

  test("session config ignores SEND_NAME after the --self rename", async () => {
    await withEnv({ SEND_NAME: "legacy-name", SEND_SELF: undefined }, () => {
      const config = sessionConfigFrom({}, {})
      expect(config.name === undefined).toBe(true)
      expect(config.localId === undefined).toBe(true)
    })
  })

  test("session config rejects short --self ID suffixes with the exact expected length", async () => {
    await withEnv({ SEND_SELF: undefined }, () => {
      expect(throwMessage(() => sessionConfigFrom({ self: "alice-ab12" }, {})))
        .toBe("--self ID suffix must be exactly 8 lowercase alphanumeric characters")
    })
  })

  test("session config rejects invalid ID-only --self values with the exact expected length", () => {
    expect(throwMessage(() => sessionConfigFrom({ self: "-ab12" }, {})))
      .toBe("--self ID suffix must be exactly 8 lowercase alphanumeric characters")
  })

  test("session config rejects long --self ID suffixes with the exact expected length", () => {
    expect(throwMessage(() => sessionConfigFrom({ self: "alice-ab12cd345" }, {})))
      .toBe("--self ID suffix must be exactly 8 lowercase alphanumeric characters")
  })

  test("session config rejects uppercase --self ID suffixes", () => {
    expect(throwMessage(() => sessionConfigFrom({ self: "alice-AB12cd34" }, {})))
      .toBe("--self ID suffix must be exactly 8 lowercase alphanumeric characters")
  })

  test("session config rejects non-alphanumeric --self ID suffixes", () => {
    expect(throwMessage(() => sessionConfigFrom({ self: "alice-ab12cd$4" }, {})))
      .toBe("--self ID suffix must be exactly 8 lowercase alphanumeric characters")
  })

  test("room announcements format human-readable output", () => {
    expect(roomAnnouncement("demo")).toBe("room demo")
  })

  test("room announcements format json output", () => {
    expect(roomAnnouncement("demo", true)).toBe(JSON.stringify({ type: "room", room: "demo" }))
  })

  test("global help lists accept and removes receive", async () => {
    const output = await captureConsole(() => runCli(["bun", "send", "--help"]))
    expect(output).toContain("Usage:\n  $ send [command] [options]")
    expect(output).toContain("Default:\n  send with no command launches the terminal UI (same as `send tui`).")
    expect(output).toContain("  accept            receive and save files")
    expect(output.includes("  receive           receive and save files")).toBe(false)
    expect(output.includes("$ send receive --help")).toBe(false)
  })

  test("accept help is available", async () => {
    const output = await captureConsole(() => runCli(["bun", "send", "accept", "--help"]))
    expect(output).toContain("Usage:\n  $ send accept")
  })

  test("defaults bare send to the tui command", async () => {
    const { calls, handlers } = createHandlerSpies()
    await runCli(["bun", "send"], handlers)
    expect(calls).toEqual([{ name: "tui", args: [{ "--": [] }] }])
  })

  test("defaults no-subcommand option-only invocations to tui", async () => {
    const { calls, handlers } = createHandlerSpies()
    await runCli(["bun", "send", "--room", "demo", "--events", "--to", "peer", "--bogus"], handlers)
    expect(calls.length).toBe(1)
    expect(calls[0]?.name).toBe("tui")
    expect(calls[0]?.args[0]).toEqual({
      "--": [],
      room: "demo",
      events: true,
      to: "peer",
      bogus: true,
    })
  })

  test("top-level help does not default to tui", async () => {
    const { calls, handlers } = createHandlerSpies()
    const output = await captureConsole(() => runCli(["bun", "send", "--help"], handlers))
    expect(output).toContain("Usage:\n  $ send [command] [options]")
    expect(output).toContain("Default:\n  send with no command launches the terminal UI (same as `send tui`).")
    expect(calls).toEqual([])
  })

  test("CLI parsing accepts the attached --self=-ID form", () => {
    const cli = createCli()
    const parsed = cli.parse(["bun", "send", "peers", "--self=-ab12cd34"], { run: false }) as { options: Record<string, unknown> }
    expect(parsed.options.self).toBe("-ab12cd34")
  })

  test("explicit subcommands still dispatch their own handlers", async () => {
    const { calls, handlers } = createHandlerSpies()
    await runCli(["bun", "send", "peers", "--wait", "1"], handlers)
    expect(calls).toEqual([{ name: "peers", args: [{ "--": [], wait: 1 }] }])
  })

  test("receive is rejected as an unknown command", async () => {
    expect(await rejectMessage(() => runCli(["bun", "send", "receive", "--help"]))).toBe("Unknown command `receive`")
  })

  test("offer help documents broadcast targeting", async () => {
    const output = await captureConsole(() => runCli(["bun", "send", "offer", "--help"]))
    expect(output).toContain("omit to create a random room")
    expect(output).toContain("--self <self>")
    expect(output).toContain("name, name-ID, or -ID")
    expect(output).toContain("use --self=-ID")
    expect(output.includes("--name <name>")).toBe(false)
    expect(output).toContain("--to <peer>")
    expect(output).toContain("or `.` for all ready peers; default: `.`")
    expect(output).toContain("omit to wait indefinitely")
    expect(output.includes("--all-ready")).toBe(false)
  })

  test("offer rejects invalid explicit wait-peer values", async () => {
    expect(await rejectMessage(() => runCli(["bun", "send", "offer", "dummy.txt", "--room", "demo", "--wait-peer", "Infinity"])))
      .toBe("--wait-peer must be a finite non-negative number of milliseconds")
  })

  test("tui help documents the events pane flag", async () => {
    const output = await captureConsole(() => runCli(["bun", "send", "tui", "--help"]))
    expect(output).toContain("omit to create a random room")
    expect(output).toContain("--self <self>")
    expect(output).toContain("--clean <0|1>")
    expect(output).toContain("--accept <0|1>")
    expect(output).toContain("--offer <0|1>")
    expect(output).toContain("--save <0|1>")
    expect(output).toContain("name, name-ID, or -ID")
    expect(output).toContain("use --self=-ID")
    expect(output.includes("--name <name>")).toBe(false)
    expect(output).toContain("--events")
    expect(output).toContain("show the event log pane")
  })

  test("tui command forwards explicit binary toggles", async () => {
    const { calls, handlers } = createHandlerSpies()
    await runCli(["bun", "send", "tui", "--clean", "0", "--accept", "0", "--offer", "0", "--save", "0"], handlers)
    expect(calls).toEqual([{
      name: "tui",
      args: [{
        "--": [],
        clean: 0,
        accept: 0,
        offer: 0,
        save: 0,
      }],
    }])
  })

  test("peers help documents optional random rooms", async () => {
    const output = await captureConsole(() => runCli(["bun", "send", "peers", "--help"]))
    expect(output).toContain("omit to create a random room")
    expect(output).toContain("--self <self>")
    expect(output).toContain("name, name-ID, or -ID")
    expect(output).toContain("use --self=-ID")
    expect(output.includes("--name <name>")).toBe(false)
  })

  test("accept help documents optional random rooms", async () => {
    const output = await captureConsole(() => runCli(["bun", "send", "accept", "--help"]))
    expect(output).toContain("omit to create a random room")
    expect(output).toContain("--self <self>")
    expect(output).toContain("name, name-ID, or -ID")
    expect(output).toContain("use --self=-ID")
    expect(output.includes("--name <name>")).toBe(false)
  })
})
