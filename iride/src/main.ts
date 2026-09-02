import './style.css';
import '../../gaia/static/menu-system.css';
import { DockviewComponent, type IDockviewPanel } from 'dockview-core';
import { LGraph, LGraphCanvas, LiteGraph } from 'litegraph.js';
import './nodes/TrackNode';
import './nodes/SampleNode';
import './nodes/SequenceNode';
import './nodes/ArrangementNode';
import './nodes/ModulatorNode';
import './nodes/AssetFilterNode';
import './nodes/DisabledNode';
import { PropertiesWindow } from './ui/PropertiesWindow';
import { NodePopupMenu } from './ui/NodePopupMenu';
import { NodeContextMenu } from './ui/NodeContextMenu';
import { isLibraryPreviewEnabled, LibraryPanel, setLibraryPreviewEnabled } from './ui/LibraryPanel';
import { MasterWaveform } from './ui/MasterWaveform';
import { RuntimeLogPanel } from './ui/RuntimeLogPanel';
import { getParameterWheelStep, registerParameterWheelControl } from './ui/ParameterWheelMenu';
import { appendServerRuntimeLog, installFetchLogging, loggedTask, runtimeLog } from './runtimeLog';
import { attachGhostProperties, createGhostNode, detachGhostDependents, isGhostNode, syncGhostTrackData } from './ghosts';
import { installSeparatedNodeClipboard } from './nodeClipboard';
import { fetchLibrary, findLibraryFile, findLibraryFileById, findLibraryFileForPoolLocator, refreshLibraryAssetSnapshot, resolveLibraryAssets, type LibraryFile } from './api';
import { serializeNodeSubtree } from '../../ermes/ts/serializer';
import { advanceAssetPoolSeed, normalizeAssetRefreshMode, resolveAssetFilterNode, resolveAssignedAssetFilters } from '../../ermes/ts/assetResolver';

const appElement = document.getElementById('app');
if (!appElement) throw new Error('Could not find #app element');

appElement.className = 'dockview-theme-light';
installFetchLogging();

// Instantiate Node Type Popup Menu & Node Context Menu
const popupMenu = new NodePopupMenu();
const nodeContextMenu = new NodeContextMenu();

// --- Top Header Toolbar UI ---
const topHeader = document.createElement('header');
topHeader.className = 'top-header';
topHeader.innerHTML = `
    <div class="top-header-left">
        <div class="header-menus">
            <details class="header-menu" id="file-menu">
                <summary>File</summary>
                <div class="header-menu-popover sin-menu-surface">
                    <button id="new-stage-btn" class="header-menu-action sin-menu-item">New</button>
                    <div class="header-menu-separator sin-menu-divider"></div>
                    <label class="header-menu-label" for="workspace-preset-select">Workspace</label>
                    <select id="workspace-preset-select" class="header-select workspace-preset-select sin-select" aria-label="Workspace preset">
                        <option value="">No saved workspaces</option>
                    </select>
                    <div class="header-menu-row">
                        <button id="save-workspace-as-btn" class="header-btn secondary-tool-btn sin-menu-item">Save workspace as</button>
                        <button id="save-workspace-btn" class="header-btn secondary-tool-btn sin-menu-item" disabled>Save workspace</button>
                    </div>
                    <div class="header-menu-row">
                        <button id="load-workspace-btn" class="header-btn secondary-tool-btn sin-menu-item" disabled>Load workspace</button>
                        <button id="delete-workspace-btn" class="header-btn secondary-tool-btn sin-menu-item" disabled>Delete workspace</button>
                    </div>
                    <div class="header-menu-separator sin-menu-divider"></div>
                    <button id="export-btn" class="header-menu-action sin-menu-item">Download selected audio</button>
                </div>
            </details>
            <details class="header-menu" id="library-menu">
                <summary>Library</summary>
                <div class="header-menu-popover sin-menu-surface">
                    <button id="toggle-library-btn" class="header-menu-action sin-menu-item">Open Library</button>
                    <button id="toggle-library-preview-btn" class="header-menu-action sin-menu-item" aria-pressed="true">Auto-preview: On</button>
                    <div class="header-menu-hint">Library management stays in GAIA.</div>
                </div>
            </details>
        </div>
        <button id="header-toggle-library" class="header-btn secondary-tool-btn icon-header-btn" title="Toggle Library Panel (Shortcut: L)" aria-label="Toggle Library Panel">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 6.5h6l2 2h9v10h-17z"/></svg>
        </button>
    </div>
    <div class="top-header-center">
        <div class="global-parameter-fields" aria-label="Global track parameters">
            <label class="global-parameter-field">BPM
                <input id="global-bpm-input" type="number" min="20" max="300" step="1" value="120" aria-label="Global BPM">
            </label>
            <label class="global-parameter-field">Length
                <input id="global-total-bars-input" type="number" min="0.25" max="128" step="0.25" value="4" aria-label="Global total length in bars">
            </label>
            <label class="global-parameter-field">Key
                <input id="global-key-input" type="text" value="C" maxlength="8" spellcheck="false" aria-label="Global musical key">
            </label>
        </div>
        <button id="global-preview-btn" class="header-btn global-preview-btn icon-header-btn" title="Preview the main graph output" aria-label="Preview the main graph output" disabled>
            <span class="btn-icon" aria-hidden="true">▶</span>
        </button>
        <button id="preview-recalculate-btn" class="header-btn preview-recalculate-btn icon-header-btn" title="Recalculate the current preview without refreshing modifiers" aria-label="Recalculate the current preview without refreshing modifiers" disabled>
            <span class="btn-icon" aria-hidden="true">↻</span>
        </button>
    </div>
    <div class="top-header-right">
        <button id="header-toggle-properties" class="header-btn secondary-tool-btn icon-header-btn" title="Toggle Properties / Inspector (Shortcut: P)" aria-label="Toggle Properties / Inspector">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10m4 0h2M4 17h2m4 0h10M14 4v6M6 14v6"/><circle cx="14" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></svg>
        </button>
    </div>
`;

const playbackFooter = document.createElement('footer');
playbackFooter.className = 'playback-footer';
playbackFooter.setAttribute('aria-label', 'Playback transport');
playbackFooter.innerHTML = `
    <div class="playback-toolbar">
        <div class="render-select-wrapper">
            <select id="temp-files-select" class="playback-track-select sin-select" aria-label="Playback track">
                <option value="" disabled selected>No renders available</option>
            </select>
        </div>
        <div class="master-player-wrapper">
            <audio id="master-player" preload="metadata"></audio>
            <button id="master-play-btn" class="master-control-btn" type="button" aria-label="Play" title="Play" disabled>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10-6.5z"/></svg>
            </button>
        </div>
        <div id="master-waveform" class="master-waveform" title="Click or drag to seek"></div>
        <div class="master-volume-control">
            <button id="master-mute-btn" class="master-control-btn master-volume-btn" type="button" aria-label="Mute" title="Mute">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4zm11.5-.5v7a4 4 0 0 0 0-7z"/></svg>
            </button>
            <input id="master-volume" class="master-volume-slider" type="range" min="0" max="1" step="0.01" value="1" aria-label="Volume">
        </div>
    </div>
`;

const dockviewContainer = document.createElement('div');
dockviewContainer.className = 'dockview-container';

appElement.appendChild(topHeader);
appElement.appendChild(dockviewContainer);
appElement.appendChild(playbackFooter);

// Strictly prevent floating panels from being dragged or positioned higher than y = 0 (under or past the header)
const clampFloatingPanels = () => {
    const elements = dockviewContainer.querySelectorAll<HTMLElement>('.dv-floating-group, .dv-resize-container');
    elements.forEach(el => {
        const topVal = parseFloat(el.style.top);
        if (!isNaN(topVal) && topVal < 0) {
            el.style.top = '0px';
        }
    });
};

let floatingClampFrame: number | null = null;
const scheduleFloatingPanelClamp = () => {
    if (floatingClampFrame !== null) return;
    floatingClampFrame = requestAnimationFrame(() => {
        floatingClampFrame = null;
        clampFloatingPanels();
    });
};

const floatingObserver = new MutationObserver(() => {
    scheduleFloatingPanelClamp();
});

floatingObserver.observe(dockviewContainer, {
    childList: true,
    subtree: true
});

window.addEventListener('pointermove', scheduleFloatingPanelClamp, { passive: true });

const tempFilesSelect = playbackFooter.querySelector('#temp-files-select') as HTMLSelectElement;
const masterPlayer = playbackFooter.querySelector('#master-player') as HTMLAudioElement;
const masterPlayBtn = playbackFooter.querySelector('#master-play-btn') as HTMLButtonElement;
const masterMuteBtn = playbackFooter.querySelector('#master-mute-btn') as HTMLButtonElement;
const masterVolume = playbackFooter.querySelector('#master-volume') as HTMLInputElement;
const exportBtn = topHeader.querySelector('#export-btn') as HTMLButtonElement;
const globalPreviewBtn = topHeader.querySelector('#global-preview-btn') as HTMLButtonElement;
const previewRecalculateBtn = topHeader.querySelector('#preview-recalculate-btn') as HTMLButtonElement;
const toggleLibraryBtn = topHeader.querySelector('#toggle-library-btn') as HTMLButtonElement;
const toggleLibraryPreviewBtn = topHeader.querySelector('#toggle-library-preview-btn') as HTMLButtonElement;
const headerToggleLibrary = topHeader.querySelector('#header-toggle-library') as HTMLButtonElement;
const headerToggleProperties = topHeader.querySelector('#header-toggle-properties') as HTMLButtonElement;
const fileMenu = topHeader.querySelector('#file-menu') as HTMLDetailsElement;
const libraryMenu = topHeader.querySelector('#library-menu') as HTMLDetailsElement;
const newStageBtn = topHeader.querySelector('#new-stage-btn') as HTMLButtonElement;
const masterWaveformElement = playbackFooter.querySelector('#master-waveform') as HTMLDivElement;
const workspacePresetSelect = topHeader.querySelector('#workspace-preset-select') as HTMLSelectElement;
const saveWorkspaceAsBtn = topHeader.querySelector('#save-workspace-as-btn') as HTMLButtonElement;
const saveWorkspaceBtn = topHeader.querySelector('#save-workspace-btn') as HTMLButtonElement;
const loadWorkspaceBtn = topHeader.querySelector('#load-workspace-btn') as HTMLButtonElement;
const deleteWorkspaceBtn = topHeader.querySelector('#delete-workspace-btn') as HTMLButtonElement;
const globalBpmInput = topHeader.querySelector('#global-bpm-input') as HTMLInputElement;
const globalTotalBarsInput = topHeader.querySelector('#global-total-bars-input') as HTMLInputElement;
const globalKeyInput = topHeader.querySelector('#global-key-input') as HTMLInputElement;

const WORKSPACE_PRESET_VERSION = 2;
type GlobalParameters = { bpm: number; total_bars: number; key: string };
const DEFAULT_GLOBAL_PARAMETERS: GlobalParameters = { bpm: 120, total_bars: 4, key: 'C' };
let globalParameters: GlobalParameters = { ...DEFAULT_GLOBAL_PARAMETERS };

function clampGlobalParameter(key: 'bpm' | 'total_bars', rawValue: unknown): number {
    const value = Number(rawValue);
    const fallback = DEFAULT_GLOBAL_PARAMETERS[key];
    if (!Number.isFinite(value)) return fallback;
    return key === 'bpm'
        ? Math.max(20, Math.min(300, value))
        : Math.max(0.25, Math.min(128, value));
}

function writeGlobalParametersToGraph(graph?: LGraph) {
    const targetGraph = graph || ((window as any).editorGraph as LGraph);
    if (!targetGraph) return;
    const graphWithExtra = targetGraph as any;
    if (!graphWithExtra.extra) graphWithExtra.extra = {};
    graphWithExtra.extra.global_parameters = { ...globalParameters };
}

function setGlobalParameters(values: Partial<GlobalParameters>, graph?: LGraph) {
    const requestedKey = String(values.key ?? globalParameters.key).trim();
    globalParameters = {
        bpm: clampGlobalParameter('bpm', values.bpm ?? globalParameters.bpm),
        total_bars: clampGlobalParameter('total_bars', values.total_bars ?? globalParameters.total_bars),
        key: requestedKey || DEFAULT_GLOBAL_PARAMETERS.key
    };
    globalBpmInput.value = String(globalParameters.bpm);
    globalTotalBarsInput.value = String(globalParameters.total_bars);
    globalKeyInput.value = globalParameters.key;
    writeGlobalParametersToGraph(graph);
    syncGraphHierarchy(graph);
    const targetGraph = graph || ((window as any).editorGraph as LGraph);
    for (const node of (((targetGraph as any)?._nodes || []) as any[])) {
        node?.onGlobalParametersChanged?.({ ...globalParameters });
    }
    window.dispatchEvent(new CustomEvent('global-parameters-changed', { detail: { ...globalParameters } }));
    (window as any).editorCanvas?.setDirty?.(true, true);
}

function loadGlobalParametersFromGraph(graph: LGraph) {
    const saved = (graph as any).extra?.global_parameters || DEFAULT_GLOBAL_PARAMETERS;
    setGlobalParameters(saved, graph);
}

(window as any).getGlobalParameter = (key: keyof GlobalParameters) => globalParameters[key];
(window as any).setGlobalParameters = (values: Partial<GlobalParameters>, graph?: LGraph) => setGlobalParameters(values, graph);

globalBpmInput.addEventListener('change', () => setGlobalParameters({ bpm: globalBpmInput.valueAsNumber }));
globalTotalBarsInput.addEventListener('change', () => setGlobalParameters({ total_bars: globalTotalBarsInput.valueAsNumber }));
globalKeyInput.addEventListener('change', () => setGlobalParameters({ key: globalKeyInput.value }));

function bindGlobalParameterWheel(
    input: HTMLInputElement,
    key: 'bpm' | 'total_bars',
    isInteger = false
) {
    registerParameterWheelControl(input);
    input.addEventListener('wheel', event => {
        event.preventDefault();
        if (event.altKey) return;
        const direction = event.deltaY < 0 ? 1 : -1;
        const current = globalParameters[key];
        const next = Math.round((current + direction * getParameterWheelStep(isInteger)) * 100) / 100;
        setGlobalParameters({ [key]: next });
    }, { passive: false });
}

bindGlobalParameterWheel(globalBpmInput, 'bpm', true);
bindGlobalParameterWheel(globalTotalBarsInput, 'total_bars');

const playIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10-6.5z"/></svg>';
const pauseIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zm6 0h4v14h-4z"/></svg>';
const volumeIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4zm11.5-.5v7a4 4 0 0 0 0-7z"/></svg>';
const mutedIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4zm11.5 1 2 2 2-2 1.5 1.5-2 2 2 2-1.5 1.5-2-2-2 2-1.5-1.5 2-2-2-2z"/></svg>';

function updatePlaybackControls() {
    const isPlaying = !masterPlayer.paused && !masterPlayer.ended;
    masterPlayBtn.innerHTML = isPlaying ? pauseIcon : playIcon;
    masterPlayBtn.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
    masterPlayBtn.title = isPlaying ? 'Pause' : 'Play';
    const isMuted = masterPlayer.muted || masterPlayer.volume === 0;
    masterMuteBtn.innerHTML = isMuted ? mutedIcon : volumeIcon;
    masterMuteBtn.setAttribute('aria-label', isMuted ? 'Unmute' : 'Mute');
    masterMuteBtn.title = isMuted ? 'Unmute' : 'Mute';
}

function updatePlaybackTrackPresentation() {
    tempFilesSelect.classList.toggle('is-ram-preview', tempFilesSelect.value === 'RAM_PREVIEW');
}

let pendingMasterSeek: number | null = null;

const masterWaveform = new MasterWaveform(masterWaveformElement, (progress) => {
    const duration = Number.isFinite(masterPlayer.duration) && masterPlayer.duration > 0
        ? masterPlayer.duration
        : masterWaveform.duration;
    if (duration <= 0) return;
    const targetTime = Math.max(0, Math.min(duration, progress * duration));
    pendingMasterSeek = targetTime;
    masterWaveform.setPlayback(targetTime, duration);
    try {
        masterPlayer.currentTime = targetTime;
    } catch (error) {
        pendingMasterSeek = null;
        console.error('Seek failed', error);
    }
});

function setMasterPlayerSource(source: string, autoplay: boolean = false) {
    pendingMasterSeek = null;
    masterPlayer.removeAttribute('aria-disabled');
    // Render filenames and RAM-preview URLs are content-versioned by the
    // backend. Preserving that URL lets the player and waveform request share
    // the browser cache; a timestamp here forced two full transfers.
    masterPlayer.src = source;
    runtimeLog(`Audio stream assigned: ${source}`, 'debug');
    masterPlayBtn.disabled = false;
    masterPlayer.load();
    void masterWaveform.load(masterPlayer.src);
    if (autoplay) masterPlayer.play().catch(error => console.error('Play failed', error));
}

function setPreviewCalculatingState() {
    masterPlayer.pause();
    masterPlayer.removeAttribute('src');
    masterPlayer.load();
    masterPlayer.setAttribute('aria-disabled', 'true');
    masterPlayBtn.disabled = true;
    masterWaveform.clear('Calculating preview...');
    updatePlaybackControls();
}

function setPreviewFailedState() {
    masterPlayer.setAttribute('aria-disabled', 'true');
    masterPlayBtn.disabled = true;
    masterWaveform.clear('Preview failed');
    updatePlaybackControls();
}

