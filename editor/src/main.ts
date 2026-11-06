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
import './nodes/RandomNode';
import './nodes/DisabledNode';
import { isModifierNode } from './nodes/BaseNode';
import { PropertiesWindow } from './ui/PropertiesWindow';
import { TrackPropertiesWindow } from './ui/TrackPropertiesWindow';
import { NodePopupMenu } from './ui/NodePopupMenu';
import { NodeContextMenu } from './ui/NodeContextMenu';
import { isLibraryPreviewEnabled, LibraryPanel, setLibraryPreviewEnabled } from './ui/LibraryPanel';
import { MasterWaveform } from './ui/MasterWaveform';
import { RuntimeLogPanel } from './ui/RuntimeLogPanel';
import { EngineSyncManager } from './ui/EngineSyncManager';
import { FileExplorerModal } from './ui/FileExplorerModal';
import {
    createAppShell,
    HEADER_LOCK_CLOSED_ICON_SVG,
    HEADER_LOCK_OPEN_ICON_SVG,
    HEADER_PAUSE_ICON_SVG,
    HEADER_PLAY_ICON_SVG,
    HEADER_REFRESH_ICON_SVG,
    mutedIcon,
    pauseIcon,
    playIcon,
    volumeIcon
} from './ui/AppShell';
import {
    frameCanvasSelectionOrGraph,
    getDistanceToCubicBezier,
    getLinkControlPoints,
    getLinkEndpoints,
    LEFT_PORT_BRANCH_INPUT,
    markLeftPortBranch,
    syncAllModifierPositions,
    syncNodesDistanceStage,
    updateModifiersForParent
} from './canvas/canvasGeometry';
import { readProgressivePreviewStream } from './network/previewStreamReader';
import { appendServerRuntimeLog, installFetchLogging, loggedTask, runtimeLog, updateEngineTelemetry } from './runtimeLog';
import { attachGhostProperties, createGhostNode, detachGhostDependents, getGhostSource, isGhostNode, syncGhostTrackData } from './ghosts';
import { installSeparatedNodeClipboard } from './nodeClipboard';
import { clearLibraryCache, fetchLibrary, findLibraryFile, findLibraryFileById, findLibraryFileForPoolLocator, refreshLibraryAssetSnapshot, resolveLibraryAssets, type LibraryFile } from './api';
import { serializeNodeSubtree } from '../../ermes/ts/serializer';
import { advanceAssetPoolSeed, normalizeAssetRefreshMode, populateOwnerSlotsFromPool, resolveAssetFilterNode, resolveAssignedAssetFilters } from '../../ermes/ts/assetResolver';
import {
    getGlobalSeed,
    setGlobalSeed,
    isGlobalSeedLocked,
    setGlobalSeedLocked,
    resolveAssignedRandomModifiers,
    refreshArmedSeeds
} from '../../ermes/ts/randomResolver';
import { defaultTransportClock } from '../../packages/iride/src/index.ts';
import { clearAudioBufferCache, fetchAudioBuffer, getSharedAudioContext } from './audioBufferCache';
import { globalAudioScheduler } from './audioScheduler';
import { getNodeGainMultiplier } from './audioCompositor';
import { applySignalFlowColors } from './graphColorEngine';

export { syncAllModifierPositions, syncNodesDistanceStage, updateModifiersForParent };

const appElement = document.getElementById('app');
if (!appElement) throw new Error('Could not find #app element');

appElement.className = 'dockview-theme-light';
installFetchLogging();

// Instantiate Node Type Popup Menu & Node Context Menu
const popupMenu = new NodePopupMenu();
const nodeContextMenu = new NodeContextMenu();

const {
    topHeader,
    dockviewContainer,
    playbackFooter,
    tempFilesSelect,
    masterPlayer,
    masterPlayBtn,
    masterLoopBtn,
    masterMuteBtn,
    masterVolume,
    exportBtn,
    globalPreviewBtn,
    previewRecalculateBtn,
    globalSeedInput,
    globalSeedLockBtn,
    globalFreezeBtn,
    toggleLibraryBtn,
    refreshLibraryBtn,
    toggleLibraryPreviewBtn,
    headerToggleLibrary,
    headerToggleProperties,
    fileMenu,
    libraryMenu,
    renderMenu,
    renderFlaggedBtn,
    renderSelectedBtn,
    renderMostParentBtn,
    renderAllBtn,
    newStageBtn,
    masterWaveformElement,
    workspacePresetSelect,
    saveWorkspaceAsBtn,
    saveWorkspaceBtn,
    loadWorkspaceBtn,
    openWorkspaceBtn,
    openRecentTriggerBtn,
    openRecentPopover,
    deleteWorkspaceBtn,
} = createAppShell(appElement);

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
    defaultTransportClock.setBpm(globalParameters.bpm);
    writeGlobalParametersToGraph(graph);
    syncGraphHierarchy(graph);
    const targetGraph = graph || ((window as any).editorGraph as LGraph);
    for (const node of (((targetGraph as any)?._nodes || []) as any[])) {
        node?.onGlobalParametersChanged?.({ ...globalParameters });
        if (node) {
            (node as any).isInvalidated = true;
            node.setDirtyCanvas?.(true, true);
        }
    }
    window.dispatchEvent(new CustomEvent('global-parameters-changed', { detail: { ...globalParameters } }));
    fetch('/api/preview/invalidate', { method: 'POST' }).catch(() => { });
    if (globalAudioScheduler.getIsPlaying()) {
        const targetId = (activeRamPreviewNodeId != null && targetGraph?.getNodeById(activeRamPreviewNodeId))
            ? activeRamPreviewNodeId
            : resolveMainPreviewNode(targetGraph)?.id;
        if (targetId != null) {
            void previewNode(targetId, false, false, false);
        }
    }
    (window as any).editorCanvas?.setDirty?.(true, true);
}

function loadGlobalParametersFromGraph(graph: LGraph) {
    const saved = (graph as any).extra?.global_parameters || DEFAULT_GLOBAL_PARAMETERS;
    setGlobalParameters(saved, graph);
}

(window as any).getGlobalParameter = (key: keyof GlobalParameters) => globalParameters[key];
(window as any).setGlobalParameters = (values: Partial<GlobalParameters>, graph?: LGraph) => setGlobalParameters(values, graph);

let isGlobalFreezeActive = false;

function updateGlobalFreezeButtonState() {
    if (!globalFreezeBtn) return;
    globalFreezeBtn.setAttribute('aria-pressed', String(isGlobalFreezeActive));
    if (isGlobalFreezeActive) {
        globalFreezeBtn.classList.add('active');
        globalFreezeBtn.title = "Global Freeze: ON (Flagged nodes are frozen)";
    } else {
        globalFreezeBtn.classList.remove('active');
        globalFreezeBtn.title = "Global Freeze: OFF (Flagged nodes refresh on recalculate)";
    }
}

function writeGlobalFreezeToGraph(graph?: LGraph) {
    const targetGraph = graph || ((window as any).editorGraph as LGraph);
    if (!targetGraph) return;
    const graphWithExtra = targetGraph as any;
    if (!graphWithExtra.extra) graphWithExtra.extra = {};
    graphWithExtra.extra.global_freeze = Boolean(isGlobalFreezeActive);
}

function setGlobalFreeze(active: boolean, graph?: LGraph, triggerSave: boolean = true) {
    isGlobalFreezeActive = Boolean(active);
    updateGlobalFreezeButtonState();
    writeGlobalFreezeToGraph(graph);
    window.dispatchEvent(new CustomEvent('global-freeze-changed', { detail: { frozen: isGlobalFreezeActive } }));
    if (triggerSave) {
        scheduleStageSave();
    }
}

function loadGlobalFreezeFromGraph(graphOrPreset: any, targetGraph?: LGraph) {
    const extra = graphOrPreset?.extra || graphOrPreset?.graph?.extra;
    const isFrozen = Boolean(graphOrPreset?.frozen || extra?.global_freeze || extra?.freeze);
    setGlobalFreeze(isFrozen, targetGraph, false);
    if (targetGraph) {
        if (!(targetGraph as any).extra) (targetGraph as any).extra = {};
        if (extra?.global_seed !== undefined) {
            setGlobalSeed(targetGraph, Number(extra.global_seed));
        } else if ((targetGraph as any).extra.global_seed === undefined) {
            setGlobalSeed(targetGraph, 0);
        }
        setGlobalSeedLocked(targetGraph, Boolean(extra?.global_seed_locked));
        syncGlobalSeedControlsUI(targetGraph);
    }
}

function syncGlobalSeedControlsUI(graph?: LGraph) {
    const targetGraph = graph || ((window as any).editorGraph as LGraph);
    const seedVal = getGlobalSeed(targetGraph);
    const locked = isGlobalSeedLocked(targetGraph);
    if (globalSeedInput && document.activeElement !== globalSeedInput) {
        globalSeedInput.value = String(seedVal);
    }
    if (globalSeedLockBtn) {
        globalSeedLockBtn.setAttribute('aria-pressed', String(locked));
        globalSeedLockBtn.classList.toggle('active', locked);
        globalSeedLockBtn.innerHTML = locked ? HEADER_LOCK_CLOSED_ICON_SVG : HEADER_LOCK_OPEN_ICON_SVG;
        globalSeedLockBtn.title = locked
            ? 'Global Seed Locked: Refresh only re-rolls field expressions (pools and random mods stay fixed)'
            : 'Lock Global Seed (keep pool order and random mod values on refresh)';
    }
}

(window as any).getGlobalFreeze = () => isGlobalFreezeActive;
(window as any).setGlobalFreeze = (val: boolean, graph?: LGraph) => setGlobalFreeze(val, graph);
(window as any).loadGlobalFreezeFromGraph = (data: any, graph?: LGraph) => loadGlobalFreezeFromGraph(data, graph);
(window as any).syncGlobalSeedControlsUI = (graph?: LGraph) => syncGlobalSeedControlsUI(graph);

function updatePlaybackControls() {
    const isPlaying = globalAudioScheduler.getIsPlaying() || (loopEnabled ? loopSource !== null || !masterPlayer.paused && !masterPlayer.ended : !masterPlayer.paused && !masterPlayer.ended);
    masterPlayBtn.innerHTML = isPlaying ? pauseIcon : playIcon;
    masterPlayBtn.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
    masterPlayBtn.title = isPlaying ? 'Pause' : 'Play';

    globalPreviewBtn.innerHTML = isPlaying ? HEADER_PAUSE_ICON_SVG : HEADER_PLAY_ICON_SVG;
    globalPreviewBtn.setAttribute('aria-label', isPlaying ? 'Pause transport (Space)' : 'Play transport (Space)');
    globalPreviewBtn.title = isPlaying ? 'Pause transport (Space)' : 'Play transport (Space)';

    const isLooping = loopEnabled;
    masterLoopBtn.disabled = masterPlayBtn.disabled;
    masterLoopBtn.classList.toggle('is-active', isLooping);
    masterLoopBtn.setAttribute('aria-pressed', String(isLooping));
    masterLoopBtn.setAttribute('aria-label', isLooping ? 'Loop on' : 'Loop off');
    masterLoopBtn.title = isLooping ? 'Loop on' : 'Loop off';
    const isMuted = masterPlayer.muted || masterPlayer.volume === 0;
    masterMuteBtn.innerHTML = isMuted ? mutedIcon : volumeIcon;
    masterMuteBtn.setAttribute('aria-label', isMuted ? 'Unmute' : 'Mute');
    masterMuteBtn.title = isMuted ? 'Unmute' : 'Mute';
}

function updatePlaybackTrackPresentation() {
    tempFilesSelect.classList.toggle('is-ram-preview', tempFilesSelect.value === 'RAM_PREVIEW');
}

let pendingMasterSeek: number | null = null;
let loopEnabled = false;
let loopBuffer: AudioBuffer | null = null;
let loopBufferRequestId = 0;
let loopLoad: Promise<AudioBuffer | null> = Promise.resolve(null);
let loopSource: AudioBufferSourceNode | null = null;
let loopContext: AudioContext | null = null;
let loopGain: GainNode | null = null;
let loopStartedAt = 0;
let loopOffset = 0;
let loopAnimationFrame: number | null = null;

const masterWaveform = new MasterWaveform(masterWaveformElement, (progress) => {
    const isSchedPlaying = globalAudioScheduler.getIsPlaying();
    const duration = isSchedPlaying
        ? globalAudioScheduler.getTotalDuration()
        : (Number.isFinite(masterPlayer.duration) && masterPlayer.duration > 0
            ? masterPlayer.duration
            : masterWaveform.duration);
    if (duration <= 0) return;
    const targetTime = Math.max(0, Math.min(duration, progress * duration));
    pendingMasterSeek = targetTime;
    masterWaveform.setPlayback(targetTime, duration);
    if (activeRamPreviewNodeId != null && globalAudioScheduler.getTotalDuration() > 0) {
        globalAudioScheduler.seek(targetTime);
        if (isSchedPlaying) return;
    }
    if (loopEnabled) {
        const wasPlaying = loopSource !== null || !masterPlayer.paused;
        loopOffset = targetTime;
        stopLoop(false);
        masterPlayer.pause();
        if (wasPlaying) void playLoop(targetTime);
    }
    try {
        masterPlayer.currentTime = targetTime;
    } catch (error) {
        pendingMasterSeek = null;
        console.error('Seek failed', error);
    }
});

function loopTime() {
    if (!loopSource || !loopContext || !loopBuffer?.duration) return Number.isFinite(masterPlayer.currentTime) ? masterPlayer.currentTime : loopOffset;
    return (loopOffset + Math.max(0, loopContext.currentTime - loopStartedAt)) % loopBuffer.duration;
}

function animateLoop() {
    if (!loopSource || !loopBuffer) return;
    masterWaveform.setPlayback(loopTime(), loopBuffer.duration);
    loopAnimationFrame = requestAnimationFrame(animateLoop);
}

function stopLoop(savePosition: boolean) {
    globalAudioScheduler.stop();
    if (loopSource) {
        if (savePosition) loopOffset = loopTime();
        try { loopSource.stop(); } catch { /* already stopped */ }
        loopSource.disconnect();
        loopSource = null;
    }
    if (loopAnimationFrame !== null) cancelAnimationFrame(loopAnimationFrame);
    loopAnimationFrame = null;
    stopPlaybackTelemetry();
}

function syncLoopGain() {
    if (loopGain) loopGain.gain.value = masterPlayer.muted ? 0 : masterPlayer.volume;
}

function playNativeLoop(offset: number) {
    masterPlayer.loop = true;
    try { masterPlayer.currentTime = Math.max(0, offset); } catch { /* metadata is still loading */ }
    masterPlayer.play().catch(error => console.error('Play failed', error));
}

async function playLoop(offset: number, requestId = loopBufferRequestId) {
    const buffer = loopBuffer || await loopLoad;
    if (!loopEnabled || requestId !== loopBufferRequestId) return;
    if (!buffer || !masterWaveform.playbackContext) {
        playNativeLoop(offset);
        return;
    }

    const context = masterWaveform.playbackContext;
    try {
        await context.resume();
    } catch {
        playNativeLoop(offset);
        return;
    }
    if (!loopEnabled || requestId !== loopBufferRequestId) return;
    stopLoop(false);
    if (!loopGain || loopContext !== context) {
        loopGain?.disconnect();
        loopGain = context.createGain();
        const analyser = getOrCreateMasterAnalyser(context);
        if (analyser) {
            loopGain.connect(analyser);
            analyser.connect(context.destination);
        } else {
            loopGain.connect(context.destination);
        }
    }
    loopContext = context;
    syncLoopGain();
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.loopEnd = buffer.duration;
    source.connect(loopGain);
    loopOffset = ((offset % buffer.duration) + buffer.duration) % buffer.duration;
    loopStartedAt = context.currentTime;
    source.start(0, loopOffset);
    loopSource = source;
    masterPlayer.loop = false;
    animateLoop();
    startPlaybackTelemetry();
    updatePlaybackControls();
}

function loadLoopBuffer(source: string) {
    const requestId = ++loopBufferRequestId;
    loopBuffer = null;
    loopLoad = masterWaveform.load(source).then(buffer => {
        if (requestId === loopBufferRequestId) {
            loopBuffer = buffer;
            (window as any).activeRamPreviewBuffer = buffer;
            (window as any).editorCanvas?.setDirty?.(true, true);
        }
        return buffer;
    });
    return requestId;
}

function setMasterPlayerSource(source: string, autoplay: boolean = false) {
    pendingMasterSeek = null;
    stopLoop(false);
    masterPlayer.loop = false;
    masterPlayer.pause();
    masterPlayer.removeAttribute('aria-disabled');
    // Render filenames and RAM-preview URLs are content-versioned by the
    // backend. Preserving that URL lets the player and waveform request share
    // the browser cache; a timestamp here forced two full transfers.
    masterPlayer.src = source;
    runtimeLog(`Audio stream assigned: ${source}`, 'debug');
    masterPlayBtn.disabled = false;
    masterLoopBtn.disabled = false;
    masterPlayer.load();
    const requestId = loadLoopBuffer(source);
    updatePlaybackControls();
    if (autoplay) {
        if (loopEnabled) {
            void playLoop(0, requestId);
        } else {
            masterPlayer.play().catch(error => console.error('Play failed', error));
        }
    }
}

function setPreviewCalculatingState(isHotSwap: boolean = false) {
    if (isHotSwap) return;
    EngineSyncManager.getInstance().setState('dsp_rendering');
    ++loopBufferRequestId;
    loopBuffer = null;
    loopLoad = Promise.resolve(null);
    stopLoop(false);
    masterPlayer.loop = false;
    if (!masterPlayer.paused) {
        masterPlayer.pause();
    }
    masterPlayer.setAttribute('aria-disabled', 'true');
    masterPlayBtn.disabled = true;
    masterLoopBtn.disabled = true;
    masterWaveform.clear('Calculating preview...');
    updatePlaybackControls();
}

function setPreviewFailedState() {
    EngineSyncManager.getInstance().setState('error', { errorMessage: 'Preview calculation failed' });
    masterPlayer.setAttribute('aria-disabled', 'true');
    masterPlayBtn.disabled = true;
    masterLoopBtn.disabled = true;
    masterWaveform.clear('Preview failed');
    updatePlaybackControls();
}

