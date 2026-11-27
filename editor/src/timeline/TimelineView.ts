/**
 * Traditional Horizontal DAW Timeline View for SIN Node Editor.
 *
 * Strictly 1:1 with the live `LGraph`:
 * - Top-level sink `TrackNode`s render inline as collapsible Master folders; nested child
 *   `TrackNode`s indent beneath their parent bus.
 * - Minimal Track headers (indent/collapse, color bar, name, M/S, Post-Gain volume, live RMS).
 * - 2-layer offscreen high-DPI timeline canvas (ruler, waveforms, 4-tier dual-color baked/unbaked
 *   tile overlays + 4px bottom rail, draggable clip crop/start_beat handles, Arrangement section
 *   dividers, Sequence hit markers, smooth scrubbing, zoom/pan, overview minimap).
 * - Ableton-style collapsible compact SVG mini-graph strip at the bottom for the selected Track.
 */

import { renderIcon } from '../../../packages/ui/src/icons.js';
import { enhanceRangeSlider } from '../../../packages/ui/src/slider.js';
import { getDefaultFxChain } from '../nodes/BaseNode.ts';
import { dbToLinear, formatDb, getPrePostGainDb, getUserFxStages, isFixedPostGain } from '../dsp/processorRegistry.ts';
import {
    buildTimelineHierarchy,
    computeNodeAncestorPath,
    computeRulerTicks,
    formatMusicalTime,
    formatTimelineTime,
    getNodeTypeSafe,
    isModifierNodeSafe,
    isTrackNode,
    resolveTimelineTimebase,
    snapTimeToGrid,
    swapGraphNodes,
    TIMELINE_TIER_BG_COLORS,
    TIMELINE_TIER_COLORS,
    TIMELINE_TIER_RAIL_COLORS,
    TimelineTileOverlayStore,
    type TimelineClipRegion,
    type TimelineHierarchyResult,
    type TimelineRulerMode,
    type TimelineTimebase,
    type TimelineTrackLane,
} from './timelineModel.ts';
import { samplePeaksForColumns, TimelineWaveformCache } from './TimelineWaveformCache.ts';
import { TimelineMiniGraphStrip } from './TimelineMiniGraphStrip.ts';

export interface TimelineViewCallbacks {
    getGraph: () => any;
    getSelectedNodeIds: () => ReadonlySet<number>;
    selectNode: (nodeId: number, options?: { openInspector?: boolean; initialTab?: string }) => void;
    seekToSeconds: (sec: number, options?: { scrubbing?: boolean }) => void;
    queryTiledPeaks: (startSec: number, endSec: number, columns: number) => Promise<{
        ok?: boolean;
        peaks?: number[];
        tiers?: number[];
        start_sec?: number;
        end_sec?: number;
        duration_sec?: number;
        tiled_bus_node_ids?: string[];
    } | null>;
    getLoopEnabled: () => boolean;
    getMainPreviewNodeId: () => number | null;
    getGlobalParameters: () => { bpm: number; total_bars: number; key: string };
    openTrackParameters: () => void;
    onGraphStructureChanged?: () => void;
    onPathNodeChanged?: (nodeId: number | null) => void;
    onRowsMetaChanged?: (info: { rowCount: number; allExpanded: boolean }) => void;
}

type ActiveCanvasDrag =
    | { kind: 'scrub'; pointerId: number }
    | { kind: 'pan'; pointerId: number; anchorX: number; anchorStartSec: number }
    | { kind: 'minimap'; pointerId: number }
    | {
        kind: 'crop-start' | 'crop-end';
        pointerId: number;
        clip: TimelineClipRegion;
        sampleNode: any;
        laneY: number;
        laneH: number;
        initialCropStart: number;
        initialCropEnd: number;
        pendingCropStart: number;
        pendingCropEnd: number;
        currentSec: number;
    }
    | {
        kind: 'move-clip';
        pointerId: number;
        clip: TimelineClipRegion;
        sampleNode: any;
        laneY: number;
        laneH: number;
        grabOffsetSec: number;
        currentStartSec: number;
    };

function clamp(v: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, v));
}

function colorWithAlpha(hex: string, alpha: number): string {
    if (!hex || !hex.startsWith('#')) return `rgba(79, 70, 229, ${alpha})`;
    let c = hex.slice(1);
    if (c.length === 3) c = c.split('').map(ch => ch + ch).join('');
    const num = parseInt(c, 16);
    if (!Number.isFinite(num)) return `rgba(79, 70, 229, ${alpha})`;
    return `rgba(${(num >> 16) & 255}, ${(num >> 8) & 255}, ${num & 255}, ${alpha})`;
}

function setTrackPostGainDb(trackNode: any, nextDb: number): void {
    if (!trackNode || typeof trackNode.updateProperty !== 'function') return;
    const clampedDb = clamp(Math.round(nextDb * 10) / 10, -36, 12);
    const linear = dbToLinear(clampedDb);
    const currentChain = Array.isArray(trackNode.properties?.chain) && trackNode.properties.chain.length > 0
        ? trackNode.properties.chain.map((m: any) => ({ ...m, params: { ...(m?.params || {}) } }))
        : getDefaultFxChain(0);

    let postMod = currentChain.find((m: any) => isFixedPostGain(m));
    if (!postMod) {
        postMod = {
            id: 'post_gain_' + Math.random().toString(36).substring(2, 8),
            type: 'gain',
            name: 'Post Gain',
            enabled: true,
            fixed: true,
            params: { gain: linear, gain_db: clampedDb },
        };
        currentChain.push(postMod);
    } else {
        postMod.enabled = true;
        postMod.params = { ...postMod.params, gain: linear, gain_db: clampedDb };
    }
    trackNode.updateProperty('chain', currentChain);
}

export class TimelineView {
    public readonly element: HTMLDivElement;
    private readonly callbacks: TimelineViewCallbacks;
    private readonly tileStore = new TimelineTileOverlayStore();
    private readonly waveformCache: TimelineWaveformCache;
    private readonly miniGraphStrip: TimelineMiniGraphStrip;

    // Minimal top info strip (right-aligned info only — no snap or zoom clutter)
    private readonly summaryBtn: HTMLButtonElement;
    private readonly legendEl: HTMLDivElement;

    // Main split panes
    private readonly headersScrollEl: HTMLDivElement;
    private readonly headersListEl: HTMLDivElement;
    private readonly collapseAllBtn: HTMLButtonElement;
    private readonly rulerCanvas: HTMLCanvasElement;
    private readonly lanesScrollEl: HTMLDivElement;
    private readonly lanesCanvas: HTMLCanvasElement;
    private readonly emptyOverlayEl: HTMLDivElement;
    private readonly minimapWrapEl: HTMLDivElement;
    private readonly minimapCanvas: HTMLCanvasElement;

    // Offscreen 2-layer waveform cache + reusable scratch peak buffers (zero GC churn on zoom/redraw)
    private backingCanvas: HTMLCanvasElement | null = null;
    private backingDirty = true;
    private cachedLanesCssW = 0;
    private cachedLanesCssH = 0;
    private scratchColMin = new Float32Array(0);
    private scratchColMax = new Float32Array(0);
    private lastHeadersSignature = '';
    private readonly lastChainSignatures = new Map<number, string>();
    private readonly trackMeterEls = new Map<number, HTMLElement>();
    private readonly trackVolControls = new Map<number, { input: HTMLInputElement; valEl: HTMLSpanElement }>();

    // State
    private active = false;
    private disposed = false;
    private hierarchy: TimelineHierarchyResult = {
        allLanes: [],
        visibleLanes: [],
        masterRootIds: [],
        laneByTrackId: new Map(),
        laneByKey: new Map(),
        anySoloActive: false,
    };
    private timebase: TimelineTimebase = {
        bpm: 120,
        globalTotalBars: 4,
        isFreeMode: false,
        resolvedRulerMode: 'bars',
        durationSec: 8,
        secPerBeat: 0.5,
        secPerBar: 2,
    };
    private collapsedTrackIds = new Set<number>();
    private expandedSignalChainTrackIds = new Set<number>();
    private selectedTrackId: number | null = null;
    private selectedLaneKey: string | null = null;
    private hasPeakPyramid = false;
    private lastFetchedCssW = 0;
    private rulerMode: TimelineRulerMode = 'auto';

    // Viewport & Playback
    private zoom = 1;
    private viewStartSec = 0;
    private viewEndSec = 8;
    private realtimeDurationSec = 0;
    private playheadSec = 0;
    private isPlaying = false;

    // Interaction
    private activeDrag: ActiveCanvasDrag | null = null;
    private hoverCursor = 'default';
    private hoverTimeSec: number | null = null;
    private syncScrollLock = false;
    private modelRefreshRaf: number | null = null;
    private drawRaf: number | null = null;
    private tiledZoomTimer: number | null = null;
    private tiledZoomToken = 0;
    private resizeObserver: ResizeObserver | null = null;

    constructor(callbacks: TimelineViewCallbacks) {
        this.callbacks = callbacks;
        this.waveformCache = new TimelineWaveformCache((durationChanged) => {
            if (durationChanged) {
                this.scheduleModelRefresh();
            }
            this.markWaveDirty();
        });

        this.element = document.createElement('div');
        this.element.className = 'sin-timeline-view';

        // 1. Minimal Top Info Strip (info aligned strictly at the very right; no snap/zoom controls)
        const toolbar = document.createElement('div');
        toolbar.className = 'sin-tl-toolbar sin-tl-toolbar-minimal';

        const rightGroup = document.createElement('div');
        rightGroup.className = 'sin-tl-toolbar-group';

        this.legendEl = document.createElement('div');
        this.legendEl.className = 'sin-tl-tier-legend is-hidden';
        this.legendEl.title = 'Dual-color tile bake status for large samples';
        this.legendEl.innerHTML = `
            <span class="sin-tl-legend-item"><i style="background:${TIMELINE_TIER_COLORS[0]}"></i>Raw</span>
            <span class="sin-tl-legend-item"><i style="background:${TIMELINE_TIER_COLORS[1]}"></i>DSP</span>
            <span class="sin-tl-legend-item"><i style="background:${TIMELINE_TIER_COLORS[2]}"></i>ML</span>
            <span class="sin-tl-legend-item"><i style="background:${TIMELINE_TIER_COLORS[3]}"></i>Stale</span>
        `;

        this.summaryBtn = document.createElement('button');
        this.summaryBtn.type = 'button';
        this.summaryBtn.className = 'ui-btn ui-btn--xs ui-btn--bordered sin-tl-summary-btn';
        this.summaryBtn.title = 'Open Global Tempo & Length Settings';
        this.summaryBtn.textContent = '120 BPM · 4 bars';
        this.summaryBtn.addEventListener('click', () => this.callbacks.openTrackParameters());

        rightGroup.append(this.legendEl, this.summaryBtn);
        toolbar.appendChild(rightGroup);
        this.element.appendChild(toolbar);

        // 2. Main DAW Split Body (Track Headers Left + Timeline Canvas Right)
        const mainSplit = document.createElement('div');
        mainSplit.className = 'sin-tl-main';

        // Left column: Corner + Scrollable Track Headers
        const headersCol = document.createElement('div');
        headersCol.className = 'sin-tl-headers-col';

        const headersCorner = document.createElement('div');
        headersCorner.className = 'sin-tl-headers-corner';

        const tracksLabel = document.createElement('span');
        tracksLabel.className = 'sin-tl-headers-corner-label';
        tracksLabel.textContent = 'TRACKS';

        this.collapseAllBtn = document.createElement('button');
        this.collapseAllBtn.type = 'button';
        this.collapseAllBtn.className = 'ui-btn ui-btn--xs ui-btn--icon';
        this.collapseAllBtn.title = 'Collapse / expand all bus folders';
        this.collapseAllBtn.innerHTML = renderIcon('layers');
        this.collapseAllBtn.addEventListener('click', () => this.toggleCollapseAllBuses());

        headersCorner.append(tracksLabel, this.collapseAllBtn);

        this.headersScrollEl = document.createElement('div');
        this.headersScrollEl.className = 'sin-tl-headers-scroll';

        this.headersListEl = document.createElement('div');
        this.headersListEl.className = 'sin-tl-headers-list';
        this.headersScrollEl.appendChild(this.headersListEl);

        headersCol.append(headersCorner, this.headersScrollEl);

        // Right column: Ruler + Multi-lane Waveform Canvas + Minimap
        const canvasCol = document.createElement('div');
        canvasCol.className = 'sin-tl-canvas-col';

        const rulerWrap = document.createElement('div');
        rulerWrap.className = 'sin-tl-ruler-wrap';
        this.rulerCanvas = document.createElement('canvas');
        this.rulerCanvas.className = 'sin-tl-ruler-canvas';
        this.rulerCanvas.setAttribute('aria-label', 'Timeline ruler');
        rulerWrap.appendChild(this.rulerCanvas);

        this.lanesScrollEl = document.createElement('div');
        this.lanesScrollEl.className = 'sin-tl-lanes-scroll';

        this.lanesCanvas = document.createElement('canvas');
        this.lanesCanvas.className = 'sin-tl-lanes-canvas';
        this.lanesCanvas.setAttribute('aria-label', 'DAW tracks timeline');
        this.lanesScrollEl.appendChild(this.lanesCanvas);

        this.emptyOverlayEl = document.createElement('div');
        this.emptyOverlayEl.className = 'sin-tl-empty is-hidden';
        this.emptyOverlayEl.innerHTML = `
            <div class="sin-tl-empty-title">No Track buses in graph</div>
            <div class="sin-tl-empty-sub">Connect nodes to a Master or Track bus in Graph View to populate horizontal DAW lanes.</div>
        `;
        this.lanesScrollEl.appendChild(this.emptyOverlayEl);

        this.minimapWrapEl = document.createElement('div');
        this.minimapWrapEl.className = 'sin-tl-minimap-wrap is-hidden';
        this.minimapCanvas = document.createElement('canvas');
        this.minimapCanvas.className = 'sin-tl-minimap-canvas';
        this.minimapWrapEl.appendChild(this.minimapCanvas);

        canvasCol.append(rulerWrap, this.lanesScrollEl, this.minimapWrapEl);
        mainSplit.append(headersCol, canvasCol);
        this.element.appendChild(mainSplit);

        // 3. Headless Bottom Signal Rack + Live Bus Cables + Right Mixer Section
        // (Footer visibility toggle & ancestor path bar live in the unified global footer bar!)
        this.miniGraphStrip = new TimelineMiniGraphStrip({
            getGraph: this.callbacks.getGraph,
            getSelectedNodeIds: this.callbacks.getSelectedNodeIds,
            onSelectNode: (nodeId, opts) => {
                // Selecting inside the bottom panel MUST NOT switch or reset the bottom panel's root lane/bus!
                // It highlights selection, syncs Inspector if open, and notifies the global path bar.
                this.callbacks.selectNode(nodeId, opts);
                this.callbacks.onPathNodeChanged?.(nodeId);
                this.miniGraphStrip.syncSelectionClasses();
            },
            onJumpToTrack: (trackNodeId) => {
                this.navigateToPathNode(trackNodeId);
            },
            onSwapNodes: (nodeIdA, nodeIdB) => {
                const graph = this.callbacks.getGraph();
                if (!graph) return false;
                const ok = swapGraphNodes(graph, nodeIdA, nodeIdB);
                if (ok) {
                    this.callbacks.onGraphStructureChanged?.();
                    this.refreshModel();
                }
                return ok;
            },
            onRowsMetaChanged: (info) => {
                this.callbacks.onRowsMetaChanged?.(info);
            },
            onGraphMutated: () => {
                this.markWaveDirty();
            },
        });
        this.element.appendChild(this.miniGraphStrip.element);

        this.bindEvents();
        this.syncToolbarControls();
    }