masterPlayer.addEventListener('timeupdate', () => {
    if (pendingMasterSeek === null && Number.isFinite(masterPlayer.duration) && masterPlayer.duration > 0) {
        masterWaveform.setPlayback(masterPlayer.currentTime, masterPlayer.duration);
    }
});
masterPlayer.addEventListener('loadedmetadata', () => {
    runtimeLog(`Audio stream metadata loaded (${masterPlayer.duration.toFixed(3)} s)`, 'debug');
    if (pendingMasterSeek !== null) {
        const targetTime = Math.min(pendingMasterSeek, masterPlayer.duration);
        masterPlayer.currentTime = targetTime;
        masterWaveform.setPlayback(targetTime, masterPlayer.duration);
    } else {
        masterWaveform.setPlayback(masterPlayer.currentTime, masterPlayer.duration);
    }
});
masterPlayer.addEventListener('error', () => {
    const code = masterPlayer.error?.code;
    runtimeLog(`Audio stream failed${code ? ` (media error ${code})` : ''}`, 'error');
});
masterPlayer.addEventListener('seeked', () => {
    pendingMasterSeek = null;
    if (Number.isFinite(masterPlayer.duration) && masterPlayer.duration > 0) {
        masterWaveform.setPlayback(masterPlayer.currentTime, masterPlayer.duration);
    }
});
masterPlayer.addEventListener('play', updatePlaybackControls);
masterPlayer.addEventListener('pause', updatePlaybackControls);
masterPlayer.addEventListener('ended', () => {
    masterWaveform.setPlayback(masterPlayer.duration, masterPlayer.duration);
    updatePlaybackControls();
});

masterPlayBtn.addEventListener('click', () => {
    if (masterPlayer.paused) masterPlayer.play().catch(error => console.error('Play failed', error));
    else masterPlayer.pause();
});

masterVolume.addEventListener('input', () => {
    masterPlayer.volume = Number(masterVolume.value);
    masterPlayer.muted = false;
    updatePlaybackControls();
});

masterMuteBtn.addEventListener('click', () => {
    if (masterPlayer.volume === 0) {
        masterPlayer.volume = 0.75;
        masterVolume.value = '0.75';
        masterPlayer.muted = false;
    } else {
        masterPlayer.muted = !masterPlayer.muted;
    }
    updatePlaybackControls();
});

function setWorkspaceButtonMessage(button: HTMLButtonElement, message: string, reset: string) {
    button.textContent = message;
    window.setTimeout(() => { button.textContent = reset; }, 1400);
}

function makeDisabledNodeInfo(nodeInfo: any, reason: string) {
    const originalType = typeof nodeInfo?.type === 'string' ? nodeInfo.type : 'Unknown';
    return {
        ...(nodeInfo || {}),
        type: 'Audio/Disabled',
        title: `Disabled: ${nodeInfo?.title || originalType}`,
        properties: {
            ...(nodeInfo?.properties || {}),
            node_name: `⚠ ${nodeInfo?.properties?.node_name || nodeInfo?.title || originalType}`,
            node_type: 'disabled',
            disabled: true,
            disabled_original_type: originalType,
            disabled_reason: reason
        },
        flags: { ...(nodeInfo?.flags || {}), hidden: false, collapsed: false }
    };
}

function poolAssetLocator(item: any) {
    if (item?.id != null && String(item.id).trim()) return { id: item.id };
    throw new Error('Asset Pool item is missing its GAIA id');
}

function stripResolvedPoolState(graphInfo: any) {
    if (!graphInfo || !Array.isArray(graphInfo.nodes)) return graphInfo;
    const poolsById = new Map<number, any>();

    for (const nodeInfo of graphInfo.nodes) {
        const properties = nodeInfo?.properties || (nodeInfo.properties = {});
        const isPool = nodeInfo?.type === 'Audio/AssetFilter'
            || properties.node_type === 'asset_filter'
            || properties.output_type === 'asset_path';
        if (isPool) poolsById.set(nodeInfo.id, nodeInfo);
    }

    // Migrate the former owner-side Fixed toggle into the pool's Off mode.
    for (const nodeInfo of graphInfo.nodes) {
        const properties = nodeInfo?.properties || {};
        const pool = poolsById.get(properties.asset_modifier_id);
        if (pool && properties.asset_fixed) {
            pool.properties.refresh_mode = 'off';
            if (!pool.properties.fixed_item) {
                pool.properties.fixed_item = poolAssetLocator(properties.locked_asset || {
                    id: properties.library_item_id,
                    absolute_path: properties.filepath,
                    name: properties.node_name,
                    type: properties.sample_type
                });
            }
        }
        delete properties.asset_fixed;
        delete properties.locked_asset;
    }

    for (const nodeInfo of graphInfo.nodes) {
        const properties = nodeInfo?.properties || (nodeInfo.properties = {});
        if (!poolsById.has(nodeInfo.id)) continue;
        properties.refresh_mode = normalizeAssetRefreshMode(properties.refresh_mode);
        const selectedItems = Array.isArray(properties.selected_items) ? properties.selected_items : [];
        if (properties.refresh_mode === 'off') {
            const current = selectedItems.find((item: any) =>
                (item.absolute_path || item.filepath) === properties.output_value
            );
            if (current) properties.fixed_item = poolAssetLocator(current);
            else if (properties.fixed_item) properties.fixed_item = poolAssetLocator(properties.fixed_item);
        } else {
            properties.fixed_item = null;
        }
        properties.selected_items = Array.isArray(properties.selected_items)
            ? properties.selected_items.map(poolAssetLocator)
            : [];
        delete properties.filters;
        // Persist only the pool recipe and lightweight locators. These values
        // are resolved again from GAIA when the workspace is loaded/rendered.
        delete properties.output_value;
        delete properties.output_item_id;
        delete properties.output_bpm;
        delete properties.output_key;
        delete properties.sequence_index;
    }

    for (const nodeInfo of graphInfo.nodes) {
        const properties = nodeInfo?.properties || {};
        if (!poolsById.has(properties.asset_modifier_id)) continue;
        // A pooled owner does not author a concrete asset. The Sample or
        // Sequence node receives the resolved path/metadata at runtime.
        delete properties.filepath;
        delete properties.library_item_id;
        delete properties.duration_seconds;
        delete properties.original_bpm;
        delete properties.key;
    }
    return graphInfo;
}

function prepareWorkspaceGraph(rawGraph: any) {
    if (!rawGraph || typeof rawGraph !== 'object' || !Array.isArray(rawGraph.nodes)) {
        throw new Error('Preset does not contain a valid graph.');
    }

    const graphInfo = stripResolvedPoolState(JSON.parse(JSON.stringify(rawGraph)));
    graphInfo.nodes = graphInfo.nodes.map((nodeInfo: any) => {
        const type = nodeInfo?.type;
        try {
            if (typeof type !== 'string') throw new Error('Node type is missing');
            if (type === 'Audio/Disabled') return nodeInfo;
            const probe = LiteGraph.createNode(type);
            if (!probe) throw new Error(`Node type ${type} is not registered`);
            if (typeof probe.configure === 'function') probe.configure(nodeInfo);
            return nodeInfo;
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            console.warn(`Disabling workspace node ${nodeInfo?.id ?? '?'}`, error);
            return makeDisabledNodeInfo(nodeInfo, reason);
        }
    });
    return graphInfo;
}

function rebuildTrackNodesFromGraph(graph: LGraph) {
    trackNodes.clear();
    for (const node of ((graph as any)._nodes || [])) {
        if (!node) continue;
        attachGhostProperties(node, graph);
        const p = node.properties || {};
        const type = (typeof (node as any).getNodeType === 'function')
            ? (node as any).getNodeType()
            : (p.disabled || node.type === 'Audio/Disabled' ? 'disabled' : p.node_type || 'track');
        if (type === 'asset_filter') p.refresh_mode = normalizeAssetRefreshMode(p.refresh_mode);
        trackNodes.set(node.id, {
            id: node.id,
            type,
            name: p.node_name || node.title || 'AudioNode',
            filepath: p.filepath || '',
            sample_type: p.sample_type,
            original_bpm: p.original_bpm || 120,
            target_bpm: p.target_bpm || p.bpm || 120,
            bpm: p.bpm || p.target_bpm || 120,
            key: p.key || '',
            start_beat: p.start_beat || 0,
            mix_mode: p.mix_mode || 'sum',
            crop_start: p.crop_start,
            crop_end: p.crop_end,
            sequence: p.sequence,
            step_parameters: p.step_parameters,
            step_length: p.step_length,
            play_mode: p.play_mode,
            fade_ms: p.fade_ms,
            total_bars: p.total_bars ?? (type === 'track' || type === 'arrangement' ? 4 : undefined),
            section_points: p.section_points,
            section_probability: p.section_probability,
            section_sample_start: p.section_sample_start,
            section_quant: p.section_quant,
            section_quant_anchor: p.section_quant_anchor,
            duration_seconds: p.duration_seconds,
            selected_items: p.selected_items,
            playbackMode: p.playbackMode,
            seed: p.seed,
            seed_mode: p.seed_mode,
            refresh_mode: type === 'asset_filter' ? normalizeAssetRefreshMode(p.refresh_mode) : p.refresh_mode,
            chain: p.chain,
            modulators: p.modulators,
            asset_modifier_id: p.asset_modifier_id,
            parentId: p.parentId ?? null,
            children: []
        } as TrackNodeData);
    }
    syncGraphHierarchy(graph);
}

function graphResolutionNodes(graph: LGraph, rootNodeId?: number): any[] {
    const allNodes = ((graph as any)._nodes || []) as any[];
    if (rootNodeId == null) return allNodes;

    const nodes: any[] = [];
    const visited = new Set<number>();
    const pending = [rootNodeId];
    while (pending.length > 0) {
        const nodeId = pending.pop();
        if (nodeId == null || visited.has(nodeId)) continue;
        visited.add(nodeId);
        const node = graph.getNodeById(nodeId) as any;
        if (!node) continue;
        nodes.push(node);

        const modifierId = node.properties?.asset_modifier_id;
        if (modifierId != null) pending.push(modifierId);
        const data = trackNodes.get(nodeId);
        for (const childId of data?.children || []) pending.push(childId);
        for (const input of node.inputs || []) {
            const link = input.link != null ? (graph as any).links?.[input.link] : null;
            if (link?.origin_id != null) pending.push(link.origin_id);
        }
    }
    return nodes;
}

async function syncGraphSampleMetadataFromLibrary(
    graph: LGraph,
    includeDynamicAssets = true,
    rootNodeId?: number
) {
    // Preview/render only needs the serialized subtree. Resolving every pool
    // and sample in the open workspace made a small preview scale with the
    // size of unrelated work elsewhere on the canvas.
    const nodes = graphResolutionNodes(graph, rootNodeId);
    const references: any[] = [];
    for (const node of nodes) {
        const isAssetPool = node?.type === 'Audio/AssetFilter'
            || node?.properties?.node_type === 'asset_filter'
            || node?.properties?.output_type === 'asset_path';
        if (isAssetPool) {
            if (includeDynamicAssets) references.push(...(node.properties?.selected_items || []));
            continue;
        }
        if (!includeDynamicAssets && node?.properties?.asset_modifier_id != null) continue;
        const filepath = String(node?.properties?.filepath || '');
        const id = node?.properties?.library_item_id;
        if (id != null || filepath) references.push({ id, absolute_path: filepath });
    }
    const files: LibraryFile[] = await resolveLibraryAssets(references);

    // Pool entries are serialized snapshots. Refresh every entry first so the
    // next selection (and moved assets located by stable ID) uses current GAIA data.
    for (const node of nodes) {
        const isAssetPool = node?.type === 'Audio/AssetFilter'
            || node?.properties?.node_type === 'asset_filter'
            || node?.properties?.output_type === 'asset_path';
        if (!includeDynamicAssets && isAssetPool) continue;
        const items = Array.isArray(node?.properties?.selected_items)
            ? node.properties.selected_items
            : [];
        const outputId = node?.properties?.output_item_id;
        const outputPath = String(node?.properties?.output_value || '');
        // Collection contents may share a parent ID. Preserve the exact saved
        // output by matching its path before falling back to a stable item ID.
        const outputItem = items.find((item: any) =>
            outputPath && (item.absolute_path || item.filepath) === outputPath
        ) || items.find((item: any) =>
            outputId != null && String(item.id) === String(outputId)
        );
        for (const item of items) refreshLibraryAssetSnapshot(item, files);
        if (outputItem && node?.properties) {
            node.properties.output_value = outputItem.absolute_path || outputItem.filepath || outputPath;
            node.properties.output_item_id = outputItem.id ?? outputId;
            node.properties.output_bpm = outputItem.bpm ?? null;
            node.properties.output_key = String(outputItem.key ?? '');
        }
    }

    await Promise.all(nodes.map(node => {
        if (!includeDynamicAssets && node?.properties?.asset_modifier_id != null) {
            return Promise.resolve(false);
        }
        const sync = node?.syncMetadataFromLibrary;
        if (typeof sync !== 'function') return Promise.resolve(false);
        const modifierId = node.properties?.asset_modifier_id;
        const modifier = modifierId != null ? graph.getNodeById(modifierId) : null;
        const assetPath = modifier?.properties?.output_value || node.properties?.filepath || '';
        const selectedItem = (modifier?.properties?.selected_items || []).find((item: any) =>
            (item.absolute_path || item.filepath) === assetPath
        );
        const preferredId = modifier?.properties?.output_item_id ?? selectedItem?.id ?? node.properties?.library_item_id;
        if (assetPath && node.properties?.filepath !== assetPath) node.updateProperty('filepath', assetPath);
        return sync.call(node, files, preferredId).then((item: LibraryFile | null) => {
            if (!item) return false;
            const bpm = Number(node.properties?.original_bpm);
            const key = String(node.properties?.key || '');
            const data = trackNodes.get(node.id);
            if (data) {
                data.filepath = node.properties?.filepath || data.filepath;
                if (Number.isFinite(bpm)) data.original_bpm = bpm;
                data.key = key;
                data.duration_seconds = node.properties?.duration_seconds;
            }
            if (modifier?.properties) {
                if (Number.isFinite(bpm)) modifier.properties.output_bpm = bpm;
                modifier.properties.output_key = key;
                if (item?.id != null) modifier.properties.output_item_id = item.id;
            }
            if (selectedItem) {
                if (Number.isFinite(bpm)) {
                    selectedItem.bpm = bpm;
                    selectedItem.original_bpm = bpm;
                }
                selectedItem.key = key;
            }
            return true;
        });
    }));
    return files;
}

function setWorkspaceControlsEnabled() {
    const hasSelection = Boolean(workspacePresetSelect.value);
    saveWorkspaceBtn.disabled = !hasSelection;
    loadWorkspaceBtn.disabled = !hasSelection;
    deleteWorkspaceBtn.disabled = !hasSelection;
}

async function refreshWorkspacePresets(selectedName?: string) {
    try {
        const response = await fetch('/api/workspaces');
        if (!response.ok) throw new Error(`Could not list workspaces (${response.status})`);
        const data = await response.json();
        const workspaces = Array.isArray(data.workspaces) ? data.workspaces : [];
        workspacePresetSelect.innerHTML = '';
        if (workspaces.length === 0) {
            workspacePresetSelect.append(new Option('No saved workspaces', ''));
        } else {
            for (const workspace of workspaces) {
                workspacePresetSelect.append(new Option(workspace.name, workspace.name));
            }
            const nextValue = selectedName && workspaces.some((workspace: any) => workspace.name === selectedName)
                ? selectedName : workspaces[0].name;
            workspacePresetSelect.value = nextValue;
        }
    } catch (error) {
        console.error('Could not list workspace presets', error);
        workspacePresetSelect.innerHTML = '';
        workspacePresetSelect.append(new Option('Workspace saves unavailable', ''));
    }
    setWorkspaceControlsEnabled();
}

function serializeWorkspaceGraph(graph: LGraph) {
    writeGlobalParametersToGraph(graph);
    return stripResolvedPoolState(graph.serialize());
}

function createWorkspacePreset(graph: LGraph) {
    return {
        version: WORKSPACE_PRESET_VERSION,
        savedAt: new Date().toISOString(),
        graph: serializeWorkspaceGraph(graph)
    };
}

async function saveWorkspacePreset(name: string) {
    const graph = (window as any).editorGraph as LGraph;
    if (!graph) throw new Error('Graph is unavailable.');
    try {
        const response = await fetch('/api/workspaces', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, preset: createWorkspacePreset(graph) })
        });
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.detail || `Could not save workspace (${response.status})`);
        }
        await refreshWorkspacePresets(name);
        fileMenu.open = false;
        setWorkspaceButtonMessage(saveWorkspaceBtn, 'Saved', 'Save');
    } catch (error) {
        console.error('Could not save workspace preset', error);
        setWorkspaceButtonMessage(saveWorkspaceBtn, 'Save failed', 'Save');
    }
}

workspacePresetSelect.addEventListener('change', setWorkspaceControlsEnabled);

newStageBtn.addEventListener('click', () => {
    const graph = (window as any).editorGraph as LGraph;
    const canvas = (window as any).editorCanvas as LGraphCanvas;
    if (!graph) return;

    closeAllParamWindows();
    activeParamNodeId = null;
    graph.clear();
    trackNodes.clear();
    setGlobalParameters(DEFAULT_GLOBAL_PARAMETERS, graph);
    updateGraphNodeCollapsing();
    canvas?.setDirty(true, true);
    fileMenu.open = false;
    // A blank stage is a deliberate new document, even if no previous stage
    // exists (or it was already blank), so force a fresh persisted snapshot.
    lastSavedStageFingerprint = null;
    scheduleStageSave(0);
});

saveWorkspaceAsBtn.addEventListener('click', async () => {
    const name = window.prompt('Workspace preset name:');
    if (!name?.trim()) return;
    await saveWorkspacePreset(name.trim());
});

saveWorkspaceBtn.addEventListener('click', async () => {
    if (workspacePresetSelect.value) await saveWorkspacePreset(workspacePresetSelect.value);
});