masterPlayer.addEventListener('timeupdate', () => {
    if (!globalAudioScheduler.getIsPlaying() && !loopEnabled && pendingMasterSeek === null && Number.isFinite(masterPlayer.duration) && masterPlayer.duration > 0) {
        masterWaveform.setPlayback(masterPlayer.currentTime, masterPlayer.duration);
    }
});
masterPlayer.addEventListener('loadedmetadata', () => {
    runtimeLog(`Audio stream metadata loaded (${masterPlayer.duration.toFixed(3)} s)`, 'debug');
    if (loopEnabled) {
        masterWaveform.setPlayback(loopTime(), masterPlayer.duration);
        return;
    }
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
let telemetryAnimationFrame: number | null = null;
let masterAudioAnalyser: AnalyserNode | null = null;
let mediaElementSourceAttached = false;
const scopeDataBuffer = new Float32Array(128);
const spectrumDataBuffer = new Uint8Array(128);

function getOrCreateMasterAnalyser(ctx?: AudioContext | null): AnalyserNode | null {
    if (masterAudioAnalyser) return masterAudioAnalyser;
    const targetCtx = ctx || masterWaveform.playbackContext || loopContext;
    if (!targetCtx) return null;
    try {
        const analyser = targetCtx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.5;
        masterAudioAnalyser = analyser;
        return analyser;
    } catch {
        return null;
    }
}

function attachMasterMediaElementSource(): void {
    if (mediaElementSourceAttached) return;
    const ctx = masterWaveform.playbackContext || loopContext || getSharedAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
        ctx.resume().catch(() => { });
    }
    try {
        const sourceNode = ctx.createMediaElementSource(masterPlayer);
        const analyser = getOrCreateMasterAnalyser(ctx);
        if (analyser) {
            sourceNode.connect(analyser);
            analyser.connect(ctx.destination);
        } else {
            sourceNode.connect(ctx.destination);
        }
        mediaElementSourceAttached = true;
    } catch {
        // Ignored if already attached
    }
}

let playbackAnchorAudioTime = 0;
let playbackAnchorWallTime = 0;

function syncPlaybackAnchor(audioTime?: number) {
    playbackAnchorAudioTime = audioTime !== undefined ? audioTime : (Number.isFinite(masterPlayer.currentTime) ? masterPlayer.currentTime : 0);
    playbackAnchorWallTime = performance.now() / 1000;
}

function getSmoothPlaybackTime(dur: number): number {
    if (loopEnabled) {
        return loopTime();
    }
    if (masterPlayer.paused || masterPlayer.ended) {
        return Number.isFinite(masterPlayer.currentTime) ? masterPlayer.currentTime : 0;
    }
    const elapsed = (performance.now() / 1000) - playbackAnchorWallTime;
    const estimated = playbackAnchorAudioTime + elapsed;
    if (dur > 0) {
        return Math.max(0, Math.min(dur, estimated));
    }
    return Math.max(0, estimated);
}

function tickPlaybackTelemetry() {
    const isSchedulerPlaying = globalAudioScheduler.getIsPlaying();
    const isPlaying = isSchedulerPlaying || (loopEnabled ? Boolean(loopSource) : (!masterPlayer.paused && !masterPlayer.ended));
    let dur = 0;
    let curTime = 0;

    if (isSchedulerPlaying) {
        globalAudioScheduler.tick();
        curTime = globalAudioScheduler.getCurrentTime();
        dur = globalAudioScheduler.getTotalDuration();
        globalAudioScheduler.getFloatTimeDomainData(scopeDataBuffer);
        globalAudioScheduler.getByteFrequencyData(spectrumDataBuffer);
        defaultTransportClock.setRealtimeScopeData(scopeDataBuffer);
        defaultTransportClock.setRealtimeSpectrumData(spectrumDataBuffer);
    } else {
        dur = loopEnabled && loopBuffer?.duration ? loopBuffer.duration : (Number.isFinite(masterPlayer.duration) ? masterPlayer.duration : 0);
        curTime = getSmoothPlaybackTime(dur);

        if (isPlaying && !masterAudioAnalyser) {
            attachMasterMediaElementSource();
        }

        if (isPlaying && masterAudioAnalyser) {
            masterAudioAnalyser.getFloatTimeDomainData(scopeDataBuffer);
            masterAudioAnalyser.getByteFrequencyData(spectrumDataBuffer);
            defaultTransportClock.setRealtimeScopeData(scopeDataBuffer);
            defaultTransportClock.setRealtimeSpectrumData(spectrumDataBuffer);
        } else {
            defaultTransportClock.setRealtimeScopeData(null);
            defaultTransportClock.setRealtimeSpectrumData(null);
        }
    }

    if (dur > 0 && isPlaying) {
        masterWaveform.setPlayback(curTime, dur);
    }

    defaultTransportClock.setBpm(
        globalAudioScheduler.getIsPlaying()
            ? (globalAudioScheduler.getBpm() || globalParameters.bpm)
            : globalParameters.bpm
    );
    defaultTransportClock.update(curTime, dur, isPlaying);
    (window as any).editorCanvas?.setDirty?.(true, false);

    if (isPlaying) {
        telemetryAnimationFrame = requestAnimationFrame(tickPlaybackTelemetry);
    } else {
        telemetryAnimationFrame = null;
    }
}

function startPlaybackTelemetry() {
    attachMasterMediaElementSource();
    syncPlaybackAnchor(masterPlayer.currentTime);
    if (telemetryAnimationFrame === null) {
        telemetryAnimationFrame = requestAnimationFrame(tickPlaybackTelemetry);
    }
}

function stopPlaybackTelemetry() {
    if (telemetryAnimationFrame !== null) {
        cancelAnimationFrame(telemetryAnimationFrame);
        telemetryAnimationFrame = null;
    }
    const dur = loopEnabled && loopBuffer?.duration ? loopBuffer.duration : (Number.isFinite(masterPlayer.duration) ? masterPlayer.duration : 0);
    const curTime = loopEnabled ? loopTime() : (Number.isFinite(masterPlayer.currentTime) ? masterPlayer.currentTime : 0);
    defaultTransportClock.setRealtimeScopeData(null);
    defaultTransportClock.update(curTime, dur, false);
    (window as any).editorCanvas?.setDirty?.(true, true);
}

masterPlayer.addEventListener('seeked', () => {
    pendingMasterSeek = null;
    syncPlaybackAnchor(masterPlayer.currentTime);
    if (!loopEnabled && Number.isFinite(masterPlayer.duration) && masterPlayer.duration > 0) {
        masterWaveform.setPlayback(masterPlayer.currentTime, masterPlayer.duration);
    }
});
masterPlayer.addEventListener('play', () => {
    updatePlaybackControls();
    syncPlaybackAnchor(masterPlayer.currentTime);
    startPlaybackTelemetry();
});
masterPlayer.addEventListener('playing', () => {
    syncPlaybackAnchor(masterPlayer.currentTime);
});
masterPlayer.addEventListener('pause', () => {
    updatePlaybackControls();
    stopPlaybackTelemetry();
});
masterPlayer.addEventListener('ended', () => {
    if (loopEnabled) return;
    masterWaveform.setPlayback(masterPlayer.duration, masterPlayer.duration);
    updatePlaybackControls();
    stopPlaybackTelemetry();
});

async function toggleTransportPlayback(): Promise<void> {
    const isPlaying = globalAudioScheduler.getIsPlaying()
        || (!masterPlayer.paused && !masterPlayer.ended)
        || (loopEnabled && Boolean(loopSource));

    if (isPlaying) {
        if (globalAudioScheduler.getIsPlaying()) {
            globalAudioScheduler.pause();
        }
        if (!masterPlayer.paused) {
            masterPlayer.pause();
        }
        if (loopEnabled && loopSource) {
            stopLoop(true);
        }
        updatePlaybackControls();
        stopPlaybackTelemetry();
        return;
    }

    // If a preview is currently buffering to auto-play and user toggles transport again, cancel auto-play
    if (previewWorker && activePreviewAutoplay) {
        activePreviewAutoplay = false;
        if (pendingPreviewRequest) {
            pendingPreviewRequest.autoplay = false;
        }
        updatePlaybackControls();
        return;
    }

    // Currently stopped / paused:
    const graph = (window as any).editorGraph as LGraph;
    const target = resolveMainPreviewNode(graph);

    if (target) {
        const hasPendingInvalidation = pendingGlobalParamInvalidation
            || pendingInvalidatedNodes.size > 0
            || Boolean(dspInvalidateTimer);
        const isInvalidated = isGraphPreviewInvalidated(graph, target.id);
        const isPreviewInFlight = previewWorker != null || pendingPreviewRequest != null;

        // 1. If the complete buffer for the target node is already rendered, valid, and synced,
        // start/resume playback immediately in lockstep with visuals.
        if (
            activeRamPreviewNodeId === target.id &&
            globalAudioScheduler.getTotalDuration() > 0 &&
            !isInvalidated &&
            !hasPendingInvalidation &&
            !isPreviewInFlight
        ) {
            await globalAudioScheduler.playAsync();
            updatePlaybackControls();
            startPlaybackTelemetry();
            return;
        }

        // 2. If a background preview is already in-flight for this target node with no newer pending edits,
        // promote it to autoplay so we don't abort in-flight work, and wait for it to finish before starting transport.
        if (
            isPreviewInFlight &&
            !hasPendingInvalidation &&
            (activePreviewNodeIdInFlight === target.id || pendingPreviewRequest?.nodeId === target.id)
        ) {
            activePreviewAutoplay = true;
            if (pendingPreviewRequest && pendingPreviewRequest.nodeId === target.id) {
                pendingPreviewRequest.autoplay = true;
            }
            setPreviewCalculatingState(false);
            try {
                globalPreviewBtn.disabled = true;
                await previewWorker;
            } catch (e) {
                console.error('Playback generation error:', e);
            } finally {
                globalPreviewBtn.disabled = false;
                updateMainPreviewTarget(graph);
            }
            return;
        }

        // 3. Otherwise (first play or graph was edited while stopped), wait for audio calculation
        // to complete before starting transport so visuals and audio begin together without silence or mid-play refresh.
        try {
            globalPreviewBtn.disabled = true;
            await previewNode(target.id, true, false, false);
        } catch (e) {
            console.error('Playback generation error:', e);
        } finally {
            globalPreviewBtn.disabled = false;
            updateMainPreviewTarget(graph);
        }
        return;
    }

    // 4. Fallback when there is NO graph target (empty workspace / standalone render playback):
    if (loopEnabled && loopBuffer) {
        void playLoop(loopTime());
        return;
    }

    if (tempFilesSelect.value && tempFilesSelect.value !== 'RAM_PREVIEW' && masterPlayer.src && masterPlayer.src !== window.location.href) {
        masterPlayer.play().catch(error => console.error('Play failed', error));
        return;
    }
}

masterPlayBtn.addEventListener('click', () => {
    void toggleTransportPlayback();
});

masterLoopBtn.addEventListener('click', () => {
    loopEnabled = !loopEnabled;
    globalAudioScheduler.setLoop(loopEnabled);
    if (loopEnabled) {
        const currentTime = Number.isFinite(masterPlayer.currentTime) ? masterPlayer.currentTime : 0;
        const wasPlaying = !masterPlayer.paused && !masterPlayer.ended;
        masterPlayer.loop = false;
        masterPlayer.pause();
        loopOffset = currentTime;
        if (wasPlaying && !globalAudioScheduler.getIsPlaying()) void playLoop(currentTime);
    } else {
        const currentTime = loopTime();
        const wasPlaying = loopSource !== null || !masterPlayer.paused && !masterPlayer.ended;
        stopLoop(false);
        masterPlayer.loop = false;
        pendingMasterSeek = currentTime;
        try {
            masterPlayer.currentTime = currentTime;
        } catch (error) {
            console.error('Could not restore native playback position', error);
        }
        if (wasPlaying && !globalAudioScheduler.getIsPlaying()) masterPlayer.play().catch(error => console.error('Play failed', error));
    }
    updatePlaybackControls();
});

masterVolume.addEventListener('input', () => {
    masterPlayer.volume = Number(masterVolume.value);
    masterPlayer.muted = false;
    syncLoopGain();
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
    syncLoopGain();
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

function stripResolvedPoolState(graphInfo: any, isFrozen: boolean = false) {
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

        // When not frozen, strip runtime outputs so pools re-resolve from GAIA recipes.
        // When frozen, keep resolved outputs in the JSON so the patch stays immutable from pool refresh.
        if (!isFrozen) {
            delete properties.output_value;
            delete properties.output_item_id;
            delete properties.output_bpm;
            delete properties.output_key;
            delete properties.sequence_index;
        }
    }

    if (!isFrozen) {
        for (const nodeInfo of graphInfo.nodes) {
            const properties = nodeInfo?.properties || {};
            if (!poolsById.has(properties.asset_modifier_id)) continue;
            // A pooled owner does not author a concrete asset when unfrozen.
            delete properties.filepath;
            delete properties.library_item_id;
            delete properties.duration_seconds;
            delete properties.original_bpm;
            delete properties.key;
        }
    }
    return graphInfo;
}

function prepareWorkspaceGraph(rawGraph: any) {
    if (!rawGraph || typeof rawGraph !== 'object' || !Array.isArray(rawGraph.nodes)) {
        throw new Error('Preset does not contain a valid graph.');
    }

    const isFrozen = Boolean(
        rawGraph.extra?.global_freeze ||
        rawGraph.extra?.freeze ||
        rawGraph.frozen
    );
    const graphInfo = stripResolvedPoolState(JSON.parse(JSON.stringify(rawGraph)), isFrozen);
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
    applySignalFlowColors(graphInfo);
    return graphInfo;
}

function rebuildTrackNodesFromGraph(graph: LGraph) {
    trackNodes.clear();
    for (const node of ((graph as any)._nodes || [])) {
        if (!node) continue;
        attachGhostProperties(node, graph);
        const p = node.properties || {};
        const type = p.disabled
            ? 'disabled'
            : ((typeof (node as any).getNodeType === 'function' ? (node as any).getNodeType() : null) || p.node_type || 'track');
        if (type === 'asset_filter') p.refresh_mode = normalizeAssetRefreshMode(p.refresh_mode);
        trackNodes.set(node.id, {
            id: node.id,
            type,
            name: p.node_name || node.title || 'AudioNode',
            filepath: p.filepath || '',
            sample_type: p.sample_type,
            original_bpm: p.sample_type === 'one_shot' ? (p.original_bpm || null) : (p.original_bpm || 120),
            target_bpm: (type === 'sequence' || type === 'arrangement') ? 'global' : (p.target_bpm ?? p.bpm ?? 'global'),
            bpm: (type === 'sequence' || type === 'arrangement') ? 'global' : (p.bpm ?? p.target_bpm ?? 'global'),
            key: p.key || '',
            start_beat: p.start_beat || 0,
            mix_mode: p.mix_mode || 'sum',
            crop_start: p.crop_start,
            crop_end: p.crop_end,
            sequence: p.sequence,
            step_parameters: p.step_parameters,
            step_length: p.step_length,
            play_mode: p.play_mode,
            release: p.release,
            fade_ms: p.fade_ms,
            total_bars: p.total_bars ?? (type === 'track' || type === 'arrangement' ? 4 : (type === 'sequence' ? 'global' : undefined)),
            section_points: p.section_points,
            section_probability: p.section_probability,
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

function markNodeAndAncestorsInvalidated(graph: LGraph, nodeId: number) {
    const visited = new Set<number>();
    const pending = [nodeId];
    const allNodes = (((graph as any)._nodes || []) as any[]);
    while (pending.length > 0) {
        const currId = pending.pop();
        if (currId == null || visited.has(currId)) continue;
        visited.add(currId);
        const node = graph.getNodeById(currId);
        if (node) {
            (node as any).isInvalidated = true;
            (node as any)._cachedMixedInput = null;
            (node as any)._cachedCompositedBuffer = null;
            (node as any)._lastRenderedBuffer = null;
            delete (node as any).manifestStemBuffer;
            (node as any).setDirtyCanvas?.(true, true);
        }
        // Invalidate any ghost nodes linked to this source node
        for (const candidate of allNodes) {
            if (candidate && candidate.id != null && !visited.has(candidate.id)) {
                const ghostSrc = getGhostSource(candidate, graph);
                if (ghostSrc && ghostSrc.id === currId) {
                    pending.push(candidate.id);
                }
            }
        }
        // In LiteGraph, audio links flow from child (origin) to parent/mixer (target).
        // Downstream ancestors that depend on this node are connected to its outputs.
        if (node && node.outputs) {
            for (const out of node.outputs) {
                for (const linkId of out.links || []) {
                    const link = (graph as any).links?.[linkId];
                    if (link && link.target_id != null) {
                        pending.push(link.target_id);
                    }
                }
            }
        }
        const data = trackNodes.get(currId);
        if (data?.parentId != null) {
            pending.push(data.parentId);
        }
    }
}

function isGraphPreviewInvalidated(graph: LGraph, targetId: number): boolean {
    const target = graph.getNodeById(targetId);
    if (!target) return true;
    if (Boolean((target as any).isInvalidated)) return true;
    const subtree = graphResolutionNodes(graph, targetId);
    return subtree.some(n => Boolean((n as any).isInvalidated));
}

let graphEvaluationDepth = 0;

function isGraphEvaluating(): boolean {
    return graphEvaluationDepth > 0;
}

async function withGraphEvaluationWindow<T>(fn: () => Promise<T>): Promise<T> {
    graphEvaluationDepth++;
    try {
        return await fn();
    } finally {
        graphEvaluationDepth = Math.max(0, graphEvaluationDepth - 1);
        if (graphEvaluationDepth === 0) {
            scheduleStageSave();
        }
    }
}

function clearSubtreeInvalidated(graph: LGraph, targetId: number) {
    const subtree = graphResolutionNodes(graph, targetId);
    for (const n of subtree) {
        if (n) {
            (n as any).isInvalidated = false;
            (n as any).setDirtyCanvas?.(true, true);
        }
    }
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
            const items = Array.isArray(node.properties?.selected_items) ? node.properties.selected_items : [];
            const needsHydration = items.some((item: any) => !item?.filepath && !item?.absolute_path);
            if (includeDynamicAssets || needsHydration) references.push(...items);
            continue;
        }
        const activeIdx = Math.max(0, Number(node?.activeSlotIndex ?? node?.properties?.active_slot ?? 0));
        const activeSlotFp = Array.isArray(node?.properties?.slots) ? node.properties.slots[activeIdx]?.filepath : '';
        if (!includeDynamicAssets && node?.properties?.asset_modifier_id != null && !node?.properties?.filepath && !activeSlotFp) continue;
        const filepath = String(node?.properties?.filepath || activeSlotFp || '');
        const id = node?.properties?.library_item_id;
        if (id != null || filepath) references.push({ id, absolute_path: filepath });
        if (Array.isArray(node?.properties?.slots)) {
            for (const s of node.properties.slots) {
                const sPath = String(s?.filepath || '');
                const sId = s?.library_item_id;
                if (sId != null || sPath) references.push({ id: sId, absolute_path: sPath });
            }
        }
    }
    const files: LibraryFile[] = await resolveLibraryAssets(references);

    // Pool entries are serialized snapshots. Refresh every entry first so the
    // next selection (and moved assets located by stable ID) uses current GAIA data.
    for (const node of nodes) {
        const isAssetPool = node?.type === 'Audio/AssetFilter'
            || node?.properties?.node_type === 'asset_filter'
            || node?.properties?.output_type === 'asset_path';
        const items = Array.isArray(node?.properties?.selected_items)
            ? node.properties.selected_items
            : [];
        const needsHydration = items.some((item: any) => !item?.filepath && !item?.absolute_path);
        if (!includeDynamicAssets && isAssetPool && !needsHydration) continue;
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
        const activeIdx = Math.max(0, Number(node?.activeSlotIndex ?? node?.properties?.active_slot ?? 0));
        const activeSlotFp = Array.isArray(node?.properties?.slots) ? node.properties.slots[activeIdx]?.filepath : '';
        if (!includeDynamicAssets && node?.properties?.asset_modifier_id != null && !node?.properties?.filepath && !activeSlotFp) {
            return Promise.resolve(false);
        }
        const sync = node?.syncMetadataFromLibrary;
        if (typeof sync !== 'function') return Promise.resolve(false);
        const modifierId = node.properties?.asset_modifier_id;
        const modifier = modifierId != null ? graph.getNodeById(modifierId) : null;
        const hasSlots = Array.isArray(node.properties?.slots) && node.properties.slots.length >= 1;
        const assetPath = hasSlots
            ? (node.properties?.filepath || activeSlotFp || modifier?.properties?.output_value || '')
            : (modifier?.properties?.output_value || node.properties?.filepath || '');
        const selectedItem = (modifier?.properties?.selected_items || []).find((item: any) =>
            (item.absolute_path || item.filepath) === assetPath
        );
        const preferredId = hasSlots
            ? (node.properties?.library_item_id ?? selectedItem?.id ?? modifier?.properties?.output_item_id)
            : (modifier?.properties?.output_item_id ?? selectedItem?.id ?? node.properties?.library_item_id);
        if (assetPath && node.properties?.filepath !== assetPath) node.updateProperty('filepath', assetPath);
        if (preferredId != null && node.properties?.library_item_id !== preferredId) node.updateProperty('library_item_id', preferredId);
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

async function preloadSubtreeAssets(graph: LGraph, rootNodeId?: number): Promise<void> {
    const nodes = graphResolutionNodes(graph, rootNodeId);
    const loadPromises: Promise<any>[] = [];

    for (const node of nodes) {
        if (!node) continue;

        const nodeKind = (typeof (node as any).getNodeType === 'function' ? (node as any).getNodeType() : null) || node.properties?.node_type;

        // 1. SampleNode: preload audio buffer into memory
        if (nodeKind === 'sample' || typeof (node as any).ensureAudioLoaded === 'function') {
            const filepath = String(node.properties?.filepath || '');
            if (filepath) {
                if (typeof (node as any).ensureAudioLoaded === 'function') {
                    loadPromises.push((node as any).ensureAudioLoaded());
                } else if (!node.audioBuffer || node.loadedFilepath !== filepath) {
                    loadPromises.push(
                        fetchAudioBuffer(filepath).then(buf => {
                            if (buf) {
                                node.audioBuffer = buf;
                                node.loadedFilepath = filepath;
                                if (buf.duration) {
                                    node.properties.duration_seconds = buf.duration;
                                }
                                node.setDirtyCanvas?.(true, true);
                            }
                        }).catch(err => {
                            console.warn(`Failed to preload audio for SampleNode #${node.id}:`, err);
                        })
                    );
                }
            }
        }

        // 2. SequenceNode: ensure sequence pattern is parsed/loaded if filepath is set
        if (nodeKind === 'sequence') {
            const filepath = String(node.properties?.filepath || '');
            const hasSequence = Array.isArray(node.properties?.sequence) && node.properties.sequence.length > 0;
            if (filepath && !hasSequence) {
                const item = {
                    id: node.properties?.library_item_id,
                    filepath: filepath,
                    itemType: filepath.toLowerCase().endsWith('.seq') ? 'sequence' : 'midi',
                    name: filepath.split(/[\\/]/).pop()
                };
                loadPromises.push(
                    applyLibraryItemToSequence(node, item as any).catch(err => {
                        console.warn(`Failed to preload sequence for SequenceNode #${node.id}:`, err);
                    })
                );
            }
        }
    }

    if (loadPromises.length > 0) {
        await Promise.all(loadPromises);
    }

    for (const node of nodes) {
        node.setDirtyCanvas?.(true, true);
    }
    (window as any).editorCanvas?.setDirty?.(true, true);
}

let currentWorkspaceName: string | null = null;

function setWorkspaceControlsEnabled() {
    const hasSelection = Boolean(workspacePresetSelect.value);
    saveWorkspaceBtn.disabled = false;
    if (loadWorkspaceBtn) loadWorkspaceBtn.disabled = false;
    if (deleteWorkspaceBtn) deleteWorkspaceBtn.disabled = !hasSelection;
}

async function refreshWorkspacePresets(selectedName?: string) {
    try {
        const response = await fetch('/api/workspaces');
        if (!response.ok) throw new Error(`Could not list workspaces (${response.status})`);
        const data = await response.json();
        const workspaces: Array<{ name: string; filename?: string; updated_at?: number; size?: number }> =
            Array.isArray(data.workspaces) ? data.workspaces : [];
        workspacePresetSelect.innerHTML = '';
        if (openRecentPopover) openRecentPopover.innerHTML = '';

        if (workspaces.length === 0) {
            workspacePresetSelect.append(new Option('No saved workspaces', ''));
            if (openRecentPopover) {
                const hint = document.createElement('div');
                hint.className = 'header-menu-hint';
                hint.textContent = 'No recent workspaces';
                openRecentPopover.appendChild(hint);
            }
        } else {
            for (const workspace of workspaces) {
                workspacePresetSelect.append(new Option(workspace.name, workspace.name));
            }
            const nextValue = selectedName && workspaces.some((workspace: any) => workspace.name === selectedName)
                ? selectedName : (currentWorkspaceName && workspaces.some(w => w.name === currentWorkspaceName) ? currentWorkspaceName : workspaces[0].name);
            workspacePresetSelect.value = nextValue;

            if (openRecentPopover) {
                const recentList = workspaces.slice(0, 10);
                for (const w of recentList) {
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'header-menu-action sin-menu-item open-recent-item';
                    btn.textContent = w.name;
                    btn.title = w.name;
                    btn.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        fileMenu.open = false;
                        await loadWorkspacePreset(w.name);
                    });
                    openRecentPopover.appendChild(btn);
                }

                const sep = document.createElement('div');
                sep.className = 'header-menu-separator sin-menu-divider';
                openRecentPopover.appendChild(sep);

                const moreBtn = document.createElement('button');
                moreBtn.type = 'button';
                moreBtn.className = 'header-menu-action sin-menu-item';
                moreBtn.style.color = '#64748b';
                moreBtn.textContent = 'More workspaces…';
                moreBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    fileMenu.open = false;
                    openWorkspaceExplorer();
                });
                openRecentPopover.appendChild(moreBtn);
            }
        }
    } catch (error) {
        console.error('Could not list workspace presets', error);
        workspacePresetSelect.innerHTML = '';
        workspacePresetSelect.append(new Option('Workspace saves unavailable', ''));
        if (openRecentPopover) {
            openRecentPopover.innerHTML = '<div class="header-menu-hint">Workspace saves unavailable</div>';
        }
    }
    setWorkspaceControlsEnabled();
}

function serializeWorkspaceGraph(graph: LGraph) {
    for (const node of (((graph as any)._nodes || []) as any[])) {
        node?.syncActiveSlotFromProperties?.();
    }
    writeGlobalParametersToGraph(graph);
    writeGlobalFreezeToGraph(graph);
    return stripResolvedPoolState(JSON.parse(JSON.stringify(graph.serialize())), isGlobalFreezeActive);
}

function createWorkspacePreset(graph: LGraph) {
    writeGlobalFreezeToGraph(graph);
    return {
        version: WORKSPACE_PRESET_VERSION,
        savedAt: new Date().toISOString(),
        frozen: Boolean(isGlobalFreezeActive),
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
        currentWorkspaceName = name;
        await refreshWorkspacePresets(name);
        fileMenu.open = false;
        setWorkspaceButtonMessage(saveWorkspaceBtn, 'Saved', 'Save');
        window.dispatchEvent(new CustomEvent('project-name-changed', {
            detail: { projectName: name }
        }));
    } catch (error) {
        console.error('Could not save workspace preset', error);
        setWorkspaceButtonMessage(saveWorkspaceBtn, 'Save failed', 'Save');
    }
}

export function getCurrentProjectName(): string {
    if (currentWorkspaceName?.trim()) return currentWorkspaceName.trim();
    const selected = workspacePresetSelect?.value?.trim();
    if (selected) return selected;
    const graph = (window as any).editorGraph as LGraph;
    if ((graph as any)?.extra?.project_name) return String((graph as any).extra.project_name);
    return 'project';
}

(window as any).getProjectName = getCurrentProjectName;

async function loadWorkspacePreset(name: string) {
    const graph = (window as any).editorGraph as LGraph;
    const canvas = (window as any).editorCanvas as LGraphCanvas;
    if (!graph || !name) return;
    try {
        cancelScheduledStageSave();
        if (stageSaveInFlight && stageSaveCompletion) await stageSaveCompletion;
        stageHydrating = true;
        setStageSaveState('loading', `Loading workspace ${name}`);
        const response = await fetch(`/api/workspaces/${encodeURIComponent(name)}`);
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
        clearActiveWorkspaceManifest();
        graph.configure(prepareWorkspaceGraph(preset.graph));

        // Restore project-dependent freeze state
        loadGlobalFreezeFromGraph(preset, graph);
        const isFrozen = isGlobalFreezeActive;

        // Apply saved transport settings immediately.
        if (preset.graph?.extra?.global_parameters) {
            setGlobalParameters(preset.graph.extra.global_parameters, graph);
        }

        rebuildTrackNodesFromGraph(graph);
        loadGlobalParametersFromGraph(graph);
        updateGraphNodeCollapsing();

        await withGraphEvaluationWindow(async () => {
            if (isFrozen) {
                // When frozen, resolved assets are already in the JSON!
                // Sync metadata without rolling new samples from pools
                await syncGraphSampleMetadataFromLibrary(graph, true);
            } else {
                // When not frozen, resolve dynamic pools and random modifiers
                const libraryFiles = await syncGraphSampleMetadataFromLibrary(graph, true);
                await resolveAssignedAssetFilters(graph, undefined as any, {
                    kind: 'preview',
                    globalPreview: true,
                    globalFreeze: false,
                    libraryFiles
                });
                await resolveAssignedRandomModifiers(graph, undefined as any, {
                    kind: 'preview',
                    globalPreview: true,
                    globalFreeze: false
                });
            }
        });

        canvas?.setDirty(true, true);
        void preloadSubtreeAssets(graph);

        stageHydrating = false;
        cancelScheduledStageSave();
        if (stageSaveInFlight && stageSaveCompletion) await stageSaveCompletion;
        await saveCurrentStage();
        currentWorkspaceName = name;
        await refreshWorkspacePresets(name);
        fileMenu.open = false;
        setWorkspaceButtonMessage(saveWorkspaceBtn, 'Saved', 'Save');
        window.dispatchEvent(new CustomEvent('project-name-changed', {
            detail: { projectName: getCurrentProjectName() }
        }));
    } catch (error) {
        stageHydrating = false;
        console.error('Could not load workspace preset', error);
        setWorkspaceButtonMessage(saveWorkspaceBtn, 'Load failed', 'Save');
    }
}

workspacePresetSelect.addEventListener('change', async () => {
    setWorkspaceControlsEnabled();
    window.dispatchEvent(new CustomEvent('project-name-changed', {
        detail: { projectName: getCurrentProjectName() }
    }));
    const selected = workspacePresetSelect.value?.trim();
    if (selected) {
        await loadWorkspacePreset(selected);
    }
});

newStageBtn.addEventListener('click', () => {
    const graph = (window as any).editorGraph as LGraph;
    const canvas = (window as any).editorCanvas as LGraphCanvas;
    if (!graph) return;

    closeAllParamWindows();
    activeParamNodeId = null;
    clearActiveWorkspaceManifest();
    graph.clear();
    trackNodes.clear();
    setGlobalParameters(DEFAULT_GLOBAL_PARAMETERS, graph);
    setGlobalFreeze(false, graph, false);
    setGlobalSeed(graph, 0);
    setGlobalSeedLocked(graph, false);
    syncGlobalSeedControlsUI(graph);
    updateGraphNodeCollapsing();
    canvas?.setDirty(true, true);
    fileMenu.open = false;
    currentWorkspaceName = null;
    window.dispatchEvent(new CustomEvent('project-name-changed', {
        detail: { projectName: 'project' }
    }));
    // A blank stage is a deliberate new document, even if no previous stage
    // exists (or it was already blank), so force a fresh persisted snapshot.
    lastSavedStageFingerprint = null;
    scheduleStageSave(0);
});

async function handleSaveWorkspace() {
    const targetName = currentWorkspaceName?.trim() || workspacePresetSelect?.value?.trim();
    if (targetName) {
        await saveWorkspacePreset(targetName);
    } else {
        await handleSaveWorkspaceAs();
    }
}

async function handleSaveWorkspaceAs() {
    const current = currentWorkspaceName || '';
    const name = window.prompt('Save workspace as:', current);
    if (!name?.trim()) return;
    await saveWorkspacePreset(name.trim());
}

function openWorkspaceExplorer() {
    FileExplorerModal.show({
        onSelect: async (name: string) => {
            await loadWorkspacePreset(name);
        },
        onDelete: async (name: string) => {
            await fetch(`/api/workspaces/${encodeURIComponent(name)}`, { method: 'DELETE' });
            if (currentWorkspaceName === name) {
                currentWorkspaceName = null;
            }
            await refreshWorkspacePresets();
        },
        onImportJson: async (presetData: any, filename: string) => {
            await importWorkspacePresetObject(presetData, filename);
        }
    });
}

async function importWorkspacePresetObject(presetData: any, filename: string) {
    const graph = (window as any).editorGraph as LGraph;
    if (!graph || !presetData) return;
    const cleanName = filename.replace(/\.json$/i, '').trim() || 'imported_workspace';
    try {
        const payload = presetData.preset ? presetData.preset : presetData;
        if (!payload.graph) {
            alert('File does not contain a valid graph structure.');
            return;
        }
        await fetch('/api/workspaces', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: cleanName, preset: payload })
        });
        await loadWorkspacePreset(cleanName);
    } catch (err) {
        console.error('Failed to import workspace preset', err);
        alert('Could not import workspace: ' + err);
    }
}

