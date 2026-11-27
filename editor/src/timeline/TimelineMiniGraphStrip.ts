/**
 * Lightweight, DAW + Graph Bottom Signal Rack with:
 * - Top ancestor-to-selected clickable Path Indicator (`Master › Bus › Chain › Node`)
 * - Left scrollable upstream signal-chain rows with real inline SVG cables between cards
 * - Middle live SVG Cable Junction Gutter wiring each upstream row into the Mixer Section
 * - Right pinned DAW Mixer Section for the selected lane (vertical FX insert list opening
 *   shared FX GUIs to the LEFT, fader/visualizer, M/S, RMS meter)
 * - Card-to-card drag-and-drop signal-flow swap (swaps real LGraph cables & canvas coordinates)
 * - FX drag-and-drop (reorder within node OR move/Alt-copy across nodes) + Copy/Paste FX
 * - Persistent open rows + zero DOM teardown during continuous drags & playback
 */

import { renderIcon } from '../../../packages/ui/src/icons.js';
import { enhanceRangeSlider } from '../../../packages/ui/src/slider.js';
import { type BaseNode, type CompactCardSpec, getDefaultFxChain } from '../nodes/BaseNode.ts';
import {
    type ChainModuleInstance,
    type DspProcessorDef,
    dbToLinear,
    formatDb,
    getPrePostGainDb,
    getUserFxStages,
    isFixedPostGain,
    isFixedPreGain,
    isRegisteredProcessor,
    listAddableProcessors,
} from '../dsp/processorRegistry.ts';
import { createFxVisualWidget, type FxVisualHandle } from '../ui/components/fx/FxVisualWidgets.ts';
import {
    canSwapGraphNodes,
    cloneFxModuleWithFreshId,
    layoutSignalChainRows,
    moveOrCopyFxBetweenChains,
    pasteFxIntoChain,
    reorderFxInChain,
    type SignalChainRow,
    type TimelineMiniGraphEdge,
    type TimelineMiniGraphNode,
    type TimelineTrackLane,
} from './timelineModel.ts';
import { extractViewportPeaksFromAudioBuffer } from './TimelineWaveformCache.ts';

export interface MiniGraphStripCallbacks {
    getGraph: () => any;
    getSelectedNodeIds: () => ReadonlySet<number>;
    onSelectNode: (nodeId: number, options?: { openInspector?: boolean; initialTab?: string }) => void;
    onJumpToTrack: (trackNodeId: number) => void;
    onSwapNodes: (nodeIdA: number, nodeIdB: number) => boolean;
    onRowsMetaChanged?: (info: { rowCount: number; allExpanded: boolean }) => void;
    onGraphMutated: () => void;
}

interface MountedFxVisual {
    nodeId: number;
    stageIndex: number;
    handle: FxVisualHandle;
}

interface LiveWaveEntry {
    canvas: HTMLCanvasElement;
    playheadEl: HTMLDivElement;
    nodeId: number;
    color: string;
    syncCropOverlay?: () => void;
}

interface LiveSeqGridEntry {
    nodeId: number;
    stepCells: HTMLButtonElement[];
    stepLength: number;
}

interface LiveArrBarEntry {
    playheadEl: HTMLDivElement;
    totalBars: number;
}

type RackDragPayload =
    | { kind: 'sin-node-card'; nodeId: number }
    | { kind: 'sin-fx-stage'; sourceNodeId: number; moduleId: string };

// Shared FX clipboard across renders & sessions
let sharedFxClipboard: ChainModuleInstance | null = null;
function getFxClipboard(): ChainModuleInstance | null {
    if (sharedFxClipboard) return sharedFxClipboard;
    if (typeof window !== 'undefined' && (window as any).__sinFxClipboard) {
        sharedFxClipboard = (window as any).__sinFxClipboard;
    }
    return sharedFxClipboard;
}
function setFxClipboard(mod: ChainModuleInstance): void {
    const copy = cloneFxModuleWithFreshId(mod);
    sharedFxClipboard = copy;
    if (typeof window !== 'undefined') {
        (window as any).__sinFxClipboard = copy;
    }
}

function formatProcessorBadge(state: string | null, progress: number, bypassed: boolean): { text: string; tone: string } | null {
    const st = bypassed ? 'bypassed' : (state || 'ready');
    const pct = Math.round(Math.max(0, Math.min(1, progress)) * 100);
    switch (st) {
        case 'bypassed': return { text: 'BYP', tone: 'amber' };
        case 'cooking_bypassed': return { text: `${pct}%`, tone: 'sky' };
        case 'partial_ready': return { text: `${pct}%`, tone: 'emerald' };
        case 'stale_bypassed': return { text: 'STALE', tone: 'amber' };
        case 'model_missing': return { text: 'DL?', tone: 'danger' };
        case 'downloading': return { text: `DL ${pct}%`, tone: 'violet' };
        case 'error': return { text: 'ERR', tone: 'danger' };
        case 'ready': return { text: 'OK', tone: 'ok' };
        default: return null;
    }
}

function normalizeNodeChain(node: BaseNode): any[] {
    let rawChain: any[] = Array.isArray(node.properties?.chain) ? node.properties.chain : [];
    if (rawChain.length === 0) {
        rawChain = getDefaultFxChain();
        node.updateProperty('chain', rawChain);
    }
    const filtered = rawChain.filter((m: any) => m && isRegisteredProcessor(m.type));
    const pre = filtered.find(isFixedPreGain) || getDefaultFxChain()[0];
    const post = filtered.find(isFixedPostGain) || getDefaultFxChain()[1];
    const middle = filtered.filter((m: any) => !isFixedPreGain(m) && !isFixedPostGain(m));
    return [pre, ...middle, post].map((m: any) =>
        m && typeof m === 'object' ? { ...m, params: { ...(m.params || {}) } } : m
    );
}

function commitNodeScalarProperty(node: any, key: string, value: any, syncInspector = false): void {
    if (!node || typeof node.updateProperty !== 'function') return;
    node.clearFieldOperator?.(key);
    node.setStaticFieldValue?.(key, value);
    node.updateProperty(key, value);
    if (syncInspector && typeof window !== 'undefined' && node.id != null) {
        window.dispatchEvent(new CustomEvent('node-properties-refreshed', { detail: { nodeId: node.id } }));
    }
}

function setNodePostGainDb(node: any, nextDb: number): void {
    if (!node || typeof node.updateProperty !== 'function') return;
    const clampedDb = Math.max(-36, Math.min(12, Math.round(nextDb * 10) / 10));
    const linear = dbToLinear(clampedDb);
    const currentChain = Array.isArray(node.properties?.chain) && node.properties.chain.length > 0
        ? node.properties.chain.map((m: any) => ({ ...m, params: { ...(m?.params || {}) } }))
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
    node.updateProperty('chain', currentChain);
}

function drawStaticMiniWaveform(
    canvas: HTMLCanvasElement,
    liveNode: any,
    accentColor: string
): void {
    const cssW = Math.max(96, Math.round(canvas.clientWidth || 180));
    const cssH = Math.max(36, Math.round(canvas.clientHeight || 88));
    const dpr = Math.min(2, typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1);
    const w = Math.round(cssW * dpr);
    const h = Math.round(cssH * dpr);
    if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(0, 0, cssW, cssH);

    const midY = cssH * 0.5;
    ctx.fillStyle = 'rgba(15, 23, 42, 0.06)';
    ctx.fillRect(0, Math.floor(midY), cssW, 1);

    let peaks: Float32Array | null = null;
    const buf: AudioBuffer | null = liveNode?.manifestStemBuffer
        || liveNode?._lastRenderedBuffer
        || liveNode?.audioBuffer
        || (typeof liveNode?.getAudioBuffer === 'function' ? liveNode.getAudioBuffer() : null);

    const sampleCols = Math.max(64, Math.min(480, Math.round(cssW * dpr)));
    if (buf && buf.length > 0 && buf.duration > 0) {
        peaks = extractViewportPeaksFromAudioBuffer(buf, 0, buf.duration, sampleCols);
    } else if (liveNode?.realtimePeaks instanceof Float32Array && liveNode.realtimePeaks.length >= 2) {
        peaks = liveNode.realtimePeaks;
    }

    if (peaks && peaks.length >= 2) {
        const pairCount = Math.floor(peaks.length / 2);
        const halfScale = cssH * 0.43;

        ctx.beginPath();
        for (let i = 0; i < pairCount; i++) {
            const x = (i / Math.max(1, pairCount - 1)) * cssW;
            const hi = Math.max(-1, Math.min(1, peaks[i * 2 + 1]));
            if (i === 0) ctx.moveTo(x, midY - hi * halfScale);
            else ctx.lineTo(x, midY - hi * halfScale);
        }
        for (let i = pairCount - 1; i >= 0; i--) {
            const x = (i / Math.max(1, pairCount - 1)) * cssW;
            const lo = Math.max(-1, Math.min(1, peaks[i * 2]));
            ctx.lineTo(x, midY - lo * halfScale);
        }
        ctx.closePath();
        ctx.fillStyle = accentColor + '36';
        ctx.fill();

        ctx.strokeStyle = accentColor;
        ctx.lineWidth = Math.max(0.7, 1 / dpr);
        ctx.lineJoin = 'round';
        ctx.beginPath();
        for (let i = 0; i < pairCount; i++) {
            const x = (i / Math.max(1, pairCount - 1)) * cssW;
            const hi = Math.max(-1, Math.min(1, peaks[i * 2 + 1]));
            if (i === 0) ctx.moveTo(x, midY - hi * halfScale);
            else ctx.lineTo(x, midY - hi * halfScale);
        }
        for (let i = 0; i < pairCount; i++) {
            const x = (i / Math.max(1, pairCount - 1)) * cssW;
            const lo = Math.max(-1, Math.min(1, peaks[i * 2]));
            if (i === 0) ctx.moveTo(x, midY - lo * halfScale);
            else ctx.lineTo(x, midY - lo * halfScale);
        }
        ctx.stroke();
    } else {
        ctx.fillStyle = '#94a3b8';
        ctx.font = '600 9px ui-monospace, SFMono-Regular, Consolas, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(liveNode?.properties?.filepath ? 'Disk stream' : 'No signal', cssW * 0.5, midY);
    }

    ctx.restore();
}

function makeInlineDragPill(opts: {
    label: string;
    min: number;
    max: number;
    step: number;
    defaultValue: number;
    getValue: () => number;
    formatValue: (v: number) => string;
    onChange: (nextVal: number, committed: boolean) => void;
}): { element: HTMLDivElement; sync: () => void } {
    const pill = document.createElement('div');
    pill.className = 'sin-rack-drag-pill';
    pill.title = `${opts.label} (drag horizontally, scroll, or Alt+click to reset)`;

    const fill = document.createElement('span');
    fill.className = 'sin-rack-drag-pill-fill';
    const lbl = document.createElement('span');
    lbl.className = 'sin-rack-drag-pill-lbl';
    lbl.textContent = opts.label;
    const valEl = document.createElement('span');
    valEl.className = 'sin-rack-drag-pill-val';
    pill.append(fill, lbl, valEl);

    const span = Math.max(1e-6, opts.max - opts.min);
    const snap = (raw: number) => {
        const clamped = Math.max(opts.min, Math.min(opts.max, raw));
        const s = Math.round(clamped / opts.step) * opts.step;
        return Math.max(opts.min, Math.min(opts.max, Number(s.toFixed(4))));
    };

    const sync = () => {
        const v = opts.getValue();
        valEl.textContent = opts.formatValue(v);
        const norm = Math.max(0, Math.min(1, (v - opts.min) / span));
        fill.style.width = `${(norm * 100).toFixed(1)}%`;
    };
    sync();

    let dragging = false;
    let startX = 0;
    let startVal = 0;
    let lastVal = 0;

    pill.addEventListener('pointerdown', (e: PointerEvent) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        e.preventDefault();
        if (e.altKey) {
            opts.onChange(opts.defaultValue, true);
            sync();
            return;
        }
        dragging = true;
        startX = e.clientX;
        startVal = opts.getValue();
        lastVal = startVal;
        try { pill.setPointerCapture(e.pointerId); } catch { }
    });
    pill.addEventListener('pointermove', (e: PointerEvent) => {
        if (!dragging) return;
        const next = snap(startVal + ((e.clientX - startX) / 110) * span);
        if (next !== lastVal) {
            lastVal = next;
            opts.onChange(next, false);
            sync();
        }
    });
    const finish = (e: PointerEvent) => {
        if (!dragging) return;
        dragging = false;
        try { pill.releasePointerCapture(e.pointerId); } catch { }
        opts.onChange(lastVal, true);
        sync();
    };
    pill.addEventListener('pointerup', finish);
    pill.addEventListener('pointercancel', finish);
    pill.addEventListener('wheel', (e: WheelEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const dir = e.deltaY < 0 ? 1 : -1;
        const delta = Math.max(opts.step, span * 0.04) * dir;
        const next = snap(opts.getValue() + delta);
        opts.onChange(next, true);
        sync();
    }, { passive: false });

    return { element: pill, sync };
}

function createInlineCableSvg(color: string, compact: boolean, isDirect: boolean): HTMLDivElement {
    const wrap = document.createElement('div');
    wrap.className = `sin-rack-inline-cable${compact ? ' is-compact' : ''}${isDirect ? '' : ' is-passthrough'}`;
    wrap.setAttribute('aria-hidden', 'true');
    const w = compact ? 18 : 26;
    const h = compact ? 16 : 24;
    const mid = h / 2;
    wrap.innerHTML = `
        <svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" fill="none">
            <path d="M 3 ${mid} C ${w * 0.38} ${mid}, ${w * 0.62} ${mid}, ${w - 3} ${mid}"
                  stroke="${color}" stroke-width="${compact ? 1.5 : 1.75}" stroke-opacity="0.72"
                  stroke-dasharray="${isDirect ? 'none' : '3 2.5'}" />
            <circle cx="3" cy="${mid}" r="${compact ? 2.1 : 2.5}" fill="${color}" />
            <circle cx="${w - 3}" cy="${mid}" r="${compact ? 2.1 : 2.5}" fill="${color}" />
        </svg>
    `;
    return wrap;
}

