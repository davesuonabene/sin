/**
 * Pure 1:1 graph-to-DAW-timeline projection model for SIN Node Editor.
 *
 * Design invariants:
 * - Strict Track-only lanes: every top-level sink `TrackNode` forms a collapsible Master
 *   folder stacked vertically; every upstream child `TrackNode` creates an indented lane
 *   under its parent bus. Loose non-Track nodes not routed into any Track are ignored.
 * - Zero graph adaptation: every lane, clip, section, marker, and mini-graph node holds
 *   direct live references (`nodeId`) to the underlying `LGraph` nodes.
 * - Pure TypeScript (no DOM dependencies) so every rule is exhaustively unit-testable.
 */

import {
    type ChainModuleInstance,
    getPrePostGainDb,
    getUserFxStages,
    isFixedPostGain,
    isFixedPreGain,
} from '../dsp/processorRegistry.ts';

export type TimelineRulerMode = 'auto' | 'bars' | 'time';

export const TIER_RAW = 0;
export const TIER_FAST_DSP = 1;
export const TIER_COMPLEX_ML = 2;
export const TIER_STALE = 3;

// Shared 4-tier dual-color palette matching packages/ui/src/waveform-scrub.js
export const TIMELINE_TIER_COLORS: readonly [string, string, string, string] = [
    '#94a3b8', // 0 = Raw / Unbaked
    '#0891b2', // 1 = Fast DSP Baked
    '#7c3aed', // 2 = Complex ML Baked
    '#d97706', // 3 = Stale Hold
];

export const TIMELINE_TIER_RAIL_COLORS: readonly [string, string, string, string] = [
    'rgba(148, 163, 184, 0.30)',
    '#06b6d4',
    '#8b5cf6',
    '#f59e0b',
];

export const TIMELINE_TIER_BG_COLORS: readonly [string | null, string, string, string] = [
    null,
    'rgba(6, 182, 212, 0.11)',
    'rgba(139, 92, 246, 0.13)',
    'rgba(245, 158, 11, 0.15)',
];

const COVERAGE_SLOTS = 256;

export interface TimelineMiniGraphNode {
    id: number;
    nodeType: string;
    badgeLabel: string;
    title: string;
    color: string;
    kind: 'node' | 'track_target' | 'bus_stub';
    hasPool: boolean;
    poolCount: number;
    hasRandom: boolean;
    randomCount: number;
    slotCount: number;
    activeSlot: number;
    isAudioProcessor: boolean;
    bypassed: boolean;
    processorState: string | null;
    processorProgress: number;
    fxStageNames: string[];
    muted: boolean;
    solo: boolean;
    postGainDb: number;
}

export interface TimelineMiniGraphEdge {
    fromId: number;
    toId: number;
    color: string;
}

export interface TimelineMiniGraph {
    targetTrackId: number;
    nodes: TimelineMiniGraphNode[];
    edges: TimelineMiniGraphEdge[];
    processorNodeIds: number[];
}

export interface TimelineClipRegion {
    sampleNodeId: number;
    trackNodeId: number;
    label: string;
    filepath: string;
    color: string;
    sampleType: 'loop' | 'one_shot';
    startBeat: number;
    startSec: number;
    durationSec: number; // active trimmed duration on timeline (single cycle for loop)
    sourceDurationSec: number; // full untrimmed source duration at effective playback rate
    cropStart: number; // [0..1]
    cropEnd: number; // [0..1]
    playbackRate: number;
    isLooped: boolean;
    editableCrop: boolean;
    editableStartBeat: boolean;
}

export interface TimelineArrangementSection {
    arrangementNodeId: number;
    index: number;
    startBar: number;
    endBar: number;
    startSec: number;
    endSec: number;
    probability: number;
    slot: number | string;
    quant: string;
}

export interface TimelineSequenceMarker {
    sequenceNodeId: number;
    stepIndex: number;
    beat: number;
    timeSec: number;
    velocity: number;
    probability: number;
}

export interface TimelineTrackLane {
    laneKey: string;
    laneKind: 'track' | 'chain';
    trackNodeId: number;
    ownerTrackId: number;
    parentTrackId: number | null;
    rootMasterId: number;
    depth: number;
    isMasterRoot: boolean;
    isFocusedRoot: boolean;
    isMainPreview: boolean;
    hasChildTracks: boolean;
    childTrackIds: number[];
    hasSignalChainLanes: boolean;
    signalChainExpanded: boolean;
    collapsed: boolean;
    visible: boolean;
    title: string;
    color: string;
    muted: boolean;
    effectivelyMuted: boolean;
    solo: boolean;
    postGainDb: number;
    totalBars: number | null; // null => inherit / free
    rowHeight: number;
    directSubgraph: TimelineMiniGraph;
    clips: TimelineClipRegion[];
    arrangementSections: TimelineArrangementSection[];
    sequenceMarkers: TimelineSequenceMarker[];
    upstreamNodeIds: Set<string>;
}

export interface TimelineHierarchyResult {
    allLanes: TimelineTrackLane[];
    visibleLanes: TimelineTrackLane[];
    masterRootIds: number[];
    laneByTrackId: Map<number, TimelineTrackLane>;
    laneByKey: Map<string, TimelineTrackLane>;
    anySoloActive: boolean;
}

export interface TimelineBuildOptions {
    mainPreviewNodeId?: number | null;
    collapsedTrackIds?: ReadonlySet<number>;
    expandedSignalChainTrackIds?: ReadonlySet<number>;
    bpm?: number;
    globalTotalBars?: number;
    durationByFilepath?: ReadonlyMap<string, number>;
}

export interface TimelineAncestorPathItem {
    nodeId: number;
    title: string;
    badgeLabel: string;
    color: string;
    kind: 'track' | 'node';
}

export interface SignalChainRowSlot {
    col: number;
    node: TimelineMiniGraphNode;
}

export interface SignalChainRow {
    rowId: string;
    title: string;
    accentColor: string;
    isBusRow: boolean;
    feedsTarget: boolean;
    headNodeId: number;
    slots: SignalChainRowSlot[];
}

export interface SignalChainRowLayout {
    targetNode: TimelineMiniGraphNode | null;
    rows: SignalChainRow[];
    numCols: number;
    isLeafOnly: boolean;
}

export interface TimelineTimebase {
    bpm: number;
    globalTotalBars: number;
    isFreeMode: boolean;
    resolvedRulerMode: 'bars' | 'time';
    durationSec: number;
    secPerBeat: number;
    secPerBar: number;
}

export interface RulerTick {
    sec: number;
    x: number;
    label: string;
    major: boolean;
}

interface NormalizedLink {
    originId: number;
    targetId: number;
    color?: string;
}

export function getNodeTypeSafe(node: any): string {
    if (!node) return '';
    if (node.properties?.disabled || node.type === 'Audio/Disabled') return 'disabled';
    if (typeof node.getNodeType === 'function') {
        return String(node.getNodeType() || '').toLowerCase();
    }
    if (typeof node.nodeType === 'string' && node.nodeType) {
        return node.nodeType.toLowerCase();
    }
    if (typeof node.properties?.node_type === 'string' && node.properties.node_type) {
        return node.properties.node_type.toLowerCase();
    }
    const rawType = String(node.type || '');
    if (rawType === 'Audio/Track') return 'track';
    if (rawType === 'Audio/Sample') return 'sample';
    if (rawType === 'Audio/Sequence') return 'sequence';
    if (rawType === 'Audio/Arrangement') return 'arrangement';
    if (rawType === 'Audio/Null') return 'null';
    if (rawType === 'Audio/PreampDenoise') return 'preamp_denoise';
    if (rawType === 'Audio/VoiceIsolator') return 'voice_isolator';
    if (rawType === 'Audio/AssetFilter') return 'asset_filter';
    if (rawType === 'Audio/Random') return 'random';
    if (rawType === 'Audio/Modulator') return 'modulator';
    return '';
}

export function isModifierNodeSafe(node: any): boolean {
    if (!node) return false;
    if (node.isModifier || node.properties?.parentId != null) return true;
    const nt = getNodeTypeSafe(node);
    return nt === 'asset_filter' || nt === 'random' || nt === 'modulator';
}

export function isTrackNode(node: any): boolean {
    if (!node || isModifierNodeSafe(node)) return false;
    return getNodeTypeSafe(node) === 'track';
}

function getNodeColorSafe(node: any): string {
    if (!node) return '#64748b';
    if (typeof node.getNodeColor === 'function') return String(node.getNodeColor() || '#64748b');
    if (typeof node.nodeColor === 'string' && node.nodeColor) return node.nodeColor;
    return String(node.properties?.color || node.color || '#4f46e5');
}

function getNodeBadgeSafe(node: any): string {
    if (!node) return 'NODE';
    if (typeof node.getNodeBadgeLabel === 'function') return String(node.getNodeBadgeLabel() || 'NODE');
    if (typeof node.badgeLabel === 'string' && node.badgeLabel) return node.badgeLabel;
    const nt = getNodeTypeSafe(node);
    switch (nt) {
        case 'sample': return 'SMPL';
        case 'sequence': return 'SEQ';
        case 'arrangement': return 'ARR';
        case 'track': return 'TRACK';
        case 'null': return 'NULL';
        case 'preamp_denoise': return 'PREAMP';
        case 'voice_isolator': return 'VOICE';
        default: return nt.toUpperCase() || 'NODE';
    }
}

function getNodeTitleSafe(node: any): string {
    if (!node) return 'Node';
    const raw = node.properties?.node_name || node.title || getNodeBadgeSafe(node);
    return String(raw).trim() || 'Node';
}

