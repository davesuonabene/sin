const audioBufferCache = new Map<string, Promise<AudioBuffer | null>>();
const resolvedAudioBuffers = new Map<string, AudioBuffer>();
const audioPeaksCache = new Map<string, Promise<AudioPeaksResult | null>>();
const MAX_CLIENT_DECODE_BYTES = 12 * 1024 * 1024; // Never freeze Chrome decoding 90 MB / 1h+ tracks into ~900 MB PCM!
let sharedAudioContext: AudioContext | null = null;

export interface AudioPeaksResult {
    peaks: Float32Array;
    durationSeconds: number;
    startSec: number;
    endSec: number;
}

export async function fetchAudioPeaks(
    filepath: string,
    options: { columns?: number; startSec?: number; endSec?: number } = {}
): Promise<AudioPeaksResult | null> {
    if (!filepath) return null;
    const cols = Math.max(32, Math.min(2048, Math.floor(options.columns ?? 1024)));
    const sSec = Math.max(0, Number(options.startSec ?? 0) || 0);
    const eSec = Math.max(0, Number(options.endSec ?? 0) || 0);
    const cacheKey = `${filepath}|${cols}|${sSec.toFixed(2)}|${eSec.toFixed(2)}`;
    const existing = audioPeaksCache.get(cacheKey);
    if (existing) return existing;

    const promise = (async (): Promise<AudioPeaksResult | null> => {
        try {
            const params = new URLSearchParams({
                filepath,
                columns: String(cols),
                start_sec: String(sSec),
                end_sec: String(eSec),
            });
            const res = await fetch(`/api/audio/peaks?${params.toString()}`);
            if (!res.ok) return null;
            const data = await res.json();
            if (!Array.isArray(data?.peaks) || data.peaks.length < 2) return null;
            return {
                peaks: Float32Array.from(data.peaks),
                durationSeconds: Number(data.duration_seconds) || 0,
                startSec: Number(data.start_sec) || sSec,
                endSec: Number(data.end_sec) || Number(data.duration_seconds) || eSec,
            };
        } catch {
            return null;
        }
    })();

    audioPeaksCache.set(cacheKey, promise);
    if (audioPeaksCache.size > 64) {
        const oldest = audioPeaksCache.keys().next().value;
        if (oldest !== undefined) audioPeaksCache.delete(oldest);
    }
    return promise;
}

export function getSharedAudioContext(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return null;
    if (!sharedAudioContext || (sharedAudioContext as any).state === 'closed') {
        sharedAudioContext = new AudioCtx();
    }
    return sharedAudioContext;
}

export async function ensureSharedAudioContextReady(): Promise<AudioContext | null> {
    const ctx = getSharedAudioContext();
    if (ctx && ctx.state === 'suspended' && typeof ctx.resume === 'function') {
        try {
            await ctx.resume();
        } catch {
            // Ignore resume failures in headless or restricted environments
        }
    }
    return ctx;
}

export function getCachedAudioBufferSync(filepath: string): AudioBuffer | null {
    if (!filepath) return null;
    return resolvedAudioBuffers.get(filepath) ?? null;
}

export async function fetchAudioBuffer(filepath: string): Promise<AudioBuffer | null> {
    if (!filepath) return null;
    if (resolvedAudioBuffers.has(filepath)) {
        return resolvedAudioBuffers.get(filepath)!;
    }
    if (audioBufferCache.has(filepath)) {
        return audioBufferCache.get(filepath)!;
    }

    const promise = (async () => {
        try {
            const ctx = getSharedAudioContext();
            if (!ctx) return null;

            let url = filepath;
            if (!filepath.startsWith('http') && !filepath.startsWith('/api') && !filepath.startsWith('/assets')) {
                url = `/api/audio/file?filepath=${encodeURIComponent(filepath)}`;
            }

            const response = await fetch(url);
            if (!response.ok) return null;
            const contentLen = Number(response.headers.get('content-length') || 0);
            if (contentLen > MAX_CLIENT_DECODE_BYTES) {
                try { await response.body?.cancel(); } catch {}
                return null;
            }
            const arrayBuffer = await response.arrayBuffer();
            if (arrayBuffer.byteLength > MAX_CLIENT_DECODE_BYTES) {
                return null;
            }
            const decoded = await ctx.decodeAudioData(arrayBuffer);
            if (decoded) {
                resolvedAudioBuffers.set(filepath, decoded);
            }
            return decoded;
        } catch (error) {
            console.warn(`[audioBufferCache] Failed to decode audio for ${filepath}:`, error);
            return null;
        }
    })();

    audioBufferCache.set(filepath, promise);
    return promise;
}

export function cacheAudioBuffer(key: string, buffer: AudioBuffer): void {
    resolvedAudioBuffers.set(key, buffer);
    audioBufferCache.set(key, Promise.resolve(buffer));
}

export function clearAudioBufferCache(): void {
    resolvedAudioBuffers.clear();
    audioBufferCache.clear();
    audioPeaksCache.clear();
}