export class TimelineMiniGraphStrip {
    public readonly element: HTMLElement;
    private readonly callbacks: MiniGraphStripCallbacks;
    private readonly resizeHandle: HTMLDivElement;
    private readonly bodyEl: HTMLDivElement;
    private readonly rowsPaneEl: HTMLDivElement;
    private readonly busCablesWrapEl: HTMLDivElement;
    private readonly busCablesSvgEl: SVGSVGElement;
    private readonly mixerDockEl: HTMLDivElement;

    private readonly meterEls = new Map<number, HTMLElement[]>();
    private readonly waveformEntries: LiveWaveEntry[] = [];
    private readonly seqGrids: LiveSeqGridEntry[] = [];
    private readonly arrBars: LiveArrBarEntry[] = [];
    private readonly activeFxVisuals: MountedFxVisual[] = [];
    private readonly cardVisualSyncs = new Map<number, Array<() => void>>();
    private readonly cardCleanups: Array<() => void> = [];

    // Persistent row expansion & per-node FX drawer state
    private readonly expandedRowIds = new Set<string>();
    private readonly openFxByNode = new Map<number, string>();
    private openMixerFxId: string | null = null;
    private pendingScrollSelector: string | null = null;
    private lastLaneKey: string | null = null;
    private lastRenderSignature = '';
    private lastRowsMeta: { rowCount: number; allExpanded: boolean } = { rowCount: 0, allExpanded: false };

    // Active drag-and-drop payload (for live dragover validation since browsers hide getData during dragover)
    private activeDragPayload: RackDragPayload | null = null;
    private activeContextMenu: HTMLDivElement | null = null;
    private busCableRaf: number | null = null;
    private resizeObserver: ResizeObserver | null = null;

    // Live playback telemetry state for zero-cost CSS playheads
    private playheadSec = 0;
    private durationSec = 0;
    private bpm = 120;
    private isPlaying = false;

    private currentLane: TimelineTrackLane | null = null;
    private collapsed = false;
    private bodyHeight = 236;
    private isResizing = false;
    private resizeStartY = 0;
    private resizeStartH = 236;
    private disposed = false;

    private readonly handlePointerMove: (e: PointerEvent) => void;
    private readonly handlePointerUp: () => void;
    private readonly handleStageMeters: (e: Event) => void;
    private readonly handlePeaksUpdated: () => void;
    private readonly handleGlobalPointerDown: (e: Event) => void;

    constructor(callbacks: MiniGraphStripCallbacks) {
        this.callbacks = callbacks;

        this.element = document.createElement('section');
        this.element.className = 'sin-tl-minigraph-strip';
        this.element.setAttribute('aria-label', 'Signal Chain & Mixer Rack');
        this.element.tabIndex = -1;

        this.resizeHandle = document.createElement('div');
        this.resizeHandle.className = 'sin-tl-mg-resize-handle';
        this.resizeHandle.title = 'Drag to resize signal chain rack';
        this.element.appendChild(this.resizeHandle);

        // 3-Zone DAW + Graph Body directly above the unified global footer bar
        this.bodyEl = document.createElement('div');
        this.bodyEl.className = 'sin-tl-mg-body sin-rack-body-grid';
        this.bodyEl.style.height = `${this.bodyHeight}px`;

        this.rowsPaneEl = document.createElement('div');
        this.rowsPaneEl.className = 'sin-rack-rows-pane';
        this.rowsPaneEl.addEventListener('scroll', () => this.scheduleBusCableUpdate(), { passive: true });

        // Smooth wheel handling: vertical scroll across rows by default; Shift+Wheel scrolls row track horizontally
        this.rowsPaneEl.addEventListener('wheel', (e: WheelEvent) => {
            const target = e.target as HTMLElement | null;
            if (target?.closest('.fx-visual-container, .sin-rack-drag-pill')) return;
            const rowTrack = target?.closest('.sin-rack-row-track') as HTMLElement | null;
            if (!rowTrack || rowTrack.scrollWidth <= rowTrack.clientWidth + 2) return;
            const canScrollV = this.rowsPaneEl.scrollHeight > this.rowsPaneEl.clientHeight + 2;
            if (e.shiftKey || !canScrollV) {
                if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
                    e.preventDefault();
                    rowTrack.scrollLeft += e.deltaY;
                }
            }
        }, { passive: false });

        this.busCablesWrapEl = document.createElement('div');
        this.busCablesWrapEl.className = 'sin-rack-bus-cables';
        this.busCablesWrapEl.setAttribute('aria-hidden', 'true');
        this.busCablesSvgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        this.busCablesSvgEl.setAttribute('class', 'sin-rack-bus-cables-svg');
        this.busCablesWrapEl.appendChild(this.busCablesSvgEl);

        this.mixerDockEl = document.createElement('div');
        this.mixerDockEl.className = 'sin-rack-mixer-dock';

        this.bodyEl.append(this.rowsPaneEl, this.busCablesWrapEl, this.mixerDockEl);
        this.element.appendChild(this.bodyEl);

        // Keyboard Copy/Paste FX inside the bottom rack
        this.element.addEventListener('keydown', (e: KeyboardEvent) => {
            const tag = (e.target as HTMLElement | null)?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
            if (!(e.ctrlKey || e.metaKey)) return;
            const key = e.key.toLowerCase();
            if (key === 'c') {
                const mod = this.resolveFocusedFxModule();
                if (mod) {
                    e.preventDefault();
                    e.stopPropagation();
                    setFxClipboard(mod);
                    this.render();
                }
            } else if (key === 'v') {
                const clip = getFxClipboard();
                const targetId = Array.from(this.callbacks.getSelectedNodeIds())[0] ?? this.currentLane?.trackNodeId;
                if (clip && targetId != null) {
                    e.preventDefault();
                    e.stopPropagation();
                    this.pasteFxOnNode(targetId, null);
                }
            }
        });

        this.resizeHandle.addEventListener('pointerdown', (e: PointerEvent) => {
            if (e.button !== 0 || this.collapsed) return;
            e.preventDefault();
            this.isResizing = true;
            this.resizeStartY = e.clientY;
            this.resizeStartH = this.bodyHeight;
            this.element.classList.add('is-resizing');
        });

        this.handlePointerMove = (e: PointerEvent) => {
            if (!this.isResizing) return;
            const dy = this.resizeStartY - e.clientY;
            this.bodyHeight = Math.max(150, Math.min(480, Math.round(this.resizeStartH + dy)));
            this.bodyEl.style.height = `${this.bodyHeight}px`;
            this.scheduleBusCableUpdate();
        };

        this.handlePointerUp = () => {
            if (!this.isResizing) return;
            this.isResizing = false;
            this.element.classList.remove('is-resizing');
            this.scheduleBusCableUpdate();
        };

        this.handleStageMeters = (evt: Event) => {
            if (this.collapsed || this.activeFxVisuals.length === 0) return;
            const detail = (evt as CustomEvent)?.detail as Record<string, Record<number, number>> | undefined;
            if (!detail) return;
            for (const item of this.activeFxVisuals) {
                const nodeMeters = detail[String(item.nodeId)];
                const val = nodeMeters && nodeMeters[item.stageIndex] !== undefined ? Number(nodeMeters[item.stageIndex]) : 0;
                item.handle.updateMeter(val);
            }
        };

        this.handlePeaksUpdated = () => {
            if (this.collapsed || this.disposed) return;
            this.refreshStaticWaveforms();
            for (const item of this.activeFxVisuals) {
                item.handle.refreshWaveform?.();
            }
        };

        this.handleGlobalPointerDown = (e: Event) => {
            if (this.activeContextMenu && !this.activeContextMenu.contains(e.target as Node)) {
                this.closeContextMenu();
            }
        };

        if (typeof ResizeObserver !== 'undefined') {
            this.resizeObserver = new ResizeObserver(() => this.scheduleBusCableUpdate());
            this.resizeObserver.observe(this.bodyEl);
        }