loadWorkspaceBtn.addEventListener('click', async () => {
    const graph = (window as any).editorGraph as LGraph;
    const canvas = (window as any).editorCanvas as LGraphCanvas;
    if (!graph) return;
    try {
        cancelScheduledStageSave();
        if (stageSaveInFlight && stageSaveCompletion) await stageSaveCompletion;
        stageHydrating = true;
        setStageSaveState('loading', 'Loading workspace preset');
        const response = await fetch(`/api/workspaces/${encodeURIComponent(workspacePresetSelect.value)}`);
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.detail || `Could not load workspace (${response.status})`);
        }
        const data = await response.json();
        const preset = data.preset;
        if (preset.version !== WORKSPACE_PRESET_VERSION) {
            console.warn(`Migrating workspace preset version ${preset.version} to ${WORKSPACE_PRESET_VERSION}.`);
        }
        closeAllParamWindows();
        activeParamNodeId = null;
        graph.configure(prepareWorkspaceGraph(preset.graph));
        // Apply saved transport settings immediately. Library metadata refresh
        // may take a moment and should not leave the editor showing defaults
        // while the graph is already loaded.
        if (preset.graph?.extra?.global_parameters) {
            setGlobalParameters(preset.graph.extra.global_parameters, graph);
        }
        // The graph is now the user's selected preset. Persist this snapshot
        // before the slower GAIA metadata refresh so a fast page refresh still
        // restores the preset rather than the previous unsaved stage.
        stageHydrating = false;
        await saveCurrentStage();
        await syncGraphSampleMetadataFromLibrary(graph, false);
        rebuildTrackNodesFromGraph(graph);
        loadGlobalParametersFromGraph(graph);
        updateGraphNodeCollapsing();
        canvas?.setDirty(true, true);
        // Metadata may have changed serialized properties. Coalesce any event
        // saves and replace the stage once more with the final loaded graph.
        cancelScheduledStageSave();
        if (stageSaveInFlight && stageSaveCompletion) await stageSaveCompletion;
        await saveCurrentStage();
        fileMenu.open = false;
        setWorkspaceButtonMessage(loadWorkspaceBtn, 'Loaded', 'Load');
    } catch (error) {
        stageHydrating = false;
        console.error('Could not load workspace preset', error);
        setWorkspaceButtonMessage(loadWorkspaceBtn, 'Load failed', 'Load');
    }
});

deleteWorkspaceBtn.addEventListener('click', async () => {
    const name = workspacePresetSelect.value;
    if (!name || !window.confirm(`Delete workspace preset "${name}"?`)) return;
    try {
        const response = await fetch(`/api/workspaces/${encodeURIComponent(name)}`, { method: 'DELETE' });
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.detail || `Could not delete workspace (${response.status})`);
        }
        await refreshWorkspacePresets();
        fileMenu.open = false;
        setWorkspaceButtonMessage(deleteWorkspaceBtn, 'Deleted', 'Delete');
    } catch (error) {
        console.error('Could not delete workspace preset', error);
        setWorkspaceButtonMessage(deleteWorkspaceBtn, 'Delete failed', 'Delete');
    }
});

void refreshWorkspacePresets();

headerToggleLibrary?.addEventListener('click', () => {
    toggleLibraryPanel('toggle');
});

headerToggleProperties?.addEventListener('click', () => {
    togglePropertiesPanel();
});

toggleLibraryBtn.addEventListener('click', () => {
    toggleLibraryPanel('toggle');
    libraryMenu.open = false;
});

function updateLibraryPreviewMenuItem() {
    const enabled = isLibraryPreviewEnabled();
    toggleLibraryPreviewBtn.textContent = `Auto-preview: ${enabled ? 'On' : 'Off'}`;
    toggleLibraryPreviewBtn.setAttribute('aria-pressed', String(enabled));
}

toggleLibraryPreviewBtn.addEventListener('click', () => {
    setLibraryPreviewEnabled(!isLibraryPreviewEnabled());
    updateLibraryPreviewMenuItem();
    libraryMenu.open = false;
});

updateLibraryPreviewMenuItem();

window.addEventListener('toggle-properties-dock', (e: Event) => {
    const nodeId = (e as CustomEvent).detail?.nodeId;
    togglePropertiesDockMode(nodeId);
});

window.addEventListener('keydown', (e: KeyboardEvent) => {
    const activeEl = document.activeElement;
    if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || (activeEl as HTMLElement).isContentEditable)) {
        return;
    }
    if ((e.key === 'l' || e.key === 'L') && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        toggleLibraryPanel('toggle');
    } else if ((e.key === 'p' || e.key === 'P') && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        togglePropertiesPanel();
    }
});

globalPreviewBtn.addEventListener('click', async () => {
    if (globalPreviewBtn.disabled) return;
    const graph = (window as any).editorGraph as LGraph;
    const target = resolveMainPreviewNode(graph);
    if (!target) return;

    globalPreviewBtn.disabled = true;
    globalPreviewBtn.innerHTML = '<span class="btn-icon" aria-hidden="true">…</span>';
    try {
        await previewNode(target.id, true, true);
    } finally {
        globalPreviewBtn.innerHTML = '<span class="btn-icon" aria-hidden="true">▶</span>';
        updateMainPreviewTarget(graph);
    }
});

previewRecalculateBtn.addEventListener('click', async () => {
    if (previewRecalculateBtn.disabled) return;
    const graph = (window as any).editorGraph as LGraph;
    const nodeId = activeRamPreviewNodeId ?? resolveMainPreviewNode(graph)?.id;
    if (nodeId == null) return;

    previewRecalculateBtn.disabled = true;
    previewRecalculateBtn.innerHTML = '<span class="btn-icon" aria-hidden="true">…</span>';
    try {
        await previewNode(nodeId, true, false, false);
    } finally {
        previewRecalculateBtn.innerHTML = '<span class="btn-icon" aria-hidden="true">↻</span>';
        previewRecalculateBtn.disabled = activeRamPreviewNodeId == null;
    }
});

tempFilesSelect.addEventListener('change', (e) => {
    const val = (e.target as HTMLSelectElement).value;
    updatePlaybackTrackPresentation();
    if (val === 'RAM_PREVIEW') {
        masterPlayer.play().catch(error => console.error('Play failed', error));
    } else if (val) {
        setMasterPlayerSource(val, true);
    }
});

let activeRamPreviewNodeId: number | null = null;
let activeRamPreviewPayload: any = null;