function collectGraphNodesAndLinks(graph: any): {
    nodes: any[];
    nodeById: Map<number, any>;
    incoming: Map<number, NormalizedLink[]>;
    outgoing: Map<number, NormalizedLink[]>;
} {
    const nodes: any[] = Array.isArray(graph?._nodes)
        ? graph._nodes.filter(Boolean)
        : (Array.isArray(graph?.nodes) ? graph.nodes.filter(Boolean) : []);
    const nodeById = new Map<number, any>();
    const incoming = new Map<number, NormalizedLink[]>();
    const outgoing = new Map<number, NormalizedLink[]>();

    for (const n of nodes) {
        if (n?.id == null) continue;
        const id = Number(n.id);
        nodeById.set(id, n);
        incoming.set(id, []);
        outgoing.set(id, []);
    }

    const rawLinks = graph?.links;
    const linkList: any[] = Array.isArray(rawLinks)
        ? rawLinks
        : (rawLinks && typeof rawLinks === 'object' ? Object.values(rawLinks) : []);

    for (const l of linkList) {
        if (!l) continue;
        const originId = Number(Array.isArray(l) ? l[1] : l.origin_id);
        const targetId = Number(Array.isArray(l) ? l[3] : l.target_id);
        if (!Number.isFinite(originId) || !Number.isFinite(targetId)) continue;
        if (!nodeById.has(originId) || !nodeById.has(targetId)) continue;
        const originNode = nodeById.get(originId);
        const targetNode = nodeById.get(targetId);
        if (getNodeTypeSafe(originNode) === 'disabled' || getNodeTypeSafe(targetNode) === 'disabled') continue;
        if (isModifierNodeSafe(originNode) || isModifierNodeSafe(targetNode)) continue;
        const linkColor = Array.isArray(l) ? l[6] : l.color;
        const norm: NormalizedLink = {
            originId,
            targetId,
            color: typeof linkColor === 'string' ? linkColor : undefined,
        };
        const outArr = outgoing.get(originId)!;
        if (!outArr.some(e => e.targetId === targetId)) {
            outArr.push(norm);
        }
        const inArr = incoming.get(targetId)!;
        if (!inArr.some(e => e.originId === originId)) {
            inArr.push(norm);
        }
    }

    return { nodes, nodeById, incoming, outgoing };
}

function getAttachedModifiersCount(
    node: any,
    allNodes: any[]
): { hasPool: boolean; poolCount: number; hasRandom: boolean; randomCount: number } {
    let poolNode: any = typeof node.getAttachedPoolNode === 'function' ? node.getAttachedPoolNode() : null;
    let rndNode: any = typeof node.getAttachedRandomModNode === 'function' ? node.getAttachedRandomModNode() : null;
    if (!poolNode || !rndNode) {
        for (const cand of allNodes) {
            if (!cand || Number(cand.properties?.parentId) !== Number(node.id)) continue;
            const nt = getNodeTypeSafe(cand);
            if (!poolNode && nt === 'asset_filter') poolNode = cand;
            if (!rndNode && nt === 'random') rndNode = cand;
        }
    }
    const poolItems = Array.isArray(poolNode?.properties?.selected_items)
        ? poolNode.properties.selected_items
        : (Array.isArray(node.properties?.selected_items) ? node.properties.selected_items : []);
    const rndDests = Array.isArray(rndNode?.properties?.destinations) ? rndNode.properties.destinations : [];
    return {
        hasPool: Boolean(poolNode) || poolItems.length > 0,
        poolCount: poolItems.length,
        hasRandom: Boolean(rndNode) || rndDests.length > 0,
        randomCount: rndDests.length,
    };
}

function resolveEffectiveSamplePlaybackRate(node: any, slot: any, bpm: number): number {
    const props = node?.properties || {};
    const warpRaw = slot?.warp ?? props.warp;
    const mode = String(slot?.stretch_mode ?? props.stretch_mode ?? 'time_stretch').toLowerCase();
    const sampleType = String(slot?.sample_type ?? props.sample_type ?? 'loop').toLowerCase();
    const isWarp = warpRaw !== undefined
        ? Boolean(warpRaw)
        : (mode !== 'pitch_shift' && mode !== 'repitch' && mode !== 'varispeed' && mode !== 'off' && sampleType !== 'one_shot' && sampleType !== 'oneshot');
    const factor = Number(slot?.stretch_factor ?? slot?.time_stretch ?? props.stretch_factor ?? 1);
    const effFactor = Number.isFinite(factor) && factor > 0 ? factor : 1;
    if (!isWarp) {
        const matchTranspose = props.key_match_mode === 'follow' ? (Number(props.key_match_transpose) || 0) : 0;
        const semis = Number(slot?.transpose ?? slot?.pitch_shift ?? props.transpose ?? 0)
            + matchTranspose
            + Number(slot?.cents ?? props.cents ?? 0) / 100;
        const pitchRate = Math.pow(2, semis / 12);
        return Math.max(0.05, pitchRate * effFactor);
    }
    const origBpm = Number(slot?.original_bpm ?? props.original_bpm);
    const bpmRate = (Number.isFinite(origBpm) && origBpm > 0 && bpm > 0)
        ? bpm / origBpm
        : 1;
    return Math.max(0.05, effFactor * bpmRate);
}

function getActiveSlotSnapshot(node: any): { slot: any; activeSlot: number; slotCount: number } {
    const slots = typeof node?.getSlots === 'function'
        ? node.getSlots()
        : (Array.isArray(node?.properties?.slots) ? node.properties.slots : []);
    const count = Array.isArray(slots) ? slots.length : 0;
    const rawIdx = Number(node?.activeSlotIndex ?? node?.properties?.active_slot ?? 0);
    const activeSlot = count > 0 ? Math.max(0, Math.min(count - 1, Math.trunc(rawIdx))) : 0;
    return {
        slot: count > 0 ? slots[activeSlot] : null,
        activeSlot,
        slotCount: Math.max(1, count),
    };
}

function parseOptionalBars(value: unknown): number | null {
    if (value == null) return null;
    if (typeof value === 'string') {
        const s = value.trim().toLowerCase();
        if (!s || s === 'global' || s === 'auto' || s === 'free' || s === 'none') return null;
        const n = Number(s);
        return Number.isFinite(n) && n > 0 ? n : null;
    }
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
}

function getSpatialSortKey(node: any): number {
    const y = Array.isArray(node?.pos) ? Number(node.pos[1]) : NaN;
    return Number.isFinite(y) ? y : Number(node?.id ?? 0);
}

/**
 * Walks outgoing audio links from `trackNodeId` through non-Track pass-through/processor
 * nodes to locate the nearest downstream `TrackNode` parent bus, or `null` if top-level sink.
 */
export function findParentTrackId(
    trackNodeId: number,
    nodeById: ReadonlyMap<number, any>,
    outgoing: ReadonlyMap<number, NormalizedLink[]>
): number | null {
    const visited = new Set<number>([trackNodeId]);
    const queue: number[] = [];
    for (const edge of outgoing.get(trackNodeId) || []) {
        queue.push(edge.targetId);
    }
    while (queue.length > 0) {
        const currId = queue.shift()!;
        if (visited.has(currId)) continue;
        visited.add(currId);
        const curr = nodeById.get(currId);
        if (!curr) continue;
        if (isTrackNode(curr)) {
            return currId;
        }
        for (const edge of outgoing.get(currId) || []) {
            if (!visited.has(edge.targetId)) {
                queue.push(edge.targetId);
            }
        }
    }
    return null;
}

function isChainMuted(chain: unknown): boolean {
    if (!Array.isArray(chain)) return false;
    return chain.some(m => m && String(m.id || '').toLowerCase() === 'mute' && m.enabled !== false);
}