saveWorkspaceAsBtn.addEventListener('click', () => {
    void handleSaveWorkspaceAs();
});

saveWorkspaceBtn.addEventListener('click', () => {
    void handleSaveWorkspace();
});

loadWorkspaceBtn.addEventListener('click', () => {
    fileMenu.open = false;
    openWorkspaceExplorer();
});

openWorkspaceBtn?.addEventListener('click', () => {
    fileMenu.open = false;
    openWorkspaceExplorer();
});

openRecentTriggerBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    const menuItem = topHeader.querySelector('#open-recent-menu-item');
    menuItem?.classList.toggle('is-open');
});

deleteWorkspaceBtn.addEventListener('click', async () => {
    const name = currentWorkspaceName || workspacePresetSelect.value;
    if (!name || !window.confirm(`Delete workspace "${name}"?`)) return;
    try {
        const response = await fetch(`/api/workspaces/${encodeURIComponent(name)}`, { method: 'DELETE' });
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.detail || `Could not delete workspace (${response.status})`);
        }
        if (currentWorkspaceName === name) {
            currentWorkspaceName = null;
        }
        await refreshWorkspacePresets();
        fileMenu.open = false;
        setWorkspaceButtonMessage(deleteWorkspaceBtn, 'Deleted', 'Delete');
    } catch (error) {
        console.error('Could not delete workspace', error);
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

refreshLibraryBtn?.addEventListener('click', async () => {
    libraryMenu.open = false;
    toggleLibraryPanel('open');
    clearLibraryCache();
    window.dispatchEvent(new CustomEvent('request-library-refresh'));
    const graph = (window as any).editorGraph as LGraph | undefined;
    const canvas = (window as any).editorCanvas as LGraphCanvas | undefined;
    if (graph) {
        await syncGraphSampleMetadataFromLibrary(graph, false).catch(() => { });
        canvas?.setDirty(true, true);
    }
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

async function ensurePoolsResolvedIfFreezing(graph: LGraph) {
    if (!isGlobalFreezeActive) return;
    const allNodes = (((graph as any)._nodes || []) as any[]);
    const unresolvedPool = allNodes.some((n: any) => {
        const isPool = n?.type === 'Audio/AssetFilter' || n?.properties?.node_type === 'asset_filter';
        return isPool && !n.properties?.output_value && Array.isArray(n.properties?.selected_items) && n.properties.selected_items.length > 0;
    });
    if (unresolvedPool) {
        await withGraphEvaluationWindow(async () => {
            const libraryFiles = await syncGraphSampleMetadataFromLibrary(graph, true);
            await resolveAssignedAssetFilters(graph, undefined as any, {
                kind: 'preview',
                globalPreview: true,
                globalFreeze: false,
                libraryFiles
            });
        });
        void preloadSubtreeAssets(graph);
        (window as any).editorCanvas?.setDirty?.(true, true);
    }
}

globalFreezeBtn?.addEventListener('click', async () => {
    const next = !isGlobalFreezeActive;
    setGlobalFreeze(next);
    if (next) {
        const graph = (window as any).editorGraph as LGraph;
        if (graph) {
            await ensurePoolsResolvedIfFreezing(graph);
        }
    }
});

updateGlobalFreezeButtonState();

function isNodeRenderable(node: any): boolean {
    if (!node) return false;
    if (typeof node.isRenderable === 'boolean') return node.isRenderable;
    return !node.isModifier && node.type !== 'Audio/Disabled';
}

function getFlaggedRenderNodes(graph: LGraph): any[] {
    const allNodes = (((graph as any)._nodes || []) as any[]);
    return allNodes.filter(n => isNodeRenderable(n) && n.properties?.render_enabled !== false);
}

function getSelectedRenderNodes(graph: LGraph): any[] {
    const canvas = (window as any).editorCanvas as LGraphCanvas | undefined;
    const allNodes = (((graph as any)._nodes || []) as any[]);
    const selectedMap = (canvas?.selected_nodes || {}) as Record<string | number, any>;
    return allNodes.filter(n => (selectedMap[n.id] || selectedMap[String(n.id)] || n.is_selected) && isNodeRenderable(n));
}

function getMostParentRenderNodes(graph: LGraph): any[] {
    const allNodes = (((graph as any)._nodes || []) as any[]);
    return allNodes.filter(n => {
        if (!isNodeRenderable(n)) return false;
        const parentId = trackNodes.get(n.id)?.parentId;
        return parentId == null;
    });
}

function getAllRenderNodes(graph: LGraph): any[] {
    const allNodes = (((graph as any)._nodes || []) as any[]);
    return allNodes.filter(n => isNodeRenderable(n));
}

async function batchRenderNodes(targetNodes: any[], label: string) {
    if (renderMenu) renderMenu.open = false;
    if (!targetNodes || targetNodes.length === 0) {
        alert(`No renderable nodes found for: ${label}`);
        return;
    }
    runtimeLog(`Starting batch render (${label}): ${targetNodes.length} node(s)`, 'common');
    let completed = 0;
    for (const node of targetNodes) {
        completed++;
        const nodeName = node.properties?.node_name || node.title || `Node #${node.id}`;
        masterWaveform.clear(`Rendering (${completed}/${targetNodes.length}): ${nodeName}...`);
        try {
            await renderNode(node.id, completed === targetNodes.length);
        } catch (err) {
            console.error(`Batch render error for node ${node.id}:`, err);
        }
    }
    runtimeLog(`Batch render finished: ${completed} node(s) processed`, 'common');
    await updateTempRendersList();
}

renderFlaggedBtn?.addEventListener('click', () => {
    const graph = (window as any).editorGraph as LGraph;
    if (!graph) return;
    void batchRenderNodes(getFlaggedRenderNodes(graph), 'Flagged Nodes');
});

renderSelectedBtn?.addEventListener('click', () => {
    const graph = (window as any).editorGraph as LGraph;
    if (!graph) return;
    void batchRenderNodes(getSelectedRenderNodes(graph), 'Selected Nodes');
});

renderMostParentBtn?.addEventListener('click', () => {
    const graph = (window as any).editorGraph as LGraph;
    if (!graph) return;
    void batchRenderNodes(getMostParentRenderNodes(graph), 'Most Parent Nodes');
});

renderAllBtn?.addEventListener('click', () => {
    const graph = (window as any).editorGraph as LGraph;
    if (!graph) return;
    void batchRenderNodes(getAllRenderNodes(graph), 'All Nodes');
});

window.addEventListener('toggle-properties-dock', (e: Event) => {
    const nodeId = (e as CustomEvent).detail?.nodeId;
    togglePropertiesDockMode(nodeId);
});

window.addEventListener('open-node-properties', (e: Event) => {
    const detail = (e as CustomEvent).detail;
    const nodeId = detail?.nodeId;
    if (nodeId == null) return;
    const graph = (window as any).editorGraph;
    const targetNode = graph?.getNodeById(nodeId);
    if (!targetNode) return;
    const canvas = (window as any).editorCanvas as LGraphCanvas;
    canvas?.selectNode?.(targetNode);
    openParamWindow(targetNode, { forceOpen: true });
    if (detail.startRandomMapping) {
        setTimeout(() => {
            window.dispatchEvent(new CustomEvent('start-random-mapping', { detail: { nodeId } }));
        }, 50);
    }
});

window.addEventListener('keydown', (e: KeyboardEvent) => {
    const activeEl = document.activeElement as HTMLElement | null;
    const isTyping = Boolean(activeEl && (
        activeEl.tagName === 'INPUT' ||
        activeEl.tagName === 'TEXTAREA' ||
        activeEl.isContentEditable ||
        activeEl.classList?.contains('node-title-editor')
    ));
    if (isTyping) {
        return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        const keyLower = e.key.toLowerCase();
        if (keyLower === 'c' || keyLower === 'v') {
            const focusedSlot = (window as any).__sinFocusedSlot as { nodeId: number | null; slotIndex: number } | undefined;
            const inInspector = Boolean(activeEl?.closest?.('.td-param-container') || activeEl?.closest?.('.td-slot-strip'));
            if (focusedSlot || inInspector) {
                const graph = (window as any).editorGraph as LGraph | undefined;
                const targetNodeId = focusedSlot?.nodeId ?? activeParamNodeId;
                const targetNode = targetNodeId != null ? (graph?.getNodeById?.(targetNodeId) as any) : null;
                if (targetNode && typeof targetNode.copySlot === 'function' && typeof targetNode.pasteSlot === 'function') {
                    e.preventDefault();
                    e.stopPropagation();
                    if (keyLower === 'c') {
                        targetNode.copySlot(targetNode.activeSlotIndex);
                    } else {
                        targetNode.pasteSlot(targetNode.activeSlotIndex);
                    }
                    return;
                }
            }
        }
    }
    if (e.key === 'Escape' || e.code === 'Escape' || e.keyCode === 27) {
        const graphCanvas = (window as any).editorCanvas as LGraphCanvas | undefined;
        let changed = false;
        if (graphCanvas?.selected_nodes && Object.keys(graphCanvas.selected_nodes).length > 0) {
            graphCanvas.deselectAllNodes?.();
            changed = true;
        }
        if (selectedLinkIds.size > 0) {
            selectedLinkIds.clear();
            changed = true;
        }
        if (changed) {
            graphCanvas?.setDirty?.(true, true);
            e.preventDefault();
            e.stopPropagation();
            return;
        }
    }
    if ((e.code === 'Delete' || e.code === 'Backspace' || e.key === 'Delete' || e.key === 'Backspace' || e.keyCode === 46 || e.keyCode === 8) && !isTyping) {
        const focusedSlot = (window as any).__sinFocusedSlot as { nodeId: number | null; slotIndex: number } | undefined;
        if (focusedSlot || activeEl?.closest?.('.td-slot-strip')) {
            const graph = (window as any).editorGraph as LGraph | undefined;
            const targetNodeId = focusedSlot?.nodeId ?? activeParamNodeId;
            const targetNode = targetNodeId != null ? (graph?.getNodeById?.(targetNodeId) as any) : null;
            if (targetNode && typeof targetNode.removeSlot === 'function' && typeof targetNode.getSlots === 'function' && targetNode.getSlots().length > 1) {
                e.preventDefault();
                e.stopPropagation();
                targetNode.removeSlot(targetNode.activeSlotIndex);
                window.dispatchEvent(new CustomEvent('node-properties-refreshed', { detail: { nodeId: targetNode.id } }));
                return;
            }
        }
        if (deleteSelectedCables()) {
            e.preventDefault();
            e.stopPropagation();
            return;
        }
    }
    if (e.code === 'Space' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
        if (activeEl && (activeEl.tagName === 'SELECT' || activeEl.closest('.dialog-modal') || activeEl.closest('.sin-modal'))) {
            return;
        }
        e.preventDefault();
        void toggleTransportPlayback();
        return;
    }
    if ((e.key === 's' || e.key === 'S') && (e.ctrlKey || e.metaKey) && !e.altKey) {
        e.preventDefault();
        void handleSaveWorkspace();
        return;
    }
    if ((e.key === 'o' || e.key === 'O') && (e.ctrlKey || e.metaKey) && !e.altKey) {
        e.preventDefault();
        openWorkspaceExplorer();
        return;
    }
    if ((e.key === 'l' || e.key === 'L') && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        toggleLibraryPanel('toggle');
    } else if ((e.key === 'p' || e.key === 'P') && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        togglePropertiesPanel();
    }
}, true);

globalPreviewBtn.addEventListener('click', () => {
    if (globalPreviewBtn.disabled) return;
    void toggleTransportPlayback();
});

async function applyGlobalSeedChange(graph: LGraph) {
    if (!graph) return;
    syncGlobalSeedControlsUI(graph);
    const nodeId = activeRamPreviewNodeId ?? resolveMainPreviewNode(graph)?.id;

    if (dspInvalidateTimer) {
        clearTimeout(dspInvalidateTimer);
        dspInvalidateTimer = null;
    }
    pendingInvalidatedNodes.clear();
    pendingGlobalParamInvalidation = false;

    try {
        await fetch('/api/preview/invalidate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ node_ids: [] })
        }).catch(() => { });

        await withGraphEvaluationWindow(async () => {
            const libraryFiles = await syncGraphSampleMetadataFromLibrary(graph, true, nodeId ?? undefined);
            await resolveAssignedAssetFilters(graph, undefined as any, {
                kind: 'preview',
                globalPreview: false,
                globalFreeze: isGlobalFreezeActive,
                libraryFiles
            });
            await resolveAssignedRandomModifiers(graph, undefined as any, {
                kind: 'preview',
                globalPreview: false,
                globalFreeze: isGlobalFreezeActive
            });
            for (const node of (((graph as any)._nodes || []) as any[])) {
                if (!node?.properties) continue;
                if (typeof node.evaluateAllFieldOperators === 'function') {
                    node.evaluateAllFieldOperators(0);
                }
                if (node.id != null) {
                    window.dispatchEvent(new CustomEvent('node-properties-refreshed', { detail: { nodeId: node.id } }));
                }
            }
        });
        for (const node of ((graph as any)._nodes || [])) {
            if (node) {
                (node as any).isInvalidated = true;
                (node as any).setDirtyCanvas?.(true, true);
            }
        }
        (window as any).editorCanvas?.setDirty?.(true, true);
        scheduleStageSave();

        if (nodeId != null) {
            await previewNode(nodeId, false, false, false);
        }
    } catch (err) {
        const isAbort = (err as any)?.name === 'AbortError' || String(err).toLowerCase().includes('abort');
        if (!isAbort) {
            console.error('Global seed change preview error:', err);
        }
    }
}

globalSeedInput?.addEventListener('change', () => {
    const graph = (window as any).editorGraph as LGraph;
    if (!graph) return;
    setGlobalSeed(graph, Number(globalSeedInput.value));
    void applyGlobalSeedChange(graph);
});

globalSeedLockBtn?.addEventListener('click', () => {
    const graph = (window as any).editorGraph as LGraph;
    if (!graph) return;
    setGlobalSeedLocked(graph, !isGlobalSeedLocked(graph));
    syncGlobalSeedControlsUI(graph);
    scheduleStageSave();
});

previewRecalculateBtn.addEventListener('click', async () => {
    if (previewRecalculateBtn.disabled) return;
    const graph = (window as any).editorGraph as LGraph;
    const nodeId = activeRamPreviewNodeId ?? resolveMainPreviewNode(graph)?.id;
    if (nodeId == null) return;

    // Evaluation can happen at any transport moment without stopping active playback.
    // It evaluates pools, patterns, and random modifiers in Stage 1, renders Stage 2 in
    // the background, and atomically swaps the new audio and manifest when ready.
    EngineSyncManager.getInstance().setState('global_refreshing');

    previewRecalculateBtn.disabled = true;
    previewRecalculateBtn.innerHTML = HEADER_REFRESH_ICON_SVG;

    if (dspInvalidateTimer) {
        clearTimeout(dspInvalidateTimer);
        dspInvalidateTimer = null;
    }
    pendingInvalidatedNodes.clear();
    pendingGlobalParamInvalidation = false;

    try {
        await fetch('/api/preview/invalidate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ node_ids: [] })
        }).catch(() => { });

        if (graph) {
            if (!(graph as any).extra) (graph as any).extra = {};
            if ((graph as any).extra.global_seed === undefined) {
                (graph as any).extra.global_seed = 0;
            }
            await withGraphEvaluationWindow(async () => {
                await syncGraphSampleMetadataFromLibrary(graph, true, nodeId);
                refreshArmedSeeds(graph, isGlobalFreezeActive, trackNodes);
            });
            syncGlobalSeedControlsUI(graph);
            for (const node of ((graph as any)._nodes || [])) {
                if (node) {
                    (node as any).isInvalidated = true;
                    (node as any).setDirtyCanvas?.(true, true);
                }
            }
            scheduleStageSave();
        }

        await previewNode(nodeId, false, false, false);
    } catch (err) {
        const isAbort = (err as any)?.name === 'AbortError' || String(err).toLowerCase().includes('abort');
        if (!isAbort) {
            console.error('Recalculate preview error:', err);
        }
    } finally {
        previewRecalculateBtn.innerHTML = HEADER_REFRESH_ICON_SVG;
        previewRecalculateBtn.disabled = activeRamPreviewNodeId == null && resolveMainPreviewNode(graph) == null;
    }
});

tempFilesSelect.addEventListener('change', (e) => {
    const val = (e.target as HTMLSelectElement).value;
    updatePlaybackTrackPresentation();
    if (val === 'RAM_PREVIEW') {
        if (activeRamPreviewSource) setMasterPlayerSource(activeRamPreviewSource, true);
        else masterPlayer.play().catch(error => console.error('Play failed', error));
    } else if (val) {
        setMasterPlayerSource(val, true);
    }
});

let activeRamPreviewNodeId: number | null = null;
(window as any).activeRamPreviewNodeId = null;
let activeRamPreviewPayload: any = null;
let activeRamPreviewSource: string | null = null;
let activeWorkspaceManifest: any = null;
(window as any).activeWorkspaceManifest = null;

export function getActiveWorkspaceManifest(): any {
    return activeWorkspaceManifest;
}

function clearActiveWorkspaceManifest() {
    activeWorkspaceManifest = null;
    (window as any).activeWorkspaceManifest = null;
    activeRamPreviewNodeId = null;
    (window as any).activeRamPreviewNodeId = null;
    activeRamPreviewPayload = null;
    activeRamPreviewSource = null;
    (window as any).activeRamPreviewBuffer = null;
    globalAudioScheduler.reset();
    clearAudioBufferCache();
    fetch('/api/preview/clear', { method: 'POST' }).catch(() => { });
    const graph = (window as any).editorGraph as LGraph;
    if (graph) {
        const nodes = (((graph as any)._nodes || []) as any[]);
        for (const node of nodes) {
            if (!node) continue;
            delete node.manifestStemUrl;
            delete node.manifestEvents;
            delete node.manifestStemBuffer;
            node.setDirtyCanvas?.(true, true);
        }
        updateMainPreviewTarget(graph);
    }
    updatePlaybackControls();
}

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
                let selectedIndex = 0;
                for (let i = 0; i < tempFilesSelect.options.length; i++) {
                    const optText = tempFilesSelect.options[i].textContent || '';
                    if (optText === selectFilename || optText.includes(selectFilename) || selectFilename.includes(optText)) {
                        selectedIndex = i;
                        break;
                    }
                }
                tempFilesSelect.selectedIndex = selectedIndex;
                const selectedOpt = tempFilesSelect.options[selectedIndex];
                if (selectedOpt && selectedOpt.value) {
                    tempFilesSelect.value = selectedOpt.value;
                    setMasterPlayerSource(selectedOpt.value, true);
                }
            } else if (activeRamPreviewNodeId != null) {
                const ramOpt = Array.from(tempFilesSelect.options).find(o => o.value === 'RAM_PREVIEW');
                if (ramOpt) {
                    tempFilesSelect.value = 'RAM_PREVIEW';
                }
            } else {
                const placeholder = document.createElement('option');
                placeholder.value = '';
                placeholder.textContent = 'Select render…';
                placeholder.disabled = true;
                placeholder.selected = true;
                tempFilesSelect.insertBefore(placeholder, tempFilesSelect.firstChild);
                tempFilesSelect.selectedIndex = 0;
                tempFilesSelect.value = '';
            }
            updatePlaybackTrackPresentation();
        } else {
            // No files left
            tempFilesSelect.innerHTML = '<option value="" disabled selected>No renders available</option>';
            ++loopBufferRequestId;
            loopBuffer = null;
            loopLoad = Promise.resolve(null);
            stopLoop(false);
            masterPlayer.loop = false;
            masterPlayer.pause();
            masterPlayer.removeAttribute('src');
            masterPlayer.load();
            masterPlayBtn.disabled = true;
            masterLoopBtn.disabled = true;
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

let hoveredLink: any = null;
const selectedLinkIds: Set<number> = new Set();
(window as any).selectedLinkIds = selectedLinkIds;

export function deleteSelectedCables(graph?: LGraph): boolean {
    if (selectedLinkIds.size === 0) return false;
    const targetGraph = graph || ((window as any).editorGraph as LGraph) || ((window as any).editorCanvas?.graph as LGraph);
    if (!targetGraph) return false;

    const idsToDelete = Array.from(selectedLinkIds);
    selectedLinkIds.clear();
    hoveredLink = null;

    let removed = false;
    for (const linkId of idsToDelete) {
        const linksMap = targetGraph.links as Record<string | number, any> | undefined;
        const link = linksMap ? (linksMap[linkId] || linksMap[String(linkId)]) : null;
        if (link) {
            const branchOwner = targetGraph.getNodeById(link.__sinLeftPortBranchOwnerId);
            if (branchOwner?.properties?.left_port_branch_links) {
                delete branchOwner.properties.left_port_branch_links[String(linkId)];
            }
            const targetNode = targetGraph.getNodeById(link.target_id);
            if (targetNode) {
                targetNode.disconnectInput(link.target_slot);
            }
            const originNode = targetGraph.getNodeById(link.origin_id);
            if (originNode) {
                originNode.disconnectOutput(link.origin_slot);
            }
            targetGraph.removeLink(linkId);
            removed = true;
        } else {
            targetGraph.removeLink(linkId);
            removed = true;
        }
        if (linksMap) {
            delete linksMap[linkId];
            delete linksMap[String(linkId)];
        }
    }

    if (removed) {
        syncGraphHierarchy(targetGraph);
        updateGraphNodeCollapsing();
        window.dispatchEvent(new CustomEvent('graph-connections-changed'));
        (window as any).editorCanvas?.setDirty?.(true, true);
        scheduleStageSave();
    }
    return true;
}
(window as any).deleteSelectedCables = deleteSelectedCables;

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

(window as any).updateModifiersForParent = updateModifiersForParent;
(window as any).syncAllModifierPositions = syncAllModifierPositions;

// Keep canvas navigation and selection on familiar desktop controls:
// middle-drag pans, Shift+left-drag box-selects, and Ctrl+click adds nodes.
// Spacebar is reserved exclusively for transport toggle, not canvas dragging.
const originalProcessKey = (LiteGraph as any).LGraphCanvas.prototype.processKey;
(LiteGraph as any).LGraphCanvas.prototype.processKey = function (e: KeyboardEvent) {
    if (e.keyCode === 32 || e.code === 'Space') {
        return;
    }
    if (e.key === 'Escape' || e.code === 'Escape' || e.keyCode === 27) {
        let changed = false;
        if (this.selected_nodes && Object.keys(this.selected_nodes).length > 0) {
            this.deselectAllNodes?.();
            changed = true;
        }
        if (selectedLinkIds.size > 0) {
            selectedLinkIds.clear();
            changed = true;
        }
        if (changed) {
            this.setDirty(true, true);
        }
        e.preventDefault();
        e.stopPropagation();
        return false;
    }
    if (e.keyCode === 46 || e.keyCode === 8 || e.code === 'Delete' || e.code === 'Backspace' || e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedLinkIds.size > 0) {
            deleteSelectedCables(this.graph);
            e.preventDefault();
            e.stopPropagation();
            return false;
        }
    }
    if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.altKey && !e.metaKey) {
        const activeTag = (document.activeElement as HTMLElement)?.tagName;
        if (activeTag !== 'INPUT' && activeTag !== 'TEXTAREA' && activeTag !== 'SELECT') {
            frameCanvasSelectionOrGraph(this);
            e.preventDefault();
            e.stopPropagation();
            return false;
        }
    }
    return originalProcessKey ? originalProcessKey.apply(this, arguments) : undefined;
};

