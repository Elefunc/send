import { ZrUiError } from "@rezi-ui/core";
export const DEBUG_QUERY_DEFAULT_RECORDS = 4096;
export const DEBUG_QUERY_MAX_RECORDS = 16384;
const MAX_DEBUG_BYTES_RETRY_CAP = 64 << 20;
export function readDebugBytesWithRetry(read, initialCapacity, emptyValue, operation) {
    const baseCapacity = Number.isFinite(initialCapacity) ? Math.floor(initialCapacity) : 1;
    let capacity = Math.min(MAX_DEBUG_BYTES_RETRY_CAP, Math.max(1, baseCapacity));
    while (true) {
        const out = new Uint8Array(capacity);
        const written = read(out);
        if (!Number.isInteger(written) || written > out.byteLength) {
            throw new ZrUiError("ZRUI_BACKEND_ERROR", `${operation} returned invalid byte count: written=${String(written)} capacity=${String(out.byteLength)}`);
        }
        if (written <= 0) {
            return emptyValue;
        }
        if (written < out.byteLength) {
            return out.slice(0, written);
        }
        if (capacity >= MAX_DEBUG_BYTES_RETRY_CAP) {
            // Native debug APIs return written byte count but not total required size.
            // If the output exactly fills our max-cap buffer, it's likely truncated.
            process.emitWarning(`[rezi][debug] ${operation} filled ${String(capacity)} bytes at max cap; payload may be truncated.`);
            return out.slice(0, written);
        }
        capacity = Math.min(MAX_DEBUG_BYTES_RETRY_CAP, capacity * 2);
    }
}
//# sourceMappingURL=backendSharedDebug.js.map