export function buildTimelineHierarchy(
    graph: any,
    options: TimelineBuildOptions = {}
): TimelineHierarchyResult {
    const { nodes, nodeById, incoming, outgoing } = collectGraphNodesAndLinks(graph);
    const bpm = Math.max(20, Number(options.bpm ?? graph?.extra?.global_parameters?.bpm ?? 120) || 120);
    const globalBarsRaw = options.globalTotalBars ?? graph?.extra?.global_parameters?.total_bars ?? 4;
    const globalTotalBars = Number.isFinite(Number(globalBarsRaw)) ? Number(globalBarsRaw) : 4;
    const secPerBeat = 60 / bpm;
    const secPerBar = secPerBeat * 4;
    const collapsedSet = options.collapsedTrackIds || new Set<number>();
    const expandedSignalChainSet = options.expandedSignalChainTrackIds || new Set<number>();

    const trackNodes = nodes.filter(isTrackNode);
    const parentByTrackId = new Map<number, number | null>();
    const childrenByTrackId = new Map<number, number[]>();

    for (const t of trackNodes) {
        const tid = Number(t.id);
        childrenByTrackId.set(tid, []);
    }

    for (const t of trackNodes) {
        const tid = Number(t.id);
        const parentId = findParentTrackId(tid, nodeById, outgoing);
        parentByTrackId.set(tid, parentId);
        if (parentId != null && childrenByTrackId.has(parentId)) {
            childrenByTrackId.get(parentId)!.push(tid);
        }
    }

    const mainPreviewId = options.mainPreviewNodeId != null ? Number(options.mainPreviewNodeId) : null;
    const sortTracks = (ids: number[], prioritizeMain: boolean) => {
        ids.sort((a, b) => {
            if (prioritizeMain) {
                const aMain = a === mainPreviewId ? 0 : 1;
                const bMain = b === mainPreviewId ? 0 : 1;
                if (aMain !== bMain) return aMain - bMain;
                const na = nodeById.get(a);
                const nb = nodeById.get(b);
                const aRole = (na?.isMasterNode || na?.properties?.role === 'master') ? 0 : 1;
                const bRole = (nb?.isMasterNode || nb?.properties?.role === 'master') ? 0 : 1;
                if (aRole !== bRole) return aRole - bRole;
            }
            const ya = getSpatialSortKey(nodeById.get(a));
            const yb = getSpatialSortKey(nodeById.get(b));
            if (ya !== yb) return ya - yb;
            return a - b;
        });
    };

    const masterRootIds = trackNodes
        .map(t => Number(t.id))
        .filter(tid => parentByTrackId.get(tid) === null);
    sortTracks(masterRootIds, true);

    for (const childIds of childrenByTrackId.values()) {
        sortTracks(childIds, false);
    }

    const anySoloActive = trackNodes.some(t => Boolean(t.properties?.solo));

    const buildMiniGraphNode = (
        node: any,
        kind: 'node' | 'track_target' | 'bus_stub'
    ): TimelineMiniGraphNode => {
        const props = node.properties || {};
        const mods = getAttachedModifiersCount(node, nodes);
        const nt = getNodeTypeSafe(node);
        const { activeSlot, slotCount } = (nt === 'sample' || nt === 'sequence')
            ? getActiveSlotSnapshot(node)
            : { activeSlot: 0, slotCount: 1 };
        const isProc = Boolean(node.isAudioProcessor || nt === 'preamp_denoise' || nt === 'voice_isolator');
        const { postDb } = getPrePostGainDb(props.chain);
        const fxStages = getUserFxStages(props.chain)
            .filter(s => s.module.enabled !== false)
            .map(s => s.module.name || s.def.label);
        return {
            id: Number(node.id),
            nodeType: nt,
            badgeLabel: kind === 'bus_stub' ? 'BUS IN' : getNodeBadgeSafe(node),
            title: getNodeTitleSafe(node),
            color: getNodeColorSafe(node),
            kind,
            hasPool: mods.hasPool,
            poolCount: mods.poolCount,
            hasRandom: mods.hasRandom,
            randomCount: mods.randomCount,
            slotCount,
            activeSlot,
            isAudioProcessor: isProc,
            bypassed: Boolean(props.bypass),
            processorState: isProc ? String(node.processorStatus?.state || (props.bypass ? 'bypassed' : 'ready')) : null,
            processorProgress: isProc ? Number(node.processorStatus?.progress ?? 1) : 1,
            fxStageNames: fxStages,
            muted: Boolean(props.muted || isChainMuted(props.chain)),
            solo: Boolean(props.solo),
            postGainDb: postDb,
        };
    };

    const buildDirectSubgraphAndOverlays = (
        rootNode: any,
        effectiveBars: number | null,
        includeRootAsSource = false
    ) => {
        const trackId = Number(rootNode.id);
        const mgNodes = new Map<number, TimelineMiniGraphNode>();
        const mgEdges: TimelineMiniGraphEdge[] = [];
        const edgeKeys = new Set<string>();
        const processorNodeIds: number[] = [];
        const directNodeIds = new Set<string>([String(trackId)]);

        const rootBuilt = buildMiniGraphNode(rootNode, includeRootAsSource ? 'node' : 'track_target');
        mgNodes.set(trackId, rootBuilt);

        // Walk backward along incoming links, stopping at child TrackNode boundaries
        const visited = new Set<number>([trackId]);
        // Track whether path from targetTrack passes through Sequence/Arrangement (affects Sample start_beat editability)
        const sampleMeta = new Map<number, { underGenerator: boolean }>();
        const arrangementNodes: any[] = [];
        const sequenceNodes: any[] = [];
        let initialUnderGen = false;
        if (includeRootAsSource) {
            if (rootBuilt.isAudioProcessor) {
                processorNodeIds.push(trackId);
            }
            const rootType = getNodeTypeSafe(rootNode);
            if (rootType === 'sample') {
                sampleMeta.set(trackId, { underGenerator: false });
            } else if (rootType === 'arrangement') {
                arrangementNodes.push(rootNode);
                initialUnderGen = true;
            } else if (rootType === 'sequence') {
                sequenceNodes.push(rootNode);
                initialUnderGen = true;
            }
        }
        const queue: Array<{ nodeId: number; underGenerator: boolean }> = [{ nodeId: trackId, underGenerator: initialUnderGen }];

        while (queue.length > 0) {
            const { nodeId: currId, underGenerator } = queue.shift()!;
            const inEdges = incoming.get(currId) || [];
            for (const edge of inEdges) {
                const srcId = edge.originId;
                const srcNode = nodeById.get(srcId);
                if (!srcNode) continue;

                const eKey = `${srcId}->${currId}`;
                if (!edgeKeys.has(eKey)) {
                    edgeKeys.add(eKey);
                    mgEdges.push({
                        fromId: srcId,
                        toId: currId,
                        color: edge.color || getNodeColorSafe(srcNode),
                    });
                }

                if (isTrackNode(srcNode)) {
                    if (!mgNodes.has(srcId)) {
                        mgNodes.set(srcId, buildMiniGraphNode(srcNode, 'bus_stub'));
                    }
                    continue; // Strict Track boundary: do not walk inside child Track
                }

                directNodeIds.add(String(srcId));
                if (!mgNodes.has(srcId)) {
                    const built = buildMiniGraphNode(srcNode, 'node');
                    mgNodes.set(srcId, built);
                    if (built.isAudioProcessor) {
                        processorNodeIds.push(srcId);
                    }
                }

                const srcType = getNodeTypeSafe(srcNode);
                const nextUnderGen = underGenerator || srcType === 'sequence' || srcType === 'arrangement';

                if (srcType === 'sample') {
                    const prev = sampleMeta.get(srcId);
                    sampleMeta.set(srcId, {
                        underGenerator: prev ? (prev.underGenerator && underGenerator) : underGenerator,
                    });
                } else if (srcType === 'arrangement' && !visited.has(srcId)) {
                    arrangementNodes.push(srcNode);
                } else if (srcType === 'sequence' && !visited.has(srcId)) {
                    sequenceNodes.push(srcNode);
                }

                if (!visited.has(srcId)) {
                    visited.add(srcId);
                    queue.push({ nodeId: srcId, underGenerator: nextUnderGen });
                }
            }
        }

        // Build direct Sample clip regions
        const clips: TimelineClipRegion[] = [];
        for (const [sampleId, meta] of sampleMeta.entries()) {
            const sampleNode = nodeById.get(sampleId);
            if (!sampleNode) continue;
            const props = sampleNode.properties || {};
            const { slot } = getActiveSlotSnapshot(sampleNode);
            const filepath = String(slot?.filepath || props.filepath || '').trim();
            const cropStart = Math.max(0, Math.min(1, Number(slot?.crop_start ?? props.crop_start ?? 0) || 0));
            const rawEnd = slot?.crop_end ?? props.crop_end;
            const cropEnd = Math.max(cropStart + 0.001, Math.min(1, rawEnd != null ? Number(rawEnd) : 1));
            const startBeat = Math.max(0, Number(slot?.start_beat ?? props.start_beat ?? 0) || 0);
            const repeatRaw = slot?.repeat ?? props.repeat;
            const sampleTypeRaw = String(slot?.sample_type ?? props.sample_type ?? 'loop').toLowerCase();
            const isRepeat = repeatRaw !== undefined
                ? Boolean(repeatRaw)
                : (sampleTypeRaw !== 'one_shot' && sampleTypeRaw !== 'oneshot');
            const sampleType: 'loop' | 'one_shot' = isRepeat ? 'loop' : 'one_shot';
            const rate = resolveEffectiveSamplePlaybackRate(sampleNode, slot, bpm);
            const rawFileDur = Number(
                slot?.duration_seconds
                ?? props.duration_seconds
                ?? sampleNode.audioBuffer?.duration
                ?? (filepath ? options.durationByFilepath?.get(filepath) : undefined)
                ?? sampleNode.realtimePeaksDuration
                ?? 0
            );
            const safeRawDur = Number.isFinite(rawFileDur) && rawFileDur > 0 ? rawFileDur : 0;
            const sourceDurationSec = safeRawDur > 0 ? safeRawDur / rate : 0;
            const trimmedDur = sourceDurationSec > 0 ? Math.max(0.02, (cropEnd - cropStart) * sourceDurationSec) : 0;
            const fileBasename = filepath ? filepath.split(/[/\\]/).pop() || '' : '';
            const label = getNodeTitleSafe(sampleNode) !== 'Sample'
                ? getNodeTitleSafe(sampleNode)
                : (fileBasename || 'Sample');

            clips.push({
                sampleNodeId: sampleId,
                trackNodeId: trackId,
                label,
                filepath,
                color: getNodeColorSafe(sampleNode),
                sampleType,
                startBeat,
                startSec: startBeat * secPerBeat,
                durationSec: trimmedDur,
                sourceDurationSec,
                cropStart,
                cropEnd,
                playbackRate: rate,
                isLooped: sampleType === 'loop',
                editableCrop: !meta.underGenerator,
                editableStartBeat: !meta.underGenerator,
            });
        }

        // Build Arrangement section overlays
        const arrangementSections: TimelineArrangementSection[] = [];
        for (const arrNode of arrangementNodes) {
            const props = arrNode.properties || {};
            const totalBars = parseOptionalBars(props.total_bars) ?? effectiveBars ?? (globalTotalBars > 0 ? globalTotalBars : 4);
            const structure = typeof arrNode.getSectionStructure === 'function'
                ? arrNode.getSectionStructure()
                : {
                    points: Array.isArray(props.section_points) ? props.section_points.map(Number).filter((p: number) => Number.isFinite(p) && p > 0 && p < totalBars).sort((a: number, b: number) => a - b) : [],
                    probability: Array.isArray(props.section_probability) ? props.section_probability : [1],
                    quant: Array.isArray(props.section_quant) ? props.section_quant : ['auto'],
                    slots: Array.isArray(props.section_slots) ? props.section_slots : ['*'],
                };
            const resolvedSlots = typeof arrNode.getResolvedSectionSlots === 'function'
                ? arrNode.getResolvedSectionSlots()
                : (structure.slots || ['*']);
            const boundaries = [0, ...structure.points, totalBars];
            for (let i = 0; i < boundaries.length - 1; i++) {
                const sb = boundaries[i];
                const eb = boundaries[i + 1];
                if (eb <= sb) continue;
                arrangementSections.push({
                    arrangementNodeId: Number(arrNode.id),
                    index: i,
                    startBar: sb,
                    endBar: eb,
                    startSec: sb * secPerBar,
                    endSec: eb * secPerBar,
                    probability: Number(structure.probability?.[i] ?? 1),
                    slot: resolvedSlots[i] ?? '*',
                    quant: String(structure.quant?.[i] ?? 'auto'),
                });
            }
        }

        // Build Sequence step hit markers
        const sequenceMarkers: TimelineSequenceMarker[] = [];
        for (const seqNode of sequenceNodes) {
            const props = seqNode.properties || {};
            const seqArr: number[] = Array.isArray(props.sequence) ? props.sequence : [];
            const stepParams: any[] = Array.isArray(props.step_parameters) ? props.step_parameters : [];
            const stepLen = Math.max(0.0625, Number(props.step_length) || 0.25);
            const targetBars = parseOptionalBars(props.total_bars) ?? effectiveBars ?? (globalTotalBars > 0 ? globalTotalBars : 4);
            const totalBeats = Math.max(stepLen, targetBars * 4);
            const patternBeats = Math.max(stepLen, seqArr.length * stepLen);
            if (seqArr.length === 0) continue;

            const maxRepeats = Math.min(64, Math.ceil(totalBeats / patternBeats));
            for (let rep = 0; rep < maxRepeats; rep++) {
                const baseBeat = rep * patternBeats;
                for (let i = 0; i < seqArr.length; i++) {
                    if (!seqArr[i]) continue;
                    const sp = stepParams[i] || {};
                    const offset = Number(sp.offset) || 0;
                    const beat = baseBeat + (i + offset) * stepLen;
                    if (beat < -1e-4 || beat >= totalBeats - 1e-4) continue;
                    const rawVel = Number(sp.velocity ?? 1);
                    const rawProb = Number(sp.probability ?? 1);
                    sequenceMarkers.push({
                        sequenceNodeId: Number(seqNode.id),
                        stepIndex: i,
                        beat: Math.max(0, beat),
                        timeSec: Math.max(0, beat) * secPerBeat,
                        velocity: Math.max(0, Math.min(1, rawVel > 1 ? rawVel / 100 : rawVel)),
                        probability: Math.max(0, Math.min(1, rawProb > 1 ? rawProb / 100 : rawProb)),
                    });
                }
            }
        }

        return {
            directSubgraph: {
                targetTrackId: trackId,
                nodes: Array.from(mgNodes.values()),
                edges: mgEdges,
                processorNodeIds,
            },
            clips,
            arrangementSections,
            sequenceMarkers,
            directNodeIds,
        };
    };

    const allLanes: TimelineTrackLane[] = [];
    const laneByTrackId = new Map<number, TimelineTrackLane>();
    const laneByKey = new Map<string, TimelineTrackLane>();
    const visitedTracks = new Set<number>();

    const walkTrack = (
        trackId: number,
        rootMasterId: number,
        depth: number,
        ancestorCollapsed: boolean,
        ancestorMuted: boolean,
        inheritedBars: number | null,
        isFocusedRoot = false
    ): Set<string> => {
        if (visitedTracks.has(trackId)) return new Set();
        visitedTracks.add(trackId);
        const trackNode = nodeById.get(trackId);
        if (!trackNode) return new Set();

        const props = trackNode.properties || {};
        const childIds = childrenByTrackId.get(trackId) || [];
        const directNonTrackInputs = (incoming.get(trackId) || [])
            .map(e => nodeById.get(e.originId))
            .filter((n): n is any => Boolean(n && !isTrackNode(n)))
            .sort((a, b) => {
                const ya = getSpatialSortKey(a);
                const yb = getSpatialSortKey(b);
                return ya !== yb ? ya - yb : Number(a.id) - Number(b.id);
            });
        const hasSignalChainLanes = directNonTrackInputs.length > 0;
        const signalChainExpanded = hasSignalChainLanes && (isFocusedRoot || expandedSignalChainSet.has(trackId));
        const collapsed = isFocusedRoot ? false : collapsedSet.has(trackId);
        const ownMuted = Boolean(props.muted || isChainMuted(props.chain));
        const ownSolo = Boolean(props.solo);
        const ownBars = parseOptionalBars(props.total_bars);
        const effectiveBars = ownBars ?? inheritedBars;
        const { postDb } = getPrePostGainDb(props.chain);

        const {
            directSubgraph,
            clips,
            arrangementSections,
            sequenceMarkers,
            directNodeIds,
        } = buildDirectSubgraphAndOverlays(trackNode, effectiveBars, false);

        const laneKey = `track:${trackId}`;
        const lane: TimelineTrackLane = {
            laneKey,
            laneKind: 'track',
            trackNodeId: trackId,
            ownerTrackId: trackId,
            parentTrackId: isFocusedRoot ? null : (parentByTrackId.get(trackId) ?? null),
            rootMasterId,
            depth,
            isMasterRoot: depth === 0,
            isFocusedRoot,
            isMainPreview: mainPreviewId != null && trackId === mainPreviewId,
            hasChildTracks: childIds.length > 0,
            childTrackIds: [...childIds],
            hasSignalChainLanes,
            signalChainExpanded,
            collapsed,
            visible: !ancestorCollapsed,
            title: getNodeTitleSafe(trackNode),
            color: getNodeColorSafe(trackNode),
            muted: ownMuted,
            effectivelyMuted: ownMuted || ancestorMuted,
            solo: ownSolo,
            postGainDb: postDb,
            totalBars: ownBars,
            rowHeight: depth === 0 || childIds.length > 0 ? 52 : 56,
            directSubgraph,
            clips,
            arrangementSections,
            sequenceMarkers,
            upstreamNodeIds: new Set<string>(directNodeIds),
        };

        allLanes.push(lane);
        laneByTrackId.set(trackId, lane);
        laneByKey.set(laneKey, lane);

        if (signalChainExpanded) {
            for (const entryNode of directNonTrackInputs) {
                const entryId = Number(entryNode.id);
                const eProps = entryNode.properties || {};
                const eMuted = Boolean(eProps.muted || isChainMuted(eProps.chain));
                const eSolo = Boolean(eProps.solo);
                const { postDb: ePostDb } = getPrePostGainDb(eProps.chain);
                const eSub = buildDirectSubgraphAndOverlays(entryNode, effectiveBars, true);
                const cKey = `chain:${trackId}:${entryId}`;
                const chainLane: TimelineTrackLane = {
                    laneKey: cKey,
                    laneKind: 'chain',
                    trackNodeId: entryId,
                    ownerTrackId: trackId,
                    parentTrackId: trackId,
                    rootMasterId,
                    depth: depth + 1,
                    isMasterRoot: false,
                    isFocusedRoot: false,
                    isMainPreview: false,
                    hasChildTracks: false,
                    childTrackIds: [],
                    hasSignalChainLanes: false,
                    signalChainExpanded: false,
                    collapsed: false,
                    visible: !ancestorCollapsed && !collapsed,
                    title: getNodeTitleSafe(entryNode),
                    color: getNodeColorSafe(entryNode),
                    muted: eMuted,
                    effectivelyMuted: eMuted || ownMuted || ancestorMuted,
                    solo: eSolo,
                    postGainDb: ePostDb,
                    totalBars: parseOptionalBars(eProps.total_bars) ?? effectiveBars,
                    rowHeight: 46,
                    directSubgraph: eSub.directSubgraph,
                    clips: eSub.clips,
                    arrangementSections: eSub.arrangementSections,
                    sequenceMarkers: eSub.sequenceMarkers,
                    upstreamNodeIds: new Set<string>(eSub.directNodeIds),
                };
                allLanes.push(chainLane);
                laneByKey.set(cKey, chainLane);
            }
        }

        for (const cid of childIds) {
            const childUpstream = walkTrack(
                cid,
                rootMasterId,
                depth + 1,
                ancestorCollapsed || collapsed,
                ownMuted || ancestorMuted,
                effectiveBars,
                false
            );
            for (const uid of childUpstream) {
                lane.upstreamNodeIds.add(uid);
            }
        }

        return lane.upstreamNodeIds;
    };

    const initialBars = globalTotalBars > 0 ? globalTotalBars : null;
    for (const rootId of masterRootIds) {
        walkTrack(rootId, rootId, 0, false, false, initialBars, false);
    }

    // Apply solo dimming pass: non-solo leaf/bus tracks dim unless they are soloed or carry a soloed descendant
    if (anySoloActive) {
        const soloedTrackIds = new Set(allLanes.filter(l => l.laneKind === 'track' && l.solo).map(l => l.trackNodeId));
        const activeUnderSolo = new Set<number>();
        for (const sid of soloedTrackIds) {
            activeUnderSolo.add(sid);
            // Ancestors of a soloed track stay audible (they carry the soloed signal to Master)
            let cur = laneByTrackId.get(sid)?.parentTrackId ?? null;
            while (cur != null) {
                activeUnderSolo.add(cur);
                cur = laneByTrackId.get(cur)?.parentTrackId ?? null;
            }
            // Descendants of a soloed bus stay audible
            const stack = [...(laneByTrackId.get(sid)?.childTrackIds || [])];
            while (stack.length > 0) {
                const d = stack.pop()!;
                activeUnderSolo.add(d);
                for (const c of laneByTrackId.get(d)?.childTrackIds || []) {
                    stack.push(c);
                }
            }
        }
        for (const lane of allLanes) {
            const checkId = lane.laneKind === 'chain' ? lane.ownerTrackId : lane.trackNodeId;
            if (!activeUnderSolo.has(checkId)) {
                lane.effectivelyMuted = true;
            }
        }
    }

    const visibleLanes = allLanes.filter(l => l.visible);
    return {
        allLanes,
        visibleLanes,
        masterRootIds,
        laneByTrackId,
        laneByKey,
        anySoloActive,
    };
}

