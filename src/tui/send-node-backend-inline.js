/**
 * Inline (single-thread) Node RuntimeBackend implementation.
 *
 * This path removes the worker-thread hop and submits frames directly from the
 * main thread. It is intentionally optimized for low-latency transport and is
 * selected explicitly via `executionMode: "inline"`.
 */
import { performance } from "node:perf_hooks";
import { DEFAULT_TERMINAL_CAPS } from "@rezi-ui/core";
import { ZR_DRAWLIST_VERSION_V1, ZR_ENGINE_ABI_MAJOR, ZR_ENGINE_ABI_MINOR, ZR_ENGINE_ABI_PATCH, ZR_EVENT_BATCH_VERSION_V1, ZrUiError, setTextMeasureEmojiPolicy, severityToNum, } from "@rezi-ui/core";
import { createFrameAuditLogger, drawlistFingerprint, maybeDumpDrawlistBytes, } from "./rezi-node/frameAudit.js";
import { DEFAULT_FPS_CAP, DEFAULT_MAX_EVENT_BYTES, MAX_SAFE_EVENT_BYTES, MAX_SAFE_FPS_CAP, normalizeBackendNativeConfig, parseBoundedPositiveIntOrThrow, parsePositiveIntOr, resolveTargetFps, } from "./rezi-node/backend/backendSharedConfig.js";
import { DEBUG_QUERY_DEFAULT_RECORDS, DEBUG_QUERY_MAX_RECORDS, readDebugBytesWithRetry, } from "./rezi-node/backend/backendSharedDebug.js";
import { attachBackendMarkers } from "./rezi-node/backend/backendSharedMarkers.js";
import { applyEmojiWidthPolicy, resolveBackendEmojiWidthPolicy } from "./rezi-node/backend/emojiWidthPolicy.js";
import { terminalProfileFromNodeEnv } from "./rezi-node/backend/terminalProfile.js";
const EVENT_POOL_SIZE = 16;
const DEFAULT_POLL_IDLE_MS = 50;
const POLL_BUSY_MS = 0;
const ZR_ERR_LIMIT = -3;
const WIDTH_POLICY_KEY = "widthPolicy";
const RESOLVED_VOID = Promise.resolve();
const SYNC_FRAME_ACK_MARKER = "__reziSyncFrameAck";
const RESOLVED_SYNC_FRAME_ACK = Promise.resolve();
Object.defineProperty(RESOLVED_SYNC_FRAME_ACK, SYNC_FRAME_ACK_MARKER, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
});
const PERF_ENABLED = process.env.REZI_PERF === "1";
const PERF_MAX_SAMPLES = 1024;
function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = (err) => rej(err instanceof Error ? err : new Error(String(err)));
    });
    return { promise, resolve, reject };
}
function safeErr(err) {
    return err instanceof Error ? err : new Error(String(err));
}
function safeDetail(err) {
    if (err instanceof Error)
        return `${err.name}: ${err.message}`;
    return String(err);
}
// Little-endian u32 magic for bytes "ZREV".
const ZREV_MAGIC = 0x5645525a;
const ZREV_RECORD_RESIZE = 5;
function writeResizeBatchV1(buf, cols, rows) {
    // Batch header (24) + RESIZE record (32) = 56 bytes.
    const totalSize = 56;
    if (buf.byteLength < totalSize)
        return 0;
    const dv = new DataView(buf);
    const timeMs = (Date.now() >>> 0) & 0xffff_ffff;
    dv.setUint32(0, ZREV_MAGIC, true);
    dv.setUint32(4, ZR_EVENT_BATCH_VERSION_V1, true);
    dv.setUint32(8, totalSize, true);
    dv.setUint32(12, 1, true); // event_count
    dv.setUint32(16, 0, true); // batch_flags
    dv.setUint32(20, 0, true); // reserved0
    dv.setUint32(24, ZREV_RECORD_RESIZE, true);
    dv.setUint32(28, 32, true); // record_size
    dv.setUint32(32, timeMs, true);
    dv.setUint32(36, 0, true); // flags
    dv.setUint32(40, cols >>> 0, true);
    dv.setUint32(44, rows >>> 0, true);
    dv.setUint32(48, 0, true);
    dv.setUint32(52, 0, true);
    return totalSize;
}
async function loadNative(shimModule) {
    const unwrap = (m) => {
        if (typeof m === "object" && m !== null) {
            const rec = m;
            const candidate = (rec.native ?? rec.default ?? rec);
            return candidate;
        }
        return m;
    };
    if (typeof shimModule === "string" && shimModule.length > 0) {
        return unwrap((await import(shimModule)));
    }
    try {
        return unwrap((await import("@rezi-ui/native")));
    }
    catch (err) {
        const detail = safeDetail(err);
        throw new Error(`Failed to load @rezi-ui/native.\n\nThis usually means the native addon was not built or not installed for this platform.\n\n${detail}`);
    }
}
export function createNodeBackendInlineInternal(opts = {}) {
    const frameAudit = createFrameAuditLogger("backend-inline");
    const cfg = opts.config ?? {};
    const requestedDrawlistVersion = ZR_DRAWLIST_VERSION_V1;
    const fpsCap = parseBoundedPositiveIntOrThrow("fpsCap", cfg.fpsCap, DEFAULT_FPS_CAP, MAX_SAFE_FPS_CAP);
    const maxEventBytes = parseBoundedPositiveIntOrThrow("maxEventBytes", cfg.maxEventBytes, DEFAULT_MAX_EVENT_BYTES, MAX_SAFE_EVENT_BYTES);
    const pollIdleMs = parsePositiveIntOr(cfg.idlePollMs, DEFAULT_POLL_IDLE_MS);
    const nativeConfig = normalizeBackendNativeConfig(cfg.nativeConfig);
    const nativeTargetFps = resolveTargetFps(fpsCap, nativeConfig);
    const initConfigBase = {
        ...nativeConfig,
        // fpsCap is the single frame-scheduling knob; native target fps must align.
        targetFps: nativeTargetFps,
        requestedEngineAbiMajor: ZR_ENGINE_ABI_MAJOR,
        requestedEngineAbiMinor: ZR_ENGINE_ABI_MINOR,
        requestedEngineAbiPatch: ZR_ENGINE_ABI_PATCH,
        requestedDrawlistVersion: requestedDrawlistVersion,
        requestedEventBatchVersion: ZR_EVENT_BATCH_VERSION_V1,
    };
    let initConfigResolved = null;
    let native = null;
    let nativePromise = null;
    let engineId = null;
    let started = false;
    let disposed = false;
    let stopRequested = false;
    let fatal = null;
    let startDef = null;
    let startSettled = false;
    let stopDef = null;
    let stopSettled = false;
    let eventQueue = [];
    const eventWaiters = [];
    let eventPool = [];
    let discardBuffer = null;
    let droppedSinceLast = 0;
    let pollTimer = null;
    let pollImmediate = null;
    let pollActive = false;
    const perfSamples = [];
    let cachedCaps = null;
    let nextFrameSeq = 1;
    function perfRecord(phase, durationMs) {
        if (!PERF_ENABLED)
            return;
        if (perfSamples.length >= PERF_MAX_SAMPLES) {
            perfSamples.shift();
        }
        perfSamples.push({ phase, durationMs });
    }
    function perfSnapshot() {
        const byPhase = new Map();
        for (const s of perfSamples) {
            let arr = byPhase.get(s.phase);
            if (!arr) {
                arr = [];
                byPhase.set(s.phase, arr);
            }
            arr.push(s.durationMs);
        }
        const phases = {};
        for (const [phase, samples] of byPhase) {
            const sorted = [...samples].sort((a, b) => a - b);
            const sum = sorted.reduce((acc, v) => acc + v, 0);
            const p50Idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.5));
            const p95Idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
            const p99Idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99));
            const worst10Start = Math.max(0, sorted.length - 10);
            const worst10 = sorted.slice(worst10Start).reverse();
            phases[phase] = {
                count: sorted.length,
                avg: sorted.length > 0 ? sum / sorted.length : 0,
                p50: sorted[p50Idx] ?? 0,
                p95: sorted[p95Idx] ?? 0,
                p99: sorted[p99Idx] ?? 0,
                max: sorted[sorted.length - 1] ?? 0,
                worst10,
            };
        }
        return { phases };
    }
    function rejectWaiters(err) {
        while (eventWaiters.length > 0)
            eventWaiters.shift()?.reject(err);
        eventQueue = [];
        if (startDef !== null && !startSettled) {
            startSettled = true;
            startDef.reject(err);
        }
        if (stopDef !== null && !stopSettled) {
            stopSettled = true;
            stopDef.reject(err);
        }
    }
    function failWith(where, code, detail) {
        if (frameAudit.enabled) {
            frameAudit.emit("fatal", { where, code, detail });
        }
        const err = new ZrUiError("ZRUI_BACKEND_ERROR", `${where} (${String(code)}): ${detail}`);
        fatal = err;
        rejectWaiters(err);
    }
    function clearPollLoop() {
        if (pollTimer !== null) {
            clearTimeout(pollTimer);
            pollTimer = null;
        }
        if (pollImmediate !== null) {
            clearImmediate(pollImmediate);
            pollImmediate = null;
        }
        pollActive = false;
    }
    function schedulePoll(delayMs) {
        if (!started || disposed || stopRequested || fatal !== null)
            return;
        if (pollImmediate !== null || pollTimer !== null)
            return;
        if (delayMs <= 0) {
            pollImmediate = setImmediate(() => {
                pollImmediate = null;
                runPollOnce();
            });
            return;
        }
        pollTimer = setTimeout(() => {
            pollTimer = null;
            runPollOnce();
        }, delayMs);
    }
    function buildBatch(buf, byteLen, dropped) {
        const bytes = new Uint8Array(buf, 0, byteLen);
        let released = false;
        return {
            bytes,
            droppedBatches: dropped,
            release: () => {
                if (released)
                    return;
                released = true;
                if (!started || disposed)
                    return;
                eventPool.push(buf);
            },
        };
    }
    function emitInitialResizeIfPossible() {
        if (!started || discardBuffer === null)
            return;
        // Keep test-shim runs deterministic (mirrors worker backend behavior).
        if (typeof opts.nativeShimModule === "string" && opts.nativeShimModule.length > 0)
            return;
        const cols = typeof process.stdout.columns === "number" &&
            Number.isInteger(process.stdout.columns) &&
            process.stdout.columns > 0
            ? process.stdout.columns
            : 80;
        const rows = typeof process.stdout.rows === "number" &&
            Number.isInteger(process.stdout.rows) &&
            process.stdout.rows > 0
            ? process.stdout.rows
            : 24;
        const buf = eventPool.pop() ?? new ArrayBuffer(maxEventBytes);
        const byteLen = writeResizeBatchV1(buf, cols, rows);
        if (byteLen <= 0) {
            eventPool.push(buf);
            return;
        }
        const waiter = eventWaiters.shift();
        if (waiter !== undefined) {
            waiter.resolve(buildBatch(buf, byteLen, 0));
            return;
        }
        eventQueue.push({ batch: buf, byteLen, droppedSinceLast: 0 });
    }
    function runPollOnce() {
        if (!started || disposed || stopRequested || fatal !== null)
            return;
        if (engineId === null || native === null || discardBuffer === null)
            return;
        if (pollActive)
            return;
        pollActive = true;
        try {
            const outBuf = eventPool.length > 0 ? (eventPool.pop() ?? discardBuffer) : discardBuffer;
            let written = -1;
            const startMs = PERF_ENABLED ? performance.now() : 0;
            try {
                written = native.enginePollEvents(engineId, 0, new Uint8Array(outBuf));
            }
            catch (err) {
                failWith("enginePollEvents", -1, `engine_poll_events threw: ${safeDetail(err)}`);
                return;
            }
            if (PERF_ENABLED) {
                perfRecord("event_poll", performance.now() - startMs);
            }
            if (written === ZR_ERR_LIMIT) {
                if (outBuf !== discardBuffer)
                    eventPool.push(outBuf);
                droppedSinceLast++;
                schedulePoll(POLL_BUSY_MS);
                return;
            }
            if (!Number.isInteger(written) || written > outBuf.byteLength) {
                if (outBuf !== discardBuffer)
                    eventPool.push(outBuf);
                failWith("enginePollEvents", -1, `engine_poll_events returned invalid byte count: written=${String(written)} capacity=${String(outBuf.byteLength)}`);
                return;
            }
            if (written < 0) {
                if (outBuf !== discardBuffer)
                    eventPool.push(outBuf);
                failWith("enginePollEvents", written, "engine_poll_events failed");
                return;
            }
            if (written === 0) {
                if (outBuf !== discardBuffer)
                    eventPool.push(outBuf);
                schedulePoll(pollIdleMs);
                return;
            }
            if (outBuf === discardBuffer) {
                droppedSinceLast++;
                schedulePoll(POLL_BUSY_MS);
                return;
            }
            const waiter = eventWaiters.shift();
            if (waiter !== undefined) {
                waiter.resolve(buildBatch(outBuf, written, droppedSinceLast));
            }
            else {
                eventQueue.push({ batch: outBuf, byteLen: written, droppedSinceLast });
            }
            droppedSinceLast = 0;
            schedulePoll(POLL_BUSY_MS);
        }
        finally {
            pollActive = false;
        }
    }
    async function ensureNativeLoaded() {
        if (native !== null)
            return native;
        if (nativePromise !== null)
            return nativePromise;
        nativePromise = loadNative(opts.nativeShimModule).then((mod) => {
            native = mod;
            return mod;
        });
        return nativePromise;
    }
    function ensureDebugApiLoaded(api) {
        if (typeof api.engineDebugEnable !== "function") {
            throw new Error("inline backend: native debug API is unavailable");
        }
        if (typeof api.engineDebugDisable !== "function") {
            throw new Error("inline backend: native debug API is unavailable");
        }
        if (typeof api.engineDebugQuery !== "function") {
            throw new Error("inline backend: native debug API is unavailable");
        }
        if (typeof api.engineDebugGetPayload !== "function") {
            throw new Error("inline backend: native debug API is unavailable");
        }
        if (typeof api.engineDebugGetStats !== "function") {
            throw new Error("inline backend: native debug API is unavailable");
        }
        if (typeof api.engineDebugExport !== "function") {
            throw new Error("inline backend: native debug API is unavailable");
        }
        if (typeof api.engineDebugReset !== "function") {
            throw new Error("inline backend: native debug API is unavailable");
        }
        return api;
    }
    const backend = {
        async start() {
            if (disposed)
                throw new Error("NodeBackend(inline): disposed");
            if (fatal !== null)
                throw fatal;
            if (started)
                return;
            if (startDef !== null) {
                await startDef.promise;
                return;
            }
            startDef = deferred();
            startSettled = false;
            stopRequested = false;
            try {
                if (initConfigResolved === null) {
                    const resolvedEmojiWidthPolicy = await resolveBackendEmojiWidthPolicy(cfg.emojiWidthPolicy, nativeConfig);
                    const nativeWidthPolicy = applyEmojiWidthPolicy(resolvedEmojiWidthPolicy);
                    initConfigResolved = {
                        ...initConfigBase,
                        widthPolicy: nativeWidthPolicy,
                    };
                }
                else {
                    const widthPolicy = initConfigResolved[WIDTH_POLICY_KEY];
                    if (typeof widthPolicy === "number") {
                        setTextMeasureEmojiPolicy(widthPolicy === 0 ? "narrow" : "wide");
                    }
                }
                const api = await ensureNativeLoaded();
                let id = 0;
                try {
                    id = api.engineCreate(initConfigResolved);
                }
                catch (err) {
                    throw new Error(`engine_create threw: ${safeDetail(err)}`);
                }
                if (!Number.isInteger(id) || id <= 0) {
                    throw new Error(`engine_create failed: code=${String(id)}`);
                }
                engineId = id;
                started = true;
                if (frameAudit.enabled) {
                    frameAudit.emit("engine.ready", {
                        engineId: id,
                        executionMode: "inline",
                        fpsCap,
                        maxEventBytes,
                    });
                }
                cachedCaps = null;
                eventQueue = [];
                eventPool = [];
                for (let i = 0; i < EVENT_POOL_SIZE; i++) {
                    eventPool.push(new ArrayBuffer(maxEventBytes));
                }
                discardBuffer = new ArrayBuffer(maxEventBytes);
                droppedSinceLast = 0;
                emitInitialResizeIfPossible();
                    schedulePoll(pollIdleMs);
                if (!startSettled && startDef !== null) {
                    startSettled = true;
                    startDef.resolve();
                }
            }
            catch (err) {
                const e = safeErr(err);
                fatal = new ZrUiError("ZRUI_BACKEND_ERROR", e.message);
                rejectWaiters(fatal);
            }
            if (startDef === null)
                throw new Error("NodeBackend(inline): invariant startDef");
            await startDef.promise;
            startDef = null;
        },
        async stop() {
            if (disposed)
                return;
            if (fatal !== null)
                throw fatal;
            if (!started)
                return;
            if (stopDef !== null) {
                await stopDef.promise;
                return;
            }
            stopDef = deferred();
            stopSettled = false;
            stopRequested = true;
            clearPollLoop();
            const stopErr = new Error("NodeBackend(inline): stopped");
            while (eventWaiters.length > 0)
                eventWaiters.shift()?.reject(stopErr);
            eventQueue = [];
            if (engineId !== null && native !== null) {
                try {
                    native.engineDestroy(engineId);
                }
                catch {
                    // best effort on stop
                }
            }
            engineId = null;
            started = false;
            if (!stopSettled && stopDef !== null) {
                stopSettled = true;
                stopDef.resolve();
            }
            await stopDef.promise;
            stopDef = null;
        },
        dispose() {
            if (disposed)
                return;
            disposed = true;
            clearPollLoop();
            stopRequested = true;
            if (engineId !== null && native !== null) {
                try {
                    native.engineDestroy(engineId);
                }
                catch {
                    // ignore
                }
            }
            engineId = null;
            started = false;
            const err = new Error("NodeBackend(inline): disposed");
            while (eventWaiters.length > 0)
                eventWaiters.shift()?.reject(err);
            eventQueue = [];
            if (startDef !== null && !startSettled) {
                startSettled = true;
                startDef.reject(err);
            }
            if (stopDef !== null && !stopSettled) {
                stopSettled = true;
                stopDef.reject(err);
            }
        },
        requestFrame(drawlist) {
            if (disposed)
                return Promise.reject(new Error("NodeBackend(inline): disposed"));
            if (fatal !== null)
                return Promise.reject(fatal);
            if (stopRequested)
                return Promise.reject(new Error("NodeBackend(inline): stopped"));
            if (!started) {
                return backend.start().then(() => backend.requestFrame(drawlist));
            }
            if (native === null || engineId === null) {
                return Promise.reject(new Error("NodeBackend(inline): engine not started"));
            }
            try {
                const frameSeq = nextFrameSeq++;
                const fp = frameAudit.enabled ? drawlistFingerprint(drawlist) : null;
                maybeDumpDrawlistBytes("backend-inline", "requestFrame", frameSeq, drawlist);
                if (fp !== null) {
                    frameAudit.emit("frame.submitted", {
                        frameSeq,
                        submitPath: "requestFrame",
                        transport: "inline-v1",
                        ...fp,
                    });
                    frameAudit.emit("frame.submit.payload", {
                        frameSeq,
                        transport: "inline-v1",
                        ...fp,
                    });
                }
                const submitRc = native.engineSubmitDrawlist(engineId, drawlist);
                if (frameAudit.enabled) {
                    frameAudit.emit("frame.submit.result", {
                        frameSeq,
                        submitResult: submitRc,
                    });
                }
                if (submitRc < 0) {
                    if (frameAudit.enabled) {
                        frameAudit.emit("frame.completed", {
                            frameSeq,
                            completedResult: submitRc,
                        });
                    }
                    return Promise.reject(new ZrUiError("ZRUI_BACKEND_ERROR", `engine_submit_drawlist failed: code=${String(submitRc)}`));
                }
                if (frameAudit.enabled) {
                    frameAudit.emit("frame.accepted", { frameSeq });
                }
                const presentRc = native.enginePresent(engineId);
                if (frameAudit.enabled) {
                    frameAudit.emit("frame.present.result", {
                        frameSeq,
                        presentResult: presentRc,
                    });
                }
                if (presentRc < 0) {
                    if (frameAudit.enabled) {
                        frameAudit.emit("frame.completed", {
                            frameSeq,
                            completedResult: presentRc,
                        });
                    }
                    return Promise.reject(new ZrUiError("ZRUI_BACKEND_ERROR", `engine_present failed: code=${String(presentRc)}`));
                }
                if (frameAudit.enabled) {
                    frameAudit.emit("frame.completed", {
                        frameSeq,
                        completedResult: 0,
                    });
                }
            }
            catch (err) {
                if (frameAudit.enabled) {
                    frameAudit.emit("frame.throw", { detail: safeDetail(err) });
                }
                return Promise.reject(safeErr(err));
            }
            return RESOLVED_SYNC_FRAME_ACK;
        },
        pollEvents() {
            if (disposed)
                return Promise.reject(new Error("NodeBackend(inline): disposed"));
            if (fatal !== null)
                return Promise.reject(fatal);
            if (stopRequested)
                return Promise.reject(new Error("NodeBackend(inline): stopped"));
            const queued = eventQueue.shift();
            if (queued !== undefined) {
                return Promise.resolve(buildBatch(queued.batch, queued.byteLen, queued.droppedSinceLast));
            }
            const d = deferred();
            eventWaiters.push(d);
            schedulePoll(POLL_BUSY_MS);
            return d.promise;
        },
        postUserEvent(tag, payload) {
            if (disposed)
                throw new Error("NodeBackend(inline): disposed");
            if (fatal !== null)
                throw fatal;
            if (!started || engineId === null || native === null)
                throw new Error("NodeBackend(inline): not started");
            if (stopRequested)
                throw new Error("NodeBackend(inline): stopped");
            const rc = native.enginePostUserEvent(engineId, tag, payload);
            if (rc < 0) {
                throw new ZrUiError("ZRUI_BACKEND_ERROR", `engine_post_user_event failed: code=${String(rc)}`);
            }
        },
        async getCaps() {
            if (disposed)
                throw new Error("NodeBackend(inline): disposed");
            if (fatal !== null)
                throw fatal;
            if (cachedCaps !== null)
                return cachedCaps;
            if (!started || engineId === null || native === null)
                return DEFAULT_TERMINAL_CAPS;
            const caps = native.engineGetCaps(engineId);
            const nextCaps = Object.freeze({
                colorMode: caps.colorMode,
                supportsMouse: caps.supportsMouse,
                supportsBracketedPaste: caps.supportsBracketedPaste,
                supportsFocusEvents: caps.supportsFocusEvents,
                supportsOsc52: caps.supportsOsc52,
                supportsSyncUpdate: caps.supportsSyncUpdate,
                supportsScrollRegion: caps.supportsScrollRegion,
                supportsCursorShape: caps.supportsCursorShape,
                supportsOutputWaitWritable: caps.supportsOutputWaitWritable,
                supportsUnderlineStyles: caps.supportsUnderlineStyles ?? false,
                supportsColoredUnderlines: caps.supportsColoredUnderlines ?? false,
                supportsHyperlinks: caps.supportsHyperlinks ?? false,
                sgrAttrsSupported: caps.sgrAttrsSupported,
            });
            cachedCaps = nextCaps;
            return nextCaps;
        },
        async getTerminalProfile() {
            const caps = await backend.getCaps();
            return terminalProfileFromNodeEnv(caps);
        },
    };
    const debug = {
        debugEnable: async (config) => {
            await backend.start();
            if (native === null || engineId === null) {
                throw new Error("NodeBackend(inline): engine not started");
            }
            const dbg = ensureDebugApiLoaded(native);
            const minSeverity = config.minSeverity !== undefined ? severityToNum(config.minSeverity) : null;
            const configWire = {
                enabled: true,
                ...(config.ringCapacity !== undefined ? { ringCapacity: config.ringCapacity } : {}),
                ...(minSeverity !== null ? { minSeverity } : {}),
                ...(config.categoryMask !== undefined ? { categoryMask: config.categoryMask } : {}),
                ...(config.captureRawEvents !== undefined
                    ? { captureRawEvents: config.captureRawEvents }
                    : {}),
                ...(config.captureDrawlistBytes !== undefined
                    ? { captureDrawlistBytes: config.captureDrawlistBytes }
                    : {}),
            };
            const rc = dbg.engineDebugEnable(engineId, configWire);
            if (rc < 0) {
                throw new ZrUiError("ZRUI_BACKEND_ERROR", `engineDebugEnable failed: code=${String(rc)}`);
            }
        },
        debugDisable: async () => {
            await backend.start();
            if (native === null || engineId === null) {
                throw new Error("NodeBackend(inline): engine not started");
            }
            const dbg = ensureDebugApiLoaded(native);
            const rc = dbg.engineDebugDisable(engineId);
            if (rc < 0) {
                throw new ZrUiError("ZRUI_BACKEND_ERROR", `engineDebugDisable failed: code=${String(rc)}`);
            }
        },
        debugQuery: async (query) => {
            await backend.start();
            if (native === null || engineId === null) {
                throw new Error("NodeBackend(inline): engine not started");
            }
            const dbg = ensureDebugApiLoaded(native);
            const maxRecordsRaw = query.maxRecords === undefined ? DEBUG_QUERY_DEFAULT_RECORDS : query.maxRecords;
            const maxRecords = parsePositiveIntOr(maxRecordsRaw, DEBUG_QUERY_DEFAULT_RECORDS);
            const clampedMaxRecords = Math.min(DEBUG_QUERY_MAX_RECORDS, maxRecords);
            const queryWire = {
                ...(query.minRecordId !== undefined ? { minRecordId: query.minRecordId.toString() } : {}),
                ...(query.maxRecordId !== undefined ? { maxRecordId: query.maxRecordId.toString() } : {}),
                ...(query.categoryMask !== undefined ? { categoryMask: query.categoryMask } : {}),
                ...(query.minSeverity !== undefined
                    ? { minSeverity: severityToNum(query.minSeverity) }
                    : {}),
                maxRecords: clampedMaxRecords,
            };
            const headersCap = Math.max(1, clampedMaxRecords) * 40;
            const outHeaders = new Uint8Array(headersCap);
            const result = dbg.engineDebugQuery(engineId, queryWire, outHeaders);
            const headers = outHeaders.subarray(0, result.recordsReturned * 40);
            const wireResult = {
                recordsReturned: result.recordsReturned,
                recordsAvailable: result.recordsAvailable,
                oldestRecordId: result.oldestRecordId,
                newestRecordId: result.newestRecordId,
                recordsDropped: result.recordsDropped,
            };
            return { headers, result: wireResult };
        },
        debugGetPayload: async (recordId) => {
            await backend.start();
            const activeEngineId = engineId;
            if (native === null || activeEngineId === null) {
                throw new Error("NodeBackend(inline): engine not started");
            }
            const dbg = ensureDebugApiLoaded(native);
            return readDebugBytesWithRetry((out) => dbg.engineDebugGetPayload(activeEngineId, recordId, out), maxEventBytes, null, "engineDebugGetPayload");
        },
        debugGetStats: async () => {
            await backend.start();
            if (native === null || engineId === null) {
                throw new Error("NodeBackend(inline): engine not started");
            }
            const dbg = ensureDebugApiLoaded(native);
            const s = dbg.engineDebugGetStats(engineId);
            const out = {
                totalRecords: s.totalRecords,
                totalDropped: s.totalDropped,
                errorCount: s.errorCount,
                warnCount: s.warnCount,
                currentRingUsage: s.currentRingUsage,
                ringCapacity: s.ringCapacity,
            };
            return out;
        },
        debugExport: async () => {
            await backend.start();
            const activeEngineId = engineId;
            if (native === null || activeEngineId === null) {
                throw new Error("NodeBackend(inline): engine not started");
            }
            const dbg = ensureDebugApiLoaded(native);
            return readDebugBytesWithRetry((out) => dbg.engineDebugExport(activeEngineId, out), maxEventBytes, new Uint8Array(0), "engineDebugExport");
        },
        debugReset: async () => {
            await backend.start();
            if (native === null || engineId === null) {
                throw new Error("NodeBackend(inline): engine not started");
            }
            const dbg = ensureDebugApiLoaded(native);
            const rc = dbg.engineDebugReset(engineId);
            if (rc < 0) {
                throw new ZrUiError("ZRUI_BACKEND_ERROR", `engineDebugReset failed: code=${String(rc)}`);
            }
        },
    };
    const perf = {
        perfSnapshot: async () => perfSnapshot(),
    };
    return Object.freeze(attachBackendMarkers({ ...backend, debug, perf }, {
        requestedDrawlistVersion,
        maxEventBytes,
        fpsCap,
    }));
}
//# sourceMappingURL=nodeBackendInline.js.map
