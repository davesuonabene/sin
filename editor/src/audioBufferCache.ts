const audioBufferCache = new Map<string, Promise<AudioBuffer | null>>();
const resolvedAudioBuffers = new Map<string, AudioBuffer>();
let sharedAudioContext: AudioContext | null = null;

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
            const arrayBuffer = await response.arrayBuffer();
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
}