        window.addEventListener('pointermove', this.handlePointerMove);
        window.addEventListener('pointerup', this.handlePointerUp);
        window.addEventListener('sin-stage-meters', this.handleStageMeters);
        window.addEventListener('sin-peaks-updated', this.handlePeaksUpdated);
        document.addEventListener('pointerdown', this.handleGlobalPointerDown);
    }

    private closeContextMenu(): void {
        if (this.activeContextMenu) {
            this.activeContextMenu.remove();
            this.activeContextMenu = null;
        }
    }

    private resolveFocusedFxModule(): ChainModuleInstance | null {
        const graph = this.callbacks.getGraph();
        if (!graph) return null;
        if (this.openMixerFxId && this.currentLane) {
            const node = graph.getNodeById?.(this.currentLane.trackNodeId);
            const found = getUserFxStages(node?.properties?.chain).find(s => String(s.module.id) === this.openMixerFxId);
            if (found) return found.module;
        }
        for (const [nodeId, modId] of this.openFxByNode.entries()) {
            const node = graph.getNodeById?.(nodeId);
            const found = getUserFxStages(node?.properties?.chain).find(s => String(s.module.id) === modId);
            if (found) return found.module;
        }
        return null;
    }

    private teardownRenderedContents(): void {
        this.closeContextMenu();
        for (const fn of this.cardCleanups) {
            try { fn(); } catch { }
        }
        this.cardCleanups.length = 0;
        for (const item of this.activeFxVisuals) {
            try { item.handle.destroy(); } catch { }
        }
        this.activeFxVisuals.length = 0;
        this.waveformEntries.length = 0;
        this.seqGrids.length = 0;
        this.arrBars.length = 0;
        this.meterEls.clear();
        this.cardVisualSyncs.clear();
    }

    private registerMeterEl(nodeId: number, el: HTMLElement): void {
        let arr = this.meterEls.get(nodeId);
        if (!arr) {
            arr = [];
            this.meterEls.set(nodeId, arr);
        }
        arr.push(el);
    }

    private registerCardVisualSync(nodeId: number, fn: () => void): void {
        let arr = this.cardVisualSyncs.get(nodeId);
        if (!arr) {
            arr = [];
            this.cardVisualSyncs.set(nodeId, arr);
        }
        arr.push(fn);
    }

    public isCollapsed(): boolean {
        return this.collapsed;
    }

    public setCollapsed(next: boolean): void {
        this.collapsed = Boolean(next);
        this.element.classList.toggle('is-collapsed', this.collapsed);
        if (!this.collapsed) {
            this.scheduleBusCableUpdate();
        }
    }

    public getRowsMeta(): { rowCount: number; allExpanded: boolean } {
        return { ...this.lastRowsMeta };
    }

    private computeLaneRenderSignature(lane: TimelineTrackLane | null, graph: any): string {
        if (!lane) return 'null';
        const nodesSig = lane.directSubgraph.nodes.map(n => {
            const live = graph?.getNodeById?.(n.id);
            const fxSig = live
                ? getUserFxStages(live.properties?.chain)
                    .map(s => `${s.module.id}:${s.def.type}:${s.module.enabled === false ? 0 : 1}`)
                    .join(',')
                : '';
            return `${n.id}:${n.kind}:${n.title}:${n.bypassed ? 1 : 0}:${n.muted ? 1 : 0}:${n.solo ? 1 : 0}:${n.activeSlot}/${n.slotCount}:${n.processorState || ''}:${Math.round((n.processorProgress || 0) * 100)}:${fxSig}`;
        }).join(';');
        const edgesSig = lane.directSubgraph.edges.map(e => `${e.fromId}>${e.toId}`).join(',');
        return `${lane.laneKey}|${lane.title}|${lane.color}|${nodesSig}|${edgesSig}`;
    }

    public setLane(lane: TimelineTrackLane | null): void {
        const nextKey = lane?.laneKey ?? null;
        const laneChanged = nextKey !== this.lastLaneKey;
        if (laneChanged) {
            this.lastLaneKey = nextKey;
            this.expandedRowIds.clear();
            this.openFxByNode.clear();
            this.openMixerFxId = null;
            this.lastRenderSignature = '';
        }
        this.currentLane = lane;

        const graph = this.callbacks.getGraph();
        const nextSig = this.computeLaneRenderSignature(lane, graph);
        if (!laneChanged && nextSig === this.lastRenderSignature) {
            this.syncSelectionClasses();
            return;
        }
        this.lastRenderSignature = nextSig;
        this.render();
    }

    public syncCardVisual(nodeId: number): void {
        if (this.disposed) return;
        const fns = this.cardVisualSyncs.get(nodeId);
        if (fns) {
            for (const fn of fns) {
                try { fn(); } catch { }
            }
        }
        const graph = this.callbacks.getGraph();
        if (!graph) return;
        const liveNode = graph.getNodeById?.(nodeId);
        if (!liveNode) return;
        for (const entry of this.waveformEntries) {
            if (entry.nodeId === nodeId && entry.canvas.isConnected) {
                entry.syncCropOverlay?.();
                drawStaticMiniWaveform(entry.canvas, liveNode, entry.color);
            }
        }
    }

    public toggleAllRows(): void {
        if (!this.currentLane) return;
        const layout = layoutSignalChainRows(this.currentLane.directSubgraph);
        const allOpen = layout.rows.every(r => this.expandedRowIds.has(r.rowId));
        if (allOpen) {
            this.expandedRowIds.clear();
            this.openFxByNode.clear();
        } else {
            for (const r of layout.rows) this.expandedRowIds.add(r.rowId);
        }
        this.render();
    }

    public updatePlayback(playheadSec: number, durationSec: number, isPlaying: boolean, bpm: number): void {
        this.playheadSec = Math.max(0, playheadSec || 0);
        this.durationSec = Math.max(0, durationSec || 0);
        this.isPlaying = Boolean(isPlaying);
        this.bpm = Math.max(20, bpm || 120);

        if (this.collapsed || this.disposed) return;

        if (this.seqGrids.length > 0) {
            const beatsNow = this.playheadSec / (60 / this.bpm);
            for (const sg of this.seqGrids) {
                const count = sg.stepCells.length;
                if (count <= 0) continue;
                const activeIdx = this.isPlaying
                    ? Math.floor(beatsNow / Math.max(0.0625, sg.stepLength)) % count
                    : -1;
                for (let i = 0; i < count; i++) {
                    sg.stepCells[i].classList.toggle('is-playing', i === activeIdx);
                }
            }
        }

        if (this.arrBars.length > 0) {
            const secPerBar = 4 * (60 / this.bpm);
            for (const ab of this.arrBars) {
                const cycleSec = Math.max(0.25, ab.totalBars * secPerBar);
                const frac = (this.playheadSec % cycleSec) / cycleSec;
                ab.playheadEl.style.left = `${(frac * 100).toFixed(2)}%`;
                ab.playheadEl.style.opacity = this.isPlaying || this.playheadSec > 0 ? '1' : '0';
            }
        }

        if (this.waveformEntries.length > 0) {
            const show = this.durationSec > 0 && (this.isPlaying || this.playheadSec > 0);
            const prog = show ? Math.max(0, Math.min(1, this.playheadSec / this.durationSec)) : 0;
            for (const entry of this.waveformEntries) {
                if (!entry.playheadEl.isConnected) continue;
                if (show) {
                    const w = entry.canvas.clientWidth || 160;
                    entry.playheadEl.style.transform = `translateX(${(prog * w).toFixed(1)}px)`;
                    entry.playheadEl.style.opacity = '1';
                } else {
                    entry.playheadEl.style.opacity = '0';
                }
            }
        }
    }

    public refreshStaticWaveforms(): void {
        const graph = this.callbacks.getGraph();
        if (!graph || this.waveformEntries.length === 0) return;
        for (const entry of this.waveformEntries) {
            if (!entry.canvas.isConnected) continue;
            const liveNode = graph.getNodeById?.(entry.nodeId);
            if (!liveNode) continue;
            drawStaticMiniWaveform(entry.canvas, liveNode, entry.color);
            entry.syncCropOverlay?.();
        }
    }

    // --- FX Chain Mutations (Reorder, Move/Copy Across Nodes, Paste) ---

    private commitNodeChainStructural(node: BaseNode, nextChain: any[]): void {
        const cloned = nextChain.map((m: any) =>
            m && typeof m === 'object' ? { ...m, params: { ...(m.params || {}) } } : m
        );
        node.updateProperty('chain', cloned);
        if (typeof window !== 'undefined' && node.id != null) {
            window.dispatchEvent(new CustomEvent('node-properties-refreshed', { detail: { nodeId: node.id } }));
        }
        this.lastRenderSignature = '';
        this.callbacks.onGraphMutated();
        this.render();
    }

    private handleFxDrop(
        sourceNodeId: number,
        moduleId: string,
        targetNodeId: number,
        targetUserIndex: number | null,
        copyOnly: boolean
    ): void {
        const graph = this.callbacks.getGraph();
        if (!graph) return;
        const srcNode = graph.getNodeById?.(sourceNodeId) as BaseNode | undefined;
        const dstNode = graph.getNodeById?.(targetNodeId) as BaseNode | undefined;
        if (!srcNode || !dstNode) return;

        const srcChain = normalizeNodeChain(srcNode);
        if (sourceNodeId === targetNodeId) {
            if (copyOnly) {
                const found = getUserFxStages(srcChain).find(s => String(s.module.id) === String(moduleId));
                if (!found) return;
                const { nextChain, insertedModule } = pasteFxIntoChain(srcChain, found.module, targetUserIndex);
                if (this.currentLane && targetNodeId === this.currentLane.trackNodeId) {
                    this.openMixerFxId = String(insertedModule.id);
                } else {
                    this.openFxByNode.set(targetNodeId, String(insertedModule.id));
                }
                this.commitNodeChainStructural(dstNode, nextChain);
                return;
            }
            const dstIdx = targetUserIndex ?? Math.max(0, getUserFxStages(srcChain).length - 1);
            const reordered = reorderFxInChain(srcChain, moduleId, dstIdx);
            if (reordered) {
                this.commitNodeChainStructural(srcNode, reordered);
            }
            return;
        }

        const dstChain = normalizeNodeChain(dstNode);
        const res = moveOrCopyFxBetweenChains(srcChain, dstChain, moduleId, targetUserIndex, copyOnly);
        if (!res) return;

        if (!copyOnly) {
            if (this.openFxByNode.get(sourceNodeId) === moduleId) {
                this.openFxByNode.delete(sourceNodeId);
            }
            if (this.currentLane && sourceNodeId === this.currentLane.trackNodeId && this.openMixerFxId === moduleId) {
                this.openMixerFxId = null;
            }
            srcNode.updateProperty('chain', res.nextSourceChain);
        }

        if (this.currentLane && targetNodeId === this.currentLane.trackNodeId) {
            this.openMixerFxId = String(res.insertedModule.id);
        } else {
            this.openFxByNode.set(targetNodeId, String(res.insertedModule.id));
        }
        this.commitNodeChainStructural(dstNode, res.nextTargetChain);
    }

    private pasteFxOnNode(targetNodeId: number, targetUserIndex: number | null): void {
        const clip = getFxClipboard();
        if (!clip) return;
        const graph = this.callbacks.getGraph();
        const dstNode = graph?.getNodeById?.(targetNodeId) as BaseNode | undefined;
        if (!dstNode) return;
        const dstChain = normalizeNodeChain(dstNode);
        const { nextChain, insertedModule } = pasteFxIntoChain(dstChain, clip, targetUserIndex);
        if (this.currentLane && targetNodeId === this.currentLane.trackNodeId) {
            this.openMixerFxId = String(insertedModule.id);
        } else {
            this.openFxByNode.set(targetNodeId, String(insertedModule.id));
        }
        this.commitNodeChainStructural(dstNode, nextChain);
    }

    private showFxContextMenu(
        clientX: number,
        clientY: number,
        node: BaseNode,
        mod: ChainModuleInstance | null,
        chainIndex: number | null
    ): void {
        this.closeContextMenu();
        const menu = document.createElement('div');
        menu.className = 'sin-tl-fx-ctx-menu sin-menu-surface';
        const clip = getFxClipboard();

        const addAction = (label: string, onClick: () => void, danger = false) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = `sin-menu-item${danger ? ' is-danger' : ''}`;
            btn.textContent = label;
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.closeContextMenu();
                onClick();
            });
            menu.appendChild(btn);
        };

        if (mod && chainIndex != null) {
            const targetModId = String(mod.id);
            addAction('Copy FX', () => {
                const latest = normalizeNodeChain(node);
                const liveMod = latest.find(m => String(m?.id) === targetModId) || mod;
                setFxClipboard(liveMod);
                this.render();
            });
            addAction('Duplicate FX', () => {
                const latest = normalizeNodeChain(node);
                const stages = getUserFxStages(latest);
                const sIdx = stages.findIndex(s => String(s.module.id) === targetModId);
                const liveMod = sIdx >= 0 ? stages[sIdx].module : mod;
                const { nextChain } = pasteFxIntoChain(latest, liveMod, sIdx >= 0 ? sIdx + 1 : null);
                this.commitNodeChainStructural(node, nextChain);
            });
            addAction(mod.enabled === false ? 'Enable FX' : 'Bypass FX', () => {
                const latest = normalizeNodeChain(node);
                const nextChain = latest.map(m =>
                    String(m?.id) === targetModId ? { ...m, enabled: m.enabled === false } : m
                );
                this.commitNodeChainStructural(node, nextChain);
            });
        }

        if (clip) {
            addAction(`Paste ${clip.name || clip.type}`, () => {
                this.pasteFxOnNode(Number(node.id), null);
            });
        }

        if (mod && chainIndex != null) {
            const targetModId = String(mod.id);
            addAction('Remove FX', () => {
                const nid = Number(node.id);
                if (this.openFxByNode.get(nid) === targetModId) this.openFxByNode.delete(nid);
                if (this.currentLane && nid === this.currentLane.trackNodeId && this.openMixerFxId === targetModId) {
                    this.openMixerFxId = null;
                }
                const latest = normalizeNodeChain(node);
                this.commitNodeChainStructural(node, latest.filter(m => String(m?.id) !== targetModId));
            }, true);
        }

        if (menu.children.length === 0) return;
        menu.style.position = 'fixed';
        menu.style.left = `${Math.min(window.innerWidth - 170, clientX)}px`;
        menu.style.top = `${Math.min(window.innerHeight - 160, clientY)}px`;
        document.body.appendChild(menu);
        this.activeContextMenu = menu;
    }

    // --- Live SVG Bus Cable Junction Gutter ---

    private scheduleBusCableUpdate(): void {
        if (this.disposed || this.collapsed) return;
        if (this.busCableRaf !== null) return;
        this.busCableRaf = window.requestAnimationFrame(() => {
            this.busCableRaf = null;
            this.updateBusJunctionCables();
        });
    }

    private updateBusJunctionCables(): void {
        if (this.disposed || this.collapsed) return;
        const svg = this.busCablesSvgEl;
        const gutterRect = this.busCablesWrapEl.getBoundingClientRect();
        const w = Math.max(1, Math.round(gutterRect.width));
        const h = Math.max(1, Math.round(gutterRect.height));
        svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
        svg.setAttribute('width', String(w));
        svg.setAttribute('height', String(h));

        const jackEl = this.mixerDockEl.querySelector<HTMLElement>('.sin-mixer-in-jack');
        let targetY = h * 0.5;
        if (jackEl) {
            const jRect = jackEl.getBoundingClientRect();
            targetY = (jRect.top + jRect.height * 0.5) - gutterRect.top;
        }
        targetY = Math.max(10, Math.min(h - 10, targetY));

        const rowEls = this.rowsPaneEl.querySelectorAll<HTMLElement>('.sin-rack-row');
        const paths: string[] = [];

        if (rowEls.length === 0) {
            const emptyHint = this.rowsPaneEl.querySelector<HTMLElement>('.sin-rack-source-hint');
            if (emptyHint) {
                const eRect = emptyHint.getBoundingClientRect();
                const sy = Math.max(12, Math.min(h - 12, (eRect.top + eRect.height * 0.5) - gutterRect.top));
                const color = this.currentLane?.color || '#64748b';
                const c1 = w * 0.45;
                const c2 = w * 0.55;
                paths.push(
                    `<path d="M 0 ${sy.toFixed(1)} C ${c1.toFixed(1)} ${sy.toFixed(1)}, ${c2.toFixed(1)} ${targetY.toFixed(1)}, ${w} ${targetY.toFixed(1)}" stroke="${color}" stroke-width="1.6" stroke-opacity="0.45" stroke-dasharray="4 3" fill="none" />`
                );
            }
        } else {
            rowEls.forEach((rowEl) => {
                const rRect = rowEl.getBoundingClientRect();
                // Skip rows scrolled completely outside visible window with generous margin for smooth curves
                if (rRect.bottom < gutterRect.top - 48 || rRect.top > gutterRect.bottom + 48) return;
                const sy = (rRect.top + rRect.height * 0.5) - gutterRect.top;
                const color = rowEl.style.getPropertyValue('--row-accent').trim() || '#64748b';
                const isDirect = rowEl.dataset.feedsTarget !== 'false';
                const c1 = w * 0.46;
                const c2 = w * 0.54;
                paths.push(
                    `<path d="M 1 ${sy.toFixed(1)} C ${c1.toFixed(1)} ${sy.toFixed(1)}, ${c2.toFixed(1)} ${targetY.toFixed(1)}, ${w - 1} ${targetY.toFixed(1)}" stroke="${color}" stroke-width="1.75" stroke-opacity="${isDirect ? '0.78' : '0.45'}" ${isDirect ? '' : 'stroke-dasharray="3 3"'} fill="none" />`,
                    `<circle cx="2.5" cy="${sy.toFixed(1)}" r="2.6" fill="${color}" />`
                );
            });
            const mixerColor = this.currentLane?.color || '#4f46e5';
            paths.push(`<circle cx="${w - 2.5}" cy="${targetY.toFixed(1)}" r="3.2" fill="${mixerColor}" />`);
        }

        svg.innerHTML = paths.join('');
    }

    // --- Main Render ---

    public render(): void {
        if (this.disposed) return;

        const rowScrolls = new Map<string, number>();
        this.rowsPaneEl.querySelectorAll<HTMLElement>('.sin-rack-row').forEach(el => {
            const rid = el.dataset.rowId;
            const track = el.querySelector<HTMLElement>('.sin-rack-row-track');
            if (rid && track) rowScrolls.set(rid, track.scrollLeft);
        });
        const prevRowsTop = this.rowsPaneEl.scrollTop;

        this.teardownRenderedContents();
        this.rowsPaneEl.replaceChildren();
        this.mixerDockEl.replaceChildren();
        this.busCablesSvgEl.innerHTML = '';

        const lane = this.currentLane;

        if (!lane) {
            this.lastRowsMeta = { rowCount: 0, allExpanded: false };
            this.callbacks.onRowsMetaChanged?.(this.lastRowsMeta);
            this.busCablesWrapEl.classList.add('is-hidden');
            this.mixerDockEl.classList.add('is-hidden');
            const empty = document.createElement('div');
            empty.className = 'sin-tl-mg-empty';
            empty.textContent = 'Select a lane on the left to inspect its upstream chains and Mixer FX strip.';
            this.rowsPaneEl.appendChild(empty);
            return;
        }

        const graph = this.callbacks.getGraph();
        const selectedIds = this.callbacks.getSelectedNodeIds();
        const layout = layoutSignalChainRows(lane.directSubgraph);
        const edgePairs = new Set<string>(lane.directSubgraph.edges.map((e: TimelineMiniGraphEdge) => `${e.fromId}>${e.toId}`));

        // Single upstream row auto-expands cleanly on first view
        if (layout.rows.length === 1 && this.expandedRowIds.size === 0) {
            this.expandedRowIds.add(layout.rows[0].rowId);
        }

        this.lastRowsMeta = {
            rowCount: layout.rows.length,
            allExpanded: layout.rows.length > 0 && layout.rows.every(r => this.expandedRowIds.has(r.rowId)),
        };
        this.callbacks.onRowsMetaChanged?.(this.lastRowsMeta);

        // 1. Left Scrollable Upstream Rows Pane (NEVER includes targetNode!)
        if (layout.rows.length === 0) {
            const hint = document.createElement('div');
            hint.className = 'sin-rack-source-hint';
            hint.innerHTML = `<span class="sin-rack-source-pill">Direct Source</span><span>Controls &amp; vertical FX rack live in the Mixer section on the right →</span>`;
            this.rowsPaneEl.appendChild(hint);
        } else {
            const rowsWrap = document.createElement('div');
            rowsWrap.className = 'sin-rack-rows';
            for (const row of layout.rows) {
                const isExpanded = layout.rows.length === 1 || this.expandedRowIds.has(row.rowId);
                const rowEl = this.buildChainRow(
                    row,
                    layout.numCols,
                    isExpanded,
                    layout.rows.length > 1,
                    graph,
                    selectedIds,
                    edgePairs
                );
                rowsWrap.appendChild(rowEl);
            }
            this.rowsPaneEl.appendChild(rowsWrap);
        }

        // 2. Middle Cable Gutter + 3. Right Pinned DAW Mixer Section (for targetNode)
        this.busCablesWrapEl.classList.remove('is-hidden');
        this.mixerDockEl.classList.remove('is-hidden');
        if (layout.targetNode) {
            const liveTarget = graph?.getNodeById?.(layout.targetNode.id) as BaseNode | undefined;
            this.buildRightMixerDock(layout.targetNode, liveTarget, selectedIds);
        }

        // Restore scroll positions & redraw static waveforms + live SVG cables
        this.rowsPaneEl.scrollTop = prevRowsTop;
        this.rowsPaneEl.querySelectorAll<HTMLElement>('.sin-rack-row').forEach(el => {
            const rid = el.dataset.rowId;
            const track = el.querySelector<HTMLElement>('.sin-rack-row-track');
            if (rid && track && rowScrolls.has(rid)) {
                track.scrollLeft = rowScrolls.get(rid)!;
            }
        });

        const scrollSel = this.pendingScrollSelector;
        this.pendingScrollSelector = null;
        requestAnimationFrame(() => {
            if (this.disposed) return;
            this.refreshStaticWaveforms();
            this.updatePlayback(this.playheadSec, this.durationSec, this.isPlaying, this.bpm);
            this.updateBusJunctionCables();
            if (scrollSel) {
                const targetEl = this.element.querySelector<HTMLElement>(scrollSel);
                targetEl?.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
            }
        });
    }

    // --- Upstream Row & Inter-Card Cables ---

    private buildChainRow(
        row: SignalChainRow,
        numCols: number,
        isExpanded: boolean,
        canToggleRow: boolean,
        graph: any,
        selectedIds: ReadonlySet<number>,
        edgePairs: ReadonlySet<string>
    ): HTMLDivElement {
        const rowEl = document.createElement('div');
        rowEl.className = [
            'sin-rack-row',
            isExpanded ? 'is-expanded' : 'is-collapsed',
        ].join(' ');
        rowEl.dataset.rowId = row.rowId;
        rowEl.dataset.feedsTarget = String(row.feedsTarget);
        rowEl.style.setProperty('--row-accent', row.accentColor);

        const rail = document.createElement('div');
        rail.className = 'sin-rack-row-rail';
        rail.title = canToggleRow
            ? (isExpanded ? 'Click to close row' : 'Click to open row cards')
            : row.title;

        const chevBtn = document.createElement('button');
        chevBtn.type = 'button';
        chevBtn.className = 'sin-rack-row-chev';
        chevBtn.disabled = !canToggleRow;
        chevBtn.innerHTML = renderIcon(isExpanded ? 'chevronDown' : 'chevronRight');

        const railInfo = document.createElement('div');
        railInfo.className = 'sin-rack-row-info';

        const nameEl = document.createElement('span');
        nameEl.className = 'sin-rack-row-name';
        nameEl.textContent = row.title;

        const metaEl = document.createElement('span');
        metaEl.className = 'sin-rack-row-meta';
        metaEl.textContent = `${row.slots.length} ${row.slots.length === 1 ? 'stage' : 'stages'}`;

        railInfo.append(nameEl, metaEl);
        rail.append(chevBtn, railInfo);

        if (canToggleRow) {
            rail.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this.expandedRowIds.has(row.rowId)) {
                    this.expandedRowIds.delete(row.rowId);
                    for (const s of row.slots) this.openFxByNode.delete(s.node.id);
                } else {
                    this.expandedRowIds.add(row.rowId);
                    this.pendingScrollSelector = `[data-row-id="${CSS.escape(row.rowId)}"]`;
                }
                this.render();
            });
        }

        rowEl.appendChild(rail);

        const track = document.createElement('div');
        track.className = 'sin-rack-row-track';

        const slotByCol = new Map<number, TimelineMiniGraphNode>();
        for (const s of row.slots) slotByCol.set(s.col, s.node);
        const totalCols = Math.max(1, numCols);
        const lastOccupiedCol = row.slots.reduce((m, s) => Math.max(m, s.col), -1);

        let prevNode: TimelineMiniGraphNode | null = null;
        for (let col = 0; col < totalCols; col++) {
            const node = slotByCol.get(col);
            if (!node) {
                const hasCarryCable = prevNode !== null && col < lastOccupiedCol;
                const blank = document.createElement('div');
                blank.className = `sin-rack-blank-cell ${isExpanded ? 'is-expanded' : 'is-collapsed'}${hasCarryCable ? ' has-cable' : ''}`;
                blank.setAttribute('aria-hidden', 'true');
                if (hasCarryCable && prevNode) {
                    blank.style.setProperty('--cable-color', prevNode.color);
                }
                track.appendChild(blank);
                continue;
            }

            // Real connection cable between previous node and this node in the row!
            if (prevNode) {
                const isDirectEdge = edgePairs.has(`${prevNode.id}>${node.id}`);
                track.appendChild(createInlineCableSvg(prevNode.color, !isExpanded, isDirectEdge));
            }

            const liveNode = graph?.getNodeById?.(node.id) as BaseNode | undefined;
            if (isExpanded) {
                track.appendChild(this.buildExpandedCardUnit(node, liveNode, selectedIds));
            } else {
                track.appendChild(this.buildCollapsedCardPill(row.rowId, node, liveNode, selectedIds));
            }
            prevNode = node;
        }

        // Trailing cable stub connecting out to the right-side Bus Cable Gutter
        if (prevNode) {
            const tail = document.createElement('div');
            tail.className = 'sin-rack-row-tail-cable';
            tail.style.setProperty('--cable-color', prevNode.color);
            tail.setAttribute('aria-hidden', 'true');
            track.appendChild(tail);
        }

        rowEl.appendChild(track);
        return rowEl;
    }

    // --- Drag-and-Drop Wiring for Card Swapping & Cross-Node FX ---

    private attachCardDragAndDrop(
        dragHandleEl: HTMLElement,
        dropZoneEl: HTMLElement,
        node: TimelineMiniGraphNode
    ): void {
        dragHandleEl.draggable = true;
        dragHandleEl.classList.add('sin-rack-draggable-node');
        dragHandleEl.addEventListener('dragstart', (e: DragEvent) => {
            e.stopPropagation();
            const payload: RackDragPayload = { kind: 'sin-node-card', nodeId: node.id };
            this.activeDragPayload = payload;
            dropZoneEl.classList.add('is-dragging');
            if (e.dataTransfer) {
                e.dataTransfer.effectAllowed = 'move';
                try { e.dataTransfer.setData('application/x-sin-rack', JSON.stringify(payload)); } catch { }
            }
        });
        dragHandleEl.addEventListener('dragend', () => {
            this.activeDragPayload = null;
            dropZoneEl.classList.remove('is-dragging');
            this.clearAllDropIndicators();
        });

        dropZoneEl.addEventListener('dragover', (e: DragEvent) => {
            const payload = this.activeDragPayload;
            if (!payload) return;
            if (payload.kind === 'sin-node-card') {
                if (payload.nodeId === node.id) return;
                const graph = this.callbacks.getGraph();
                const ok = canSwapGraphNodes(graph, payload.nodeId, node.id);
                e.preventDefault();
                e.stopPropagation();
                if (e.dataTransfer) e.dataTransfer.dropEffect = ok ? 'move' : 'none';
                dropZoneEl.classList.toggle('is-drop-swap', ok);
                dropZoneEl.classList.toggle('is-drop-invalid', !ok);
                return;
            }
            if (payload.kind === 'sin-fx-stage' && node.kind !== 'bus_stub') {
                e.preventDefault();
                e.stopPropagation();
                if (e.dataTransfer) e.dataTransfer.dropEffect = (e.altKey || e.ctrlKey) ? 'copy' : 'move';
                dropZoneEl.classList.add('is-drop-fx');
            }
        });

        dropZoneEl.addEventListener('dragleave', (e: DragEvent) => {
            if (!dropZoneEl.contains(e.relatedTarget as Node | null)) {
                dropZoneEl.classList.remove('is-drop-swap', 'is-drop-invalid', 'is-drop-fx');
            }
        });

        dropZoneEl.addEventListener('drop', (e: DragEvent) => {
            const payload = this.activeDragPayload;
            this.clearAllDropIndicators();
            if (!payload) return;
            e.preventDefault();
            e.stopPropagation();
            if (payload.kind === 'sin-node-card' && payload.nodeId !== node.id) {
                this.callbacks.onSwapNodes(payload.nodeId, node.id);
                return;
            }
            if (payload.kind === 'sin-fx-stage' && node.kind !== 'bus_stub') {
                this.handleFxDrop(payload.sourceNodeId, payload.moduleId, node.id, null, e.altKey || e.ctrlKey);
            }
        });
    }

    private attachFxStageDragAndDrop(
        el: HTMLElement,
        nodeId: number,
        moduleId: string,
        stageIndex: number
    ): void {
        el.draggable = true;
        el.addEventListener('dragstart', (e: DragEvent) => {
            e.stopPropagation();
            const payload: RackDragPayload = { kind: 'sin-fx-stage', sourceNodeId: nodeId, moduleId };
            this.activeDragPayload = payload;
            el.classList.add('is-dragging');
            if (e.dataTransfer) {
                e.dataTransfer.effectAllowed = 'copyMove';
                try { e.dataTransfer.setData('application/x-sin-rack', JSON.stringify(payload)); } catch { }
            }
        });
        el.addEventListener('dragend', () => {
            this.activeDragPayload = null;
            el.classList.remove('is-dragging');
            this.clearAllDropIndicators();
        });
        el.addEventListener('dragover', (e: DragEvent) => {
            const payload = this.activeDragPayload;
            if (!payload || payload.kind !== 'sin-fx-stage') return;
            e.preventDefault();
            e.stopPropagation();
            if (e.dataTransfer) e.dataTransfer.dropEffect = (e.altKey || e.ctrlKey) ? 'copy' : 'move';
            el.classList.add('is-drop-fx-slot');
        });
        el.addEventListener('dragleave', () => {
            el.classList.remove('is-drop-fx-slot');
        });
        el.addEventListener('drop', (e: DragEvent) => {
            const payload = this.activeDragPayload;
            this.clearAllDropIndicators();
            if (!payload || payload.kind !== 'sin-fx-stage') return;
            e.preventDefault();
            e.stopPropagation();
            this.handleFxDrop(payload.sourceNodeId, payload.moduleId, nodeId, stageIndex, e.altKey || e.ctrlKey);
        });
    }

    private clearAllDropIndicators(): void {
        this.element.querySelectorAll('.is-drop-swap, .is-drop-invalid, .is-drop-fx, .is-drop-fx-slot, .is-dragging').forEach(el => {
            el.classList.remove('is-drop-swap', 'is-drop-invalid', 'is-drop-fx', 'is-drop-fx-slot', 'is-dragging');
        });
    }

    // --- Collapsed Pill & Expanded Card ---

    private buildCollapsedCardPill(
        rowId: string,
        node: TimelineMiniGraphNode,
        liveNode: BaseNode | undefined,
        selectedIds: ReadonlySet<number>
    ): HTMLDivElement {
        const pill = document.createElement('div');
        pill.className = [
            'sin-rack-pill',
            `is-kind-${node.kind}`,
            selectedIds.has(node.id) ? 'is-selected' : '',
            node.bypassed ? 'is-bypassed' : '',
            node.muted ? 'is-muted' : '',
        ].filter(Boolean).join(' ');
        pill.style.setProperty('--mg-accent', node.color);
        pill.dataset.nodeId = String(node.id);
        pill.title = `${node.title} — click to open row, drag onto another card to swap signal order`;

        const badge = document.createElement('span');
        badge.className = 'sin-tl-mg-badge';
        badge.textContent = node.badgeLabel;

        const title = document.createElement('span');
        title.className = 'sin-rack-pill-title';
        title.textContent = node.title;

        pill.append(badge, title);

        if (node.kind !== 'bus_stub' && liveNode) {
            const fxStages = getUserFxStages(normalizeNodeChain(liveNode));
            if (fxStages.length > 0) {
                const fxWrap = document.createElement('div');
                fxWrap.className = 'sin-rack-pill-fx';
                for (const { module: mod, def, stageIndex } of fxStages.slice(0, 3)) {
                    const fxChip = document.createElement('button');
                    fxChip.type = 'button';
                    fxChip.className = `sin-rack-pill-fx-tag${mod.enabled === false ? ' is-bypassed' : ''}`;
                    fxChip.textContent = mod.name || def.label;
                    fxChip.title = `Open ${mod.name || def.label} FX GUI (drag to move/reorder)`;
                    this.attachFxStageDragAndDrop(fxChip, node.id, String(mod.id), stageIndex);
                    fxChip.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.expandedRowIds.add(rowId);
                        this.openFxByNode.set(node.id, String(mod.id));
                        this.pendingScrollSelector = `[data-drawer-key="fx:${node.id}:${mod.id}"]`;
                        this.callbacks.onSelectNode(node.id, { openInspector: false });
                        this.render();
                    });
                    fxWrap.appendChild(fxChip);
                }
                if (fxStages.length > 3) {
                    const more = document.createElement('span');
                    more.className = 'sin-tl-mg-meta';
                    more.textContent = `+${fxStages.length - 3}`;
                    fxWrap.appendChild(more);
                }
                pill.appendChild(fxWrap);
            }
        }

        const meterTrack = document.createElement('div');
        meterTrack.className = 'sin-tl-mg-meter-track';
        const meterFill = document.createElement('div');
        meterFill.className = 'sin-tl-mg-meter-fill';
        meterTrack.appendChild(meterFill);
        pill.appendChild(meterTrack);
        this.registerMeterEl(node.id, meterFill);

        this.attachCardDragAndDrop(pill, pill, node);

        pill.addEventListener('click', (e) => {
            e.stopPropagation();
            this.expandedRowIds.add(rowId);
            this.pendingScrollSelector = `[data-row-id="${CSS.escape(rowId)}"]`;
            this.callbacks.onSelectNode(node.id, { openInspector: false });
            this.render();
        });

        return pill;
    }

    private buildExpandedCardUnit(
        node: TimelineMiniGraphNode,
        liveNode: BaseNode | undefined,
        selectedIds: ReadonlySet<number>
    ): HTMLDivElement {
        const isSelected = selectedIds.has(node.id);
        const openFxId = this.openFxByNode.get(node.id) ?? null;

        const unit = document.createElement('div');
        unit.className = [
            'sin-tl-card-unit',
            `is-kind-${node.kind}`,
            isSelected ? 'is-selected' : '',
        ].filter(Boolean).join(' ');
        unit.dataset.nodeId = String(node.id);

        const card = document.createElement('div');
        card.className = [
            'sin-tl-mg-card',
            `is-kind-${node.kind}`,
            isSelected ? 'is-selected' : '',
            node.bypassed ? 'is-bypassed' : '',
            node.muted ? 'is-muted' : '',
        ].filter(Boolean).join(' ');
        card.style.setProperty('--mg-accent', node.color);
        card.dataset.nodeId = String(node.id);

        const head = document.createElement('div');
        head.className = 'sin-tl-mg-card-head';
        head.title = `${node.title} — drag header onto another card to swap signal order; double-click to inspect`;

        const badge = document.createElement('span');
        badge.className = 'sin-tl-mg-badge';
        badge.textContent = node.badgeLabel;

        const title = document.createElement('span');
        title.className = 'sin-tl-mg-card-title';
        title.textContent = node.title;

        const headRight = document.createElement('div');
        headRight.className = 'sin-tl-mg-head-actions';

        if (node.kind !== 'bus_stub' && node.slotCount > 1 && typeof (liveNode as any)?.setActiveSlot === 'function') {
            const maxShow = Math.min(node.slotCount, 4);
            for (let i = 0; i < maxShow; i++) {
                const pill = document.createElement('button');
                pill.type = 'button';
                pill.className = `sin-tl-mg-chip${i === node.activeSlot ? ' is-active' : ''}`;
                pill.textContent = String(i);
                pill.title = `Select slot [${i}]`;
                pill.addEventListener('click', (e) => {
                    e.stopPropagation();
                    (liveNode as any).setActiveSlot(i);
                    this.callbacks.onGraphMutated();
                });
                headRight.appendChild(pill);
            }
        }

        if (node.hasPool) {
            const poolBtn = document.createElement('button');
            poolBtn.type = 'button';
            poolBtn.className = 'sin-tl-mg-chip is-mod';
            poolBtn.textContent = node.poolCount > 0 ? `P·${node.poolCount}` : 'POOL';
            poolBtn.title = 'Open Asset Pool tab in Inspector';
            poolBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.callbacks.onSelectNode(node.id, { openInspector: true, initialTab: 'POOL' });
            });
            headRight.appendChild(poolBtn);
        }

        if (node.hasRandom) {
            const rndBtn = document.createElement('button');
            rndBtn.type = 'button';
            rndBtn.className = 'sin-tl-mg-chip is-mod';
            rndBtn.textContent = node.randomCount > 0 ? `R·${node.randomCount}` : 'RND';
            rndBtn.title = 'Inspect Random modifier';
            rndBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const rndMod = (liveNode as any)?.getAttachedRandomModNode?.();
                this.callbacks.onSelectNode(rndMod?.id ?? node.id, { openInspector: true });
            });
            headRight.appendChild(rndBtn);
        }

        if (node.isAudioProcessor) {
            const procBadge = formatProcessorBadge(node.processorState, node.processorProgress, node.bypassed);
            if (procBadge) {
                const pill = document.createElement('span');
                pill.className = `sin-tl-mg-status tone-${procBadge.tone}`;
                pill.textContent = procBadge.text;
                headRight.appendChild(pill);
            }
        }

        head.append(badge, title, headRight);
        card.appendChild(head);

        const body = document.createElement('div');
        body.className = 'sin-tl-mg-card-body';

        if (node.kind === 'bus_stub') {
            this.populateBusStubBody(body, node, liveNode);
        } else if (liveNode) {
            const spec: CompactCardSpec = typeof liveNode.getCompactCardSpec === 'function'
                ? liveNode.getCompactCardSpec()
                : { visualizer: 'bus_meter', paramKeys: [] };
            const visEl = this.buildMainVisualizer(spec.visualizer, node, liveNode);
            if (visEl) body.appendChild(visEl);
        }

        card.appendChild(body);

        const meterTrack = document.createElement('div');
        meterTrack.className = 'sin-tl-mg-meter-track';
        const meterFill = document.createElement('div');
        meterFill.className = 'sin-tl-mg-meter-fill';
        meterTrack.appendChild(meterFill);
        card.appendChild(meterTrack);
        this.registerMeterEl(node.id, meterFill);

        this.attachCardDragAndDrop(head, card, node);

        card.addEventListener('click', (e) => {
            const target = e.target as HTMLElement | null;
            if (target?.closest('button, input, select, .ui-slider, .sin-tl-step-cell, .sin-rack-wave-wrap, .sin-rack-drag-pill')) {
                return;
            }
            e.stopPropagation();
            this.callbacks.onSelectNode(node.id, { openInspector: false });
            this.syncSelectionClasses();
        });

        head.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            if (node.kind === 'bus_stub') {
                this.callbacks.onJumpToTrack(node.id);
                return;
            }
            this.callbacks.onSelectNode(node.id, { openInspector: true });
            this.syncSelectionClasses();
        });

        unit.appendChild(card);

        if (node.kind !== 'bus_stub' && liveNode) {
            const dock = this.buildRightFxDock(node, liveNode, openFxId);
            unit.appendChild(dock);
        }

        return unit;
    }

    // --- Right Pinned DAW Mixer Section (Selected Lane + Vertical FX Opening to the Left!) ---

    private buildRightMixerDock(
        targetNode: TimelineMiniGraphNode,
        liveNode: BaseNode | undefined,
        selectedIds: ReadonlySet<number>
    ): void {
        if (!liveNode) return;
        const chain = normalizeNodeChain(liveNode);
        const preModule = chain[0];
        const postModule = chain[chain.length - 1];
        const userStages = getUserFxStages(chain);

        // 1. Left-Opening Shared FX Drawer (when a vertical DAW FX slot in the Mixer is clicked!)
        if (this.openMixerFxId) {
            const activeStage = userStages.find(s => String(s.module.id) === this.openMixerFxId);
            if (activeStage) {
                const leftDrawer = this.buildInlineFxDrawer(
                    liveNode,
                    chain,
                    activeStage.module,
                    activeStage.def,
                    activeStage.stageIndex,
                    'left',
                    () => {
                        this.openMixerFxId = null;
                        this.render();
                    }
                );
                this.mixerDockEl.appendChild(leftDrawer);
            } else {
                this.openMixerFxId = null;
            }
        }

        // 2. Pinned DAW Mixer Strip
        const isSelected = selectedIds.has(targetNode.id);
        const strip = document.createElement('div');
        strip.className = [
            'sin-rack-mixer-strip',
            isSelected ? 'is-selected' : '',
            targetNode.muted ? 'is-muted' : '',
        ].filter(Boolean).join(' ');
        strip.dataset.nodeId = String(targetNode.id);
        strip.style.setProperty('--mg-accent', targetNode.color);

        // Visual left input jack where SVG bus cables terminate
        const inJack = document.createElement('span');
        inJack.className = 'sin-mixer-in-jack';
        inJack.style.backgroundColor = targetNode.color;
        inJack.setAttribute('aria-hidden', 'true');
        strip.appendChild(inJack);

        // Header: Badge + Name + M/S
        const head = document.createElement('div');
        head.className = 'sin-mixer-head';

        const badge = document.createElement('span');
        badge.className = 'sin-tl-mg-badge';
        badge.textContent = targetNode.badgeLabel;

        const title = document.createElement('span');
        title.className = 'sin-mixer-title';
        title.textContent = targetNode.title;
        title.title = targetNode.title;

        const flags = document.createElement('div');
        flags.className = 'sin-tl-row-flags';

        const muteBtn = document.createElement('button');
        muteBtn.type = 'button';
        muteBtn.className = `sin-tl-flag-btn is-mute${targetNode.muted ? ' is-active' : ''}`;
        muteBtn.textContent = 'M';
        muteBtn.title = targetNode.muted ? 'Unmute' : 'Mute';
        muteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            liveNode.updateProperty('muted', !Boolean(liveNode.properties?.muted));
            this.callbacks.onGraphMutated();
        });
        flags.appendChild(muteBtn);

        if (targetNode.kind === 'track_target') {
            const soloBtn = document.createElement('button');
            soloBtn.type = 'button';
            soloBtn.className = `sin-tl-flag-btn is-solo${targetNode.solo ? ' is-active' : ''}`;
            soloBtn.textContent = 'S';
            soloBtn.title = targetNode.solo ? 'Unsolo' : 'Solo';
            soloBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                liveNode.updateProperty('solo', !Boolean(liveNode.properties?.solo));
                this.callbacks.onGraphMutated();
            });
            flags.appendChild(soloBtn);
        }

        head.append(badge, title, flags);
        strip.appendChild(head);

        // Middle: Compact Main Visualizer / Channel Fader
        const ctrlSection = document.createElement('div');
        ctrlSection.className = 'sin-mixer-controls';

        const spec: CompactCardSpec = typeof liveNode.getCompactCardSpec === 'function'
            ? liveNode.getCompactCardSpec()
            : { visualizer: 'bus_meter', paramKeys: [] };

        if (targetNode.kind === 'track_target' || spec.visualizer === 'bus_meter') {
            const { wrap: waveWrap, canvas, playheadEl } = this.createWaveCanvasWrap();
            waveWrap.classList.add('sin-mixer-wave-wrap');
            ctrlSection.appendChild(waveWrap);
            this.waveformEntries.push({ canvas, playheadEl, nodeId: targetNode.id, color: targetNode.color });

            const gainRow = document.createElement('div');
            gainRow.className = 'sin-tl-card-gain-row';
            const { postDb } = getPrePostGainDb(liveNode.properties?.chain);
            const gainLbl = document.createElement('span');
            gainLbl.className = 'sin-tl-card-param-label';
            gainLbl.textContent = 'Out';

            const volInput = document.createElement('input');
            volInput.type = 'range';
            volInput.min = '-36';
            volInput.max = '12';
            volInput.step = '0.5';
            volInput.value = String(Math.max(-36, Math.min(12, postDb)));
            const volVal = document.createElement('span');
            volVal.className = 'sin-tl-vol-val';
            volVal.textContent = formatDb(postDb).replace(' dB', '');

            volInput.addEventListener('pointerdown', e => e.stopPropagation());
            volInput.addEventListener('input', () => {
                const db = Number(volInput.value);
                volVal.textContent = formatDb(db).replace(' dB', '');
                setNodePostGainDb(liveNode, db);
            });
            const volWrap = document.createElement('div');
            volWrap.className = 'sin-tl-vol-wrap';
            volWrap.appendChild(volInput);
            enhanceRangeSlider(volInput, { defaultValue: 0, compact: true, showValue: false });

            gainRow.append(gainLbl, volWrap, volVal);
            ctrlSection.appendChild(gainRow);
        } else {
            const visEl = this.buildMainVisualizer(spec.visualizer, targetNode, liveNode);
            if (visEl) ctrlSection.appendChild(visEl);
        }

        strip.appendChild(ctrlSection);

        // Bottom: DAW Vertical FX Insert List (clicking any FX opens its shared GUI to the LEFT!)
        const fxSection = document.createElement('div');
        fxSection.className = 'sin-mixer-fx-section';

        const fxHead = document.createElement('div');
        fxHead.className = 'sin-mixer-fx-head';

        const fxLabel = document.createElement('span');
        fxLabel.className = 'sin-mixer-fx-label';
        fxLabel.textContent = `FX (${userStages.length})`;

        const fxHeadBtns = document.createElement('div');
        fxHeadBtns.className = 'sin-mixer-fx-head-btns';

        const clip = getFxClipboard();
        if (clip) {
            const pasteBtn = document.createElement('button');
            pasteBtn.type = 'button';
            pasteBtn.className = 'sin-mixer-mini-btn';
            pasteBtn.title = `Paste ${clip.name || clip.type} into ${targetNode.title}`;
            pasteBtn.innerHTML = renderIcon('clipboard');
            pasteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.pasteFxOnNode(targetNode.id, null);
            });
            fxHeadBtns.appendChild(pasteBtn);
        }

        const addWrap = document.createElement('div');
        addWrap.className = 'sin-mixer-fx-add-wrap';
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'sin-mixer-mini-btn';
        addBtn.title = `Add FX to ${targetNode.title}`;
        addBtn.innerHTML = renderIcon('plus');

        const addMenu = document.createElement('div');
        addMenu.className = 'sin-tl-fx-add-menu sin-menu-surface';
        addMenu.hidden = true;
        for (const procDef of listAddableProcessors()) {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'fx-add-menu-item sin-menu-item';
            item.textContent = procDef.label;
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                addMenu.hidden = true;
                const modId = `${procDef.type}_${Math.random().toString(36).substring(2, 7)}`;
                const newMod = procDef.createModule(modId, procDef.label, { expanded: true, viewMode: 'visual' });
                const latest = normalizeNodeChain(liveNode);
                const latestPre = latest[0] ?? preModule;
                const latestPost = latest[latest.length - 1] ?? postModule;
                const middle = latest.slice(1, -1);
                this.openMixerFxId = modId;
                this.commitNodeChainStructural(liveNode, [latestPre, ...middle, newMod, latestPost]);
            });
            addMenu.appendChild(item);
        }
        addBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const willOpen = addMenu.hidden;
            addMenu.hidden = !willOpen;
            if (willOpen) {
                const rect = addBtn.getBoundingClientRect();
                addMenu.style.position = 'fixed';
                addMenu.style.left = `${Math.max(8, Math.min(window.innerWidth - 160, rect.right - 148))}px`;
                addMenu.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 4)}px`;
                addMenu.style.top = 'auto';
            }
        });
        const closeAdd = (e: Event) => {
            if (!addWrap.contains(e.target as Node)) addMenu.hidden = true;
        };
        document.addEventListener('pointerdown', closeAdd);
        this.cardCleanups.push(() => document.removeEventListener('pointerdown', closeAdd));
        addWrap.append(addBtn, addMenu);

        fxHeadBtns.appendChild(addWrap);
        fxHead.append(fxLabel, fxHeadBtns);
        fxSection.appendChild(fxHead);

        const fxList = document.createElement('div');
        fxList.className = 'sin-mixer-fx-list';

        // Allow dropping any FX stage anywhere onto the Mixer vertical FX list
        fxList.addEventListener('dragover', (e: DragEvent) => {
            if (this.activeDragPayload?.kind !== 'sin-fx-stage') return;
            e.preventDefault();
            e.stopPropagation();
            if (e.dataTransfer) e.dataTransfer.dropEffect = (e.altKey || e.ctrlKey) ? 'copy' : 'move';
            fxList.classList.add('is-drop-fx');
        });
        fxList.addEventListener('dragleave', (e: DragEvent) => {
            if (!fxList.contains(e.relatedTarget as Node | null)) {
                fxList.classList.remove('is-drop-fx');
            }
        });
        fxList.addEventListener('drop', (e: DragEvent) => {
            const payload = this.activeDragPayload;
            this.clearAllDropIndicators();
            if (!payload || payload.kind !== 'sin-fx-stage') return;
            e.preventDefault();
            e.stopPropagation();
            this.handleFxDrop(payload.sourceNodeId, payload.moduleId, targetNode.id, null, e.altKey || e.ctrlKey);
        });
        fxList.addEventListener('contextmenu', (e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            this.showFxContextMenu(e.clientX, e.clientY, liveNode, null, null);
        });

        if (userStages.length === 0) {
            const emptyFx = document.createElement('div');
            emptyFx.className = 'sin-mixer-fx-empty';
            emptyFx.textContent = 'Drop FX or click +';
            fxList.appendChild(emptyFx);
        } else {
            for (const { module: mod, def, stageIndex, chainIndex } of userStages) {
                const isOpen = this.openMixerFxId === String(mod.id);
                const slot = document.createElement('div');
                slot.className = [
                    'sin-mixer-fx-slot',
                    mod.enabled === false ? 'is-bypassed' : '',
                    isOpen ? 'is-open' : '',
                ].filter(Boolean).join(' ');
                slot.title = `${mod.name || def.label} — click to open to the left; drag to reorder or move to another node`;

                const led = document.createElement('button');
                led.type = 'button';
                led.className = `sin-mixer-fx-led${mod.enabled === false ? '' : ' is-active'}`;
                led.title = mod.enabled === false ? 'Enable FX' : 'Bypass FX';
                led.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const latest = normalizeNodeChain(liveNode);
                    const nextChain = latest.map(m =>
                        String(m?.id) === String(mod.id) ? { ...m, enabled: m.enabled === false } : m
                    );
                    this.commitNodeChainStructural(liveNode, nextChain);
                });

                const nameSpan = document.createElement('span');
                nameSpan.className = 'sin-mixer-fx-name';
                nameSpan.textContent = mod.name || def.label;

                const copyBtn = document.createElement('button');
                copyBtn.type = 'button';
                copyBtn.className = 'sin-mixer-slot-act';
                copyBtn.title = `Copy ${mod.name || def.label}`;
                copyBtn.innerHTML = renderIcon('copy');
                copyBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const latest = normalizeNodeChain(liveNode);
                    const liveMod = latest.find(m => String(m?.id) === String(mod.id)) || mod;
                    setFxClipboard(liveMod);
                    this.render();
                });

                const rmBtn = document.createElement('button');
                rmBtn.type = 'button';
                rmBtn.className = 'sin-mixer-slot-act is-danger';
                rmBtn.title = `Remove ${mod.name || def.label}`;
                rmBtn.innerHTML = renderIcon('close');
                rmBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (this.openMixerFxId === String(mod.id)) this.openMixerFxId = null;
                    const latest = normalizeNodeChain(liveNode);
                    this.commitNodeChainStructural(liveNode, latest.filter(m => String(m?.id) !== String(mod.id)));
                });

                slot.append(led, nameSpan, copyBtn, rmBtn);

                this.attachFxStageDragAndDrop(slot, targetNode.id, String(mod.id), stageIndex);

                slot.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.openMixerFxId = isOpen ? null : String(mod.id);
                    this.callbacks.onSelectNode(targetNode.id, { openInspector: false });
                    this.render();
                });
                slot.addEventListener('contextmenu', (e: MouseEvent) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.showFxContextMenu(e.clientX, e.clientY, liveNode, mod, chainIndex);
                });

                fxList.appendChild(slot);
            }
        }

        fxSection.appendChild(fxList);
        strip.appendChild(fxSection);

        // Live RMS meter along bottom of Mixer strip
        const meterTrack = document.createElement('div');
        meterTrack.className = 'sin-tl-mg-meter-track';
        const meterFill = document.createElement('div');
        meterFill.className = 'sin-tl-mg-meter-fill';
        meterTrack.appendChild(meterFill);
        strip.appendChild(meterTrack);
        this.registerMeterEl(targetNode.id, meterFill);

        strip.addEventListener('click', (e) => {
            const target = e.target as HTMLElement | null;
            if (target?.closest('button, input, .ui-slider, .sin-mixer-fx-slot, .sin-rack-wave-wrap, .sin-rack-drag-pill')) return;
            e.stopPropagation();
            this.callbacks.onSelectNode(targetNode.id, { openInspector: false });
            this.syncSelectionClasses();
        });
        head.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            this.callbacks.onSelectNode(targetNode.id, { openInspector: true });
        });

        this.mixerDockEl.appendChild(strip);
    }

    // --- Shared Card Visualizers ---

    private createWaveCanvasWrap(): {
        wrap: HTMLDivElement;
        canvas: HTMLCanvasElement;
        playheadEl: HTMLDivElement;
    } {
        const wrap = document.createElement('div');
        wrap.className = 'sin-rack-wave-wrap';
        const canvas = document.createElement('canvas');
        canvas.className = 'sin-tl-card-wave-canvas';
        const playheadEl = document.createElement('div');
        playheadEl.className = 'sin-rack-wave-playhead';
        wrap.append(canvas, playheadEl);
        return { wrap, canvas, playheadEl };
    }

    private populateBusStubBody(body: HTMLDivElement, node: TimelineMiniGraphNode, liveNode: any): void {
        const stubWrap = document.createElement('div');
        stubWrap.className = 'sin-tl-bus-stub-body';

        const { wrap, canvas, playheadEl } = this.createWaveCanvasWrap();
        stubWrap.appendChild(wrap);
        this.waveformEntries.push({ canvas, playheadEl, nodeId: node.id, color: node.color });

        const infoRow = document.createElement('div');
        infoRow.className = 'sin-tl-bus-stub-row';

        const gainText = document.createElement('span');
        gainText.className = 'sin-tl-mg-meta';
        gainText.textContent = formatDb(node.postGainDb);

        const actions = document.createElement('div');
        actions.className = 'sin-tl-bus-stub-actions';

        if (liveNode) {
            const muteBtn = document.createElement('button');
            muteBtn.type = 'button';
            muteBtn.className = `sin-tl-flag-btn is-mute${node.muted ? ' is-active' : ''}`;
            muteBtn.textContent = 'M';
            muteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                liveNode.updateProperty('muted', !Boolean(liveNode.properties?.muted));
                this.callbacks.onGraphMutated();
            });
            actions.appendChild(muteBtn);
        }

        const openBtn = document.createElement('button');
        openBtn.type = 'button';
        openBtn.className = 'sin-tl-mg-chip is-action';
        openBtn.textContent = 'Open Bus';
        openBtn.title = 'Expand & inspect this sub-bus (keeps parent & siblings visible)';
        openBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.callbacks.onJumpToTrack(node.id);
        });

        actions.append(openBtn);
        infoRow.append(gainText, actions);
        stubWrap.appendChild(infoRow);
        body.appendChild(stubWrap);
    }

    private buildMainVisualizer(
        kind: CompactCardSpec['visualizer'],
        node: TimelineMiniGraphNode,
        liveNode: any
    ): HTMLElement | null {
        const wrap = document.createElement('div');
        wrap.className = `sin-tl-card-vis is-vis-${kind}`;

        if (kind === 'waveform_crop') {
            const { wrap: waveWrap, canvas, playheadEl } = this.createWaveCanvasWrap();
            waveWrap.classList.add('sin-tl-crop-wrap');
            waveWrap.title = 'Drag left/right trim edges to adjust crop_start / crop_end';

            const maskLeft = document.createElement('div');
            maskLeft.className = 'sin-rack-crop-mask is-left';
            const maskRight = document.createElement('div');
            maskRight.className = 'sin-rack-crop-mask is-right';
            const edgeLeft = document.createElement('div');
            edgeLeft.className = 'sin-rack-crop-handle is-left';
            const edgeRight = document.createElement('div');
            edgeRight.className = 'sin-rack-crop-handle is-right';
            waveWrap.append(maskLeft, maskRight, edgeLeft, edgeRight);

            let pendingStart = Number(liveNode.properties?.crop_start ?? 0) || 0;
            let pendingEnd = liveNode.properties?.crop_end != null ? Number(liveNode.properties.crop_end) : 1;
            let dragEdge: 'start' | 'end' | null = null;

            const applyCropCss = (cs: number, ce: number) => {
                const s = Math.max(0, Math.min(0.995, cs));
                const e = Math.max(s + 0.005, Math.min(1, ce));
                maskLeft.style.width = `${(s * 100).toFixed(2)}%`;
                maskRight.style.width = `${((1 - e) * 100).toFixed(2)}%`;
                edgeLeft.style.left = `${(s * 100).toFixed(2)}%`;
                edgeRight.style.left = `${(e * 100).toFixed(2)}%`;
            };

            const syncCropFromNode = () => {
                if (dragEdge) return;
                pendingStart = Number(liveNode.properties?.crop_start ?? 0) || 0;
                pendingEnd = liveNode.properties?.crop_end != null ? Number(liveNode.properties.crop_end) : 1;
                applyCropCss(pendingStart, pendingEnd);
            };
            syncCropFromNode();

            this.waveformEntries.push({
                canvas,
                playheadEl,
                nodeId: node.id,
                color: node.color,
                syncCropOverlay: syncCropFromNode,
            });

            const updateDragFromPointer = (e: PointerEvent) => {
                const rect = waveWrap.getBoundingClientRect();
                if (rect.width <= 0) return;
                const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                if (dragEdge === 'start') {
                    pendingStart = Math.max(0, Math.min(pendingEnd - 0.01, Math.round(ratio * 1000) / 1000));
                } else if (dragEdge === 'end') {
                    pendingEnd = Math.min(1, Math.max(pendingStart + 0.01, Math.round(ratio * 1000) / 1000));
                }
                applyCropCss(pendingStart, pendingEnd);
            };

            waveWrap.addEventListener('pointerdown', (e: PointerEvent) => {
                if (e.button !== 0) return;
                const rect = waveWrap.getBoundingClientRect();
                const ratio = (e.clientX - rect.left) / Math.max(1, rect.width);
                const dStart = Math.abs(ratio - pendingStart);
                const dEnd = Math.abs(ratio - pendingEnd);
                if (Math.min(dStart, dEnd) > 0.16) return;
                e.stopPropagation();
                e.preventDefault();
                dragEdge = dStart <= dEnd ? 'start' : 'end';
                waveWrap.classList.add('is-dragging-crop');
                try { waveWrap.setPointerCapture(e.pointerId); } catch { }
                updateDragFromPointer(e);
            });
            waveWrap.addEventListener('pointermove', (e: PointerEvent) => {
                if (dragEdge) {
                    updateDragFromPointer(e);
                    return;
                }
                const rect = waveWrap.getBoundingClientRect();
                const ratio = (e.clientX - rect.left) / Math.max(1, rect.width);
                waveWrap.style.cursor = Math.min(Math.abs(ratio - pendingStart), Math.abs(ratio - pendingEnd)) <= 0.14
                    ? 'ew-resize'
                    : 'default';
            });
            const finishCropDrag = (e: PointerEvent) => {
                if (!dragEdge) return;
                const edge = dragEdge;
                dragEdge = null;
                waveWrap.classList.remove('is-dragging-crop');
                try { waveWrap.releasePointerCapture(e.pointerId); } catch { }
                if (edge === 'start') {
                    commitNodeScalarProperty(liveNode, 'crop_start', pendingStart, true);
                } else {
                    commitNodeScalarProperty(liveNode, 'crop_end', pendingEnd, true);
                }
                liveNode.syncActiveSlotFromProperties?.();
                this.callbacks.onGraphMutated();
            };
            waveWrap.addEventListener('pointerup', finishCropDrag);
            waveWrap.addEventListener('pointercancel', finishCropDrag);

            wrap.appendChild(waveWrap);

            const foot = document.createElement('div');
            foot.className = 'sin-rack-vis-foot';

            const repeatBtn = document.createElement('button');
            repeatBtn.type = 'button';
            repeatBtn.className = 'sin-rack-vis-btn';
            const syncRepeat = () => {
                const on = Boolean(liveNode.properties?.repeat ?? (liveNode.properties?.sample_type === 'loop'));
                repeatBtn.classList.toggle('is-on', on);
                repeatBtn.textContent = on ? 'Repeat' : 'Once';
            };
            syncRepeat();
            repeatBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const next = !Boolean(liveNode.properties?.repeat ?? (liveNode.properties?.sample_type === 'loop'));
                // SampleNode.updateProperty('repeat', next) canonically updates both repeat & sample_type ('loop'|'one_shot')
                commitNodeScalarProperty(liveNode, 'repeat', next, true);
                syncRepeat();
                this.callbacks.onGraphMutated();
            });

            const warpBtn = document.createElement('button');
            warpBtn.type = 'button';
            warpBtn.className = 'sin-rack-vis-btn';
            const syncWarp = () => {
                const on = Boolean(liveNode.properties?.warp ?? (liveNode.properties?.stretch_mode === 'time_stretch'));
                warpBtn.classList.toggle('is-on', on);
                warpBtn.textContent = on ? 'Warp' : 'Tape';
            };
            syncWarp();
            warpBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const next = !Boolean(liveNode.properties?.warp ?? (liveNode.properties?.stretch_mode === 'time_stretch'));
                // SampleNode.updateProperty('warp', next) canonically updates both warp & stretch_mode ('time_stretch'|'pitch_shift')
                commitNodeScalarProperty(liveNode, 'warp', next, true);
                syncWarp();
                this.callbacks.onGraphMutated();
            });

            const pitchPill = makeInlineDragPill({
                label: 'Pitch',
                min: -24,
                max: 24,
                step: 1,
                defaultValue: 0,
                getValue: () => Number(liveNode.properties?.transpose ?? 0) || 0,
                formatValue: (v) => `${v > 0 ? '+' : ''}${Math.round(v)}st`,
                onChange: (v, committed) => {
                    commitNodeScalarProperty(liveNode, 'transpose', v, committed);
                    if (committed) {
                        liveNode.syncActiveSlotFromProperties?.();
                        this.callbacks.onGraphMutated();
                    }
                },
            });

            this.registerCardVisualSync(node.id, () => {
                syncRepeat();
                syncWarp();
                pitchPill.sync();
            });

            foot.append(repeatBtn, warpBtn, pitchPill.element);
            wrap.appendChild(foot);
            return wrap;
        }

        if (kind === 'sequence_grid') {
            const seq: number[] = Array.isArray(liveNode.properties?.sequence) && liveNode.properties.sequence.length > 0
                ? liveNode.properties.sequence
                : Array(16).fill(0);
            const stepParams: any[] = Array.isArray(liveNode.properties?.step_parameters) ? liveNode.properties.step_parameters : [];
            const gridEl = document.createElement('div');
            gridEl.className = 'sin-tl-mini-seq-grid is-tall';
            gridEl.style.gridTemplateColumns = `repeat(${Math.min(16, Math.max(4, seq.length))}, 1fr)`;

            const stepCells: HTMLButtonElement[] = [];
            const renderSteps = () => {
                gridEl.replaceChildren();
                stepCells.length = 0;
                const currentSeq: number[] = Array.isArray(liveNode.properties?.sequence) ? liveNode.properties.sequence : seq;
                const limit = Math.min(32, currentSeq.length);
                for (let i = 0; i < limit; i++) {
                    const active = Boolean(currentSeq[i]);
                    const rawVel = Number(stepParams[i]?.velocity ?? 1);
                    const vel = Math.max(0.15, Math.min(1, rawVel > 1 ? rawVel / 100 : rawVel));
                    const cell = document.createElement('button');
                    cell.type = 'button';
                    cell.className = `sin-tl-step-cell${active ? ' is-on' : ''}${i % 4 === 0 ? ' is-beat' : ''}`;
                    cell.title = `Step ${i + 1}${active ? ' (On)' : ' (Off)'}`;
                    const bar = document.createElement('span');
                    bar.className = 'sin-tl-step-fill';
                    bar.style.height = active ? `${Math.round(vel * 100)}%` : '0%';
                    cell.appendChild(bar);
                    cell.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const next = [...currentSeq];
                        next[i] = next[i] ? 0 : 1;
                        commitNodeScalarProperty(liveNode, 'sequence', next, true);
                        liveNode.syncActiveSlotFromProperties?.();
                        renderSteps();
                        this.callbacks.onGraphMutated();
                    });
                    stepCells.push(cell);
                    gridEl.appendChild(cell);
                }
            };
            renderSteps();
            this.seqGrids.push({
                nodeId: node.id,
                stepCells,
                stepLength: Math.max(0.0625, Number(liveNode.properties?.step_length) || 0.25),
            });
            this.registerCardVisualSync(node.id, renderSteps);
            wrap.appendChild(gridEl);

            const foot = document.createElement('div');
            foot.className = 'sin-rack-vis-foot';
            const stepLen = Number(liveNode.properties?.step_length || 0.25);
            const divTxt = stepLen > 0 ? `1/${Math.max(1, Math.round(4 / stepLen))}` : '1/16';
            foot.innerHTML = `<span class="sin-rack-mini-tag is-on">${seq.length} steps</span><span class="sin-rack-mini-tag">${divTxt}</span>`;
            wrap.appendChild(foot);
            return wrap;
        }

        if (kind === 'arrangement') {
            const totalBars = Math.max(0.25, Number(liveNode.properties?.total_bars) || 4);
            const structure = typeof liveNode.getSectionStructure === 'function'
                ? liveNode.getSectionStructure()
                : { points: [], probability: [1], slots: ['*'], quant: ['auto'] };
            const boundaries = [0, ...structure.points, totalBars];
            const barEl = document.createElement('div');
            barEl.className = 'sin-tl-mini-arr-bar is-tall';

            for (let i = 0; i < boundaries.length - 1; i++) {
                const span = Math.max(0.1, boundaries[i + 1] - boundaries[i]);
                const prob = Number(structure.probability?.[i] ?? 1);
                const slot = structure.slots?.[i] ?? '*';
                const seg = document.createElement('div');
                seg.className = 'sin-tl-mini-arr-seg';
                seg.style.flex = String(span);
                seg.style.opacity = String(0.3 + prob * 0.7);
                seg.textContent = slot === '*' ? `S${i}` : `S${i}[${slot}]`;
                seg.title = `Section ${i}: ${boundaries[i]}–${boundaries[i + 1]} bars · ${Math.round(prob * 100)}%`;
                barEl.appendChild(seg);
            }

            const playheadEl = document.createElement('div');
            playheadEl.className = 'sin-rack-arr-playhead';
            barEl.appendChild(playheadEl);
            this.arrBars.push({ playheadEl, totalBars });

            wrap.appendChild(barEl);

            const foot = document.createElement('div');
            foot.className = 'sin-rack-vis-foot';
            foot.innerHTML = `<span class="sin-rack-mini-tag is-on">${totalBars} bars</span><span class="sin-rack-mini-tag">${boundaries.length - 1} sections</span>`;
            wrap.appendChild(foot);
            return wrap;
        }

        if (kind === 'preamp') {
            const bar = document.createElement('div');
            bar.className = 'sin-tl-mini-proc-bar';
            this.appendProcessorQuickButtons(bar, liveNode);

            const diffBtn = document.createElement('button');
            diffBtn.type = 'button';
            const syncDiff = () => {
                const isNoiseOnly = String(liveNode.properties?.output_mode || 'denoised') === 'noise_only';
                diffBtn.className = `sin-tl-mg-chip${isNoiseOnly ? ' is-warn' : ''}`;
                diffBtn.textContent = isNoiseOnly ? 'Diff: ON' : 'Diff';
            };
            syncDiff();
            diffBtn.title = 'Listen to removed noise floor only';
            diffBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const next = String(liveNode.properties?.output_mode || 'denoised') === 'noise_only' ? 'denoised' : 'noise_only';
                commitNodeScalarProperty(liveNode, 'output_mode', next);
                if ((window as any).__sinRealtimeTiled && typeof liveNode.emitLiveParam === 'function') {
                    liveNode.emitLiveParam('output_mode', next, true);
                }
                syncDiff();
            });
            bar.appendChild(diffBtn);
            wrap.appendChild(bar);

            const { wrap: waveWrap, canvas, playheadEl } = this.createWaveCanvasWrap();
            wrap.appendChild(waveWrap);
            this.waveformEntries.push({ canvas, playheadEl, nodeId: node.id, color: node.color });

            const foot = document.createElement('div');
            foot.className = 'sin-rack-vis-foot';

            const redPill = makeInlineDragPill({
                label: 'Red',
                min: 0,
                max: 30,
                step: 0.5,
                defaultValue: 12,
                getValue: () => Number(liveNode.properties?.reduction_db ?? 12),
                formatValue: (v) => `-${v.toFixed(1)}dB`,
                onChange: (v, committed) => {
                    commitNodeScalarProperty(liveNode, 'reduction_db', v);
                    if ((window as any).__sinRealtimeTiled && typeof liveNode.emitLiveParam === 'function') {
                        liveNode.emitLiveParam('reduction_db', v, committed);
                    }
                },
            });
            const mixPill = makeInlineDragPill({
                label: 'Mix',
                min: 0,
                max: 1,
                step: 0.01,
                defaultValue: 1,
                getValue: () => Number(liveNode.properties?.mix ?? 1),
                formatValue: (v) => `${Math.round(v * 100)}%`,
                onChange: (v, committed) => {
                    commitNodeScalarProperty(liveNode, 'mix', v);
                    if ((window as any).__sinRealtimeTiled && typeof liveNode.emitLiveParam === 'function') {
                        liveNode.emitLiveParam('mix', v, committed);
                    }
                },
            });

            this.registerCardVisualSync(node.id, () => {
                syncDiff();
                redPill.sync();
                mixPill.sync();
            });

            foot.append(redPill.element, mixPill.element);
            wrap.appendChild(foot);
            return wrap;
        }

        if (kind === 'voice_isolator') {
            const topBar = document.createElement('div');
            topBar.className = 'sin-tl-mini-proc-bar';
            this.appendProcessorQuickButtons(topBar, liveNode);
            wrap.appendChild(topBar);

            const stemsWrap = document.createElement('div');
            stemsWrap.className = 'sin-tl-mini-stems';
            const stems = [
                { id: 'ambience', label: 'AMB', dbKey: 'ambience_db', muteKey: 'mute_ambience', accent: '#f59e0b' },
                { id: 'voice', label: 'VOX', dbKey: 'voice_db', muteKey: 'mute_voice', accent: '#06b6d4' },
                { id: 'reverb', label: 'REV', dbKey: 'reverb_db', muteKey: 'mute_reverb', accent: '#8b5cf6' },
            ] as const;

            for (const st of stems) {
                const row = document.createElement('div');
                row.className = 'sin-tl-mini-stem-row';
                row.style.setProperty('--stem-accent', st.accent);

                const lbl = document.createElement('span');
                lbl.className = 'sin-tl-mini-stem-lbl';
                lbl.textContent = st.label;

                const slider = document.createElement('input');
                slider.type = 'range';
                slider.min = '-60';
                slider.max = '12';
                slider.step = '0.5';
                slider.value = String(Number(liveNode.properties?.[st.dbKey] ?? 0));
                slider.className = 'sin-tl-mini-stem-slider';

                const valEl = document.createElement('span');
                valEl.className = 'sin-tl-mini-stem-val';
                const fmtStem = (v: number) => (v <= -59.9 ? '-∞' : `${v > 0 ? '+' : ''}${v.toFixed(0)}`);
                valEl.textContent = fmtStem(Number(slider.value));

                slider.addEventListener('pointerdown', e => e.stopPropagation());
                slider.addEventListener('input', () => {
                    const v = Number(slider.value);
                    valEl.textContent = fmtStem(v);
                    commitNodeScalarProperty(liveNode, st.dbKey, v);
                    if ((window as any).__sinRealtimeTiled && typeof liveNode.emitLiveParam === 'function') {
                        liveNode.emitLiveParam(st.dbKey, v, false);
                    }
                });
                slider.addEventListener('change', () => {
                    const v = Number(slider.value);
                    if ((window as any).__sinRealtimeTiled && typeof liveNode.emitLiveParam === 'function') {
                        liveNode.emitLiveParam(st.dbKey, v, true);
                    }
                });

                const sliderHost = document.createElement('div');
                sliderHost.className = 'sin-tl-mini-stem-slider-wrap';
                sliderHost.appendChild(slider);
                enhanceRangeSlider(slider, { defaultValue: 0, compact: true, showValue: false });

                const mBtn = document.createElement('button');
                mBtn.type = 'button';
                const syncMute = () => {
                    const isMuted = Boolean(liveNode.properties?.[st.muteKey]);
                    mBtn.className = `sin-tl-flag-btn is-mute${isMuted ? ' is-active' : ''}`;
                };
                syncMute();
                mBtn.textContent = 'M';
                mBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const nextMute = !Boolean(liveNode.properties?.[st.muteKey]);
                    commitNodeScalarProperty(liveNode, st.muteKey, nextMute);
                    if ((window as any).__sinRealtimeTiled && typeof liveNode.emitLiveParam === 'function') {
                        liveNode.emitLiveParam(st.muteKey, nextMute, true);
                    }
                    syncMute();
                });

                this.registerCardVisualSync(node.id, syncMute);
                row.append(lbl, sliderHost, valEl, mBtn);
                stemsWrap.appendChild(row);
            }
            wrap.appendChild(stemsWrap);
            return wrap;
        }

        // Default 'bus_meter'
        const { wrap: waveWrap, canvas, playheadEl } = this.createWaveCanvasWrap();
        wrap.appendChild(waveWrap);
        this.waveformEntries.push({ canvas, playheadEl, nodeId: node.id, color: node.color });

        const gainRow = document.createElement('div');
        gainRow.className = 'sin-tl-card-gain-row';
        const { postDb } = getPrePostGainDb(liveNode.properties?.chain);

        const gainLbl = document.createElement('span');
        gainLbl.className = 'sin-tl-card-param-label';
        gainLbl.textContent = 'Out';

        const volInput = document.createElement('input');
        volInput.type = 'range';
        volInput.min = '-36';
        volInput.max = '12';
        volInput.step = '0.5';
        volInput.value = String(Math.max(-36, Math.min(12, postDb)));
        const volVal = document.createElement('span');
        volVal.className = 'sin-tl-vol-val';
        volVal.textContent = formatDb(postDb).replace(' dB', '');

        volInput.addEventListener('pointerdown', e => e.stopPropagation());
        volInput.addEventListener('input', () => {
            const db = Number(volInput.value);
            volVal.textContent = formatDb(db).replace(' dB', '');
            setNodePostGainDb(liveNode, db);
        });
        const volWrap = document.createElement('div');
        volWrap.className = 'sin-tl-vol-wrap';
        volWrap.appendChild(volInput);
        enhanceRangeSlider(volInput, { defaultValue: 0, compact: true, showValue: false });

        gainRow.append(gainLbl, volWrap, volVal);
        wrap.appendChild(gainRow);
        return wrap;
    }

    private appendProcessorQuickButtons(container: HTMLElement, liveNode: any): void {
        if (typeof liveNode?.getToolbarControls !== 'function') return;
        const controls = liveNode.getToolbarControls() || [];
        for (const ctrl of controls) {
            if (ctrl.kind === 'toggle' && ctrl.id === 'bypass') {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = `sin-tl-mg-chip${ctrl.active ? ' is-warn' : ''}`;
                btn.textContent = ctrl.active ? 'Bypass' : 'On';
                btn.title = ctrl.title || 'Toggle processor bypass';
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    ctrl.onToggle();
                    this.callbacks.onGraphMutated();
                });
                container.appendChild(btn);
            } else if (ctrl.kind === 'button' && (ctrl.id === 'process_now' || ctrl.id === 'cook_full_track')) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'sin-tl-mg-chip is-action';
                btn.textContent = ctrl.id === 'process_now' ? 'Cook' : 'Full';
                btn.title = ctrl.title || ctrl.label;
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    ctrl.onClick();
                });
                container.appendChild(btn);
            }
        }
    }

    // --- Upstream Card Right-Border FX Strips & Shared FX Drawers ---

    private buildRightFxDock(
        node: TimelineMiniGraphNode,
        liveNode: BaseNode,
        openFxId: string | null
    ): HTMLDivElement {
        const dock = document.createElement('div');
        dock.className = 'sin-tl-fx-dock';

        // Allow dropping any FX stage onto the dock to append to this node's chain
        dock.addEventListener('dragover', (e: DragEvent) => {
            if (this.activeDragPayload?.kind !== 'sin-fx-stage') return;
            e.preventDefault();
            e.stopPropagation();
            if (e.dataTransfer) e.dataTransfer.dropEffect = (e.altKey || e.ctrlKey) ? 'copy' : 'move';
            dock.classList.add('is-drop-fx');
        });
        dock.addEventListener('dragleave', (e: DragEvent) => {
            if (!dock.contains(e.relatedTarget as Node | null)) dock.classList.remove('is-drop-fx');
        });
        dock.addEventListener('drop', (e: DragEvent) => {
            const payload = this.activeDragPayload;
            this.clearAllDropIndicators();
            if (!payload || payload.kind !== 'sin-fx-stage') return;
            e.preventDefault();
            e.stopPropagation();
            this.handleFxDrop(payload.sourceNodeId, payload.moduleId, node.id, null, e.altKey || e.ctrlKey);
        });
        dock.addEventListener('contextmenu', (e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            this.showFxContextMenu(e.clientX, e.clientY, liveNode, null, null);
        });

        const chain = normalizeNodeChain(liveNode);
        const preModule = chain[0];
        const postModule = chain[chain.length - 1];
        const userStages = getUserFxStages(chain);

        for (const { module: mod, def, stageIndex, chainIndex } of userStages) {
            const fxOpen = openFxId !== null && openFxId === String(mod.id);

            const strip = document.createElement('button');
            strip.type = 'button';
            strip.className = [
                'sin-tl-fx-strip',
                mod.enabled === false ? 'is-bypassed' : '',
                fxOpen ? 'is-open' : '',
            ].filter(Boolean).join(' ');
            strip.title = `${mod.name || def.label} — click for FX GUI; drag to reorder or move across nodes; right-click for copy/paste`;

            const led = document.createElement('span');
            led.className = `sin-tl-fx-strip-led${mod.enabled === false ? '' : ' is-active'}`;
            led.title = mod.enabled === false ? 'Enable FX' : 'Bypass FX';
            led.addEventListener('click', (e) => {
                e.stopPropagation();
                const latest = normalizeNodeChain(liveNode);
                const nextChain = latest.map(m =>
                    String(m?.id) === String(mod.id) ? { ...m, enabled: m.enabled === false } : m
                );
                this.commitNodeChainStructural(liveNode, nextChain);
            });

            const nameSpan = document.createElement('span');
            nameSpan.className = 'sin-tl-fx-strip-name';
            nameSpan.textContent = mod.name || def.label;

            strip.append(led, nameSpan);

            this.attachFxStageDragAndDrop(strip, node.id, String(mod.id), stageIndex);

            strip.addEventListener('click', (e) => {
                e.stopPropagation();
                if (fxOpen) {
                    this.openFxByNode.delete(node.id);
                } else {
                    this.openFxByNode.set(node.id, String(mod.id));
                    this.pendingScrollSelector = `[data-drawer-key="fx:${node.id}:${mod.id}"]`;
                    this.callbacks.onSelectNode(node.id, { openInspector: false });
                }
                this.render();
            });
            strip.addEventListener('contextmenu', (e: MouseEvent) => {
                e.preventDefault();
                e.stopPropagation();
                this.showFxContextMenu(e.clientX, e.clientY, liveNode, mod, chainIndex);
            });
            dock.appendChild(strip);

            if (fxOpen) {
                const drawer = this.buildInlineFxDrawer(
                    liveNode,
                    chain,
                    mod as ChainModuleInstance,
                    def,
                    stageIndex,
                    'right',
                    () => {
                        this.openFxByNode.delete(node.id);
                        this.render();
                    }
                );
                dock.appendChild(drawer);
            }
        }

        // Optional compact Paste FX strip when clipboard has an FX
        const clip = getFxClipboard();
        if (clip) {
            const pasteStrip = document.createElement('button');
            pasteStrip.type = 'button';
            pasteStrip.className = 'sin-tl-fx-paste-strip';
            pasteStrip.title = `Paste ${clip.name || clip.type} onto ${node.title}`;
            pasteStrip.innerHTML = renderIcon('clipboard');
            pasteStrip.addEventListener('click', (e) => {
                e.stopPropagation();
                this.pasteFxOnNode(node.id, null);
            });
            dock.appendChild(pasteStrip);
        }

        // '+' border strip to add FX directly
        const addWrap = document.createElement('div');
        addWrap.className = 'sin-tl-fx-add-wrap';

        const addStrip = document.createElement('button');
        addStrip.type = 'button';
        addStrip.className = 'sin-tl-fx-add-strip';
        addStrip.title = `Add FX to ${node.title}`;
        addStrip.innerHTML = renderIcon('plus');

        const addMenu = document.createElement('div');
        addMenu.className = 'sin-tl-fx-add-menu sin-menu-surface';
        addMenu.hidden = true;

        for (const procDef of listAddableProcessors()) {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'fx-add-menu-item sin-menu-item';
            item.textContent = procDef.label;
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                addMenu.hidden = true;
                const modId = `${procDef.type}_${Math.random().toString(36).substring(2, 7)}`;
                const newMod = procDef.createModule(modId, procDef.label, { expanded: true, viewMode: 'visual' });
                const latest = normalizeNodeChain(liveNode);
                const latestPre = latest[0] ?? preModule;
                const latestPost = latest[latest.length - 1] ?? postModule;
                const middle = latest.slice(1, -1);
                this.openFxByNode.set(node.id, modId);
                this.pendingScrollSelector = `[data-drawer-key="fx:${node.id}:${modId}"]`;
                this.commitNodeChainStructural(liveNode, [latestPre, ...middle, newMod, latestPost]);
            });
            addMenu.appendChild(item);
        }

        addStrip.addEventListener('click', (e) => {
            e.stopPropagation();
            const willOpen = addMenu.hidden;
            addMenu.hidden = !willOpen;
            if (willOpen) {
                const rect = addStrip.getBoundingClientRect();
                addMenu.style.position = 'fixed';
                addMenu.style.left = `${Math.min(window.innerWidth - 160, rect.right + 4)}px`;
                addMenu.style.bottom = `${Math.max(8, window.innerHeight - rect.bottom)}px`;
                addMenu.style.top = 'auto';
            }
        });

        const closeAddMenu = (e: Event) => {
            if (!addWrap.contains(e.target as Node)) {
                addMenu.hidden = true;
            }
        };
        document.addEventListener('pointerdown', closeAddMenu);
        this.cardCleanups.push(() => document.removeEventListener('pointerdown', closeAddMenu));

        addWrap.append(addStrip, addMenu);
        dock.appendChild(addWrap);

        return dock;
    }

    private buildInlineFxDrawer(
        liveNode: BaseNode,
        chain: any[],
        mod: ChainModuleInstance,
        def: DspProcessorDef,
        stageIndex: number,
        side: 'right' | 'left',
        onClose: () => void
    ): HTMLDivElement {
        const drawer = document.createElement('div');
        drawer.className = [
            'sin-tl-fx-drawer',
            side === 'left' ? 'is-mixer-left' : '',
            mod.enabled === false ? 'is-bypassed' : '',
        ].filter(Boolean).join(' ');
        drawer.dataset.drawerKey = `fx:${liveNode.id}:${mod.id}`;
        drawer.addEventListener('click', (e) => e.stopPropagation());

        const head = document.createElement('div');
        head.className = 'sin-tl-fx-drawer-head';

        const bypassBtn = document.createElement('button');
        bypassBtn.type = 'button';
        bypassBtn.className = `fx-bypass-btn ${mod.enabled === false ? '' : 'is-active'}`;
        bypassBtn.title = mod.enabled === false ? 'Enable FX' : 'Bypass FX';
        bypassBtn.innerHTML = '<span class="fx-bypass-dot"></span>';
        bypassBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const latest = normalizeNodeChain(liveNode);
            const nextChain = latest.map(m =>
                String(m?.id) === String(mod.id) ? { ...m, enabled: m.enabled === false } : m
            );
            this.commitNodeChainStructural(liveNode, nextChain);
        });

        const nameEl = document.createElement('span');
        nameEl.className = 'sin-tl-fx-drawer-title';
        nameEl.textContent = mod.name || def.label;

        const actions = document.createElement('div');
        actions.className = 'sin-tl-fx-drawer-actions';

        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'fx-icon-btn';
        copyBtn.title = `Copy ${mod.name || def.label} FX`;
        copyBtn.innerHTML = renderIcon('copy');
        copyBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const latest = normalizeNodeChain(liveNode);
            const liveMod = latest.find(m => String(m?.id) === String(mod.id)) || mod;
            setFxClipboard(liveMod);
            this.render();
        });

        const inspBtn = document.createElement('button');
        inspBtn.type = 'button';
        inspBtn.className = 'fx-icon-btn';
        inspBtn.title = 'Open full FX Chain in Inspector Panel';
        inspBtn.innerHTML = renderIcon('inspector');
        inspBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.callbacks.onSelectNode(Number(liveNode.id), { openInspector: true, initialTab: 'CHAIN' });
        });

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'fx-icon-btn fx-remove-btn';
        removeBtn.title = 'Remove FX';
        removeBtn.innerHTML = renderIcon('close');
        removeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (side === 'left') {
                this.openMixerFxId = null;
            } else {
                this.openFxByNode.delete(Number(liveNode.id));
            }
            const latest = normalizeNodeChain(liveNode);
            this.commitNodeChainStructural(liveNode, latest.filter(m => String(m?.id) !== String(mod.id)));
        });

        const collapseBtn = document.createElement('button');
        collapseBtn.type = 'button';
        collapseBtn.className = 'fx-icon-btn';
        collapseBtn.title = 'Collapse FX GUI';
        collapseBtn.innerHTML = renderIcon(side === 'left' ? 'arrowRight' : 'arrowLeft');
        collapseBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            onClose();
        });

        actions.append(copyBtn, inspBtn, removeBtn, collapseBtn);
        head.append(bypassBtn, nameEl, actions);
        drawer.appendChild(head);

        const body = document.createElement('div');
        body.className = 'sin-tl-fx-drawer-body';

        // Use a decoupled working copy so FxVisualWidgets never mutates liveNode.properties.chain in place
        const workingMod: ChainModuleInstance = {
            ...mod,
            params: { ...(mod.params || {}) },
        };
        const handle = createFxVisualWidget({
            node: liveNode,
            module: workingMod,
            def,
            onParamChange: (paramKey, value) => {
                workingMod.params = { ...(workingMod.params || {}), [paramKey]: value };
                const liveChain = Array.isArray(liveNode.properties?.chain) ? liveNode.properties.chain : chain;
                const nextChain = liveChain.map((m: any) => {
                    if (!m || typeof m !== 'object') return m;
                    if (String(m.id) === String(mod.id)) {
                        return { ...m, params: { ...(m.params || {}), [paramKey]: value } };
                    }
                    return { ...m, params: { ...(m.params || {}) } };
                });
                liveNode.updateProperty('chain', nextChain);
            },
        });
        if (handle) {
            this.activeFxVisuals.push({
                nodeId: Number(liveNode.id),
                stageIndex,
                handle,
            });
            body.appendChild(handle.element);
        }

        drawer.appendChild(body);
        return drawer;
    }

    public syncSelectionClasses(): void {
        const selectedIds = this.callbacks.getSelectedNodeIds();
        this.element.querySelectorAll<HTMLElement>('.sin-tl-card-unit, .sin-rack-pill, .sin-rack-mixer-strip').forEach((el) => {
            const nid = Number(el.dataset.nodeId);
            const active = selectedIds.has(nid);
            el.classList.toggle('is-selected', active);
            const card = el.querySelector<HTMLElement>('.sin-tl-mg-card');
            card?.classList.toggle('is-selected', active);
        });
    }

    public updateMeters(
        busRms: Record<string, number> | null | undefined,
        busPeaks: Record<string, number> | null | undefined
    ): void {
        if (this.collapsed || this.meterEls.size === 0) return;
        for (const [nodeId, els] of this.meterEls.entries()) {
            const key = String(nodeId);
            const rms = Number(busRms?.[key] ?? 0);
            const peak = Number(busPeaks?.[key] ?? rms);
            const level = Math.max(0, Math.min(1, Math.pow(Math.max(rms, peak * 0.72), 0.55)));
            const pct = `${Math.round(level * 100)}%`;
            const clip = peak >= 0.99;
            for (const fillEl of els) {
                fillEl.style.width = pct;
                fillEl.classList.toggle('is-clipping', clip);
            }
        }
    }

    public dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        if (this.busCableRaf !== null) {
            window.cancelAnimationFrame(this.busCableRaf);
            this.busCableRaf = null;
        }
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        this.teardownRenderedContents();
        window.removeEventListener('pointermove', this.handlePointerMove);
        window.removeEventListener('pointerup', this.handlePointerUp);
        window.removeEventListener('sin-stage-meters', this.handleStageMeters);
        window.removeEventListener('sin-peaks-updated', this.handlePeaksUpdated);
        document.removeEventListener('pointerdown', this.handleGlobalPointerDown);
        this.element.remove();
    }
}