exportBtn.addEventListener('click', async () => {
    fileMenu.open = false;
    const selectedVal = tempFilesSelect.value;
    if (selectedVal === 'RAM_PREVIEW' && activeRamPreviewNodeId != null) {
        const keyName = `export_${activeRamPreviewNodeId}`;
        try {
            const res = await fetch(`/api/preview/export/${encodeURIComponent(keyName)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(activeRamPreviewPayload || {})
            });
            const data = await res.json();
            if (data.status === 'success' && data.file_url) {
                const downloadName = data.filename || `${keyName}.wav`;
                const a = document.createElement('a');
                a.href = data.file_url;
                a.download = downloadName;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);

                await updateTempRendersList();
            } else {
                alert("RAM Export failed: " + (data.detail || 'Unknown error'));
            }
        } catch (err) {
            console.error(err);
            alert("RAM Export failed");
        }
        return;
    }

    const selectedOption = tempFilesSelect.options[tempFilesSelect.selectedIndex];
    if (!selectedOption || !selectedOption.value) return;

    const filename = selectedOption.textContent;
    if (!filename) return;

    try {
        const res = await fetch('/api/renders/export', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename })
        });
        const data = await res.json();
        if (data.status === 'success' && data.file_url) {
            const a = document.createElement('a');
            a.href = data.file_url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);

            await updateTempRendersList();
        } else {
            alert("Export failed: " + (data.detail || 'Unknown error'));
        }
    } catch (err) {
        console.error(err);
        alert("Export failed");
    }
});

async function updateTempRendersList(selectFilename?: string) {
    try {
        const res = await fetch('/api/renders/temp');
        const data = await res.json();

        tempFilesSelect.innerHTML = ''; // clear options

        if (data.files && data.files.length > 0) {
            data.files.forEach((f: any) => {
                const opt = document.createElement('option');
                opt.value = f.url;
                opt.textContent = f.filename;
                tempFilesSelect.appendChild(opt);
            });

            if (selectFilename) {
                for (let i = 0; i < tempFilesSelect.options.length; i++) {
                    if (tempFilesSelect.options[i].textContent === selectFilename) {
                        tempFilesSelect.selectedIndex = i;
                        break;
                    }
                }
            }

            // Update player src to currently selected
            const selectedOpt = tempFilesSelect.options[tempFilesSelect.selectedIndex];
            if (selectedOpt) {
                setMasterPlayerSource(selectedOpt.value);
            }
            updatePlaybackTrackPresentation();
        } else {
            // No files left
            tempFilesSelect.innerHTML = '<option value="" disabled selected>No renders available</option>';
            masterPlayer.pause();
            masterPlayer.removeAttribute('src');
            masterPlayer.load();
            masterPlayBtn.disabled = true;
            masterWaveform.clear('Ready to render');
            updatePlaybackControls();
            updatePlaybackTrackPresentation();
        }
    } catch (err) {
        console.error("Failed to update temp renders list", err);
    }
}

// Initial fetch
updateTempRendersList();
// ------------------

LiteGraph.NODE_TITLE_HEIGHT = 44;
LiteGraph.NODE_TITLE_TEXT_Y = 27;
LiteGraph.NODE_SLOT_HEIGHT = 0;
LiteGraph.NODE_WIDGET_HEIGHT = 0;
LiteGraph.NODE_WIDTH = 200;
LiteGraph.NODE_MIN_WIDTH = 200;
LiteGraph.NODE_COLLAPSED_RADIUS = 0;
LiteGraph.NODE_COLLAPSED_WIDTH = 80;
LiteGraph.NODE_TEXT_SIZE = 13;
LiteGraph.NODE_SUBTEXT_SIZE = 0;
LiteGraph.NODE_DEFAULT_SHAPE = "box" as any;

// Cable Breaker cursor SVG Data URI
const BREAKER_CURSOR = `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='%23ef4444' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><circle cx='6' cy='6' r='3'/><circle cx='6' cy='18' r='3'/><line x1='8.5' y1='7.5' x2='18' y2='17'/><line x1='8.5' y1='16.5' x2='18' y2='7'/></svg>") 12 12, pointer`;

let hoveredLink: any = null;
const LEFT_PORT_BRANCH_INPUT = '__sinLeftPortBranchInput';

function markLeftPortBranch(link: any, sourceNode: any, inputSlot: number) {
    if (!link || !sourceNode) return;
    link[LEFT_PORT_BRANCH_INPUT] = inputSlot;
    link.__sinLeftPortBranchOwnerId = sourceNode.id;
    sourceNode.properties = sourceNode.properties || {};
    const branches = sourceNode.properties.left_port_branch_links || {};
    branches[String(link.id)] = inputSlot;
    sourceNode.properties.left_port_branch_links = branches;
}

function getLinkEndpoints(
    graph: any,
    link: any,
    fallbackOrigin: [number, number],
    fallbackTarget: [number, number]
) {
    const originNode = link ? graph?.getNodeById?.(link.origin_id) : null;
    const targetNode = link ? graph?.getNodeById?.(link.target_id) : null;
    const branchOwner = graph?.getNodeById?.(link?.__sinLeftPortBranchOwnerId)
        || [originNode, targetNode].find((node: any) =>
            Number.isInteger(node?.properties?.left_port_branch_links?.[String(link?.id)])
        );
    const inputSlot = link?.[LEFT_PORT_BRANCH_INPUT]
        ?? branchOwner?.properties?.left_port_branch_links?.[String(link?.id)];

    if (branchOwner && Number.isInteger(inputSlot)) {
        const childNode = branchOwner.id === originNode?.id ? targetNode : originNode;
        if (childNode) {
            return {
                origin: branchOwner.getConnectionPos(true, inputSlot),
                target: childNode.getConnectionPos(false, childNode.id === originNode?.id ? link.origin_slot : 0)
            };
        }
    }
    return { origin: fallbackOrigin, target: fallbackTarget };
}

function getDistanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) {
        return Math.hypot(px - ax, py - ay);
    }
    let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const projX = ax + t * dx;
    const projY = ay + t * dy;
    return Math.hypot(px - projX, py - projY);
}

// Monkey-patch LGraphNode.prototype.connect to redirect connections to free slots
// Or dynamically allocate a new input slot if all existing slots are occupied.
const originalConnect = (LiteGraph as any).LGraphNode.prototype.connect;
(LiteGraph as any).LGraphNode.prototype.connect = function (slot: any, target_node: any, target_slot: any) {
    const sourceOutput = this.outputs?.[slot];
    const leftPortBranchInput = sourceOutput?.[LEFT_PORT_BRANCH_INPUT];
    let t_node = target_node;
    if (t_node && t_node.constructor === Number) {
        t_node = this.graph.getNodeById(t_node);
    }
    if (t_node && t_node.inputs) {
        let freeSlotIndex = -1;
        for (let i = 0; i < t_node.inputs.length; i++) {
            if (t_node.inputs[i].link == null) {
                freeSlotIndex = i;
                break;
            }
        }
        if (freeSlotIndex !== -1) {
            target_slot = freeSlotIndex;
        } else {
            // Allocate a new slot on the fly if all are occupied
            if (typeof t_node.addInput === 'function') {
                t_node.addInput("Input", "audio");
                target_slot = t_node.inputs.length - 1;
            }
        }
    }
    const link = originalConnect.call(this, slot, target_node, target_slot);
    if (Number.isInteger(leftPortBranchInput)) {
        delete sourceOutput[LEFT_PORT_BRANCH_INPUT];
        markLeftPortBranch(link, this, leftPortBranchInput);
    }
    return link;
};

// Keep canvas navigation and selection on familiar desktop controls:
// middle-drag pans, Shift+left-drag box-selects, and Ctrl+click adds nodes.
const originalProcessMouseDown = (LiteGraph as any).LGraphCanvas.prototype.processMouseDown;
(LiteGraph as any).LGraphCanvas.prototype.processMouseDown = function (e: MouseEvent) {
    const previousAllowDragCanvas = this.allow_dragcanvas;
    const boxSelect = e.button === 0 && e.shiftKey && !e.ctrlKey;
    const additiveSelect = e.button === 0 && e.ctrlKey && !e.shiftKey;

    // Dragging an occupied input fans out from the node that owns the input.
    // LiteGraph normally disconnects that input before reconnecting it;
    // preserve the incoming link and start a fresh connection from the
    // parent's right-side output instead.
    if (e.button === 0 && !e.shiftKey && !e.ctrlKey && this.graph) {
        const offset = this.convertEventToCanvasOffset(e);
        const scale = this.ds?.scale || 1;
        const threshold = 10 / scale;
        const node = this.getNodeOnPos(offset[0], offset[1], (this.graph as any)._nodes, 0);
        if (node?.inputs) {
            for (let index = 0; index < node.inputs.length; index++) {
                const input = node.inputs[index];
                if (input?.link == null) continue;

                const port = node.getConnectionPos(true, index);
                if (Math.hypot(offset[0] - port[0], offset[1] - port[1]) > threshold) continue;

                const parentOutputSlot = 0;
                const parentOutput = node.outputs?.[parentOutputSlot];
                if (!parentOutput) {
                    // This port cannot fan out, but it must never unpatch by
                    // beginning LiteGraph's input-reconnect gesture.
                    e.preventDefault();
                    return true;
                }

                this.connecting_node = node;
                this.connecting_output = parentOutput;
                this.connecting_output.slot_index = parentOutputSlot;
                this.connecting_input = null;
                this.connecting_slot = parentOutputSlot;
                parentOutput[LEFT_PORT_BRANCH_INPUT] = index;
                this.connecting_pos = node.getConnectionPos(true, index);
                this.dirty_bgcanvas = true;
                e.preventDefault();
                return true;
            }
        }
    }

    this.allow_dragcanvas = e.button === 1;
    if (boxSelect) {
        Object.defineProperty(e, "ctrlKey", { configurable: true, value: true });
    } else if (additiveSelect) {
        Object.defineProperty(e, "ctrlKey", { configurable: true, value: false });
        Object.defineProperty(e, "shiftKey", { configurable: true, value: true });
    }

    try {
        return originalProcessMouseDown.call(this, e);
    } finally {
        this.allow_dragcanvas = previousAllowDragCanvas;
        if (boxSelect || additiveSelect) delete (e as any).ctrlKey;
        if (additiveSelect) delete (e as any).shiftKey;
    }
};

const originalProcessNodeSelected = (LiteGraph as any).LGraphCanvas.prototype.processNodeSelected;
(LiteGraph as any).LGraphCanvas.prototype.processNodeSelected = function (node: any, e: MouseEvent) {
    const keepGroup = node?.is_selected
        && Object.keys(this.selected_nodes || {}).length > 1
        && !e.shiftKey
        && !e.ctrlKey;
    if (!keepGroup) return originalProcessNodeSelected.call(this, node, e);
    this.onNodeSelected?.(node);
};

// Monkey-patch LGraphCanvas.prototype.processMouseUp for Cable to Nothing node selector
const originalProcessMouseUp = (LiteGraph as any).LGraphCanvas.prototype.processMouseUp;
(LiteGraph as any).LGraphCanvas.prototype.processMouseUp = function (e: MouseEvent) {
    const connectingNode = this.connecting_node;
    const connectingOutput = (this as any).connecting_output;
    const connectingInput = (this as any).connecting_input;
    const connectingSlotObj = (this as any).connecting_slot;
    const nodeOver = this.node_over;
    const leftPortBranchInput = connectingOutput?.[LEFT_PORT_BRANCH_INPUT];

    const res = originalProcessMouseUp.call(this, e);

    // A normal connection consumes the temporary marker in `connect`. For the
    // empty-canvas node picker, retain the intent locally until its callback.
    if (Number.isInteger(leftPortBranchInput)) {
        delete connectingOutput[LEFT_PORT_BRANCH_INPUT];
    }

    // If dragging a connection wire and released over empty space (no node_over)
    if (connectingNode && !nodeOver) {
        const offset = this.convertEventToCanvasOffset(e);
        const canvasPos: [number, number] = [offset[0], offset[1]];
        const clientX = e.clientX;
        const clientY = e.clientY;

        let isOutput = true;
        let slotIndex = 0;

        if (connectingInput != null) {
            isOutput = false;
            if (connectingNode.inputs) {
                const idx = connectingNode.inputs.indexOf(connectingInput);
                if (idx !== -1) slotIndex = idx;
            }
        } else if (connectingOutput != null) {
            isOutput = true;
            if (connectingNode.outputs) {
                const idx = connectingNode.outputs.indexOf(connectingOutput);
                if (idx !== -1) slotIndex = idx;
            }
        } else if (typeof connectingSlotObj === 'number') {
            slotIndex = connectingSlotObj;
            if (connectingNode.inputs && connectingNode.inputs[slotIndex] === connectingSlotObj) {
                isOutput = false;
            }
        }

        popupMenu.show(clientX, clientY, (nodeType) => {
                const newNode = addRootNode(nodeType, canvasPos);
            if (newNode && connectingNode) {
                if (isOutput && Number.isInteger(leftPortBranchInput)) {
                    // A left-port branch creates a child of the clicked node:
                    // child right output -> original node input. The custom
                    // cable renderer keeps the visual cable left-to-right.
                    const link = newNode.connect(0, connectingNode, 0);
                    markLeftPortBranch(link, connectingNode, leftPortBranchInput);
                } else if (isOutput) {
                    const link = connectingNode.connect(slotIndex, newNode, 0);
                    if (Number.isInteger(leftPortBranchInput)) {
                        markLeftPortBranch(link, connectingNode, leftPortBranchInput);
                    }
                } else {
                    newNode.connect(0, connectingNode, slotIndex);
                }
                if (this.graph) {
                    syncGraphHierarchy(this.graph);
                    updateGraphNodeCollapsing();
                }
                this.setDirty(true, true);
            }
        });
    }

    return res;
};

// Monkey-patch LGraphCanvas.prototype.drawNode to delegate to node's drawCanvas method
(LiteGraph as any).LGraphCanvas.prototype.drawNode = function (node: any, ctx: CanvasRenderingContext2D) {
    if (!node || node.flags?.hidden || (node as any).collapsedDotMode) {
        return;
    }

    if (typeof node.drawCanvas === 'function') {
        node.drawCanvas(ctx, this);
    }
};

// Monkey-patch LGraphCanvas.prototype.getNodeOnPos for square node & action button hit testing
(LiteGraph as any).LGraphCanvas.prototype.getNodeOnPos = function (x: number, y: number, nodes_list: any[], margin: number) {
    const targetList = nodes_list || (this.graph ? (this.graph as any)._nodes : null);
    if (!targetList) return null;

    margin = margin || 0;

    for (let i = targetList.length - 1; i >= 0; i--) {
        const n = targetList[i];
        if (!n || n.flags?.hidden) continue;

        if ((n as any).collapsedDotMode) {
            const dotX = n.pos[0] + (n.size?.[0] || 44) * 0.5;
            const dotY = n.pos[1] + 10;
            const dist = Math.hypot(x - dotX, y - dotY);
            if (dist <= 16) {
                return n;
            }
            continue;
        }

        if (typeof n.isPointInside === 'function' && n.isPointInside(x, y, margin)) {
            return n;
        }
    }

    return null;
};

// Custom renderLink override:
// 1. Keeps slate color when moving nodes (prevents white highlight flash)
// 2. Removes center anchor dots
// 3. Renders full unbroken straight lines from Point A to Point B without input/output stub breaks
// 4. Highlights cable in bright red (#ef4444) when hovered by Breaker cursor
(LiteGraph as any).LGraphCanvas.prototype.renderLink = function (
    ctx: CanvasRenderingContext2D,
    a: [number, number],
    b: [number, number],
    link: any,
    _skip_border?: boolean,
    _flow?: boolean,
    color?: string
) {
    if (link) {
        this.visible_links.push(link);
    }

    const isHovered = hoveredLink && link && link.id === hoveredLink.id;
    const lineColor = isHovered ? "#ef4444" : (color || (link && link.color) || "#94a3b8");

    ctx.save();
    ctx.lineWidth = isHovered ? (this.connections_width || 2) + 1.5 : (this.connections_width || 2);
    ctx.strokeStyle = lineColor;
    ctx.fillStyle = lineColor;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    const endpoints = getLinkEndpoints(this.graph, link, a, b);

    // Direct 1-to-1 full unbroken straight line
    ctx.beginPath();
    ctx.moveTo(endpoints.origin[0], endpoints.origin[1]);
    ctx.lineTo(endpoints.target[0], endpoints.target[1]);
    ctx.stroke();

    ctx.restore();
};

// Direct linear connections (Single straight line A -> B without turns)
LiteGraph.LINEAR_LINK = 1;
LiteGraph.LINK_COLOR = "#94a3b8"; // Light slate
LiteGraph.CONNECTING_LINK_COLOR = "#94a3b8";
LiteGraph.EVENT_LINK_COLOR = "#94a3b8";
LiteGraph.NODE_TEXT_COLOR = "#ffffff";
LiteGraph.NODE_TITLE_COLOR = "#ffffff";
LiteGraph.NODE_TITLE_HEIGHT = 0;

export interface TrackNodeData {
    id: number;
    type: "track" | "sample" | "sequence" | "item_pool" | "sample_pool" | "arrangement" | "modulator" | "asset_filter" | "disabled";
    name: string;
    filepath: string;
    sample_type?: string;
    original_bpm: number;
    target_bpm?: number;
    key?: string;
    start_beat: number;
    bpm?: number | 'global';
    mix_mode: string;
    crop_start?: number;
    crop_end?: number;
    transpose?: number;
    cents?: number;
    stretch_mode?: string;
    stretch_factor?: number;
    stretch_algorithm?: string;
    sequence?: number[];
    step_parameters?: Array<{
        offset: number;
        velocity: number;
        probability: number;
        subdivision_enabled: boolean;
        subdivisions: number;
    }>;
    step_length?: number;
    play_mode?: string;
    fade_ms?: number;
    total_bars?: number | 'global';
    section_points?: number[];
    section_probability?: number[];
    section_sample_start?: number[];
    section_quant?: string[];
    section_quant_anchor?: string[];
    duration_seconds?: number;
    selected_items?: any[];
    playbackMode?: string;
    seed?: number;
    seed_mode?: string;
    refresh_mode?: string;
    chain?: any[];
    modulators?: number[];
    asset_modifier_id?: number;
    parentId: number | null;
    children: number[];
}

interface LibraryDragItem {
    id?: number | string;
    itemType?: string;
    filepath: string;
    name?: string;
    key?: string | null;
    bpm?: number | null;
    duration_seconds?: number | null;
    stems?: any[];
    is_valid_length?: boolean;
    length_variance?: number;
}

function isMidiLibraryItem(item: LibraryDragItem): boolean {
    const filepath = (item.filepath || "").toLowerCase();
    return item.itemType === "midi" || filepath.endsWith(".mid") || filepath.endsWith(".midi");
}

function isSavedSequenceLibraryItem(item: LibraryDragItem): boolean {
    const filepath = (item.filepath || "").toLowerCase();
    return item.itemType === "sequence" || filepath.endsWith(".seq");
}

function isSequenceSourceLibraryItem(item: LibraryDragItem): boolean {
    return isMidiLibraryItem(item) || isSavedSequenceLibraryItem(item);
}

function getLibraryDragItems(payload: any): LibraryDragItem[] {
    const rawItems = payload?.type === "library-items" && Array.isArray(payload.items)
        ? payload.items
        : payload?.type === "library-item" ? [payload] : [];

    return rawItems.filter((item: any) => item && typeof item.filepath === "string" && item.filepath.length > 0);
}

export function extractMetadataFromPath(filepath: string): { bpm: number | null; key: string | null } {
    if (!filepath) return { bpm: null, key: null };
    const cleanText = filepath.replace(/[/_\\-]/g, ' ');

    const bpmMatch = cleanText.match(/(?<!\d)(\d{2,3})\s*bpm\b/i);
    const bpm = bpmMatch ? parseInt(bpmMatch[1], 10) : null;

    let key: string | null = null;
    const camelotMatch = cleanText.match(/\b(1[0-2]|[1-9])[ab]\b/i);
    if (camelotMatch) {
        key = camelotMatch[0].toUpperCase();
    } else {
        const standardMatch = cleanText.match(/\b([a-g][#b]?\s*(?:min|maj|minor|major|m(?![ix])))\b/i);
        if (standardMatch) {
            const raw = standardMatch[0].trim();
            key = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
        }
    }
    return { bpm, key };
}

const trackNodes = new Map<number, TrackNodeData>();
(window as any).trackNodes = trackNodes;
(window as any).fetchLibrary = fetchLibrary;
(window as any).resolveLibraryAssets = resolveLibraryAssets;
(window as any).runtimeLog = runtimeLog;
(window as any).findLibraryFile = findLibraryFile;
(window as any).findLibraryFileById = findLibraryFileById;
(window as any).findLibraryFileForPoolLocator = findLibraryFileForPoolLocator;

type MainPreviewState = { node_id: number | null; mode: 'auto' | 'manual' };

function getMainPreviewState(graph: LGraph): MainPreviewState {
    const graphWithExtra = graph as any;
    if (!graphWithExtra.extra) graphWithExtra.extra = {};
    const saved = graphWithExtra.extra.main_preview;
    if (!saved || (saved.mode !== 'auto' && saved.mode !== 'manual')) {
        graphWithExtra.extra.main_preview = { node_id: null, mode: 'auto' } satisfies MainPreviewState;
    }
    return graphWithExtra.extra.main_preview;
}

function canBeMainPreview(node: any): boolean {
    return Boolean(node)
        && !isGhostNode(node)
        && (typeof node.canBeMainPreview !== 'function' || node.canBeMainPreview());
}

function resolveMainPreviewNode(graph?: LGraph): any | null {
    if (!graph) return null;
    const state = getMainPreviewState(graph);
    let current = state.node_id != null ? graph.getNodeById(state.node_id) : null;

    if (state.mode === 'manual') {
        if (canBeMainPreview(current)) return current;
        state.mode = 'auto';
        state.node_id = null;
        current = null;
    }

    // Keep the first automatic root stable. When it is connected upward, follow
    // that new parent chain to the graph output before considering another root.
    if (canBeMainPreview(current)) {
        const visited = new Set<number>();
        while (current && !visited.has(current.id)) {
            visited.add(current.id);
            const parentId = trackNodes.get(current.id)?.parentId;
            if (parentId == null) break;
            const parent = graph.getNodeById(parentId);
            if (!canBeMainPreview(parent)) break;
            current = parent;
        }
        if (current && trackNodes.get(current.id)?.parentId == null) {
            state.node_id = current.id;
            return current;
        }
    }

    const firstRoot = (((graph as any)._nodes || []) as any[]).find(node =>
        canBeMainPreview(node) && trackNodes.get(node.id)?.parentId == null
    ) || null;
    state.node_id = firstRoot?.id ?? null;
    return firstRoot;
}

function updateMainPreviewTarget(graph?: LGraph): any | null {
    const targetGraph = graph || ((window as any).editorGraph as LGraph);
    if (!targetGraph) return null;
    const target = resolveMainPreviewNode(targetGraph);
    for (const node of (((targetGraph as any)._nodes || []) as any[])) {
        if (!node?.properties) continue;
        node.properties.is_main_preview = node.id === target?.id;
        node.setDirtyCanvas?.(true, true);
    }
    const state = getMainPreviewState(targetGraph);
    const targetName = target?.properties?.node_name || target?.title || '';
    globalPreviewBtn.disabled = !target;
    globalPreviewBtn.title = target
        ? `Preview main output: ${targetName} (${state.mode === 'manual' ? 'manual' : 'automatic'})`
        : 'Add an audio node to enable main preview';
    globalPreviewBtn.setAttribute('aria-label', globalPreviewBtn.title);
    return target;
}

(window as any).isMainPreviewNode = (nodeId: number) => {
    const graph = (window as any).editorGraph as LGraph;
    return resolveMainPreviewNode(graph)?.id === nodeId;
};
(window as any).isManualMainPreviewNode = (nodeId: number) => {
    const graph = (window as any).editorGraph as LGraph;
    if (!graph) return false;
    const state = getMainPreviewState(graph);
    return state.mode === 'manual' && state.node_id === nodeId;
};

window.addEventListener('set-main-preview-node', (event: Event) => {
    const nodeId = (event as CustomEvent).detail?.nodeId;
    const graph = (window as any).editorGraph as LGraph;
    const node = nodeId != null ? graph?.getNodeById(nodeId) : null;
    if (!graph || !canBeMainPreview(node)) return;
    const state = getMainPreviewState(graph);
    if (state.mode === 'manual' && state.node_id === nodeId) {
        state.mode = 'auto';
        state.node_id = null;
    } else {
        state.mode = 'manual';
        state.node_id = nodeId;
    }
    updateMainPreviewTarget(graph);
    (window as any).editorCanvas?.setDirty?.(true, true);
});

window.addEventListener('node-property-changed', (event: Event) => {
    const { nodeId, key, value } = (event as CustomEvent).detail || {};
    const data = trackNodes.get(nodeId);
    if (!data || typeof key !== 'string') return;
    if (key === 'node_name' || key === 'name') data.name = String(value);
    else (data as any)[key] = value;

    // BPM is inherited through the graph hierarchy, so a property edit must
    // re-run the same propagation pass used after connection changes.
    if (key === 'bpm' || key === 'target_bpm' || key === 'total_bars') {
        syncGraphHierarchy();
    }
    if (key === 'total_bars') {
        window.dispatchEvent(new CustomEvent('arrangement-length-changed', {
            detail: { nodeId }
        }));
    }
});

let activeParamNodeId: number | null = null;

function closeAllParamWindows(exceptNodeId?: number) {
    const dv = (window as any).dockview;
    if (!dv) return;
    const panels = dv.panels || [];
    for (const p of panels) {
        if (p.id && p.id.startsWith('properties_')) {
            const idNum = parseInt(p.id.replace('properties_', ''), 10);
            if (exceptNodeId == null || idNum !== exceptNodeId) {
                p.api.close();
            }
        }
    }
}

function isNodeInSubtree(nodeId: number, targetId: number): boolean {
    if (nodeId === targetId) return true;
    const data = trackNodes.get(nodeId);
    if (!data || !data.children) return false;
    for (const childId of data.children) {
        if (isNodeInSubtree(childId, targetId)) return true;
    }
    return false;
}

function isChildParamShown(parentId: number): boolean {
    if (activeParamNodeId === null) return false;
    const parentData = trackNodes.get(parentId);
    if (!parentData || !parentData.children) return false;
    for (const childId of parentData.children) {
        if (isNodeInSubtree(childId, activeParamNodeId)) return true;
    }
    return false;
}

function syncBpmInheritance(graph?: LGraph) {
    const targetGraph = graph || ((window as any).editorGraph as LGraph);
    if (!targetGraph) return;

    // Tracks own a scope setting. Resolve it first without replacing the
    // persisted "global" choice in `properties.bpm`.
    for (const [nodeId, data] of trackNodes.entries()) {
        if (data.type !== 'track') continue;
        const node = targetGraph.getNodeById(nodeId);
        const configured = node?.properties?.bpm ?? data.bpm ?? 'global';
        const numeric = configured === 'global' ? globalParameters.bpm : Number(configured);
        const resolved = Number.isFinite(numeric) ? Number(numeric) : globalParameters.bpm;
        data.bpm = configured;
        data.target_bpm = resolved;
        if (node?.properties) node.properties.target_bpm = resolved;
    }

    let changed = true;
    let iterations = 0;
    while (changed && iterations < 10) {
        changed = false;
        iterations++;
        for (const [nodeId, data] of trackNodes.entries()) {
            if (data.parentId != null && data.type !== 'track') {
                const parentData = trackNodes.get(data.parentId);
                const parentNodeObj = targetGraph.getNodeById(data.parentId);
                const parentTargetBpm = parentData?.target_bpm ?? parentData?.bpm ?? parentNodeObj?.properties?.target_bpm ?? parentNodeObj?.properties?.bpm ?? 120;
                
                if (data.target_bpm !== parentTargetBpm || data.bpm !== parentTargetBpm) {
                    data.target_bpm = parentTargetBpm;
                    data.bpm = parentTargetBpm;
                    changed = true;
                    
                    const nodeObj = targetGraph.getNodeById(nodeId);
                    if (nodeObj && nodeObj.properties) {
                        nodeObj.properties.target_bpm = parentTargetBpm;
                        nodeObj.properties.bpm = parentTargetBpm;
                    }
                }
            }
        }
    }
}

(window as any).syncBpmInheritance = () => syncBpmInheritance();

function syncArrangementLengthInheritance(graph?: LGraph) {
    const targetGraph = graph || ((window as any).editorGraph as LGraph);
    if (!targetGraph) return;

    for (const [nodeId, data] of trackNodes.entries()) {
        if (data.type !== 'arrangement' || data.parentId == null) continue;
        const parentData = trackNodes.get(data.parentId);
        const parentNode = targetGraph.getNodeById(data.parentId);
        const parentSetting = parentNode?.properties?.total_bars ?? parentData?.total_bars;
        const parentBars = parentSetting === 'global' ? globalParameters.total_bars : Number(parentSetting);
        if (!Number.isFinite(parentBars) || Number(parentBars) <= 0) continue;

        const inheritedBars = Number(parentBars);
        data.total_bars = inheritedBars;
        const node = targetGraph.getNodeById(nodeId);
        if (node?.properties) {
            node.properties.total_bars = inheritedBars;
            node.properties.length_inherited = true;
            node.properties.length_source_id = data.parentId;
        }
    }
}

(window as any).syncArrangementLengthInheritance = () => syncArrangementLengthInheritance();

function syncGraphHierarchy(graph?: LGraph) {
    const targetGraph = graph || ((window as any).editorGraph as LGraph);
    if (!targetGraph) return;

    for (const data of trackNodes.values()) {
        const node = targetGraph.getNodeById(data.id);
        data.parentId = (data.type === 'modulator' || data.type === 'asset_filter')
            ? (node?.properties?.parentId ?? data.parentId ?? null)
            : null;
        data.children = [];
    }

    if ((targetGraph as any).links) {
        const links = (targetGraph as any).links;
        for (const linkId in links) {
            const link = links[linkId];
            if (!link) continue;

            const childId = link.origin_id;
            const parentId = link.target_id;

            const childData = trackNodes.get(childId);
            const parentData = trackNodes.get(parentId);

            if (childData) {
                childData.parentId = parentId;
            }
            if (parentData) {
                if (!parentData.children.includes(childId)) {
                    parentData.children.push(childId);
                }
            }
        }
    }

    syncBpmInheritance(targetGraph);
    syncArrangementLengthInheritance(targetGraph);
    updateMainPreviewTarget(targetGraph);
}

window.addEventListener('graph-connections-changed', () => {
    syncGraphHierarchy();
    updateGraphNodeCollapsing();
});

function updateGraphNodeCollapsing() {
    const graph = (window as any).editorGraph as LGraph;
    if (!graph) return;

    syncGraphHierarchy(graph);

    const canvas = (window as any).editorCanvas as LGraphCanvas;
    const selectedMap = canvas?.selected_nodes || {};

    for (const [nodeId, data] of trackNodes.entries()) {
        const lgraphNode = graph.getNodeById(nodeId);
        if (!lgraphNode) continue;

        if (data.type === "modulator" || data.type === "asset_filter" || lgraphNode.type === "Audio/Modulator" || lgraphNode.type === "Audio/AssetFilter") {
            const parentId = data.parentId || lgraphNode.properties?.parentId;

            const isParentSelected = parentId != null && Boolean(selectedMap[parentId]);
            const isSelfSelected = Boolean(selectedMap[nodeId]);

            if (isParentSelected || isSelfSelected) {
                lgraphNode.flags.collapsed = false;
                (lgraphNode as any).flags.hidden = false;
                (lgraphNode as any).collapsedDotMode = false;
            } else {
                lgraphNode.flags.collapsed = true;
                (lgraphNode as any).flags.hidden = false;
                (lgraphNode as any).collapsedDotMode = true;

                if (activeParamNodeId === nodeId) {
                    dockedPropertyPanels().forEach(panel => panel.api.close());
                }
            }
        } else if (data.parentId === null) {
            lgraphNode.flags.collapsed = false;
            (lgraphNode as any).flags.hidden = false;
        } else {
            const isSelfWindowOpen = (activeParamNodeId === nodeId);
            const isSelfChildParamOpen = isChildParamShown(nodeId);

            if (isSelfWindowOpen || isSelfChildParamOpen) {
                lgraphNode.flags.collapsed = false;
                (lgraphNode as any).flags.hidden = false;
            } else {
                lgraphNode.flags.collapsed = true;
                (lgraphNode as any).flags.hidden = false;
            }
        }
    }

    if ((window as any).editorCanvas) {
        (window as any).editorCanvas.setDirty(true, true);
    }
}

function isFloatingPanel(panel: IDockviewPanel | undefined): boolean {
    return panel?.group?.api?.location?.type === 'floating';
}

function propertyPanels(): IDockviewPanel[] {
    const dv = (window as any).dockview;
    return Array.from(dv?.panels || []).filter((panel: any) =>
        panel.id?.startsWith('properties_')
    ) as IDockviewPanel[];
}

function dockedPropertyPanels(exceptPanelId?: string): IDockviewPanel[] {
    return propertyPanels().filter(panel =>
        panel.id !== exceptPanelId && !isFloatingPanel(panel)
    );
}

function updatePanelToggleButtons() {
    const dv = (window as any).dockview;
    const libBtn = topHeader.querySelector('#header-toggle-library') as HTMLButtonElement | null;
    const propBtn = topHeader.querySelector('#header-toggle-properties') as HTMLButtonElement | null;

    if (dv && libBtn) {
        const p = dv.getGroupPanel('library_panel');
        if (p) {
            libBtn.classList.add('active');
        } else {
            libBtn.classList.remove('active');
        }
    }

    if (dv && propBtn) {
        const hasProp = dockedPropertyPanels().length > 0;
        if (hasProp) {
            propBtn.classList.add('active');
        } else {
            propBtn.classList.remove('active');
        }
    }
}

function toggleLibraryPanel(action: 'toggle' | 'open' | 'close' = 'toggle') {
    const dv = (window as any).dockview;
    if (!dv) return;

    const p = dv.getGroupPanel('library_panel');
    if (p) {
        if (action === 'toggle' || action === 'close') {
            p.api.close();
            updatePanelToggleButtons();
            return;
        }
        p.api.setActive();
        updatePanelToggleButtons();
        return;
    }

    if (action === 'close') return;

    const graphPanel = dv.getGroupPanel('graph_panel');
    if (!graphPanel) return;
    dv.addPanel({
        id: 'library_panel',
        component: 'library-panel',
        title: 'Library',
        position: {
            referencePanel: 'graph_panel',
            direction: 'left'
        },
        initialWidth: 210,
        minimumWidth: 150,
        maximumWidth: 315
    });
    updatePanelToggleButtons();
}

function openParamWindow(node: any, options?: { forceOpen?: boolean; toggle?: boolean; location?: 'right' | 'floating' }) {
    if (!node || node.id == null) return;
    if (node.type !== "Audio/Track" && node.type !== "Audio/Sample" && node.type !== "Audio/Sequence" && node.type !== "Audio/Arrangement" && node.type !== "Audio/Modulator" && node.type !== "Audio/AssetFilter") return;

    const dv = (window as any).dockview;
    if (!dv) return;

    const panelId = `properties_${node.id}`;
    let panel = dv.getGroupPanel(panelId) as IDockviewPanel | undefined;
    const previousDockedPanels = dockedPropertyPanels(panelId);
    const previousDockedPanel = previousDockedPanels[0];

    if (options?.toggle && panel) {
        panel.api.close();
        updatePanelToggleButtons();
        return;
    }

    (window as any)._currentlySelectedNode = node;
    if (panel) {
        if (!isFloatingPanel(panel)) {
            previousDockedPanels.forEach(previous => previous.api.close());
            activeParamNodeId = node.id;
        }
        panel.api.setActive();
        updateGraphNodeCollapsing();
        updatePanelToggleButtons();
        return;
    }

    const width = 380;
    const graphPanel = dv.getGroupPanel('graph_panel');

    const location = options?.location || 'right';
    if (location === 'floating' || !graphPanel) {
        panel = dv.addPanel({
            id: panelId,
            component: 'properties-panel',
            title: `Node Properties`,
            params: {
                nodeId: node.id
            }
        });
        const rightX = Math.max(20, window.innerWidth - width - 40);
        dv.addFloatingGroup(panel as any, {
            x: rightX,
            y: 50,
            width: width,
            height: 480
        });
    } else {
        activeParamNodeId = node.id;
        panel = dv.addPanel({
            id: panelId,
            component: 'properties-panel',
            title: `Node Properties`,
            params: {
                nodeId: node.id
            },
            position: {
                referencePanel: previousDockedPanel?.id || 'graph_panel',
                direction: previousDockedPanel ? 'within' : 'right'
            },
            initialWidth: width,
            minimumWidth: 260,
            maximumWidth: Math.max(width + 80, 580)
        });
    }
    // Close the old properties panel only after its replacement exists. This
    // keeps the dock group dimensions stable and avoids a full-canvas flash.
    if (location === 'right') previousDockedPanels.forEach(previous => previous.api.close());
    panel?.api.setActive();
    updateGraphNodeCollapsing();
    updatePanelToggleButtons();
}

function togglePropertiesDockMode(nodeId?: number) {
    const dv = (window as any).dockview;
    if (!dv) return;

    const targetId = nodeId ?? activeParamNodeId;
    if (targetId == null) return;

    const graph = (window as any).editorGraph;
    const node = graph?.getNodeById(targetId);
    if (!node) return;

    const panelId = `properties_${targetId}`;
    const p = dv.getGroupPanel(panelId);
    const isFloating = isFloatingPanel(p);

    if (!p) return;
    if (isFloating) dockedPropertyPanels(panelId).forEach(panel => panel.api.close());
    p.api.close();
    openParamWindow(node, { forceOpen: true, location: isFloating ? 'right' : 'floating' });
}

function togglePropertiesPanel() {
    const dv = (window as any).dockview;
    if (!dv) return;

    const dockedPanel = dockedPropertyPanels()[0];
    if (dockedPanel) {
        dockedPanel.api.close();
        updatePanelToggleButtons();
        return;
    }

    const graph = (window as any).editorGraph;
    let node = (window as any)._currentlySelectedNode;
    if (!node && graph) {
        const selected = graph._selected_nodes ? Object.values(graph._selected_nodes)[0] : null;
        if (selected) node = selected;
    }
    if (node) {
        openParamWindow(node);
    }
}

(window as any).openParamWindow = openParamWindow;

window.addEventListener('open-add-menu', (e: any) => {
    const parentId = e.detail?.parentId;
    const x = e.detail?.x || 100;
    const y = e.detail?.y || 100;
    popupMenu.show(x, y, (nodeType) => {
        if (parentId != null) {
            addChildNode(parentId, nodeType);
        } else {
            addRootNode(nodeType);
        }
    });
});

window.addEventListener('add-child-node', (e: any) => {
    const parentId = e.detail?.parentId;
    const nodeType = e.detail?.nodeType || "sample";
    if (parentId != null) {
        addChildNode(parentId, nodeType);
    }
});

window.addEventListener('add-modulator-node', (e: any) => {
    const parentId = e.detail?.parentId;
    if (parentId != null) {
        addModulatorNode(parentId);
    }
});

window.addEventListener('add-asset-filter-to-param', (e: any) => {
    const nodeId = e.detail?.nodeId;
    const graph = (window as any).editorGraph as LGraph;
    const ownerNode = nodeId != null ? graph?.getNodeById(nodeId) : null;
    if (!ownerNode || (ownerNode.type !== 'Audio/Sample' && ownerNode.type !== 'Audio/Sequence')) return;

    const assignedId = ownerNode.properties?.asset_modifier_id;
    let modifierNode = assignedId != null ? graph.getNodeById(assignedId) : null;
    if (!modifierNode) {
        modifierNode = (((graph as any)._nodes || []) as any[]).find(candidate =>
            candidate?.type === 'Audio/AssetFilter'
            && candidate?.properties?.parentId === nodeId
        ) || null;
    }
    if (!modifierNode) modifierNode = addAssetFilterNode(nodeId, false);
    if (!modifierNode) return;

    modifierNode.properties.accepted_asset_type = ownerNode.type === 'Audio/Sequence' ? 'sequence_source' : 'audio';
    if (ownerNode.type === 'Audio/Sequence') {
        (modifierNode as any).updateProperty('node_name', 'MIDI / Sequence Pool');
    }
    ownerNode.properties.asset_modifier_id = modifierNode.id;
    const ownerData = trackNodes.get(nodeId);
    if (ownerData) ownerData.asset_modifier_id = modifierNode.id;
    window.dispatchEvent(new CustomEvent('modifier-assignment-changed', { detail: { nodeId } }));
    openParamWindow(modifierNode, { forceOpen: true });
});

function addAssetFilterNode(parentId: number, openProperties: boolean = true) {
    return addModulatorNode(parentId, "asset_filter", openProperties);
}

function addModulatorNode(
    parentId: number,
    modifierKind: "modulator" | "asset_filter" = "modulator",
    openProperties: boolean = true
) {
    const graph = (window as any).editorGraph as LGraph;
    if (!graph) return;

    const parentNode = graph.getNodeById(parentId);
    if (!parentNode) return;

    const parentData = trackNodes.get(parentId);

    let modCount = 0;
    for (const data of trackNodes.values()) {
        if ((data.type === "modulator" || data.type === "asset_filter") && data.parentId === parentId) {
            modCount++;
        }
    }

    const isAssetFilter = modifierKind === "asset_filter";
    const modNode = LiteGraph.createNode(isAssetFilter ? "Audio/AssetFilter" : "Audio/Modulator");
    const modName = isAssetFilter ? `Asset Pool ${modCount + 1}` : `Modulator ${modCount + 1}`;
    modNode.properties.node_name = modName;
    modNode.properties.node_type = modifierKind;
    modNode.properties.parentId = parentId;
    modNode.title = modName;

    if (typeof (modNode as any).computeSize === 'function') {
        modNode.size = (modNode as any).computeSize();
    }

    const parentWidth = parentNode.size ? parentNode.size[0] : 200;
    const parentHeight = parentNode.size ? parentNode.size[1] : 44;
    const offsetX = (modCount - 0.5) * 210;

    modNode.pos = [
        parentNode.pos[0] + parentWidth * 0.5 - 90 + offsetX,
        parentNode.pos[1] + parentHeight + 60
    ];

    graph.add(modNode);

    trackNodes.set(modNode.id, {
        id: modNode.id,
        type: modifierKind,
        name: modName,
        filepath: "",
        original_bpm: 120,
        start_beat: 0,
        mix_mode: "sum",
        chain: modNode.properties.chain || [],
        parentId: parentId,
        children: []
    });

    if (parentData) {
        if (!parentData.modulators) parentData.modulators = [];
        parentData.modulators.push(modNode.id);
    }

    updateGraphNodeCollapsing();
    if (openProperties) openParamWindow(modNode);
    return modNode;
}

window.addEventListener('render-node', (e: any) => {
    const nodeId = e.detail?.nodeId;
    if (nodeId != null) {
        renderNode(nodeId);
    }
});

window.addEventListener('preview-node', (e: any) => {
    const changedNodeId = e.detail?.nodeId;
    // Legacy/custom controls may still emit parameter-change requests. Ignore
    // them so only an explicit node/context preview action performs calculation.
    if (changedNodeId != null && e.detail?.reason !== 'parameter-change') {
        previewNode(changedNodeId, true);
    }
});


window.addEventListener('delete-node', (e: any) => {
    const nodeId = e.detail?.nodeId;
    if (nodeId != null) {
        deleteNode(nodeId);
    }
});

window.addEventListener('node-removed', (e: any) => {
    const nodeId = e.detail?.nodeId;
    if (nodeId != null) {
        detachGhostDependents((window as any).editorGraph as LGraph, nodeId, e.detail?.properties);
        handleNodeRemoved(nodeId);
    }
});

window.addEventListener('create-ghost-node', (e: any) => {
    const graph = (window as any).editorGraph as LGraph;
    const source = graph?.getNodeById(e.detail?.nodeId);
    if (!graph || !source) return;
    const ghost: any = createGhostNode(source, graph);
    if (!ghost) return;
    const sourceData = trackNodes.get(source.id);
    if (sourceData) {
        trackNodes.set(ghost.id, {
            ...sourceData,
            id: ghost.id,
            parentId: null,
            children: [],
            chain: ghost.properties.chain
        });
    }
    syncGhostTrackData(ghost, trackNodes.get(ghost.id));
    const canvas = (window as any).editorCanvas as LGraphCanvas;
    canvas?.selectNode?.(ghost);
    canvas?.setDirty?.(true, true);
    openParamWindow(ghost, { forceOpen: true });
});

window.addEventListener('add-library-node', async (e: any) => {
    const filepath = e.detail?.filepath;
    const name = e.detail?.name;
    const itemType = e.detail?.itemType;

    if (filepath) {
        try {
            await addLibraryItemsToCanvas([{
                id: e.detail?.id,
                filepath,
                name,
                itemType,
                key: e.detail?.key,
                bpm: e.detail?.bpm,
                duration_seconds: e.detail?.duration_seconds
            }]);
        } catch (err) {
            console.error("Failed adding GAIA item to the graph", err);
        }
    }
});

function addChildNode(
    parentId: number,
    nodeType: "sample" | "track" | "sequence" | "item_pool" | "arrangement" = "sample",
    openProperties: boolean = true
) {
    const graph = (window as any).editorGraph as LGraph;
    if (!graph) return;

    const parentNode = graph.getNodeById(parentId);
    if (!parentNode) return;

    const parentData = trackNodes.get(parentId);
    if (!parentData) return;

    let typeStr = "Audio/Sample";
    let defaultName = "New Sample";
    if (nodeType === "track") {
        typeStr = "Audio/Track";
        defaultName = "Sub Track";
    } else if (nodeType === "sequence") {
        typeStr = "Audio/Sequence";
        defaultName = "Sequence";
    } else if (nodeType === "arrangement") {
        typeStr = "Audio/Arrangement";
        defaultName = "Arrangement";
    }

    const childNode = LiteGraph.createNode(typeStr);
    childNode.properties.node_name = defaultName;
    childNode.properties.node_type = nodeType;
    childNode.properties.filepath = "";
    childNode.properties.original_bpm = 120;
    childNode.properties.start_beat = 0;
    childNode.properties.mix_mode = "sum";
    if (nodeType === "sequence") {
        childNode.properties.sequence = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
        childNode.properties.step_length = 0.25;
        childNode.properties.fade_ms = 0;
    } else if (nodeType === "arrangement") {
        childNode.properties.total_bars = 4.0;
        childNode.properties.section_points = [];
        childNode.properties.section_probability = [1.0];
        childNode.properties.section_sample_start = [0.0];
        childNode.properties.section_quant = ["none"];
        childNode.properties.section_quant_anchor = ["start"];
    } else if (nodeType === "track") {
        childNode.properties.bpm = 'global';
        childNode.properties.total_bars = 'global';
    }
    childNode.title = defaultName;
    if (typeof (childNode as any).computeSize === 'function') {
        childNode.size = (childNode as any).computeSize();
    }

    // Visual themes
    if (nodeType === "sample") {
        const sampleColors = [
            { color: "#10b981", bgcolor: "#10b981", boxcolor: "#059669" },
            { color: "#f59e0b", bgcolor: "#f59e0b", boxcolor: "#d97706" },
            { color: "#8b5cf6", bgcolor: "#8b5cf6", boxcolor: "#7c3aed" }
        ];
        const theme = sampleColors[parentData.children.length % sampleColors.length];
        childNode.color = theme.color;
        childNode.bgcolor = theme.bgcolor;
        childNode.boxcolor = theme.boxcolor;
    } else if (nodeType === "sequence") {
        childNode.color = "#ec4899";
        childNode.bgcolor = "#ec4899";
        childNode.boxcolor = "#db2777";
    } else if (nodeType === "item_pool") {
        childNode.color = "#8b5cf6";
        childNode.bgcolor = "#8b5cf6";
        childNode.boxcolor = "#7c3aed";
    } else if (nodeType === "arrangement") {
        childNode.color = "#f59e0b";
        childNode.bgcolor = "#f59e0b";
        childNode.boxcolor = "#d97706";
    } else {
        childNode.color = "#3b82f6";
        childNode.bgcolor = "#3b82f6";
        childNode.boxcolor = "#2563eb";
    }

    graph.add(childNode);

    // Position node neatly relative to parent (above parent so signal flows down into parent input)
    const childCount = parentData.children.length + 1;
    const spacing = 260;
    const startX = parentNode.pos[0] - ((childCount - 1) * spacing) / 2;

    childNode.pos = [startX + (childCount - 1) * spacing, parentNode.pos[1] - 120];

    // Find first free input slot on parent
    let targetSlot = 0;
    if (parentNode.inputs) {
        for (let i = 0; i < parentNode.inputs.length; i++) {
            if (parentNode.inputs[i].link == null) {
                targetSlot = i;
                break;
            }
        }
    }
    
    // Connect link in LiteGraph: Child output (0) -> Parent free input
    childNode.connect(0, parentNode, targetSlot);

    // Update parent's children record
    parentData.children.push(childNode.id);

    // Register node data
    trackNodes.set(childNode.id, {
        id: childNode.id,
        type: nodeType,
        name: defaultName,
        filepath: "",
        original_bpm: 120,
        start_beat: 0,
        mix_mode: "sum",
        sequence: nodeType === "sequence" ? [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] : undefined,
        step_length: nodeType === "sequence" ? 0.25 : undefined,
        play_mode: nodeType === "sequence" ? "gate" : undefined,
        fade_ms: nodeType === "sequence" ? 0 : undefined,
        bpm: nodeType === 'track' ? 'global' : undefined,
        target_bpm: nodeType === 'track' ? globalParameters.bpm : undefined,
        total_bars: nodeType === "arrangement" ? 4.0 : nodeType === 'track' ? 'global' : undefined,
        section_points: nodeType === "arrangement" ? [] : undefined,
        section_probability: nodeType === "arrangement" ? [1.0] : undefined,
        section_sample_start: nodeType === "arrangement" ? [0.0] : undefined,
        section_quant: nodeType === "arrangement" ? ["none"] : undefined,
        section_quant_anchor: nodeType === "arrangement" ? ["start"] : undefined,
        parentId: parentId,
        children: []
    });

    // The connection is created before the data record exists, so run one
    // explicit hierarchy pass now to inherit BPM and master length immediately.
    syncGraphHierarchy(graph);

    // Re-align all siblings above parent for horizontal symmetry
    parentData.children.forEach((cid, i) => {
        const sibling = graph.getNodeById(cid);
        if (sibling) {
            sibling.pos = [startX + i * spacing, parentNode.pos[1] - 120];
        }
    });

    if (openProperties) {
        openParamWindow(childNode);
    }
    return childNode;
}

function deleteNode(nodeId: number) {
    const graph = (window as any).editorGraph as LGraph;
    if (!graph) return;

    const lgraphNode = graph.getNodeById(nodeId);
    if (lgraphNode) {
        graph.remove(lgraphNode); // Triggers onRemoved lifecycle hook & 'node-removed' event
    } else {
        handleNodeRemoved(nodeId);
    }
}

function handleNodeRemoved(nodeId: number) {
    const graph = (window as any).editorGraph as LGraph;
    const nodeData = trackNodes.get(nodeId);

    // Removing an Asset Pool modifier disconnects every Sample that references it.
    for (const [candidateId, candidateData] of trackNodes.entries()) {
        const candidateNode = graph?.getNodeById(candidateId);
        const assignedId = candidateNode?.properties?.asset_modifier_id ?? candidateData.asset_modifier_id;
        if (assignedId === nodeId) {
            if (candidateNode?.properties) delete candidateNode.properties.asset_modifier_id;
            delete candidateData.asset_modifier_id;
            window.dispatchEvent(new CustomEvent('modifier-assignment-changed', { detail: { nodeId: candidateId } }));
        }
        if (candidateData.modulators?.includes(nodeId)) {
            candidateData.modulators = candidateData.modulators.filter(id => id !== nodeId);
        }
    }

    if (nodeData) {
        // Unlink from parent data structure
        if (nodeData.parentId != null) {
            const parentData = trackNodes.get(nodeData.parentId);
            if (parentData) {
                parentData.children = parentData.children.filter(id => id !== nodeId);
            }
        }

        // Recursively remove children
        const childrenToDelete = [...nodeData.children];
        for (const childId of childrenToDelete) {
            if (graph) {
                const childNode = graph.getNodeById(childId);
                if (childNode) {
                    graph.remove(childNode);
                } else {
                    handleNodeRemoved(childId);
                }
            }
        }

        trackNodes.delete(nodeId);
    }

    // Close associated properties panel if open
    const dv = (window as any).dockview;
    if (dv) {
        const panelId = `properties_${nodeId}`;
        const panel = dv.getGroupPanel(panelId);
        if (panel) panel.api.close();
    }

    if ((window as any)._currentlySelectedNode?.id === nodeId) {
        (window as any)._currentlySelectedNode = null;
    }

    if (activeParamNodeId === nodeId) {
        activeParamNodeId = null;
    }
    updateGraphNodeCollapsing();
}

installSeparatedNodeClipboard(() => {
    const graph = (window as any).editorGraph as LGraph;
    if (!graph) return;
    rebuildTrackNodesFromGraph(graph);
    syncGraphHierarchy(graph);
    updateGraphNodeCollapsing();
    window.dispatchEvent(new CustomEvent('graph-connections-changed'));
});

function addRootNode(
    nodeType: "sample" | "track" | "sequence" | "item_pool" | "arrangement" = "track",
    pos?: [number, number],
    filepath?: string,
    customName?: string,
    metaKey?: string,
    metaBpm?: number
) {
    const graph = (window as any).editorGraph as LGraph;
    if (!graph) return;

    let typeStr = "Audio/Track";
    let defaultName = "Master Track";
    if (nodeType === "sample") {
        typeStr = "Audio/Sample";
        defaultName = "Sample";
    } else if (nodeType === "sequence") {
        typeStr = "Audio/Sequence";
        defaultName = "Sequence";
    } else if (nodeType === "arrangement") {
        typeStr = "Audio/Arrangement";
        defaultName = "Arrangement";
    }

    const rootNode = LiteGraph.createNode(typeStr);
    rootNode.pos = pos ? [pos[0], pos[1]] : [350 + Math.random() * 40, 100 + Math.random() * 40];
    rootNode.properties.node_name = customName || defaultName;
    rootNode.properties.filepath = filepath || "";
    rootNode.properties.mix_mode = "sum";

    let extractedBpm = metaBpm;
    let extractedKey = metaKey;
    if (filepath && (!extractedBpm || !extractedKey)) {
        const meta = extractMetadataFromPath(filepath);
        if (!extractedBpm && meta.bpm) extractedBpm = meta.bpm;
        if (!extractedKey && meta.key) extractedKey = meta.key;
    }

    const origBpm = extractedBpm || 120;
    const keyStr = extractedKey || "";
    const targetBpm = origBpm;

    rootNode.properties.original_bpm = origBpm;
    rootNode.properties.target_bpm = nodeType === 'track' ? globalParameters.bpm : targetBpm;
    rootNode.properties.bpm = nodeType === 'track' ? 'global' : targetBpm;
    rootNode.properties.key = keyStr;

    if (nodeType === "sequence") {
        rootNode.properties.sequence = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
        rootNode.properties.step_length = 0.25;
        rootNode.properties.fade_ms = 0;
    } else if (nodeType === "arrangement") {
        rootNode.properties.total_bars = 4.0;
        rootNode.properties.section_points = [];
        rootNode.properties.section_probability = [1.0];
        rootNode.properties.section_sample_start = [0.0];
        rootNode.properties.section_quant = ["none"];
        rootNode.properties.section_quant_anchor = ["start"];
    } else if (nodeType === "track") {
        rootNode.properties.total_bars = 'global';
    }
    rootNode.title = customName || defaultName;
    if (typeof (rootNode as any).computeSize === 'function') {
        rootNode.size = (rootNode as any).computeSize();
    }

    if (nodeType === "sample") {
        rootNode.color = "#10b981";
        rootNode.bgcolor = "#10b981";
        rootNode.boxcolor = "#059669";
    } else if (nodeType === "sequence") {
        rootNode.color = "#ec4899";
        rootNode.bgcolor = "#ec4899";
        rootNode.boxcolor = "#db2777";
    } else if (nodeType === "item_pool") {
        rootNode.color = "#8b5cf6";
        rootNode.bgcolor = "#8b5cf6";
        rootNode.boxcolor = "#7c3aed";
    } else if (nodeType === "arrangement") {
        rootNode.color = "#f59e0b";
        rootNode.bgcolor = "#f59e0b";
        rootNode.boxcolor = "#d97706";
    } else {
        rootNode.color = "#4f46e5";
        rootNode.bgcolor = "#4f46e5";
        rootNode.boxcolor = "#4338ca";
    }

    graph.add(rootNode);

    trackNodes.set(rootNode.id, {
        id: rootNode.id,
        type: nodeType,
        name: customName || defaultName,
        filepath: filepath || "",
        original_bpm: origBpm,
        target_bpm: nodeType === 'track' ? globalParameters.bpm : targetBpm,
        bpm: nodeType === 'track' ? 'global' : targetBpm,
        key: keyStr,
        start_beat: 0,
        mix_mode: "sum",
        sequence: nodeType === "sequence" ? [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] : undefined,
        step_length: nodeType === "sequence" ? 0.25 : undefined,
        fade_ms: nodeType === "sequence" ? 0 : undefined,
        total_bars: nodeType === "arrangement" ? 4.0 : nodeType === 'track' ? 'global' : undefined,
        section_points: nodeType === "arrangement" ? [] : undefined,
        section_probability: nodeType === "arrangement" ? [1.0] : undefined,
        section_sample_start: nodeType === "arrangement" ? [0.0] : undefined,
        section_quant: nodeType === "arrangement" ? ["none"] : undefined,
        section_quant_anchor: nodeType === "arrangement" ? ["start"] : undefined,
        parentId: null,
        children: []
    });

    updateMainPreviewTarget(graph);

    if ((window as any).editorCanvas) {
        (window as any).editorCanvas.setDirty(true, true);
    }
    return rootNode;
}

async function applyLibraryItemToSample(node: any, item: LibraryDragItem) {
    if (!node?.properties || isMidiLibraryItem(item)) return false;

    const files = await resolveLibraryAssets([item]);
    const latest = refreshLibraryAssetSnapshot(item, files);

    const metadata = extractMetadataFromPath(item.filepath);
    const originalBpm = item.bpm || metadata.bpm || node.properties.original_bpm || 120;
    const targetBpm = node.properties.target_bpm || originalBpm;
    const nodeName = item.name || item.filepath.split(/[\\/]/).pop() || "Sample";
    const sampleType = item.itemType === "one_shot" ? "one_shot" : "loop";

    Object.assign(node.properties, {
        node_name: nodeName,
        node_type: "sample",
        filepath: item.filepath,
        sample_type: sampleType,
        original_bpm: originalBpm,
        target_bpm: targetBpm,
        bpm: targetBpm,
        key: latest ? String(latest.key ?? '') : (item.key || metadata.key || ""),
        duration_seconds: item.duration_seconds ?? undefined
    });
    node.title = nodeName;

    const data = trackNodes.get(node.id);
    if (data) {
        Object.assign(data, {
            type: "sample",
            name: nodeName,
            filepath: item.filepath,
            sample_type: sampleType,
            original_bpm: originalBpm,
            target_bpm: targetBpm,
            bpm: targetBpm,
            key: latest ? String(latest.key ?? '') : (item.key || metadata.key || ""),
            duration_seconds: item.duration_seconds ?? undefined
        });
    }

    node.setDirtyCanvas?.(true, true);
    window.dispatchEvent(new CustomEvent('arrangement-source-changed', {
        detail: { nodeId: node.id },
    }));
    return true;
}

async function applyLibraryItemToSequence(node: any, item: LibraryDragItem) {
    if (!node?.properties || !isSequenceSourceLibraryItem(item)) return false;

    if (isSavedSequenceLibraryItem(item)) {
        const response = await fetch('/api/sequence/parse', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filepath: item.filepath, file_id: item.id })
        });
        const document = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(document.detail || `Sequence loading failed (${response.status})`);
        if (typeof node.applySequenceDocument !== 'function') {
            throw new Error('Node cannot load saved sequence files');
        }
        node.applySequenceDocument(document);
        node.updateProperty('filepath', item.filepath);
        if (item.id != null) node.updateProperty('library_item_id', item.id);
        node.setDirtyCanvas?.(true, true);
        return true;
    }

    const response = await fetch('/api/midi/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filepath: item.filepath })
    });
    if (!response.ok) {
        throw new Error(`MIDI parsing failed (${response.status})`);
    }

    const parsed = await response.json();
    if (!Array.isArray(parsed.sequence) || parsed.sequence.length === 0) {
        throw new Error("MIDI file did not contain a playable sequence");
    }

    const sourceName = item.name || item.filepath.split(/[\\/]/).pop() || "Sequence";
    const nodeName = sourceName.replace(/\.(?:mid|midi)$/i, '') || "Sequence";
    Object.assign(node.properties, {
        node_name: nodeName,
        node_type: "sequence",
        filepath: item.filepath,
        sequence: [...parsed.sequence],
        step_parameters: Array.isArray(parsed.step_parameters)
            ? parsed.step_parameters.map((step: any) => ({ ...step }))
            : node.properties.step_parameters,
        original_bpm: parsed.bpm || item.bpm || node.properties.original_bpm || 120
    });
    node.title = nodeName;

    const data = trackNodes.get(node.id);
    if (data) {
        data.name = nodeName;
        data.filepath = item.filepath;
        data.sequence = [...parsed.sequence];
        data.step_parameters = Array.isArray(parsed.step_parameters)
            ? parsed.step_parameters.map((step: any) => ({ ...step }))
            : node.properties.step_parameters;
        data.original_bpm = parsed.bpm || item.bpm || data.original_bpm || 120;
    }

    node.setDirtyCanvas?.(true, true);
    return true;
}
(window as any).applyLibraryItemToSequence = applyLibraryItemToSequence;

function addLibraryItemsToPool(node: any, items: LibraryDragItem[]) {
    if (!node?.properties || items.length === 0) return false;

    const existing = Array.isArray(node.properties.selected_items) ? node.properties.selected_items : [];
    const byKey = new Map<string, any>();
    for (const item of existing) {
        // Several files inside one GAIA collection can carry the same parent
        // item ID, so identity must prefer the contained asset's exact path.
        const key = String(item.absolute_path ?? item.filepath ?? item.id ?? "")
            .replace(/\\/g, '/').toLocaleLowerCase();
        if (key) byKey.set(key, item);
    }
    for (const item of items) {
        if (item.id == null || !String(item.id).trim()) {
            throw new Error('Cannot add a library item without its GAIA id to an Asset Pool');
        }
        const poolItem = {
            id: item.id,
            absolute_path: item.filepath,
            filepath: item.filepath,
            name: item.name || item.filepath.split(/[\\/]/).pop(),
            type: item.itemType || (isSavedSequenceLibraryItem(item) ? "sequence" : isMidiLibraryItem(item) ? "midi" : "audio"),
            key: item.key || null,
            bpm: item.bpm || null,
            duration_seconds: item.duration_seconds || null
        };
        const key = String(item.filepath || item.id || '')
            .replace(/\\/g, '/').toLocaleLowerCase();
        if (key) byKey.set(key, poolItem);
    }

    const selectedItems = [...byKey.values()];
    node.properties.selected_items = selectedItems;
    node.properties.seed = Math.random();
    const data = trackNodes.get(node.id);
    if (data) {
        data.selected_items = selectedItems;
        data.seed = node.properties.seed;
    }
    node.setDirtyCanvas?.(true, true);
    window.dispatchEvent(new CustomEvent('item-pool-preview-refresh', { detail: { nodeId: node.id } }));
    return true;
}

function findDirectSampleChild(parentId: number) {
    const graph = (window as any).editorGraph as LGraph;
    const parentData = trackNodes.get(parentId);
    if (!graph || !parentData) return null;

    for (const childId of parentData.children) {
        const child = graph.getNodeById(childId);
        if (child?.type === "Audio/Sample") return child;
    }
    return null;
}

async function attachLibrarySampleToSequence(sequenceNode: any, item: LibraryDragItem) {
    let sampleNode: any = findDirectSampleChild(sequenceNode.id);
    if (!sampleNode) {
        sampleNode = addChildNode(sequenceNode.id, "sample", false);
    }
    if (!sampleNode) return false;

    const applied = await applyLibraryItemToSample(sampleNode, item);
    if (applied) {
        syncGraphHierarchy();
        updateGraphNodeCollapsing();
    }
    return applied;
}

async function applyLibraryDropToNode(node: any, items: LibraryDragItem[]) {
    if (!node || items.length === 0) return false;

    if (node.type === "Audio/Sample") {
        const sample = items.find(item => !isMidiLibraryItem(item));
        return sample ? await applyLibraryItemToSample(node, sample) : false;
    }

    if (node.type === "Audio/Sequence") {
        let applied = false;
        const sequenceSource = items.find(isSequenceSourceLibraryItem);
        const sample = items.find(item => !isSequenceSourceLibraryItem(item));
        if (sequenceSource) applied = await applyLibraryItemToSequence(node, sequenceSource) || applied;
        if (sample) applied = await attachLibrarySampleToSequence(node, sample) || applied;
        return applied;
    }

    if (node.type === "Audio/AssetFilter") {
        return addLibraryItemsToPool(node, items);
    }

    // Track and arrangement nodes are containers: dropped assets become connected children.
    let applied = false;
    for (const item of items) {
        if (isSequenceSourceLibraryItem(item)) {
            const sequence = addChildNode(node.id, "sequence", false);
            if (sequence) {
                await applyLibraryItemToSequence(sequence, item);
                applied = true;
            }
        } else {
            const sample = addChildNode(node.id, "sample", false);
            if (sample) applied = await applyLibraryItemToSample(sample, item) || applied;
        }
    }
    if (applied) {
        syncGraphHierarchy();
        updateGraphNodeCollapsing();
    }
    return applied;
}

async function addLibraryItemsToCanvas(items: LibraryDragItem[], canvasPos?: [number, number]) {
    for (let index = 0; index < items.length; index++) {
        const item = items[index];
        const pos: [number, number] | undefined = canvasPos
            ? [canvasPos[0] + index * 90, canvasPos[1]]
            : undefined;
        if (isSequenceSourceLibraryItem(item)) {
            const sequence = addRootNode("sequence", pos, item.filepath, item.name, item.key || undefined, item.bpm || undefined);
            if (sequence) await applyLibraryItemToSequence(sequence, item);
        } else {
            const sample = addRootNode("sample", pos, item.filepath, item.name, item.key || undefined, item.bpm || undefined);
            if (sample) await applyLibraryItemToSample(sample, item);
        }
    }
}

type StageSaveState = 'loading' | 'saved' | 'saving' | 'unsaved' | 'error';

let stageSaveStatus: HTMLElement | null = null;
let stageSaveTimer: number | null = null;
let stageSaveInFlight = false;
let stageSaveCompletion: Promise<void> | null = null;
let resolveStageSaveCompletion: (() => void) | null = null;
let stageSaveQueued = false;
let stageHydrating = false;
let stageReady = false;
let lastSavedStageFingerprint: string | null = null;

function setStageSaveState(state: StageSaveState, title?: string) {
    if (!stageSaveStatus) return;
    const labels: Record<StageSaveState, string> = {
        loading: 'Loading last stage',
        saved: 'All changes saved',
        saving: 'Saving current stage',
        unsaved: 'Changes waiting to be saved',
        error: 'Could not save current stage'
    };
    const label = title || labels[state];
    stageSaveStatus.dataset.state = state;
    stageSaveStatus.title = label;
    stageSaveStatus.setAttribute('aria-label', label);
}

function createCurrentStage(graph: LGraph) {
    const graphData = serializeWorkspaceGraph(graph);
    return {
        fingerprint: JSON.stringify(graphData),
        stage: {
            version: WORKSPACE_PRESET_VERSION,
            savedAt: new Date().toISOString(),
            graph: graphData
        }
    };
}

function cancelScheduledStageSave() {
    if (stageSaveTimer !== null) {
        window.clearTimeout(stageSaveTimer);
        stageSaveTimer = null;
    }
    stageSaveQueued = false;
}

function scheduleStageSave(delay = 650) {
    if (!stageReady || stageHydrating) return;
    const graph = (window as any).editorGraph as LGraph;
    if (!graph) return;

    const current = createCurrentStage(graph);
    if (current.fingerprint === lastSavedStageFingerprint) {
        if (!stageSaveInFlight) setStageSaveState('saved');
        return;
    }

    setStageSaveState('unsaved');
    if (stageSaveTimer !== null) window.clearTimeout(stageSaveTimer);
    stageSaveTimer = window.setTimeout(() => {
        stageSaveTimer = null;
        void saveCurrentStage();
    }, delay);
}

async function saveCurrentStage() {
    if (!stageReady || stageHydrating) return;
    const graph = (window as any).editorGraph as LGraph;
    if (!graph) return;
    if (stageSaveInFlight) {
        stageSaveQueued = true;
        return;
    }

    const current = createCurrentStage(graph);
    if (current.fingerprint === lastSavedStageFingerprint) {
        setStageSaveState('saved');
        return;
    }

    stageSaveInFlight = true;
    stageSaveCompletion = new Promise<void>(resolve => { resolveStageSaveCompletion = resolve; });
    setStageSaveState('saving');
    const saveStartedAt = performance.now();
    runtimeLog('Saving current stage started', 'debug');
    try {
        const response = await fetch('/api/stage', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            keepalive: true,
            body: JSON.stringify({ stage: current.stage })
        });
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.detail || `Could not save current stage (${response.status})`);
        }
        lastSavedStageFingerprint = current.fingerprint;
        const latest = createCurrentStage(graph).fingerprint;
        setStageSaveState(latest === lastSavedStageFingerprint ? 'saved' : 'unsaved');
        runtimeLog(`Saving current stage complete (${Math.round(performance.now() - saveStartedAt)} ms)`, 'debug');
    } catch (error) {
        console.error('Could not auto-save current stage', error);
        setStageSaveState('error');
        runtimeLog(`Saving current stage failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
        stageSaveInFlight = false;
        const resolveCompletion = resolveStageSaveCompletion;
        resolveStageSaveCompletion = null;
        stageSaveCompletion = null;
        resolveCompletion?.();
        if (stageSaveQueued) {
            stageSaveQueued = false;
            scheduleStageSave(0);
        }
    }
}

async function restoreCurrentStage(graph: LGraph, canvas: LGraphCanvas): Promise<boolean> {
    setStageSaveState('loading');
    stageHydrating = true;
    const restoreStartedAt = performance.now();
    runtimeLog('Restoring current stage started', 'debug');
    try {
        const response = await fetch('/api/stage');
        if (response.status === 404) {
            lastSavedStageFingerprint = createCurrentStage(graph).fingerprint;
            setStageSaveState('saved', 'No saved work yet');
            runtimeLog(`No saved stage found (${Math.round(performance.now() - restoreStartedAt)} ms)`, 'common');
            return false;
        }
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.detail || `Could not load current stage (${response.status})`);
        }

        const data = await response.json();
        const stage = data.stage;
        if (!stage?.graph) throw new Error('The saved stage does not contain a graph.');

        closeAllParamWindows();
        activeParamNodeId = null;
        graph.configure(prepareWorkspaceGraph(stage.graph));
        rebuildTrackNodesFromGraph(graph);
        loadGlobalParametersFromGraph(graph);
        updateGraphNodeCollapsing();
        canvas.setDirty(true, true);
        lastSavedStageFingerprint = JSON.stringify(stage.graph);
        setStageSaveState('saved');
        runtimeLog(`Restoring current stage complete (${Math.round(performance.now() - restoreStartedAt)} ms)`, 'common');
        return true;
    } catch (error) {
        console.error('Could not restore current stage', error);
        setStageSaveState('error', 'Could not load last stage');
        runtimeLog(`Restoring current stage failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
        return false;
    } finally {
        stageHydrating = false;
        stageReady = true;
    }
}