/**
 * Clean collapsible upstream row subdivision for the bottom signal-chain rack.
 *
 * The selected lane's target node (`targetNode`) is NEVER placed as a row card; it is returned
 * separately so it docks into the dedicated right-hand Mixer Section with vertical DAW FX slots.
 * All upstream parallel chains feeding `targetNode` are returned as collapsible horizontal rows
 * aligned by serial column `0..numCols-1` (leaving blank space where shorter chains finish early).
 */
export function layoutSignalChainRows(subgraph: TimelineMiniGraph): SignalChainRowLayout {
    if (!subgraph.nodes.length) {
        return { targetNode: null, rows: [], numCols: 0, isLeafOnly: false };
    }

    const nodeMap = new Map<number, TimelineMiniGraphNode>();
    const incoming = new Map<number, number[]>();
    const directToTarget = new Set<number>();
    for (const n of subgraph.nodes) {
        nodeMap.set(n.id, n);
        incoming.set(n.id, []);
    }
    const targetNode = nodeMap.get(subgraph.targetTrackId) ?? subgraph.nodes[subgraph.nodes.length - 1];
    for (const e of subgraph.edges) {
        if (nodeMap.has(e.fromId) && nodeMap.has(e.toId)) {
            incoming.get(e.toId)!.push(e.fromId);
            if (e.toId === targetNode.id) {
                directToTarget.add(e.fromId);
            }
        }
    }

    const isLeafOnly = targetNode.kind !== 'track_target';

    // Longest-path serial column index per upstream node (leaves at col 0, flowing left -> right)
    const cols = new Map<number, number>();
    const visiting = new Set<number>();
    const computeCol = (id: number): number => {
        if (cols.has(id)) return cols.get(id)!;
        if (visiting.has(id)) return 0;
        visiting.add(id);
        let maxP = -1;
        for (const pid of incoming.get(id) || []) {
            if (pid === targetNode.id) continue;
            maxP = Math.max(maxP, computeCol(pid));
        }
        visiting.delete(id);
        const c = maxP + 1;
        cols.set(id, c);
        return c;
    };
    for (const n of subgraph.nodes) {
        if (n.id !== targetNode.id) {
            computeCol(n.id);
        }
    }

    // Reserve targetNode so it ONLY lives in the right-docked Mixer Section
    const placed = new Set<number>([targetNode.id]);
    const decomposeBranch = (rootId: number): SignalChainRow[] => {
        const resultRows: SignalChainRow[] = [];

        const collectPrimaryChain = (headId: number): number[] => {
            const chainIds: number[] = [];
            let cur: number | null = headId;
            const guard = new Set<number>();
            while (cur != null && !guard.has(cur) && !placed.has(cur)) {
                guard.add(cur);
                chainIds.push(cur);
                placed.add(cur);
                const parents: number[] = [...(incoming.get(cur) || [])]
                    .filter((pid: number) => !placed.has(pid))
                    .sort((a: number, b: number) => a - b);
                if (parents.length === 0) break;
                let bestParent: number = parents[0];
                let bestCol: number = cols.get(bestParent) ?? 0;
                for (let i = 1; i < parents.length; i++) {
                    const pc = cols.get(parents[i]) ?? 0;
                    if (pc > bestCol) {
                        bestCol = pc;
                        bestParent = parents[i];
                    }
                }
                const extraParents = parents.filter((pid: number) => pid !== bestParent);
                cur = bestParent;
                for (const ep of extraParents) {
                    resultRows.push(...decomposeBranch(ep));
                }
            }
            chainIds.reverse();
            return chainIds;
        };

        const primaryIds = collectPrimaryChain(rootId);
        if (primaryIds.length > 0) {
            const headNode = nodeMap.get(primaryIds[primaryIds.length - 1])!;
            const slots: SignalChainRowSlot[] = primaryIds
                .map(id => ({ col: cols.get(id) ?? 0, node: nodeMap.get(id)! }))
                .sort((a, b) => a.col - b.col);
            resultRows.unshift({
                rowId: `row:${headNode.id}`,
                title: headNode.title,
                accentColor: headNode.color,
                isBusRow: false,
                feedsTarget: directToTarget.has(headNode.id),
                headNodeId: headNode.id,
                slots,
            });
        }
        return resultRows;
    };

    const rows: SignalChainRow[] = [];
    const directInputs = [...(incoming.get(targetNode.id) || [])].sort((a, b) => a - b);
    for (const inId of directInputs) {
        rows.push(...decomposeBranch(inId));
    }

    // Safety net: include any unplaced upstream node in its own row
    for (const n of subgraph.nodes) {
        if (!placed.has(n.id)) {
            placed.add(n.id);
            rows.push({
                rowId: `row:${n.id}`,
                title: n.title,
                accentColor: n.color,
                isBusRow: false,
                feedsTarget: directToTarget.has(n.id),
                headNodeId: n.id,
                slots: [{ col: cols.get(n.id) ?? 0, node: n }],
            });
        }
    }

    let numCols = 0;
    for (const r of rows) {
        for (const s of r.slots) {
            numCols = Math.max(numCols, s.col + 1);
        }
    }

    return { targetNode, rows, numCols, isLeafOnly };
}

