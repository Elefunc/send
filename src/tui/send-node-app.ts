import { createApp, darkTheme, type App, type AppConfig, type ThemeDefinition } from "@rezi-ui/core"
import type { NodeBackend, NodeAppConfig } from "@rezi-ui/node"
import { createNodeBackendInlineInternal } from "./send-node-backend-inline.js"

export type SendNodeAppConfig = NodeAppConfig & { idlePollMs?: number }
export type SendNodeApp<S> = App<S> & Readonly<{ backend: NodeBackend; isNoColor: boolean }>

const createNoColorTheme = (theme?: ThemeDefinition): ThemeDefinition => {
  const base = theme ?? darkTheme
  const mono = base.colors.fg.primary
  return Object.freeze({
    ...base,
    colors: Object.freeze({
      ...base.colors,
      accent: Object.freeze({ primary: mono, secondary: mono, tertiary: mono }),
      success: mono,
      warning: mono,
      error: mono,
      info: mono,
      focus: Object.freeze({ ring: mono, bg: base.colors.bg.base }),
      selected: Object.freeze({ bg: base.colors.bg.base, fg: mono }),
      disabled: Object.freeze({ fg: mono, bg: base.colors.bg.base }),
      diagnostic: Object.freeze({ error: mono, warning: mono, info: mono, hint: mono }),
      border: Object.freeze({ subtle: mono, default: mono, strong: mono }),
    }),
    widget: Object.freeze({
      ...base.widget,
      syntax: Object.freeze({
        ...base.widget.syntax,
        keyword: mono,
        type: mono,
        string: mono,
        number: mono,
        comment: mono,
        operator: mono,
        punctuation: mono,
        function: mono,
        variable: mono,
        cursorFg: base.colors.bg.base,
        cursorBg: mono,
      }),
      diff: Object.freeze({
        ...base.widget.diff,
        addBg: base.colors.bg.base,
        deleteBg: base.colors.bg.base,
        addFg: mono,
        deleteFg: mono,
        hunkHeader: mono,
        lineNumber: mono,
        border: mono,
      }),
      logs: Object.freeze({
        ...base.widget.logs,
        trace: mono,
        debug: mono,
        info: mono,
        warn: mono,
        error: mono,
      }),
      toast: Object.freeze({
        ...base.widget.toast,
        info: mono,
        success: mono,
        warning: mono,
        error: mono,
      }),
      chart: Object.freeze({
        ...base.widget.chart,
        primary: mono,
        accent: mono,
        muted: mono,
        success: mono,
        warning: mono,
        danger: mono,
      }),
    }),
  })
}

const readProcessEnv = () => {
  const processRef = globalThis.process
  if (!processRef || typeof processRef !== "object") return null
  const env = processRef.env
  return env && typeof env === "object" ? env : null
}

const hasNoColorEnv = (env: Record<string, string | undefined> | null) => !!env && Object.prototype.hasOwnProperty.call(env, "NO_COLOR")

const toAppConfig = (config?: SendNodeAppConfig): AppConfig | undefined => config ? {
  ...(config.fpsCap !== undefined ? { fpsCap: config.fpsCap } : {}),
  ...(config.maxDrawlistBytes !== undefined ? { maxDrawlistBytes: config.maxDrawlistBytes } : {}),
  ...(config.rootPadding !== undefined ? { rootPadding: config.rootPadding } : {}),
  ...(config.breakpoints !== undefined ? { breakpoints: config.breakpoints } : {}),
  ...(config.drawlistValidateParams !== undefined ? { drawlistValidateParams: config.drawlistValidateParams } : {}),
  ...(config.drawlistReuseOutputBuffer !== undefined ? { drawlistReuseOutputBuffer: config.drawlistReuseOutputBuffer } : {}),
  ...(config.drawlistEncodedStringCacheCap !== undefined ? { drawlistEncodedStringCacheCap: config.drawlistEncodedStringCacheCap } : {}),
  ...(config.maxFramesInFlight !== undefined ? { maxFramesInFlight: config.maxFramesInFlight } : {}),
  ...(config.themeTransitionFrames !== undefined ? { themeTransitionFrames: config.themeTransitionFrames } : {}),
  ...(config.internal_onRender !== undefined ? { internal_onRender: config.internal_onRender } : {}),
  ...(config.internal_onLayout !== undefined ? { internal_onLayout: config.internal_onLayout } : {}),
} : undefined

export const createSendNodeApp = <S>(opts: Readonly<{ initialState: S; config?: SendNodeAppConfig; theme?: ThemeDefinition }>): SendNodeApp<S> => {
  const backend = createNodeBackendInlineInternal({
    config: {
      ...(opts.config?.fpsCap !== undefined ? { fpsCap: opts.config.fpsCap } : {}),
      ...(opts.config?.executionMode !== undefined ? { executionMode: opts.config.executionMode } : {}),
      ...(opts.config?.frameTransport !== undefined ? { frameTransport: opts.config.frameTransport } : {}),
      ...(opts.config?.frameSabSlotCount !== undefined ? { frameSabSlotCount: opts.config.frameSabSlotCount } : {}),
      ...(opts.config?.frameSabSlotBytes !== undefined ? { frameSabSlotBytes: opts.config.frameSabSlotBytes } : {}),
      ...(opts.config?.nativeConfig !== undefined ? { nativeConfig: opts.config.nativeConfig } : {}),
      ...(opts.config?.emojiWidthPolicy !== undefined ? { emojiWidthPolicy: opts.config.emojiWidthPolicy } : {}),
      ...(opts.config?.idlePollMs !== undefined ? { idlePollMs: opts.config.idlePollMs } : {}),
    },
  }) as NodeBackend
  const isNoColor = hasNoColorEnv(readProcessEnv())
  const theme = isNoColor ? createNoColorTheme(opts.theme) : opts.theme
  const app = createApp<S>({
    backend,
    initialState: opts.initialState,
    ...(toAppConfig(opts.config) ? { config: toAppConfig(opts.config) } : {}),
    ...(theme ? { theme } : {}),
  })
  return Object.defineProperties(app, {
    backend: { value: backend, enumerable: true, configurable: false, writable: false },
    isNoColor: { value: isNoColor, enumerable: true, configurable: false, writable: false },
  }) as SendNodeApp<S>
}
