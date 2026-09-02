import type { ArrangementSourceVisual } from './ArrangementVisualizer';

type SourceNode = {
    type?: string | null;
    title?: string;
    properties?: Record<string, unknown>;
    inputs?: Array<{ link?: number | null }>;
};

function numberOrNull(value: unknown): number | null {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function normalizedRange(start: unknown, end: unknown): number {
    const startValue = Math.max(0, Math.min(1, numberOrNull(start) ?? 0));
    const endValue = Math.max(0, Math.min(1, numberOrNull(end) ?? 1));
    return Math.max(0, endValue - startValue);
}

/**
 * Resolve an accurate source block only when the direct input has a known
 * duration. Pools provide that duration through their active resolved item.
 */
export function resolveArrangementSourceVisual(node: SourceNode): ArrangementSourceVisual | null {
    const graph = (window as any).editorGraph;
    const links = graph?.links || {};
    const sourceIds = [...new Set((node.inputs || [])
        .map(input => input.link)
        .filter((linkId): linkId is number => linkId != null)
        .map(linkId => links[linkId])
        .filter((link: any) => link?.origin_id != null)
        .map((link: any) => link.origin_id))];

    // Multiple inputs are mixed by the engine, so a single-source block would
    // be misleading. Keep the visual in its settings-only state instead.
    if (sourceIds.length !== 1) return null;

    const source = graph?.getNodeById?.(sourceIds[0]) as SourceNode | null;
    if (!source) return null;
    const properties = source.properties || {};
    const pool = properties.asset_modifier_id != null
        ? graph?.getNodeById?.(properties.asset_modifier_id)
        : null;
    const poolProperties = pool?.properties || {};
    const activePoolPath = String(poolProperties.output_value || '');
    const selectedPoolItems = Array.isArray(poolProperties.selected_items) ? poolProperties.selected_items : [];
    const activePoolItem = selectedPoolItems.find((item: any) =>
        activePoolPath && (item.absolute_path || item.filepath) === activePoolPath
    ) || selectedPoolItems.find((item: any) =>
        poolProperties.output_item_id != null && String(item.id) === String(poolProperties.output_item_id)
    ) || (selectedPoolItems.length === 1 ? selectedPoolItems[0] : null);
    const timelineBpm = numberOrNull(node.properties?.target_bpm)
        ?? numberOrNull(node.properties?.bpm)
        ?? numberOrNull(graph?.extra?.global_parameters?.bpm)
        ?? 120;
    const label = String(activePoolItem?.name || properties.node_name || source.title || 'Source');

    if (source.type === 'Audio/Sequence') {
        const length = Array.isArray(properties.sequence) ? properties.sequence.length : 0;
        const stepLength = numberOrNull(properties.step_length) ?? 0;
        const bars = length * stepLength;
        return bars > 0 ? { bars, label, kind: 'sequence' } : null;
    }

    if (source.type === 'Audio/Arrangement') {
        const bars = numberOrNull(properties.total_bars);
        return bars != null && bars > 0 ? { bars, label, kind: 'loop' } : null;
    }

    if (source.type === 'Audio/Track') {
        const configuredLength = properties.total_bars === 'global'
            ? graph?.extra?.global_parameters?.total_bars
            : properties.total_bars;
        const bars = numberOrNull(configuredLength);
        return bars != null && bars > 0 ? { bars, label, kind: 'mixed' } : null;
    }

    if (source.type !== 'Audio/Sample') return null;

    const durationSeconds = numberOrNull(properties.duration_seconds)
        ?? numberOrNull(activePoolItem?.duration_seconds);
    if (durationSeconds == null || durationSeconds <= 0) return null;

    const crop = normalizedRange(properties.crop_start, properties.crop_end);
    if (crop <= 0) return null;

    const stretchFactor = Math.max(0.0001, numberOrNull(properties.stretch_factor) ?? 1);
    const sampleType = String(activePoolItem?.itemType || activePoolItem?.type || properties.sample_type || 'loop').toLowerCase();
    const stretchMode = String(properties.stretch_mode || 'time_stretch').toLowerCase();
    const originalBpm = numberOrNull(properties.original_bpm)
        ?? numberOrNull(poolProperties.output_bpm)
        ?? numberOrNull(activePoolItem?.bpm)
        ?? numberOrNull(activePoolItem?.original_bpm)
        ?? 120;
    const targetBpm = numberOrNull(properties.target_bpm) ?? numberOrNull(properties.bpm) ?? timelineBpm;
    let timeRate = stretchFactor;

    if (sampleType !== 'one_shot' && sampleType !== 'oneshot' && stretchMode !== 'off') {
        timeRate *= targetBpm / Math.max(0.0001, originalBpm);
    }
    if (stretchMode === 'pitch_shift' || stretchMode === 'repitch' || stretchMode === 'varispeed') {
        const semitones = (numberOrNull(properties.transpose) ?? 0) + (numberOrNull(properties.cents) ?? 0) / 100;
        timeRate *= 2 ** (semitones / 12);
    }

    const bars = (durationSeconds * crop / timeRate) * timelineBpm / 240;
    return bars > 0 ? {
        bars,
        label,
        kind: sampleType === 'one_shot' || sampleType === 'oneshot' ? 'sample' : 'loop'
    } : null;
}
