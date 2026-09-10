/**
 * ERMES Graph Subtree Serializer
 * Converts LiteGraph node structures into canonical AudioNodeModel payload dictionaries.
 */

export interface SerializationOptions {
    includeDynamicPools?: boolean;
}

export function serializeNodeSubtree(
    graph: any,
    rootNodeId: number,
    trackNodesMap?: Map<number, any>,
    options: SerializationOptions = {}
): any {
    const trackNodes = trackNodesMap || (window as any).trackNodes || new Map();
    const includeDynamicPools = options.includeDynamicPools !== false;
    const globalParameters = graph?.extra?.global_parameters || { bpm: 120, total_bars: 4, key: 'C' };
    const modulatorsByParent = new Map<number, Array<[number, any]>>();
    for (const [modifierId, modifierData] of trackNodes.entries()) {
        if (modifierData?.type !== 'modulator' || modifierData.parentId == null) continue;
        const siblings = modulatorsByParent.get(modifierData.parentId) || [];
        siblings.push([modifierId, modifierData]);
        modulatorsByParent.set(modifierData.parentId, siblings);
    }
    const resolveGlobalNumber = (value: any, key: 'bpm' | 'total_bars', fallback: number) => {
        const candidate = String(value).toLowerCase() === 'global' ? globalParameters[key] : value;
        const numeric = Number(candidate);
        return Number.isFinite(numeric) ? numeric : fallback;
    };

    function buildNodeModel(nodeId: number): any {
        const data = trackNodes.get(nodeId);
        const nodeObj = graph.getNodeById(nodeId);
        if (!data && !nodeObj) return null;
        if (typeof (window as any).syncGhostTrackData === 'function') {
            (window as any).syncGhostTrackData(nodeObj, data);
        }
        if (data?.type === 'disabled' || nodeObj?.properties?.disabled || nodeObj?.type === 'Audio/Disabled') {
            console.warn(`Skipping disabled node ${nodeId} during serialization.`);
            return null;
        }

        const name = data?.name || nodeObj?.title || nodeObj?.properties?.node_name || "AudioNode";
        const assignedModifierId = nodeObj?.properties?.asset_modifier_id ?? data?.asset_modifier_id;
        const assignedModifier = assignedModifierId != null ? graph.getNodeById(assignedModifierId) : null;
        const filepath = assignedModifier?.properties?.output_value || data?.filepath || nodeObj?.properties?.filepath || null;
        const original_bpm = assignedModifier?.properties?.output_bpm || data?.original_bpm || nodeObj?.properties?.original_bpm || 120;
        const configuredBpm = nodeObj?.properties?.bpm ?? data?.bpm;
        const target_bpm = resolveGlobalNumber(
            String(configuredBpm).toLowerCase() === 'global'
                ? configuredBpm
                : (data?.target_bpm ?? nodeObj?.properties?.target_bpm ?? configuredBpm),
            'bpm',
            120
        );
        const key = assignedModifier?.properties?.output_key ?? nodeObj?.properties?.key ?? data?.key ?? "";
        const start_beat = data?.start_beat || nodeObj?.properties?.start_beat || 0;
        const bpm = target_bpm;
        const mix_mode = data?.mix_mode || nodeObj?.properties?.mix_mode || "sum";

        const nodeType = data?.type || nodeObj?.properties?.node_type || (nodeObj?.type === "Audio/Sample" ? "sample" : nodeObj?.type === "Audio/Sequence" ? "sequence" : "track");
        
        const sequence = nodeObj?.properties?.sequence ?? data?.sequence ?? (nodeType === "sequence" ? [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] : undefined);
        const rawStepParameters = nodeObj?.properties?.step_parameters ?? data?.step_parameters;
        const stepParameters = Array.isArray(rawStepParameters)
            ? rawStepParameters.map((step: any) => ({ ...(step || {}) }))
            : undefined;
        const stepLength = nodeObj?.properties?.step_length ?? data?.step_length ?? (nodeType === "sequence" ? 0.25 : undefined);
        const fadeMs = nodeObj?.properties?.fade_ms ?? data?.fade_ms ?? (nodeType === "sequence" ? 0 : undefined);
        const rawTotalBars = nodeObj?.properties?.total_bars ?? data?.total_bars;
        const total_bars = rawTotalBars == null
            ? (nodeType === "arrangement" ? 4.0 : undefined)
            : resolveGlobalNumber(rawTotalBars, 'total_bars', 4.0);
        const section_points = nodeObj?.properties?.section_points ?? data?.section_points ?? (nodeType === "arrangement" ? [] : undefined);
        const section_enabled = nodeObj?.properties?.section_enabled ?? data?.section_enabled ?? (nodeType === "arrangement" ? [] : undefined);
        const section_probability = nodeObj?.properties?.section_probability ?? data?.section_probability ?? (nodeType === "arrangement" ? [1.0] : undefined);
        const section_sample_start = nodeObj?.properties?.section_sample_start ?? data?.section_sample_start ?? (nodeType === "arrangement" ? [0.0] : undefined);
        const section_quant = nodeObj?.properties?.section_quant ?? data?.section_quant ?? (nodeType === "arrangement" ? ["none"] : undefined);
        const section_quant_anchor = nodeObj?.properties?.section_quant_anchor ?? data?.section_quant_anchor ?? (nodeType === "arrangement" ? ["start"] : undefined);

        const poolProperties = assignedModifier?.properties;
        const selected_items = includeDynamicPools
            ? (poolProperties?.selected_items || data?.selected_items || nodeObj?.properties?.selected_items || [])
            : [];
        const playbackMode = includeDynamicPools
            ? (poolProperties?.playbackMode || data?.playbackMode || nodeObj?.properties?.playbackMode)
            : undefined;
        const refresh_mode = includeDynamicPools
            ? (poolProperties?.refresh_mode || data?.refresh_mode || nodeObj?.properties?.refresh_mode || "off")
            : "off";
        let seed = includeDynamicPools
            ? (poolProperties?.seed ?? data?.seed ?? nodeObj?.properties?.seed)
            : (data?.seed ?? nodeObj?.properties?.seed);
        const rawSeedMode = data?.seed_mode ?? nodeObj?.properties?.seed_mode;
        const seed_mode = typeof rawSeedMode === 'string'
            ? rawSeedMode
            : (nodeType === "sequence" ? "moving" : undefined);

        const childrenIds: number[] = data?.children ? [...data.children] : [];
        if (nodeObj && nodeObj.inputs) {
            for (const input of nodeObj.inputs) {
                if (input.link != null) {
                    const link = (graph as any).links ? (graph as any).links[input.link] : null;
                    if (link && link.origin_id != null) {
                        if (!childrenIds.includes(link.origin_id)) {
                            childrenIds.push(link.origin_id);
                        }
                    }
                }
            }
        }

        const childModels: any[] = [];
        for (const cid of childrenIds) {
            const childModel = buildNodeModel(cid);
            if (childModel) {
                childModels.push(childModel);
            }
        }

        const chain = nodeObj?.properties?.chain || data?.chain || [];

        const modulatorModels: any[] = [];
        for (const [mid, mdata] of modulatorsByParent.get(nodeId) || []) {
            const mNodeObj = graph.getNodeById(mid);
            modulatorModels.push({
                id: mid,
                node_name: mdata.name || mNodeObj?.title || "Modulator",
                chain: mNodeObj?.properties?.chain || mdata.chain || []
            });
        }

        const sample_type = data?.sample_type || nodeObj?.properties?.sample_type || "loop";
        const crop_start = data?.crop_start ?? nodeObj?.properties?.crop_start ?? 0.0;
        const crop_end = data?.crop_end ?? nodeObj?.properties?.crop_end ?? 1.0;
        const transpose = data?.transpose ?? nodeObj?.properties?.transpose ?? 0.0;
        const cents = data?.cents ?? nodeObj?.properties?.cents ?? 0.0;
        const stretch_mode = data?.stretch_mode || nodeObj?.properties?.stretch_mode || "time_stretch";
        const stretch_factor = data?.stretch_factor ?? nodeObj?.properties?.stretch_factor ?? 1.0;
        const stretch_algorithm = data?.stretch_algorithm || nodeObj?.properties?.stretch_algorithm || "rubberband";

        const model = {
            node_name: name,
            node_type: nodeType,
            sample_type: sample_type,
            filepath: filepath,
            original_bpm: original_bpm,
            target_bpm: target_bpm,
            key: key,
            bpm: bpm,
            start_beat: start_beat,
            mix_mode: mix_mode,
            crop_start: crop_start,
            crop_end: crop_end,
            transpose: transpose,
            cents: cents,
            stretch_mode: stretch_mode,
            stretch_factor: stretch_factor,
            stretch_algorithm: stretch_algorithm,
            sequence: sequence,
            step_parameters: stepParameters,
            step_length: stepLength,
            play_mode: nodeObj?.properties?.play_mode ?? data?.play_mode ?? (nodeType === "sequence" ? "gate" : undefined),
            fade_ms: fadeMs,
            total_bars: total_bars,
            section_points: section_points,
            section_enabled: section_enabled,
            section_probability: section_probability,
            section_sample_start: section_sample_start,
            section_quant: section_quant,
            section_quant_anchor: section_quant_anchor,
            selected_items: selected_items,
            playbackMode: playbackMode,
            seed: seed,
            seed_mode: seed_mode,
            refresh_mode: refresh_mode,
            chain: chain,
            modulators: modulatorModels,
            children: childModels
        };

        return typeof nodeObj?.prepareSerializedModel === 'function'
            ? nodeObj.prepareSerializedModel(model)
            : model;
    }

    return buildNodeModel(rootNodeId);
}