    private isSnapEffective(): boolean {
        return this.timebase.resolvedRulerMode === 'bars';
    }

    private syncToolbarControls(): void {
        const tb = this.timebase;
        const lenStr = tb.isFreeMode
            ? `Free · ${formatTimelineTime(tb.durationSec)}`
            : `${tb.globalTotalBars} bars · ${formatTimelineTime(tb.durationSec)}`;
        this.summaryBtn.textContent = `${Math.round(tb.bpm)} BPM · ${lenStr}`;
        this.legendEl.classList.toggle('is-hidden', !this.tileStore.hasActiveTiledSession());
    }

    private toggleCollapseAllBuses(): void {
        const expandableTracks = this.hierarchy.allLanes.filter(
            l => l.laneKind === 'track' && (l.hasChildTracks || l.hasSignalChainLanes)
        );
        if (expandableTracks.length === 0) return;
        const anyExpanded = expandableTracks.some(l =>
            (l.hasChildTracks && !this.collapsedTrackIds.has(l.trackNodeId))
            || (l.hasSignalChainLanes && this.expandedSignalChainTrackIds.has(l.trackNodeId))
        );
        if (anyExpanded) {
            for (const l of expandableTracks) {
                if (l.hasChildTracks) this.collapsedTrackIds.add(l.trackNodeId);
                this.expandedSignalChainTrackIds.delete(l.trackNodeId);
            }
        } else {
            this.collapsedTrackIds.clear();
            for (const l of expandableTracks) {
                if (l.hasSignalChainLanes) this.expandedSignalChainTrackIds.add(l.trackNodeId);
            }
        }
        this.refreshModel();
    }

    public setActive(active: boolean): void {
        if (this.active === active) return;
        this.active = active;
        if (active) {
            // If user selected a leaf node in Graph View before switching to Timeline,
            // isolate ONLY that leaf lane immediately (zero parent bus clutter)!
            this.syncFocusFromGraphSelectionOnActivate();
            this.cachedLanesCssW = 0;
            this.cachedLanesCssH = 0;
            this.refreshModel();
            this.requestDraw(true);
        }
    }

    private expandAncestorsOfNode(nodeId: number): boolean {
        const graph = this.callbacks.getGraph();
        if (!graph) return false;
        const path = computeNodeAncestorPath(graph, nodeId);
        let changed = false;
        for (const item of path) {
            if (item.kind === 'track') {
                if (this.collapsedTrackIds.has(item.nodeId)) {
                    this.collapsedTrackIds.delete(item.nodeId);
                    changed = true;
                }
                if (!this.expandedSignalChainTrackIds.has(item.nodeId)) {
                    this.expandedSignalChainTrackIds.add(item.nodeId);
                    changed = true;
                }
            }
        }
        return changed;
    }

    public setBottomRackOpen(open: boolean): void {
        this.miniGraphStrip.setCollapsed(!open);
        if (this.active) {
            this.cachedLanesCssW = 0;
            this.cachedLanesCssH = 0;
            this.requestDraw(true);
        }
    }

    public isBottomRackOpen(): boolean {
        return !this.miniGraphStrip.isCollapsed();
    }

    public toggleAllBottomRackRows(): void {
        this.miniGraphStrip.toggleAllRows();
    }

    public getBottomRackRowsMeta(): { rowCount: number; allExpanded: boolean } {
        return this.miniGraphStrip.getRowsMeta();
    }

    private syncFocusFromGraphSelectionOnActivate(): void {
        const graph = this.callbacks.getGraph();
        const selectedIds = Array.from(this.callbacks.getSelectedNodeIds());
        if (!graph || selectedIds.length !== 1) return;
        const node = graph.getNodeById?.(selectedIds[0]);
        if (!node || isModifierNodeSafe(node) || getNodeTypeSafe(node) === 'disabled') return;
        const nid = Number(node.id);
        // Never hide parent/siblings — expand ancestors along the path and select this node cleanly!
        this.expandAncestorsOfNode(nid);
        this.selectedTrackId = nid;
        this.selectedLaneKey = isTrackNode(node) ? `track:${nid}` : null;
        this.callbacks.onPathNodeChanged?.(nid);
    }

    public navigateToPathNode(nodeId: number): void {
        const graph = this.callbacks.getGraph();
        if (!graph) return;
        const node = graph.getNodeById?.(nodeId);
        if (!node) return;
        this.expandAncestorsOfNode(nodeId);
        this.refreshModel();

        const exactTrack = this.hierarchy.laneByTrackId.get(nodeId);
        const exactChain = this.hierarchy.allLanes.find(l => l.laneKind === 'chain' && l.trackNodeId === nodeId);
        const match = exactTrack ?? exactChain ?? null;
        if (match) {
            this.selectTrackLane(match.trackNodeId, false, match.laneKey);
            return;
        }
        // Deep inner node (not a direct top-level lane): highlight its owning lane if present, select node, and update path
        const ownerLane = this.hierarchy.allLanes.find(l =>
            l.laneKind === 'chain' && l.directSubgraph.nodes.some(n => n.id === nodeId && n.kind !== 'bus_stub')
        ) || this.hierarchy.allLanes.find(l =>
            l.directSubgraph.nodes.some(n => n.id === nodeId && n.kind !== 'bus_stub')
        );
        if (ownerLane) {
            this.selectedLaneKey = ownerLane.laneKey;
            this.selectedTrackId = ownerLane.trackNodeId;
            this.syncTrackHeaderSelection();
            this.miniGraphStrip.setLane(ownerLane);
        }
        this.callbacks.selectNode(nodeId, { openInspector: false });
        this.callbacks.onPathNodeChanged?.(nodeId);
        this.miniGraphStrip.syncSelectionClasses();
        this.markWaveDirty();
    }

    public isActive(): boolean {
        return this.active;
    }

    private computeChainUiSignature(chain: unknown): string {
        return getUserFxStages(chain)
            .map(e => `${e.stageIndex}:${e.def.type}:${e.module.id}:${e.module.enabled === false ? 0 : 1}`)
            .join('|');
    }

    public onGraphSelectionChanged(): void {
        if (!this.active || this.disposed) return;
        // Keep the bottom panel strictly scoped to the lane selected on the left tracks selector;
        // only update visual selection highlights.
        this.miniGraphStrip.syncSelectionClasses();
    }

    public onNodePropertyUpdated(nodeId?: number, key?: string): void {
        if (!this.active || this.disposed) return;
        if (!key) {
            this.scheduleModelRefresh();
            return;
        }
        const nid = nodeId != null ? Number(nodeId) : null;

        // 1. Live chain parameter / Post-Gain changes: ZERO DOM teardown unless FX stages structurally changed!
        if (key === 'chain' && nid != null) {
            const graph = this.callbacks.getGraph();
            const node = graph?.getNodeById?.(nid);
            const nextSig = this.computeChainUiSignature(node?.properties?.chain);
            const prevSig = this.lastChainSignatures.get(nid) ?? '';
            if (nextSig === prevSig) {
                const ctrl = this.trackVolControls.get(nid);
                if (ctrl && node) {
                    const { postDb } = getPrePostGainDb(node.properties?.chain);
                    const clamped = clamp(postDb, -36, 12);
                    if (Math.abs(Number(ctrl.input.value) - clamped) > 0.05) {
                        ctrl.input.value = String(clamped);
                        ctrl.valEl.textContent = formatDb(clamped).replace(' dB', '');
                    }
                }
                return;
            }
            this.lastChainSignatures.set(nid, nextSig);
            this.scheduleModelRefresh();
            return;
        }

        // 2. Live clip crop / start_beat updates: mutate clip geometry in-place + redraw canvas (ZERO DOM rebuild!)
        if (key === 'crop_start' || key === 'crop_end' || key === 'start_beat') {
            if (nid != null) {
                this.refreshClipGeometryInPlace(nid);
                this.miniGraphStrip.syncCardVisual(nid);
            }
            this.markWaveDirty();
            return;
        }

        // 3. Other continuous DSP/visual params: lightweight card sync, ZERO full rack teardown!
        if (
            key === 'gain' || key === 'transpose' || key === 'cents' || key === 'mix'
            || key === 'reduction_db' || key === 'voice_db' || key === 'ambience_db' || key === 'reverb_db'
            || key === 'mute_voice' || key === 'mute_ambience' || key === 'mute_reverb'
            || key === 'sequence' || key === 'step_parameters' || key === 'output_mode'
            || key === 'playhead_offset' || key === 'stretch_ratio'
        ) {
            if (nid != null) {
                this.miniGraphStrip.syncCardVisual(nid);
            }
            if (key === 'sequence' || key === 'step_parameters' || key === 'transpose' || key === 'cents') {
                this.markWaveDirty();
            }
            return;
        }

        this.scheduleModelRefresh();
    }