let lastMouseDownPos: [number, number] | null = null;
let lastMouseDownHitNode: any = null;
let lastMouseDownWasEmptyBackground = false;

const originalProcessMouseDown = (LiteGraph as any).LGraphCanvas.prototype.processMouseDown;
(LiteGraph as any).LGraphCanvas.prototype.processMouseDown = function (e: MouseEvent) {
    const previousAllowDragCanvas = this.allow_dragcanvas;
    const offset = this.convertEventToCanvasOffset ? this.convertEventToCanvasOffset(e) : [0, 0];
    const hitNode = this.getNodeOnPos ? this.getNodeOnPos(offset[0], offset[1], (this.graph as any)?._nodes, 0) : null;
    const emptyCanvasDrag = e.button === 0 && !hitNode && !this.connecting_node && !hoveredLink;
    const boxSelect = (e.button === 0 && e.shiftKey && !e.ctrlKey) || emptyCanvasDrag;
    const additiveSelect = e.button === 0 && e.ctrlKey && !e.shiftKey;

    lastMouseDownPos = [e.clientX, e.clientY];
    lastMouseDownHitNode = hitNode;
    lastMouseDownWasEmptyBackground = Boolean(emptyCanvasDrag);
    (window as any).__sinFocusedSlot = null;

    // If clicking a node or background without shift/ctrl, deselect cables
    if (e.button === 0 && !e.shiftKey && !e.ctrlKey && !hoveredLink) {
        if (selectedLinkIds.size > 0) {
            selectedLinkIds.clear();
            this.setDirty(true, true);
        }
    }

    // Priority 1: Check if an action button on any node was clicked.
    // Must be handled BEFORE LiteGraph's output slot hitbox detection
    // which otherwise intercepts clicks near (x=48, y=18) as cable connection gestures.
    if (e.button === 0 && !e.shiftKey && !e.ctrlKey && this.graph) {
        const offset = this.convertEventToCanvasOffset(e);
        const candidateNodes = (this.graph as any)._nodes || [];
        for (let i = candidateNodes.length - 1; i >= 0; i--) {
            const n = candidateNodes[i];
            if (!n || n.flags?.collapsed || (n.flags as any)?.hidden || isModifierNode(n)) continue;
            const isSelected = this.selected_nodes
                ? Boolean(this.selected_nodes[n.id] || this.selected_nodes[String(n.id)])
                : Boolean(n.is_selected);
            const isHovered = this.node_over === n;

            const localX = offset[0] - n.pos[0];
            const localY = offset[1] - n.pos[1];

            // Priority 1a: Bottom-right resize grip on resizable panel nodes
            if (
                n.resizable !== false &&
                n.isVisualizationActive &&
                localX >= n.size[0] - 11 &&
                localX <= n.size[0] + 3 &&
                localY >= n.size[1] - 11 &&
                localY <= n.size[1] + 3
            ) {
                this.graph.beforeChange?.();
                this.resizing_node = n;
                if (this.canvas) this.canvas.style.cursor = "se-resize";
                if (!isSelected) this.selectNode?.(n);
                this.dirty_canvas = true;
                this.setDirty(true, true);
                e.preventDefault();
                e.stopPropagation();
                return true;
            }

            if (!Array.isArray(n.buttons) || n.buttons.length === 0) continue;
            const activeButtons = typeof n.getVisibleCanvasButtons === 'function'
                ? n.getVisibleCanvasButtons(isSelected, isHovered)
                : (isSelected || !n.isVisualizationActive ? n.buttons : []);
            for (const btn of activeButtons) {
                if (btn.checkHit(localX, localY, n)) {
                    console.log(`[CanvasButton] Clicked '${btn.label}' (${btn.tooltip || 'button'}) on node #${n.id}`);
                    btn.onClick(e);
                    this.dirty_canvas = true;
                    this.setDirty(true, true);
                    e.preventDefault();
                    e.stopPropagation();
                    return true;
                }
            }
        }

        // Dragging an occupied input fans out from the node that owns the input.
        // LiteGraph normally disconnects that input before reconnecting it;
        // preserve the incoming link and start a fresh connection from the
        // parent's right-side output instead.
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
        const res = originalProcessMouseDown.call(this, e);
        if (this.node_dragged && isModifierNode(this.node_dragged)) {
            this.node_dragged = null;
        }
        return res;
    } finally {
        this.allow_dragcanvas = previousAllowDragCanvas;
        if (boxSelect || additiveSelect) delete (e as any).ctrlKey;
        if (additiveSelect) delete (e as any).shiftKey;
    }
};

