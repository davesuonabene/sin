import './style.css';
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
import { LibraryPanel } from './ui/LibraryPanel';
import { MasterWaveform } from './ui/MasterWaveform';
import { attachGhostProperties, createGhostNode, detachGhostDependents, isGhostNode, syncGhostTrackData } from './ghosts';
import { installSeparatedNodeClipboard } from './nodeClipboard';
import { fetchLibrary, findLibraryFile, findLibraryFileById, type LibraryFile } from './api';

const appElement = document.getElementById('app');
if (!appElement) throw new Error('Could not find #app element');

appElement.className = 'dockview-theme-light';

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
                <div class="header-menu-popover">
                    <label class="header-menu-label" for="workspace-preset-select">Workspace</label>
                    <select id="workspace-preset-select" class="header-select workspace-preset-select" aria-label="Workspace preset">
                        <option value="">No saved workspaces</option>
                    </select>
                    <div class="header-menu-row">
                        <button id="save-workspace-as-btn" class="header-btn secondary-tool-btn">Save As</button>
                        <button id="save-workspace-btn" class="header-btn secondary-tool-btn" disabled>Save</button>
                    </div>
                    <div class="header-menu-row">
                        <button id="load-workspace-btn" class="header-btn secondary-tool-btn" disabled>Load</button>
                        <button id="delete-workspace-btn" class="header-btn secondary-tool-btn" disabled>Delete</button>
                    </div>
                    <div class="header-menu-separator"></div>
                    <button id="export-btn" class="header-menu-action">Download selected audio</button>
                </div>
            </details>
            <details class="header-menu" id="library-menu">
                <summary>Library</summary>
                <div class="header-menu-popover">
                    <button id="toggle-library-btn" class="header-menu-action">Open Library</button>
                    <div class="header-menu-hint">Library management stays in GAIA.</div>
                </div>
            </details>
        </div>
        <div class="panel-toggles">
            <button id="header-toggle-library" class="header-btn secondary-tool-btn" title="Toggle Library Panel (Shortcut: L)">📁 Library</button>
            <button id="header-toggle-properties" class="header-btn secondary-tool-btn" title="Toggle Properties / Inspector (Shortcut: P)">⚙ Inspector</button>
        </div>
    </div>
    <div class="top-header-center">
        <div class="playback-toolbar">
            <div class="render-select-wrapper">
                <select id="temp-files-select" class="header-select">
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
    </div>
    <div class="top-header-right">
        <button id="global-refresh-btn" class="header-btn global-refresh-btn" title="Refresh highlighted nodes using Global Refresh mode">
            <span class="btn-icon">↻</span> Refresh
        </button>
    </div>