function installStageAutosave(graph: LGraph, canvas: HTMLCanvasElement) {
    const graphWithCallbacks = graph as any;
    const previousAfterChange = graphWithCallbacks.onAfterChange;
    graphWithCallbacks.onAfterChange = (...args: any[]) => {
        previousAfterChange?.apply(graph, args);
        scheduleStageSave();
    };

    const previousNodeAdded = graphWithCallbacks.onNodeAdded;
    graphWithCallbacks.onNodeAdded = (node: any) => {
        previousNodeAdded?.call(graph, node);
        scheduleStageSave();
    };

    const previousNodeRemoved = graphWithCallbacks.onNodeRemoved;
    graphWithCallbacks.onNodeRemoved = (node: any) => {
        previousNodeRemoved?.call(graph, node);
        scheduleStageSave();
    };

    // LiteGraph finalizes node dragging on mouseup.  The fingerprint check in
    // scheduleStageSave keeps ordinary clicks from producing network writes.
    canvas.addEventListener('mouseup', () => scheduleStageSave());
}

window.addEventListener('node-property-changed', () => scheduleStageSave());
window.addEventListener('graph-connections-changed', () => scheduleStageSave());
window.addEventListener('global-parameters-changed', () => scheduleStageSave());
window.addEventListener('set-main-preview-node', () => scheduleStageSave());
window.addEventListener('pagehide', () => {
    if (!stageReady || stageHydrating) return;
    const graph = (window as any).editorGraph as LGraph;
    if (!graph) return;
    const current = createCurrentStage(graph);
    if (current.fingerprint === lastSavedStageFingerprint) return;
    const body = new Blob([JSON.stringify({ stage: current.stage })], { type: 'application/json' });
    if (!navigator.sendBeacon('/api/stage', body)) void saveCurrentStage();
});

