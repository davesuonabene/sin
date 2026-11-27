/**
 * ERMES Graph Subtree Serializer
 * Converts LiteGraph node structures into canonical AudioNodeModel payload dictionaries.
 */

import {
    type NodeSlot,
    evaluateNumericFieldOperator,
    evaluateSelectFieldOperator,
    isFieldOperatorExpression,
    normalizeNumericSeed,
    resolveCycleSeeds,
    resolveSectionSlot,
    resolveStepSlots,
} from './slotLanguage.ts';
import {
    getEffectiveFieldSeed,
} from './randomResolver.ts';
import {
    resolveEffectivePoolSeed,
} from './assetResolver.ts';
import {
    findChainModuleParam,
    parseChainParamFieldKey,
} from '../../editor/src/dsp/processorRegistry.ts';

export interface SerializationOptions {
    includeDynamicPools?: boolean;
    isFrozen?: boolean;
}

function normalizeStepParametersList(rawStepParameters: any): Array<Record<string, any>> | undefined {
    if (!Array.isArray(rawStepParameters)) return undefined;
    return rawStepParameters.map((step: any) => {
        const cloned = { ...(step || {}) };
        if (typeof cloned.sample_start === 'number' && cloned.sample_start > 1) {
            cloned.sample_start = cloned.sample_start / 100;
        }
        if (typeof cloned.probability === 'number' && cloned.probability > 1) {
            cloned.probability = cloned.probability / 100;
        }
        if (typeof cloned.gate_length === 'number' && cloned.gate_length > 1) {
            cloned.gate_length = cloned.gate_length / 100;
        }
        return cloned;
    });
}