const originalProcessMouseMove = (LiteGraph as any).LGraphCanvas.prototype.processMouseMove;
(LiteGraph as any).LGraphCanvas.prototype.processMouseMove = function (e: MouseEvent) {
    if (this.node_dragged && isModifierNode(this.node_dragged)) {
        this.node_dragged = null;
    }
    const res = originalProcessMouseMove.call(this, e);
    if (this.node_dragged) {
        syncAllModifierPositions(this.graph);
    }
    return res;
};

// Render theme-cohesive styled box selection instead of invisible #FFF stroke on white canvas
const originalDrawFrontCanvas = (LiteGraph as any).LGraphCanvas.prototype.drawFrontCanvas;
(LiteGraph as any).LGraphCanvas.prototype.drawFrontCanvas = function () {
    if (this.graph && this.ds?.scale != null) {
        if (syncNodesDistanceStage(this.graph, Number(this.ds.scale))) {
            this.dirty_bgcanvas = true;
        }
    }
    if (this.node_dragged) {
        this.dirty_bgcanvas = true;
    }
    const rect = this.dragging_rectangle;
    if (rect) {
        this.dragging_rectangle = null;
    }
    const res = originalDrawFrontCanvas ? originalDrawFrontCanvas.apply(this, arguments) : undefined;
    if (rect) {
        this.dragging_rectangle = rect;
        const ctx = this.ctx || this.canvas?.getContext?.('2d');
        if (ctx && this.ds) {
            ctx.save();
            this.ds.toCanvasContext(ctx);

            const rx = rect[2] < 0 ? rect[0] + rect[2] : rect[0];
            const ry = rect[3] < 0 ? rect[1] + rect[3] : rect[1];
            const rw = Math.abs(rect[2]);
            const rh = Math.abs(rect[3]);

            ctx.fillStyle = 'rgba(2, 132, 199, 0.08)';
            ctx.fillRect(rx, ry, rw, rh);
            ctx.strokeStyle = '#0284c7';
            ctx.lineWidth = 1.25 / this.ds.scale;
            ctx.setLineDash([4 / this.ds.scale, 2 / this.ds.scale]);
            ctx.strokeRect(rx, ry, rw, rh);
            ctx.restore();
        }
    }
    return res;
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

    const mouseDownPos = lastMouseDownPos;
    const mouseDownHitNode = lastMouseDownHitNode;
    const wasEmptyBg = lastMouseDownWasEmptyBackground;
    const isLeftButton = e.button === 0;
    const isSimpleClick = Boolean(mouseDownPos && Math.hypot(e.clientX - mouseDownPos[0], e.clientY - mouseDownPos[1]) < 6);

    const hadDraggingRect = Boolean(this.dragging_rectangle);
    const draggingRectW = this.dragging_rectangle ? Math.abs(this.dragging_rectangle[2]) : 0;
    const draggingRectH = this.dragging_rectangle ? Math.abs(this.dragging_rectangle[3]) : 0;

    const res = originalProcessMouseUp.call(this, e);

    if (isLeftButton && !e.shiftKey && !e.ctrlKey && !connectingNode) {
        if (wasEmptyBg) {
            const isSmallClick = isSimpleClick || (hadDraggingRect && draggingRectW <= 10 && draggingRectH <= 10);
            if (isSmallClick) {
                // Clicked on empty canvas background -> deselect everything
                this.deselectAllNodes?.();
                if (selectedLinkIds.size > 0) {
                    selectedLinkIds.clear();
                }
                this.setDirty(true, true);
            } else if (hadDraggingRect && (draggingRectW > 10 || draggingRectH > 10)) {
                // Box drag released on canvas -> if box enclosed 0 nodes, clear selection
                if (!this.selected_nodes || Object.keys(this.selected_nodes).length === 0) {
                    this.deselectAllNodes?.();
                    if (selectedLinkIds.size > 0) {
                        selectedLinkIds.clear();
                    }
                    this.setDirty(true, true);
                } else if (selectedLinkIds.size > 0) {
                    selectedLinkIds.clear();
                    this.setDirty(true, true);
                }
            }
        } else if (isSimpleClick && mouseDownHitNode) {
            // Clicked on a node without drag -> ensure ONLY this node is selected
            if (Object.keys(this.selected_nodes || {}).length > 1 || !this.selected_nodes?.[mouseDownHitNode.id]) {
                this.selectNodes([mouseDownHitNode], false);
                this.setDirty(true, true);
                this.onNodeSelected?.(mouseDownHitNode);
            }
            if (selectedLinkIds.size > 0) {
                selectedLinkIds.clear();
                this.setDirty(true, true);
            }
        }
    }

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
        if (!n || n.flags?.hidden || isModifierNode(n)) continue;

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
// 1. Keeps route signal color and shows selection halo when selected
// 2. Removes center anchor dots
// 3. Renders full unbroken straight lines from Point A to Point B without input/output stub breaks
// 4. Highlights cable smoothly when hovered without automatic cutting
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
    const isSelected = link && selectedLinkIds.has(link.id);
    const baseColor = color || (link && link.color) || "#94a3b8";

    ctx.save();
    const baseWidth = this.connections_width || 2;
    const endpoints = getLinkEndpoints(this.graph, link, a, b);
    const { cp1, cp2 } = getLinkControlPoints(endpoints.origin, endpoints.target);

    if (isSelected) {
        // High-visibility selection halo
        ctx.lineWidth = baseWidth + 3.5;
        ctx.strokeStyle = "rgba(2, 132, 199, 0.45)";
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.beginPath();
        ctx.moveTo(endpoints.origin[0], endpoints.origin[1]);
        ctx.bezierCurveTo(cp1[0], cp1[1], cp2[0], cp2[1], endpoints.target[0], endpoints.target[1]);
        ctx.stroke();

        ctx.lineWidth = baseWidth + 1;
        ctx.strokeStyle = "#0284c7";
    } else if (isHovered) {
        ctx.lineWidth = baseWidth + 1.5;
        ctx.strokeStyle = baseColor;
    } else {
        ctx.lineWidth = baseWidth;
        ctx.strokeStyle = baseColor;
    }

    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // Smooth horizontal S-curve Bezier cable
    ctx.beginPath();
    ctx.moveTo(endpoints.origin[0], endpoints.origin[1]);
    ctx.bezierCurveTo(cp1[0], cp1[1], cp2[0], cp2[1], endpoints.target[0], endpoints.target[1]);
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
    type: "track" | "sample" | "sequence" | "item_pool" | "sample_pool" | "arrangement" | "modulator" | "asset_filter" | "random" | "disabled";
    name: string;
    filepath: string;
    sample_type?: string;
    original_bpm: number;
    target_bpm?: number | 'global';
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
    release?: number;
    fade_ms?: number;
    total_bars?: number | 'global';
    section_points?: number[];
    section_probability?: number[];
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

    const nodes = (((graph as any)._nodes || []) as any[]);
    const masterRoleNode = nodes.find(node =>
        canBeMainPreview(node) && (node.properties?.role === 'master' || node.properties?.is_main_preview)
    );
    if (masterRoleNode) {
        state.node_id = masterRoleNode.id;
        return masterRoleNode;
    }

    const trackRoot = nodes.find(node =>
        canBeMainPreview(node)
        && ((node as any).getNodeType?.() === 'track' || node.properties?.node_type === 'track')
        && trackNodes.get(node.id)?.parentId == null
    );
    if (trackRoot) {
        state.node_id = trackRoot.id;
        return trackRoot;
    }

    const firstRoot = nodes.find(node =>
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
    previewRecalculateBtn.disabled = !target && activeRamPreviewNodeId == null;
    const isPlaying = globalAudioScheduler.getIsPlaying()
        || (!masterPlayer.paused && !masterPlayer.ended)
        || (loopEnabled && Boolean(loopSource));
    globalPreviewBtn.title = target
        ? (isPlaying ? 'Pause transport (Space)' : `Play transport (Space) · ${targetName} (${state.mode === 'manual' ? 'manual' : 'automatic'})`)
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
            if (data.type === 'track') continue;
            const nodeObj = targetGraph.getNodeById(nodeId);

            let parentTargetBpm = globalParameters.bpm;
            if (data.parentId != null) {
                const parentData = trackNodes.get(data.parentId);
                const parentNodeObj = targetGraph.getNodeById(data.parentId);
                parentTargetBpm = parentData?.target_bpm ?? parentData?.bpm ?? parentNodeObj?.properties?.target_bpm ?? parentNodeObj?.properties?.bpm ?? globalParameters.bpm;
            }

            const configuredTarget = nodeObj?.properties?.target_bpm ?? data.target_bpm;
            const configuredBpm = nodeObj?.properties?.bpm ?? data.bpm;
            const alwaysInheritsBpm = data.type === 'sequence' || data.type === 'arrangement';
            const isGlobal = alwaysInheritsBpm
                || configuredTarget === 'global'
                || (configuredTarget == null && (configuredBpm === 'global' || configuredBpm == null));

            const resolvedBpm = isGlobal
                ? parentTargetBpm
                : (Number(configuredTarget) || Number(configuredBpm) || parentTargetBpm);

            if (data.target_bpm !== resolvedBpm) {
                data.target_bpm = resolvedBpm;
                changed = true;
            }
            if (isGlobal) {
                if (data.bpm !== 'global') {
                    data.bpm = 'global';
                    changed = true;
                }
                if (nodeObj?.properties && (alwaysInheritsBpm || nodeObj.properties.target_bpm === undefined || nodeObj.properties.target_bpm === null)) {
                    nodeObj.properties.target_bpm = 'global';
                    if (alwaysInheritsBpm) nodeObj.properties.bpm = 'global';
                }
            } else {
                if (data.bpm !== resolvedBpm) {
                    data.bpm = resolvedBpm;
                    changed = true;
                }
                if (nodeObj?.properties && nodeObj.properties.target_bpm !== resolvedBpm) {
                    nodeObj.properties.target_bpm = resolvedBpm;
                }
            }
        }
    }
}

(window as any).syncBpmInheritance = () => syncBpmInheritance();

function syncLengthInheritance(graph?: LGraph) {
    const targetGraph = graph || ((window as any).editorGraph as LGraph);
    if (!targetGraph) return;

    for (const [nodeId, data] of trackNodes.entries()) {
        if (data.parentId == null) continue;
        if (data.type !== 'arrangement' && data.type !== 'sequence' && !(data.type === 'sample' && data.sample_type === 'loop')) {
            continue;
        }

        const parentData = trackNodes.get(data.parentId);
        const parentNode = targetGraph.getNodeById(data.parentId);
        const parentSetting = parentNode?.properties?.total_bars ?? parentData?.total_bars;
        const parentBars = (parentSetting === 'global' || parentSetting == null)
            ? globalParameters.total_bars
            : Number(parentSetting);
        if (!Number.isFinite(parentBars) || Number(parentBars) <= 0) continue;

        const inheritedBars = Number(parentBars);
        const node = targetGraph.getNodeById(nodeId);
        const currentSetting = node?.properties?.total_bars ?? data.total_bars;

        const isInherited = currentSetting === 'global'
            || currentSetting == null
            || Boolean(node?.properties?.length_inherited)
            || (data.type === 'sequence' && !node?.properties?.length_explicit);

        if (isInherited) {
            data.total_bars = inheritedBars;
            if (node?.properties) {
                if (data.type === 'arrangement' || node.properties.total_bars !== 'global') {
                    if (data.type === 'arrangement') {
                        if (typeof (node as any).updateProperty === 'function') {
                            (node as any).updateProperty('total_bars', inheritedBars);
                        } else {
                            node.properties.total_bars = inheritedBars;
                        }
                    }
                }
                node.properties.length_inherited = true;
                node.properties.length_source_id = data.parentId;
            }
        }
    }
}

function syncArrangementLengthInheritance(graph?: LGraph) {
    syncLengthInheritance(graph);
}

(window as any).syncLengthInheritance = () => syncLengthInheritance();
(window as any).syncArrangementLengthInheritance = () => syncLengthInheritance();

function syncGraphHierarchy(graph?: LGraph) {
    const targetGraph = graph || ((window as any).editorGraph as LGraph);
    if (!targetGraph) return;
    for (const data of trackNodes.values()) {
        const node = targetGraph.getNodeById(data.id);
        data.parentId = ((node as any)?.isModifier || data.type === 'modulator' || data.type === 'asset_filter' || data.type === 'random')
            ? (node?.properties?.parentId ?? data.parentId ?? null)
            : null;
        data.children = [];
    }

    if ((targetGraph as any).links) {
        const links = (targetGraph as any).links;
        for (const linkId in links) {
            const link = links[linkId];
            if (!link) continue;

            const childData = trackNodes.get(link.origin_id);
            const parentId = link.target_id;
            if (childData && parentId != null) {
                const parentData = trackNodes.get(parentId);
                if (parentData && !parentData.children.includes(link.origin_id)) {
                    parentData.children.push(link.origin_id);
                }
                childData.parentId = parentId;
            }
        }
    }

    syncBpmInheritance(targetGraph);
    syncArrangementLengthInheritance(targetGraph);
    updateMainPreviewTarget(targetGraph);
    syncAllModifierPositions(targetGraph);
    applySignalFlowColors(targetGraph);
}

let connectionsChangeTimer: any = null;

window.addEventListener('graph-connections-changed', () => {
    const graph = (window as any).editorGraph as LGraph;
    if (graph) {
        syncGraphHierarchy(graph);
        updateGraphNodeCollapsing();

        // Mark all nodes in graph as invalidated because connectivity/topology has changed
        for (const node of (graph as any)._nodes || []) {
            if (node) {
                (node as any).isInvalidated = true;
                (node as any).setDirtyCanvas?.(true, true);
            }
        }
    } else {
        syncGraphHierarchy();
        updateGraphNodeCollapsing();
    }

    if (connectionsChangeTimer) {
        clearTimeout(connectionsChangeTimer);
    }

    connectionsChangeTimer = setTimeout(() => {
        // Fully clear DAG cache and RAM preview store in backend
        fetch('/api/preview/invalidate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ node_ids: [] })
        }).catch(() => { });

        // If active playback is ongoing, trigger seamless in-place hot-swap preview
        if (globalAudioScheduler.getIsPlaying()) {
            const currentGraph = (window as any).editorGraph as LGraph;
            const targetId = (activeRamPreviewNodeId != null && currentGraph?.getNodeById(activeRamPreviewNodeId))
                ? activeRamPreviewNodeId
                : resolveMainPreviewNode(currentGraph)?.id;
            if (targetId != null) {
                void previewNode(targetId, false, false, false);
            }
        }
    }, 150);
});

function updateGraphNodeCollapsing() {
    const graph = (window as any).editorGraph as LGraph;
    if (!graph) return;

    syncGraphHierarchy(graph);

    const allNodes: any[] = (graph as any)._nodes || [];
    for (const lgraphNode of allNodes) {
        if (!lgraphNode) continue;
        lgraphNode.flags = lgraphNode.flags || {};
        lgraphNode.flags.collapsed = false;
        (lgraphNode.flags as any).hidden = isModifierNode(lgraphNode);
        (lgraphNode as any).collapsedDotMode = false;
    }

    syncAllModifierPositions(graph);

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
        panel.id?.startsWith('properties_') || panel.id === 'track_properties'
    ) as IDockviewPanel[];
}

function dockedPropertyPanels(exceptPanelId?: string): IDockviewPanel[] {
    return propertyPanels().filter(panel =>
        panel.id !== exceptPanelId && !isFloatingPanel(panel)
    );
}