const dockview = new DockviewComponent(dockviewContainer, {
    createComponent: (options: any) => {
        const element = document.createElement('div');
        let disposeComponent = () => { };
        element.style.width = '100%';
        element.style.height = '100%';
        element.style.position = 'relative';

        switch (options.name) {
            case 'graph-editor': {
                const canvas = document.createElement('canvas');
                canvas.id = 'graph-canvas';
                canvas.style.width = '100%';
                canvas.style.height = '100%';
                canvas.style.display = 'block';
                canvas.style.backgroundColor = '#ffffff';
                element.appendChild(canvas);

                requestAnimationFrame(async () => {
                    const graph = new LGraph();
                    (window as any).editorGraph = graph;
                    loadGlobalParametersFromGraph(graph);

                    // Render connections on top of main canvas so they update live in real-time during node drag
                    if (!graph.config) graph.config = {};
                    (graph.config as any).links_ontop = true;

                    const graphCanvas = new LGraphCanvas(canvas, graph);
                    (window as any).editorCanvas = graphCanvas;

                    graphCanvas.ds.scale = 1.0;

                    // Direct 1-to-1 linear straight connections (Point A to Point B)
                    graphCanvas.links_render_mode = LiteGraph.LINEAR_LINK;
                    graphCanvas.render_curved_connections = false;
                    graphCanvas.render_connection_arrows = false;
                    graphCanvas.render_connections_border = false;
                    graphCanvas.render_connections_shadows = false;
                    graphCanvas.default_link_color = "#94a3b8";
                    graphCanvas.connections_width = 2;

                    // Suppress drawing connection dots / anchor points
                    (graphCanvas as any).drawSlot = function () { };

                    (graph as any).onNodeConnectionChange = function () {
                        syncGraphHierarchy(graph);
                        updateGraphNodeCollapsing();
                    };

                    // Clean white canvas background without grid fade
                    graphCanvas.clear_background = true;
                    (graphCanvas as any).clear_background_color = "#ffffff";
                    (graphCanvas as any).background_image = null;
                    (graphCanvas as any).zoom_modify_alpha = false;
                    (graphCanvas as any).render_canvas_border = false;
                    // Hide LiteGraph's diagnostic overlay (coordinates, graph counts, and FPS).
                    graphCanvas.show_info = false;

                    (graphCanvas as any).onDrawForeground = function (ctx: CanvasRenderingContext2D) {
                        const nodesList = (graph as any)?._nodes;
                        if (!graph || !nodesList) return;

                        ctx.save();
                        // Ghost relationships are visual metadata rather than audio
                        // graph links. Draw a dotted edge between the two node borders.
                        for (const ghost of nodesList) {
                            if (!isGhostNode(ghost) || (ghost.flags as any)?.hidden) continue;
                            const source = graph.getNodeById(ghost.properties?.ghost_source_id);
                            if (!source || (source.flags as any)?.hidden) continue;

                            const sourceWidth = source.size?.[0] || 64;
                            const sourceHeight = source.size?.[1] || 64;
                            const ghostWidth = ghost.size?.[0] || 64;
                            const ghostHeight = ghost.size?.[1] || 64;
                            const sourceCenter = [source.pos[0] + sourceWidth / 2, source.pos[1] + sourceHeight / 2];
                            const ghostCenter = [ghost.pos[0] + ghostWidth / 2, ghost.pos[1] + ghostHeight / 2];
                            const dx = ghostCenter[0] - sourceCenter[0];
                            const dy = ghostCenter[1] - sourceCenter[1];
                            if (!dx && !dy) continue;

                            const sourceScale = 1 / Math.max(Math.abs(dx) / (sourceWidth / 2), Math.abs(dy) / (sourceHeight / 2));
                            const ghostScale = 1 / Math.max(Math.abs(dx) / (ghostWidth / 2), Math.abs(dy) / (ghostHeight / 2));

                            ctx.save();
                            ctx.beginPath();
                            ctx.moveTo(sourceCenter[0] + dx * sourceScale, sourceCenter[1] + dy * sourceScale);
                            ctx.lineTo(ghostCenter[0] - dx * ghostScale, ghostCenter[1] - dy * ghostScale);
                            ctx.setLineDash([3, 5]);
                            ctx.lineWidth = 1.75;
                            ctx.lineCap = "round";
                            ctx.strokeStyle = "#8b5cf6";
                            ctx.stroke();
                            ctx.restore();
                        }

                        // Modifier ownership is represented as a dedicated
                        // control cable into the parent's footer inlet. It is
                        // visual metadata, not an audio graph link.
                        for (const node of nodesList) {
                            if (!node || (node.flags as any)?.hidden) continue;
                            const isMod = node.type === "Audio/Modulator"
                                || node.type === "Audio/AssetFilter"
                                || node.properties?.node_type === "modulator"
                                || node.properties?.node_type === "asset_filter";

                            if (!isMod) {
                                if (node.flags?.collapsed) continue;
                                const width = node.size?.[0] || 200;
                                const height = node.size?.[1] || 44;
                                const inletX = node.pos[0] + width * 0.5;
                                const inletY = node.pos[1] + height;

                                ctx.beginPath();
                                ctx.arc(inletX, inletY, 6, 0, Math.PI * 2);
                                ctx.fillStyle = "rgba(147, 51, 234, 0.2)";
                                ctx.fill();

                                ctx.beginPath();
                                ctx.arc(inletX, inletY, 4, 0, Math.PI * 2);
                                ctx.fillStyle = "#9333ea";
                                ctx.fill();
                                ctx.lineWidth = 1.5;
                                ctx.strokeStyle = "#ffffff";
                                ctx.stroke();
                                continue;
                            }

                            const parentId = node.properties?.parentId;
                            if (parentId == null) continue;
                            const parentNode = graph.getNodeById(parentId);
                            if (!parentNode || (parentNode.flags as any)?.hidden) continue;

                            const parentWidth = parentNode.size?.[0] || 44;
                            const parentHeight = parentNode.size?.[1] || 44;
                            const parentX = parentNode.pos[0] + parentWidth * 0.5;
                            const parentY = parentNode.pos[1] + parentHeight;
                            const modWidth = node.size?.[0] || 44;
                            const modX = node.pos[0] + modWidth * 0.5;
                            const modY = (node as any).collapsedDotMode
                                ? node.pos[1] + 10
                                : node.pos[1];

                            ctx.beginPath();
                            ctx.moveTo(parentX, parentY);
                            ctx.lineTo(modX, modY);
                            ctx.lineWidth = 2.5;
                            ctx.strokeStyle = "#a855f7";
                            ctx.lineCap = "round";
                            ctx.stroke();

                            if ((node as any).collapsedDotMode) {
                                ctx.beginPath();
                                ctx.arc(modX, modY, 7.5, 0, Math.PI * 2);
                                ctx.fillStyle = "rgba(147, 51, 234, 0.25)";
                                ctx.fill();

                                ctx.beginPath();
                                ctx.arc(modX, modY, 4.5, 0, Math.PI * 2);
                                ctx.fillStyle = "#9333ea";
                                ctx.fill();
                                ctx.lineWidth = 1.5;
                                ctx.strokeStyle = "#ffffff";
                                ctx.stroke();
                            } else {
                                ctx.beginPath();
                                ctx.arc(modX, modY, 3.5, 0, Math.PI * 2);
                                ctx.fillStyle = "#c084fc";
                                ctx.fill();
                            }
                        }

                        ctx.restore();
                    };
                    if (graphCanvas.bgcanvas) {
                        graphCanvas.bgcanvas.style.backgroundColor = "#ffffff";
                    }

                    // Context Menu Override for Nodes & Canvas right-clicks
                    graphCanvas.processContextMenu = function (node: any, e: MouseEvent) {
                        if (node) {
                            nodeContextMenu.show(e.clientX, e.clientY, node);
                        } else {
                            const offset = this.convertEventToCanvasOffset(e);
                            popupMenu.show(e.clientX, e.clientY, (nodeType) => {
                                addRootNode(nodeType, [offset[0], offset[1]]);
                            });
                        }
                        return false;
                    };

                    canvas.addEventListener('contextmenu', (e: MouseEvent) => {
                        e.preventDefault();
                        const offset = graphCanvas.convertEventToCanvasOffset(e);
                        const node = (graphCanvas as any).getNodeOnPos(offset[0], offset[1], (graph as any)._nodes, 0);
                        if (node) {
                            nodeContextMenu.show(e.clientX, e.clientY, node);
                        }
                    });

                    // Override LiteGraph search box to open Node Select popup on double-click
                    graphCanvas.allow_searchbox = true;
                    graphCanvas.showSearchBox = function (e?: MouseEvent) {
                        if (graphCanvas.node_over) return;

                        let canvasPos: [number, number] | undefined = undefined;
                        if (e && typeof graphCanvas.convertEventToCanvasOffset === 'function') {
                            const offset = graphCanvas.convertEventToCanvasOffset(e);
                            canvasPos = [offset[0], offset[1]];
                        }

                        const clickX = e ? e.clientX : window.innerWidth / 2;
                        const clickY = e ? e.clientY : window.innerHeight / 2;

                        popupMenu.show(clickX, clickY, (nodeType) => {
                            addRootNode(nodeType, canvasPos);
                        });
                    };

                    canvas.addEventListener('dblclick', (e: MouseEvent) => {
                        if (graphCanvas.node_over) return;
                        const offset = graphCanvas.convertEventToCanvasOffset(e);
                        popupMenu.show(e.clientX, e.clientY, (nodeType) => {
                            addRootNode(nodeType, [offset[0], offset[1]]);
                        });
                    });

                    canvas.addEventListener('mousemove', (e: MouseEvent) => {
                        if (!graph || graphCanvas.node_over || graphCanvas.connecting_node || graphCanvas.dragging_canvas || (graphCanvas as any).selected_group_resizing) {
                            if (hoveredLink) {
                                hoveredLink = null;
                                canvas.style.cursor = "default";
                                graphCanvas.setDirty(true, true);
                            }
                            return;
                        }

                        const offset = graphCanvas.convertEventToCanvasOffset(e);
                        const canvasX = offset[0];
                        const canvasY = offset[1];
                        const scale = graphCanvas.ds?.scale || 1.0;
                        const threshold = 10 / scale;

                        let closestLink: any = null;
                        let minDistance = threshold;

                        if (graph.links) {
                            for (const linkId in graph.links) {
                                const link = graph.links[linkId];
                                if (!link) continue;

                                const originNode = graph.getNodeById(link.origin_id);
                                const targetNode = graph.getNodeById(link.target_id);
                                if (!originNode || !targetNode) continue;

                                const defaultPosA = originNode.getConnectionPos(false, link.origin_slot);
                                const defaultPosB = targetNode.getConnectionPos(true, link.target_slot);
                                const { origin: posA, target: posB } = getLinkEndpoints(graph, link, defaultPosA, defaultPosB);

                                const dist = getDistanceToSegment(canvasX, canvasY, posA[0], posA[1], posB[0], posB[1]);
                                if (dist < minDistance) {
                                    minDistance = dist;
                                    closestLink = link;
                                }
                            }
                        }

                        if (hoveredLink !== closestLink) {
                            hoveredLink = closestLink;
                            if (hoveredLink) {
                                canvas.style.cursor = BREAKER_CURSOR;
                            } else {
                                canvas.style.cursor = "default";
                            }
                            graphCanvas.setDirty(true, true);
                        }
                    });

                    canvas.addEventListener('mousedown', (e: MouseEvent) => {
                        if (e.button === 0 && hoveredLink) {
                            const linkIdToDelete = hoveredLink.id;
                            hoveredLink = null;
                            canvas.style.cursor = "default";
                            graph.removeLink(linkIdToDelete);
                            syncGraphHierarchy(graph);
                            updateGraphNodeCollapsing();
                            window.dispatchEvent(new CustomEvent('graph-connections-changed'));
                            graphCanvas.setDirty(true, true);
                            e.stopPropagation();
                            e.preventDefault();
                        }
                    }, true);

                    canvas.addEventListener('dragover', (e: DragEvent) => {
                        e.preventDefault();
                        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
                        const offset = graphCanvas.convertEventToCanvasOffset(e);
                        const dropNode = (graphCanvas as any).getNodeOnPos(offset[0], offset[1], (graph as any)._nodes, 0);
                        if ((graphCanvas as any).library_drop_node !== dropNode) {
                            (graphCanvas as any).library_drop_node = dropNode;
                            graphCanvas.setDirty(true, true);
                        }
                    });

                    canvas.addEventListener('dragleave', () => {
                        if ((graphCanvas as any).library_drop_node) {
                            (graphCanvas as any).library_drop_node = null;
                            graphCanvas.setDirty(true, true);
                        }
                    });

                    canvas.addEventListener('drop', async (e: DragEvent) => {
                        e.preventDefault();
                        (graphCanvas as any).library_drop_node = null;
                        graphCanvas.setDirty(true, true);
                        if (!e.dataTransfer) return;

                        try {
                            const dataStr = e.dataTransfer.getData('text/plain');
                            if (!dataStr) return;
                            const items = getLibraryDragItems(JSON.parse(dataStr));
                            if (items.length === 0) return;

                            const offset = graphCanvas.convertEventToCanvasOffset(e);
                            const targetNode = (graphCanvas as any).getNodeOnPos(offset[0], offset[1], (graph as any)._nodes, 0);
                            if (targetNode) {
                                await applyLibraryDropToNode(targetNode, items);
                            } else {
                                await addLibraryItemsToCanvas(items, [offset[0], offset[1]]);
                            }
                        } catch (err) {
                            console.error("Failed applying dropped GAIA item", err);
                        }
                    });

                    let resizeFrame: number | null = null;
                    let renderedWidth = 0;
                    let renderedHeight = 0;
                    const resizeObserver = new ResizeObserver(() => {
                        if (resizeFrame !== null) return;
                        resizeFrame = window.requestAnimationFrame(() => {
                            resizeFrame = null;
                            const width = Math.floor(element.clientWidth);
                            const height = Math.floor(element.clientHeight);
                            if (width <= 0 || height <= 0) return;
                            if (width === renderedWidth && height === renderedHeight) return;

                            renderedWidth = width;
                            renderedHeight = height;
                            canvas.style.width = width + "px";
                            canvas.style.height = height + "px";
                            graphCanvas.resize(width, height);
                            if (graphCanvas.bgcanvas) {
                                graphCanvas.bgcanvas.style.backgroundColor = "#ffffff";
                            }
                            graphCanvas.setDirty(true, true);
                        });
                    });
                    resizeObserver.observe(element);

                    await restoreCurrentStage(graph, graphCanvas);
                    installStageAutosave(graph, canvas);
                    graph.start();

                    graphCanvas.onSelectionChange = function () {
                        updateGraphNodeCollapsing();
                    };

                    graphCanvas.onNodeSelected = function (node: any) {
                        updateGraphNodeCollapsing();
                        openParamWindow(node);
                    };

                    graphCanvas.onNodeDeselected = function () {
                        updateGraphNodeCollapsing();
                    };
                });
                break;
            }
            case 'properties-panel': {
                const nodeId = options.params?.nodeId;
                const graph = (window as any).editorGraph;
                let node = (window as any)._currentlySelectedNode;
                if (!node && graph && nodeId != null) {
                    node = graph.getNodeById(nodeId);
                }
                const onClose = () => {
                    const dv = (window as any).dockview;
                    if (dv) {
                        const p = dv.getGroupPanel(options.id);
                        if (p) p.api.close();
                    } else if (options.api) {
                        options.api.close();
                    }
                };

                if (node?.properties?.disabled || node?.type === 'Audio/Disabled') {
                    const notice = document.createElement('div');
                    notice.className = 'disabled-node-notice';
                    const heading = document.createElement('strong');
                    heading.textContent = 'Node disabled';
                    const details = document.createElement('p');
                    details.textContent = node.properties?.disabled_reason || 'This saved node is unavailable in the current build.';
                    const originalType = document.createElement('code');
                    originalType.textContent = node.properties?.disabled_original_type || 'Unknown node type';
                    notice.append(heading, details, originalType);
                    element.appendChild(notice);
                } else if (node) {
                    try {
                        const win = new PropertiesWindow(element, node, onClose);
                        disposeComponent = () => win.dispose();
                        win.render().catch(err => {
                            element.innerHTML = `
                                <div style="padding:15px; color:red;">
                                    <div style="margin-bottom:10px;">Async Error rendering properties: ${err}</div>
                                    <button id="err-close">Close</button>
                                </div>
                            `;
                            element.querySelector('#err-close')?.addEventListener('click', onClose);
                        });
                    } catch (err) {
                        element.innerHTML = `
                            <div style="padding:15px; color:red;">
                                <div style="margin-bottom:10px;">Error rendering properties: ${err}</div>
                                <button id="err-close">Close</button>
                            </div>
                        `;
                        element.querySelector('#err-close')?.addEventListener('click', onClose);
                    }
                } else {
                    element.innerHTML = `
                        <div style="padding:15px; color:red; background-color: #fef08a; height: 100%;">
                            <div style="margin-bottom:10px;">Error loading properties (missing node params).</div>
                            <button id="err-close" style="padding:5px 10px; cursor:pointer;">Close</button>
                        </div>
                    `;
                    element.querySelector('#err-close')?.addEventListener('click', onClose);
                }
                break;
            }
            case 'library-panel': {
                const panel = new LibraryPanel(element);
                disposeComponent = () => panel.dispose();
                break;
            }
        }

        return {
            element,
            init: () => { },
            update: () => { },
            dispose: disposeComponent
        };
    }
});
(window as any).dockview = dockview;