    private refreshClipGeometryInPlace(sampleNodeId: number): void {
        const graph = this.callbacks.getGraph();
        const node = graph?.getNodeById?.(sampleNodeId);
        if (!node) return;
        const props = node.properties || {};
        const nextCropStart = clamp(Number(props.crop_start ?? 0) || 0, 0, 0.999);
        const rawEnd = props.crop_end != null ? Number(props.crop_end) : 1;
        const nextCropEnd = clamp(Number.isFinite(rawEnd) ? rawEnd : 1, Math.min(1, nextCropStart + 0.001), 1);
        const startBeat = Math.max(0, Number(props.start_beat ?? 0) || 0);
        const nextStartSec = startBeat * this.timebase.secPerBeat;

        for (const lane of this.hierarchy.allLanes) {
            for (const clip of lane.clips) {
                if (clip.sampleNodeId !== sampleNodeId) continue;
                clip.cropStart = nextCropStart;
                clip.cropEnd = nextCropEnd;
                if (clip.editableStartBeat) {
                    clip.startSec = nextStartSec;
                }
                if (clip.sourceDurationSec > 0) {
                    const croppedSpan = Math.max(0.01, (nextCropEnd - nextCropStart) * clip.sourceDurationSec);
                    clip.durationSec = croppedSpan / Math.max(0.05, clip.playbackRate);
                }
            }
        }
    }

    public scheduleModelRefresh(): void {
        if (this.disposed) return;
        if (this.modelRefreshRaf !== null) return;
        this.modelRefreshRaf = window.requestAnimationFrame(() => {
            this.modelRefreshRaf = null;
            if (!this.disposed && this.active) {
                this.refreshModel();
            }
        });
    }

    public refreshModel(): void {
        if (this.disposed) return;
        const graph = this.callbacks.getGraph();
        const globals = this.callbacks.getGlobalParameters();
        const prevDur = this.timebase.durationSec;

        // Snapshot chain signatures for fast-path live parameter filtering
        this.lastChainSignatures.clear();
        for (const n of ((graph as any)?._nodes || [])) {
            if (n?.id != null) {
                this.lastChainSignatures.set(Number(n.id), this.computeChainUiSignature(n.properties?.chain));
            }
        }

        this.hierarchy = buildTimelineHierarchy(graph, {
            mainPreviewNodeId: this.callbacks.getMainPreviewNodeId(),
            collapsedTrackIds: this.collapsedTrackIds,
            expandedSignalChainTrackIds: this.expandedSignalChainTrackIds,
            bpm: globals.bpm,
            globalTotalBars: globals.total_bars,
            durationByFilepath: this.waveformCache.getKnownDurations(),
        });

        this.timebase = resolveTimelineTimebase(
            globals.bpm,
            globals.total_bars,
            this.hierarchy.allLanes,
            this.realtimeDurationSec,
            this.rulerMode
        );

        const dur = this.timebase.durationSec;
        if (Math.abs(dur - prevDur) > 0.25 || this.zoom <= 1.01 || this.viewEndSec <= this.viewStartSec) {
            this.zoom = 1;
            this.viewStartSec = 0;
            this.viewEndSec = dur;
        } else {
            this.viewEndSec = Math.min(dur, this.viewEndSec);
            this.viewStartSec = Math.max(0, Math.min(this.viewStartSec, this.viewEndSec - 0.05));
        }

        // Keep the currently selected left-selector lane stable across refreshes unless it no longer exists
        if (!this.selectedLaneKey || !this.hierarchy.laneByKey.has(this.selectedLaneKey)) {
            this.syncSelectedTrackFromGraphSelection();
        }
        this.renderTrackHeaders();
        this.miniGraphStrip.setLane(this.resolveSelectedLane());
        this.syncToolbarControls();

        const isEmpty = this.hierarchy.visibleLanes.length === 0;
        this.emptyOverlayEl.classList.toggle('is-hidden', !isEmpty);
        this.minimapWrapEl.classList.toggle('is-hidden', isEmpty || this.zoom <= 1.01);

        // Fetch crisp dynamic peak resolution matching actual viewport width & DPR
        const reqCols = this.computeDynamicPeakColumns();
        this.lastFetchedCssW = this.lanesScrollEl.clientWidth || 0;
        this.waveformCache.fetchMissingSamplePeaks(
            this.hierarchy.visibleLanes,
            this.tileStore,
            this.viewStartSec,
            this.viewEndSec,
            reqCols,
            this.zoom
        );

        this.requestDraw(true);
    }

    private computeDynamicPeakColumns(): number {
        const cssW = Math.max(320, Math.floor(this.lanesScrollEl.clientWidth || 640));
        const dpr = Math.min(2, typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1);
        return Math.max(512, Math.min(2048, Math.round(cssW * dpr)));
    }

    private resolveSelectedLane(): TimelineTrackLane | null {
        if (this.selectedLaneKey) {
            const byKey = this.hierarchy.laneByKey.get(this.selectedLaneKey);
            if (byKey) return byKey;
        }
        if (this.selectedTrackId != null) {
            const exact = this.hierarchy.allLanes.find(l => l.trackNodeId === this.selectedTrackId);
            if (exact) return exact;
            const byTrack = this.hierarchy.laneByTrackId.get(this.selectedTrackId);
            if (byTrack) return byTrack;
        }
        return this.hierarchy.visibleLanes[0] ?? this.hierarchy.allLanes[0] ?? null;
    }

    private syncSelectedTrackFromGraphSelection(): void {
        const selectedIds = this.callbacks.getSelectedNodeIds();
        if (selectedIds.size > 0) {
            // 1. Exact lane match (prefers chain/leaf lane before falling back to parent bus!)
            for (const sid of selectedIds) {
                const chainMatch = this.hierarchy.allLanes.find(l => l.laneKind === 'chain' && l.trackNodeId === sid);
                if (chainMatch) {
                    this.selectedTrackId = chainMatch.trackNodeId;
                    this.selectedLaneKey = chainMatch.laneKey;
                    return;
                }
                const trackMatch = this.hierarchy.laneByTrackId.get(sid);
                if (trackMatch) {
                    this.selectedTrackId = trackMatch.trackNodeId;
                    this.selectedLaneKey = trackMatch.laneKey;
                    return;
                }
            }
            // 2. Upstream node inside an existing lane's direct subgraph
            for (const sid of selectedIds) {
                const match = this.hierarchy.allLanes.find(l =>
                    l.laneKind === 'chain' && l.directSubgraph.nodes.some(n => n.id === sid && n.kind !== 'bus_stub')
                ) || this.hierarchy.allLanes.find(l =>
                    l.directSubgraph.nodes.some(n => n.id === sid && n.kind !== 'bus_stub')
                );
                if (match) {
                    this.selectedTrackId = match.trackNodeId;
                    this.selectedLaneKey = match.laneKey;
                    return;
                }
            }
        }
        if (this.selectedLaneKey && this.hierarchy.laneByKey.has(this.selectedLaneKey)) {
            return;
        }
        const fallback = this.hierarchy.visibleLanes[0] ?? this.hierarchy.allLanes[0] ?? null;
        this.selectedTrackId = fallback?.trackNodeId ?? null;
        this.selectedLaneKey = fallback?.laneKey ?? null;
    }

    private selectTrackLane(trackNodeId: number, openInspector: boolean, laneKey?: string): void {
        let lane = (laneKey ? this.hierarchy.laneByKey.get(laneKey) : null)
            ?? this.hierarchy.allLanes.find(l => l.trackNodeId === trackNodeId)
            ?? this.hierarchy.laneByTrackId.get(trackNodeId)
            ?? null;
        this.selectedLaneKey = lane?.laneKey ?? `track:${trackNodeId}`;
        this.selectedTrackId = lane ? lane.trackNodeId : trackNodeId;

        // Selecting a track/sub-bus expands it in place (keeping parent, siblings, and other open items open!)
        let expandedNow = false;
        if (lane && lane.laneKind === 'track') {
            if (lane.hasChildTracks && this.collapsedTrackIds.has(lane.trackNodeId)) {
                this.collapsedTrackIds.delete(lane.trackNodeId);
                expandedNow = true;
            }
            if (lane.hasSignalChainLanes && !this.expandedSignalChainTrackIds.has(lane.trackNodeId)) {
                this.expandedSignalChainTrackIds.add(lane.trackNodeId);
                expandedNow = true;
            }
        }

        this.callbacks.selectNode(trackNodeId, { openInspector });
        this.callbacks.onPathNodeChanged?.(trackNodeId);
        if (expandedNow) {
            this.refreshModel();
            return;
        }
        this.syncTrackHeaderSelection();
        this.miniGraphStrip.setLane(lane);
        this.markWaveDirty();
    }

    private renderTrackHeaders(): void {
        const nextSig = this.hierarchy.visibleLanes.map(l => (
            `${l.laneKey}|${l.title}|${l.color}|${l.muted ? 1 : 0}|${l.effectivelyMuted ? 1 : 0}|${l.solo ? 1 : 0}`
            + `|${l.depth}|${l.collapsed ? 1 : 0}|${l.signalChainExpanded ? 1 : 0}|${l.isFocusedRoot ? 1 : 0}`
            + `|${l.isMainPreview ? 1 : 0}|${l.hasChildTracks ? 1 : 0}|${l.hasSignalChainLanes ? 1 : 0}|${l.rowHeight}`
        )).join('||');
        if (nextSig === this.lastHeadersSignature) {
            this.syncTrackHeaderSelection();
            return;
        }
        this.lastHeadersSignature = nextSig;

        this.trackMeterEls.clear();
        this.trackVolControls.clear();
        this.headersListEl.innerHTML = '';
        const graph = this.callbacks.getGraph();

        for (const lane of this.hierarchy.visibleLanes) {
            const trackNode = graph?.getNodeById?.(lane.trackNodeId);
            const isChainLane = lane.laneKind === 'chain';
            const isSelected = this.selectedLaneKey
                ? lane.laneKey === this.selectedLaneKey
                : lane.trackNodeId === this.selectedTrackId;
            const row = document.createElement('div');
            row.className = [
                'sin-tl-row',
                lane.isMasterRoot ? 'is-master' : '',
                lane.hasChildTracks ? 'is-bus' : '',
                isChainLane ? 'is-chain-lane' : '',
                lane.isFocusedRoot ? 'is-focused-root' : '',
                isSelected ? 'is-selected' : '',
                lane.effectivelyMuted ? 'is-muted' : '',
            ].filter(Boolean).join(' ');
            row.style.height = `${lane.rowHeight}px`;
            row.dataset.trackId = String(lane.trackNodeId);
            row.dataset.laneKey = lane.laneKey;
            row.style.setProperty('--track-color', lane.color);

            // Left indentation guides for nested child buses & signal chains
            const indentPx = lane.depth * 14;
            const inner = document.createElement('div');
            inner.className = 'sin-tl-row-inner';
            inner.style.paddingLeft = `${6 + indentPx}px`;

            if (lane.depth > 0) {
                const guide = document.createElement('span');
                guide.className = 'sin-tl-tree-guide';
                guide.style.left = `${indentPx - 2}px`;
                row.appendChild(guide);
            }

            // Top line: chevron + track/chain name + role/focus badge + M/S buttons
            const topRow = document.createElement('div');
            topRow.className = 'sin-tl-row-top';

            const canToggleExpand = !isChainLane && (lane.hasChildTracks || lane.hasSignalChainLanes);
            if (canToggleExpand) {
                const isExpandedNow = (lane.hasChildTracks && !lane.collapsed)
                    || (lane.hasSignalChainLanes && lane.signalChainExpanded);
                const chev = document.createElement('button');
                chev.type = 'button';
                chev.className = 'sin-tl-collapse-btn';
                chev.title = isExpandedNow ? 'Collapse inner lanes' : 'Expand inner lanes';
                chev.innerHTML = renderIcon(isExpandedNow ? 'chevronDown' : 'chevronRight');
                chev.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (isExpandedNow) {
                        if (lane.hasChildTracks) this.collapsedTrackIds.add(lane.trackNodeId);
                        this.expandedSignalChainTrackIds.delete(lane.trackNodeId);
                    } else {
                        this.collapsedTrackIds.delete(lane.trackNodeId);
                        if (lane.hasSignalChainLanes) this.expandedSignalChainTrackIds.add(lane.trackNodeId);
                    }
                    this.refreshModel();
                });
                topRow.appendChild(chev);
            } else {
                const spacer = document.createElement('span');
                spacer.className = 'sin-tl-collapse-spacer';
                topRow.appendChild(spacer);
            }

            const nameEl = document.createElement('span');
            nameEl.className = 'sin-tl-row-name';
            nameEl.textContent = lane.title;
            nameEl.title = lane.title;
            topRow.appendChild(nameEl);