function updatePanelToggleButtons() {
    const dv = (window as any).dockview;
    const floatingLibBtn = topHeader.querySelector('#floating-toggle-library') as HTMLButtonElement | null;
    const propBtn = topHeader.querySelector('#header-toggle-properties') as HTMLButtonElement | null;

    if (dv && floatingLibBtn) {
        const p = dv.getGroupPanel('library_panel');
        const isOpen = Boolean(p);
        floatingLibBtn.classList.toggle('active', isOpen);
        floatingLibBtn.setAttribute('aria-expanded', String(isOpen));
        if (toggleLibraryBtn) toggleLibraryBtn.textContent = isOpen ? 'Close Library' : 'Open Library';
    }

    if (dv && propBtn) {
        const hasProp = dockedPropertyPanels().length > 0;
        propBtn.classList.toggle('active', hasProp);
        propBtn.setAttribute('aria-expanded', String(hasProp));
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
    if (node.type !== "Audio/Track" && node.type !== "Audio/Sample" && node.type !== "Audio/Sequence" && node.type !== "Audio/Arrangement" && node.type !== "Audio/Modulator" && node.type !== "Audio/AssetFilter" && node.type !== "Audio/Random" && !(node as any).isModifier) return;

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
    if (node.manifestStemUrl && !node.manifestStemBuffer && node.type !== 'Audio/Sample' && node.id !== activeRamPreviewNodeId) {
        fetchAudioBuffer(node.manifestStemUrl).then(buf => {
            if (buf && node.id !== activeRamPreviewNodeId) {
                node.manifestStemBuffer = buf;
                node.setDirtyCanvas?.(true, true);
            }
        }).catch(() => { });
    }
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

    if (!options?.forceOpen && dockedPropertyPanels().length === 0) {
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

function openTrackParamWindow() {
    const dv = (window as any).dockview;
    if (!dv) return;

    const panelId = 'track_properties';
    let panel = dv.getGroupPanel(panelId) as IDockviewPanel | undefined;
    const previousDockedPanels = dockedPropertyPanels(panelId);
    const previousDockedPanel = previousDockedPanels[0];

    (window as any)._currentlySelectedNode = null;

    if (panel) {
        if (!isFloatingPanel(panel)) {
            previousDockedPanels.forEach(previous => previous.api.close());
        }
        panel.api.setActive();
        updateGraphNodeCollapsing();
        updatePanelToggleButtons();
        return;
    }

    const width = 380;
    const graphPanel = dv.getGroupPanel('graph_panel');
    if (!graphPanel) return;

    panel = dv.addPanel({
        id: panelId,
        component: 'track-properties-panel',
        title: 'Track Parameters',
        position: {
            referencePanel: previousDockedPanel?.id || 'graph_panel',
            direction: previousDockedPanel ? 'within' : 'right'
        },
        initialWidth: width,
        minimumWidth: 260,
        maximumWidth: Math.max(width + 80, 580)
    });

    previousDockedPanels.forEach(previous => previous.api.close());
    panel?.api.setActive();
    updateGraphNodeCollapsing();
    updatePanelToggleButtons();
}

(window as any).openTrackParamWindow = openTrackParamWindow;

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
        openParamWindow(node, { forceOpen: true });
    } else {
        openTrackParamWindow();
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

window.addEventListener('open-node-properties', (e: any) => {
    const nodeId = e.detail?.nodeId;
    const graph = (window as any).editorGraph as LGraph;
    const targetNode = nodeId != null ? graph?.getNodeById(nodeId) : null;
    if (targetNode) {
        openParamWindow(targetNode, { forceOpen: true });
    }
});

window.addEventListener('add-asset-filter-to-param', (e: any) => {
    const nodeId = e.detail?.nodeId;
    const silent = Boolean(e.detail?.silent);
    const graph = (window as any).editorGraph as LGraph;
    const ownerNode = nodeId != null ? (graph?.getNodeById(nodeId) as any) : null;
    const ownerType = ownerNode?.getNodeType?.() || ownerNode?.properties?.node_type;
    if (!ownerNode || (ownerType !== 'sample' && ownerType !== 'sequence')) return;

    const assignedId = ownerNode.properties?.asset_modifier_id;
    let modifierNode = assignedId != null ? graph.getNodeById(assignedId) : null;
    if (!modifierNode) {
        modifierNode = (((graph as any)._nodes || []) as any[]).find(candidate =>
            (candidate?.getNodeType?.() === 'asset_filter' || candidate?.type === 'Audio/AssetFilter')
            && candidate?.properties?.parentId === nodeId
        ) || null;
    }
    if (!modifierNode) modifierNode = addAssetFilterNode(nodeId, false);
    if (!modifierNode) return;

    const acceptedType = ownerNode.acceptedPoolAssetType || (ownerType === 'sequence' ? 'sequence_source' : 'audio');
    modifierNode.properties.accepted_asset_type = acceptedType;
    if (acceptedType === 'sequence_source') {
        (modifierNode as any).updateProperty('node_name', 'MIDI / Sequence Pool');
    }
    const hadAssignedModifier = ownerNode.properties.asset_modifier_id === modifierNode.id;
    ownerNode.properties.asset_modifier_id = modifierNode.id;
    const ownerData = trackNodes.get(nodeId);
    if (ownerData) ownerData.asset_modifier_id = modifierNode.id;
    if (silent) {
        if (!hadAssignedModifier) {
            window.dispatchEvent(new CustomEvent('modifier-assignment-changed', { detail: { nodeId } }));
        }
        return;
    }

    const isOwnerAlreadyOpen = activeParamNodeId === ownerNode.id && dockedPropertyPanels().length > 0;
    if (typeof ownerNode.togglePoolView === 'function') {
        if (isOwnerAlreadyOpen) {
            ownerNode.togglePoolView();
        } else {
            ownerNode.togglePoolView(true);
        }
    } else if (ownerNode.properties) {
        ownerNode.properties.pool_view_open = isOwnerAlreadyOpen ? !ownerNode.properties.pool_view_open : true;
    }

    if (isOwnerAlreadyOpen) {
        window.dispatchEvent(new CustomEvent('node-properties-refreshed', { detail: { nodeId: ownerNode.id } }));
    } else {
        openParamWindow(ownerNode, { forceOpen: true });
    }
});

window.addEventListener('item-pool-preview-refresh', async (e: any) => {
    const poolNodeId = e.detail?.nodeId;
    const graph = (window as any).editorGraph as LGraph;
    if (!graph || poolNodeId == null) return;
    const poolNode = graph.getNodeById(poolNodeId);
    if (!poolNode) return;

    const selectedItems = Array.isArray(poolNode.properties?.selected_items)
        ? poolNode.properties.selected_items
        : [];
    if (selectedItems.length === 0) return;

    // Find any nodes associated with this pool (either via asset_modifier_id or parentId)
    const files = await resolveLibraryAssets(selectedItems);
    for (const item of selectedItems) {
        refreshLibraryAssetSnapshot(item, files);
    }

    const nodes = (((graph as any)._nodes || []) as any[]);
    for (const node of nodes) {
        if (!node) continue;
        const isAssociated = node.properties?.asset_modifier_id === poolNodeId ||
            poolNode.properties?.parentId === node.id;
        if (!isAssociated) continue;

        const nodeKind = node.getNodeType?.() || node.properties?.node_type;
        if (nodeKind === 'sample') {
            populateOwnerSlotsFromPool(poolNode, node, selectedItems);
            const data = trackNodes.get(node.id);
            if (data) {
                data.filepath = node.properties?.filepath || data.filepath;
                data.original_bpm = node.properties?.original_bpm ?? data.original_bpm;
                data.key = node.properties?.key ?? data.key;
                data.duration_seconds = node.properties?.duration_seconds ?? data.duration_seconds;
            }
            node.setDirtyCanvas?.(true, true);
            window.dispatchEvent(new CustomEvent('node-properties-refreshed', {
                detail: { nodeId: node.id }
            }));
            window.dispatchEvent(new CustomEvent('arrangement-source-changed', {
                detail: { nodeId: node.id }
            }));
        } else if (nodeKind === 'sequence') {
            populateOwnerSlotsFromPool(poolNode, node, selectedItems);
            const targetPath = poolNode.properties?.output_value;
            const activeItem = (targetPath
                ? selectedItems.find((it: any) => (it.filepath || it.absolute_path) === targetPath)
                : null) || selectedItems[0];
            if (!activeItem) continue;
            const dragItem: LibraryDragItem = {
                id: activeItem.id,
                name: activeItem.name,
                filepath: activeItem.filepath || activeItem.absolute_path,
                itemType: activeItem.type || 'sequence',
                key: activeItem.key || undefined,
                bpm: activeItem.bpm || undefined,
                duration_seconds: activeItem.duration_seconds || undefined
            };
            await applyLibraryItemToSequence(node, dragItem);
            node.setDirtyCanvas?.(true, true);
        }
    }
});

function addAssetFilterNode(parentId: number, openProperties: boolean = true) {
    return addModulatorNode(parentId, "asset_filter", openProperties);
}

function addRandomNode(parentId: number, openProperties: boolean = true) {
    const graph = (window as any).editorGraph as LGraph;
    const parentNode = graph?.getNodeById(parentId);
    const existing = (((graph as any)?._nodes || []) as any[]).find(candidate =>
        candidate &&
        (candidate.type === 'Audio/Random' || candidate.properties?.node_type === 'random' || candidate.properties?.modifier_kind === 'random') &&
        candidate.properties?.parentId === parentId
    );
    if (existing) {
        if (openProperties) {
            if (activeParamNodeId === existing.id && dockedPropertyPanels().length > 0 && parentNode) {
                openParamWindow(parentNode, { forceOpen: true });
            } else {
                openParamWindow(existing, { forceOpen: true });
            }
        }
        return existing;
    }
    return addModulatorNode(parentId, "random", openProperties);
}

window.addEventListener('add-random-node', (e: any) => {
    const parentId = e.detail?.parentId;
    if (parentId != null) {
        addRandomNode(parentId, true);
    }
});

function addModulatorNode(
    parentId: number,
    modifierKind: "modulator" | "asset_filter" | "random" = "modulator",
    openProperties: boolean = true
) {
    const graph = (window as any).editorGraph as LGraph;
    if (!graph) return;

    const parentNode = graph.getNodeById(parentId);
    if (!parentNode) return;

    const parentData = trackNodes.get(parentId);

    let modCount = 0;
    for (const data of trackNodes.values()) {
        if ((data.type === "modulator" || data.type === "asset_filter" || data.type === "random") && data.parentId === parentId) {
            modCount++;
        }
    }

    let nodeType = "Audio/Modulator";
    let modName = `Modulator ${modCount + 1}`;
    if (modifierKind === "asset_filter") {
        nodeType = "Audio/AssetFilter";
        modName = `Asset Pool ${modCount + 1}`;
    } else if (modifierKind === "random") {
        nodeType = "Audio/Random";
        modName = `Random ${modCount + 1}`;
    }

    const modNode = LiteGraph.createNode(nodeType);
    modNode.properties.node_name = modName;
    modNode.properties.node_type = modifierKind;
    modNode.properties.parentId = parentId;
    modNode.title = modName;
    modNode.flags = modNode.flags || {};
    (modNode.flags as any).hidden = true;

    if (typeof (modNode as any).computeSize === 'function') {
        modNode.size = (modNode as any).computeSize();
    }

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

    updateModifiersForParent(parentNode);
    updateGraphNodeCollapsing();
    window.dispatchEvent(new CustomEvent('graph-connections-changed'));
    if ((window as any).editorCanvas) {
        (window as any).editorCanvas.setDirty(true, true);
    }
    if (openProperties) openParamWindow(modNode);
    return modNode;
}

(window as any).addRandomNode = addRandomNode;
(window as any).addModulatorNode = addModulatorNode;

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
        void previewNode(changedNodeId, true, false, false);
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

    if ((nodeType as string) === "random") {
        return addRandomNode(parentId, openProperties);
    }

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
        childNode.properties.release = 0;
        childNode.properties.fade_ms = 0;
        childNode.properties.total_bars = 'global';
        childNode.properties.length_inherited = true;
    } else if (nodeType === "arrangement") {
        childNode.properties.total_bars = 4.0;
        childNode.properties.section_points = [];
        childNode.properties.section_probability = [1.0];
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
        release: nodeType === "sequence" ? 0 : undefined,
        fade_ms: nodeType === "sequence" ? 0 : undefined,
        bpm: nodeType === 'track' ? 'global' : undefined,
        target_bpm: nodeType === 'track' ? globalParameters.bpm : undefined,
        total_bars: nodeType === "arrangement" ? 4.0 : nodeType === 'track' ? 'global' : undefined,
        section_points: nodeType === "arrangement" ? [] : undefined,
        section_probability: nodeType === "arrangement" ? [1.0] : undefined,
        section_quant: nodeType === "arrangement" ? ["auto"] : undefined,
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

    if (activeRamPreviewNodeId === nodeId) {
        activeRamPreviewNodeId = null;
        (window as any).activeRamPreviewNodeId = null;
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
    const targetBpm = (nodeType === 'sample' && extractedBpm) ? origBpm : 'global';

    rootNode.properties.original_bpm = origBpm;
    rootNode.properties.target_bpm = nodeType === 'track' ? globalParameters.bpm : targetBpm;
    rootNode.properties.bpm = nodeType === 'track' ? 'global' : targetBpm;
    rootNode.properties.key = keyStr;

    if (nodeType === "sequence") {
        rootNode.properties.sequence = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
        rootNode.properties.step_length = 0.25;
        rootNode.properties.release = 0;
        rootNode.properties.fade_ms = 0;
    } else if (nodeType === "arrangement") {
        rootNode.properties.total_bars = 4.0;
        rootNode.properties.section_points = [];
        rootNode.properties.section_probability = [1.0];
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
        play_mode: nodeType === "sequence" ? "gate" : undefined,
        release: nodeType === "sequence" ? 0 : undefined,
        fade_ms: nodeType === "sequence" ? 0 : undefined,
        total_bars: nodeType === "arrangement" ? 4.0 : nodeType === 'track' ? 'global' : undefined,
        section_points: nodeType === "arrangement" ? [] : undefined,
        section_probability: nodeType === "arrangement" ? [1.0] : undefined,
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

function insertNodeIntoLink(
    targetLink: any,
    nodeType: "sample" | "item_pool" | "sequence" | "track" | "arrangement",
    canvasPos: [number, number]
): any | null {
    const graph = (window as any).editorGraph as LGraph;
    const canvas = (window as any).editorCanvas as LGraphCanvas;
    if (!graph || !targetLink) return null;

    const originNode = graph.getNodeById(targetLink.origin_id);
    const targetNode = graph.getNodeById(targetLink.target_id);
    if (!originNode || !targetNode) return null;

    const originSlot = targetLink.origin_slot;
    const targetSlot = targetLink.target_slot;
    const linkId = targetLink.id;
    const leftPortBranchInput = targetLink[LEFT_PORT_BRANCH_INPUT];

    // 1. Create the new node centered at the insertion position
    const newNode = addRootNode(nodeType, canvasPos);
    if (!newNode) return null;

    const width = newNode.size?.[0] || 140;
    const height = newNode.size?.[1] || 80;
    newNode.pos = [canvasPos[0] - width / 2, canvasPos[1] - height / 2];

    // 2. Remove the original link to free the destination slot
    graph.removeLink(linkId);

    // 3. Connect originNode -> newNode (input 0)
    if (newNode.inputs && newNode.inputs.length > 0) {
        originNode.connect(originSlot, newNode, 0);
    }

    // 4. Connect newNode (output 0) -> targetNode (targetSlot)
    if (newNode.outputs && newNode.outputs.length > 0) {
        const newLink = newNode.connect(0, targetNode, targetSlot);
        if (Number.isInteger(leftPortBranchInput)) {
            markLeftPortBranch(newLink, targetNode, leftPortBranchInput);
        }
    }

    // 5. Select the newly inserted node and focus it
    if (canvas && typeof (canvas as any).selectNode === 'function') {
        (canvas as any).selectNode(newNode);
    }

    // 6. Synchronize hierarchy, audio inheritance, collapsing, and engine
    syncGraphHierarchy(graph);
    updateGraphNodeCollapsing();
    window.dispatchEvent(new CustomEvent('graph-connections-changed'));
    if (canvas) {
        canvas.setDirty(true, true);
    }

    return newNode;
}
(window as any).insertNodeIntoLink = insertNodeIntoLink;

async function applyLibraryItemToSample(node: any, item: LibraryDragItem) {
    if (!node?.properties || isMidiLibraryItem(item)) return false;

    const files = await resolveLibraryAssets([item]);
    const latest = refreshLibraryAssetSnapshot(item, files);

    const metadata = extractMetadataFromPath(item.filepath);
    const originalBpm = item.bpm || metadata.bpm || node.properties.original_bpm || 120;
    const targetBpm = node.properties.target_bpm || originalBpm;
    const nodeName = item.name || item.filepath.split(/[\\/]/).pop() || "Sample";
    const sampleType = item.itemType === "one_shot" ? "one_shot" : "loop";

    const resolvedKey = latest ? String(latest.key ?? '') : (item.key || metadata.key || "");
    const resolvedItemId = latest?.id ?? item.id;
    if (typeof node.updateProperty === 'function') {
        node.updateProperty('node_name', nodeName);
        node.updateProperty('sample_type', sampleType);
        node.updateProperty('original_bpm', originalBpm);
        node.updateProperty('target_bpm', targetBpm);
        node.updateProperty('bpm', targetBpm);
        node.updateProperty('key', resolvedKey);
        if (resolvedItemId !== undefined) {
            node.updateProperty('library_item_id', resolvedItemId);
        }
        if (item.duration_seconds !== undefined) {
            node.updateProperty('duration_seconds', item.duration_seconds);
        }
        node.updateProperty('filepath', item.filepath);
    } else {
        Object.assign(node.properties, {
            node_name: nodeName,
            node_type: "sample",
            filepath: item.filepath,
            library_item_id: resolvedItemId,
            sample_type: sampleType,
            original_bpm: originalBpm,
            target_bpm: targetBpm,
            bpm: targetBpm,
            key: resolvedKey,
            duration_seconds: item.duration_seconds ?? undefined
        });
    }
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
            key: resolvedKey,
            duration_seconds: item.duration_seconds ?? undefined
        });
    }

    const graph = (window as any).editorGraph as LGraph;
    if (graph && !isGraphEvaluating()) {
        markNodeAndAncestorsInvalidated(graph, node.id);
    }
    node.setDirtyCanvas?.(true, true);
    window.dispatchEvent(new CustomEvent('arrangement-source-changed', {
        detail: { nodeId: node.id },
    }));
    return true;
}

const parsedMidiCache = new Map<string, any>();

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
        const graph = (window as any).editorGraph as LGraph;
        if (graph && !isGraphEvaluating()) markNodeAndAncestorsInvalidated(graph, node.id);
        node.setDirtyCanvas?.(true, true);
        window.dispatchEvent(new CustomEvent('arrangement-source-changed', {
            detail: { nodeId: node.id },
        }));
        window.dispatchEvent(new CustomEvent('node-properties-refreshed', {
            detail: { nodeId: node.id }
        }));
        return true;
    }

    let parsed = parsedMidiCache.get(item.filepath);
    if (!parsed) {
        const response = await fetch('/api/midi/parse', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filepath: item.filepath })
        });
        if (!response.ok) {
            throw new Error(`MIDI parsing failed (${response.status})`);
        }
        parsed = await response.json();
        if (Array.isArray(parsed?.sequence) && parsed.sequence.length > 0) {
            parsedMidiCache.set(item.filepath, parsed);
        }
    }
    if (!Array.isArray(parsed.sequence) || parsed.sequence.length === 0) {
        throw new Error("MIDI file did not contain a playable sequence");
    }

    const sourceName = item.name || item.filepath.split(/[\\/]/).pop() || "Sequence";
    const nodeName = sourceName.replace(/\.(?:mid|midi)$/i, '') || "Sequence";

    if (typeof node.updateProperty === 'function') {
        node.updateProperty('node_name', nodeName);
        node.updateProperty('sequence_name', nodeName);
        node.updateProperty('filepath', item.filepath);
        if (item.id != null) node.updateProperty('library_item_id', item.id);
        node.updateProperty('sequence', [...parsed.sequence]);
        if (Array.isArray(parsed.step_parameters)) {
            node.updateProperty('step_parameters', parsed.step_parameters.map((step: any) => ({ ...step })));
        }
        if (parsed.bpm || item.bpm) {
            node.updateProperty('original_bpm', parsed.bpm || item.bpm || 120);
        }
    } else {
        Object.assign(node.properties, {
            node_name: nodeName,
            sequence_name: nodeName,
            node_type: "sequence",
            filepath: item.filepath,
            library_item_id: item.id ?? node.properties.library_item_id,
            sequence: [...parsed.sequence],
            step_parameters: Array.isArray(parsed.step_parameters)
                ? parsed.step_parameters.map((step: any) => ({ ...step }))
                : node.properties.step_parameters,
            original_bpm: parsed.bpm || item.bpm || node.properties.original_bpm || 120
        });
        node.title = nodeName;
    }

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

    const graph = (window as any).editorGraph as LGraph;
    if (graph && !isGraphEvaluating()) {
        markNodeAndAncestorsInvalidated(graph, node.id);
    }
    node.setDirtyCanvas?.(true, true);
    window.dispatchEvent(new CustomEvent('arrangement-source-changed', {
        detail: { nodeId: node.id },
    }));
    window.dispatchEvent(new CustomEvent('node-properties-refreshed', {
        detail: { nodeId: node.id }
    }));
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
    const nextSeed = node.properties.seed ?? 42;
    if (typeof node.updateProperty === 'function') {
        node.updateProperty('selected_items', selectedItems);
        node.updateProperty('seed', nextSeed);
    } else {
        node.properties.selected_items = selectedItems;
        node.properties.seed = nextSeed;
    }
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
    const nodeKind = node.getNodeType?.() || node.properties?.node_type;

    if (nodeKind === "sample") {
        const sample = items.find(item => !isMidiLibraryItem(item));
        return sample ? await applyLibraryItemToSample(node, sample) : false;
    }

    if (nodeKind === "sequence") {
        let applied = false;
        const sequenceSource = items.find(isSequenceSourceLibraryItem);
        const sample = items.find(item => !isSequenceSourceLibraryItem(item));
        if (sequenceSource) applied = await applyLibraryItemToSequence(node, sequenceSource) || applied;
        if (sample) applied = await attachLibrarySampleToSequence(node, sample) || applied;
        return applied;
    }

    if (nodeKind === "asset_filter") {
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
const DEFAULT_STAGE_SAVE_DELAY_MS = 2500;
const STAGE_SAVE_ERROR_COOLDOWN_MS = 8000;
let lastStageSaveErrorAt = 0;
let lastStageSaveErrorMessage: string | null = null;

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
    writeGlobalFreezeToGraph(graph);
    const graphData = serializeWorkspaceGraph(graph);
    return {
        fingerprint: JSON.stringify(graphData),
        stage: {
            version: WORKSPACE_PRESET_VERSION,
            savedAt: new Date().toISOString(),
            frozen: Boolean(isGlobalFreezeActive),
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

function scheduleStageSave(delay = DEFAULT_STAGE_SAVE_DELAY_MS) {
    if (!stageReady || stageHydrating || isGraphEvaluating()) return;
    const graph = (window as any).editorGraph as LGraph;
    if (!graph) return;

    const current = createCurrentStage(graph);
    if (current.fingerprint === lastSavedStageFingerprint) {
        if (!stageSaveInFlight) setStageSaveState('saved');
        return;
    }

    setStageSaveState('unsaved');
    if (stageSaveTimer !== null) window.clearTimeout(stageSaveTimer);

    let effectiveDelay = delay;
    // For non-immediate auto-saves, back off if an error occurred recently to avoid hammering the network
    if (delay > 0 && lastStageSaveErrorAt > 0) {
        const elapsedSinceError = performance.now() - lastStageSaveErrorAt;
        if (elapsedSinceError < STAGE_SAVE_ERROR_COOLDOWN_MS) {
            effectiveDelay = Math.max(delay, STAGE_SAVE_ERROR_COOLDOWN_MS - elapsedSinceError);
        }
    }

    stageSaveTimer = window.setTimeout(() => {
        stageSaveTimer = null;
        void saveCurrentStage();
    }, effectiveDelay);
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
    let saveFailed = false;
    try {
        const response = await fetch('/api/stage', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ stage: current.stage })
        });
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.detail || `Could not save current stage (${response.status})`);
        }
        lastSavedStageFingerprint = current.fingerprint;
        lastStageSaveErrorAt = 0;
        lastStageSaveErrorMessage = null;
        const latest = createCurrentStage(graph).fingerprint;
        setStageSaveState(latest === lastSavedStageFingerprint ? 'saved' : 'unsaved');
        runtimeLog(`Saving current stage complete (${Math.round(performance.now() - saveStartedAt)} ms)`, 'debug');
    } catch (error) {
        saveFailed = true;
        lastStageSaveErrorAt = performance.now();
        console.error('Could not auto-save current stage', error);
        setStageSaveState('error');
        const message = error instanceof Error ? error.message : String(error);
        if (message !== lastStageSaveErrorMessage) {
            runtimeLog(`Saving current stage failed: ${message}`, 'error');
            lastStageSaveErrorMessage = message;
        }
    } finally {
        stageSaveInFlight = false;
        const resolveCompletion = resolveStageSaveCompletion;
        resolveStageSaveCompletion = null;
        stageSaveCompletion = null;
        resolveCompletion?.();
        if (stageSaveQueued) {
            stageSaveQueued = false;
            scheduleStageSave(saveFailed ? STAGE_SAVE_ERROR_COOLDOWN_MS : DEFAULT_STAGE_SAVE_DELAY_MS);
        }
    }
}