`;

const dockviewContainer = document.createElement('div');
dockviewContainer.className = 'dockview-container';

appElement.appendChild(topHeader);
appElement.appendChild(dockviewContainer);

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

const tempFilesSelect = topHeader.querySelector('#temp-files-select') as HTMLSelectElement;
const masterPlayer = topHeader.querySelector('#master-player') as HTMLAudioElement;
const masterPlayBtn = topHeader.querySelector('#master-play-btn') as HTMLButtonElement;
const masterMuteBtn = topHeader.querySelector('#master-mute-btn') as HTMLButtonElement;
const masterVolume = topHeader.querySelector('#master-volume') as HTMLInputElement;
const exportBtn = topHeader.querySelector('#export-btn') as HTMLButtonElement;
const globalRefreshBtn = topHeader.querySelector('#global-refresh-btn') as HTMLButtonElement;
const toggleLibraryBtn = topHeader.querySelector('#toggle-library-btn') as HTMLButtonElement;
const headerToggleLibrary = topHeader.querySelector('#header-toggle-library') as HTMLButtonElement;
const headerToggleProperties = topHeader.querySelector('#header-toggle-properties') as HTMLButtonElement;
const fileMenu = topHeader.querySelector('#file-menu') as HTMLDetailsElement;
const libraryMenu = topHeader.querySelector('#library-menu') as HTMLDetailsElement;
const masterWaveformElement = topHeader.querySelector('#master-waveform') as HTMLDivElement;
const workspacePresetSelect = topHeader.querySelector('#workspace-preset-select') as HTMLSelectElement;
const saveWorkspaceAsBtn = topHeader.querySelector('#save-workspace-as-btn') as HTMLButtonElement;
const saveWorkspaceBtn = topHeader.querySelector('#save-workspace-btn') as HTMLButtonElement;
const loadWorkspaceBtn = topHeader.querySelector('#load-workspace-btn') as HTMLButtonElement;
const deleteWorkspaceBtn = topHeader.querySelector('#delete-workspace-btn') as HTMLButtonElement;

const WORKSPACE_PRESET_VERSION = 1;

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
    masterPlayer.src = `${source}${source.includes('?') ? '&' : '?'}t=${Date.now()}`;
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
    if (pendingMasterSeek !== null) {
        const targetTime = Math.min(pendingMasterSeek, masterPlayer.duration);
        masterPlayer.currentTime = targetTime;
        masterWaveform.setPlayback(targetTime, masterPlayer.duration);
    } else {
        masterWaveform.setPlayback(masterPlayer.currentTime, masterPlayer.duration);
    }
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

function prepareWorkspaceGraph(rawGraph: any) {
    if (!rawGraph || typeof rawGraph !== 'object' || !Array.isArray(rawGraph.nodes)) {
        throw new Error('Preset does not contain a valid graph.');
    }

    const graphInfo = JSON.parse(JSON.stringify(rawGraph));
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
            total_bars: p.total_bars ?? (type === 'track' || type === 'arrangement' ? 4 : undefined),
            probability: p.probability,
            section_points: p.section_points,
            section_enabled: p.section_enabled,
            section_probability: p.section_probability,
            section_quant: p.section_quant,
            section_quant_anchor: p.section_quant_anchor,
            quant: p.quant,
            quant_anchor: p.quant_anchor,
            duration_seconds: p.duration_seconds,
            filters: p.filters,
            selected_items: p.selected_items,
            playbackMode: p.playbackMode,
            seed: p.seed,
            seed_mode: p.seed_mode,
            refresh_mode: p.refresh_mode,
            chain: p.chain,
            modulators: p.modulators,
            asset_modifier_id: p.asset_modifier_id,
            global_refresh_highlighted: p.global_refresh_highlighted,
            parentId: p.parentId ?? null,
            children: []
        } as TrackNodeData);
    }
    syncGraphHierarchy(graph);
}

async function syncGraphSampleBpmsFromLibrary(graph: LGraph) {
    const files: LibraryFile[] = await fetchLibrary(true, true);
    const nodes = ((graph as any)._nodes || []) as any[];
    await Promise.all(nodes.map(node => {
        const sync = node?.syncOriginalBpmFromLibrary;
        if (typeof sync !== 'function') return Promise.resolve(false);
        const modifierId = node.properties?.asset_modifier_id;
        const modifier = modifierId != null ? graph.getNodeById(modifierId) : null;
        const assetPath = modifier?.properties?.output_value || node.properties?.filepath || '';
        const selectedItem = (modifier?.properties?.selected_items || []).find((item: any) =>
            (item.absolute_path || item.filepath) === assetPath
        );
        const preferredId = modifier?.properties?.output_item_id ?? selectedItem?.id ?? node.properties?.library_item_id;
        if (assetPath && node.properties?.filepath !== assetPath) node.updateProperty('filepath', assetPath);
        return sync.call(node, files, preferredId).then((synced: boolean) => {
            if (!synced) return false;
            const bpm = node.properties?.original_bpm;
            const item = findLibraryFileById(files, preferredId) || findLibraryFile(files, assetPath);
            if (modifier?.properties) {
                modifier.properties.output_bpm = bpm;
                if (item?.id != null) modifier.properties.output_item_id = item.id;
            }
            if (selectedItem) {
                selectedItem.bpm = bpm;
                selectedItem.original_bpm = bpm;
            }
            return true;
        });
    }));
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

function createWorkspacePreset(graph: LGraph) {
    return {
        version: WORKSPACE_PRESET_VERSION,
        savedAt: new Date().toISOString(),
        graph: graph.serialize()
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
        const response = await fetch(`/api/workspaces/${encodeURIComponent(workspacePresetSelect.value)}`);
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.detail || `Could not load workspace (${response.status})`);
        }
        const data = await response.json();
        const preset = data.preset;
        if (preset.version !== WORKSPACE_PRESET_VERSION) {
            console.warn(`Loading preset version ${preset.version}; unsupported nodes will be disabled.`);
        }
        closeAllParamWindows();
        activeParamNodeId = null;
        graph.configure(prepareWorkspaceGraph(preset.graph));
        await syncGraphSampleBpmsFromLibrary(graph);
        rebuildTrackNodesFromGraph(graph);
        updateGraphNodeCollapsing();
        canvas?.setDirty(true, true);
        fileMenu.open = false;
        setWorkspaceButtonMessage(loadWorkspaceBtn, 'Loaded', 'Load');
    } catch (error) {
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

window.addEventListener('toggle-library-dock', () => {
    toggleLibraryDockMode();
});

window.addEventListener('close-library-panel', () => {
    toggleLibraryPanel('close');
});

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

globalRefreshBtn.addEventListener('click', async () => {
    if (globalRefreshBtn.disabled) return;
    const original = globalRefreshBtn.innerHTML;
    globalRefreshBtn.disabled = true;
    globalRefreshBtn.innerHTML = '<span class="btn-icon">↻</span> Refreshing…';
    try {
        const refreshed = await refreshHighlightedNodes();
        globalRefreshBtn.innerHTML = `<span class="btn-icon">✓</span> ${refreshed} Refreshed`;
        window.setTimeout(() => { globalRefreshBtn.innerHTML = original; }, 1400);
    } catch (error) {
        console.error('Global refresh failed', error);
        globalRefreshBtn.innerHTML = '<span class="btn-icon">!</span> Refresh failed';
        window.setTimeout(() => { globalRefreshBtn.innerHTML = original; }, 1800);
    } finally {
        globalRefreshBtn.disabled = false;
    }
});

tempFilesSelect.addEventListener('change', (e) => {
    const val = (e.target as HTMLSelectElement).value;
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
        } else {
            // No files left
            tempFilesSelect.innerHTML = '<option value="" disabled selected>No renders available</option>';
            masterPlayer.pause();
            masterPlayer.removeAttribute('src');
            masterPlayer.load();
            masterPlayBtn.disabled = true;
            masterWaveform.clear('Ready to render');
            updatePlaybackControls();
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
    bpm?: number;
    mix_mode: string;
    crop_start?: number;
    crop_end?: number;
    transpose?: number;
    cents?: number;
    stretch_mode?: string;
    stretch_factor?: number;
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
    total_bars?: number;
    probability?: number;
    section_points?: number[];
    section_enabled?: boolean[];
    section_probability?: number[];
    section_quant?: string[];
    section_quant_anchor?: string[];
    quant?: string;
    quant_anchor?: "start" | "end";
    duration_seconds?: number;
    filters?: any;
    selected_items?: any[];
    playbackMode?: string;
    seed?: number;
    seed_mode?: string;
    refresh_mode?: string;
    chain?: any[];
    modulators?: number[];
    asset_modifier_id?: number;
    global_refresh_highlighted?: boolean;
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

window.addEventListener('node-property-changed', (event: Event) => {
    const { nodeId, key, value } = (event as CustomEvent).detail || {};
    const data = trackNodes.get(nodeId);
    if (!data || typeof key !== 'string') return;
    if (key === 'node_name' || key === 'name') data.name = String(value);
    else (data as any)[key] = value;

    // BPM is inherited through the graph hierarchy, so a property edit must
    // re-run the same propagation pass used after connection changes.
    if (key === 'bpm' || key === 'target_bpm') {
        syncGraphHierarchy();
    }
});

window.addEventListener('toggle-global-refresh-highlight', (event: Event) => {
    const nodeId = (event as CustomEvent).detail?.nodeId;
    const graph = (window as any).editorGraph as LGraph;
    const node = nodeId != null ? graph?.getNodeById(nodeId) : null;
    if (!node?.properties) return;
    const highlighted = !node.properties.global_refresh_highlighted;
    node.properties.global_refresh_highlighted = highlighted;
    const data = trackNodes.get(nodeId);
    if (data) data.global_refresh_highlighted = highlighted;
    node.setDirtyCanvas?.(true, true);
    (window as any).editorCanvas?.setDirty?.(true, true);
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

    let changed = true;
    let iterations = 0;
    while (changed && iterations < 10) {
        changed = false;
        iterations++;
        for (const [nodeId, data] of trackNodes.entries()) {
            if (data.parentId != null) {
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
        const parentBars = parentData?.total_bars ?? parentNode?.properties?.total_bars;
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
                    closeAllParamWindows();
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

let libraryPreferredLocation: 'left' | 'floating' = 'left';
let propertiesPreferredLocation: 'right' | 'floating' = 'right';

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
        let hasProp = false;
        if (activeParamNodeId != null) {
            const p = dv.getGroupPanel(`properties_${activeParamNodeId}`);
            if (p) hasProp = true;
        }
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
    if (libraryPreferredLocation === 'floating' || !graphPanel) {
        const libPanel = dv.addPanel({
            id: 'library_panel',
            component: 'library-panel',
            title: 'Library'
        });
        dv.addFloatingGroup(libPanel, {
            x: 20,
            y: 50,
            width: 210,
            height: 500
        });
    } else {
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
    }
    updatePanelToggleButtons();
}

function toggleLibraryDockMode() {
    const dv = (window as any).dockview;
    if (!dv) return;
    const p = dv.getGroupPanel('library_panel');
    const isFloating = p?.group?.api?.location?.type === 'floating';

    if (p) p.api.close();

    libraryPreferredLocation = isFloating ? 'left' : 'floating';
    toggleLibraryPanel('open');
}

function openParamWindow(node: any, options?: { forceOpen?: boolean; toggle?: boolean }) {
    if (!node || node.id == null) return;
    if (node.type !== "Audio/Track" && node.type !== "Audio/Sample" && node.type !== "Audio/Sequence" && node.type !== "Audio/Arrangement" && node.type !== "Audio/Modulator" && node.type !== "Audio/AssetFilter") return;

    const dv = (window as any).dockview;
    if (!dv) return;

    const panelId = `properties_${node.id}`;
    let panel = dv.getGroupPanel(panelId) as IDockviewPanel | undefined;
    const previousPanels = Array.from(dv.panels || []).filter((candidate: any) =>
        candidate.id?.startsWith('properties_') && candidate.id !== panelId
    ) as IDockviewPanel[];
    const previousPanel = previousPanels[0];

    if (options?.toggle && panel) {
        panel.api.close();
        updatePanelToggleButtons();
        return;
    }

    (window as any)._currentlySelectedNode = node;
    activeParamNodeId = node.id;

    if (panel) {
        previousPanels.forEach(previous => previous.api.close());
        panel.api.setActive();
        updateGraphNodeCollapsing();
        updatePanelToggleButtons();
        return;
    }

    const width = 380;
    const graphPanel = dv.getGroupPanel('graph_panel');

    if (propertiesPreferredLocation === 'floating' || !graphPanel) {
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
        panel = dv.addPanel({
            id: panelId,
            component: 'properties-panel',
            title: `Node Properties`,
            params: {
                nodeId: node.id
            },
            position: {
                referencePanel: previousPanel?.id || 'graph_panel',
                direction: previousPanel ? 'within' : 'right'
            },
            initialWidth: width,
            minimumWidth: 260,
            maximumWidth: Math.max(width + 80, 580)
        });
    }
    // Close the old properties panel only after its replacement exists. This
    // keeps the dock group dimensions stable and avoids a full-canvas flash.
    previousPanels.forEach(previous => previous.api.close());
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
    const isFloating = p?.group?.api?.location?.type === 'floating';

    if (p) p.api.close();

    propertiesPreferredLocation = isFloating ? 'right' : 'floating';
    openParamWindow(node, { forceOpen: true });
}

function togglePropertiesPanel() {
    const dv = (window as any).dockview;
    if (!dv) return;

    if (activeParamNodeId != null) {
        const p = dv.getGroupPanel(`properties_${activeParamNodeId}`);
        if (p) {
            p.api.close();
            updatePanelToggleButtons();
            return;
        }
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

    const modifierNode = addAssetFilterNode(nodeId, false);
    if (!modifierNode) return;

    modifierNode.properties.accepted_asset_type = ownerNode.type === 'Audio/Sequence' ? 'midi' : 'audio';
    ownerNode.properties.asset_modifier_id = modifierNode.id;
    const ownerData = trackNodes.get(nodeId);
    if (ownerData) ownerData.asset_modifier_id = modifierNode.id;
    window.dispatchEvent(new CustomEvent('modifier-assignment-changed', { detail: { nodeId } }));
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

function nodeSubtreeContains(rootNodeId: number, targetNodeId: number): boolean {
    if (rootNodeId === targetNodeId) return true;
    const visited = new Set<number>();
    const pending = [rootNodeId];
    while (pending.length > 0) {
        const current = pending.pop()!;
        if (visited.has(current)) continue;
        visited.add(current);
        const children = trackNodes.get(current)?.children || [];
        if (children.includes(targetNodeId)) return true;
        pending.push(...children);
    }
    return false;
}

window.addEventListener('preview-node', (e: any) => {
    const changedNodeId = e.detail?.nodeId;
    if (changedNodeId != null) {
        const isParameterChange = e.detail?.reason === 'parameter-change';
        const previewRoot = isParameterChange
            && activeRamPreviewNodeId != null
            && nodeSubtreeContains(activeRamPreviewNodeId, changedNodeId)
            ? activeRamPreviewNodeId
            : changedNodeId;
        // Parameter edits replace the current preview but do not start playback.
        previewNode(previewRoot, !isParameterChange);
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
    } else if (nodeType === "arrangement") {
        childNode.properties.total_bars = 4.0;
        childNode.properties.probability = 1.0;
        childNode.properties.section_points = [];
        childNode.properties.section_enabled = [true];
        childNode.properties.section_probability = [1.0];
        childNode.properties.section_quant = ["global"];
        childNode.properties.section_quant_anchor = ["global"];
        childNode.properties.quant = "none";
        childNode.properties.quant_anchor = "start";
    } else if (nodeType === "track") {
        childNode.properties.total_bars = 4.0;
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
        total_bars: nodeType === "arrangement" || nodeType === "track" ? 4.0 : undefined,
        probability: nodeType === "arrangement" ? 1.0 : undefined,
        section_points: nodeType === "arrangement" ? [] : undefined,
        section_enabled: nodeType === "arrangement" ? [true] : undefined,
        section_probability: nodeType === "arrangement" ? [1.0] : undefined,
        section_quant: nodeType === "arrangement" ? ["global"] : undefined,
        section_quant_anchor: nodeType === "arrangement" ? ["global"] : undefined,
        quant: nodeType === "arrangement" ? "none" : undefined,
        quant_anchor: nodeType === "arrangement" ? "start" : undefined,
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
    rootNode.properties.target_bpm = targetBpm;
    rootNode.properties.bpm = targetBpm;
    rootNode.properties.key = keyStr;

    if (nodeType === "sequence") {
        rootNode.properties.sequence = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
        rootNode.properties.step_length = 0.25;
    } else if (nodeType === "arrangement") {
        rootNode.properties.total_bars = 4.0;
        rootNode.properties.probability = 1.0;
        rootNode.properties.section_points = [];
        rootNode.properties.section_enabled = [true];
        rootNode.properties.section_probability = [1.0];
        rootNode.properties.section_quant = ["global"];
        rootNode.properties.section_quant_anchor = ["global"];
        rootNode.properties.quant = "none";
        rootNode.properties.quant_anchor = "start";
    } else if (nodeType === "track") {
        rootNode.properties.total_bars = 4.0;
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
        target_bpm: targetBpm,
        bpm: targetBpm,
        key: keyStr,
        start_beat: 0,
        mix_mode: "sum",
        sequence: nodeType === "sequence" ? [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] : undefined,
        step_length: nodeType === "sequence" ? 0.25 : undefined,
        total_bars: nodeType === "arrangement" || nodeType === "track" ? 4.0 : undefined,
        probability: nodeType === "arrangement" ? 1.0 : undefined,
        section_points: nodeType === "arrangement" ? [] : undefined,
        section_enabled: nodeType === "arrangement" ? [true] : undefined,
        section_probability: nodeType === "arrangement" ? [1.0] : undefined,
        section_quant: nodeType === "arrangement" ? ["global"] : undefined,
        section_quant_anchor: nodeType === "arrangement" ? ["global"] : undefined,
        quant: nodeType === "arrangement" ? "none" : undefined,
        quant_anchor: nodeType === "arrangement" ? "start" : undefined,
        parentId: null,
        children: []
    });

    if ((window as any).editorCanvas) {
        (window as any).editorCanvas.setDirty(true, true);
    }
    return rootNode;
}

function applyLibraryItemToSample(node: any, item: LibraryDragItem) {
    if (!node?.properties || isMidiLibraryItem(item)) return false;

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
        key: item.key || metadata.key || "",
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
            key: item.key || metadata.key || "",
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
    if (!node?.properties || !isMidiLibraryItem(item)) return false;

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

    const nodeName = item.name || item.filepath.split(/[\\/]/).pop() || "Sequence";
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

function addLibraryItemsToPool(node: any, items: LibraryDragItem[]) {
    if (!node?.properties || items.length === 0) return false;

    const existing = Array.isArray(node.properties.selected_items) ? node.properties.selected_items : [];
    const byKey = new Map<string, any>();
    for (const item of existing) {
        const key = String(item.id ?? item.absolute_path ?? item.filepath ?? "");
        if (key) byKey.set(key, item);
    }
    for (const item of items) {
        const poolItem = {
            id: item.id,
            absolute_path: item.filepath,
            filepath: item.filepath,
            name: item.name || item.filepath.split(/[\\/]/).pop(),
            type: item.itemType || (isMidiLibraryItem(item) ? "midi" : "audio"),
            key: item.key || null,
            bpm: item.bpm || null,
            duration_seconds: item.duration_seconds || null
        };
        byKey.set(String(item.id ?? item.filepath), poolItem);
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

function attachLibrarySampleToSequence(sequenceNode: any, item: LibraryDragItem) {
    let sampleNode: any = findDirectSampleChild(sequenceNode.id);
    if (!sampleNode) {
        sampleNode = addChildNode(sequenceNode.id, "sample", false);
    }
    if (!sampleNode) return false;

    const applied = applyLibraryItemToSample(sampleNode, item);
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
        return sample ? applyLibraryItemToSample(node, sample) : false;
    }

    if (node.type === "Audio/Sequence") {
        let applied = false;
        const midi = items.find(isMidiLibraryItem);
        const sample = items.find(item => !isMidiLibraryItem(item));
        if (midi) applied = await applyLibraryItemToSequence(node, midi) || applied;
        if (sample) applied = attachLibrarySampleToSequence(node, sample) || applied;
        return applied;
    }

    if (node.type === "Audio/AssetFilter") {
        return addLibraryItemsToPool(node, items);
    }

    // Track and arrangement nodes are containers: dropped assets become connected children.
    let applied = false;
    for (const item of items) {
        if (isMidiLibraryItem(item)) {
            const sequence = addChildNode(node.id, "sequence", false);
            if (sequence) {
                await applyLibraryItemToSequence(sequence, item);
                applied = true;
            }
        } else {
            const sample = addChildNode(node.id, "sample", false);
            if (sample) applied = applyLibraryItemToSample(sample, item) || applied;
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
        if (isMidiLibraryItem(item)) {
            const sequence = addRootNode("sequence", pos, item.filepath, item.name, item.key || undefined, item.bpm || undefined);
            if (sequence) await applyLibraryItemToSequence(sequence, item);
        } else {
            const sample = addRootNode("sample", pos, item.filepath, item.name, item.key || undefined, item.bpm || undefined);
            if (sample) applyLibraryItemToSample(sample, item);
        }
    }
}

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

                requestAnimationFrame(() => {
                    const graph = new LGraph();
                    (window as any).editorGraph = graph;

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

                    graph.start();

                    // Add initial Master Track root node
                    addRootNode("track");

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
                new LibraryPanel(element);
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

function parseBpmFromFilename(filepath: string): number | null {
    if (!filepath) return null;
    const filename = filepath.split(/[\\/]/).pop() || '';
    const match = filename.match(/(\d{2,3}(?:\.\d+)?)\s*bpm/i) || filename.match(/(\d{2,3}(?:\.\d+)?)[_\s-]+bpm/i);
    if (match) return parseFloat(match[1]);
    const numMatches = filename.match(/(?:^|[_\s-])(\d{2,3})(?=[._\s-]|$)/g);
    if (numMatches) {
        for (let i = numMatches.length - 1; i >= 0; i--) {
            const val = parseFloat(numMatches[i].replace(/^[_\s-]/, ''));
            if (val >= 60 && val <= 220) return val;
        }
    }
    return null;
}

async function resolveAssetFilterNode(modifierNode: any, ownerNode?: any, preferDifferent: boolean = false): Promise<string> {
    if (!modifierNode?.properties || modifierNode.properties.output_type !== 'asset_path') return '';
    const previousPath = modifierNode.properties.output_value || '';
    const acceptedType = modifierNode.properties.accepted_asset_type;
    const selectedItems = (modifierNode.properties.selected_items || []).filter((item: any) => {
        if (!acceptedType) return true;
        const path = String(item.absolute_path || item.filepath || item.name || '').toLowerCase();
        const isMidi = item.type === 'midi' || item.itemType === 'midi' || path.endsWith('.mid') || path.endsWith('.midi');
        return acceptedType === 'midi' ? isMidi : !isMidi;
    });
    let result: any = null;
    for (let attempt = 0; attempt < (preferDifferent ? 6 : 1); attempt++) {
        const response = await fetch('/api/pool/resolve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                filters: {},
                selected_items: selectedItems,
                seed: modifierNode.properties.seed || 0,
                playbackMode: modifierNode.properties.playbackMode || 'Random'
            })
        });
        if (!response.ok) throw new Error('Unable to resolve Asset Filter');
        result = await response.json();
        const candidate = typeof result.sample === 'string' ? result.sample : '';
        if (!preferDifferent || !previousPath || candidate !== previousPath || (result.items || []).length <= 1) break;
        modifierNode.properties.seed = Math.random();
    }
    const assetPath = typeof result?.sample === 'string' ? result.sample : '';
    modifierNode.properties.output_value = assetPath;

    const selectedItem = (modifierNode.properties.selected_items || []).find((item: any) =>
        (item.absolute_path || item.filepath) === assetPath
    );
    const resolvedPoolItem = result?.item || selectedItem;
    const libraryFiles = assetPath ? await fetchLibrary(true, true) : [];
    const libraryItem = findLibraryFileById(libraryFiles, resolvedPoolItem?.id)
        || findLibraryFile(libraryFiles, assetPath);
    let resolvedBpm: number | null = libraryItem?.bpm ?? result?.bpm ?? selectedItem?.bpm ?? selectedItem?.original_bpm ?? null;
    if (resolvedBpm == null && assetPath) {
        resolvedBpm = parseBpmFromFilename(assetPath);
    }

    if (resolvedBpm != null) {
        if (selectedItem) {
            selectedItem.bpm = resolvedBpm;
            selectedItem.original_bpm = resolvedBpm;
        }
        modifierNode.properties.output_bpm = resolvedBpm;
    }
    const libraryItemId = libraryItem?.id ?? resolvedPoolItem?.id ?? selectedItem?.id;
    if (libraryItemId != null) modifierNode.properties.output_item_id = libraryItemId;

    if (ownerNode?.properties) {
        if (ownerNode.type === 'Audio/Sequence' && assetPath) {
            await applyLibraryItemToSequence(ownerNode, {
                id: libraryItemId,
                filepath: assetPath,
                itemType: 'midi',
                name: selectedItem?.name || assetPath.split(/[\\/]/).pop(),
                bpm: selectedItem?.bpm || null
            });
        } else {
            if (typeof ownerNode.updateProperty === 'function') {
                ownerNode.updateProperty('filepath', assetPath);
                if (libraryItemId != null) ownerNode.updateProperty('library_item_id', libraryItemId);
                if (resolvedBpm != null) ownerNode.updateProperty('original_bpm', resolvedBpm);
            } else {
                ownerNode.properties.filepath = assetPath;
                if (libraryItemId != null) ownerNode.properties.library_item_id = libraryItemId;
                if (resolvedBpm != null) ownerNode.properties.original_bpm = resolvedBpm;
            }
        }
    }
    return assetPath;
}

function advanceAssetPoolSeed(modifierNode: any) {
    if (modifierNode?.properties?.playbackMode === 'Sequential') {
        const length = Math.max(1, modifierNode.properties.selected_items?.length || 0);
        const storedIndex = Number(modifierNode.properties.sequence_index);
        const currentIndex = Number.isFinite(storedIndex) ? storedIndex : -1;
        const nextIndex = (currentIndex + 1) % length;
        modifierNode.properties.sequence_index = nextIndex;
        modifierNode.properties.seed = nextIndex;
    } else {
        modifierNode.properties.seed = Math.random();
    }
    const modifierData = trackNodes.get(modifierNode.id);
    if (modifierData) modifierData.seed = modifierNode.properties.seed;
}

window.addEventListener('refresh-asset-pool', async (event: Event) => {
    const { modifierId, sampleId } = (event as CustomEvent).detail || {};
    const graph = (window as any).editorGraph as LGraph;
    const modifier = modifierId != null ? graph?.getNodeById(modifierId) : null;
    const sample = sampleId != null ? graph?.getNodeById(sampleId) : null;
    if (!modifier) return;
    if (sample?.properties?.asset_fixed && modifier.properties?.output_value) return;
    try {
        advanceAssetPoolSeed(modifier);
        await resolveAssetFilterNode(modifier, sample, modifier.properties?.playbackMode !== 'Sequential');
        window.dispatchEvent(new CustomEvent('modifier-assignment-changed', { detail: { nodeId: sampleId } }));
        window.dispatchEvent(new CustomEvent('modifier-assignment-changed', { detail: { nodeId: modifierId } }));
        if (sampleId != null) {
            window.dispatchEvent(new CustomEvent('preview-node', {
                detail: { nodeId: sampleId, reason: 'parameter-change' }
            }));
        }
    } catch (error) {
        console.error('Asset Pool refresh failed', error);
        alert(error instanceof Error ? error.message : 'Asset Pool refresh failed.');
    }
});

async function refreshHighlightedNodes(): Promise<number> {
    const graph = (window as any).editorGraph as LGraph;
    if (!graph) return 0;

    const filters = new Map<number, any>();
    const visited = new Set<number>();
    const isAssetFilter = (node: any) => node && (
        node.type === 'Audio/AssetFilter'
        || node.properties?.node_type === 'asset_filter'
        || node.properties?.output_type === 'asset_path'
    );
    const collect = (nodeId: number) => {
        if (visited.has(nodeId)) return;
        visited.add(nodeId);
        const node = graph.getNodeById(nodeId);
        const data = trackNodes.get(nodeId);
        if (!node) return;
        if (isAssetFilter(node)) filters.set(node.id, node);
        const modifierId = node.properties?.asset_modifier_id ?? data?.asset_modifier_id;
        const modifier = modifierId != null ? graph.getNodeById(modifierId) : null;
        if (modifier && isAssetFilter(modifier)) filters.set(modifier.id, modifier);
        for (const childId of data?.children || []) collect(childId);
        for (const input of node.inputs || []) {
            const link = input.link != null ? (graph as any).links?.[input.link] : null;
            if (link?.origin_id != null) collect(link.origin_id);
        }
    };

    for (const node of ((graph as any)._nodes || [])) {
        if (node?.properties?.global_refresh_highlighted) collect(node.id);
    }

    let refreshed = 0;
    for (const modifier of filters.values()) {
        const mode = modifier.properties?.refresh_mode;
        if (mode !== 'global_refresh') continue;
        const parentNode = modifier.properties?.parentId != null
            ? graph.getNodeById(modifier.properties.parentId)
            : undefined;
        if (parentNode?.properties?.asset_fixed && modifier.properties?.output_value) continue;
        advanceAssetPoolSeed(modifier);
        await resolveAssetFilterNode(modifier, parentNode, modifier.properties?.playbackMode !== 'Sequential');
        refreshed++;
        window.dispatchEvent(new CustomEvent('modifier-assignment-changed', { detail: { nodeId: modifier.id } }));
        if (parentNode) {
            window.dispatchEvent(new CustomEvent('modifier-assignment-changed', { detail: { nodeId: parentNode.id } }));
            parentNode.setDirtyCanvas?.(true, true);
        }
    }
    (window as any).editorCanvas?.setDirty?.(true, true);
    return refreshed;
}

async function resolveAssignedAssetFilters(graph: LGraph, rootNodeId: number) {
    const visited = new Set<number>();
    const visit = async (nodeId: number) => {
        if (visited.has(nodeId)) return;
        visited.add(nodeId);
        const node = graph.getNodeById(nodeId);
        const data = trackNodes.get(nodeId);
        const modifierId = node?.properties?.asset_modifier_id ?? data?.asset_modifier_id;
        if (modifierId != null) {
            const modifier = graph.getNodeById(modifierId);
            if (modifier) {
                const refreshMode = modifier.properties?.refresh_mode || 'parent_refresh';
                const hasResolvedAsset = Boolean(modifier.properties?.output_value);
                const assetFixed = Boolean(node?.properties?.asset_fixed) && hasResolvedAsset;
                const isLocalRender = nodeId === rootNodeId;
                const refreshLocally = (refreshMode === 'local_refresh' || refreshMode === 'manual') && isLocalRender;
                const refreshWithParent = (refreshMode === 'parent_refresh' || refreshMode === 'parent_render') && !isLocalRender;
                const shouldRefresh = !assetFixed && (refreshLocally || refreshWithParent);
                if (shouldRefresh) advanceAssetPoolSeed(modifier);
                if (shouldRefresh || !hasResolvedAsset) {
                    await resolveAssetFilterNode(modifier, node, shouldRefresh);
                } else if (node?.properties) {
                    const sampleNode = node as any;
                    const assetPath = modifier.properties.output_value;
                    const selectedItem = (modifier.properties.selected_items || []).find((item: any) =>
                        (item.absolute_path || item.filepath) === assetPath
                    );
                    const preferredId = modifier.properties.output_item_id ?? selectedItem?.id;
                    sampleNode.updateProperty?.('filepath', assetPath);
                    if (preferredId != null) sampleNode.updateProperty?.('library_item_id', preferredId);
                    const sync = sampleNode.syncOriginalBpmFromLibrary;
                    const synced = typeof sync === 'function'
                        ? await sync.call(sampleNode, undefined, preferredId)
                        : false;
                    if (synced) {
                        modifier.properties.output_bpm = sampleNode.properties.original_bpm;
                        modifier.properties.output_item_id = sampleNode.properties.library_item_id ?? preferredId;
                        if (selectedItem) {
                            selectedItem.bpm = sampleNode.properties.original_bpm;
                            selectedItem.original_bpm = sampleNode.properties.original_bpm;
                        }
                    } else if (modifier.properties.output_bpm != null) {
                        sampleNode.updateProperty?.('original_bpm', modifier.properties.output_bpm);
                    }
                }
            }
        }
        for (const childId of data?.children || []) await visit(childId);
        for (const input of node?.inputs || []) {
            const link = input.link != null ? (graph as any).links?.[input.link] : null;
            if (link?.origin_id != null) await visit(link.origin_id);
        }
    };
    await visit(rootNodeId);
}

function serializeNodeSubtree(graph: LGraph, rootNodeId: number) {
    function buildNodeModel(nodeId: number): any {
        const data = trackNodes.get(nodeId);
        const nodeObj = graph.getNodeById(nodeId);
        if (!data && !nodeObj) return null;
        syncGhostTrackData(nodeObj, data);
        if (data?.type === 'disabled' || nodeObj?.properties?.disabled || nodeObj?.type === 'Audio/Disabled') {
            console.warn(`Skipping disabled node ${nodeId} during serialization.`);
            return null;
        }

        const name = data?.name || nodeObj?.title || nodeObj?.properties?.node_name || "AudioNode";
        const assignedModifierId = nodeObj?.properties?.asset_modifier_id ?? data?.asset_modifier_id;
        const assignedModifier = assignedModifierId != null ? graph.getNodeById(assignedModifierId) : null;
        const filepath = assignedModifier?.properties?.output_value || data?.filepath || nodeObj?.properties?.filepath || null;
        const original_bpm = assignedModifier?.properties?.output_bpm || data?.original_bpm || nodeObj?.properties?.original_bpm || 120;
        const target_bpm = data?.target_bpm || nodeObj?.properties?.target_bpm || data?.bpm || nodeObj?.properties?.bpm || 120;
        const key = data?.key || nodeObj?.properties?.key || "";
        const start_beat = data?.start_beat || nodeObj?.properties?.start_beat || 0;
        const bpm = target_bpm;
        const mix_mode = data?.mix_mode || nodeObj?.properties?.mix_mode || "sum";

        const nodeType = data?.type || nodeObj?.properties?.node_type || (nodeObj?.type === "Audio/Sample" ? "sample" : nodeObj?.type === "Audio/Sequence" ? "sequence" : "track");
        // Graph properties are the canonical editable state. `trackNodes` is a UI
        // cache and can lag when an editor normalizes/replaces an array.
        const sequence = nodeObj?.properties?.sequence ?? data?.sequence ?? (nodeType === "sequence" ? [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] : undefined);
        const rawStepParameters = nodeObj?.properties?.step_parameters ?? data?.step_parameters;
        const stepParameters = Array.isArray(rawStepParameters)
            ? rawStepParameters.map((step: any) => ({ ...(step || {}) }))
            : undefined;
        const stepLength = nodeObj?.properties?.step_length ?? data?.step_length ?? (nodeType === "sequence" ? 0.25 : undefined);
        const total_bars = nodeObj?.properties?.total_bars ?? data?.total_bars ?? (nodeType === "arrangement" ? 4.0 : undefined);
        const probability = nodeObj?.properties?.probability ?? data?.probability ?? (nodeType === "arrangement" ? 1.0 : undefined);
        const section_points = nodeObj?.properties?.section_points ?? data?.section_points ?? (nodeType === "arrangement" ? [] : undefined);
        const section_enabled = nodeObj?.properties?.section_enabled ?? data?.section_enabled ?? (nodeType === "arrangement" ? [true] : undefined);
        const section_probability = nodeObj?.properties?.section_probability ?? data?.section_probability ?? (nodeType === "arrangement" ? [1.0] : undefined);
        const section_quant = nodeObj?.properties?.section_quant ?? data?.section_quant ?? (nodeType === "arrangement" ? ["global"] : undefined);
        const section_quant_anchor = nodeObj?.properties?.section_quant_anchor ?? data?.section_quant_anchor ?? (nodeType === "arrangement" ? ["global"] : undefined);
        const quant = nodeObj?.properties?.quant ?? data?.quant ?? (nodeType === "arrangement" ? "none" : undefined);
        const quant_anchor = nodeObj?.properties?.quant_anchor ?? data?.quant_anchor ?? (nodeType === "arrangement" ? "start" : undefined);

        const rawFilters = data?.filters || nodeObj?.properties?.filters || {};
        const filters = rawFilters;
        const selected_items = data?.selected_items || nodeObj?.properties?.selected_items || [];
        const playbackMode = data?.playbackMode || nodeObj?.properties?.playbackMode;
        const refresh_mode = data?.refresh_mode || nodeObj?.properties?.refresh_mode || "manual";
        let seed = data?.seed || nodeObj?.properties?.seed;
        const seed_mode = data?.seed_mode || nodeObj?.properties?.seed_mode || (nodeType === "sequence" ? "moving" : undefined);

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
        for (const [mid, mdata] of trackNodes.entries()) {
            if (mdata.type === "modulator" && mdata.parentId === nodeId) {
                const mNodeObj = graph.getNodeById(mid);
                modulatorModels.push({
                    id: mid,
                    node_name: mdata.name || mNodeObj?.title || "Modulator",
                    chain: mNodeObj?.properties?.chain || mdata.chain || []
                });
            }
        }

        const sample_type = data?.sample_type || nodeObj?.properties?.sample_type || "loop";
        const crop_start = data?.crop_start ?? nodeObj?.properties?.crop_start ?? 0.0;
        const crop_end = data?.crop_end ?? nodeObj?.properties?.crop_end ?? 1.0;
        const transpose = data?.transpose ?? nodeObj?.properties?.transpose ?? 0.0;
        const cents = data?.cents ?? nodeObj?.properties?.cents ?? 0.0;
        const stretch_mode = data?.stretch_mode || nodeObj?.properties?.stretch_mode || "time_stretch";
        const stretch_factor = data?.stretch_factor ?? nodeObj?.properties?.stretch_factor ?? 1.0;

        return {
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
            sequence: sequence,
            step_parameters: stepParameters,
            step_length: stepLength,
            play_mode: nodeObj?.properties?.play_mode ?? data?.play_mode ?? (nodeType === "sequence" ? "gate" : undefined),
            total_bars: total_bars,
            probability: probability,
            section_points: section_points,
            section_enabled: section_enabled,
            section_probability: section_probability,
            section_quant: section_quant,
            section_quant_anchor: section_quant_anchor,
            quant: quant,
            quant_anchor: quant_anchor,
            filters: filters,
            selected_items: selected_items,
            playbackMode: playbackMode,
            seed: seed,
            seed_mode: seed_mode,
            refresh_mode: refresh_mode,
            chain: chain,
            modulators: modulatorModels,
            children: childModels
        };
    }

    return buildNodeModel(rootNodeId);
}

async function renderNode(nodeId: number) {
    const graph = (window as any).editorGraph as LGraph;
    if (!graph) return;

    try {
        await resolveAssignedAssetFilters(graph, nodeId);
    } catch (error) {
        console.error('Asset Filter resolution failed', error);
        alert('Could not resolve the assigned Asset Filter.');
        return;
    }
    const payload = serializeNodeSubtree(graph, nodeId);
    if (!payload) {
        alert("Could not serialize node for rendering.");
        return;
    }

    payload.filename = `export_${nodeId}`;

    try {
        const res = await fetch('/api/render', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
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

        if (data.status === 'success' && data.filename) {
            await updateTempRendersList(data.filename);
            masterPlayer.play().catch(e => console.error(e));
        } else {
            console.error("Render failed:", data);
            alert("Render failed, check console.");
        }
    } catch (err) {
        console.error("Error during render:", err);
        alert(`Error during render: ${(err as Error).message || err}`);
    }
}

type PreviewRequest = {
    nodeId: number;
    autoplay: boolean;
};

let pendingPreviewRequest: PreviewRequest | null = null;
let previewRequestVersion = 0;
let previewWorker: Promise<void> | null = null;

async function calculatePreview(nodeId: number, requestVersion: number, autoplay: boolean) {
    const graph = (window as any).editorGraph as LGraph;
    if (!graph) throw new Error('Graph is unavailable.');



    try {
        await resolveAssignedAssetFilters(graph, nodeId);
    } catch (error) {
        console.error('Asset Filter resolution failed', error);
        throw new Error('Could not resolve the assigned Asset Filter.');
    }
    const payload = serializeNodeSubtree(graph, nodeId);
    if (!payload) {
        throw new Error("Could not serialize node for preview.");
    }

    const keyName = `export_${nodeId}`;
    payload.filename = keyName;

    try {
        const res = await fetch('/api/preview', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

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

        if (data.status === 'success' && data.audio_url) {
            if (requestVersion !== previewRequestVersion) return;
            activeRamPreviewNodeId = nodeId;
            activeRamPreviewPayload = payload;

            setMasterPlayerSource(data.audio_url, autoplay);

            // Add/select RAM preview entry in toolbar dropdown
            let ramOpt = Array.from(tempFilesSelect.options).find(o => o.value === 'RAM_PREVIEW');
            if (!ramOpt) {
                ramOpt = document.createElement('option');
                ramOpt.value = 'RAM_PREVIEW';
                ramOpt.textContent = `⚡ [RAM Preview] ${payload.node_name}`;
                tempFilesSelect.insertBefore(ramOpt, tempFilesSelect.firstChild);
            } else {
                ramOpt.textContent = `⚡ [RAM Preview] ${payload.node_name}`;
            }
            tempFilesSelect.value = 'RAM_PREVIEW';
        } else {
            throw new Error(data.detail || "RAM preview calculation failed.");
        }
    } catch (err) {
        console.error("Error during RAM preview:", err);
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
                await calculatePreview(request.nodeId, requestVersion, request.autoplay);
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

function previewNode(nodeId: number, autoplay: boolean = true): Promise<void> {
    pendingPreviewRequest = { nodeId, autoplay };
    previewRequestVersion++;
    setPreviewCalculatingState();
    if (!previewWorker) previewWorker = runPreviewQueue();
    return previewWorker;
}
