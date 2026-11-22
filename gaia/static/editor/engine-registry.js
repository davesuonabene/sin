const FALLBACK_REGISTRY = {
    ephemeral_default_engine: 'simple_media',
    engines: [
        {
            id: 'sin',
            label: 'SIN Node Editor',
            description: 'Node-graph audio synthesis, routing, snapshots, and multi-track arrangement.',
            supported_kinds: ['audio'],
            supports_ephemeral: false,
        },
        {
            id: 'simple_media',
            label: 'Simple Media Editor',
            description: 'Single-channel FFmpeg-backed trimmer, multi-cut slicer, and exporter for audio & video.',
            supported_kinds: ['audio', 'video'],
            supports_ephemeral: true,
        },
    ],
    project_kinds: [
        {
            id: 'audio',
            label: 'Audio',
            default_engine: 'sin',
            allowed_engines: ['sin', 'simple_media'],
            media_types: ['audio', 'multitrack', 'sample', 'track', 'zoom_h4'],
            description: 'Audio project defaulting to the SIN Node Editor.',
        },
        {
            id: 'video',
            label: 'Video',
            default_engine: 'simple_media',
            allowed_engines: ['simple_media'],
            media_types: ['video'],
            description: 'Video project using the Simple Media Editor.',
        },
    ],
};

let cachedRegistry = FALLBACK_REGISTRY;
let pendingPromise = null;

export async function fetchRegistry(force = false) {
    if (!force && pendingPromise) return pendingPromise;
    pendingPromise = (async () => {
        try {
            const response = await fetch('/editor/engines');
            if (response.ok) {
                const payload = await response.json();
                if (payload && Array.isArray(payload.engines) && Array.isArray(payload.project_kinds)) {
                    cachedRegistry = payload;
                }
            }
        } catch (err) {
            console.warn('Could not load editor engine registry, using defaults:', err);
        }
        return cachedRegistry;
    })();
    return pendingPromise;
}

export function getCachedRegistry() {
    return cachedRegistry;
}

export function getKindSpec(kind, registry = cachedRegistry) {
    const normalized = String(kind || 'audio').toLowerCase();
    return (
        registry.project_kinds.find(spec => spec.id === normalized)
        || registry.project_kinds[0]
        || FALLBACK_REGISTRY.project_kinds[0]
    );
}

export function defaultEngineForKind(kind, registry = cachedRegistry) {
    return getKindSpec(kind, registry).default_engine || 'sin';
}

export function allowedEnginesForKind(kind, registry = cachedRegistry) {
    const spec = getKindSpec(kind, registry);
    const allowedIds = new Set(spec.allowed_engines || []);
    return registry.engines.filter(engine => allowedIds.has(engine.id));
}

export function isEngineAllowedForKind(kind, engineId, registry = cachedRegistry) {
    const spec = getKindSpec(kind, registry);
    return (spec.allowed_engines || []).includes(String(engineId || '').toLowerCase());
}

export function inferProjectKindFromEntries(entries = []) {
    for (const entry of entries || []) {
        if (!entry) continue;
        const item = entry.item || entry;
        if (item.type === 'video' || entry.type === 'video') return 'video';
        if (item.project_kind === 'video' || entry.project_kind === 'video') return 'video';
        const contents = item.contents || entry.contents || [];
        for (const child of contents) {
            if (child?.type === 'video') return 'video';
        }
    }
    return 'audio';
}