interface RawLinkEntry {
    id: number;
    origin_id: number;
    origin_slot: number;
    target_id: number;
    target_slot: number;
}

function collectRawLinkEntries(graph: any): RawLinkEntry[] {
    const rawLinks = graph?.links;
    const list: any[] = Array.isArray(rawLinks)
        ? rawLinks
        : (rawLinks && typeof rawLinks === 'object' ? Object.values(rawLinks) : []);
    const out: RawLinkEntry[] = [];
    for (const l of list) {
        if (!l) continue;
        if (Array.isArray(l)) {
            out.push({
                id: Number(l[0]),
                origin_id: Number(l[1]),
                origin_slot: Number(l[2] || 0),
                target_id: Number(l[3]),
                target_slot: Number(l[4] || 0),
            });
        } else if (l.origin_id != null && l.target_id != null) {
            out.push({
                id: Number(l.id),
                origin_id: Number(l.origin_id),
                origin_slot: Number(l.origin_slot || 0),
                target_id: Number(l.target_id),
                target_slot: Number(l.target_slot || 0),
            });
        }
    }
    return out;
}

/**
 * Computes the complete ancestor path from the outermost root Master bus down to `nodeId`
 * (e.g. `[Master, Drums Bus, Kick Seq, Kick Sample]`).
 */
export function computeNodeAncestorPath(graph: any, nodeId: number | null): TimelineAncestorPathItem[] {
    if (!graph || nodeId == null) return [];
    const { nodeById, outgoing } = collectGraphNodesAndLinks(graph);
    const startNode = nodeById.get(Number(nodeId));
    if (!startNode || isModifierNodeSafe(startNode) || getNodeTypeSafe(startNode) === 'disabled') return [];

    const rev: TimelineAncestorPathItem[] = [];
    const visited = new Set<number>();
    let curId: number | null = Number(nodeId);
    while (curId != null && !visited.has(curId)) {
        visited.add(curId);
        const node = nodeById.get(curId);
        if (!node) break;
        rev.push({
            nodeId: curId,
            title: getNodeTitleSafe(node),
            badgeLabel: getNodeBadgeSafe(node),
            color: getNodeColorSafe(node),
            kind: isTrackNode(node) ? 'track' : 'node',
        });
        const outs: number[] = (outgoing.get(curId) || [])
            .map(e => e.targetId)
            .filter(tid => !visited.has(tid));
        if (outs.length === 0) break;
        // Prefer Track/Bus targets when fanning out, otherwise follow first downstream consumer
        const trackTarget = outs.find((tid: number) => isTrackNode(nodeById.get(tid)));
        curId = trackTarget ?? outs[0];
    }

    rev.reverse();
    return rev;
}

/**
 * Computes the ancestor path rooted at `previewAncestorId` (the active node shown in the Transport Bar).
 * - If `selectedNodeId` lies within `previewAncestorId`'s upstream subtree (or equals it), returns
 *   `[previewAncestor, ..., selectedNode]` so the leftmost crumb is always the active preview ancestor.
 * - If `selectedNodeId` is null or outside `previewAncestorId`'s subtree (e.g. solo-previewing a leaf),
 *   returns `[previewAncestor]` so the path always matches what is being previewed.
 */
export function computeScopedAncestorPath(
    graph: any,
    selectedNodeId: number | null,
    previewAncestorId: number | null
): TimelineAncestorPathItem[] {
    if (!graph) return [];
    const selectedPath = selectedNodeId != null ? computeNodeAncestorPath(graph, selectedNodeId) : [];
    if (previewAncestorId == null) {
        return selectedPath;
    }
    const targetAncestor = Number(previewAncestorId);
    const idx = selectedPath.findIndex(item => item.nodeId === targetAncestor);
    if (idx >= 0) {
        return selectedPath.slice(idx);
    }
    const ancestorFull = computeNodeAncestorPath(graph, targetAncestor);
    return ancestorFull.length > 0 ? [ancestorFull[ancestorFull.length - 1]] : selectedPath;
}

function getAudioInputSlotCount(node: any): number {
    if (!Array.isArray(node?.inputs)) return 0;
    let count = 0;
    for (const inp of node.inputs) {
        if (!inp) continue;
        const t = String(inp.type ?? 'audio').toLowerCase();
        if (t === 'audio' || t === '' || t === '*' || t === '0') count++;
    }
    return count;
}

function getAudioOutputSlotCount(node: any): number {
    if (!Array.isArray(node?.outputs)) return 0;
    let count = 0;
    for (const out of node.outputs) {
        if (!out) continue;
        const t = String(out.type ?? 'audio').toLowerCase();
        if (t === 'audio' || t === '' || t === '*' || t === '0') count++;
    }
    return count;
}

/**
 * Checks whether two nodes can safely swap their signal-flow positions (in/out cables + canvas coords)
 * without violating port constraints (e.g. wiring audio into a 0-input source-only SampleNode).
 */
export function canSwapGraphNodes(graph: any, nodeIdA: number, nodeIdB: number): boolean {
    if (!graph || nodeIdA === nodeIdB) return false;
    const nodeA = graph.getNodeById?.(nodeIdA);
    const nodeB = graph.getNodeById?.(nodeIdB);
    if (!nodeA || !nodeB) return false;
    if (isModifierNodeSafe(nodeA) || isModifierNodeSafe(nodeB)) return false;

    const links = collectRawLinkEntries(graph).filter((l: RawLinkEntry) => {
        const oid = l.origin_id;
        const tid = l.target_id;
        if (oid !== nodeIdA && oid !== nodeIdB && tid !== nodeIdA && tid !== nodeIdB) return false;
        const oNode = graph.getNodeById?.(oid);
        const tNode = graph.getNodeById?.(tid);
        if (isModifierNodeSafe(oNode) || isModifierNodeSafe(tNode)) return false;
        return true;
    });

    const swapId = (id: number) => (id === nodeIdA ? nodeIdB : (id === nodeIdB ? nodeIdA : id));
    const inCount = new Map<number, number>([[nodeIdA, 0], [nodeIdB, 0]]);
    const outCount = new Map<number, number>([[nodeIdA, 0], [nodeIdB, 0]]);

    for (const l of links) {
        const newO = swapId(l.origin_id);
        const newT = swapId(l.target_id);
        if (newO === newT) return false;
        if (outCount.has(newO)) outCount.set(newO, (outCount.get(newO) || 0) + 1);
        if (inCount.has(newT)) inCount.set(newT, (inCount.get(newT) || 0) + 1);
    }

    for (const [id, node] of [[nodeIdA, nodeA], [nodeIdB, nodeB]] as const) {
        const needIn = inCount.get(id) || 0;
        const needOut = outCount.get(id) || 0;
        const availIn = getAudioInputSlotCount(node);
        const availOut = getAudioOutputSlotCount(node);
        if (needIn > 0 && availIn === 0) return false;
        if (needOut > 0 && availOut === 0) return false;
        if (needIn > 1 && availIn < needIn && !isTrackNode(node)) return false;
    }

    return true;
}

/**
 * Swaps two nodes in the live LGraph:
 * 1. Swaps all non-modifier in/out audio cables so signal flow order swaps cleanly
 *    (handles adjacent serial `1->A->B->4 => 1->B->A->4`, non-adjacent serial, and parallel swaps).
 * 2. Swaps their `[x, y]` canvas coordinates in the graph.
 */