export function serializeNodeSubtree(
    graph: any,
    rootNodeId: number,
    trackNodesMap?: Map<number, any>,
    options: SerializationOptions = {}
): any {
    const trackNodes = trackNodesMap || (typeof window !== 'undefined' ? (window as any).trackNodes : undefined) || new Map();
    const includeDynamicPools = options.includeDynamicPools !== false;
    const globalParameters = graph?.extra?.global_parameters || { bpm: 120, total_bars: 4, key: 'C' };
    const modulatorsByParent = new Map<number, Array<[number, any]>>();
    for (const [modifierId, modifierData] of trackNodes.entries()) {
        if (modifierData?.type !== 'modulator' || modifierData.parentId == null) continue;
        const siblings = modulatorsByParent.get(modifierData.parentId) || [];
        siblings.push([modifierId, modifierData]);
        modulatorsByParent.set(modifierData.parentId, siblings);
    }
    const isAutoBars = (value: any): boolean => {
        if (value == null) return false;
        if (typeof value === 'string') {
            const s = value.trim().toLowerCase();
            if (s === 'auto' || s === 'free') return true;
            const n = Number(s);
            return Number.isFinite(n) && n <= 0;
        }
        return typeof value === 'number' && Number.isFinite(value) && value <= 0;
    };
    const isAutoGlobalBars = isAutoBars(globalParameters.total_bars);
    const resolveGlobalNumber = (value: any, key: 'bpm' | 'total_bars', fallback: number) => {
        const candidate = String(value).toLowerCase() === 'global' ? globalParameters[key] : value;
        const numeric = Number(candidate);
        return Number.isFinite(numeric) ? numeric : fallback;
    };
    const workspaceBars = isAutoGlobalBars ? undefined : resolveGlobalNumber(globalParameters.total_bars, 'total_bars', 4.0);

    const findParentWrapperBars = (startNodeId: number): number | undefined => {
        const visited = new Set<number>();
        let currentId: number | undefined = startNodeId;
        while (currentId != null && !visited.has(currentId)) {
            visited.add(currentId);
            let nextParentId: number | undefined = trackNodes.get(currentId)?.parentId;
            if (nextParentId == null) {
                const links = (graph as any)?.links;
                if (links) {
                    const linkList = Array.isArray(links) ? links : Object.values(links);
                    for (const link of linkList) {
                        if (!link) continue;
                        const orig = Array.isArray(link) ? link[1] : link.origin_id;
                        const targ = Array.isArray(link) ? link[3] : link.target_id;
                        if (orig === currentId && targ != null) {
                            nextParentId = targ;
                            break;
                        }
                    }
                }
            }
            if (nextParentId == null) break;
            const pData = trackNodes.get(nextParentId);
            const pObj = graph.getNodeById?.(nextParentId);
            const pType = pData?.type || pObj?.properties?.node_type || (pObj?.type === 'Audio/Arrangement' ? 'arrangement' : pObj?.type === 'Audio/Track' ? 'track' : '');
            if (pType === 'track' || pType === 'arrangement') {
                const rawBars = pObj?.properties?.total_bars ?? pData?.total_bars;
                if (isAutoBars(rawBars)) return undefined;
                const isGlobal = rawBars == null || String(rawBars).toLowerCase() === 'global' || Boolean(pObj?.properties?.length_inherited);
                return isGlobal ? workspaceBars : resolveGlobalNumber(rawBars, 'total_bars', workspaceBars ?? 4.0);
            }
            currentId = nextParentId;
        }
        return undefined;
    };

    function buildNodeModel(
        nodeId: number,
        parentTotalBars?: number,
        parentTargetBpm?: number,
        parentNodeType?: string
    ): any {
        const data = trackNodes.get(nodeId);
        const nodeObj = graph.getNodeById(nodeId);
        if (!data && !nodeObj) return null;
        if (typeof nodeObj?.syncActiveSlotFromProperties === 'function') {
            nodeObj.syncActiveSlotFromProperties();
        }
        if (typeof window !== 'undefined' && typeof (window as any).syncGhostTrackData === 'function') {
            (window as any).syncGhostTrackData(nodeObj, data);
        }
        if (data?.type === 'disabled' || nodeObj?.properties?.disabled || nodeObj?.type === 'Audio/Disabled') {
            console.warn(`Skipping disabled node ${nodeId} during serialization.`);
            return null;
        }

        const name = data?.name || nodeObj?.title || nodeObj?.properties?.node_name || "AudioNode";
        const assignedModifierId = nodeObj?.properties?.asset_modifier_id ?? data?.asset_modifier_id;
        const assignedModifier = assignedModifierId != null ? graph.getNodeById(assignedModifierId) : null;
        const hasPopulatedSlots = Array.isArray(nodeObj?.properties?.slots) && nodeObj.properties.slots.some((s: any) => Boolean(s?.filepath));
        const activeSlotIdx = Math.max(0, Number(nodeObj?.activeSlotIndex ?? nodeObj?.properties?.active_slot ?? data?.active_slot ?? 0));
        const activeSlotFilepath = Array.isArray(nodeObj?.properties?.slots) ? nodeObj.properties.slots[activeSlotIdx]?.filepath : undefined;
        const filepath = (hasPopulatedSlots
            ? (nodeObj?.properties?.filepath || activeSlotFilepath || assignedModifier?.properties?.output_value || data?.filepath)
            : (assignedModifier?.properties?.output_value || data?.filepath || nodeObj?.properties?.filepath)) || null;
        const original_bpm = nodeObj?.properties?.original_bpm ?? data?.original_bpm ?? assignedModifier?.properties?.output_bpm ?? undefined;
        const rawTargetBpm = nodeObj?.properties?.target_bpm ?? data?.target_bpm;
        const configuredBpm = nodeObj?.properties?.bpm ?? data?.bpm;
        const isTargetGlobal = rawTargetBpm == null
            || String(rawTargetBpm).toLowerCase() === 'global'
            || String(configuredBpm).toLowerCase() === 'global';

        const fallbackBpm = parentTargetBpm ?? resolveGlobalNumber(globalParameters.bpm, 'bpm', 120);
        const resolvedBpm = isTargetGlobal
            ? fallbackBpm
            : resolveGlobalNumber(rawTargetBpm ?? configuredBpm, 'bpm', fallbackBpm);

        const target_bpm = isTargetGlobal ? undefined : resolvedBpm;
        const bpm = resolvedBpm;
        const key = nodeObj?.properties?.key ?? data?.key ?? assignedModifier?.properties?.output_key ?? "";
        const start_beat = data?.start_beat || nodeObj?.properties?.start_beat || 0;
        const mix_mode = data?.mix_mode || nodeObj?.properties?.mix_mode || "sum";

        const nodeType = data?.type || (typeof nodeObj?.getNodeType === 'function' ? nodeObj.getNodeType() : undefined) || nodeObj?.properties?.node_type || (
            nodeObj?.type === "Audio/Sample" ? "sample"
            : nodeObj?.type === "Audio/Sequence" ? "sequence"
            : nodeObj?.type === "Audio/Arrangement" ? "arrangement"
            : nodeObj?.type === "Audio/Null" ? "null"
            : nodeObj?.type === "Audio/PreampDenoise" ? "preamp_denoise"
            : nodeObj?.type === "Audio/VoiceIsolator" ? "voice_isolator"
            : "track"
        );

        const sequence = nodeObj?.properties?.sequence ?? data?.sequence ?? (nodeType === "sequence" ? [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] : undefined);
        const rawStepParameters = nodeObj?.properties?.step_parameters ?? data?.step_parameters;
        const stepParameters = normalizeStepParametersList(rawStepParameters);
        const stepLength = nodeObj?.properties?.step_length ?? data?.step_length ?? (nodeType === "sequence" ? 0.25 : undefined);
        const fadeMs = nodeObj?.properties?.fade_ms ?? data?.fade_ms ?? (nodeType === "sequence" ? 0 : undefined);
        const rawTotalBars = nodeObj?.properties?.total_bars ?? data?.total_bars;
        const isAutoExplicit = isAutoBars(rawTotalBars);
        const isGlobalOrInherited = rawTotalBars == null
            || String(rawTotalBars).toLowerCase() === 'global'
            || Boolean(nodeObj?.properties?.length_inherited);
        const parentWrapperBars = parentTotalBars ?? findParentWrapperBars(nodeId);
        const fallbackBars = parentWrapperBars ?? workspaceBars;
        const rawRepeat = data?.repeat ?? nodeObj?.properties?.repeat;
        const rawSampleType = data?.sample_type ?? nodeObj?.properties?.sample_type;
        const repeat = rawRepeat !== undefined
            ? Boolean(rawRepeat)
            : (rawSampleType !== undefined ? String(rawSampleType).toLowerCase() === 'loop' : true);
        const sample_type = repeat ? 'loop' : 'one_shot';
        const isSampleLoop = repeat;
        let total_bars: number | undefined;
        if (isAutoExplicit) {
            total_bars = undefined;
        } else if (isGlobalOrInherited) {
            if (nodeType === 'sample') {
                // Standalone SampleNode preview (parentNodeType === undefined) always uses
                // its exact cropped active duration rather than inheriting global total_bars.
                total_bars = (isSampleLoop && (parentNodeType === 'track' || parentNodeType === 'null')) ? fallbackBars : undefined;
            } else if (nodeType === 'track') {
                total_bars = fallbackBars;
            } else if (nodeType === 'null') {
                total_bars = parentTotalBars ?? parentWrapperBars;
            } else {
                total_bars = fallbackBars ?? 4.0;
            }
        } else {
            total_bars = resolveGlobalNumber(rawTotalBars, 'total_bars', fallbackBars ?? 4.0);
        }
        const wrapper_bars = (total_bars != null || parentWrapperBars != null || workspaceBars != null)
            ? Math.max(Number(total_bars || 0), Number(parentWrapperBars ?? workspaceBars ?? 0)) || undefined
            : undefined;
        const global_bars = wrapper_bars;
        const section_points = nodeObj?.properties?.section_points ?? data?.section_points ?? (nodeType === "arrangement" ? [] : undefined);
        const section_enabled = nodeObj?.properties?.section_enabled ?? data?.section_enabled ?? (nodeType === "arrangement" ? [] : undefined);
        const section_probability = nodeObj?.properties?.section_probability ?? data?.section_probability ?? (nodeType === "arrangement" ? [1.0] : undefined);
        const section_quant = nodeObj?.properties?.section_quant ?? data?.section_quant ?? (nodeType === "arrangement" ? ["auto"] : undefined);
        const section_quant_anchor = nodeObj?.properties?.section_quant_anchor ?? data?.section_quant_anchor ?? (nodeType === "arrangement" ? ["start"] : undefined);

        const poolProperties = assignedModifier?.properties;
        const selected_items = (Array.isArray(poolProperties?.selected_items) && poolProperties.selected_items.length > 0)
            ? poolProperties.selected_items
            : (Array.isArray(nodeObj?.properties?.selected_items) && nodeObj.properties.selected_items.length > 0
                ? nodeObj.properties.selected_items
                : (data?.selected_items || []));
        const pool_node_id = Number(assignedModifier?.id || nodeId || 0);
        const playbackMode = includeDynamicPools
            ? (poolProperties?.playbackMode || data?.playbackMode || nodeObj?.properties?.playbackMode)
            : undefined;
        const refresh_mode = includeDynamicPools
            ? (poolProperties?.refresh_mode || data?.refresh_mode || nodeObj?.properties?.refresh_mode || "off")
            : "off";
        let seed = poolProperties?.seed ?? data?.seed ?? nodeObj?.properties?.seed;
        const global_seed = resolveEffectivePoolSeed(assignedModifier, nodeObj, graph);
        const field_seed = getEffectiveFieldSeed(graph, nodeObj);
        if (seed === undefined && graph?.extra?.global_seed !== undefined) {
            seed = field_seed;
        }
        const isGlobalFrozen = (options.isFrozen !== undefined)
            ? Boolean(options.isFrozen)
            : Boolean(
                (typeof window !== 'undefined' && typeof (window as any).getGlobalFreeze === 'function' ? (window as any).getGlobalFreeze() : false)
                || graph?.extra?.global_freeze
                || graph?.frozen
            );
        const isNodeFrozen = isGlobalFrozen && (nodeObj?.properties?.freeze_refresh !== false);
        const rawSeedMode = data?.seed_mode ?? nodeObj?.properties?.seed_mode;
        const seed_mode = isNodeFrozen && nodeType === "sequence"
            ? "fixed"
            : (typeof rawSeedMode === 'string'
                ? rawSeedMode
                : (nodeType === "sequence" ? "moving" : undefined));

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

        const effectiveChildrenIds = nodeType === 'null' ? childrenIds.slice(0, 1) : childrenIds;
        const childModels: any[] = [];
        for (const cid of effectiveChildrenIds) {
            const childModel = buildNodeModel(cid, total_bars, resolvedBpm, nodeType);
            if (childModel) {
                childModels.push(childModel);
            }
        }

        const rawChain = nodeObj?.properties?.chain || data?.chain || [];
        let chain = rawChain.map((fx: any) => (typeof fx === 'object' && fx !== null ? {
            name: fx.name || fx.id || fx.type || 'FX',
            ...fx,
            params: fx.params && typeof fx.params === 'object' ? { ...fx.params } : {},
        } : fx));
        const rawFieldOps = nodeObj?.properties?.field_operators ?? data?.field_operators;
        if (rawFieldOps && typeof rawFieldOps === 'object' && chain.length > 0) {
            for (const [opKey, opExpr] of Object.entries(rawFieldOps)) {
                if (typeof opExpr !== 'string' || !isFieldOperatorExpression(opExpr)) continue;
                const parsedChainKey = parseChainParamFieldKey(opKey);
                if (!parsedChainKey) continue;
                const found = findChainModuleParam({ properties: { chain } }, opKey);
                if (!found) continue;
                const mod = chain.find((m: any) => m && String(m.id) === parsedChainKey.moduleId);
                if (!mod) continue;
                const evalSeed = field_seed ?? 42;
                const salt = normalizeNumericSeed(opKey, 0xF1E1);
                if (found.schema.type === 'select' && Array.isArray(found.schema.options)) {
                    const resolvedOpt = evaluateSelectFieldOperator(opExpr, found.schema.options as any, {
                        triggerCount: 0,
                        seed: evalSeed,
                        salt,
                        fallback: found.schema.default,
                    });
                    mod.params[parsedChainKey.paramKey] = Number(resolvedOpt);
                } else {
                    const resolvedNum = evaluateNumericFieldOperator(opExpr, {
                        triggerCount: 0,
                        seed: evalSeed,
                        salt,
                        min: found.param.min,
                        max: found.param.max,
                        step: found.param.step,
                        isInteger: found.param.kind === 'bool' || found.param.kind === 'enum',
                        fallback: Number(found.param.defaultValue),
                    });
                    mod.params[parsedChainKey.paramKey] = resolvedNum;
                }
            }
        }
        const rawTopGain = nodeObj?.properties?.gain ?? data?.gain;
        if (typeof rawTopGain === 'number' && Number.isFinite(rawTopGain) && chain.length === 0) {
            const gainLin = rawTopGain <= -35.9 ? 0 : Number(Math.pow(10, rawTopGain / 20).toFixed(6));
            chain = [{
                id: 'post_gain_0',
                type: 'gain',
                name: 'Post Gain',
                enabled: true,
                fixed: true,
                params: { gain: gainLin, gain_db: rawTopGain },
            }];
        }

        const modulatorModels: any[] = [];
        for (const [mid, mdata] of modulatorsByParent.get(nodeId) || []) {
            const mNodeObj = graph.getNodeById(mid);
            const mRawChain = mNodeObj?.properties?.chain || mdata.chain || [];
            const mChain = mRawChain.map((fx: any) => (typeof fx === 'object' && fx !== null ? {
                name: fx.name || fx.id || fx.type || 'FX',
                ...fx
            } : fx));
            modulatorModels.push({
                id: mid,
                node_name: mdata.name || mNodeObj?.title || "Modulator",
                chain: mChain
            });
        }

        const crop_start = data?.crop_start ?? nodeObj?.properties?.crop_start ?? 0.0;
        const crop_end = data?.crop_end ?? nodeObj?.properties?.crop_end ?? 1.0;
        const transpose = data?.transpose ?? nodeObj?.properties?.transpose ?? 0.0;
        const cents = data?.cents ?? nodeObj?.properties?.cents ?? 0.0;
        const rawWarp = data?.warp ?? nodeObj?.properties?.warp;
        const rawStretchMode = data?.stretch_mode ?? nodeObj?.properties?.stretch_mode;
        const warp: boolean | undefined = rawWarp !== undefined
            ? Boolean(rawWarp)
            : (rawStretchMode != null
                ? !['pitch_shift', 'repitch', 'varispeed', 'off'].includes(String(rawStretchMode).toLowerCase())
                : undefined);
        const stretch_mode = warp !== undefined
            ? (warp ? 'time_stretch' : (String(rawStretchMode || '').toLowerCase() === 'off' ? 'off' : 'pitch_shift'))
            : (rawStretchMode || 'time_stretch');
        const stretch_factor = data?.stretch_factor ?? nodeObj?.properties?.stretch_factor ?? 1.0;
        const stretch_algorithm = data?.stretch_algorithm || nodeObj?.properties?.stretch_algorithm || "rubberband";
        const key_match_mode = data?.key_match_mode || nodeObj?.properties?.key_match_mode || "off";
        const key_match_algorithm = data?.key_match_algorithm || nodeObj?.properties?.key_match_algorithm || "nearest";

        const projectName = (graph as any)?.extra?.project_name
            || (typeof window !== 'undefined' && typeof (window as any).getProjectName === 'function' ? (window as any).getProjectName() : null)
            || (typeof document !== 'undefined' ? (document.querySelector('#workspace-preset-select') as HTMLSelectElement)?.value : null)
            || 'project';

        const upstreamSlotCount = Math.max(1, childModels[0]?.slots?.length || 1);
        const upstreamActiveSlot = Math.max(0, Number(childModels[0]?.active_slot ?? 0));
        const rawSlots = Array.isArray(nodeObj?.properties?.slots)
            ? nodeObj.properties.slots
            : (Array.isArray(data?.slots) ? data.slots : []);
        const activeIdx = Math.max(0, Number(nodeObj?.activeSlotIndex ?? nodeObj?.properties?.active_slot ?? data?.active_slot ?? 0));
        const seedSalt = Number(nodeObj?.properties?.seed_salt ?? data?.seed_salt ?? 0) * 9973;

        let slots: NodeSlot[] = [];
        if (nodeType === 'sample') {
            if (rawSlots.length > 0) {
                slots = rawSlots.map((s: any, idx: number) => ({
                    slot: idx,
                    label: s?.label,
                    pool_query: s?.pool_query ?? (idx === activeIdx ? (nodeObj?.properties?.pool_query ?? data?.pool_query) : undefined),
                    filepath: s?.filepath ?? (idx === activeIdx ? filepath : undefined),
                    library_item_id: s?.library_item_id ?? (idx === activeIdx ? (nodeObj?.properties?.library_item_id ?? data?.library_item_id) : undefined),
                    original_bpm: s?.original_bpm ?? (idx === activeIdx ? original_bpm : undefined),
                    key: s?.key ?? (idx === activeIdx ? key : undefined),
                    duration_seconds: s?.duration_seconds,
                    crop_start: s?.crop_start ?? s?.sample_start ?? crop_start,
                    crop_end: s?.crop_end ?? s?.sample_end ?? crop_end,
                    pitch_shift: s?.pitch_shift ?? (idx === activeIdx ? transpose : undefined),
                    time_stretch: s?.time_stretch ?? (idx === activeIdx ? stretch_factor : undefined),
                    repeat: s?.repeat ?? (idx === activeIdx ? repeat : undefined),
                    warp: s?.warp ?? (idx === activeIdx ? warp : undefined),
                    field_operators: s?.field_operators,
                }));
            } else {
                slots = [{
                    slot: 0,
                    pool_query: nodeObj?.properties?.pool_query ?? data?.pool_query,
                    filepath: filepath || undefined,
                    library_item_id: nodeObj?.properties?.library_item_id ?? data?.library_item_id,
                    original_bpm: original_bpm,
                    key: key,
                    crop_start: crop_start,
                    crop_end: crop_end,
                    pitch_shift: transpose,
                    time_stretch: stretch_factor,
                    repeat: repeat,
                    warp: warp,
                    field_operators: nodeObj?.properties?.field_operators ?? data?.field_operators,
                }];
            }
        } else if (nodeType === 'sequence') {
            const sampleSlotExpr = String(nodeObj?.properties?.sample_slot ?? data?.sample_slot ?? '*');
            const seqLen = Array.isArray(sequence) && sequence.length > 0 ? sequence.length : 16;
            const patternBeats = Math.max(0.25, seqLen * Number(stepLength || 0.25));
            const totalBeats = Number(total_bars || 4.0) * 4.0;
            const numCycles = Math.max(1, Math.ceil(totalBeats / patternBeats));

            if (rawSlots.length > 0) {
                slots = rawSlots.map((s: any, idx: number) => {
                    const isActive = idx === activeIdx;
                    const slotSeq = isActive && Array.isArray(sequence)
                        ? [...sequence]
                        : (Array.isArray(s?.sequence) ? [...s.sequence] : (Array.isArray(sequence) ? [...sequence] : []));
                    const slotStepParams = (isActive && stepParameters)
                        ? stepParameters
                        : (normalizeStepParametersList(s?.step_parameters) || stepParameters);
                    const slotSampleSlot = isActive
                        ? sampleSlotExpr
                        : String(s?.sample_slot ?? sampleSlotExpr);
                    const slotSeed = isActive ? (seed ?? s?.seed ?? field_seed ?? 42) : (s?.seed ?? seed ?? field_seed ?? 42);
                    const slotCycleSeeds = resolveCycleSeeds(slotSeed, numCycles, Number(nodeId || 1) + idx + seedSalt);
                    const stepSlotOptions = /[\[\]<>]/.test(slotSampleSlot)
                        ? { globalIdx: 0, cycleIdx: 0, numCycles, activeSequence: slotSeq }
                        : undefined;
                    const slotStepSlots = resolveStepSlots(
                        slotSampleSlot,
                        slotSeq.length || 16,
                        upstreamSlotCount,
                        slotCycleSeeds[0],
                        upstreamActiveSlot,
                        stepSlotOptions
                    );
                    return {
                        slot: idx,
                        label: s?.label,
                        pool_query: s?.pool_query ?? (isActive ? (nodeObj?.properties?.pool_query ?? data?.pool_query) : undefined),
                        filepath: s?.filepath ?? (isActive ? filepath : undefined),
                        library_item_id: s?.library_item_id ?? (isActive ? (nodeObj?.properties?.library_item_id ?? data?.library_item_id) : undefined),
                        sequence_name: s?.sequence_name ?? (isActive ? (nodeObj?.properties?.sequence_name ?? data?.sequence_name) : undefined),
                        sequence: slotSeq,
                        step_parameters: slotStepParams,
                        sample_slot: slotSampleSlot,
                        step_slots: slotStepSlots,
                        step_length: s?.step_length ?? (isActive ? stepLength : undefined),
                        release: s?.release ?? (isActive ? (nodeObj?.properties?.release ?? data?.release) : undefined),
                        fade_ms: s?.fade_ms ?? (isActive ? fadeMs : undefined),
                        seed: slotSeed,
                        cycle_seeds: slotCycleSeeds,
                        field_operators: s?.field_operators ?? (isActive ? (nodeObj?.properties?.field_operators ?? data?.field_operators) : undefined),
                    };
                });
            } else {
                const effSeed0 = seed ?? field_seed ?? 42;
                const cycleSeeds0 = resolveCycleSeeds(effSeed0, numCycles, Number(nodeId || 1) + seedSalt);
                const stepSlotOptions0 = /[\[\]<>]/.test(sampleSlotExpr)
                    ? { globalIdx: 0, cycleIdx: 0, numCycles, activeSequence: Array.isArray(sequence) ? sequence : undefined }
                    : undefined;
                const stepSlots0 = resolveStepSlots(
                    sampleSlotExpr,
                    seqLen,
                    upstreamSlotCount,
                    cycleSeeds0[0],
                    upstreamActiveSlot,
                    stepSlotOptions0
                );
                slots = [{
                    slot: 0,
                    pool_query: nodeObj?.properties?.pool_query ?? data?.pool_query,
                    filepath: filepath || undefined,
                    library_item_id: nodeObj?.properties?.library_item_id ?? data?.library_item_id,
                    sequence_name: nodeObj?.properties?.sequence_name ?? data?.sequence_name,
                    sequence: Array.isArray(sequence) ? [...sequence] : [],
                    step_parameters: stepParameters,
                    sample_slot: sampleSlotExpr,
                    step_slots: stepSlots0,
                    step_length: stepLength,
                    release: nodeObj?.properties?.release ?? data?.release,
                    fade_ms: fadeMs,
                    seed: effSeed0,
                    cycle_seeds: cycleSeeds0,
                    field_operators: nodeObj?.properties?.field_operators ?? data?.field_operators,
                }];
            }
        }

        const clampedActiveIdx = slots.length > 0 ? Math.min(activeIdx, slots.length - 1) : 0;
        const sample_slot = nodeType === 'sequence'
            ? String(nodeObj?.properties?.sample_slot ?? data?.sample_slot ?? '*')
            : undefined;
        const cycle_seeds = nodeType === 'sequence' && slots.length > 0
            ? (slots[clampedActiveIdx].cycle_seeds || [])
            : (nodeType === 'arrangement'
                ? resolveCycleSeeds(seed ?? 42, (Array.isArray(section_points) ? section_points.length : 0) + 1, Number(nodeId || 1) + seedSalt)
                : []);
        const step_slots = nodeType === 'sequence' && slots.length > 0
            ? (slots[clampedActiveIdx].step_slots || [])
            : [];

        const rawSectionSlots = nodeObj?.properties?.section_slots ?? data?.section_slots;
        const numSections = (Array.isArray(section_points) ? section_points.length : 0) + 1;
        const section_slots = nodeType === 'arrangement'
            ? Array.from({ length: numSections }, (_, i) =>
                resolveSectionSlot(
                    Array.isArray(rawSectionSlots) ? rawSectionSlots[i] : '*',
                    upstreamSlotCount,
                    upstreamActiveSlot,
                    cycle_seeds[i] ?? seed ?? 42,
                    i,
                )
            )
            : [];

        const model = {
            node_id: nodeId,
            node_name: name,
            node_type: nodeType,
            active_slot: activeIdx,
            repeat: rawRepeat !== undefined ? repeat : undefined,
            warp: warp,
            sample_type: sample_type,
            filepath: filepath,
            original_bpm: original_bpm,
            target_bpm: target_bpm,
            key: key,
            bpm: bpm,
            start_beat: start_beat,
            mix_mode: mix_mode,
            muted: Boolean(nodeObj?.properties?.muted ?? data?.muted ?? false),
            solo: Boolean(nodeObj?.properties?.solo ?? data?.solo ?? false),
            pan: Number(nodeObj?.properties?.pan ?? data?.pan ?? 0) || 0,
            project_name: nodeObj?.properties?.project_name ?? data?.project_name ?? projectName,
            export_directory: nodeObj?.properties?.export_directory ?? data?.export_directory,
            export_pattern: nodeObj?.properties?.export_pattern ?? data?.export_pattern,
            export_overwrite_mode: nodeObj?.properties?.export_overwrite_mode ?? data?.export_overwrite_mode,
            crop_start: crop_start,
            crop_end: crop_end,
            transpose: transpose,
            cents: cents,
            stretch_mode: stretch_mode,
            stretch_factor: stretch_factor,
            stretch_algorithm: stretch_algorithm,
            key_match_mode: key_match_mode,
            key_match_algorithm: key_match_algorithm,
            sequence: sequence,
            step_parameters: stepParameters,
            step_length: stepLength,
            play_mode: nodeObj?.properties?.play_mode ?? data?.play_mode ?? (nodeType === "sequence" ? "gate" : undefined),
            release: nodeObj?.properties?.release ?? data?.release ?? (nodeType === "sequence" ? 0 : undefined),
            fade_ms: fadeMs,
            total_bars: total_bars,
            wrapper_bars: wrapper_bars,
            global_bars: global_bars,
            global_seed: global_seed,
            field_seed: field_seed,
            pool_node_id: pool_node_id,
            section_points: section_points,
            section_enabled: section_enabled,
            section_probability: section_probability,
            section_quant: section_quant,
            section_quant_anchor: section_quant_anchor,
            slots: slots,
            pool_query: nodeObj?.properties?.pool_query ?? data?.pool_query,
            field_operators: nodeObj?.properties?.field_operators ?? data?.field_operators,
            sample_slot: sample_slot,
            step_slots: step_slots,
            cycle_seeds: cycle_seeds,
            section_slots: section_slots,
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