            if (isChainLane) {
                const badgeText = lane.directSubgraph.nodes.find(n => n.id === lane.trackNodeId)?.badgeLabel || 'NODE';
                const tag = document.createElement('span');
                tag.className = 'sin-tl-role-tag is-chain';
                tag.textContent = badgeText;
                topRow.appendChild(tag);
            } else if (lane.depth > 0) {
                const busTag = document.createElement('span');
                busTag.className = 'sin-tl-role-tag is-bus-toggle';
                busTag.textContent = 'BUS';
                topRow.appendChild(busTag);
            } else if (lane.isMainPreview) {
                const tag = document.createElement('span');
                tag.className = 'sin-tl-role-tag is-main';
                tag.textContent = 'MAIN';
                tag.title = 'Active Main Preview output';
                topRow.appendChild(tag);
            } else if (lane.isMasterRoot) {
                const tag = document.createElement('span');
                tag.className = 'sin-tl-role-tag';
                tag.textContent = 'MASTER';
                topRow.appendChild(tag);
            }

            const flags = document.createElement('div');
            flags.className = 'sin-tl-row-flags';

            const muteBtn = document.createElement('button');
            muteBtn.type = 'button';
            muteBtn.className = `sin-tl-flag-btn is-mute${lane.muted ? ' is-active' : ''}`;
            muteBtn.textContent = 'M';
            muteBtn.title = lane.muted ? 'Unmute' : 'Mute';
            muteBtn.setAttribute('aria-pressed', String(lane.muted));
            muteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!trackNode) return;
                trackNode.updateProperty('muted', !Boolean(trackNode.properties?.muted));
                this.refreshModel();
            });
            flags.appendChild(muteBtn);

            if (!isChainLane) {
                const soloBtn = document.createElement('button');
                soloBtn.type = 'button';
                soloBtn.className = `sin-tl-flag-btn is-solo${lane.solo ? ' is-active' : ''}`;
                soloBtn.textContent = 'S';
                soloBtn.title = lane.solo ? 'Unsolo track' : 'Solo track';
                soloBtn.setAttribute('aria-pressed', String(lane.solo));
                soloBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (!trackNode) return;
                    trackNode.updateProperty('solo', !Boolean(trackNode.properties?.solo));
                    this.refreshModel();
                });
                flags.appendChild(soloBtn);
            }
            topRow.appendChild(flags);

            // Bottom line: compact Post-Gain volume slider + live RMS meter
            const bottomRow = document.createElement('div');
            bottomRow.className = 'sin-tl-row-bottom';

            const volInput = document.createElement('input');
            volInput.type = 'range';
            volInput.min = '-36';
            volInput.max = '12';
            volInput.step = '0.5';
            volInput.value = String(clamp(lane.postGainDb, -36, 12));
            volInput.className = 'sin-tl-vol-input';
            volInput.setAttribute('aria-label', `${lane.title} volume`);
            volInput.title = 'Post Gain (double-click to reset 0.0 dB)';

            const volVal = document.createElement('span');
            volVal.className = 'sin-tl-vol-val';
            volVal.textContent = formatDb(lane.postGainDb).replace(' dB', '');

            volInput.addEventListener('pointerdown', (e) => e.stopPropagation());
            volInput.addEventListener('click', (e) => e.stopPropagation());
            volInput.addEventListener('input', () => {
                const db = Number(volInput.value);
                volVal.textContent = formatDb(db).replace(' dB', '');
                if (trackNode) {
                    setTrackPostGainDb(trackNode, db);
                }
            });

            const sliderWrap = document.createElement('div');
            sliderWrap.className = 'sin-tl-vol-wrap';
            sliderWrap.appendChild(volInput);
            sliderWrap.addEventListener('pointerdown', (e) => e.stopPropagation());
            sliderWrap.addEventListener('click', (e) => e.stopPropagation());

            bottomRow.append(sliderWrap, volVal);
            this.trackVolControls.set(lane.trackNodeId, { input: volInput, valEl: volVal });

            // Enhance slider using shared Ableton-minimal recessed bar slider
            enhanceRangeSlider(volInput, {
                defaultValue: 0,
                compact: true,
                showValue: false,
            });

            const meterTrack = document.createElement('div');
            meterTrack.className = 'sin-tl-meter-track';
            const meterFill = document.createElement('div');
            meterFill.className = 'sin-tl-meter-fill';
            meterTrack.appendChild(meterFill);
            this.trackMeterEls.set(lane.trackNodeId, meterFill);

            inner.append(topRow, bottomRow, meterTrack);
            row.appendChild(inner);

            row.addEventListener('click', () => {
                this.selectTrackLane(lane.trackNodeId, false, lane.laneKey);
            });
            row.addEventListener('dblclick', () => {
                this.selectTrackLane(lane.trackNodeId, true, lane.laneKey);
            });

            this.headersListEl.appendChild(row);
        }
    }

    private syncTrackHeaderSelection(): void {
        const rows = this.headersListEl.querySelectorAll<HTMLElement>('.sin-tl-row');
        rows.forEach((row) => {
            const lk = row.dataset.laneKey || '';
            const tid = Number(row.dataset.trackId);
            const active = this.selectedLaneKey ? lk === this.selectedLaneKey : tid === this.selectedTrackId;
            row.classList.toggle('is-selected', active);
        });
    }

    // --- Live Engine Event Handlers ---

    public onPlanLoaded(res: {
        duration_sec?: number;
        tiled?: boolean;
        has_peak_pyramid?: boolean;
        tiled_bus_node_ids?: string[];
        tiled_stage_node_ids?: string[];
    }): void {
        if (typeof res?.duration_sec === 'number' && res.duration_sec > 0) {
            this.realtimeDurationSec = res.duration_sec;
        }
        this.hasPeakPyramid = Boolean(res?.has_peak_pyramid || res?.tiled);
        this.waveformCache.clearPyramidViewportPeaks();
        if (res?.tiled) {
            this.tileStore.setSessionScope(
                res.tiled_bus_node_ids || [],
                res.tiled_stage_node_ids || [],
                this.realtimeDurationSec
            );
        } else {
            this.tileStore.clear();
        }
        this.scheduleModelRefresh();
        this.markWaveDirty();
    }

    public onMasterPeaks(res: {
        duration_sec?: number;
        master_peaks?: number[];
        peak_tiers?: number[] | null;
        has_peak_pyramid?: boolean;
        tiled_bus_node_ids?: string[];
        tiled_stage_node_ids?: string[];
    }): void {
        const dur = Number(res?.duration_sec) || this.realtimeDurationSec || this.timebase.durationSec;
        if (dur > 0) this.realtimeDurationSec = dur;
        if (res?.has_peak_pyramid) {
            this.hasPeakPyramid = true;
        }
        const hasTiledInfo = Boolean(
            (Array.isArray(res?.tiled_bus_node_ids) && res.tiled_bus_node_ids.length > 0)
            || (Array.isArray(res?.peak_tiers) && res.peak_tiers.length > 0)
        );
        if (hasTiledInfo && Array.isArray(res?.master_peaks) && res.master_peaks.length >= 2) {
            this.tileStore.applyPeaks({
                busNodeIds: res.tiled_bus_node_ids,
                stageNodeIds: res.tiled_stage_node_ids,
                peaks: res.master_peaks,
                tiers: res.peak_tiers || null,
                durationSec: dur,
            });
        } else if (this.hasPeakPyramid && Array.isArray(res?.master_peaks) && res.master_peaks.length >= 2) {
            this.waveformCache.setPyramidViewportPeaks(res.master_peaks, 0, dur, dur);
            if (this.active && (this.zoom > 1.01 || this.computeDynamicPeakColumns() > res.master_peaks.length / 2)) {
                this.scheduleTiledViewportFetch(false);
            }
        }
        if (this.active) {
            this.syncToolbarControls();
            this.markWaveDirty();
        }
    }

    public onTileUpdate(msg: any): void {
        if (!msg) return;
        if (typeof msg.duration_sec === 'number' && msg.duration_sec > 0 && this.realtimeDurationSec <= 0) {
            this.realtimeDurationSec = msg.duration_sec;
        }
        this.tileStore.applyTileDelta(msg);
        if (msg.clear_all && this.active && this.zoom > 1.01) {
            this.scheduleTiledViewportFetch(true);
        }
        if (this.active) {
            this.syncToolbarControls();
            this.markWaveDirty();
        }
    }

    public onProcessorStatusUpdated(): void {
        if (!this.active) return;
        this.scheduleModelRefresh();
    }

    public onTelemetryFrame(
        playheadSec: number,
        durationSec: number,
        isPlaying: boolean,
        busRms?: Record<string, number> | null,
        busPeaks?: Record<string, number> | null
    ): void {
        this.playheadSec = Math.max(0, Number(playheadSec) || 0);
        this.isPlaying = Boolean(isPlaying);
        if (Number.isFinite(durationSec) && durationSec > 0 && Math.abs(durationSec - this.realtimeDurationSec) > 0.25) {
            this.realtimeDurationSec = durationSec;
            if (this.active) {
                this.scheduleModelRefresh();
            }
        }
        if (!this.active) return;

        // Auto-follow playhead cleanly when zoomed in and user is not dragging
        if (this.isPlaying && this.zoom > 1.01 && !this.activeDrag) {
            const span = this.getViewSpanSec();
            if (this.playheadSec > this.viewEndSec || this.playheadSec < this.viewStartSec) {
                this.setViewport(this.playheadSec - span * 0.12, span);
            }
        }

        // Update minimal Track Header RMS meters directly in DOM
        for (const [trackId, fillEl] of this.trackMeterEls.entries()) {
            const key = String(trackId);
            const rms = isPlaying ? Number(busRms?.[key] ?? 0) : 0;
            const peak = isPlaying ? Number(busPeaks?.[key] ?? rms) : 0;
            const level = Math.max(0, Math.min(1, Math.pow(Math.max(rms, peak * 0.72), 0.55)));
            fillEl.style.width = `${Math.round(level * 100)}%`;
            fillEl.classList.toggle('is-clipping', isPlaying && peak >= 0.99);
        }
        this.miniGraphStrip.updateMeters(isPlaying ? busRms : null, isPlaying ? busPeaks : null);
        this.miniGraphStrip.updatePlayback(this.playheadSec, this.timebase.durationSec, isPlaying, this.timebase.bpm);

        this.requestDraw(false);
    }

    // --- Zoom & Viewport Controls ---

    private getViewSpanSec(): number {
        const dur = Math.max(0.25, this.timebase.durationSec);
        if (this.zoom <= 1.01 || this.viewEndSec <= this.viewStartSec) return dur;
        return clamp(this.viewEndSec - this.viewStartSec, 0.1, dur);
    }

    private setViewport(startSec: number, spanSec: number): void {
        const dur = Math.max(0.25, this.timebase.durationSec);
        const minSpan = Math.min(dur, this.timebase.isFreeMode ? 1.0 : 0.25);
        const clampedSpan = clamp(spanSec, minSpan, dur);
        const maxStart = Math.max(0, dur - clampedSpan);
        this.viewStartSec = clamp(startSec, 0, maxStart);
        this.viewEndSec = Math.min(dur, this.viewStartSec + clampedSpan);
        this.zoom = clampedSpan > 0 ? Math.max(1, dur / clampedSpan) : 1;
        if (this.zoom <= 1.01) {
            this.zoom = 1;
            this.viewStartSec = 0;
            this.viewEndSec = dur;
        }
        this.minimapWrapEl.classList.toggle('is-hidden', this.hierarchy.visibleLanes.length === 0 || this.zoom <= 1.01);
        this.syncToolbarControls();
        this.scheduleTiledViewportFetch(false);
        this.waveformCache.scheduleViewportFetch(
            this.hierarchy.visibleLanes,
            this.tileStore,
            this.viewStartSec,
            this.viewEndSec,
            this.computeDynamicPeakColumns(),
            this.zoom
        );
        this.requestDraw(true);
    }

    public zoomBy(factor: number, anchorFrac = 0.5): void {
        const dur = Math.max(0.25, this.timebase.durationSec);
        const curSpan = this.getViewSpanSec();
        const maxZoom = Math.max(4, Math.min(2000, dur / 0.1));
        const nextZoom = clamp(this.zoom * factor, 1, maxZoom);
        if (Math.abs(nextZoom - this.zoom) < 1e-4) return;
        const anchorSec = this.viewStartSec + clamp(anchorFrac, 0, 1) * curSpan;
        const nextSpan = dur / nextZoom;
        this.setViewport(anchorSec - clamp(anchorFrac, 0, 1) * nextSpan, nextSpan);
    }

    public fitTimeline(): void {
        this.setViewport(0, this.timebase.durationSec);
    }

    private scheduleTiledViewportFetch(immediate: boolean): void {
        const isTiled = this.tileStore.hasActiveTiledSession();
        if (!isTiled && !this.hasPeakPyramid) return;
        if (this.tiledZoomTimer !== null) {
            window.clearTimeout(this.tiledZoomTimer);
            this.tiledZoomTimer = null;
        }
        const run = () => {
            this.tiledZoomTimer = null;
            const cols = this.computeDynamicPeakColumns();
            const token = ++this.tiledZoomToken;
            const s = this.viewStartSec;
            const e = this.viewEndSec;
            void this.callbacks.queryTiledPeaks(s, e, cols).then((vp) => {
                if (token !== this.tiledZoomToken || !vp?.ok || !Array.isArray(vp.peaks) || vp.peaks.length < 2) return;
                const dur = Number(vp.duration_sec) || this.timebase.durationSec;
                const vs = vp.start_sec ?? s;
                const ve = vp.end_sec ?? e;
                if (this.tileStore.hasActiveTiledSession()) {
                    this.tileStore.applyPeaks({
                        busNodeIds: vp.tiled_bus_node_ids,
                        peaks: vp.peaks,
                        tiers: vp.tiers || null,
                        durationSec: dur,
                        viewStartSec: vs,
                        viewEndSec: ve,
                    });
                } else {
                    this.waveformCache.setPyramidViewportPeaks(vp.peaks, vs, ve, dur);
                }
                this.markWaveDirty();
            }).catch(() => { });
        };
        if (immediate) run();
        else this.tiledZoomTimer = window.setTimeout(run, 55);
    }

    // --- Rendering Pipeline (2-Layer Offscreen Cache) ---

    public markWaveDirty(): void {
        this.requestDraw(true);
    }

    private requestDraw(waveDirty: boolean): void {
        if (waveDirty) this.backingDirty = true;
        if (!this.active || this.disposed) return;
        if (this.drawRaf !== null) return;
        this.drawRaf = window.requestAnimationFrame(() => {
            this.drawRaf = null;
            if (!this.active || this.disposed) return;
            this.drawLanes();
            this.drawRuler();
            if (this.zoom > 1.01) {
                this.drawMinimap();
            }
        });
    }

    private secToX(sec: number, width: number): number {
        const span = this.getViewSpanSec();
        return ((sec - this.viewStartSec) / span) * width;
    }

    private xToSec(x: number, width: number): number {
        if (width <= 0) return this.viewStartSec;
        const span = this.getViewSpanSec();
        return clamp(this.viewStartSec + (x / width) * span, 0, this.timebase.durationSec);
    }

    private drawRuler(): void {
        const canvas = this.rulerCanvas;
        const rect = canvas.getBoundingClientRect();
        const alignedCssW = Math.max(1, this.lanesScrollEl.clientWidth || Math.floor(rect.width));
        const cssH = Math.max(1, Math.round(rect.height || 24));
        if (alignedCssW <= 0 || cssH <= 0) return;
        // Lock ruler width strictly to lanesScrollEl.clientWidth so ticks match vertical
        // waveform grid lines with 0.0 px drift even when the vertical scrollbar is visible!
        if (canvas.style.width !== `${alignedCssW}px`) {
            canvas.style.width = `${alignedCssW}px`;
        }
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const w = Math.max(1, Math.round(alignedCssW * dpr));
        const h = Math.max(1, Math.round(cssH * dpr));
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        }
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const cssW = w / dpr;
        ctx.save();
        ctx.scale(dpr, dpr);

        ctx.fillStyle = '#f8fafc';
        ctx.fillRect(0, 0, cssW, cssH);

        // Loop bar highlight when loop is active
        if (this.callbacks.getLoopEnabled()) {
            const x0 = clamp(this.secToX(0, cssW), 0, cssW);
            const x1 = clamp(this.secToX(this.timebase.durationSec, cssW), 0, cssW);
            if (x1 > x0) {
                ctx.fillStyle = 'rgba(2, 132, 199, 0.14)';
                ctx.fillRect(x0, 0, x1 - x0, 4);
                ctx.fillStyle = '#0284c7';
                ctx.fillRect(x0, 0, x1 - x0, 2);
            }
        }

        const ticks = computeRulerTicks(
            this.viewStartSec,
            this.viewEndSec,
            cssW,
            this.timebase.resolvedRulerMode,
            this.timebase.bpm,
            this.timebase.durationSec
        );

        ctx.font = '600 9.5px ui-monospace, SFMono-Regular, Consolas, monospace';
        ctx.textBaseline = 'top';
        ctx.textAlign = 'left';

        for (const tick of ticks) {
            const px = Math.round(tick.x) + 0.5;
            ctx.strokeStyle = tick.major ? '#94a3b8' : '#cbd5e1';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(px, tick.major ? cssH - 10 : cssH - 5);
            ctx.lineTo(px, cssH);
            ctx.stroke();

            if (tick.major && tick.label) {
                ctx.fillStyle = '#475569';
                ctx.fillText(tick.label, Math.min(cssW - 36, px + 3), 4);
            }
        }

        // Bottom hairline
        ctx.fillStyle = '#cbd5e1';
        ctx.fillRect(0, cssH - 1, cssW, 1);

        // Playhead triangle marker
        const playX = this.secToX(this.playheadSec, cssW);
        if (playX >= -6 && playX <= cssW + 6) {
            const isScrub = this.activeDrag?.kind === 'scrub';
            ctx.fillStyle = isScrub ? '#059669' : '#0f172a';
            ctx.beginPath();
            ctx.moveTo(playX - 4.5, cssH - 9);
            ctx.lineTo(playX + 4.5, cssH - 9);
            ctx.lineTo(playX, cssH - 1);
            ctx.closePath();
            ctx.fill();
        }

        ctx.restore();
    }

    private computeTotalLanesHeight(): number {
        let total = 0;
        for (const lane of this.hierarchy.visibleLanes) {
            total += lane.rowHeight;
        }
        return total;
    }

    private drawLanes(): void {
        const canvas = this.lanesCanvas;
        const containerW = this.lanesScrollEl.clientWidth;
        const containerH = this.lanesScrollEl.clientHeight;
        if (containerW <= 0 || containerH <= 0) return;

        const contentH = Math.max(containerH, this.computeTotalLanesHeight());
        if (canvas.style.width !== `${containerW}px` || canvas.style.height !== `${contentH}px`) {
            canvas.style.width = `${containerW}px`;
            canvas.style.height = `${contentH}px`;
            this.backingDirty = true;
        }

        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const w = Math.max(1, Math.round(containerW * dpr));
        const h = Math.max(1, Math.round(contentH * dpr));
        if (canvas.width !== w || canvas.height !== h || this.cachedLanesCssW !== containerW || this.cachedLanesCssH !== contentH) {
            canvas.width = w;
            canvas.height = h;
            this.cachedLanesCssW = containerW;
            this.cachedLanesCssH = contentH;
            this.backingDirty = true;
        }

        const cssW = w / dpr;
        const cssH = h / dpr;

        // 1. Rebuild static offscreen backing canvas only when dirty
        if (!this.backingCanvas) {
            this.backingCanvas = document.createElement('canvas');
            this.backingDirty = true;
        }
        if (this.backingCanvas.width !== w || this.backingCanvas.height !== h) {
            this.backingCanvas.width = w;
            this.backingCanvas.height = h;
            this.backingDirty = true;
        }

        if (this.backingDirty) {
            this.backingDirty = false;
            const bCtx = this.backingCanvas.getContext('2d');
            if (bCtx) {
                this.renderLanesBacking(bCtx, cssW, cssH, dpr);
            }
        }

        // 2. Fast GPU blit + crisp live playhead & drag overlays
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(this.backingCanvas, 0, 0);

        ctx.save();
        ctx.scale(dpr, dpr);

        // Hover guide hairline
        if (this.hoverTimeSec !== null && !this.activeDrag) {
            const hx = this.secToX(this.hoverTimeSec, cssW);
            if (hx >= 0 && hx <= cssW) {
                ctx.strokeStyle = 'rgba(15, 23, 42, 0.16)';
                ctx.lineWidth = 1;
                ctx.setLineDash([3, 3]);
                ctx.beginPath();
                ctx.moveTo(hx, 0);
                ctx.lineTo(hx, cssH);
                ctx.stroke();
                ctx.setLineDash([]);
            }
        }

        // Active clip drag feedback (zero-cost live foreground preview at 60-120fps, ZERO backing redraw!)
        if (this.activeDrag && (this.activeDrag.kind === 'crop-start' || this.activeDrag.kind === 'crop-end' || this.activeDrag.kind === 'move-clip')) {
            const d = this.activeDrag;
            const dragSec = d.kind === 'move-clip' ? d.currentStartSec : d.currentSec;
            const gx = this.secToX(dragSec, cssW);

            if (d.kind === 'crop-start' || d.kind === 'crop-end') {
                const origX0 = clamp(this.secToX(d.clip.startSec, cssW), 0, cssW);
                const origX1 = clamp(this.secToX(d.clip.startSec + Math.max(0.05, d.clip.durationSec), cssW), 0, cssW);
                const curX = clamp(gx, 0, cssW);
                if (d.kind === 'crop-start' && curX > origX0) {
                    ctx.fillStyle = 'rgba(15, 23, 42, 0.14)';
                    ctx.fillRect(origX0, d.laneY, curX - origX0, d.laneH);
                } else if (d.kind === 'crop-end' && curX < origX1) {
                    ctx.fillStyle = 'rgba(15, 23, 42, 0.14)';
                    ctx.fillRect(curX, d.laneY, origX1 - curX, d.laneH);
                }
                const nextX0 = d.kind === 'crop-start' ? curX : origX0;
                const nextX1 = d.kind === 'crop-end' ? curX : origX1;
                if (nextX1 > nextX0) {
                    ctx.strokeStyle = '#0284c7';
                    ctx.lineWidth = 1.5;
                    ctx.strokeRect(nextX0 + 0.5, d.laneY + 1.5, Math.max(1, nextX1 - nextX0 - 1), Math.max(4, d.laneH - 3));
                }
            } else if (d.kind === 'move-clip') {
                const ghostX0 = clamp(gx, 0, cssW);
                const ghostX1 = clamp(this.secToX(d.currentStartSec + Math.max(0.1, d.clip.durationSec), cssW), 0, cssW);
                if (ghostX1 > ghostX0) {
                    ctx.fillStyle = 'rgba(2, 132, 199, 0.12)';
                    ctx.fillRect(ghostX0, d.laneY + 1, ghostX1 - ghostX0, d.laneH - 2);
                    ctx.strokeStyle = '#0284c7';
                    ctx.lineWidth = 1.5;
                    ctx.strokeRect(ghostX0 + 0.5, d.laneY + 1.5, Math.max(1, ghostX1 - ghostX0 - 1), Math.max(4, d.laneH - 3));
                }
            }

            if (gx >= 0 && gx <= cssW) {
                ctx.strokeStyle = '#0284c7';
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.moveTo(gx, 0);
                ctx.lineTo(gx, cssH);
                ctx.stroke();

                const label = this.timebase.resolvedRulerMode === 'bars'
                    ? formatMusicalTime(dragSec, this.timebase.bpm)
                    : formatTimelineTime(dragSec, true);
                this.drawFloatingPill(ctx, gx + 6, Math.max(4, d.laneY + 4), label, '#0284c7', cssW);
            }
        }

        // Playhead needle
        const playX = this.secToX(this.playheadSec, cssW);
        if (playX >= -1 && playX <= cssW + 1) {
            const isScrub = this.activeDrag?.kind === 'scrub';
            ctx.strokeStyle = isScrub ? '#059669' : '#0f172a';
            ctx.lineWidth = isScrub ? 2 : 1.5;
            ctx.beginPath();
            ctx.moveTo(playX, 0);
            ctx.lineTo(playX, cssH);
            ctx.stroke();

            if (isScrub) {
                const label = this.timebase.resolvedRulerMode === 'bars'
                    ? `${formatMusicalTime(this.playheadSec, this.timebase.bpm)} · ${formatTimelineTime(this.playheadSec, true)}`
                    : formatTimelineTime(this.playheadSec, true);
                const scrollTop = this.lanesScrollEl.scrollTop;
                this.drawFloatingPill(ctx, playX + 6, scrollTop + 6, label, '#059669', cssW);
            }
        }

        ctx.restore();
    }

    private drawFloatingPill(
        ctx: CanvasRenderingContext2D,
        x: number,
        y: number,
        text: string,
        accent: string,
        maxW: number
    ): void {
        ctx.font = '600 9.5px ui-monospace, SFMono-Regular, Consolas, monospace';
        const tw = ctx.measureText(text).width;
        const padX = 5;
        const bw = tw + padX * 2;
        const bh = 16;
        const bx = clamp(x, 4, Math.max(4, maxW - bw - 4));
        ctx.fillStyle = 'rgba(15, 23, 42, 0.90)';
        ctx.fillRect(bx, y, bw, bh);
        ctx.strokeStyle = accent;
        ctx.lineWidth = 1;
        ctx.strokeRect(bx + 0.5, y + 0.5, bw - 1, bh - 1);
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, bx + padX, y + bh * 0.5 + 0.5);
    }

    private renderLanesBacking(
        ctx: CanvasRenderingContext2D,
        cssW: number,
        cssH: number,
        dpr: number
    ): void {
        ctx.save();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, cssW, cssH);

        const graph = this.callbacks.getGraph();
        const ticks = computeRulerTicks(
            this.viewStartSec,
            this.viewEndSec,
            cssW,
            this.timebase.resolvedRulerMode,
            this.timebase.bpm,
            this.timebase.durationSec
        );

        const renderCols = Math.max(1, Math.round(cssW * dpr));
        if (this.scratchColMin.length < renderCols) {
            this.scratchColMin = new Float32Array(renderCols);
            this.scratchColMax = new Float32Array(renderCols);
        }
        const colMin = this.scratchColMin.length === renderCols ? this.scratchColMin : this.scratchColMin.subarray(0, renderCols);
        const colMax = this.scratchColMax.length === renderCols ? this.scratchColMax : this.scratchColMax.subarray(0, renderCols);

        let curY = 0;
        for (let idx = 0; idx < this.hierarchy.visibleLanes.length; idx++) {
            const lane = this.hierarchy.visibleLanes[idx];
            const laneH = lane.rowHeight;
            const isSelected = this.selectedLaneKey
                ? lane.laneKey === this.selectedLaneKey
                : lane.trackNodeId === this.selectedTrackId;

            // Lane background
            if (isSelected) {
                ctx.fillStyle = 'rgba(2, 132, 199, 0.045)';
            } else if (lane.isMasterRoot) {
                ctx.fillStyle = '#f8fafc';
            } else if (lane.laneKind === 'chain') {
                ctx.fillStyle = '#fafbfc';
            } else if (idx % 2 === 1) {
                ctx.fillStyle = '#fcfdfe';
            } else {
                ctx.fillStyle = '#ffffff';
            }
            ctx.fillRect(0, curY, cssW, laneH);

            // Vertical grid lines inside lane
            for (const tick of ticks) {
                const gx = Math.round(tick.x) + 0.5;
                ctx.strokeStyle = tick.major ? 'rgba(148, 163, 184, 0.24)' : 'rgba(203, 213, 225, 0.14)';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(gx, curY);
                ctx.lineTo(gx, curY + laneH);
                ctx.stroke();
            }

            // Center hairline
            const midY = curY + (laneH - 3) * 0.5;
            ctx.fillStyle = 'rgba(15, 23, 42, 0.05)';
            ctx.fillRect(0, Math.floor(midY), cssW, 1);

            // 1. Crisp, high-DPI continuous waveform envelope (with 4-tier dual-color baked/unbaked overlay)
            const trackNode = graph?.getNodeById?.(lane.trackNodeId);
            const resolved = this.waveformCache.resolveTrackPeaks(
                lane,
                trackNode,
                this.tileStore,
                this.timebase.durationSec,
                this.viewStartSec,
                this.viewEndSec,
                renderCols
            );

            if (resolved && resolved.peaks.length >= 2) {
                samplePeaksForColumns(
                    resolved.peaks,
                    resolved.startSec,
                    resolved.endSec,
                    this.viewStartSec,
                    this.viewEndSec,
                    renderCols,
                    colMin,
                    colMax
                );

                const hasTiers = Boolean(resolved.isTiled && resolved.tiers && resolved.tiers.length === renderCols);
                const railH = hasTiers ? 3 : 0;
                const waveTop = curY + 3;
                const waveH = Math.max(12, laneH - 5 - railH);
                const waveMidY = waveTop + waveH * 0.5;
                const halfScale = waveH * 0.46;

                if (hasTiers && resolved.tiers) {
                    const tiers = resolved.tiers;
                    // Subtle translucent tier wash
                    this.drawTierRuns(ctx, tiers, TIMELINE_TIER_BG_COLORS, curY, laneH - railH, dpr);

                    // Continuous smooth envelope runs per tier (zero blockiness!)
                    ctx.save();
                    if (lane.effectivelyMuted) ctx.globalAlpha = 0.36;
                    let runStart = 0;
                    let runTier = tiers[0];
                    for (let x = 1; x <= renderCols; x++) {
                        const cur = x < renderCols ? tiers[x] : -1;
                        if (cur !== runTier) {
                            this.drawWaveformEnvelopeRun(
                                ctx,
                                colMin,
                                colMax,
                                runStart,
                                x,
                                waveMidY,
                                halfScale,
                                TIMELINE_TIER_COLORS[runTier],
                                dpr
                            );
                            runStart = x;
                            runTier = cur;
                        }
                    }
                    ctx.restore();

                    // 3px bottom dual-color coverage rail
                    this.drawTierRuns(ctx, tiers, TIMELINE_TIER_RAIL_COLORS, curY + laneH - railH, railH, dpr);
                } else {
                    ctx.save();
                    if (lane.effectivelyMuted) ctx.globalAlpha = 0.36;
                    this.drawWaveformEnvelopeRun(
                        ctx,
                        colMin,
                        colMax,
                        0,
                        renderCols,
                        waveMidY,
                        halfScale,
                        lane.color,
                        dpr
                    );
                    ctx.restore();
                }
            }

            // 2. Minimal precision clip trim hairlines & corner tag (no blocky overlays!)
            this.drawLaneClips(ctx, lane, curY, laneH, cssW);

            // 3. Arrangement Section Dividers & Labels
            this.drawArrangementOverlays(ctx, lane, curY, laneH, cssW);

            // 4. Sequence Step Hit Ticks
            this.drawSequenceOverlays(ctx, lane, curY, laneH, cssW);

            // Muted lane subtle veil
            if (lane.effectivelyMuted) {
                ctx.fillStyle = 'rgba(248, 250, 252, 0.30)';
                ctx.fillRect(0, curY, cssW, laneH);
            }

            // Bottom row separator
            ctx.fillStyle = lane.isMasterRoot ? '#cbd5e1' : '#e2e8f0';
            ctx.fillRect(0, curY + laneH - 1, cssW, 1);

            curY += laneH;
        }

        ctx.restore();
    }

    /**
     * Renders a contiguous slice `[startIdx..endIdx)` as a crisp anti-aliased continuous waveform
     * envelope (filled polygon + inner core + 1-physical-px upper/lower contour stroke) instead of
     * blocky vertical bars.
     */
    private drawWaveformEnvelopeRun(
        ctx: CanvasRenderingContext2D,
        colMin: Float32Array,
        colMax: Float32Array,
        startIdx: number,
        endIdx: number,
        midY: number,
        halfScale: number,
        color: string,
        dpr: number
    ): void {
        const invDpr = 1 / dpr;
        let segStart = -1;

        const flushSegment = (s0: number, s1: number) => {
            const count = s1 - s0;
            if (count <= 0) return;

            if (count === 1) {
                const px = (s0 + 0.5) * invDpr;
                const yTop = midY - colMax[s0] * halfScale;
                const yBot = midY - colMin[s0] * halfScale;
                ctx.strokeStyle = color;
                ctx.lineWidth = Math.max(0.75, invDpr);
                ctx.beginPath();
                ctx.moveTo(px, Math.min(yTop, midY - 0.5));
                ctx.lineTo(px, Math.max(yBot, midY + 0.5));
                ctx.stroke();
                return;
            }

            // Outer translucent envelope polygon
            ctx.beginPath();
            ctx.moveTo((s0 + 0.5) * invDpr, midY - colMax[s0] * halfScale);
            for (let i = s0 + 1; i < s1; i++) {
                ctx.lineTo((i + 0.5) * invDpr, midY - colMax[i] * halfScale);
            }
            for (let i = s1 - 1; i >= s0; i--) {
                ctx.lineTo((i + 0.5) * invDpr, midY - colMin[i] * halfScale);
            }
            ctx.closePath();
            ctx.fillStyle = colorWithAlpha(color, 0.28);
            ctx.fill();

            // Subtle denser inner body core for studio-DAW clarity
            ctx.beginPath();
            ctx.moveTo((s0 + 0.5) * invDpr, midY - colMax[s0] * halfScale * 0.55);
            for (let i = s0 + 1; i < s1; i++) {
                ctx.lineTo((i + 0.5) * invDpr, midY - colMax[i] * halfScale * 0.55);
            }
            for (let i = s1 - 1; i >= s0; i--) {
                ctx.lineTo((i + 0.5) * invDpr, midY - colMin[i] * halfScale * 0.55);
            }
            ctx.closePath();
            ctx.fillStyle = colorWithAlpha(color, 0.24);
            ctx.fill();

            // Razor-sharp 1-physical-pixel upper + lower contour strokes
            ctx.strokeStyle = color;
            ctx.lineWidth = Math.max(0.65, invDpr);
            ctx.lineJoin = 'round';
            ctx.beginPath();
            ctx.moveTo((s0 + 0.5) * invDpr, midY - colMax[s0] * halfScale);
            for (let i = s0 + 1; i < s1; i++) {
                ctx.lineTo((i + 0.5) * invDpr, midY - colMax[i] * halfScale);
            }
            ctx.moveTo((s0 + 0.5) * invDpr, midY - colMin[s0] * halfScale);
            for (let i = s0 + 1; i < s1; i++) {
                ctx.lineTo((i + 0.5) * invDpr, midY - colMin[i] * halfScale);
            }
            ctx.stroke();
        };

        for (let i = startIdx; i < endIdx; i++) {
            const active = Math.abs(colMin[i]) > 1e-4 || Math.abs(colMax[i]) > 1e-4;
            if (active) {
                if (segStart < 0) segStart = i;
            } else if (segStart >= 0) {
                flushSegment(segStart, i);
                segStart = -1;
            }
        }
        if (segStart >= 0) {
            flushSegment(segStart, endIdx);
        }
    }

    private drawTierRuns(
        ctx: CanvasRenderingContext2D,
        tiers: Uint8Array,
        palette: readonly (string | null)[],
        y: number,
        height: number,
        dpr = 1
    ): void {
        const len = tiers.length;
        if (len === 0 || height <= 0) return;
        const invDpr = 1 / dpr;
        let runStart = 0;
        let runTier = tiers[0];
        for (let x = 1; x <= len; x++) {
            const cur = x < len ? tiers[x] : -1;
            if (cur !== runTier) {
                const color = palette[runTier];
                if (color) {
                    ctx.fillStyle = color;
                    ctx.fillRect(runStart * invDpr, y, (x - runStart) * invDpr, height);
                }
                runStart = x;
                runTier = cur;
            }
        }
    }

    private drawLaneClips(
        ctx: CanvasRenderingContext2D,
        lane: TimelineTrackLane,
        laneY: number,
        laneH: number,
        cssW: number
    ): void {
        if (lane.clips.length === 0) return;
        const padTop = 1;
        const padBottom = 4;
        const boxH = Math.max(16, laneH - padTop - padBottom);

        for (const clip of lane.clips) {
            const effDur = clip.durationSec > 0 ? clip.durationSec : Math.max(0.25, this.timebase.durationSec - clip.startSec);
            const totalEnd = clip.isLooped ? this.timebase.durationSec : (clip.startSec + effDur);
            const x0 = this.secToX(clip.startSec, cssW);
            const x1 = this.secToX(totalEnd, cssW);
            if (x1 < 0 || x0 > cssW) continue;

            const rx0 = Math.max(0, x0);
            const rx1 = Math.min(cssW, x1);
            const rw = rx1 - rx0;
            if (rw <= 1) continue;

            // Minimal floating corner filename badge (non-blocking — leaves waveform unobstructed!)
            if (rw >= 48) {
                ctx.save();
                ctx.font = '600 8.5px Inter, system-ui, sans-serif';
                const maxLabelW = Math.min(180, rw - 10);
                let label = clip.label;
                if (ctx.measureText(label).width > maxLabelW) {
                    while (label.length > 3 && ctx.measureText(label + '…').width > maxLabelW) {
                        label = label.slice(0, -1);
                    }
                    label += '…';
                }
                const tw = ctx.measureText(label).width;
                const bx = rx0 + 4;
                const by = laneY + 3;
                ctx.fillStyle = 'rgba(255, 255, 255, 0.80)';
                ctx.fillRect(bx, by, tw + 6, 11);
                ctx.fillStyle = lane.effectivelyMuted ? '#94a3b8' : '#334155';
                ctx.textAlign = 'left';
                ctx.textBaseline = 'middle';
                ctx.fillText(label, bx + 3, by + 6);
                ctx.restore();
            }

            // Loop cycle vertical markers
            if (clip.isLooped && clip.durationSec > 0.05) {
                let loopT = clip.startSec + clip.durationSec;
                let guard = 0;
                ctx.save();
                ctx.strokeStyle = colorWithAlpha(clip.color, 0.30);
                ctx.lineWidth = 1;
                ctx.setLineDash([2, 3]);
                while (loopT < totalEnd - 1e-3 && guard < 128) {
                    const lx = this.secToX(loopT, cssW);
                    if (lx >= 0 && lx <= cssW) {
                        ctx.beginPath();
                        ctx.moveTo(lx + 0.5, laneY + padTop);
                        ctx.lineTo(lx + 0.5, laneY + padTop + boxH);
                        ctx.stroke();
                    }
                    loopT += clip.durationSec;
                    guard++;
                }
                ctx.restore();
            }

            // Crisp thin left/right crop trim edge handles (editable direct samples)
            if (clip.editableCrop) {
                ctx.fillStyle = colorWithAlpha(clip.color, 0.72);
                if (x0 >= 0 && x0 <= cssW) {
                    ctx.fillRect(x0, laneY + padTop, 1.5, boxH);
                }
                const singleEndX = this.secToX(clip.startSec + effDur, cssW);
                if (singleEndX >= 0 && singleEndX <= cssW) {
                    ctx.fillRect(singleEndX - 1.5, laneY + padTop, 1.5, boxH);
                }
            }
        }
    }

    private drawArrangementOverlays(
        ctx: CanvasRenderingContext2D,
        lane: TimelineTrackLane,
        laneY: number,
        laneH: number,
        cssW: number
    ): void {
        if (lane.arrangementSections.length === 0) return;
        for (const sec of lane.arrangementSections) {
            const x0 = this.secToX(sec.startSec, cssW);
            const x1 = this.secToX(sec.endSec, cssW);
            if (x1 < 0 || x0 > cssW) continue;

            const rx0 = Math.max(0, x0);
            const rx1 = Math.min(cssW, x1);
            if (sec.probability <= 0.001) {
                ctx.fillStyle = 'rgba(148, 163, 184, 0.16)';
                ctx.fillRect(rx0, laneY, rx1 - rx0, laneH - 1);
            }

            if (x0 >= 0 && x0 <= cssW && sec.index > 0) {
                ctx.save();
                ctx.strokeStyle = 'rgba(217, 119, 6, 0.65)';
                ctx.lineWidth = 1;
                ctx.setLineDash([3, 2]);
                ctx.beginPath();
                ctx.moveTo(Math.round(x0) + 0.5, laneY + 1);
                ctx.lineTo(Math.round(x0) + 0.5, laneY + laneH - 2);
                ctx.stroke();
                ctx.restore();
            }

            if (rx1 - rx0 >= 32) {
                const slotText = sec.slot === '*' ? '' : ` [${sec.slot}]`;
                const probText = sec.probability < 0.99 ? ` ${Math.round(sec.probability * 100)}%` : '';
                const label = `S${sec.index}${slotText}${probText}`;
                ctx.font = '600 8.5px ui-monospace, SFMono-Regular, Consolas, monospace';
                const tw = ctx.measureText(label).width;
                const bx = rx0 + 3;
                const by = laneY + 3;
                ctx.fillStyle = 'rgba(255, 251, 235, 0.90)';
                ctx.fillRect(bx, by, tw + 6, 12);
                ctx.strokeStyle = 'rgba(217, 119, 6, 0.45)';
                ctx.lineWidth = 1;
                ctx.strokeRect(bx + 0.5, by + 0.5, tw + 5, 11);
                ctx.fillStyle = '#92400e';
                ctx.textAlign = 'left';
                ctx.textBaseline = 'middle';
                ctx.fillText(label, bx + 3, by + 6.5);
            }
        }
    }

    private drawSequenceOverlays(
        ctx: CanvasRenderingContext2D,
        lane: TimelineTrackLane,
        laneY: number,
        laneH: number,
        cssW: number
    ): void {
        if (lane.sequenceMarkers.length === 0) return;
        const baseY = laneY + laneH - 2;
        for (const m of lane.sequenceMarkers) {
            const x = this.secToX(m.timeSec, cssW);
            if (x < 0 || x > cssW) continue;
            const h = Math.max(4, Math.round(4 + m.velocity * 9));
            ctx.fillStyle = colorWithAlpha('#ec4899', 0.28 + m.probability * 0.55);
            ctx.fillRect(Math.round(x), baseY - h, 2, h);
        }
    }

    private drawMinimap(): void {
        const canvas = this.minimapCanvas;
        const rect = canvas.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const w = Math.max(1, Math.round(rect.width * dpr));
        const h = Math.max(1, Math.round(rect.height * dpr));
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        }
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const cssW = w / dpr;
        const cssH = h / dpr;
        const dur = Math.max(0.25, this.timebase.durationSec);

        ctx.save();
        ctx.scale(dpr, dpr);
        ctx.fillStyle = '#f1f5f9';
        ctx.fillRect(0, 0, cssW, cssH);

        // Full-track dual-color tile coverage overview
        const cov = this.tileStore.getPrimaryCoverageSlots();
        if (cov) {
            const slotW = cssW / cov.length;
            for (let s = 0; s < cov.length; s++) {
                const t = cov[s];
                if (t > 0) {
                    ctx.fillStyle = TIMELINE_TIER_RAIL_COLORS[t];
                    ctx.fillRect(s * slotW, 0, Math.ceil(slotW), cssH);
                }
            }
        }

        // Viewport thumb
        const vx0 = (this.viewStartSec / dur) * cssW;
        const vx1 = (this.viewEndSec / dur) * cssW;
        const vw = Math.max(14, vx1 - vx0);
        ctx.fillStyle = 'rgba(15, 23, 42, 0.34)';
        ctx.fillRect(Math.min(cssW - vw, vx0), 1, vw, cssH - 2);
        ctx.strokeStyle = 'rgba(15, 23, 42, 0.65)';
        ctx.lineWidth = 1;
        ctx.strokeRect(Math.min(cssW - vw, vx0) + 0.5, 1.5, vw - 1, cssH - 3);

        // Playhead indicator
        const px = clamp((this.playheadSec / dur) * cssW, 0, cssW - 2);
        ctx.fillStyle = '#059669';
        ctx.fillRect(px, 0, 2, cssH);

        ctx.restore();
    }

    // --- Hit Testing & Pointer Interactions ---

    private hitTestLanes(localX: number, localY: number, cssW: number): {
        lane: TimelineTrackLane | null;
        laneY: number;
        hitKind: 'crop-start' | 'crop-end' | 'move-clip' | 'lane';
        clip: TimelineClipRegion | null;
    } {
        let curY = 0;
        for (const lane of this.hierarchy.visibleLanes) {
            const nextY = curY + lane.rowHeight;
            if (localY >= curY && localY < nextY) {
                const relY = localY - curY;
                for (const clip of lane.clips) {
                    const effDur = clip.durationSec > 0 ? clip.durationSec : Math.max(0.25, this.timebase.durationSec - clip.startSec);
                    const x0 = this.secToX(clip.startSec, cssW);
                    const xEnd = this.secToX(clip.startSec + effDur, cssW);
                    const xFullEnd = clip.isLooped ? this.secToX(this.timebase.durationSec, cssW) : xEnd;

                    if (clip.editableCrop) {
                        if (Math.abs(localX - x0) <= 6) {
                            return { lane, laneY: curY, hitKind: 'crop-start', clip };
                        }
                        if (Math.abs(localX - xEnd) <= 6) {
                            return { lane, laneY: curY, hitKind: 'crop-end', clip };
                        }
                    }
                    if (clip.editableStartBeat && relY <= 16 && localX >= x0 + 4 && localX <= xFullEnd - 4) {
                        return { lane, laneY: curY, hitKind: 'move-clip', clip };
                    }
                }
                return { lane, laneY: curY, hitKind: 'lane', clip: null };
            }
            curY = nextY;
        }
        return { lane: null, laneY: 0, hitKind: 'lane', clip: null };
    }

    private bindEvents(): void {
        // Vertical scroll synchronization between left Track Headers and right Timeline Lanes
        this.lanesScrollEl.addEventListener('scroll', () => {
            if (this.syncScrollLock) return;
            this.syncScrollLock = true;
            this.headersScrollEl.scrollTop = this.lanesScrollEl.scrollTop;
            this.syncScrollLock = false;
        }, { passive: true });

        this.headersScrollEl.addEventListener('scroll', () => {
            if (this.syncScrollLock) return;
            this.syncScrollLock = true;
            this.lanesScrollEl.scrollTop = this.headersScrollEl.scrollTop;
            this.syncScrollLock = false;
        }, { passive: true });

        // Resize observer (dynamically re-fetches sharper peaks when screen width changes!)
        if (typeof ResizeObserver !== 'undefined') {
            this.resizeObserver = new ResizeObserver(() => {
                if (this.active) {
                    const nextW = this.lanesScrollEl.clientWidth || 0;
                    const widthDelta = Math.abs(nextW - this.lastFetchedCssW);
                    this.cachedLanesCssW = 0;
                    this.cachedLanesCssH = 0;
                    this.requestDraw(true);
                    if (nextW > 0 && widthDelta > 64) {
                        this.lastFetchedCssW = nextW;
                        this.scheduleTiledViewportFetch(false);
                        this.waveformCache.scheduleViewportFetch(
                            this.hierarchy.visibleLanes,
                            this.tileStore,
                            this.viewStartSec,
                            this.viewEndSec,
                            this.computeDynamicPeakColumns(),
                            this.zoom
                        );
                    }
                }
            });
            this.resizeObserver.observe(this.lanesScrollEl);
            this.resizeObserver.observe(this.rulerCanvas);
        }

        // Wheel zoom / horizontal pan on both ruler and lanes
        const onWheel = (e: WheelEvent) => {
            const rect = this.lanesCanvas.getBoundingClientRect();
            if (rect.width <= 0) return;

            if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
                if (this.zoom > 1.01) {
                    e.preventDefault();
                    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
                    const span = this.getViewSpanSec();
                    this.setViewport(this.viewStartSec + (delta / 360) * span, span);
                }
                return;
            }
            // Ctrl/Cmd + Wheel OR plain vertical wheel when mouse is over ruler / timeline zooms horizontally
            if (e.ctrlKey || e.metaKey || e.currentTarget === this.rulerCanvas || this.lanesScrollEl.scrollHeight <= this.lanesScrollEl.clientHeight + 2) {
                e.preventDefault();
                const anchorFrac = clamp((e.clientX - rect.left) / rect.width, 0, 1);
                const factor = e.deltaY < 0 ? 1.24 : (1 / 1.24);
                this.zoomBy(factor, anchorFrac);
            }
        };
        this.rulerCanvas.addEventListener('wheel', onWheel, { passive: false });
        this.lanesScrollEl.addEventListener('wheel', onWheel, { passive: false });

        // Ruler scrub & double-click fit
        this.rulerCanvas.addEventListener('pointerdown', (e: PointerEvent) => {
            if (e.button === 1) {
                if (this.zoom <= 1.01) return;
                e.preventDefault();
                this.activeDrag = { kind: 'pan', pointerId: e.pointerId, anchorX: e.clientX, anchorStartSec: this.viewStartSec };
                try { this.rulerCanvas.setPointerCapture(e.pointerId); } catch { }
                return;
            }
            if (e.button !== 0) return;
            e.preventDefault();
            const rect = this.rulerCanvas.getBoundingClientRect();
            const sec = this.xToSec(e.clientX - rect.left, rect.width);
            this.activeDrag = { kind: 'scrub', pointerId: e.pointerId };
            try { this.rulerCanvas.setPointerCapture(e.pointerId); } catch { }
            this.playheadSec = sec;
            this.callbacks.seekToSeconds(sec, { scrubbing: true });
            this.requestDraw(false);
        });

        this.rulerCanvas.addEventListener('dblclick', () => this.fitTimeline());

        // Lanes pointerdown: crop handle / clip drag / middle-pan / lane select + scrub
        this.lanesCanvas.addEventListener('pointerdown', (e: PointerEvent) => {
            const rect = this.lanesCanvas.getBoundingClientRect();
            const localX = e.clientX - rect.left;
            const localY = e.clientY - rect.top;

            if (e.button === 1 || (e.button === 0 && e.shiftKey && this.zoom > 1.01)) {
                e.preventDefault();
                this.activeDrag = { kind: 'pan', pointerId: e.pointerId, anchorX: e.clientX, anchorStartSec: this.viewStartSec };
                try { this.lanesCanvas.setPointerCapture(e.pointerId); } catch { }
                return;
            }
            if (e.button !== 0) return;

            const hit = this.hitTestLanes(localX, localY, rect.width);
            if (hit.lane) {
                this.selectTrackLane(hit.lane.trackNodeId, false, hit.lane.laneKey);
            }

            const graph = this.callbacks.getGraph();
            if ((hit.hitKind === 'crop-start' || hit.hitKind === 'crop-end') && hit.clip) {
                const sampleNode = graph?.getNodeById?.(hit.clip.sampleNodeId);
                if (sampleNode) {
                    e.preventDefault();
                    this.activeDrag = {
                        kind: hit.hitKind,
                        pointerId: e.pointerId,
                        clip: hit.clip,
                        sampleNode,
                        laneY: hit.laneY,
                        laneH: hit.lane?.rowHeight ?? 56,
                        initialCropStart: hit.clip.cropStart,
                        initialCropEnd: hit.clip.cropEnd,
                        pendingCropStart: hit.clip.cropStart,
                        pendingCropEnd: hit.clip.cropEnd,
                        currentSec: hit.hitKind === 'crop-start' ? hit.clip.startSec : (hit.clip.startSec + hit.clip.durationSec),
                    };
                    try { this.lanesCanvas.setPointerCapture(e.pointerId); } catch { }
                    return;
                }
            }

            if (hit.hitKind === 'move-clip' && hit.clip) {
                const sampleNode = graph?.getNodeById?.(hit.clip.sampleNodeId);
                if (sampleNode) {
                    e.preventDefault();
                    const clickSec = this.xToSec(localX, rect.width);
                    this.activeDrag = {
                        kind: 'move-clip',
                        pointerId: e.pointerId,
                        clip: hit.clip,
                        sampleNode,
                        laneY: hit.laneY,
                        laneH: hit.lane?.rowHeight ?? 56,
                        grabOffsetSec: clickSec - hit.clip.startSec,
                        currentStartSec: hit.clip.startSec,
                    };
                    try { this.lanesCanvas.setPointerCapture(e.pointerId); } catch { }
                    return;
                }
            }

            // Default: scrub playhead
            e.preventDefault();
            const sec = this.xToSec(localX, rect.width);
            this.activeDrag = { kind: 'scrub', pointerId: e.pointerId };
            try { this.lanesCanvas.setPointerCapture(e.pointerId); } catch { }
            this.playheadSec = sec;
            this.callbacks.seekToSeconds(sec, { scrubbing: true });
            this.requestDraw(false);
        });

        // Minimap drag
        this.minimapCanvas.addEventListener('pointerdown', (e: PointerEvent) => {
            if (e.button !== 0 || this.zoom <= 1.01) return;
            e.preventDefault();
            this.activeDrag = { kind: 'minimap', pointerId: e.pointerId };
            try { this.minimapCanvas.setPointerCapture(e.pointerId); } catch { }
            this.panMinimapFromEvent(e);
        });

        // Unified pointermove / pointerup (early-exit with 0 cost when Timeline View is inactive!)
        const onPointerMove = (e: PointerEvent) => {
            if (!this.active) return;
            const drag = this.activeDrag;
            if (!drag) {
                // Hover cursor & guide updates when over lanesCanvas
                if (e.target === this.lanesCanvas) {
                    const rect = this.lanesCanvas.getBoundingClientRect();
                    const localX = e.clientX - rect.left;
                    const localY = e.clientY - rect.top;
                    const hit = this.hitTestLanes(localX, localY, rect.width);
                    const nextCursor = hit.hitKind === 'crop-start' || hit.hitKind === 'crop-end'
                        ? 'ew-resize'
                        : (hit.hitKind === 'move-clip' ? 'grab' : 'default');
                    if (nextCursor !== this.hoverCursor) {
                        this.hoverCursor = nextCursor;
                        this.lanesCanvas.style.cursor = nextCursor;
                    }
                    this.hoverTimeSec = this.xToSec(localX, rect.width);
                    this.requestDraw(false);
                }
                return;
            }

            if (drag.kind === 'minimap') {
                this.panMinimapFromEvent(e);
                return;
            }

            const rect = this.lanesCanvas.getBoundingClientRect();
            if (rect.width <= 0) return;

            if (drag.kind === 'pan') {
                const dx = e.clientX - drag.anchorX;
                const span = this.getViewSpanSec();
                this.setViewport(drag.anchorStartSec - (dx / rect.width) * span, span);
                return;
            }

            if (drag.kind === 'scrub') {
                const sec = this.xToSec(e.clientX - rect.left, rect.width);
                this.playheadSec = sec;
                this.callbacks.seekToSeconds(sec, { scrubbing: true });
                this.requestDraw(false);
                return;
            }

            const rawSec = this.xToSec(e.clientX - rect.left, rect.width);
            const snapOn = this.isSnapEffective() && !e.altKey;
            const snappedSec = snapTimeToGrid(
                rawSec,
                this.timebase.bpm,
                this.getViewSpanSec(),
                rect.width,
                snapOn,
                this.timebase.resolvedRulerMode
            );

            if (drag.kind === 'move-clip') {
                const nextStartSec = Math.max(0, snapTimeToGrid(
                    rawSec - drag.grabOffsetSec,
                    this.timebase.bpm,
                    this.getViewSpanSec(),
                    rect.width,
                    snapOn,
                    this.timebase.resolvedRulerMode
                ));
                drag.currentStartSec = nextStartSec;
                // O(1) foreground-only preview during drag; commit once on pointerup!
                this.requestDraw(false);
                return;
            }

            if (drag.kind === 'crop-start' || drag.kind === 'crop-end') {
                const srcDur = drag.clip.sourceDurationSec > 0 ? drag.clip.sourceDurationSec : this.timebase.durationSec;
                if (srcDur <= 0.01) return;
                const rate = Math.max(0.05, drag.clip.playbackRate);
                const effSpan = srcDur / rate;
                // Anchor the full untrimmed source timeline origin relative to initial cropStart
                const sourceOriginSec = drag.clip.startSec - drag.initialCropStart * effSpan;
                const targetRatio = clamp((snappedSec - sourceOriginSec) / effSpan, 0, 1);
                if (drag.kind === 'crop-start') {
                    const nextStart = clamp(targetRatio, 0, Math.max(0, drag.initialCropEnd - 0.005));
                    drag.pendingCropStart = Math.round(nextStart * 10000) / 10000;
                    drag.currentSec = sourceOriginSec + drag.pendingCropStart * effSpan;
                } else {
                    const nextEnd = clamp(targetRatio, Math.min(1, drag.initialCropStart + 0.005), 1);
                    drag.pendingCropEnd = Math.round(nextEnd * 10000) / 10000;
                    drag.currentSec = sourceOriginSec + drag.pendingCropEnd * effSpan;
                }
                // Zero-freeze 60fps foreground preview; commit property once on pointerup!
                this.requestDraw(false);
            }
        };

        const onPointerUp = (e: PointerEvent) => {
            if (!this.active && !this.activeDrag) return;
            const drag = this.activeDrag;
            if (!drag) return;
            this.activeDrag = null;
            if (drag.kind === 'scrub') {
                const rect = this.lanesCanvas.getBoundingClientRect();
                const sec = rect.width > 0 ? this.xToSec(e.clientX - rect.left, rect.width) : this.playheadSec;
                this.playheadSec = sec;
                this.callbacks.seekToSeconds(sec, { scrubbing: false });
                this.requestDraw(false);
                return;
            }
            if (drag.kind === 'move-clip') {
                const nextBeat = Math.round((drag.currentStartSec / this.timebase.secPerBeat) * 1000) / 1000;
                drag.sampleNode.clearFieldOperator?.('start_beat');
                drag.sampleNode.setStaticFieldValue?.('start_beat', nextBeat);
                drag.sampleNode.updateProperty('start_beat', nextBeat);
                drag.sampleNode.syncActiveSlotFromProperties?.();
                this.refreshClipGeometryInPlace(drag.clip.sampleNodeId);
                this.miniGraphStrip.syncCardVisual(drag.clip.sampleNodeId);
                this.requestDraw(true);
                return;
            }
            if (drag.kind === 'crop-start') {
                if (Math.abs(drag.pendingCropStart - drag.initialCropStart) > 1e-5) {
                    drag.sampleNode.clearFieldOperator?.('crop_start');
                    drag.sampleNode.setStaticFieldValue?.('crop_start', drag.pendingCropStart);
                    drag.sampleNode.updateProperty('crop_start', drag.pendingCropStart);
                    drag.sampleNode.syncActiveSlotFromProperties?.();
                    this.refreshClipGeometryInPlace(drag.clip.sampleNodeId);
                    this.miniGraphStrip.syncCardVisual(drag.clip.sampleNodeId);
                }
                this.requestDraw(true);
                return;
            }
            if (drag.kind === 'crop-end') {
                if (Math.abs(drag.pendingCropEnd - drag.initialCropEnd) > 1e-5) {
                    drag.sampleNode.clearFieldOperator?.('crop_end');
                    drag.sampleNode.setStaticFieldValue?.('crop_end', drag.pendingCropEnd);
                    drag.sampleNode.updateProperty('crop_end', drag.pendingCropEnd);
                    drag.sampleNode.syncActiveSlotFromProperties?.();
                    this.refreshClipGeometryInPlace(drag.clip.sampleNodeId);
                    this.miniGraphStrip.syncCardVisual(drag.clip.sampleNodeId);
                }
                this.requestDraw(true);
                return;
            }
            this.requestDraw(false);
        };

        this.lanesCanvas.addEventListener('pointerleave', () => {
            if (!this.activeDrag) {
                this.hoverTimeSec = null;
                this.hoverCursor = 'default';
                this.lanesCanvas.style.cursor = 'default';
                this.requestDraw(false);
            }
        });

        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp);
        window.addEventListener('pointercancel', onPointerUp);

        this.cleanupWindowListeners = () => {
            window.removeEventListener('pointermove', onPointerMove);
            window.removeEventListener('pointerup', onPointerUp);
            window.removeEventListener('pointercancel', onPointerUp);
        };
    }

    private cleanupWindowListeners: () => void = () => { };

    private panMinimapFromEvent(e: PointerEvent): void {
        const rect = this.minimapCanvas.getBoundingClientRect();
        if (rect.width <= 0) return;
        const frac = clamp((e.clientX - rect.left) / rect.width, 0, 1);
        const span = this.getViewSpanSec();
        this.setViewport(frac * this.timebase.durationSec - span * 0.5, span);
    }

    public dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.active = false;
        this.cleanupWindowListeners();
        if (this.modelRefreshRaf !== null) {
            window.cancelAnimationFrame(this.modelRefreshRaf);
            this.modelRefreshRaf = null;
        }
        if (this.drawRaf !== null) {
            window.cancelAnimationFrame(this.drawRaf);
            this.drawRaf = null;
        }
        if (this.tiledZoomTimer !== null) {
            window.clearTimeout(this.tiledZoomTimer);
            this.tiledZoomTimer = null;
        }
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        this.waveformCache.dispose();
        this.miniGraphStrip.dispose();
        this.trackMeterEls.clear();
        this.backingCanvas = null;
        this.element.remove();
    }
}