export function swapGraphNodes(graph: any, nodeIdA: number, nodeIdB: number): boolean {
    if (!canSwapGraphNodes(graph, nodeIdA, nodeIdB)) return false;
    const nodeA = graph.getNodeById(nodeIdA);
    const nodeB = graph.getNodeById(nodeIdB);
    if (!nodeA || !nodeB) return false;

    const links = collectRawLinkEntries(graph).filter((l: RawLinkEntry) => {
        const oid = l.origin_id;
        const tid = l.target_id;
        if (oid !== nodeIdA && oid !== nodeIdB && tid !== nodeIdA && tid !== nodeIdB) return false;
        const oNode = graph.getNodeById?.(oid);
        const tNode = graph.getNodeById?.(tid);
        return !isModifierNodeSafe(oNode) && !isModifierNodeSafe(tNode);
    });

    const snapshot = links.map((l: RawLinkEntry) => ({
        id: l.id,
        originId: l.origin_id,
        originSlot: l.origin_slot,
        targetId: l.target_id,
        targetSlot: l.target_slot,
    }));

    // 1. Swap canvas coordinates
    const posA: [number, number] = [Number(nodeA.pos?.[0] ?? 0), Number(nodeA.pos?.[1] ?? 0)];
    const posB: [number, number] = [Number(nodeB.pos?.[0] ?? 0), Number(nodeB.pos?.[1] ?? 0)];
    nodeA.pos = [posB[0], posB[1]];
    nodeB.pos = [posA[0], posA[1]];

    // 2. Remove existing links touching A or B
    for (const s of snapshot) {
        if (typeof graph.removeLink === 'function') {
            graph.removeLink(s.id);
        } else if (graph.links && typeof graph.links === 'object') {
            delete graph.links[s.id];
        }
    }

    // 3. Reconnect with A <-> B swapped
    const swapId = (id: number) => (id === nodeIdA ? nodeIdB : (id === nodeIdB ? nodeIdA : id));
    const usedInputSlots = new Map<number, Set<number>>();

    for (const s of snapshot) {
        const newOriginId = swapId(s.originId);
        const newTargetId = swapId(s.targetId);
        const newOrigin = graph.getNodeById(newOriginId);
        const newTarget = graph.getNodeById(newTargetId);
        if (!newOrigin || !newTarget) continue;

        const outSlot = s.originSlot < (newOrigin.outputs?.length || 0) ? s.originSlot : 0;

        let used = usedInputSlots.get(newTargetId);
        if (!used) {
            used = new Set<number>();
            usedInputSlots.set(newTargetId, used);
        }

        // Preserve exact target slot if target node didn't swap (e.g. a downstream multi-input Track)
        let inSlot = 0;
        if (newTargetId === s.targetId && s.targetSlot < (newTarget.inputs?.length || 0) && !used.has(s.targetSlot)) {
            inSlot = s.targetSlot;
        } else {
            const totalIn = newTarget.inputs?.length || 0;
            let found = -1;
            for (let idx = 0; idx < totalIn; idx++) {
                if (!used.has(idx) && newTarget.inputs[idx]?.link == null) {
                    found = idx;
                    break;
                }
            }
            if (found >= 0) {
                inSlot = found;
            } else if (isTrackNode(newTarget) && typeof newTarget.addInput === 'function') {
                newTarget.addInput('Input', 'audio');
                inSlot = (newTarget.inputs?.length || 1) - 1;
            } else {
                inSlot = 0;
            }
        }
        used.add(inSlot);

        if (typeof newOrigin.connect === 'function') {
            newOrigin.connect(outSlot, newTarget, inSlot);
        }
    }

    return true;
}

/**
 * Pure FX chain helpers for reordering, cross-node dragging, and copy/paste.
 */
export function cloneFxModuleWithFreshId(mod: ChainModuleInstance): ChainModuleInstance {
    const baseType = String(mod.type || 'fx').trim().toLowerCase();
    return {
        ...mod,
        id: `${baseType}_${Math.random().toString(36).substring(2, 8)}`,
        fixed: false,
        params: { ...(mod.params || {}) },
    };
}

function splitChainEndpoints(chain: unknown): { pre: any | null; middle: any[]; post: any | null } {
    const arr = Array.isArray(chain) ? chain.map(m => (m && typeof m === 'object' ? { ...m, params: { ...(m.params || {}) } } : m)) : [];
    const pre = arr.find(isFixedPreGain) || null;
    const post = arr.find(isFixedPostGain) || null;
    const middle = arr.filter(m => m && !isFixedPreGain(m) && !isFixedPostGain(m));
    return { pre, middle, post };
}

function joinChainEndpoints(pre: any | null, middle: any[], post: any | null): any[] {
    const out: any[] = [];
    if (pre) out.push(pre);
    out.push(...middle);
    if (post) out.push(post);
    return out;
}

export function reorderFxInChain(chain: unknown, fromModuleId: string, toUserIndex: number): any[] | null {
    const { pre, middle, post } = splitChainEndpoints(chain);
    const fromIdx = middle.findIndex(m => String(m?.id) === String(fromModuleId));
    if (fromIdx < 0) return null;
    const clampedTo = Math.max(0, Math.min(middle.length - 1, Math.floor(toUserIndex)));
    if (fromIdx === clampedTo) return null;
    const [moved] = middle.splice(fromIdx, 1);
    middle.splice(clampedTo, 0, moved);
    return joinChainEndpoints(pre, middle, post);
}

export function moveOrCopyFxBetweenChains(
    sourceChain: unknown,
    targetChain: unknown,
    moduleId: string,
    targetUserIndex: number | null,
    copyOnly: boolean
): { nextSourceChain: any[]; nextTargetChain: any[]; insertedModule: ChainModuleInstance } | null {
    const src = splitChainEndpoints(sourceChain);
    const dst = splitChainEndpoints(targetChain);
    const idx = src.middle.findIndex(m => String(m?.id) === String(moduleId));
    if (idx < 0) return null;

    const rawMod = src.middle[idx] as ChainModuleInstance;
    const insertedModule = copyOnly
        ? cloneFxModuleWithFreshId(rawMod)
        : (dst.middle.some(m => String(m?.id) === String(rawMod.id))
            ? cloneFxModuleWithFreshId(rawMod)
            : { ...rawMod, fixed: false, params: { ...(rawMod.params || {}) } });

    if (!copyOnly) {
        src.middle.splice(idx, 1);
    }

    const insertAt = targetUserIndex == null
        ? dst.middle.length
        : Math.max(0, Math.min(dst.middle.length, Math.floor(targetUserIndex)));
    dst.middle.splice(insertAt, 0, insertedModule);

    return {
        nextSourceChain: joinChainEndpoints(src.pre, src.middle, src.post),
        nextTargetChain: joinChainEndpoints(dst.pre, dst.middle, dst.post),
        insertedModule,
    };
}

export function pasteFxIntoChain(
    targetChain: unknown,
    clipboardModule: ChainModuleInstance,
    targetUserIndex: number | null = null
): { nextChain: any[]; insertedModule: ChainModuleInstance } {
    const dst = splitChainEndpoints(targetChain);
    const insertedModule = cloneFxModuleWithFreshId(clipboardModule);
    const insertAt = targetUserIndex == null
        ? dst.middle.length
        : Math.max(0, Math.min(dst.middle.length, Math.floor(targetUserIndex)));
    dst.middle.splice(insertAt, 0, insertedModule);
    return {
        nextChain: joinChainEndpoints(dst.pre, dst.middle, dst.post),
        insertedModule,
    };
}

export function resolveTimelineTimebase(
    bpmRaw: number,
    globalTotalBarsRaw: number,
    lanes: readonly TimelineTrackLane[],
    realtimeDurationSec: number,
    requestedRulerMode: TimelineRulerMode
): TimelineTimebase {
    const bpm = Math.max(20, Math.min(300, Number(bpmRaw) || 120));
    const globalTotalBars = Number.isFinite(Number(globalTotalBarsRaw)) ? Number(globalTotalBarsRaw) : 4;
    const isFreeMode = globalTotalBars <= 0;
    const secPerBeat = 60 / bpm;
    const secPerBar = secPerBeat * 4;

    let maxContentSec = 0;
    for (const lane of lanes) {
        if (lane.totalBars && lane.totalBars > 0) {
            maxContentSec = Math.max(maxContentSec, lane.totalBars * secPerBar);
        }
        for (const clip of lane.clips) {
            if (clip.durationSec > 0) {
                maxContentSec = Math.max(maxContentSec, clip.startSec + clip.durationSec);
            }
        }
        for (const sec of lane.arrangementSections) {
            maxContentSec = Math.max(maxContentSec, sec.endSec);
        }
    }

    let durationSec = 0;
    if (!isFreeMode) {
        // Bar-locked mode strictly honors globalTotalBars * secPerBar so a 4-bar
        // workspace never stretches into a phantom 5th bar from stale/tail durations.
        durationSec = globalTotalBars * secPerBar;
    } else {
        durationSec = Math.max(realtimeDurationSec > 0 ? realtimeDurationSec : 0, maxContentSec);
        if (durationSec <= 0) {
            durationSec = 4 * secPerBar; // fallback 4 bars when workspace is empty
        }
    }
    durationSec = Math.max(0.25, durationSec);

    const resolvedRulerMode: 'bars' | 'time' = requestedRulerMode === 'auto'
        ? (isFreeMode ? 'time' : 'bars')
        : requestedRulerMode;

    return {
        bpm,
        globalTotalBars,
        isFreeMode,
        resolvedRulerMode,
        durationSec,
        secPerBeat,
        secPerBar,
    };
}

export function formatTimelineTime(sec: number, showDecimals = false): string {
    if (!Number.isFinite(sec) || sec < 0) return showDecimals ? '0:00.0' : '0:00';
    const hours = Math.floor(sec / 3600);
    const mins = Math.floor((sec % 3600) / 60);
    const secsWhole = Math.floor(sec % 60);
    const tenths = Math.floor((sec - Math.floor(sec)) * 10);
    if (hours > 0) {
        return `${hours}:${String(mins).padStart(2, '0')}:${String(secsWhole).padStart(2, '0')}`;
    }
    if (showDecimals) {
        return `${mins}:${String(secsWhole).padStart(2, '0')}.${tenths}`;
    }
    return `${mins}:${String(secsWhole).padStart(2, '0')}`;
}

export function formatMusicalTime(sec: number, bpm: number): string {
    const safeBpm = Math.max(20, bpm || 120);
    const totalBeats = Math.max(0, sec / (60 / safeBpm));
    const bar = Math.floor(totalBeats / 4) + 1;
    const beat = Math.floor(totalBeats % 4) + 1;
    const sub = Math.floor(((totalBeats % 1) * 4)) + 1;
    return `${bar}.${beat}.${sub}`;
}