stageSaveStatus = document.createElement('div');
stageSaveStatus.className = 'stage-save-status';
stageSaveStatus.setAttribute('role', 'status');
stageSaveStatus.setAttribute('aria-live', 'polite');
dockviewContainer.appendChild(stageSaveStatus);
setStageSaveState('loading');
new RuntimeLogPanel(dockviewContainer);

dockview.onDidAddPanel(() => updatePanelToggleButtons());
dockview.onDidRemovePanel((panel: any) => {
    if (panel.id && panel.id.startsWith('properties_')) {
        const nodeId = parseInt(panel.id.replace('properties_', ''), 10);
        if (activeParamNodeId === nodeId) {
            activeParamNodeId = null;
        }
        updateGraphNodeCollapsing();
    }
    updatePanelToggleButtons();
});
dockview.onDidActivePanelChange(() => updatePanelToggleButtons());
dockview.onDidMaximizedGroupChange((event: any) => {
    if (event.isMaximized) {
        if (typeof event.group?.api?.exitMaximized === 'function') {
            event.group.api.exitMaximized();
        } else if (typeof (dockview as any).exitMaximizedGroup === 'function') {
            (dockview as any).exitMaximizedGroup();
        }
    }
});

dockview.layout(dockviewContainer.clientWidth, dockviewContainer.clientHeight);
window.addEventListener('resize', () => {
    dockview.layout(dockviewContainer.clientWidth, dockviewContainer.clientHeight);
});

