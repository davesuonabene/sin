const audioBufferCache = new Map<string, Promise<AudioBuffer | null>>();
let sharedAudioContext: AudioContext | null = null;

function getSharedAudioContext(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    if (!sharedAudioContext) {
        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        if (AudioCtx) sharedAudioContext = new AudioCtx();
    }
    return sharedAudioContext;
}

export async function fetchAudioBuffer(filepath: string): Promise<AudioBuffer | null> {
    if (!filepath) return null;
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
            return await ctx.decodeAudioData(arrayBuffer);
        } catch (error) {
            console.warn(`[audioBufferCache] Failed to decode audio for ${filepath}:`, error);
            return null;
        }
    })();

    audioBufferCache.set(filepath, promise);
    return promise;
}

export function cacheAudioBuffer(key: string, buffer: AudioBuffer): void {
    audioBufferCache.set(key, Promise.resolve(buffer));
}

export function clearAudioBufferCache(): void {
    audioBufferCache.clear();
}