export function computeRulerTicks(
    viewStartSec: number,
    viewEndSec: number,
    widthPx: number,
    mode: 'bars' | 'time',
    bpm: number,
    totalDurationSec?: number
): RulerTick[] {
    const span = Math.max(1e-4, viewEndSec - viewStartSec);
    if (widthPx <= 0) return [];
    const pxPerSec = widthPx / span;
    const ticks: RulerTick[] = [];
    const maxSecLimit = (typeof totalDurationSec === 'number' && Number.isFinite(totalDurationSec) && totalDurationSec > 0)
        ? totalDurationSec
        : viewEndSec;

    if (mode === 'bars') {
        const secPerBeat = 60 / Math.max(20, bpm || 120);
        const secPerBar = secPerBeat * 4;
        const pxPerBar = secPerBar * pxPerSec;

        let majorStepBeats = 4; // 1 bar
        let minorStepBeats = 1; // 1 beat
        if (pxPerBar < 26) {
            majorStepBeats = 32; // 8 bars
            minorStepBeats = 8;
        } else if (pxPerBar < 52) {
            majorStepBeats = 16; // 4 bars
            minorStepBeats = 4;
        } else if (pxPerBar < 90) {
            majorStepBeats = 8; // 2 bars
            minorStepBeats = 4;
        } else if (pxPerBar < 220) {
            majorStepBeats = 4; // 1 bar
            minorStepBeats = 1;
        } else if (pxPerBar < 460) {
            majorStepBeats = 1; // every beat labeled
            minorStepBeats = 0.5;
        } else {
            majorStepBeats = 1;
            minorStepBeats = 0.25; // 16th notes
        }

        const startBeat = Math.max(0, Math.floor((viewStartSec / secPerBeat) / minorStepBeats) * minorStepBeats);
        const endBeat = Math.ceil(viewEndSec / secPerBeat) + minorStepBeats;

        for (let b = startBeat; b <= endBeat; b = Math.round((b + minorStepBeats) * 10000) / 10000) {
            const sec = b * secPerBeat;
            if (sec < viewStartSec - 1e-4 || sec >= maxSecLimit - 1e-4 || sec > viewEndSec + 1e-4) continue;
            const x = ((sec - viewStartSec) / span) * widthPx;
            const remMajor = Math.abs(b / majorStepBeats - Math.round(b / majorStepBeats));
            const isMajor = remMajor < 1e-4;
            let label = '';
            if (isMajor) {
                const barNum = Math.floor(b / 4 + 1e-6) + 1;
                const beatInBar = Math.round((b % 4) * 100) / 100;
                label = beatInBar < 1e-3 ? `${barNum}` : `${barNum}.${Math.floor(beatInBar) + 1}`;
            }
            ticks.push({ sec, x, label, major: isMajor });
        }
        return ticks;
    }

    // Time ruler (MM:SS)
    const candidateSteps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800];
    let majorStep = candidateSteps[candidateSteps.length - 1];
    for (const s of candidateSteps) {
        if (s * pxPerSec >= 68) {
            majorStep = s;
            break;
        }
    }
    const minorStep = majorStep >= 60 ? majorStep / 4 : (majorStep >= 10 ? majorStep / 5 : majorStep / 2);
    const showDecimals = majorStep < 1;

    const firstMinor = Math.max(0, Math.floor(viewStartSec / minorStep) * minorStep);
    const maxMinor = viewEndSec + minorStep;
    for (let t = firstMinor; t <= maxMinor; t = Math.round((t + minorStep) * 10000) / 10000) {
        if (t < viewStartSec - 1e-4 || t >= maxSecLimit - 1e-4 || t > viewEndSec + 1e-4) continue;
        const x = ((t - viewStartSec) / span) * widthPx;
        const remMajor = Math.abs(t / majorStep - Math.round(t / majorStep));
        const isMajor = remMajor < 1e-3;
        ticks.push({
            sec: t,
            x,
            label: isMajor ? formatTimelineTime(t, showDecimals) : '',
            major: isMajor,
        });
    }
    return ticks;
}

export function snapTimeToGrid(
    sec: number,
    bpm: number,
    viewSpanSec: number,
    widthPx: number,
    snapEnabled: boolean,
    mode: 'bars' | 'time'
): number {
    const clamped = Math.max(0, sec);
    if (!snapEnabled || widthPx <= 0 || viewSpanSec <= 0) return clamped;

    if (mode === 'bars') {
        const secPerBeat = 60 / Math.max(20, bpm || 120);
        const pxPerBeat = (secPerBeat / viewSpanSec) * widthPx;
        let stepBeats = 1;
        if (pxPerBeat >= 80) stepBeats = 0.25; // 1/16
        else if (pxPerBeat >= 36) stepBeats = 0.5; // 1/8
        else if (pxPerBeat >= 14) stepBeats = 1; // beat
        else stepBeats = 4; // bar
        const stepSec = stepBeats * secPerBeat;
        return Math.max(0, Math.round(clamped / stepSec) * stepSec);
    }

    // Time mode snap (when explicitly enabled by user)
    const pxPerSec = widthPx / viewSpanSec;
    const stepSec = pxPerSec >= 100 ? 0.1 : (pxPerSec >= 25 ? 0.5 : (pxPerSec >= 6 ? 1 : 5));
    return Math.max(0, Math.round(clamped / stepSec) * stepSec);
}

export interface TrackTileOverlayEntry {
    durationSec: number;
    coverageSlots: Uint8Array;
    hasCoverage: boolean;
    peaks: Float32Array | null;
    tiers: Uint8Array | null;
    peaksStartSec: number;
    peaksEndSec: number;
    revision: number;
}

/**
 * Node-ID-keyed dual-color tile coverage & peak overlay store.
 * Phase 1 routes the active tiled session to its scoped `bus_node_ids` + `stage_node_ids`;
 * Phase 2 multi-session backend tiling plugs in without any API change.
 */
export class TimelineTileOverlayStore {
    private readonly entries = new Map<string, TrackTileOverlayEntry>();
    private tiledBusNodeIds = new Set<string>();
    private tiledStageNodeIds = new Set<string>();

    private ensureEntry(key: string): TrackTileOverlayEntry {
        let entry = this.entries.get(key);
        if (!entry) {
            entry = {
                durationSec: 0,
                coverageSlots: new Uint8Array(COVERAGE_SLOTS),
                hasCoverage: false,
                peaks: null,
                tiers: null,
                peaksStartSec: 0,
                peaksEndSec: 0,
                revision: 0,
            };
            this.entries.set(key, entry);
        }
        return entry;
    }

    public hasActiveTiledSession(): boolean {
        return this.tiledBusNodeIds.size > 0 || this.tiledStageNodeIds.size > 0;
    }

    public getTiledBusNodeIds(): ReadonlySet<string> {
        return this.tiledBusNodeIds;
    }

    public isLaneTiled(lane: TimelineTrackLane): boolean {
        if (!this.hasActiveTiledSession()) return false;
        if (this.tiledBusNodeIds.has(String(lane.trackNodeId))) return true;
        for (const sid of this.tiledStageNodeIds) {
            if (lane.upstreamNodeIds.has(sid)) return true;
        }
        return false;
    }

    public setSessionScope(busNodeIds: readonly string[], stageNodeIds: readonly string[], durationSec?: number): void {
        const nextBus = new Set((busNodeIds || []).map(String).filter(Boolean));
        const nextStage = new Set((stageNodeIds || []).map(String).filter(Boolean));
        const changed = nextBus.size !== this.tiledBusNodeIds.size
            || Array.from(nextBus).some(id => !this.tiledBusNodeIds.has(id));
        if (changed) {
            this.entries.clear();
        }
        this.tiledBusNodeIds = nextBus;
        this.tiledStageNodeIds = nextStage;
        if (durationSec && durationSec > 0) {
            for (const key of this.tiledBusNodeIds) {
                const entry = this.ensureEntry(key);
                entry.durationSec = durationSec;
                entry.revision++;
            }
        }
    }

    public applyPeaks(params: {
        busNodeIds?: readonly string[];
        stageNodeIds?: readonly string[];
        peaks: number[] | Float32Array;
        tiers?: number[] | Uint8Array | null;
        durationSec: number;
        viewStartSec?: number;
        viewEndSec?: number;
        preserveTiers?: boolean;
    }): void {
        if (params.busNodeIds?.length || params.stageNodeIds?.length) {
            this.tiledBusNodeIds = new Set((params.busNodeIds || []).map(String).filter(Boolean));
            if (params.stageNodeIds?.length) {
                this.tiledStageNodeIds = new Set(params.stageNodeIds.map(String).filter(Boolean));
            }
        }
        const keys = this.tiledBusNodeIds.size > 0 ? Array.from(this.tiledBusNodeIds) : ['__master__'];
        const peaksArr = params.peaks instanceof Float32Array ? Float32Array.from(params.peaks) : Float32Array.from(params.peaks || []);
        const pairCount = Math.floor(peaksArr.length / 2);
        const dur = Math.max(0, Number(params.durationSec) || 0);
        const pStart = Number.isFinite(params.viewStartSec) ? Number(params.viewStartSec) : 0;
        const pEnd = (Number.isFinite(params.viewEndSec) && Number(params.viewEndSec) > pStart)
            ? Number(params.viewEndSec)
            : dur;

        for (const key of keys) {
            const entry = this.ensureEntry(key);
            const durChanged = entry.durationSec > 0 && Math.abs(dur - entry.durationSec) > 0.25;
            entry.durationSec = dur;
            entry.peaks = pairCount > 0 ? Float32Array.from(peaksArr) : null;
            entry.peaksStartSec = pStart;
            entry.peaksEndSec = pEnd;

            const hasExplicitTiers = Boolean(params.tiers && params.tiers.length > 0 && pairCount > 0);
            if (hasExplicitTiers) {
                if (durChanged) {
                    entry.coverageSlots.fill(0);
                    entry.hasCoverage = false;
                }
                const tArr = new Uint8Array(pairCount);
                let anyNonZero = false;
                for (let i = 0; i < pairCount; i++) {
                    const t = Number(params.tiers![i] ?? 0) & 3;
                    tArr[i] = t;
                    if (t !== 0) anyNonZero = true;
                }
                entry.tiers = tArr;
                if (dur > 0) {
                    const pSpan = Math.max(1e-4, pEnd - pStart);
                    const s0 = Math.max(0, Math.floor((pStart / dur) * COVERAGE_SLOTS));
                    const s1 = Math.min(COVERAGE_SLOTS, Math.ceil((pEnd / dur) * COVERAGE_SLOTS));
                    for (let s = s0; s < s1; s++) {
                        const slotT = ((s + 0.5) / COVERAGE_SLOTS) * dur;
                        if (slotT < pStart || slotT > pEnd) continue;
                        const idx = Math.max(0, Math.min(pairCount - 1, Math.floor(((slotT - pStart) / pSpan) * pairCount)));
                        entry.coverageSlots[s] = tArr[idx];
                        if (tArr[idx] !== 0) anyNonZero = true;
                    }
                    if (anyNonZero) entry.hasCoverage = true;
                }
            } else if (durChanged || params.preserveTiers === false) {
                entry.tiers = null;
                entry.coverageSlots.fill(0);
                entry.hasCoverage = false;
            } else if (entry.hasCoverage && pairCount > 0 && dur > 0) {
                const tArr = new Uint8Array(pairCount);
                const pSpan = Math.max(1e-4, pEnd - pStart);
                for (let i = 0; i < pairCount; i++) {
                    const tSec = pStart + ((i + 0.5) / pairCount) * pSpan;
                    const slot = Math.max(0, Math.min(COVERAGE_SLOTS - 1, Math.floor((tSec / dur) * COVERAGE_SLOTS)));
                    tArr[i] = entry.coverageSlots[slot];
                }
                entry.tiers = tArr;
            }
            entry.revision++;
        }
    }