async function restoreCurrentStage(graph: LGraph, canvas: LGraphCanvas): Promise<boolean> {
    setStageSaveState('loading');
    stageHydrating = true;
    const restoreStartedAt = performance.now();
    runtimeLog('Restoring current stage started', 'debug');
    try {
        const urlParams = new URLSearchParams(window.location.search);
        const gaiaProjectId = urlParams.get('gaia_project');
        const targetId = urlParams.get('target_id');
        if (gaiaProjectId) {
            runtimeLog(`Loading GAIA linked project #${gaiaProjectId} (read-only copy)`, 'common');
            try {
                const targetQuery = targetId ? `?target_id=${encodeURIComponent(targetId)}` : '';
                const gaiaRes = await fetch(`http://127.0.0.1:8001/items/${gaiaProjectId}/graph${targetQuery}`);
                if (gaiaRes.ok) {
                    const gaiaData = await gaiaRes.json();
                    if (gaiaData?.graph) {
                        const convertRes = await fetch('/api/graph/convert', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ graph: gaiaData.graph })
                        });
                        if (convertRes.ok) {
                            const workspace = await convertRes.json();
                            if (workspace?.graph) {
                                closeAllParamWindows();
                                activeParamNodeId = null;
                                graph.configure(prepareWorkspaceGraph(workspace.graph));
                                loadGlobalFreezeFromGraph(workspace, graph);
                                rebuildTrackNodesFromGraph(graph);
                                loadGlobalParametersFromGraph(graph);
                                updateGraphNodeCollapsing();
                                canvas.setDirty(true, true);
                                void preloadSubtreeAssets(graph);
                                lastSavedStageFingerprint = JSON.stringify(workspace.graph);
                                setStageSaveState('saved', `GAIA Project #${gaiaProjectId} (Read-Only)`);
                                runtimeLog(`Loaded GAIA project #${gaiaProjectId} into SIN canvas`, 'common');
                                return true;
                            }
                        }
                    }
                }
            } catch (err) {
                console.error('Failed loading GAIA project', err);
            }
        }

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
        loadGlobalFreezeFromGraph(stage, graph);
        rebuildTrackNodesFromGraph(graph);
        loadGlobalParametersFromGraph(graph);
        updateGraphNodeCollapsing();
        await withGraphEvaluationWindow(async () => {
            const libraryFiles = await syncGraphSampleMetadataFromLibrary(graph, true);
            await resolveAssignedAssetFilters(graph, undefined as any, {
                kind: 'preview',
                globalPreview: false,
                globalFreeze: true,
                libraryFiles
            });
        }).catch(err => {
            console.warn('Could not pre-resolve stage asset pools on restore:', err);
        });
        canvas.setDirty(true, true);
        void preloadSubtreeAssets(graph);
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
    const payload = JSON.stringify({ stage: current.stage });
    // Browsers impose a 64KB limit on sendBeacon. Only attempt beacon when within quota.
    if (payload.length <= 65536) {
        const body = new Blob([payload], { type: 'application/json' });
        if (navigator.sendBeacon('/api/stage', body)) return;
    }
    void saveCurrentStage();
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
                canvas.setAttribute('tabindex', '0');
                element.appendChild(canvas);
                element.addEventListener('contextmenu', (e: MouseEvent) => {
                    e.preventDefault();
                });

                requestAnimationFrame(async () => {
                    const graph = new LGraph();
                    (window as any).editorGraph = graph;
                    loadGlobalParametersFromGraph(graph);

                    // Render connections behind nodes so cables never cross over node text or waveforms
                    if (!graph.config) graph.config = {};
                    (graph.config as any).links_ontop = false;

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
                        window.dispatchEvent(new CustomEvent('graph-connections-changed'));
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

                        ctx.restore();
                    };
                    if (graphCanvas.bgcanvas) {
                        graphCanvas.bgcanvas.style.backgroundColor = "#ffffff";
                    }

                    // Context Menu Override for Nodes & Canvas right-clicks
                    graphCanvas.processContextMenu = function (node: any, e: MouseEvent) {
                        if (e) {
                            e.preventDefault?.();
                            e.stopPropagation?.();
                        }
                        if (node) {
                            nodeContextMenu.show(e.clientX, e.clientY, node);
                        } else if (hoveredLink) {
                            const targetLink = hoveredLink;
                            const clientX = e ? e.clientX : window.innerWidth / 2;
                            const clientY = e ? e.clientY : window.innerHeight / 2;
                            const offset = this.convertEventToCanvasOffset(e);
                            const canvasPos: [number, number] = [offset[0], offset[1]];

                            hoveredLink = null;
                            canvas.style.cursor = "default";
                            graphCanvas.setDirty(true, true);

                            popupMenu.show(clientX, clientY, (nodeType) => {
                                insertNodeIntoLink(targetLink, nodeType, canvasPos);
                            }, { mode: 'insert', placeholder: 'Insert OP into cable...' });
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
                        e.stopPropagation();
                        const offset = graphCanvas.convertEventToCanvasOffset(e);
                        const node = (graphCanvas as any).getNodeOnPos(offset[0], offset[1], (graph as any)._nodes, 0);
                        if (node) {
                            nodeContextMenu.show(e.clientX, e.clientY, node);
                        } else if (hoveredLink) {
                            const targetLink = hoveredLink;
                            const clientX = e.clientX;
                            const clientY = e.clientY;
                            const canvasPos: [number, number] = [offset[0], offset[1]];

                            hoveredLink = null;
                            canvas.style.cursor = "default";
                            graphCanvas.setDirty(true, true);

                            popupMenu.show(clientX, clientY, (nodeType) => {
                                insertNodeIntoLink(targetLink, nodeType, canvasPos);
                            }, { mode: 'insert', placeholder: 'Insert OP into cable...' });
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
                        if (!graph || e.buttons !== 0 || graphCanvas.node_over || graphCanvas.connecting_node || graphCanvas.dragging_canvas || graphCanvas.node_dragged || (graphCanvas as any).selected_group_resizing) {
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
                                const { cp1, cp2 } = getLinkControlPoints(posA, posB);

                                const dist = getDistanceToCubicBezier(canvasX, canvasY, posA, cp1, cp2, posB);
                                if (dist < minDistance) {
                                    minDistance = dist;
                                    closestLink = link;
                                }
                            }
                        }

                        if (hoveredLink !== closestLink) {
                            hoveredLink = closestLink;
                            if (hoveredLink) {
                                canvas.style.cursor = "pointer";
                            } else {
                                canvas.style.cursor = "default";
                            }
                            graphCanvas.setDirty(true, true);
                        }
                    });

                    canvas.addEventListener('mousedown', (e: MouseEvent) => {
                        if (e.button === 0 && hoveredLink) {
                            canvas.focus?.();
                            const isMulti = e.shiftKey || e.ctrlKey;
                            if (isMulti) {
                                if (selectedLinkIds.has(hoveredLink.id)) {
                                    selectedLinkIds.delete(hoveredLink.id);
                                } else {
                                    selectedLinkIds.add(hoveredLink.id);
                                }
                            } else {
                                selectedLinkIds.clear();
                                selectedLinkIds.add(hoveredLink.id);
                                graphCanvas.deselectAllNodes?.();
                            }
                            graphCanvas.setDirty(true, true);
                            e.stopPropagation();
                            e.preventDefault();
                        } else if (e.button === 0 && !hoveredLink && !e.shiftKey && !e.ctrlKey) {
                            if (selectedLinkIds.size > 0) {
                                selectedLinkIds.clear();
                                graphCanvas.setDirty(true, true);
                            }
                        } else if (e.button === 2 && hoveredLink) {
                            const targetLink = hoveredLink;
                            const clientX = e.clientX;
                            const clientY = e.clientY;
                            const offset = graphCanvas.convertEventToCanvasOffset(e);
                            const canvasPos: [number, number] = [offset[0], offset[1]];

                            hoveredLink = null;
                            canvas.style.cursor = "default";
                            graphCanvas.setDirty(true, true);

                            e.stopPropagation();
                            e.preventDefault();

                            popupMenu.show(clientX, clientY, (nodeType) => {
                                insertNodeIntoLink(targetLink, nodeType, canvasPos);
                            }, { mode: 'insert', placeholder: 'Insert OP into cable...' });
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
                            graphCanvas.draw(true, true);
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
                        (window as any)._currentlySelectedNode = node;
                        updateGraphNodeCollapsing();
                        if (dockedPropertyPanels().length > 0) {
                            openParamWindow(node);
                        }
                    };

                    graphCanvas.onNodeDeselected = function () {
                        (window as any)._currentlySelectedNode = null;
                        updateGraphNodeCollapsing();
                        if (dockedPropertyPanels().length > 0) {
                            openTrackParamWindow();
                        }
                    };

                    canvas.addEventListener('click', () => {
                        if (!graphCanvas.node_over && !hoveredLink && dockedPropertyPanels().length > 0) {
                            (window as any)._currentlySelectedNode = null;
                            openTrackParamWindow();
                        }
                    });
                });
                break;
            }
            case 'properties-panel': {
                const nodeId = options.params?.nodeId;
                const graph = (window as any).editorGraph;
                let node = (graph && nodeId != null) ? graph.getNodeById(nodeId) : (window as any)._currentlySelectedNode;
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
            case 'track-properties-panel': {
                const onClose = () => {
                    const dv = (window as any).dockview;
                    if (dv) {
                        const p = dv.getGroupPanel('track_properties');
                        if (p) p.api.close();
                    }
                };
                const win = new TrackPropertiesWindow(element, onClose);
                disposeComponent = () => win.dispose();
                break;
            }
            case 'library-panel': {
                const onClose = () => {
                    toggleLibraryPanel('close');
                };
                const panel = new LibraryPanel(element, onClose);
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

const transportToggle = document.createElement('button');
transportToggle.id = 'transport-bar-toggle';
transportToggle.className = 'transport-bar-toggle';
transportToggle.type = 'button';
transportToggle.setAttribute('aria-label', 'Toggle Transport Bar');

const syncTransportBarState = (open: boolean) => {
    transportToggle.classList.toggle('is-collapsed', !open);
    transportToggle.setAttribute('aria-expanded', String(open));
    transportToggle.title = open ? 'Hide Transport Bar' : 'Show Transport Bar';
    playbackFooter.classList.toggle('is-collapsed', !open);
    dockview.layout(dockviewContainer.clientWidth, dockviewContainer.clientHeight);
};

const storedTransportState = typeof localStorage !== 'undefined' ? localStorage.getItem('sin-transport-bar-open') : null;
let isTransportOpen = storedTransportState !== null ? storedTransportState === 'true' : false;

transportToggle.innerHTML = `
    <svg class="transport-toggle-icon" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path class="transport-toggle-arrow" d="M3 6l5 5 5-5"/>
    </svg>
`;

transportToggle.addEventListener('click', () => {
    isTransportOpen = !isTransportOpen;
    if (typeof localStorage !== 'undefined') {
        localStorage.setItem('sin-transport-bar-open', String(isTransportOpen));
    }
    syncTransportBarState(isTransportOpen);
});

dockviewContainer.appendChild(transportToggle);
syncTransportBarState(isTransportOpen);
const engineSync = EngineSyncManager.getInstance();
engineSync.attachTo(dockviewContainer);
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


function formatApiError(status: number, errJson: any, rawText: string): string {
    const detail = errJson?.detail;
    if (!detail && rawText) return rawText;
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail)) {
        return detail.map((e: any) => {
            const loc = Array.isArray(e.loc) ? e.loc.filter((l: any) => l !== 'body').join('.') : (e.loc || '');
            return `${loc ? loc + ': ' : ''}${e.msg || JSON.stringify(e)}`;
        }).join('; ');
    }
    if (typeof detail === 'object' && detail !== null) {
        return JSON.stringify(detail);
    }
    return `Status code ${status}`;
}

async function evaluateGraphModifiersAndMetadata(
    graph: LGraph,
    nodeId: number,
    kind: 'render' | 'preview',
    refreshModifiers: boolean = true,
    globalPreview: boolean = false
): Promise<void> {
    await withGraphEvaluationWindow(async () => {
        const libraryFiles = await loggedTask('Resolve graph asset metadata', () =>
            syncGraphSampleMetadataFromLibrary(graph, true, nodeId)
        );
        await loggedTask(`Resolve ${kind} asset pools`, () =>
            resolveAssignedAssetFilters(graph, nodeId, {
                kind,
                globalPreview: kind === 'preview' ? (refreshModifiers ? globalPreview : false) : undefined,
                globalFreeze: refreshModifiers ? isGlobalFreezeActive : true,
                libraryFiles
            })
        );
        if (refreshModifiers) {
            await loggedTask('Resolve random modifiers', () =>
                resolveAssignedRandomModifiers(graph, nodeId, {
                    kind,
                    globalPreview: kind === 'preview' ? globalPreview : undefined,
                    globalFreeze: isGlobalFreezeActive
                })
            );
        }
    });
}

async function throwFormattedResponseError(res: Response, prefix: string): Promise<never> {
    let errJson: any = null;
    let rawText = '';
    try {
        errJson = await res.json();
    } catch {
        try { rawText = await res.text(); } catch { }
    }
    throw new Error(`${prefix}: ${formatApiError(res.status, errJson, rawText)}`);
}

