import { spawn } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "bun:test"
import { ACCEPT_SESSION_DEFAULTS, commandAnnouncement, createCli, readyStatusLine, roomAnnouncement, runCli, sessionConfigFrom } from "../src/index"

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

const withCliHelpEnv = async (
  values: { name?: string; colored?: string },
  fn: () => Promise<unknown> | unknown,
) => withEnv({
  SEND_NAME: values.name,
  SEND_NAME_COLORED: values.colored,
}, fn)

const withStdoutTTY = async (isTTY: boolean, fn: () => Promise<unknown> | unknown) => {
  const hadOwn = Object.prototype.hasOwnProperty.call(process.stdout, "isTTY")
  const previous = process.stdout.isTTY
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: isTTY })
  try {
    return await fn()
  } finally {
    if (hadOwn) Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: previous })
    else Reflect.deleteProperty(process.stdout as unknown as Record<string, unknown>, "isTTY")
  }
}

const bunMainName = Bun.main.replace(/^.*[\\/]/, "") || Bun.main
const colorHelpName = (value: string) => `\u001b[38;5;214m${value}\u001b[0m`
const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const runCliRaw = (...args: string[]) => new Promise<{ stdout: string; stderr: string; exitCode: number | null }>((resolveRun, reject) => {
  const child = spawn("bun", ["run", "./src/index.ts", ...args], {
    cwd: cliRoot,
    env: { ...process.env, SEND_NAME: "send" },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", chunk => { stdout += `${chunk}` })
  child.stderr.on("data", chunk => { stderr += `${chunk}` })
  child.on("error", reject)
  child.on("close", exitCode => resolveRun({ stdout, stderr, exitCode }))
})

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

  test("accept command defaults keep streaming receive enabled", () => {
    const config = sessionConfigFrom({}, ACCEPT_SESSION_DEFAULTS)
    expect(config.autoAcceptIncoming).toBe(true)
    expect(config.autoSaveIncoming).toBe(true)
  })

  test("session config enables overwrite mode from --overwrite", () => {
    const config = sessionConfigFrom({ overwrite: true }, {})
    expect(config.overwriteIncoming).toBe(true)
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

  test("session config parses --self name-id values", () => {
    const config = sessionConfigFrom({ self: "alice-ab12cd34" }, {})
    expect(config.name).toBe("alice")
    expect(config.localId).toBe("ab12cd34")
  })

  test("session config parses --self id-only values without setting an explicit name", () => {
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

  test("session config falls back to SEND_SELF for id-only values", async () => {
    await withEnv({ SEND_SELF: "-ab12cd34" }, () => {
      const config = sessionConfigFrom({}, {})
      expect(config.name === undefined).toBe(true)
      expect(config.localId).toBe("ab12cd34")
    })
  })

  test("session config ignores SEND_NAME for self identity", async () => {
    await withEnv({ SEND_NAME: "legacy-name", SEND_SELF: undefined }, () => {
      const config = sessionConfigFrom({}, {})
      expect(config.name === undefined).toBe(true)
      expect(config.localId === undefined).toBe(true)
    })
  })

  test("session config rejects short --self id suffixes with the exact expected length", async () => {
    await withEnv({ SEND_SELF: undefined }, () => {
      expect(throwMessage(() => sessionConfigFrom({ self: "alice-ab12" }, {})))
        .toBe("--self id suffix must be exactly 8 lowercase alphanumeric characters")
    })
  })

  test("session config rejects invalid id-only --self values with the exact expected length", () => {
    expect(throwMessage(() => sessionConfigFrom({ self: "-ab12" }, {})))
      .toBe("--self id suffix must be exactly 8 lowercase alphanumeric characters")
  })

  test("session config rejects long --self id suffixes with the exact expected length", () => {
    expect(throwMessage(() => sessionConfigFrom({ self: "alice-ab12cd345" }, {})))
      .toBe("--self id suffix must be exactly 8 lowercase alphanumeric characters")
  })

  test("session config rejects uppercase --self id suffixes", () => {
    expect(throwMessage(() => sessionConfigFrom({ self: "alice-AB12cd34" }, {})))
      .toBe("--self id suffix must be exactly 8 lowercase alphanumeric characters")
  })

  test("session config rejects non-alphanumeric --self id suffixes", () => {
    expect(throwMessage(() => sessionConfigFrom({ self: "alice-ab12cd$4" }, {})))
      .toBe("--self id suffix must be exactly 8 lowercase alphanumeric characters")
  })

  test("room announcements format human-readable output", () => {
    expect(roomAnnouncement("demo", "alice-12345678")).toBe("room demo\nself alice-12345678")
  })

  test("room announcements format json output", () => {
    expect(roomAnnouncement("demo", "alice-12345678", true)).toBe(JSON.stringify({ type: "room", room: "demo", self: "alice-12345678" }))
  })

  test("offer announcements add copy-pasteable Web, CLI, and TUI join lines", () => {
    expect(commandAnnouncement("offer", "demo", "alice-12345678")).toBe([
      "room demo",
      "self alice-12345678",
      "",
      "Join with:",
      "",
      "Web (open in browser):",
      "https://rtme.sh/#room=demo",
      "",
      "CLI (receive and save):",
      "bunx rtme.sh accept --room demo",
      "",
      "TUI (interactive terminal UI):",
      "bunx rtme.sh --room demo",
      "",
    ].join("\n"))
  })

  test("accept announcements use the sender offer template and generic TUI/Web joins", () => {
    expect(commandAnnouncement("accept", "demo", "alice-12345678")).toBe([
      "room demo",
      "self alice-12345678",
      "",
      "Join with:",
      "",
      "Web (open in browser):",
      "https://rtme.sh/#room=demo",
      "",
      "CLI (append file paths at the end):",
      "bunx rtme.sh offer --room demo",
      "",
      "TUI (interactive terminal UI):",
      "bunx rtme.sh --room demo",
      "",
    ].join("\n"))
  })

  test("json announcements stay machine-readable and skip join lines", () => {
    expect(commandAnnouncement("offer", "demo", "alice-12345678", true))
      .toBe(JSON.stringify({ type: "room", room: "demo", self: "alice-12345678" }))
  })

  test("ready status lines use the shared human wording and disappear in json mode", () => {
    expect(readyStatusLine("demo")).toBe("ready in demo")
    expect(readyStatusLine("demo", true)).toBe("")
  })

  test("announcements derive the host and web base from SEND_WEB_URL", async () => {
    await withEnv({ SEND_WEB_URL: "https://example.com/send/" }, () => {
      const output = commandAnnouncement("offer", "demo", "alice-12345678")
      expect(output).toContain("https://example.com/send/#room=demo")
      expect(output).toContain("bunx example.com accept --room demo")
      expect(output).toContain("bunx example.com --room demo")
    })
  })

  test("global help lists accept and removes receive", async () => {
    await withCliHelpEnv({ name: "send" }, async () => {
      await withStdoutTTY(false, async () => {
        const output = await captureConsole(() => runCli(["bun", "send", "--help"]))
        expect(output).toContain("Usage:\n  $ send [command] [options]")
        expect(output).toContain("Default:\n  send with no command launches the terminal UI (same as `send tui`).")
        expect(output).toContain("  accept            receive and save files")
        expect(output.includes("  receive           receive and save files")).toBe(false)
        expect(output.includes("$ send receive --help")).toBe(false)
      })
    })
  })

  test("accept help is available", async () => {
    await withCliHelpEnv({ name: "send" }, async () => {
      await withStdoutTTY(false, async () => {
        const output = await captureConsole(() => runCli(["bun", "send", "accept", "--help"]))
        expect(output).toContain("Usage:\n  $ send accept")
        expect(output).toContain("--overwrite")
      })
    })
  })

  test("defaults bare send to the tui command", async () => {
    const { calls, handlers } = createHandlerSpies()
    await runCli(["bun", "send"], handlers)
    expect(calls).toEqual([{ name: "tui", args: [{ "--": [] }] }])
  })

  test("defaults no-subcommand option-only invocations to tui", async () => {
    const { calls, handlers } = createHandlerSpies()
    await runCli(["bun", "send", "--room", "demo", "--events", "--overwrite", "--to", "peer", "--bogus"], handlers)
    expect(calls.length).toBe(1)
    expect(calls[0]?.name).toBe("tui")
    expect(calls[0]?.args[0]).toEqual({
      "--": [],
      room: "demo",
      events: true,
      overwrite: true,
      to: "peer",
      bogus: true,
    })
  })

  test("top-level help does not default to tui", async () => {
    await withCliHelpEnv({ name: "send" }, async () => {
      await withStdoutTTY(false, async () => {
        const { calls, handlers } = createHandlerSpies()
        const output = await captureConsole(() => runCli(["bun", "send", "--help"], handlers))
        expect(output).toContain("Usage:\n  $ send [command] [options]")
        expect(output).toContain("Default:\n  send with no command launches the terminal UI (same as `send tui`).")
        expect(output).toContain("Usage:\n  $ send tui")
        expect(calls).toEqual([])
      })
    })
  })

  test("top-level help appends the exact tui help output", async () => {
    await withCliHelpEnv({ name: "send" }, async () => {
      await withStdoutTTY(false, async () => {
        const output = await captureConsole(() => runCli(["bun", "send", "--help"]))
        const tuiHelp = await captureConsole(() => runCli(["bun", "send", "tui", "--help"]))
        expect(output.endsWith(tuiHelp)).toBe(true)
        expect(output.includes(`\n\n${tuiHelp}`)).toBe(true)
      })
    })
  })

  test("top-level help ends with exactly one empty final line", async () => {
    const { stdout, stderr, exitCode } = await runCliRaw("--help")
    expect(exitCode).toBe(0)
    expect(stderr).toBe("")
    expect(stdout.endsWith("\n\n")).toBe(true)
    expect(stdout.endsWith("\n\n\n")).toBe(false)
    expect(stdout.includes("\n\nsend\n\nUsage:\n  $ send tui")).toBe(true)
    expect(stdout.includes("\n\n\nsend\n\nUsage:\n  $ send tui")).toBe(false)
  })

  test("top-level help still applies when a global option value matches a command name", async () => {
    await withCliHelpEnv({ name: "send" }, async () => {
      await withStdoutTTY(false, async () => {
        const output = await captureConsole(() => runCli(["bun", "send", "--room", "offer", "--help"]))
        const topLevelHelp = await captureConsole(() => runCli(["bun", "send", "--help"]))
        expect(output).toBe(topLevelHelp)
      })
    })
  })

  test("help name can be overridden by env", async () => {
    await withCliHelpEnv({ name: "my-send" }, async () => {
      await withStdoutTTY(false, async () => {
        const output = await captureConsole(() => runCli(["bun", "send", "--help"]))
        expect(output).toContain("Usage:\n  $ my-send [command] [options]")
        expect(output).toContain("Default:\n  my-send with no command launches the terminal UI (same as `my-send tui`).")
        expect(output).toContain("$ my-send peers --help")
        expect(output).toContain("Usage:\n  $ my-send tui")
      })
    })
  })

  test("help name defaults to Bun.main when env override is unset", async () => {
    await withCliHelpEnv({}, async () => {
      await withStdoutTTY(false, async () => {
        const output = await captureConsole(() => runCli(["bun", "send", "--help"]))
        expect(output).toContain(`Usage:\n  $ ${bunMainName} [command] [options]`)
        expect(output).toContain(`Default:\n  ${bunMainName} with no command launches the terminal UI (same as \`${bunMainName} tui\`).`)
        expect(output).toContain(`Usage:\n  $ ${bunMainName} tui`)
      })
    })
  })

  test("help name is auto-colored on TTY", async () => {
    await withCliHelpEnv({ name: "my-send" }, async () => {
      await withStdoutTTY(true, async () => {
        const output = await captureConsole(() => runCli(["bun", "send", "--help"]))
        const colored = colorHelpName("my-send")
        expect(output).toContain(`Usage:\n  $ ${colored} [command] [options]`)
        expect(output).toContain(`Default:\n  ${colored} with no command launches the terminal UI (same as \`${colored} tui\`).`)
        expect(output).toContain(`$ ${colored} peers --help`)
        const tuiHelp = await captureConsole(() => runCli(["bun", "send", "tui", "--help"]))
        expect(output.endsWith(tuiHelp)).toBe(true)
      })
    })
  })

  test("SEND_NAME_COLORED overrides the default TTY color", async () => {
    await withCliHelpEnv({ name: "my-send", colored: "\u001b[38;5;45mcustom-send\u001b[0m" }, async () => {
      await withStdoutTTY(true, async () => {
        const output = await captureConsole(() => runCli(["bun", "send", "--help"]))
        expect(output).toContain("Usage:\n  $ \u001b[38;5;45mcustom-send\u001b[0m [command] [options]")
        expect(output.includes(colorHelpName("my-send"))).toBe(false)
      })
    })
  })

  test("colored help name is ignored when not on a TTY", async () => {
    await withCliHelpEnv({ name: "plain-send", colored: "\u001b[38;5;214mmy-send\u001b[0m" }, async () => {
      await withStdoutTTY(false, async () => {
        const output = await captureConsole(() => runCli(["bun", "send", "--help"]))
        expect(output).toContain("Usage:\n  $ plain-send [command] [options]")
        expect(output.includes("\u001b[38;5;214mmy-send\u001b[0m")).toBe(false)
      })
    })
  })

  test("CLI parsing accepts the attached --self=-id form", () => {
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

  test("leading options do not turn explicit subcommand help into top-level help", async () => {
    await withCliHelpEnv({ name: "send" }, async () => {
      await withStdoutTTY(false, async () => {
        const output = await captureConsole(() => runCli(["bun", "send", "--room", "demo", "--self", "cs-12345678", "offer", "--help"]))
        const offerHelp = await captureConsole(() => runCli(["bun", "send", "offer", "--help"]))
        expect(output).toBe(offerHelp)
      })
    })
  })

  test("leading options do not duplicate tui help", async () => {
    await withCliHelpEnv({ name: "send" }, async () => {
      await withStdoutTTY(false, async () => {
        const output = await captureConsole(() => runCli(["bun", "send", "--room", "demo", "--self", "cs-12345678", "tui", "--help"]))
        const tuiHelp = await captureConsole(() => runCli(["bun", "send", "tui", "--help"]))
        expect(output).toBe(tuiHelp)
      })
    })
  })

  test("unknown commands are still rejected after leading options", async () => {
    expect(await rejectMessage(() => runCli(["bun", "send", "--room", "demo", "receive", "--help"]))).toBe("Unknown command `receive`")
  })

  test("offer help documents broadcast targeting", async () => {
    await withCliHelpEnv({ name: "send" }, async () => {
      await withStdoutTTY(false, async () => {
        const output = await captureConsole(() => runCli(["bun", "send", "offer", "--help"]))
        expect(output).toContain("--room <room>              room id (default: <random>)")
        expect(output).toContain("--self <self>")
        expect(output).toContain("self identity: `name`, `name-id`, or `-id`")
        expect(output.includes("--name <name>")).toBe(false)
        expect(output).toContain("--to <peer>                target `name`, `name-id`, or `-id` (default: .)")
        expect(output).toContain("--wait-peer <ms>           wait for eligible peers in milliseconds (default: <infinite>)")
        expect(output).toContain("--save-dir <dir>           save directory (default: .)")
        expect(output.includes("--all-ready")).toBe(false)
      })
    })
  })

  test("subcommand help ends with exactly one empty final line", async () => {
    const { stdout, stderr, exitCode } = await runCliRaw("offer", "--help")
    expect(exitCode).toBe(0)
    expect(stderr).toBe("")
    expect(stdout.endsWith("\n\n")).toBe(true)
    expect(stdout.endsWith("\n\n\n")).toBe(false)
  })

  test("offer rejects invalid explicit wait-peer values", async () => {
    expect(await rejectMessage(() => runCli(["bun", "send", "offer", "dummy.txt", "--room", "demo", "--wait-peer", "Infinity"])))
      .toBe("--wait-peer must be a finite non-negative number of milliseconds")
  })

  test("tui help documents the events pane flag", async () => {
    await withCliHelpEnv({ name: "send" }, async () => {
      await withStdoutTTY(false, async () => {
        const output = await captureConsole(() => runCli(["bun", "send", "tui", "--help"]))
        expect(output).toContain("--room <room>              room id (default: <random>)")
        expect(output).toContain("--self <self>")
        expect(output).toContain("--clean <0|1>              show only active peers when 1; show terminal peers too when 0 (default: 1)")
        expect(output).toContain("--accept <0|1>             auto-accept incoming offers: 1 on, 0 off (default: 1)")
        expect(output).toContain("--offer <0|1>              auto-offer drafts to matching ready peers: 1 on, 0 off (default: 1)")
        expect(output).toContain("--save <0|1>               auto-save completed incoming files: 1 on, 0 off (default: 1)")
        expect(output).toContain("--overwrite")
        expect(output).toContain("self identity: `name`, `name-id`, or `-id`")
        expect(output.includes("--name <name>")).toBe(false)
        expect(output).toContain("--events")
        expect(output).toContain("show the event log pane")
        expect(output).toContain("--save-dir <dir>           save directory (default: .)")
      })
    })
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

  test("tui command does not inject help defaults into omitted binary toggles", async () => {
    const { calls, handlers } = createHandlerSpies()
    await runCli(["bun", "send", "tui"], handlers)
    expect(calls).toEqual([{ name: "tui", args: [{ "--": [] }] }])
  })

  test("peers command does not inject help defaults into omitted options", async () => {
    const { calls, handlers } = createHandlerSpies()
    await runCli(["bun", "send", "peers"], handlers)
    expect(calls).toEqual([{ name: "peers", args: [{ "--": [] }] }])
  })

  test("offer command does not inject help defaults into omitted options", async () => {
    const { calls, handlers } = createHandlerSpies()
    await runCli(["bun", "send", "offer", "file.txt"], handlers)
    expect(calls).toEqual([{ name: "offer", args: [["file.txt"], { "--": [] }] }])
  })

  test("accept command does not inject help defaults into omitted options", async () => {
    const { calls, handlers } = createHandlerSpies()
    await runCli(["bun", "send", "accept"], handlers)
    expect(calls).toEqual([{ name: "accept", args: [{ "--": [] }] }])
  })

  test("peers help documents optional random rooms", async () => {
    await withCliHelpEnv({ name: "send" }, async () => {
      await withStdoutTTY(false, async () => {
        const output = await captureConsole(() => runCli(["bun", "send", "peers", "--help"]))
        expect(output).toContain("--room <room>              room id (default: <random>)")
        expect(output).toContain("--self <self>")
        expect(output).toContain("self identity: `name`, `name-id`, or `-id`")
        expect(output.includes("--name <name>")).toBe(false)
        expect(output).toContain("--wait <ms>                discovery wait in milliseconds (default: 3000)")
        expect(output).toContain("--save-dir <dir>")
        expect(output).toContain("save directory (default: .)")
      })
    })
  })

  test("accept help documents optional random rooms", async () => {
    await withCliHelpEnv({ name: "send" }, async () => {
      await withStdoutTTY(false, async () => {
        const output = await captureConsole(() => runCli(["bun", "send", "accept", "--help"]))
        expect(output).toContain("--room <room>              room id (default: <random>)")
        expect(output).toContain("--self <self>")
        expect(output).toContain("self identity: `name`, `name-id`, or `-id`")
        expect(output.includes("--name <name>")).toBe(false)
        expect(output).toContain("--save-dir <dir>           save directory (default: .)")
      })
    })
  })
})