    public applyTileDelta(msg: {
        bus_node_ids?: readonly string[];
        stage_node_ids?: readonly string[];
        start_sec?: number;
        end_sec?: number;
        duration_sec?: number;
        tier?: number;
        stale?: boolean;
        stale_all?: boolean;
        clear_all?: boolean;
        peaks?: number[] | null;
    }): void {
        if (Array.isArray(msg.bus_node_ids) && msg.bus_node_ids.length > 0) {
            this.tiledBusNodeIds = new Set(msg.bus_node_ids.map(String));
        }
        if (Array.isArray(msg.stage_node_ids) && msg.stage_node_ids.length > 0) {
            this.tiledStageNodeIds = new Set(msg.stage_node_ids.map(String));
        }
        const targetKeys = this.tiledBusNodeIds.size > 0
            ? Array.from(this.tiledBusNodeIds)
            : (this.entries.size > 0 ? Array.from(this.entries.keys()) : ['__master__']);

        if (msg.clear_all) {
            for (const key of targetKeys) {
                const entry = this.entries.get(key);
                if (!entry) continue;
                entry.coverageSlots.fill(0);
                entry.hasCoverage = false;
                entry.tiers = null;
                entry.revision++;
            }
            return;
        }

        if (msg.stale_all) {
            for (const key of targetKeys) {
                const entry = this.entries.get(key);
                if (!entry) continue;
                let changed = false;
                if (entry.tiers) {
                    for (let i = 0; i < entry.tiers.length; i++) {
                        if (entry.tiers[i] > 0) {
                            entry.tiers[i] = TIER_STALE;
                            changed = true;
                        }
                    }
                }
                for (let s = 0; s < COVERAGE_SLOTS; s++) {
                    if (entry.coverageSlots[s] > 0) {
                        entry.coverageSlots[s] = TIER_STALE;
                        changed = true;
                    }
                }
                if (changed) entry.revision++;
            }
            return;
        }

        const startSec = Number(msg.start_sec);
        const endSec = Number(msg.end_sec);
        if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) return;
        const effTier = msg.stale ? TIER_STALE : Math.max(0, Math.min(3, Number(msg.tier) || 0));

        for (const key of targetKeys) {
            const entry = this.ensureEntry(key);
            if (typeof msg.duration_sec === 'number' && msg.duration_sec > 0) {
                entry.durationSec = msg.duration_sec;
            }
            const dur = entry.durationSec;
            if (dur <= 0) continue;

            const s0 = Math.max(0, Math.floor((startSec / dur) * COVERAGE_SLOTS));
            const s1 = Math.min(COVERAGE_SLOTS, Math.ceil((endSec / dur) * COVERAGE_SLOTS));
            for (let s = s0; s < s1; s++) {
                if (effTier === TIER_STALE || effTier >= entry.coverageSlots[s] || entry.coverageSlots[s] === TIER_STALE) {
                    entry.coverageSlots[s] = effTier;
                }
            }
            if (effTier > 0) entry.hasCoverage = true;

            if (entry.peaks) {
                const pStart = entry.peaksStartSec;
                const pEnd = entry.peaksEndSec > pStart ? entry.peaksEndSec : dur;
                const pSpan = pEnd - pStart;
                const pairCount = Math.floor(entry.peaks.length / 2);
                if (pSpan > 0 && pairCount > 0 && endSec > pStart && startSec < pEnd) {
                    if (!entry.tiers || entry.tiers.length !== pairCount) {
                        entry.tiers = new Uint8Array(pairCount);
                    }
                    const c0 = Math.max(0, Math.floor(((startSec - pStart) / pSpan) * pairCount));
                    const c1 = Math.min(pairCount, Math.ceil(((endSec - pStart) / pSpan) * pairCount));
                    const tilePeaks = Array.isArray(msg.peaks) && msg.peaks.length >= 2 ? msg.peaks : null;
                    const tilePairs = tilePeaks ? Math.floor(tilePeaks.length / 2) : 0;
                    const tileSpan = Math.max(1e-4, endSec - startSec);

                    for (let c = c0; c < c1; c++) {
                        const colT0 = pStart + (c / pairCount) * pSpan;
                        const colT1 = pStart + ((c + 1) / pairCount) * pSpan;
                        if (colT1 <= startSec || colT0 >= endSec) continue;
                        if (effTier === TIER_STALE || effTier >= entry.tiers[c] || entry.tiers[c] === TIER_STALE) {
                            entry.tiers[c] = effTier;
                        }
                        if (tilePeaks && tilePairs > 0) {
                            const u0 = Math.max(0, Math.min(1, (colT0 - startSec) / tileSpan));
                            const u1 = Math.max(u0, Math.min(1, (colT1 - startSec) / tileSpan));
                            const tp0 = Math.max(0, Math.min(tilePairs - 1, Math.floor(u0 * tilePairs)));
                            const tp1 = Math.max(tp0 + 1, Math.min(tilePairs, Math.ceil(u1 * tilePairs)));
                            let mn = 1;
                            let mx = -1;
                            for (let k = tp0; k < tp1; k++) {
                                const lo = Number(tilePeaks[k * 2]) || 0;
                                const hi = Number(tilePeaks[k * 2 + 1]) || 0;
                                if (lo < mn) mn = lo;
                                if (hi > mx) mx = hi;
                            }
                            if (mn <= mx) {
                                entry.peaks[c * 2] = mn;
                                entry.peaks[c * 2 + 1] = mx;
                            }
                        }
                    }
                }
            }
            entry.revision++;
        }
    }

    public clear(): void {
        this.entries.clear();
        this.tiledBusNodeIds.clear();
        this.tiledStageNodeIds.clear();
    }

    public getEntryForLane(lane: TimelineTrackLane): TrackTileOverlayEntry | null {
        if (!this.isLaneTiled(lane)) return null;
        const direct = this.entries.get(String(lane.trackNodeId));
        if (direct) return direct;
        for (const sid of this.tiledStageNodeIds) {
            if (lane.upstreamNodeIds.has(sid)) {
                const first = this.entries.values().next().value;
                if (first) return first;
            }
        }
        return null;
    }

    public getPrimaryCoverageSlots(): Uint8Array | null {
        for (const entry of this.entries.values()) {
            if (entry.hasCoverage) return entry.coverageSlots;
        }
        return null;
    }

    public resolveColumnTiers(
        entry: TrackTileOverlayEntry,
        viewStartSec: number,
        viewEndSec: number,
        columns: number
    ): Uint8Array | null {
        if (columns <= 0 || entry.durationSec <= 0) return null;
        const vSpan = Math.max(1e-4, viewEndSec - viewStartSec);
        const out = new Uint8Array(columns);

        if (entry.tiers && entry.peaks) {
            const pairCount = Math.floor(entry.peaks.length / 2);
            const pStart = entry.peaksStartSec;
            const pEnd = entry.peaksEndSec > pStart ? entry.peaksEndSec : entry.durationSec;
            const pSpan = Math.max(1e-4, pEnd - pStart);
            let anyNonZero = false;
            for (let x = 0; x < columns; x++) {
                const t0 = viewStartSec + (x / columns) * vSpan;
                const t1 = viewStartSec + ((x + 1) / columns) * vSpan;
                if (t1 <= pStart || t0 >= pEnd) {
                    const mid = (t0 + t1) * 0.5;
                    const slot = Math.max(0, Math.min(COVERAGE_SLOTS - 1, Math.floor((mid / entry.durationSec) * COVERAGE_SLOTS)));
                    out[x] = entry.coverageSlots[slot];
                    if (out[x] !== 0) anyNonZero = true;
                    continue;
                }
                const sIdx = Math.max(0, Math.min(pairCount - 1, Math.floor(((t0 - pStart) / pSpan) * pairCount)));
                const eIdx = Math.max(sIdx + 1, Math.min(pairCount, Math.ceil(((t1 - pStart) / pSpan) * pairCount)));
                let best = 0;
                let anyStale = false;
                for (let i = sIdx; i < eIdx && i < entry.tiers.length; i++) {
                    const t = entry.tiers[i];
                    if (t === TIER_STALE) anyStale = true;
                    else if (t > best) best = t;
                }
                const resolved = (anyStale && best < TIER_COMPLEX_ML) ? TIER_STALE : best;
                out[x] = resolved;
                if (resolved !== 0) anyNonZero = true;
            }
            if (anyNonZero || entry.hasCoverage) return out;
        }

        if (!entry.hasCoverage) return null;
        for (let x = 0; x < columns; x++) {
            const mid = viewStartSec + ((x + 0.5) / columns) * vSpan;
            const slot = Math.max(0, Math.min(COVERAGE_SLOTS - 1, Math.floor((mid / entry.durationSec) * COVERAGE_SLOTS)));
            out[x] = entry.coverageSlots[slot];
        }
        return out;
    }
}