async function renderNode(nodeId: number, autoPlay: boolean = true) {
    const graph = (window as any).editorGraph as LGraph;
    if (!graph) return;

    const targetNode = graph.getNodeById(nodeId) as any;
    if (targetNode?.renderBtn) {
        targetNode.renderBtn.label = '…';
        (window as any).editorCanvas?.setDirty?.(true, true);
    }
    masterWaveform.clear('Rendering to disk...');
    masterPlayBtn.disabled = true;
    updatePlaybackControls();

    const renderStartedAt = performance.now();
    console.log(`[Render] Starting disk render (/api/render) for node #${nodeId}`);
    runtimeLog(`Disk render requested for node ${nodeId}`, 'common');
    try {
        try {
            await evaluateGraphModifiersAndMetadata(graph, nodeId, 'render', true, false);
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

        payload.project_name = getCurrentProjectName();
        if (targetNode?.properties) {
            payload.export_directory = targetNode.properties.export_directory || 'exports';
            payload.export_pattern = targetNode.properties.export_pattern || '{project}_{name}_{idx}';
            payload.export_overwrite_mode = targetNode.properties.export_overwrite_mode || 'incremental';
        }

        const res = await loggedTask('Render audio on server', () =>
            fetch('/api/render', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            })
        );

        if (!res.ok) {
            await throwFormattedResponseError(res, 'Render failed');
        }
        const data = await res.json();
        appendServerRuntimeLog(data.runtime_log);

        if (data.status === 'success' && data.filename) {
            if (data.file_url) {
                masterPlayer.src = data.file_url;
                if (!loopEnabled && autoPlay) masterPlayer.play().catch(e => console.error(e));
            }
            const outPath = data.file_path || data.filename;
            runtimeLog(`Export complete: ${outPath} (${Math.round(performance.now() - renderStartedAt)} ms)`, 'common');
            window.dispatchEvent(new CustomEvent('render-completed', {
                detail: { nodeId, filename: data.filename, filePath: data.file_path, fileUrl: data.file_url }
            }));
        } else {
            console.error("Render failed:", data);
            window.dispatchEvent(new CustomEvent('render-failed', {
                detail: { nodeId, error: data?.detail || 'Render failed' }
            }));
            alert("Render failed, check console.");
        }
    } catch (err) {
        console.error("Error during render:", err);
        const errMsg = (err as Error).message || String(err);
        runtimeLog(`Disk render failed: ${errMsg}`, 'error');
        window.dispatchEvent(new CustomEvent('render-failed', {
            detail: { nodeId, error: errMsg }
        }));
        alert(`Error during render: ${errMsg}`);
    } finally {
        if (targetNode?.renderBtn) {
            targetNode.renderBtn.label = 'R';
            (window as any).editorCanvas?.setDirty?.(true, true);
        }
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
let currentPreviewAbortController: AbortController | null = null;
let currentPreviewSessionId = 0;
let activePreviewAutoplay = false;
let activePreviewNodeIdInFlight: number | null = null;

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
    console.log(`[Preview] Starting RAM preview (/api/preview) for node #${nodeId}`);

    if (currentPreviewAbortController) {
        currentPreviewAbortController.abort();
    }
    const abortController = new AbortController();
    currentPreviewAbortController = abortController;
    const sessionId = ++currentPreviewSessionId;
    activePreviewNodeIdInFlight = nodeId;
    activePreviewAutoplay = autoplay || activePreviewAutoplay;

    // Flush any pending debounced parameter invalidations immediately so the backend
    // DAG cache is invalidated before rendering and no late timer aborts this stream.
    if (dspInvalidateTimer) {
        clearTimeout(dspInvalidateTimer);
        dspInvalidateTimer = null;
    }
    if (pendingGlobalParamInvalidation || pendingInvalidatedNodes.size > 0) {
        const idsToInvalidate = pendingGlobalParamInvalidation ? [] : Array.from(pendingInvalidatedNodes);
        pendingInvalidatedNodes.clear();
        pendingGlobalParamInvalidation = false;
        await fetch('/api/preview/invalidate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ node_ids: idsToInvalidate }),
            signal: abortController.signal
        }).catch(() => { });
    }

    activeRamPreviewNodeId = nodeId;
    (window as any).activeRamPreviewNodeId = nodeId;
    const targetNode = graph.getNodeById(nodeId);
    const nodeName = targetNode?.properties?.node_name || targetNode?.title || ('Node #' + nodeId);
    const engineSync = EngineSyncManager.getInstance();
    engineSync.setState(globalAudioScheduler.getIsPlaying() && !activePreviewAutoplay ? 'hot_swapping' : 'dsp_rendering', { nodeId, nodeName });

    if (targetNode) {
        (targetNode as any).isInvalidated = true;
        (targetNode as any).bufferedProgress = 0;
        (targetNode as any).setDirtyCanvas?.(true, true);
    }
    (window as any).editorCanvas?.setDirty?.(true, true);

    try {
        await evaluateGraphModifiersAndMetadata(graph, nodeId, 'preview', refreshModifiers, globalPreview);
        void preloadSubtreeAssets(graph, nodeId);
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
        const res = await loggedTask('Connect to progressive preview stream', () =>
            fetch('/api/preview/stream-progressive?format=binary', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: abortController.signal
            })
        );

        if (!res.ok) {
            await throwFormattedResponseError(res, 'RAM preview failed');
        }

        const isSessionCurrent = () =>
            requestVersion === previewRequestVersion && sessionId === currentPreviewSessionId;

        const finalData = await readProgressivePreviewStream({
            response: res,
            signal: abortController.signal,
            isSessionCurrent,
            decodeWav: (raw) => globalAudioScheduler.decodeWav(raw),
            decodeBase64Wav: (b64) => globalAudioScheduler.decodeBase64Wav(b64),
            onBarChunk: async (chunkData, audioBuf) => {
                if (!isSessionCurrent()) return;
                const stagedProgress = globalAudioScheduler.stageBarChunk({
                    barIndex: chunkData.bar_index,
                    totalBars: chunkData.total_bars,
                    bpm: chunkData.bpm,
                    startSeconds: chunkData.start_seconds,
                    durationSeconds: chunkData.duration_seconds,
                    audioBuffer: audioBuf,
                    peaks: chunkData.peaks
                }, sessionId);

                engineSync.setState('streaming_chunks', {
                    barsReceived: chunkData.bar_index + 1,
                    totalBars: chunkData.total_bars,
                    nodeId,
                    nodeName
                });

                if (targetNode) {
                    (targetNode as any).bufferedProgress = stagedProgress;
                    (targetNode as any).setDirtyCanvas?.(true, true);
                }
                (window as any).editorCanvas?.setDirty?.(true, false);
            }
        });

        const fallbackUrl = `/api/preview/stream/${keyName}`;
        const data = finalData ? {
            status: 'success',
            audio_url: finalData.audio_url || fallbackUrl,
            manifest: finalData.manifest,
            runtime_log: finalData.runtime_log,
            ...finalData
        } : { status: 'success', audio_url: fallbackUrl };
        appendServerRuntimeLog(data.runtime_log);

        if (data.status === 'success' && data.audio_url) {
            if (requestVersion !== previewRequestVersion || sessionId !== currentPreviewSessionId) {
                runtimeLog(`Discarded superseded preview for node ${nodeId}`, 'warning');
                return;
            }
            activeRamPreviewNodeId = nodeId;
            (window as any).activeRamPreviewNodeId = nodeId;
            activeRamPreviewPayload = payload;
            activeRamPreviewSource = data.audio_url;

            // 1. Atomically commit the full multi-bar session into the scheduler
            globalAudioScheduler.commitSession(sessionId);
            const fullBuf = globalAudioScheduler.getFullAudioBuffer();
            if (fullBuf) {
                (window as any).activeRamPreviewBuffer = fullBuf;
                masterWaveform.setAudioBuffer(fullBuf, data.total_duration || globalAudioScheduler.getTotalDuration());
            }

            // 2. Distribute workspace manifest and await intermediate stem buffers BEFORE starting playback
            // so waveforms never jump or refresh mid-playback.
            if (data.manifest && typeof data.manifest === 'object') {
                await distributeWorkspaceManifest(graph, data.manifest);
            }
            if (requestVersion !== previewRequestVersion || sessionId !== currentPreviewSessionId) {
                return;
            }

            clearSubtreeInvalidated(graph, nodeId);
            if (targetNode) {
                (targetNode as any).bufferedProgress = 1.0;
                (targetNode as any).setDirtyCanvas?.(true, true);
            }

            previewRecalculateBtn.disabled = false;
            masterPlayBtn.disabled = false;
            masterLoopBtn.disabled = false;

            // 3. Start transport and visual telemetry together only after audio & stems are 100% ready
            const shouldStartPlayback = activePreviewAutoplay;
            activePreviewAutoplay = false;
            if (shouldStartPlayback && !globalAudioScheduler.getIsPlaying()) {
                await globalAudioScheduler.playFromStart();
                startPlaybackTelemetry();
            } else if (globalAudioScheduler.getIsPlaying()) {
                startPlaybackTelemetry();
            }

            updatePlaybackControls();
            (window as any).editorCanvas?.setDirty?.(true, true);

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
            const totalDurationMs = Math.round(performance.now() - previewStartedAt);
            engineSync.setState('idle_synced', {
                lastRenderDurationMs: finalData?.metrics?.render_ms ?? totalDurationMs,
                nodeId,
                nodeName
            });
            if (finalData?.metrics) {
                updateEngineTelemetry({
                    renderMs: finalData.metrics.render_ms,
                    streamMs: Math.max(0, totalDurationMs - (finalData.metrics.render_ms || 0)),
                    totalMs: totalDurationMs,
                    bufferedPercent: 100
                });
            }
            runtimeLog(`Preview ready for node ${nodeId} (${totalDurationMs} ms)`, 'common');
        } else {
            throw new Error(data.detail || "RAM preview calculation failed.");
        }
    } catch (err) {
        if ((err as any)?.name === 'AbortError' || String(err).includes('aborted') || String(err).includes('BodyStreamBuffer was aborted')) {
            // Silently ignore intentional abort of previous preview stream
            return;
        }
        console.error("Error during RAM preview:", err);
        engineSync.setState('error', {
            errorMessage: (err as Error).message || String(err),
            nodeId,
            nodeName
        });
        if (requestVersion === previewRequestVersion) {
            activePreviewAutoplay = false;
            runtimeLog(`Preview failed for node ${nodeId}: ${(err as Error).message || String(err)}`, 'error');
        }
        if (requestVersion === previewRequestVersion) throw err;
    } finally {
        if (activePreviewNodeIdInFlight === nodeId && requestVersion === previewRequestVersion) {
            activePreviewNodeIdInFlight = null;
        }
    }
}

async function distributeWorkspaceManifest(graph: LGraph, manifest: any): Promise<void> {
    if (!manifest || typeof manifest !== 'object') return;
    activeWorkspaceManifest = manifest;
    (window as any).activeWorkspaceManifest = manifest;
    const nodesMap = manifest.nodes || {};
    const graphNodes = (((graph as any)._nodes || []) as any[]);
    const pendingLoads: Promise<any>[] = [];

    for (const gNode of graphNodes) {
        if (!gNode) continue;
        const manifestEntry = nodesMap[String(gNode.id)];
        if (!manifestEntry) {
            if (gNode.manifestEvents && gNode.manifestEvents.length > 0) {
                gNode.manifestEvents = [];
                gNode.setDirtyCanvas?.(true, true);
            }
            continue;
        }
        if (manifestEntry) {
            const stemUrlChanged = gNode.manifestStemUrl !== manifestEntry.audio_url;
            gNode.manifestStemUrl = manifestEntry.audio_url;
            gNode.manifestEvents = manifestEntry.events || [];
            gNode.manifestStemDuration = manifestEntry.duration_seconds;

            // Sync resolved sample/pool filepath to node (skip overwriting pooled or multi-slot nodes that already have a primary filepath)
            const hasMultiSlots = Array.isArray(gNode.properties?.slots) && gNode.properties.slots.length > 1;
            const isPooledOrSlotted = Boolean(
                manifestEntry.is_pool ||
                manifestEntry.is_dynamic_pool ||
                hasMultiSlots ||
                gNode.properties?.asset_modifier_id != null
            );
            const isDynamicPoolWithPath = Boolean(
                isPooledOrSlotted &&
                gNode.properties &&
                typeof gNode.properties.filepath === 'string' &&
                gNode.properties.filepath.trim().length > 0
            );
            if (hasMultiSlots && typeof gNode.preloadAllSlotBuffers === 'function') {
                pendingLoads.push(gNode.preloadAllSlotBuffers().catch(() => { }));
            }
            if (Array.isArray(manifestEntry.pool_filepaths)) {
                for (const poolFp of manifestEntry.pool_filepaths) {
                    if (typeof poolFp === 'string' && poolFp.trim().length > 0) {
                        pendingLoads.push(fetchAudioBuffer(poolFp).catch(() => { }));
                    }
                }
            }
            if (manifestEntry.filepath && gNode.properties && !isDynamicPoolWithPath && !hasMultiSlots) {
                const currentPath = String(gNode.properties.filepath || '');
                if (currentPath !== manifestEntry.filepath || !gNode.audioBuffer) {
                    gNode.properties.filepath = manifestEntry.filepath;
                    gNode.loadedFilepath = manifestEntry.filepath;
                    gNode.syncActiveSlotFromProperties?.();
                    delete gNode.manifestStemBuffer;
                    pendingLoads.push(
                        fetchAudioBuffer(manifestEntry.filepath).then(buf => {
                            if (buf) {
                                gNode.audioBuffer = buf;
                                if (buf.duration) {
                                    gNode.properties.duration_seconds = buf.duration;
                                }
                                gNode.setDirtyCanvas?.(true, true);
                            }
                        }).catch(() => { })
                    );
                }
            }

            // Sample duration metadata inheritance
            if (manifestEntry.duration_seconds && gNode.properties && !gNode.properties.duration_seconds) {
                gNode.properties.duration_seconds = manifestEntry.duration_seconds;
            }

            // Fetch intermediate stem buffers for visible nodes to populate high-fidelity DSP waveforms
            if (manifestEntry.audio_url && manifestEntry.node_type !== 'sample') {
                if (gNode.id === activeRamPreviewNodeId) {
                    const fullBuf = globalAudioScheduler.getFullAudioBuffer();
                    if (fullBuf) {
                        gNode.manifestStemBuffer = fullBuf;
                        gNode._lastRenderedBuffer = fullBuf;
                        gNode._lastRenderedGain = getNodeGainMultiplier(gNode);
                    }
                } else {
                    const shouldFetchStem = (gNode.id === activeParamNodeId || (Boolean(gNode.isVisualizationActive) && !gNode.flags?.collapsed));
                    if (shouldFetchStem && (!gNode.manifestStemBuffer || stemUrlChanged)) {
                        pendingLoads.push(
                            fetchAudioBuffer(manifestEntry.audio_url).then(buf => {
                                if (buf && gNode.id !== activeRamPreviewNodeId) {
                                    gNode.manifestStemBuffer = buf;
                                    gNode._lastRenderedBuffer = buf;
                                    gNode._lastRenderedGain = getNodeGainMultiplier(gNode);
                                    gNode.setDirtyCanvas?.(true, true);
                                }
                            }).catch(() => { })
                        );
                    }
                }
            }
            gNode.setDirtyCanvas?.(true, true);
        }
    }

    if (pendingLoads.length > 0) {
        await Promise.all(pendingLoads);
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
                const isAbort = (error as any)?.name === 'AbortError' || String(error).toLowerCase().includes('abort');
                const isLatest = requestVersion === previewRequestVersion && pendingPreviewRequest == null;
                if (isLatest && !isAbort) {
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
    refreshModifiers: boolean = false
): Promise<void> {
    if (dspInvalidateTimer) {
        clearTimeout(dspInvalidateTimer);
        dspInvalidateTimer = null;
    }
    const effectiveAutoplay = autoplay
        || (activePreviewAutoplay && !globalAudioScheduler.getIsPlaying() && activePreviewNodeIdInFlight === nodeId)
        || Boolean(pendingPreviewRequest?.autoplay && pendingPreviewRequest.nodeId === nodeId);

    if (pendingPreviewRequest) {
        runtimeLog(`Replaced queued preview for node ${pendingPreviewRequest.nodeId}`, 'warning');
    }
    if (currentPreviewAbortController) {
        currentPreviewAbortController.abort();
    }
    activePreviewAutoplay = effectiveAutoplay;
    pendingPreviewRequest = { nodeId, autoplay: effectiveAutoplay, globalPreview, refreshModifiers };
    previewRequestVersion++;
    runtimeLog(`Preview queued for node ${nodeId}`, 'common');
    setPreviewCalculatingState(globalAudioScheduler.getIsPlaying() || !effectiveAutoplay);
    if (!previewWorker) previewWorker = runPreviewQueue();
    return previewWorker;
}

export const NON_DSP_PROPERTIES = new Set([
    'render_enabled',
    'visualization_enabled',
    'visualization_type',
    'visual_width',
    'visual_height',
    'collapsed_step_modifiers',
    'collapsed',
    'collapsedDotMode',
    'pinned',
    'color',
    'bgcolor',
    'boxcolor',
    'icon',
    'shape',
    'pos',
    'size',
    'selected',
    'node_name',
    'name',
    'description',
    'tags',
    'favorite',
    'duration_seconds',
    'library_item_id',
    'key_proposal',
    'original_bpm_proposal',
    'key_is_local_override',
    'original_bpm_is_local_override'
]);

let dspInvalidateTimer: any = null;
const pendingInvalidatedNodes = new Set<number>();
let isPointerManipulatingParam = false;
let pendingGlobalParamInvalidation = false;

function flushPendingParameterUpdate() {
    if (isPointerManipulatingParam || isGraphEvaluating()) {
        if (pendingGlobalParamInvalidation || pendingInvalidatedNodes.size > 0) {
            scheduleSettledParameterUpdate(150);
        }
        return;
    }
    if (dspInvalidateTimer) {
        clearTimeout(dspInvalidateTimer);
        dspInvalidateTimer = null;
    }

    const idsToInvalidate = pendingGlobalParamInvalidation ? [] : Array.from(pendingInvalidatedNodes);
    const hadPending = pendingGlobalParamInvalidation || pendingInvalidatedNodes.size > 0;
    pendingInvalidatedNodes.clear();
    pendingGlobalParamInvalidation = false;

    if (!hadPending) return;

    const graph = (window as any).editorGraph as LGraph;
    const targetId = activeRamPreviewNodeId ?? (graph ? resolveMainPreviewNode(graph)?.id : undefined);

    fetch('/api/preview/invalidate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ node_ids: idsToInvalidate })
    }).catch(() => { }).finally(() => {
        // Parameter changes occur after the edit completes, rendering Stage 2 in the background
        // and swapping atomically via GaplessAudioScheduler.commitSession() without interrupting playback.
        if (targetId != null) {
            if (globalAudioScheduler.getIsPlaying()) {
                EngineSyncManager.getInstance().setState('hot_swapping');
            }
            void previewNode(targetId, false, false, false);
        }
    });
}

function scheduleSettledParameterUpdate(delayMs = 300) {
    if (dspInvalidateTimer) {
        clearTimeout(dspInvalidateTimer);
    }
    dspInvalidateTimer = setTimeout(() => {
        dspInvalidateTimer = null;
        flushPendingParameterUpdate();
    }, delayMs);
}

window.addEventListener('pointerdown', () => {
    isPointerManipulatingParam = true;
}, { passive: true, capture: true });

const handlePointerFinish = () => {
    if (!isPointerManipulatingParam) return;
    isPointerManipulatingParam = false;
    if (pendingGlobalParamInvalidation || pendingInvalidatedNodes.size > 0) {
        scheduleSettledParameterUpdate(150);
    }
};
window.addEventListener('pointerup', handlePointerFinish, { passive: true, capture: true });
window.addEventListener('pointercancel', handlePointerFinish, { passive: true, capture: true });

window.addEventListener('node-property-changed', (e: any) => {
    if (isGraphEvaluating()) return;
    const changedNodeId = e.detail?.nodeId;
    const propertyKey = e.detail?.key;
    if (changedNodeId == null) return;

    if (propertyKey && NON_DSP_PROPERTIES.has(propertyKey)) {
        // UI visual adjustments do not alter audio DSP; avoid invalidating preview cache or triggering re-renders
        return;
    }

    const graph = (window as any).editorGraph as LGraph;
    if (graph) {
        markNodeAndAncestorsInvalidated(graph, changedNodeId);
    }

    EngineSyncManager.getInstance().setState('dirty_pending');
    pendingInvalidatedNodes.add(changedNodeId);

    if (propertyKey === 'active_slot') {
        isPointerManipulatingParam = false;
        scheduleSettledParameterUpdate(50);
    } else if (!isPointerManipulatingParam) {
        scheduleSettledParameterUpdate(300);
    }
});

window.addEventListener('global-parameters-changed', () => {
    if (isGraphEvaluating()) return;
    const graph = (window as any).editorGraph as LGraph;
    if (graph) {
        for (const node of ((graph as any)._nodes || [])) {
            if (node) {
                (node as any).isInvalidated = true;
                (node as any).setDirtyCanvas?.(true, true);
            }
        }
    }

    EngineSyncManager.getInstance().setState('dirty_pending');
    pendingGlobalParamInvalidation = true;

    if (!isPointerManipulatingParam) {
        scheduleSettledParameterUpdate(300);
    }
});