const graphPanel = dockview.addPanel({
    id: 'graph_panel',
    component: 'graph-editor',
    title: 'Graph Editor',
    minimumWidth: 400
});
graphPanel.group.header.hidden = true;

updatePanelToggleButtons();

// Note: parseBpmFromFilename, resolveAssetFilterNode, and advanceAssetPoolSeed are imported from ./ermes/assetResolver.


window.addEventListener('refresh-asset-pool', async (event: Event) => {
    const { modifierId, sampleId } = (event as CustomEvent).detail || {};
    const graph = (window as any).editorGraph as LGraph;
    const modifier = modifierId != null ? graph?.getNodeById(modifierId) : null;
    const sample = sampleId != null ? graph?.getNodeById(sampleId) : null;
    if (!modifier) return;
    try {
        advanceAssetPoolSeed(modifier);
        await resolveAssetFilterNode(modifier, sample, modifier.properties?.playbackMode !== 'Sequential');
        window.dispatchEvent(new CustomEvent('modifier-assignment-changed', { detail: { nodeId: sampleId } }));
        window.dispatchEvent(new CustomEvent('modifier-assignment-changed', { detail: { nodeId: modifierId } }));
    } catch (error) {
        console.error('Asset Pool refresh failed', error);
        alert(error instanceof Error ? error.message : 'Asset Pool refresh failed.');
    }
});

// Note: resolveAssignedAssetFilters, resolveAssetFilterNode, advanceAssetPoolSeed, and serializeNodeSubtree
// are imported from ERMES serialization engine (./ermes/serializer and ./ermes/assetResolver).


async function renderNode(nodeId: number) {
    const graph = (window as any).editorGraph as LGraph;
    if (!graph) return;

    const renderStartedAt = performance.now();
    runtimeLog(`Disk render requested for node ${nodeId}`, 'common');
    let libraryFiles: LibraryFile[];
    try {
        libraryFiles = await loggedTask('Resolve graph asset metadata', () =>
            syncGraphSampleMetadataFromLibrary(graph, true, nodeId)
        );
        await loggedTask('Resolve render asset pools', () =>
            resolveAssignedAssetFilters(graph, nodeId, { kind: 'render', libraryFiles })
        );
    } catch (error) {
        console.error('Asset Filter resolution failed', error);
        const message = error instanceof Error ? error.message : String(error);
        runtimeLog(`Disk render stopped: ${message}`, 'error');
        alert(`Could not resolve the assigned Asset Filter: ${message}`);
        return;
    }
    const payload = await loggedTask('Serialize render graph', () => serializeNodeSubtree(graph, nodeId));
    if (!payload) {
        runtimeLog('Disk render stopped: graph serialization returned no payload', 'error');
        alert("Could not serialize node for rendering.");
        return;
    }

    payload.filename = `export_${nodeId}`;

    try {
        const res = await loggedTask('Render audio on server', () =>
            fetch('/api/render', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            })
        );
        if (!res.ok) {
            let errorDetail = `Status code ${res.status}`;
            try {
                const errJson = await res.json();
                if (errJson.detail) errorDetail = errJson.detail;
            } catch {
                const rawText = await res.text();
                if (rawText) errorDetail = rawText;
            }
            throw new Error(`Render failed: ${errorDetail}`);
        }
        const data = await res.json();
        appendServerRuntimeLog(data.runtime_log);

        if (data.status === 'success' && data.filename) {
            await updateTempRendersList(data.filename);
            masterPlayer.play().catch(e => console.error(e));
            runtimeLog(`Disk render complete (${Math.round(performance.now() - renderStartedAt)} ms)`, 'common');
        } else {
            console.error("Render failed:", data);
            alert("Render failed, check console.");
        }
    } catch (err) {
        console.error("Error during render:", err);
        runtimeLog(`Disk render failed: ${(err as Error).message || String(err)}`, 'error');
        alert(`Error during render: ${(err as Error).message || err}`);
    }
}

type PreviewRequest = {
    nodeId: number;
    autoplay: boolean;
    globalPreview: boolean;
    refreshModifiers: boolean;
};

let pendingPreviewRequest: PreviewRequest | null = null;
let previewRequestVersion = 0;
let previewWorker: Promise<void> | null = null;

async function calculatePreview(
    nodeId: number,
    requestVersion: number,
    autoplay: boolean,
    globalPreview: boolean,
    refreshModifiers: boolean
) {
    const graph = (window as any).editorGraph as LGraph;
    if (!graph) throw new Error('Graph is unavailable.');
    const previewStartedAt = performance.now();

    try {
        const libraryFiles = await loggedTask('Resolve graph asset metadata', () =>
            syncGraphSampleMetadataFromLibrary(graph, true, nodeId)
        );
        if (refreshModifiers) {
            await loggedTask('Resolve preview asset pools', () =>
                resolveAssignedAssetFilters(graph, nodeId, {
                    kind: 'preview',
                    globalPreview,
                    libraryFiles
                })
            );
        }
    } catch (error) {
        console.error('Asset Filter resolution failed', error);
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Could not resolve the assigned Asset Filter: ${message}`);
    }
    const payload = await loggedTask('Serialize preview graph', () =>
        serializeNodeSubtree(
            graph,
            nodeId,
            undefined,
            { includeDynamicPools: refreshModifiers }
        )
    );
    if (!payload) {
        throw new Error("Could not serialize node for preview.");
    }

    const keyName = `export_${nodeId}`;
    payload.filename = keyName;

    try {
        const res = await loggedTask('Render preview audio on server', () =>
            fetch('/api/preview', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            })
        );

        if (!res.ok) {
            let errorDetail = `Status code ${res.status}`;
            try {
                const errJson = await res.json();
                if (errJson.detail) errorDetail = errJson.detail;
            } catch {
                const rawText = await res.text();
                if (rawText) errorDetail = rawText;
            }
            throw new Error(`RAM preview failed: ${errorDetail}`);
        }

        const data = await res.json();
        appendServerRuntimeLog(data.runtime_log);

        if (data.status === 'success' && data.audio_url) {
            if (requestVersion !== previewRequestVersion) {
                runtimeLog(`Discarded superseded preview for node ${nodeId}`, 'warning');
                return;
            }
            activeRamPreviewNodeId = nodeId;
            activeRamPreviewPayload = payload;
            previewRecalculateBtn.disabled = false;

            setMasterPlayerSource(data.audio_url, autoplay);

            // Add/select RAM preview entry in toolbar dropdown
            let ramOpt = Array.from(tempFilesSelect.options).find(o => o.value === 'RAM_PREVIEW');
            if (!ramOpt) {
                ramOpt = document.createElement('option');
                ramOpt.value = 'RAM_PREVIEW';
                ramOpt.className = 'ram-preview-option';
                ramOpt.textContent = `RAM · ${payload.node_name}`;
                tempFilesSelect.insertBefore(ramOpt, tempFilesSelect.firstChild);
            } else {
                ramOpt.className = 'ram-preview-option';
                ramOpt.textContent = `RAM · ${payload.node_name}`;
            }
            tempFilesSelect.value = 'RAM_PREVIEW';
            updatePlaybackTrackPresentation();
            runtimeLog(`Preview ready for node ${nodeId} (${Math.round(performance.now() - previewStartedAt)} ms)`, 'common');
        } else {
            throw new Error(data.detail || "RAM preview calculation failed.");
        }
    } catch (err) {
        console.error("Error during RAM preview:", err);
        if (requestVersion === previewRequestVersion) {
            runtimeLog(`Preview failed for node ${nodeId}: ${(err as Error).message || String(err)}`, 'error');
        }
        if (requestVersion === previewRequestVersion) throw err;
    }
}

async function runPreviewQueue() {
    try {
        while (pendingPreviewRequest != null) {
            const request = pendingPreviewRequest;
            const requestVersion = previewRequestVersion;
            pendingPreviewRequest = null;
            try {
                await calculatePreview(
                    request.nodeId,
                    requestVersion,
                    request.autoplay,
                    request.globalPreview,
                    request.refreshModifiers
                );
            } catch (error) {
                const isLatest = requestVersion === previewRequestVersion && pendingPreviewRequest == null;
                if (isLatest) {
                    setPreviewFailedState();
                    alert(error instanceof Error ? error.message : 'RAM preview failed.');
                }
            }
        }
    } finally {
        previewWorker = null;
        if (pendingPreviewRequest != null) previewWorker = runPreviewQueue();
    }
}

function previewNode(
    nodeId: number,
    autoplay: boolean = true,
    globalPreview: boolean = false,
    refreshModifiers: boolean = true
): Promise<void> {
    if (pendingPreviewRequest) {
        runtimeLog(`Replaced queued preview for node ${pendingPreviewRequest.nodeId}`, 'warning');
    }
    pendingPreviewRequest = { nodeId, autoplay, globalPreview, refreshModifiers };
    previewRequestVersion++;
    runtimeLog(`Preview queued for node ${nodeId}`, 'common');
    setPreviewCalculatingState();
    if (!previewWorker) previewWorker = runPreviewQueue();
    return previewWorker;
}
