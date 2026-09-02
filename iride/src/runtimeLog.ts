export type RuntimeLogLevel = 'common' | 'warning' | 'debug' | 'error';

export interface RuntimeLogEntry {
    id: number;
    timestamp: Date;
    level: RuntimeLogLevel;
    message: string;
}

type RuntimeLogListener = (
    entries: RuntimeLogEntry[],
    appendedEntries: RuntimeLogEntry[]
) => void;

const MAX_ENTRIES = 800;
const entries: RuntimeLogEntry[] = [];
const listeners = new Set<RuntimeLogListener>();
let nextId = 1;
let fetchLoggingInstalled = false;

function publish(appendedEntries: RuntimeLogEntry[] = []) {
    const snapshot = entries.slice();
    for (const listener of listeners) listener(snapshot, appendedEntries);
}

function appendEntries(nextEntries: Array<Omit<RuntimeLogEntry, 'id' | 'timestamp'>>): RuntimeLogEntry[] {
    const timestamp = new Date();
    const appended = nextEntries.map(entry => ({
        id: nextId++,
        timestamp,
        level: entry.level,
        message: entry.message
    }));
    entries.push(...appended);
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
    publish(appended);
    return appended;
}

export function runtimeLog(message: string, level: RuntimeLogLevel = 'common'): RuntimeLogEntry {
    return appendEntries([{ level, message }])[0];
}

export async function loggedTask<T>(label: string, task: () => Promise<T> | T): Promise<T> {
    const startedAt = performance.now();
    runtimeLog(`${label} started`, 'debug');
    try {
        const result = await task();
        runtimeLog(`${label} complete (${Math.round(performance.now() - startedAt)} ms)`, 'debug');
        return result;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        runtimeLog(`${label} failed (${Math.round(performance.now() - startedAt)} ms): ${message}`, 'error');
        throw error;
    }
}

/** Log every frontend fetch once, without recording bodies, headers, or asset data. */
export function installFetchLogging(): void {
    if (fetchLoggingInstalled || typeof window === 'undefined' || typeof window.fetch !== 'function') return;
    fetchLoggingInstalled = true;
    const originalFetch = window.fetch.bind(window);

    window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const request = input instanceof Request ? input : null;
        const method = String(init?.method || request?.method || 'GET').toUpperCase();
        const rawUrl = input instanceof Request ? input.url : String(input);
        let url = rawUrl;
        try {
            const parsed = new URL(rawUrl, window.location.href);
            url = `${parsed.pathname}${parsed.search}`;
        } catch {
            // Retain the original value for malformed/custom request schemes.
        }

        const startedAt = performance.now();
        try {
            const response = await originalFetch(input, init);
            const elapsed = Math.round(performance.now() - startedAt);
            const level: RuntimeLogLevel = response.ok
                ? 'debug'
                : response.status >= 500 ? 'error' : 'warning';
            // Publish after the request has been dispatched and completed. The
            // old start/end pair synchronously notified and rendered the log
            // before every request, doubling log work on asset-heavy screens.
            runtimeLog(`HTTP ${response.status} ${method} ${url} (${elapsed} ms)`, level);
            return response;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            runtimeLog(`HTTP failed ${method} ${url} (${Math.round(performance.now() - startedAt)} ms): ${message}`, 'error');
            throw error;
        }
    };
}

export interface ServerRuntimeLogEntry {
    level?: RuntimeLogLevel;
    message?: string;
    offset_ms?: number;
}

/** Replay ordered backend render events in the same terminal view. */
export function appendServerRuntimeLog(rawEntries: unknown): void {
    if (!Array.isArray(rawEntries)) return;
    const normalized: Array<Omit<RuntimeLogEntry, 'id' | 'timestamp'>> = [];
    for (const rawEntry of rawEntries as ServerRuntimeLogEntry[]) {
        if (!rawEntry || typeof rawEntry.message !== 'string') continue;
        const level: RuntimeLogLevel = ['common', 'warning', 'debug', 'error'].includes(String(rawEntry.level))
            ? rawEntry.level as RuntimeLogLevel
            : 'debug';
        const offset = Number(rawEntry.offset_ms);
        const prefix = Number.isFinite(offset) ? `SERVER +${offset.toFixed(1)} ms ` : 'SERVER ';
        normalized.push({ level, message: `${prefix}${rawEntry.message}` });
    }
    if (normalized.length > 0) appendEntries(normalized);
}

export function clearRuntimeLog(): void {
    entries.length = 0;
    publish([]);
}

export function subscribeRuntimeLog(listener: RuntimeLogListener): () => void {
    listeners.add(listener);
    listener(entries.slice(), []);
    return () => listeners.delete(listener);
}
