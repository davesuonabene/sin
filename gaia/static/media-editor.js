(function initializeMediaEditor() {
    const MAX_WAVEFORM_ZOOM = 512;
    const ZOOM_BUTTON_FACTOR = 1.25;
    const DETAIL_ZOOM_THRESHOLD = 2;
    const VIEW_DRAG_THRESHOLD = 3;
    const VIEW_EDGE_SIZE = 7;
    const BOUNDARY_AUDITION_SECONDS = 0.12;
    const BOUNDARY_AUDITION_PREROLL_SECONDS = 0.04;
    const BOUNDARY_AUDITION_INTERVAL_MS = 125;
    const MIN_GAIN_DB = -60;
    const MAX_PRE_GAIN_DB = 48;
    const MAX_VOLUME = 1;

    const state = {
        selectedEntry: null,
        playingEntry: null,
        externalAudio: null,
        session: null,
        editor: null,
        rootId: null,
        currentTargetId: null,
        currentTarget: null,
        layers: new Map(),
        cuts: [],
        selectedCutId: null,
        loopCutId: null,
        mainRange: null,
        playheadTime: 0,
        draftRange: null,
        waveformZoom: 1,
        viewStartFrame: 0,
        dirty: false,
        opened: false,
        ownPlayback: null,
        soloLayerId: null,
        waveforms: new Map(),
        detailWaveforms: new Map(),
        waveformToken: 0,
        detailWaveformToken: 0,
        detailWaveformTimer: null,
        detailWaveformController: null,
        animationFrame: null,
        playbackRequestId: 0,
        playbackLoadingRequestId: null,
        boundaryAuditionTimer: null,
        boundaryAuditionPending: null,
        lastBoundaryAuditionAt: -Infinity,
        pendingSwitch: null,
        pendingOutputConflict: null,
        selectedLayerId: null,
        editingCutLabelId: null,
        mixerValueTimer: null,
        gainDrag: null,
        viewDrag: null,
        hoverRangeHandle: null,
        renderScope: 'main',
        sessionRequestController: null,
        sessionRequestId: 0,
        editRevision: 0,
        renderBusy: false,
        projectSaveTimer: null,
        projectSavePromise: null,
        projectSaveQueued: false,
        destinationAction: 'render',
    };

    const $ = id => document.getElementById(id);
    const drawer = $('media-editor-drawer');
    const editorTitle = $('media-editor-title');
    const editorDetail = $('media-editor-detail');
    const editorClose = $('media-editor-close');
    const editorSave = $('media-editor-save');
    const editorRender = $('media-editor-render');
    const editorRenderAll = $('media-editor-render-all');
    const editorAddCut = $('media-editor-add-cut');
    const editorZoomOut = $('media-editor-zoom-out');
    const editorZoomIn = $('media-editor-zoom-in');
    const editorZoomFit = $('media-editor-zoom-fit');
    const editorZoomLabel = $('media-editor-zoom-label');
    const editorNormalize = $('media-editor-normalize');
    const editorStatus = $('media-editor-status');
    const editorWaveform = $('media-editor-waveform');
    const editorWaveformMain = editorWaveform?.querySelector('.media-editor-waveform-main');
    const editorWaveformEmpty = $('media-editor-waveform-empty');
    const editorLayers = $('media-editor-layers');
    const editorMixerRail = $('media-editor-mixer-rail');
    const editorCuts = $('media-editor-cuts');
    const targetButton = $('media-target-button');
    const targetLabel = $('media-target-label');
    const targetMenu = $('media-target-menu');
    const transportPlay = $('media-transport-play');
    const transportStop = $('media-transport-stop');
    const transportTime = $('media-transport-time');
    const transportSeek = $('media-transport-seek');
    const editorView = $('media-editor-view');
    const editorViewWindow = $('media-editor-view-window');
    const editorToggle = $('media-editor-toggle');
    const destinationDialog = $('media-destination-dialog');
    const destinationForm = $('media-destination-form');
    const destinationEyebrow = $('media-destination-eyebrow');
    const destinationTitle = $('media-destination-title');
    const destinationFormat = $('media-destination-format');
    const destinationFormatField = $('media-destination-format-field');
    const destinationProjectChoice = $('media-project-choice');
    const destinationOverrideChoice = $('media-override-choice');
    const existingProjectChoice = $('media-existing-project-choice');
    const existingProjectFields = $('media-existing-project-fields');
    const projectExistingSelect = $('media-existing-project-select');
    const destinationSubmit = $('media-destination-submit');
    const destinationClose = $('media-destination-close');
    const destinationCancel = $('media-destination-cancel');
    const destinationResult = $('media-destination-result');
    const projectFields = $('media-project-fields');
    const projectName = $('media-project-name');
    const projectVault = $('media-project-vault');
    const projectMove = $('media-project-move');
    const switchDialog = $('media-switch-dialog');
    const switchSummary = $('media-switch-summary');
    const switchClose = $('media-switch-close');
    const switchStay = $('media-switch-stay');
    const switchConfirm = $('media-switch-confirm');
    const renderConflictDialog = $('media-render-conflict-dialog');
    const renderConflictSummary = $('media-render-conflict-summary');
    const renderConflictClose = $('media-render-conflict-close');
    const renderConflictCancel = $('media-render-conflict-cancel');
    const renderConflictOverride = $('media-render-conflict-override');
    const renderConflictNewVersion = $('media-render-conflict-new-version');

    if (!drawer || !targetButton) return;

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>'"]/g, character => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
        })[character]);
    }

    function formatTime(seconds) {
        const value = Math.max(0, Number(seconds) || 0);
        const minutes = Math.floor(value / 60);
        const remainder = Math.floor(value % 60);
        return `${minutes}:${String(remainder).padStart(2, '0')}`;
    }

    function formatWaveformTime(seconds) {
        const value = Math.max(0, Number(seconds) || 0);
        if (value < 1) return `${Math.round(value * 1000)} ms`;
        if (value < 10) return `${value.toFixed(2)} s`;
        if (value < 60) return `${value.toFixed(1)} s`;
        return `${formatTime(value)}.${String(Math.floor((value % 1) * 10))}`;
    }

    function setStatus(message, isError = false) {
        editorStatus.textContent = message || '';
        editorStatus.style.color = isError ? 'var(--danger)' : '';
    }

    function rootIdForEntry(entry) {
        if (!entry) return null;
        if (entry.kind === 'content') return Number(entry.collection?.id) || null;
        if (entry.kind === 'reference') return Number(entry.collection?.id) || Number(entry.item?.id) || null;
        return Number(entry.item?.id) || null;
    }

    function activeProjectId() {
        return state.session?.root_type === 'project' ? Number(state.rootId) || null : null;
    }

    function targetIdForEntry(entry) {
        if (!entry) return null;
        if (entry.kind === 'reference') {
            const itemId = entry.item?.id || entry.reference?.to_item_id;
            if (itemId) {
                return entry.item?.type === 'multitrack' ? `root:${itemId}` : `item:${itemId}`;
            }
            return null;
        }
        if (entry.kind === 'content' && entry.content?.child_id) {
            return entry.item?.type === 'multitrack' ? `root:${entry.content.child_id}` : `item:${entry.content.child_id}`;
        }
        if (entry.kind === 'asset' && entry.item?.type === 'multitrack') return `root:${entry.item.id}`;
        if (entry.kind === 'asset' && entry.item?.id && ['audio', 'track', 'sample'].includes(entry.item?.type)) return `item:${entry.item.id}`;
        return null;
    }

    function sourceLabel(entry) {
        return entry?.title || entry?.item?.title || entry?.content?.title || 'Media';
    }

    function dispatchTransportCommand(command, value = null) {
        window.dispatchEvent(new CustomEvent('gaia:transport-command', { detail: { command, value } }));
    }

    function currentDuration() {
        return Number(state.editor?.duration_seconds) || 0;
    }

    function currentTime() {
        const playback = state.ownPlayback;
        if (!playback) return state.externalAudio ? Number(state.externalAudio.currentTime) || 0 : state.playheadTime;
        if (playback.kind === 'audio') return Number(playback.audio.currentTime) || 0;
        const audio = playback.audios?.[0];
        return Math.max(0, Math.min(currentDuration(), Number(audio?.currentTime) || state.playheadTime));
    }

    function setTransportPlaying(playing) {
        transportPlay.textContent = playing ? '❚❚' : '▶';
        transportPlay.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    }

    function playbackIsRunning() {
        const playback = state.ownPlayback;
        if (playback?.kind === 'multi') return playback.audios.some(audio => !audio.paused && !audio.ended);
        const audio = playback?.kind === 'audio' ? playback.audio : state.externalAudio;
        return Boolean(audio && !audio.paused && !audio.ended);
    }

    function updateRenderButtons() {
        const enabled = Boolean(state.editor && activeLayers().length) && !state.renderBusy;
        const projectId = activeProjectId();
        editorSave.textContent = state.projectSavePromise
            ? 'Saving…'
            : projectId && !state.dirty ? 'Saved' : 'Save progress';
        editorSave.disabled = !state.editor || state.renderBusy || Boolean(projectId && !state.dirty && !state.projectSavePromise);
        editorRender.disabled = !enabled;
        editorRenderAll.disabled = !enabled || state.cuts.length === 0;
    }

    function renderEditorView() {
        const duration = currentDuration();
        let startSeconds = 0;
        let endSeconds = duration;
        let left = 0;
        let width = 1;
        if (state.editor && duration) {
            const windowState = waveformWindow();
            const sampleRate = Number(state.editor.sample_rate) || 44100;
            startSeconds = windowState.startFrame / sampleRate;
            endSeconds = windowState.endFrame / sampleRate;
            left = windowState.startFrame / windowState.totalFrames;
            width = windowState.visibleFrames / windowState.totalFrames;
        }
        left = Math.max(0, Math.min(1, left));
        width = Math.max(0, Math.min(1, width));
        const trackWidth = editorView.clientWidth;
        if (trackWidth > 0) {
            const windowWidth = Math.min(trackWidth, Math.max(14, width * trackWidth));
            const logicalTravel = Math.max(0, 1 - width);
            const visualTravel = Math.max(0, trackWidth - windowWidth);
            const windowLeft = logicalTravel > 0 ? (left / logicalTravel) * visualTravel : 0;
            editorViewWindow.style.left = `${windowLeft}px`;
            editorViewWindow.style.width = `${windowWidth}px`;
        } else {
            editorViewWindow.style.left = `${left * 100}%`;
            editorViewWindow.style.width = `${Math.max(0.02, width) * 100}%`;
        }
        editorView.classList.toggle('disabled', !state.editor || width >= 1);
        editorView.setAttribute('aria-valuenow', String(Math.round(left * 100)));
        editorView.setAttribute('aria-valuetext', `${formatWaveformTime(startSeconds)} to ${formatWaveformTime(endSeconds)}`);
        editorView.setAttribute('aria-label', `Waveform view ${formatWaveformTime(startSeconds)} to ${formatWaveformTime(endSeconds)}, width ${formatWaveformTime(Math.max(0, endSeconds - startSeconds))}`);
    }

    function layerPlaybackGain(layer, ignoreMute = false) {
        if (!layer || (layer.muted && !ignoreMute)) return 0;
        const preGain = Number.isFinite(Number(layer.pre_gain_linear))
            ? Number(layer.pre_gain_linear)
            : 10 ** ((Number(layer.pre_gain_db) || 0) / 20);
        const volume = Math.max(0, Math.min(MAX_VOLUME, Number(layer.volume ?? 1)));
        return preGain * volume;
    }

    function activeLayers() {
        // Persisted/render selection.  Solo is deliberately excluded here.
        return [...state.layers.values()].filter(layer => !layer.muted);
    }

    function playbackLayers() {
        // Keep one stable playback graph. Mute and solo are final gain-node
        // states, never reasons to remove/reload a media element.
        return [...state.layers.values()];
    }

    function playbackLayerGain(layer) {
        if (!layer) return 0;
        if (state.soloLayerId !== null) {
            return layer.item_id === state.soloLayerId ? layerPlaybackGain(layer, true) : 0;
        }
        return layerPlaybackGain(layer);
    }

    function activeLayerIds() {
        return activeLayers().map(layer => layer.item_id);
    }

    function defaultSelectedLayerId() {
        return activeLayers()[0]?.item_id ?? [...state.layers.keys()][0] ?? null;
    }

    function selectedLayer() {
        return state.layers.get(state.selectedLayerId) || [...state.layers.values()][0] || null;
    }

    function selectedCut() {
        return state.cuts.find(cut => cut.id === state.selectedCutId) || null;
    }

    function disableCutLoop(cutId) {
        if (!cutId || state.loopCutId !== cutId) return false;
        state.loopCutId = null;
        if (state.ownPlayback?.range?.loop && state.ownPlayback.range.cutId === cutId) clearOwnPlayback();
        return true;
    }

    function selectLayer(itemId) {
        const layer = state.layers.get(Number(itemId));
        if (!layer) return;
        disableCutLoop(state.selectedCutId);
        state.selectedLayerId = layer.item_id;
        state.selectedCutId = null;
        state.editingCutLabelId = null;
        [editorLayers, editorMixerRail].forEach(container => container?.querySelectorAll('[data-layer-id]').forEach(row => {
            row.classList.toggle('selected', Number(row.dataset.layerId) === state.selectedLayerId);
        }));
        renderCuts();
        editorNormalize.disabled = !state.editor;
        updateRenderButtons();
        drawWaveform();
    }

    function selectCut(cutId) {
        const cut = state.cuts.find(value => value.id === cutId);
        if (!cut) return;
        const previousCutId = state.selectedCutId;
        const wasSelected = state.selectedCutId === cutId;
        state.selectedCutId = wasSelected ? null : cutId;
        if (previousCutId !== state.selectedCutId) disableCutLoop(previousCutId);
        state.editingCutLabelId = null;
        if (!wasSelected) state.selectedLayerId = null;
        else state.selectedLayerId = defaultSelectedLayerId();
        editorLayers.querySelectorAll('[data-layer-id]').forEach(row => row.classList.toggle('selected', Number(row.dataset.layerId) === state.selectedLayerId));
        editorMixerRail?.querySelectorAll('[data-layer-id]').forEach(row => row.classList.toggle('selected', Number(row.dataset.layerId) === state.selectedLayerId));
        renderCuts();
        editorNormalize.disabled = !state.editor || !selectedLayer();
        updateRenderButtons();
        drawWaveform();
        renderTransport();
    }

    function showMixerValue(input) {
        if (!input) return;
        const mixer = input.closest('[data-layer-mixer]');
        if (!mixer) return;
        mixer.classList.add('is-adjusting');
        if (state.mixerValueTimer) clearTimeout(state.mixerValueTimer);
        state.mixerValueTimer = setTimeout(() => mixer.classList.remove('is-adjusting'), 900);
    }

    function normalizationGainDb(layer) {
        const waveform = state.waveforms.get(layer?.item_id);
        if (!waveform?.peaks?.length) return null;
        let peak = 0;
        waveform.peaks.forEach(values => {
            peak = Math.max(peak, Math.abs(Number(values[0]) || 0), Math.abs(Number(values[1]) || 0));
        });
        if (peak <= 0) return null;
        const volume = Number(layer.volume ?? 1);
        const volumeDb = volume > 0 ? 20 * Math.log10(volume) : 0;
        return Math.max(MIN_GAIN_DB, Math.min(MAX_PRE_GAIN_DB, -20 * Math.log10(peak) - volumeDb));
    }

    function formatGain(value) {
        const gain = Number(value) || 0;
        if (gain <= MIN_GAIN_DB) return '-∞';
        return `${gain > 0 ? '+' : ''}${gain.toFixed(1)} dB`;
    }

    function clampGain(value, maximum = MAX_PRE_GAIN_DB) {
        return Math.max(MIN_GAIN_DB, Math.min(maximum, Math.round((Number(value) || 0) * 2) / 2));
    }

    function gainDbToLinear(value) {
        return 10 ** (clampGain(value, MAX_PRE_GAIN_DB) / 20);
    }

    function clampVolume(value) {
        return Math.max(0, Math.min(MAX_VOLUME, Number.isFinite(Number(value)) ? Number(value) : 1));
    }

    function legacyGainDbToVolume(value) {
        const gainDb = clampGain(value, 10);
        return clampVolume(10 ** (gainDb / 20));
    }

    function formatVolume(value) {
        return clampVolume(value).toFixed(2);
    }

    function updateLayerParameter(itemId, key, value) {
        const layer = state.layers.get(Number(itemId));
        if (!layer) return;
        layer[key] = key === 'volume' ? clampVolume(value) : clampGain(value, MAX_PRE_GAIN_DB);
        if (key === 'pre_gain_db') layer.pre_gain_linear = gainDbToLinear(layer[key]);
        const row = editorMixerRail?.querySelector(`[data-layer-id="${layer.item_id}"]`);
        if (key === 'pre_gain_db') {
            const control = row?.querySelector('[data-layer-pre-gain]');
            if (control) {
                control.textContent = formatGain(layer[key]);
                control.setAttribute('aria-valuenow', String(layer[key]));
            }
        } else {
            const control = row?.querySelector('[data-layer-gain]');
            if (control) {
                control.value = String(layer[key]);
                control.style.setProperty('--volume-level', gainPercent(layer[key]));
            }
            const output = row?.querySelector('[data-layer-gain-value]');
            if (output) output.textContent = formatVolume(layer[key]);
        }
        updateLiveLayerGain(layer.item_id);
        markDirty();
        drawWaveform();
    }

    function normalizeSelectedLayer() {
        const layer = selectedLayer();
        if (!layer) {
            setStatus('Select a layer first.', true);
            return;
        }
        const value = normalizationGainDb(layer);
        if (value === null) {
            setStatus('Waveform is still loading.', true);
            return;
        }
        updateLayerParameter(layer.item_id, 'pre_gain_db', value);
    }

    function layerWaveformScale(layer) {
        if (!layer) return 1;
        // The waveform represents pre-gain only. Post-fader volume, mute and
        // solo must not change its geometry.
        return Number(layer.pre_gain_linear) || gainDbToLinear(layer.pre_gain_db);
    }

    function gainPercent(volume) {
        return `${clampVolume(volume) * 100}%`;
    }

    function updateLiveLayerGain(itemId) {
        const playback = state.ownPlayback;
        if (playback?.kind !== 'multi') return;
        const gain = playback.gains.get(itemId);
        const layer = state.layers.get(itemId);
        if (gain && layer) {
            // Keep gain changes on the audio thread and make the transition
            // deterministic.  In particular, a muted layer must end at the
            // exact zero value, never at a relative/accumulated volume.
            const now = playback.context.currentTime;
            gain.gain.cancelScheduledValues(now);
            gain.gain.setValueAtTime(playbackLayerGain(layer), now);
        }
    }

    function playbackAudios(playback) {
        if (!playback) return [];
        return playback.kind === 'audio' ? [playback.audio] : playback.audios;
    }

    function beginPlaybackOperation(playback) {
        if (!playback) return 0;
        playback.operationId = (playback.operationId || 0) + 1;
        return playback.operationId;
    }

    function ownsPlaybackOperation(playback, operationId) {
        return state.ownPlayback === playback && playback.operationId === operationId;
    }

    function setPlaybackPosition(playback, seconds) {
        const position = Math.max(0, Number(seconds) || 0);
        playbackAudios(playback).forEach(audio => {
            try {
                audio.currentTime = Math.min(position, Number(audio.duration) || position);
            } catch (_error) { /* metadata may not be ready yet */ }
        });
    }

    function schedulePlaybackRangeEnd(playback) {
        const range = playback?.range;
        if (!range || playback.loopRestarting || state.ownPlayback !== playback || !playbackIsRunning()) return;
        if (playback.rangeTimer) clearTimeout(playback.rangeTimer);
        const remaining = Math.max(0, range.end - currentTime());
        playback.rangeTimer = window.setTimeout(() => {
            playback.rangeTimer = null;
            if (state.ownPlayback !== playback || !playbackIsRunning()) return;
            if (!enforcePlaybackRange()) schedulePlaybackRangeEnd(playback);
        }, Math.max(8, remaining * 1000 - 8));
    }

    function restartLoopPlayback(playback) {
        const range = playback?.range;
        if (state.ownPlayback !== playback || !range?.loop || playback.loopRestarting) return;
        playback.loopRestarting = true;
        const operationId = beginPlaybackOperation(playback);
        if (playback.rangeTimer) clearTimeout(playback.rangeTimer);
        playback.rangeTimer = null;
        playbackAudios(playback).forEach(audio => audio.pause());
        setPlaybackPosition(playback, range.start);
        state.playheadTime = range.start;
        const resume = playback.kind === 'multi'
            ? playback.context.resume().then(() => {
                if (!ownsPlaybackOperation(playback, operationId)) return [];
                return Promise.all(playback.audios.map(audio => audio.play()));
            })
            : Promise.resolve().then(() => {
                if (!ownsPlaybackOperation(playback, operationId)) return;
                return playback.audio.play();
            });
        resume
            .then(() => {
                if (!ownsPlaybackOperation(playback, operationId) || !playback.range?.loop) return;
                playback.loopRestarting = false;
                schedulePlaybackRangeEnd(playback);
                renderTransport();
            })
            .catch(error => {
                if (!ownsPlaybackOperation(playback, operationId)) return;
                playback.loopRestarting = false;
                reportPlaybackError(error);
            });
        renderTransport();
    }

    function enforcePlaybackRange() {
        const playback = state.ownPlayback;
        const range = playback?.range;
        if (!range || !playbackIsRunning() || currentTime() < range.end) return false;
        if (range.loop) restartLoopPlayback(playback);
        else clearOwnPlayback(range.end);
        return true;
    }

    function requestPlaybackFrame() {
        if (state.animationFrame !== null) return;
        const schedule = window.requestAnimationFrame || (callback => window.setTimeout(callback, 33));
        state.animationFrame = schedule(() => {
            state.animationFrame = null;
            state.playheadTime = currentTime();
            const rangeHandled = enforcePlaybackRange();
            renderTransport();
            drawWaveform();
            if (!rangeHandled && playbackIsRunning()) requestPlaybackFrame();
        });
    }

    function renderTransport() {
        const playback = state.ownPlayback;
        const audio = playback?.kind === 'audio' ? playback.audio : state.externalAudio;
        const hasPlayback = Boolean(playback || audio || state.editor);
        const duration = currentDuration() || Number(audio?.duration) || 0;
        const time = currentTime();
        transportPlay.disabled = !hasPlayback;
        transportStop.disabled = !hasPlayback;
        transportSeek.disabled = !hasPlayback || duration <= 0;
        transportSeek.max = String(Math.max(0, duration));
        transportSeek.value = String(Math.max(0, Math.min(duration || 0, time)));
        transportSeek.style.setProperty('--seek-progress', `${duration > 0 ? Math.max(0, Math.min(100, (time / duration) * 100)) : 0}%`);
        transportTime.textContent = `${formatTime(time)} / ${formatTime(duration)}`;
        renderEditorView();
        const playing = playbackIsRunning();
        setTransportPlaying(playing);
        if (playing) requestPlaybackFrame();
    }

    function reportPlaybackError(error) {
        setStatus(error?.message || 'Playback could not start.', true);
        renderTransport();
    }

    function startAudioPlayback(audio, playback = null, operationId = null) {
        try {
            const promise = audio.play();
            if (promise?.catch) {
                promise.catch(error => {
                    const ownsAudio = state.ownPlayback?.kind === 'audio' && state.ownPlayback.audio === audio;
                    const isExternalAudio = state.externalAudio === audio;
                    if (!ownsAudio && !isExternalAudio) return;
                    const operationCurrent = !playback || ownsPlaybackOperation(playback, operationId);
                    if (ownsAudio && !operationCurrent) return;
                    if (ownsAudio) clearOwnPlayback();
                    reportPlaybackError(error);
                });
            }
        } catch (error) {
            const ownsAudio = state.ownPlayback?.kind === 'audio' && state.ownPlayback.audio === audio;
            const isExternalAudio = state.externalAudio === audio;
            if (!ownsAudio && !isExternalAudio) return;
            const operationCurrent = !playback || ownsPlaybackOperation(playback, operationId);
            if (ownsAudio && !operationCurrent) return;
            if (ownsAudio) clearOwnPlayback();
            reportPlaybackError(error);
        }
    }

    function clearOwnPlayback(position = null, invalidatePending = true) {
        const playback = state.ownPlayback;
        if (invalidatePending) {
            state.playbackRequestId += 1;
            state.playbackLoadingRequestId = null;
        }
        if (playback) state.playheadTime = Number.isFinite(position) ? position : currentTime();
        state.ownPlayback = null;
        if (!playback) return;
        // Invalidate any pending resume/seek/loop promise before detaching the
        // graph.  A promise from the old graph must never touch new playback.
        beginPlaybackOperation(playback);
        const wasLooping = Boolean(playback.range?.loop);
        if (playback.rangeTimer) clearTimeout(playback.rangeTimer);
        if (playback.kind === 'audio') {
            playback.audio.pause();
            playback.audio.removeAttribute('src');
            playback.audio.load();
        } else {
            playback.audios.forEach(audio => {
                audio.pause();
                audio.removeAttribute('src');
                audio.load();
            });
            playback.sources.forEach(source => source.disconnect());
            playback.gains.forEach(gain => gain.disconnect());
        }
        if (playback.context) playback.context.close().catch(() => {});
        if (wasLooping) renderCuts();
        renderTransport();
    }

    function bindExternalAudio(audio, entry) {
        if (state.ownPlayback) clearOwnPlayback();
        state.externalAudio = audio || null;
        state.playingEntry = entry || null;
        if (entry) {
            targetLabel.textContent = sourceLabel(entry);
            targetButton.disabled = false;
            editorToggle.disabled = false;
        }
        if (audio) state.playheadTime = Number(audio.currentTime) || 0;
        if (audio) {
            ['timeupdate', 'loadedmetadata', 'play', 'pause', 'ended'].forEach(eventName => {
                audio.addEventListener(eventName, renderTransport);
            });
        }
        renderTransport();
    }

    async function playActiveLayers(startOffset = currentTime(), options = {}) {
        if (!state.editor) return;
        const requestId = ++state.playbackRequestId;
        state.playbackLoadingRequestId = requestId;
        clearOwnPlayback(null, false);
        state.externalAudio = null;
        const active = playbackLayers();
        if (!active.length) {
            if (state.playbackLoadingRequestId === requestId) state.playbackLoadingRequestId = null;
            setStatus('Activate at least one layer.', true);
            return;
        }
        const offset = Math.max(0, Math.min(Number(startOffset) || 0, currentDuration()));
        const requestedEnd = Number(options.endOffset);
        const range = Number.isFinite(requestedEnd) && requestedEnd > offset
            ? {
                start: offset,
                end: Math.min(requestedEnd, currentDuration()),
                loop: Boolean(options.loop),
                cutId: options.cutId || null,
            }
            : null;
        if (!window.AudioContext && !window.webkitAudioContext) {
            if (state.playbackLoadingRequestId === requestId) state.playbackLoadingRequestId = null;
            setStatus('This browser cannot mix layers.', true);
            return;
        }
        setStatus('Loading layers…');
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        const context = new AudioContextClass();
        let audios = [];
        let sources = [];
        let gains = new Map();
        let playback = null;
        let playbackOperationId = null;
        try {
            audios = await Promise.all(active.map(layer => new Promise((resolve, reject) => {
                const audio = new Audio();
                audio.preload = 'metadata';
                const cleanup = () => {
                    audio.removeEventListener('loadedmetadata', ready);
                    audio.removeEventListener('error', failed);
                };
                const ready = () => {
                    cleanup();
                    resolve(audio);
                };
                const failed = () => {
                    cleanup();
                    reject(new Error(`Could not load ${layer.label}`));
                };
                audio.addEventListener('loadedmetadata', ready, { once: true });
                audio.addEventListener('error', failed, { once: true });
                audio.src = layer.stream_url;
                audio.load();
            })));
            if (requestId !== state.playbackRequestId) {
                if (state.playbackLoadingRequestId === requestId) state.playbackLoadingRequestId = null;
                audios.forEach(audio => {
                    audio.removeAttribute('src');
                    audio.load();
                });
                context.close().catch(() => {});
                return;
            }
            sources = [];
            gains = new Map();
            audios.forEach((audio, index) => {
                const source = context.createMediaElementSource(audio);
                const gain = context.createGain();
                const layer = state.layers.get(active[index].item_id);
                gain.gain.value = playbackLayerGain(layer);
                source.connect(gain).connect(context.destination);
                audio.currentTime = Math.min(offset, Number(audio.duration) || offset);
                sources.push(source);
                gains.set(active[index].item_id, gain);
            });
            playback = { kind: 'multi', context, audios, sources, gains, range, operationId: 0 };
            state.ownPlayback = playback;
            if (state.playbackLoadingRequestId === requestId) state.playbackLoadingRequestId = null;
            if (range?.loop) renderCuts();
            const finish = () => {
                if (state.ownPlayback !== playback) return;
                // A scheduled loop restart can leave an old `ended` event in
                // the queue.  Ignore that stale event once playback has
                // already returned to the loop start.
                if (range?.loop) {
                    if (currentTime() >= range.end - 0.015) restartLoopPlayback(playback);
                    return;
                }
                clearOwnPlayback(range?.end ?? currentDuration());
            };
            audios.forEach(audio => audio.addEventListener('ended', finish, { once: true }));
            playbackOperationId = playback.operationId;
            await context.resume();
            if (!ownsPlaybackOperation(playback, playbackOperationId)) return;
            await Promise.all(audios.map(audio => audio.play()));
            if (requestId !== state.playbackRequestId || state.ownPlayback !== playback) {
                if (state.playbackLoadingRequestId === requestId) state.playbackLoadingRequestId = null;
                audios.forEach(audio => {
                    audio.pause();
                    audio.removeAttribute('src');
                    audio.load();
                });
                sources.forEach(source => source.disconnect());
                gains.forEach(gain => gain.disconnect());
                context.close().catch(() => {});
                return;
            }
            // The graph is still owned by the editor, but a newer seek/pause
            // superseded this start.  Leave the graph intact for that newer
            // operation; tearing it down here reintroduces the seek race.
            if (!ownsPlaybackOperation(playback, playbackOperationId)) return;
            if (!options.audition) setStatus('Playing active layers.');
            schedulePlaybackRangeEnd(playback);
            renderTransport();
        } catch (error) {
            if (state.playbackLoadingRequestId === requestId) state.playbackLoadingRequestId = null;
            if (requestId !== state.playbackRequestId || (playback && state.ownPlayback !== playback)) {
                audios.forEach(audio => {
                    audio.pause();
                    audio.removeAttribute('src');
                    audio.load();
                });
                sources.forEach(source => source.disconnect());
                gains.forEach(gain => gain.disconnect());
                context.close().catch(() => {});
                return;
            }
            if (playback && !ownsPlaybackOperation(playback, playbackOperationId)) return;
            if (state.ownPlayback?.context === context) clearOwnPlayback();
            else context.close().catch(() => {});
            setStatus(error.message || 'Layer playback failed.', true);
        }
    }

    function togglePlayback() {
        if (state.ownPlayback?.kind === 'audio') {
            const playback = state.ownPlayback;
            if (playback.audio.paused) {
                const operationId = beginPlaybackOperation(playback);
                startAudioPlayback(playback.audio, playback, operationId);
                schedulePlaybackRangeEnd(playback);
            } else {
                beginPlaybackOperation(playback);
                playback.audio.pause();
                if (playback.rangeTimer) clearTimeout(playback.rangeTimer);
                playback.rangeTimer = null;
            }
            renderTransport();
            return;
        }
        if (state.ownPlayback?.kind === 'multi') {
            const playback = state.ownPlayback;
            if (playbackIsRunning()) {
                beginPlaybackOperation(playback);
                playback.audios.forEach(audio => audio.pause());
                playback.context.suspend().catch(error => {
                    if (state.ownPlayback === playback) reportPlaybackError(error);
                });
                if (playback.rangeTimer) clearTimeout(playback.rangeTimer);
                playback.rangeTimer = null;
            } else {
                const operationId = beginPlaybackOperation(playback);
                playback.context.resume()
                    .then(() => {
                        if (!ownsPlaybackOperation(playback, operationId)) return [];
                        return Promise.all(playback.audios.map(audio => audio.play()));
                    })
                    .then(() => {
                        if (!ownsPlaybackOperation(playback, operationId)) return;
                        schedulePlaybackRangeEnd(playback);
                        renderTransport();
                    })
                    .catch(error => {
                        if (!ownsPlaybackOperation(playback, operationId)) return;
                        playback.audios.forEach(audio => audio.pause());
                        reportPlaybackError(error);
                    });
            }
            renderTransport();
            return;
        }
        if (state.externalAudio) {
            if (state.externalAudio.paused) startAudioPlayback(state.externalAudio);
            else state.externalAudio.pause();
            renderTransport();
            return;
        }
        const loopCut = state.loopCutId === state.selectedCutId ? selectedCut() : null;
        if (loopCut) playCut(loopCut);
        else playActiveLayers(currentTime()).catch(reportPlaybackError);
    }

    function seek(seconds) {
        const requested = Math.max(0, Number(seconds) || 0);
        const playback = state.ownPlayback;
        const range = playback?.range;
        const value = range?.loop
            ? Math.max(range.start, Math.min(requested, Math.max(range.start, range.end - 0.001)))
            : requested;
        state.playheadTime = Math.min(value, currentDuration() || value);
        if (playback?.kind === 'audio') {
            playback.requestedOffset = value;
            try { playback.audio.currentTime = value; } catch (_error) { /* metadata is not ready yet */ }
        }
        else if (state.externalAudio) state.externalAudio.currentTime = value;
        else if (playback?.kind === 'multi') {
            // Seeking must not rebuild the mixer.  Recreating every media
            // element/context here made a muted layer turn a harmless seek
            // into a race between teardown, metadata loading and play().
            // Move all clocks together and preserve the existing final gain
            // values (including exact-zero mutes).
            const wasPlaying = playbackIsRunning();
            const operationId = beginPlaybackOperation(playback);
            playback.audios.forEach(audio => audio.pause());
            setPlaybackPosition(playback, value);
            if (wasPlaying) {
                playback.context.resume()
                    .then(() => {
                        if (!ownsPlaybackOperation(playback, operationId)) return [];
                        return Promise.all(playback.audios.map(audio => audio.play()));
                    })
                    .then(() => {
                        if (!ownsPlaybackOperation(playback, operationId)) return;
                        schedulePlaybackRangeEnd(playback);
                        renderTransport();
                    })
                    .catch(error => {
                        if (!ownsPlaybackOperation(playback, operationId)) return;
                        playback.audios.forEach(audio => audio.pause());
                        reportPlaybackError(error);
                    });
            }
        } else if (state.playbackLoadingRequestId !== null) {
            // A multitrack request can be between metadata loading and graph
            // creation. Cancel that stale request and replay from the exact
            // position chosen by the UI once the new request is ready.
            state.playbackRequestId += 1;
            state.playbackLoadingRequestId = null;
            playActiveLayers(value).catch(reportPlaybackError);
        }
        renderTransport();
        drawWaveform();
    }

    function targetOptionMarkup(target) {
        const active = target.id === state.currentTargetId;
        const type = target.type === 'multitrack' ? 'multitrack' : target.type;
        return `<button class="media-target-option sin-menu-item${active ? ' active' : ''}" type="button" role="option" aria-selected="${active}" data-target-id="${escapeHtml(target.id)}">
            <span>${escapeHtml(target.label)}</span>
            <span class="media-target-option-type">${escapeHtml(type)}</span>
        </button>`;
    }

    function renderTargetMenu() {
        if (!state.session) {
            targetMenu.classList.add('hidden');
            return;
        }
        targetMenu.innerHTML = `<div class="media-target-session">${escapeHtml(state.session.title || 'Media session')}</div>${(state.session.targets || []).map(targetOptionMarkup).join('')}`;
    }

    function renderLayers() {
        const layers = [...state.layers.values()];
        const layerHeight = 100 / Math.max(1, layers.length);
        editorLayers.innerHTML = layers.map((layer, index) => {
            const solo = state.soloLayerId === layer.item_id;
            const active = !layer.muted || solo;
            const selected = state.selectedLayerId === layer.item_id;
            return `<div class="media-editor-layer${active ? ' active' : ''}${selected ? ' selected' : ''}${layer.muted ? ' muted' : ''}${solo ? ' solo' : ''}" data-layer-id="${layer.item_id}" style="top:${index * layerHeight}%;height:${layerHeight}%">
                <div class="media-editor-layer-info">
                    <div class="media-editor-layer-name" title="${escapeHtml(layer.filename || layer.label)}"><span>${escapeHtml(layer.label)}</span></div>
                    <span class="media-editor-layer-meta">${escapeHtml(layer.type || 'audio')} · ${formatTime(layer.duration_seconds)}</span>
                </div>
            </div>`;
        }).join('');
        editorMixerRail.innerHTML = layers.map((layer, index) => {
            const solo = state.soloLayerId === layer.item_id;
            const selected = state.selectedLayerId === layer.item_id;
            const preGain = Number(layer.pre_gain_db || 0);
            const volume = clampVolume(layer.volume);
            return `<div class="media-editor-layer-mixer${selected ? ' selected' : ''}${solo ? ' is-solo' : ''}" data-layer-id="${layer.item_id}" data-layer-mixer title="Select layer" style="top:${index * layerHeight}%;height:${layerHeight}%">
                <div class="media-editor-layer-mixer-stack">
                    <div class="media-editor-layer-parameter media-editor-layer-pre-gain">
                        <span class="media-editor-layer-mixer-label">gain</span>
                        <output class="media-editor-layer-pre-gain-value" data-layer-parameter data-layer-pre-gain role="slider" tabindex="0" aria-valuemin="${MIN_GAIN_DB}" aria-valuemax="${MAX_PRE_GAIN_DB}" aria-valuenow="${preGain}" aria-label="Pre-gain for ${escapeHtml(layer.label)}">${formatGain(preGain)}</output>
                    </div>
                    <div class="media-editor-layer-mixer-gap" data-layer-parameter aria-hidden="true"></div>
                    <div class="media-editor-layer-mixer-actions">
                        <button class="media-editor-layer-solo" type="button" data-layer-solo data-layer-id="${layer.item_id}" aria-pressed="${solo}" aria-label="Solo ${escapeHtml(layer.label)}" title="Solo layer">S</button>
                        <label class="media-editor-layer-mute" title="Mute layer"><input type="checkbox" data-layer-parameter data-layer-muted data-layer-id="${layer.item_id}" aria-label="Mute ${escapeHtml(layer.label)}" ${layer.muted ? 'checked' : ''}><span>M</span></label>
                    </div>
                </div>
                <div class="media-editor-layer-volume-control">
                    <output class="media-editor-layer-value media-editor-layer-volume-value" data-layer-gain-value>${formatVolume(volume)}</output>
                    <input class="media-editor-layer-volume" type="range" data-layer-parameter data-layer-gain min="0" max="${MAX_VOLUME}" step="0.01" value="${volume}" style="--volume-level:${gainPercent(volume)}" aria-label="Volume multiplier for ${escapeHtml(layer.label)}">
                </div>
            </div>`;
        }).join('');
    }

    function renderCuts() {
        const sampleRate = Number(state.editor?.sample_rate) || 44100;
        editorCuts.innerHTML = state.cuts.map((cut, index) => {
            const selected = state.selectedCutId === cut.id;
            const label = cut.label || `Cut ${index + 1}`;
            const looping = state.loopCutId === cut.id;
            return `
            <div class="media-editor-cut${selected ? ' selected' : ''}" data-cut-id="${escapeHtml(cut.id)}">
                ${selected && state.editingCutLabelId === cut.id
                    ? `<input type="text" maxlength="80" data-cut-field="label" value="${escapeHtml(label)}" aria-label="Cut name">`
                    : `<span class="media-editor-cut-label" data-cut-label title="Select the row, then click to edit ${escapeHtml(label)}">${escapeHtml(label)}</span>`}
                <input type="number" min="0" step="0.001" data-cut-field="start" value="${(cut.start_frame / sampleRate).toFixed(3)}" aria-label="Cut start"${selected ? '' : ' readonly'}>
                <input type="number" min="0" step="0.001" data-cut-field="end" value="${(cut.end_frame / sampleRate).toFixed(3)}" aria-label="Cut end"${selected ? '' : ' readonly'}>
                <button type="button" data-cut-play aria-label="Play ${escapeHtml(cut.label || `Cut ${index + 1}`)}" title="Play from cut start">▶</button>
                <button type="button" class="media-editor-cut-loop${looping ? ' is-active' : ''}" data-cut-loop aria-pressed="${looping}" aria-label="${looping ? 'Disable loop' : 'Enable loop'} for ${escapeHtml(cut.label || `Cut ${index + 1}`)}" title="${looping ? 'Disable loop' : 'Enable loop between cut start and end'}">↻</button>
                <button type="button" data-cut-export aria-label="Export ${escapeHtml(cut.label || `Cut ${index + 1}`)}" title="Export this cut">Export</button>
                <button type="button" data-cut-remove>Remove</button>
            </div>`;
        }).join('');
    }

    function loopPlaybackOptions(cut) {
        const sampleRate = Number(state.editor?.sample_rate) || 44100;
        return {
            start: Math.max(0, Number(cut.start_frame) || 0) / sampleRate,
            endOffset: Math.max(0, Number(cut.end_frame) || 0) / sampleRate,
            loop: true,
            cutId: cut.id,
        };
    }

    function playCut(cut) {
        const loopOptions = loopPlaybackOptions(cut);
        const start = loopOptions.start;
        const options = state.loopCutId === cut.id ? loopOptions : {};
        playActiveLayers(start, options).catch(reportPlaybackError);
    }

    function toggleCutLoop(cut) {
        if (state.selectedCutId !== cut.id) selectCut(cut.id);
        if (state.loopCutId === cut.id) disableCutLoop(cut.id);
        else {
            state.loopCutId = cut.id;
            const playback = state.ownPlayback;
            if (playback) {
                const options = loopPlaybackOptions(cut);
                const wasPlaying = playbackIsRunning();
                const position = Math.max(options.start, Math.min(currentTime(), Math.max(options.start, options.endOffset - 0.001)));
                clearOwnPlayback(position);
                state.playheadTime = position;
                if (wasPlaying) playActiveLayers(position, options).catch(reportPlaybackError);
            }
        }
        renderCuts();
        drawWaveform();
        renderTransport();
    }

    function syncLoopPlayback(cut) {
        const playback = state.ownPlayback;
        if (!playback?.range?.loop || playback.range.cutId !== cut.id) return;
        const sampleRate = Number(state.editor?.sample_rate) || 44100;
        playback.range.start = Math.max(0, Number(cut.start_frame) || 0) / sampleRate;
        playback.range.end = Math.max(playback.range.start, Number(cut.end_frame) || 0) / sampleRate;
        const position = currentTime();
        if (position < playback.range.start || position >= playback.range.end) {
            if (playbackIsRunning()) restartLoopPlayback(playback);
            else {
                setPlaybackPosition(playback, playback.range.start);
                state.playheadTime = playback.range.start;
                renderTransport();
            }
        }
        schedulePlaybackRangeEnd(playback);
    }

    function scheduleBoundaryAudition(frame) {
        if (!state.editor || playbackIsRunning()) return;
        const sampleRate = Number(state.editor.sample_rate) || 44100;
        const boundary = Math.max(0, Number(frame) || 0) / sampleRate;
        const start = Math.max(0, boundary - BOUNDARY_AUDITION_PREROLL_SECONDS);
        const end = Math.min(currentDuration(), start + BOUNDARY_AUDITION_SECONDS);
        if (end <= start) return;
        state.boundaryAuditionPending = { start, end };
        if (state.boundaryAuditionTimer) return;
        const elapsed = performance.now() - state.lastBoundaryAuditionAt;
        const delay = Math.max(0, BOUNDARY_AUDITION_INTERVAL_MS - elapsed);
        state.boundaryAuditionTimer = window.setTimeout(() => {
            state.boundaryAuditionTimer = null;
            const audition = state.boundaryAuditionPending;
            state.boundaryAuditionPending = null;
            if (!audition || playbackIsRunning()) return;
            state.lastBoundaryAuditionAt = performance.now();
            playActiveLayers(audition.start, { endOffset: audition.end, audition: true }).catch(reportPlaybackError);
        }, delay);
    }

    function cancelBoundaryAudition() {
        if (state.boundaryAuditionTimer) clearTimeout(state.boundaryAuditionTimer);
        state.boundaryAuditionTimer = null;
        state.boundaryAuditionPending = null;
    }

    function exportCut(cutId) {
        const cut = state.cuts.find(value => value.id === cutId);
        if (!cut) return;
        if (state.selectedCutId !== cut.id) selectCut(cut.id);
        openDestinationDialog('selected');
    }

    function waveformFrames() {
        return Math.max(1, Math.round((Number(state.editor?.duration_seconds) || 0) * (Number(state.editor?.sample_rate) || 44100)));
    }

    function fullMainRange() {
        return { start_frame: 0, end_frame: waveformFrames() };
    }

    function waveformWindow() {
        const totalFrames = waveformFrames();
        const visibleFrames = Math.max(1, Math.round(totalFrames / Math.max(1, state.waveformZoom)));
        const maxStart = Math.max(0, totalFrames - visibleFrames);
        state.viewStartFrame = Math.max(0, Math.min(maxStart, Math.round(state.viewStartFrame || 0)));
        return {
            totalFrames,
            visibleFrames,
            startFrame: state.viewStartFrame,
            endFrame: state.viewStartFrame + visibleFrames,
            maxStart,
        };
    }

    function renderZoomControls() {
        const enabled = Boolean(state.editor);
        editorZoomOut.disabled = !enabled || state.waveformZoom <= 1;
        editorZoomIn.disabled = !enabled || state.waveformZoom >= MAX_WAVEFORM_ZOOM;
        editorZoomFit.disabled = !enabled;
        const zoomDigits = state.waveformZoom < 10 ? 2 : state.waveformZoom < 100 ? 1 : 0;
        editorZoomLabel.textContent = `${Number(state.waveformZoom.toFixed(zoomDigits))}×`;
        renderEditorView();
    }

    function setWaveformZoom(value, anchorFrame = null, anchorRatio = 0.5, loadDetail = true) {
        const currentWindow = waveformWindow();
        const previousZoom = state.waveformZoom;
        const previousStart = state.viewStartFrame;
        const nextZoom = Math.max(1, Math.min(MAX_WAVEFORM_ZOOM, Number(value) || 1));
        const totalFrames = waveformFrames();
        const nextVisibleFrames = Math.max(1, Math.round(totalFrames / nextZoom));
        const defaultAnchor = currentWindow.startFrame + currentWindow.visibleFrames / 2;
        const anchor = Math.max(0, Math.min(totalFrames, Number.isFinite(anchorFrame) ? anchorFrame : defaultAnchor));
        const ratio = Math.max(0, Math.min(1, Number(anchorRatio) || 0));
        state.waveformZoom = nextZoom;
        state.viewStartFrame = Math.max(0, Math.min(totalFrames - nextVisibleFrames, Math.round(anchor - nextVisibleFrames * ratio)));
        renderZoomControls();
        drawWaveform();
        if (loadDetail) scheduleDetailWaveforms();
        if (state.waveformZoom !== previousZoom || state.viewStartFrame !== previousStart) markDirty();
    }

    function setWaveformViewStart(value, loadDetail = true) {
        const windowState = waveformWindow();
        const previousStart = state.viewStartFrame;
        state.viewStartFrame = Math.max(0, Math.min(windowState.maxStart, Math.round(Number(value) || 0)));
        renderZoomControls();
        drawWaveform();
        if (loadDetail) scheduleDetailWaveforms();
        if (state.viewStartFrame !== previousStart) markDirty();
    }

    function editorViewPointerMode(clientX) {
        if (!state.editor) return null;
        const windowBounds = editorViewWindow.getBoundingClientRect();
        if (clientX < windowBounds.left || clientX > windowBounds.right) return 'pan';
        if (Math.abs(clientX - windowBounds.left) <= VIEW_EDGE_SIZE) return 'resize-start';
        if (Math.abs(clientX - windowBounds.right) <= VIEW_EDGE_SIZE) return 'resize-end';
        return 'pan';
    }

    function updateEditorViewDrag(event) {
        const drag = state.viewDrag;
        if (!drag || event.pointerId !== drag.pointerId) return;
        const deltaPixels = event.clientX - drag.startX;
        if (!drag.moved && Math.abs(deltaPixels) < VIEW_DRAG_THRESHOLD) return;
        drag.moved = true;

        const fineAdjustment = event.shiftKey ? 0.2 : 1;
        const frameDelta = (deltaPixels / Math.max(1, drag.trackWidth)) * drag.window.totalFrames * fineAdjustment;
        if (drag.mode === 'pan') {
            state.viewStartFrame = Math.max(0, Math.min(
                drag.window.maxStart,
                Math.round(drag.window.startFrame + frameDelta),
            ));
        } else {
            const minimumVisible = Math.max(1, Math.round(drag.window.totalFrames / MAX_WAVEFORM_ZOOM));
            let startFrame = drag.window.startFrame;
            let endFrame = drag.window.endFrame;
            if (drag.mode === 'resize-start') {
                startFrame = Math.max(0, Math.min(endFrame - minimumVisible, Math.round(startFrame + frameDelta)));
            } else {
                endFrame = Math.min(drag.window.totalFrames, Math.max(startFrame + minimumVisible, Math.round(endFrame + frameDelta)));
            }
            const visibleFrames = Math.max(1, endFrame - startFrame);
            state.waveformZoom = Math.max(1, Math.min(MAX_WAVEFORM_ZOOM, drag.window.totalFrames / visibleFrames));
            state.viewStartFrame = startFrame;
        }
        renderZoomControls();
        drawWaveform();
    }

    function finishEditorViewDrag(event) {
        const drag = state.viewDrag;
        if (!drag || event.pointerId !== drag.pointerId) return;
        editorView.releasePointerCapture?.(event.pointerId);
        editorView.classList.remove('is-dragging');
        state.viewDrag = null;
        editorView.style.cursor = editorViewPointerMode(event.clientX)?.startsWith('resize') ? 'ew-resize' : 'grab';
        if (drag.moved) {
            scheduleDetailWaveforms(60);
            markDirty();
        }
    }

    function moveEditorViewByKeyboard(event) {
        if (!state.editor) return;
        const windowState = waveformWindow();
        const step = Math.max(1, Math.round(windowState.visibleFrames * (event.shiftKey ? 0.5 : 0.1)));
        if (event.key === 'ArrowLeft') state.viewStartFrame -= step;
        else if (event.key === 'ArrowRight') state.viewStartFrame += step;
        else if (event.key === 'ArrowUp') {
            setWaveformZoom(state.waveformZoom * ZOOM_BUTTON_FACTOR);
            event.preventDefault();
            return;
        }
        else if (event.key === 'ArrowDown') {
            setWaveformZoom(state.waveformZoom / ZOOM_BUTTON_FACTOR);
            event.preventDefault();
            return;
        }
        else if (event.key === 'Home') state.viewStartFrame = 0;
        else if (event.key === 'End') state.viewStartFrame = windowState.maxStart;
        else return;
        event.preventDefault();
        renderZoomControls();
        drawWaveform();
        scheduleDetailWaveforms();
        markDirty();
    }

    function drawRangeHandle(context, position, height, width, { color, edge, handleId, label }) {
        if (position < 0 || position > width) return;
        const hovered = state.hoverRangeHandle === handleId;
        const x = Math.max(0, Math.min(width, position));
        const bandWidth = hovered ? 10 : 6;
        const markerFill = color === '#77c8f2' ? '119, 200, 242' : '245, 215, 153';
        context.fillStyle = `rgba(${markerFill}, ${hovered ? '.24' : '.10'})`;
        context.fillRect(Math.max(0, x - bandWidth / 2), 0, Math.min(bandWidth, width - Math.max(0, x - bandWidth / 2)), height);
        context.strokeStyle = color;
        context.lineWidth = hovered ? 2 : 1.5;
        context.beginPath();
        context.moveTo(x, 0);
        context.lineTo(x, height);
        context.stroke();
        context.fillStyle = hovered ? '#fff2bd' : color;
        context.beginPath();
        context.moveTo(x - 7, 0);
        context.lineTo(x + 7, 0);
        context.lineTo(x, 11);
        context.closePath();
        context.fill();
        context.beginPath();
        context.moveTo(x - 7, height);
        context.lineTo(x + 7, height);
        context.lineTo(x, height - 11);
        context.closePath();
        context.fill();
        if (hovered) {
            context.font = '700 8px ui-monospace, SFMono-Regular, Consolas, monospace';
            const textWidth = context.measureText(label).width;
            const textX = edge === 'start'
                ? Math.min(width - textWidth - 6, x + 8)
                : Math.max(6, x - textWidth - 8);
            context.fillStyle = 'rgba(9, 12, 16, .92)';
            context.fillRect(textX - 3, 14, textWidth + 6, 13);
            context.fillStyle = '#fff2bd';
            context.fillText(label, textX, 23);
        }
    }

    function waveformBounds(waveform, totalFrames) {
        const startFrame = Math.max(0, Number(waveform?.start_frame) || 0);
        const endFrame = Math.max(startFrame, Math.min(
            totalFrames,
            Number.isFinite(Number(waveform?.end_frame)) ? Number(waveform.end_frame) : totalFrames,
        ));
        return { startFrame, endFrame };
    }

    function waveformForWindow(itemId, windowState) {
        const overview = state.waveforms.get(itemId);
        const detail = state.detailWaveforms.get(itemId);
        if (detail?.peaks?.length) {
            const bounds = waveformBounds(detail, windowState.totalFrames);
            if (bounds.startFrame <= windowState.startFrame && bounds.endFrame >= windowState.endFrame) {
                const detailDensity = detail.peaks.length / Math.max(1, bounds.endFrame - bounds.startFrame);
                const overviewBounds = waveformBounds(overview, windowState.totalFrames);
                const overviewDensity = (overview?.peaks?.length || 0) / Math.max(1, overviewBounds.endFrame - overviewBounds.startFrame);
                if (detailDensity >= overviewDensity) return detail;
            }
        }
        return overview;
    }

    function waveformHasDisplayDetail(waveform, windowState) {
        if (!waveform?.peaks?.length) return false;
        const bounds = waveformBounds(waveform, windowState.totalFrames);
        if (bounds.startFrame > windowState.startFrame || bounds.endFrame < windowState.endFrame) return false;
        const rangeFrames = Math.max(1, bounds.endFrame - bounds.startFrame);
        const visiblePeakCount = waveform.peaks.length * windowState.visibleFrames / rangeFrames;
        const pixelTarget = Math.max(320, editorWaveformMain?.clientWidth || 0)
            * Math.max(1, window.devicePixelRatio || 1)
            * 1.25;
        return visiblePeakCount >= Math.min(10_000, pixelTarget);
    }

    function drawWaveformGrid(context, width, height, windowState, sampleRate) {
        const startSeconds = windowState.startFrame / sampleRate;
        const visibleSeconds = windowState.visibleFrames / sampleRate;
        if (!Number.isFinite(visibleSeconds) || visibleSeconds <= 0) return;

        const rawStep = visibleSeconds / 8;
        const magnitude = 10 ** Math.floor(Math.log10(Math.max(rawStep, 0.0001)));
        const normalized = rawStep / magnitude;
        const multiplier = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
        const stepSeconds = multiplier * magnitude;
        const first = Math.ceil(startSeconds / stepSeconds) * stepSeconds;

        context.save();
        context.strokeStyle = 'rgba(255, 255, 255, .07)';
        context.fillStyle = 'rgba(205, 221, 231, .5)';
        context.lineWidth = 1;
        context.font = '8px ui-monospace, SFMono-Regular, Consolas, monospace';
        context.textBaseline = 'top';
        for (let seconds = first; seconds <= startSeconds + visibleSeconds + stepSeconds * 0.01; seconds += stepSeconds) {
            const x = ((seconds - startSeconds) / visibleSeconds) * width;
            if (x < 0 || x > width) continue;
            const alignedX = Math.round(x) + 0.5;
            context.beginPath();
            context.moveTo(alignedX, 0);
            context.lineTo(alignedX, height);
            context.stroke();
            if (x < width - 44) context.fillText(formatWaveformTime(seconds), x + 3, 3);
        }
        context.restore();
    }

    function drawWaveform() {
        const canvas = editorWaveformMain?.querySelector('canvas');
        if (!canvas) return;
        const width = Math.max(240, editorWaveformMain.clientWidth);
        const height = Math.max(150, Math.min(360, Math.max(1, state.layers.size) * 72));
        editorWaveformMain.style.height = `${height}px`;
        if (editorMixerRail) editorMixerRail.style.height = `${height}px`;
        const ratio = window.devicePixelRatio || 1;
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        const context = canvas.getContext('2d');
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        context.clearRect(0, 0, width, height);
        const layers = [...state.layers.values()];
        const bandHeight = height / Math.max(1, layers.length);
        const windowState = waveformWindow();
        const sampleRate = Number(state.editor?.sample_rate) || 44100;
        drawWaveformGrid(context, width, height, windowState, sampleRate);
        layers.forEach((layer, layerIndex) => {
            const waveform = waveformForWindow(layer.item_id, windowState);
            if (!waveform?.peaks?.length) return;
            const top = layerIndex * bandHeight;
            const bottom = top + bandHeight;
            const center = top + bandHeight / 2;
            const amplitude = Math.max(5, bandHeight * 0.42) * layerWaveformScale(layer);
            context.strokeStyle = layer.muted
                ? 'rgba(142, 151, 161, .42)'
                : 'rgba(119, 200, 242, .85)';
            context.lineWidth = 1;
            context.save();
            context.beginPath();
            context.rect(0, top, width, bandHeight);
            context.clip();
            context.beginPath();
            const clippedTop = new Set();
            const clippedBottom = new Set();
            const bounds = waveformBounds(waveform, windowState.totalFrames);
            const waveformFrames = Math.max(1, bounds.endFrame - bounds.startFrame);
            const peakCount = waveform.peaks.length;
            const firstPeak = Math.max(0, Math.floor(
                ((windowState.startFrame - bounds.startFrame) / waveformFrames) * peakCount,
            ) - 1);
            const lastPeak = Math.min(peakCount - 1, Math.ceil(
                ((windowState.endFrame - bounds.startFrame) / waveformFrames) * peakCount,
            ) + 1);
            for (let index = firstPeak; index <= lastPeak; index += 1) {
                const peak = waveform.peaks[index];
                const frame = bounds.startFrame + ((index + 0.5) / peakCount) * waveformFrames;
                const x = ((frame - windowState.startFrame) / windowState.visibleFrames) * width;
                const minimumY = center + Number(peak[0] || 0) * amplitude;
                const maximumY = center + Number(peak[1] || 0) * amplitude;
                if (x >= 0 && x <= width) {
                    const markerX = Math.max(0, Math.min(width - 1, Math.round(x)));
                    if (minimumY < top) clippedTop.add(markerX);
                    if (maximumY > bottom) clippedBottom.add(markerX);
                }
                context.moveTo(x, Math.max(top, Math.min(bottom, minimumY)));
                context.lineTo(x, Math.max(top, Math.min(bottom, maximumY)));
            }
            context.stroke();
            context.restore();
            if (layerIndex) {
                context.strokeStyle = 'rgba(255, 255, 255, .08)';
                context.beginPath();
                context.moveTo(0, top);
                context.lineTo(width, top);
                context.stroke();
            }
            context.fillStyle = '#ff4d55';
            clippedTop.forEach(x => context.fillRect(x, top, 1, 2));
            clippedBottom.forEach(x => context.fillRect(x, Math.max(top, bottom - 2), 1, 2));
        });
        const mainRange = state.mainRange || { start_frame: 0, end_frame: windowState.totalFrames };
        const mainStart = ((mainRange.start_frame - windowState.startFrame) / windowState.visibleFrames) * width;
        const mainEnd = ((mainRange.end_frame - windowState.startFrame) / windowState.visibleFrames) * width;
        context.fillStyle = 'rgba(5, 8, 11, .46)';
        if (mainStart > 0) context.fillRect(0, 0, Math.min(width, mainStart), height);
        if (mainEnd < width) context.fillRect(Math.max(0, mainEnd), 0, width - Math.max(0, mainEnd), height);
        drawRangeHandle(context, mainStart, height, width, {
            color: '#f5d799', edge: 'start', handleId: 'main-start', label: 'main in',
        });
        drawRangeHandle(context, mainEnd, height, width, {
            color: '#f5d799', edge: 'end', handleId: 'main-end', label: 'main out',
        });
        const visibleCuts = state.selectedCutId
            ? state.cuts.filter(cut => cut.id === state.selectedCutId)
            : [];
        [...visibleCuts, ...(state.draftRange ? [{ ...state.draftRange, id: 'draft' }] : [])].forEach(cut => {
            const start = ((cut.start_frame - windowState.startFrame) / windowState.visibleFrames) * width;
            const end = ((cut.end_frame - windowState.startFrame) / windowState.visibleFrames) * width;
            if (end < 0 || start > width) return;
            context.fillStyle = cut.id === 'draft' ? 'rgba(119, 200, 242, .12)' : 'rgba(245, 215, 153, .2)';
            context.fillRect(Math.max(0, start), 0, Math.max(1, Math.min(width, end) - Math.max(0, start)), height);
            context.strokeStyle = cut.id === 'draft' ? 'rgba(119, 200, 242, .9)' : '#f5d799';
            context.strokeRect(Math.max(0, start), 0, Math.max(1, Math.min(width, end) - Math.max(0, start)), height);
            if (cut.id !== 'draft') {
                drawRangeHandle(context, start, height, width, {
                    color: '#77c8f2', edge: 'start', handleId: 'cut-start', label: 'cut in',
                });
                drawRangeHandle(context, end, height, width, {
                    color: '#77c8f2', edge: 'end', handleId: 'cut-end', label: 'cut out',
                });
            }
        });
        const playheadFrame = currentTime() * sampleRate;
        if (playheadFrame >= windowState.startFrame && playheadFrame <= windowState.endFrame) {
            const playheadX = ((playheadFrame - windowState.startFrame) / windowState.visibleFrames) * width;
            context.fillStyle = '#f5d799';
            context.fillRect(Math.max(0, playheadX - 1), 0, 2, height);
        }
    }

    function waveformUrl(url, parameters) {
        const query = new URLSearchParams(parameters);
        return `${url}${url.includes('?') ? '&' : '?'}${query}`;
    }

    function detailResolution() {
        const width = Math.max(320, editorWaveformMain?.clientWidth || 0);
        const ratio = Math.max(1, window.devicePixelRatio || 1);
        return Math.min(10_000, Math.max(2400, Math.ceil(width * Math.max(4, ratio * 2))));
    }

    async function loadDetailWaveforms() {
        if (!state.editor || state.waveformZoom <= DETAIL_ZOOM_THRESHOLD) return;
        const windowState = waveformWindow();
        const layers = [...state.layers.values()];
        if (!layers.length) return;

        const alreadyCovered = layers.every(layer => waveformHasDisplayDetail(
            state.detailWaveforms.get(layer.item_id),
            windowState,
        ));
        if (alreadyCovered) return;

        const margin = Math.max(1, Math.round(windowState.visibleFrames * 0.5));
        const startFrame = Math.max(0, windowState.startFrame - margin);
        const endFrame = Math.min(windowState.totalFrames, windowState.endFrame + margin);
        const resolution = detailResolution();
        const token = ++state.detailWaveformToken;
        state.detailWaveformController?.abort();
        const controller = new AbortController();
        state.detailWaveformController = controller;

        try {
            const values = await Promise.all(layers.map(async layer => {
                const response = await fetch(waveformUrl(layer.waveform_url, {
                    resolution: String(resolution),
                    start_frame: String(startFrame),
                    end_frame: String(endFrame),
                }), { signal: controller.signal });
                if (!response.ok) throw new Error(`Could not load detailed waveform for ${layer.label}`);
                return [layer.item_id, await response.json()];
            }));
            if (token !== state.detailWaveformToken) return;
            values.forEach(([id, waveform]) => state.detailWaveforms.set(id, waveform));
            drawWaveform();
        } catch (error) {
            if (error?.name !== 'AbortError') console.warn(error.message || 'Detailed waveform unavailable');
        } finally {
            if (state.detailWaveformController === controller) state.detailWaveformController = null;
        }
    }

    function scheduleDetailWaveforms(delay = 120) {
        if (state.detailWaveformTimer) clearTimeout(state.detailWaveformTimer);
        state.detailWaveformTimer = null;
        state.detailWaveformController?.abort();
        state.detailWaveformController = null;
        state.detailWaveformToken += 1;
        if (!state.editor || state.waveformZoom <= DETAIL_ZOOM_THRESHOLD) {
            state.detailWaveforms.clear();
            return;
        }
        state.detailWaveformTimer = setTimeout(() => {
            state.detailWaveformTimer = null;
            loadDetailWaveforms();
        }, delay);
    }

    async function loadWaveforms() {
        const token = ++state.waveformToken;
        state.waveforms.clear();
        state.detailWaveforms.clear();
        state.detailWaveformController?.abort();
        editorWaveformEmpty.textContent = 'Loading waveform…';
        editorWaveformEmpty.classList.remove('hidden');
        const layers = [...state.layers.values()];
        const overviewResolution = Math.min(10_000, Math.max(
            2400,
            Math.ceil(Math.max(320, editorWaveformMain?.clientWidth || 0) * 4),
        ));
        try {
            const values = await Promise.all(layers.map(async layer => {
                const response = await fetch(waveformUrl(layer.waveform_url, {
                    resolution: String(overviewResolution),
                }));
                if (!response.ok) throw new Error(`Could not load ${layer.label}`);
                return [layer.item_id, await response.json()];
            }));
            if (token !== state.waveformToken) return;
            values.forEach(([id, waveform]) => state.waveforms.set(id, waveform));
            editorWaveformEmpty.classList.add('hidden');
            renderZoomControls();
            drawWaveform();
            setStatus('');
        } catch (error) {
            if (token !== state.waveformToken) return;
            editorWaveformEmpty.textContent = error.message || 'Waveform unavailable';
            editorWaveformEmpty.classList.remove('hidden');
        }
    }

    function renderEditor() {
        const current = state.currentTarget;
        const activeCount = activeLayers().length;
        const soloLayer = state.soloLayerId === null ? null : state.layers.get(state.soloLayerId);
        editorTitle.textContent = current?.label || 'Media editor';
        editorDetail.textContent = state.session
            ? soloLayer
                ? `${state.session.title} · SOLO ${soloLayer.label}`
                : `${state.session.title} · ${activeCount} active layer${activeCount === 1 ? '' : 's'}`
            : 'Choose a playable asset.';
        targetLabel.textContent = current?.label || state.session?.title || 'No media selected';
        updateRenderButtons();
        editorAddCut.disabled = !state.editor;
        editorNormalize.disabled = !state.editor || !selectedLayer();
        renderZoomControls();
        renderLayers();
        renderCuts();
        renderTargetMenu();
        drawWaveform();
        renderTransport();
    }

    function editorStatePayload() {
        const mainRange = state.mainRange || fullMainRange();
        return {
            schema_version: 1,
            source_item_id: Number(state.currentTarget?.item_id),
            target_id: state.currentTargetId,
            active_layer_ids: activeLayerIds(),
            main_start_frame: mainRange.start_frame,
            main_end_frame: mainRange.end_frame,
            segments: state.cuts.map(cut => ({
                id: cut.id,
                start_frame: cut.start_frame,
                end_frame: cut.end_frame,
                label: cut.label,
            })),
            layers: [...state.layers.values()].map(layer => ({
                item_id: layer.item_id,
                pre_gain_db: Number(layer.pre_gain_db) || 0,
                volume: clampVolume(layer.volume),
                muted: Boolean(layer.muted),
            })),
            gain_db: 0,
            normalize: false,
            target_peak_db: -1,
            output_format: destinationFormat.value || 'wav',
            view: {
                selected_layer_id: state.selectedLayerId,
                selected_segment_id: state.selectedCutId,
                waveform_zoom: state.waveformZoom,
                view_start_frame: state.viewStartFrame,
            },
        };
    }

    function applyEditorState(saved) {
        if (!saved || saved.target_id !== state.currentTargetId) return false;
        const availableIds = new Set(state.layers.keys());
        const hasSavedActiveIds = Array.isArray(saved.active_layer_ids);
        const activeIds = new Set((saved.active_layer_ids || []).map(Number).filter(id => availableIds.has(id)));
        (saved.layers || []).forEach(settings => {
            const layer = state.layers.get(Number(settings.item_id));
            if (!layer) return;
            layer.pre_gain_db = clampGain(settings.pre_gain_db, MAX_PRE_GAIN_DB);
            layer.pre_gain_linear = gainDbToLinear(layer.pre_gain_db);
            layer.volume = settings.volume === null || settings.volume === undefined
                ? legacyGainDbToVolume(settings.gain_db)
                : clampVolume(settings.volume);
            if (!hasSavedActiveIds) layer.muted = Boolean(settings.muted);
        });
        if (hasSavedActiveIds) state.layers.forEach(layer => {
            layer.muted = !activeIds.has(layer.item_id);
        });
        const totalFrames = waveformFrames();
        const mainStart = Math.max(0, Math.min(totalFrames - 1, Number(saved.main_start_frame) || 0));
        const mainEnd = Math.max(mainStart + 1, Math.min(totalFrames, Number(saved.main_end_frame) || totalFrames));
        state.mainRange = { start_frame: mainStart, end_frame: mainEnd };
        state.cuts = (saved.segments || []).map(segment => ({
            id: String(segment.id),
            start_frame: Number(segment.start_frame),
            end_frame: Number(segment.end_frame),
            label: segment.label || 'Cut',
        }));
        const view = saved.view || {};
        state.selectedCutId = state.cuts.some(cut => cut.id === view.selected_segment_id) ? view.selected_segment_id : null;
        state.selectedLayerId = availableIds.has(Number(view.selected_layer_id))
            ? Number(view.selected_layer_id)
            : defaultSelectedLayerId();
        state.waveformZoom = Math.max(1, Math.min(MAX_WAVEFORM_ZOOM, Number(view.waveform_zoom) || 1));
        state.viewStartFrame = Math.max(0, Number(view.view_start_frame) || 0);
        if (saved.output_format === 'wav' || saved.output_format === 'mp3') destinationFormat.value = saved.output_format;
        return true;
    }

    async function writeProjectState(projectId, revision, payload) {
        const response = await fetch(`/projects/${projectId}/editor-state`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.detail || 'Could not save editor progress');
        if (revision === state.editRevision) state.dirty = false;
        return result;
    }

    async function saveProjectState(projectId = activeProjectId(), { force = false } = {}) {
        if (!projectId || !state.editor) return false;
        if (state.projectSaveTimer) clearTimeout(state.projectSaveTimer);
        state.projectSaveTimer = null;
        if (state.projectSavePromise) {
            state.projectSaveQueued = true;
            const currentResult = await state.projectSavePromise;
            if (force && state.dirty) return saveProjectState(projectId, { force: true });
            return currentResult && !state.dirty;
        }
        if (!force && !state.dirty) return true;

        const revision = state.editRevision;
        const payload = editorStatePayload();
        state.projectSaveQueued = false;
        setStatus('Saving progress…');
        updateRenderButtons();
        state.projectSavePromise = writeProjectState(projectId, revision, payload)
            .then(() => {
                if (revision === state.editRevision) setStatus('Progress saved');
                return true;
            })
            .catch(error => {
                setStatus(`${error.message || 'Could not save progress'}. Changes remain in this editor.`, true);
                return false;
            })
            .finally(() => {
                state.projectSavePromise = null;
                updateRenderButtons();
                if (state.projectSaveQueued && state.dirty && activeProjectId() === projectId) scheduleProjectSave(0);
            });
        return state.projectSavePromise;
    }

    function scheduleProjectSave(delay = 600) {
        const projectId = activeProjectId();
        if (!projectId) return;
        if (state.projectSaveTimer) clearTimeout(state.projectSaveTimer);
        state.projectSaveTimer = setTimeout(() => {
            state.projectSaveTimer = null;
            saveProjectState(projectId);
        }, delay);
    }

    function markDirty() {
        state.dirty = true;
        state.editRevision += 1;
        if (activeProjectId()) {
            setStatus('Saving progress…');
            scheduleProjectSave();
        } else {
            setStatus('Save progress to keep this edit');
        }
        updateRenderButtons();
    }

    function buildSessionTargetUrl(rootId, targetId) {
        const query = targetId ? `?target_id=${encodeURIComponent(targetId)}` : '';
        return `/items/${rootId}/editor-session${query}`;
    }

    async function loadSession(rootId, targetId = null) {
        const requestId = ++state.sessionRequestId;
        cancelBoundaryAudition();
        if (state.projectSaveTimer) clearTimeout(state.projectSaveTimer);
        state.projectSaveTimer = null;
        state.projectSaveQueued = false;
        state.sessionRequestController?.abort();
        const controller = new AbortController();
        state.sessionRequestController = controller;
        let response;
        try {
            response = await fetch(buildSessionTargetUrl(rootId, targetId), { signal: controller.signal });
        } catch (error) {
            if (state.sessionRequestController === controller) state.sessionRequestController = null;
            throw error;
        }
        const session = await response.json().catch(() => ({}));
        if (!response.ok) {
            if (state.sessionRequestController === controller) state.sessionRequestController = null;
            throw new Error(session.detail || 'Could not open this media');
        }
        if (requestId !== state.sessionRequestId) return false;
        state.session = session.session;
        state.editor = session.editor;
        state.rootId = rootId;
        state.currentTargetId = session.current_target.id;
        state.currentTarget = session.session.targets.find(target => target.id === state.currentTargetId) || session.current_target;
        state.layers = new Map((session.editor.layers || []).map(layer => [layer.item_id, {
            ...layer,
            pre_gain_db: 0,
            pre_gain_linear: 1,
            volume: 1,
            muted: !layer.active,
        }]));
        state.soloLayerId = null;
        state.selectedLayerId = defaultSelectedLayerId();
        state.cuts = [];
        state.selectedCutId = null;
        state.loopCutId = null;
        state.editingCutLabelId = null;
        state.mainRange = fullMainRange();
        state.draftRange = null;
        state.playheadTime = 0;
        state.waveformZoom = 1;
        state.viewStartFrame = 0;
        const restored = applyEditorState(session.editor_state);
        state.dirty = false;
        state.editRevision = 0;
        renderEditor();
        await loadWaveforms();
        if (restored) setStatus('Saved project progress restored');
        else if (session.editor_state_warning) setStatus(session.editor_state_warning, true);
        if (state.sessionRequestController === controller) state.sessionRequestController = null;
        return true;
    }

    async function confirmTargetChange(label = 'another target') {
        if (!state.dirty) return Promise.resolve(true);
        if (activeProjectId()) return saveProjectState(activeProjectId(), { force: true });
        switchSummary.textContent = `Switch to ${label}? Your staged changes will be discarded.`;
        switchDialog.showModal();
        return new Promise(resolve => {
            state.pendingSwitch = { resolve };
        });
    }

    async function switchTarget(targetId) {
        if (!state.session || targetId === state.currentTargetId) {
            targetMenu.classList.add('hidden');
            return;
        }
        const target = state.session.targets.find(value => value.id === targetId);
        if (!(await confirmTargetChange(target?.label || 'another target'))) return;
        targetMenu.classList.add('hidden');
        dispatchTransportCommand('stop');
        setStatus('Loading target…');
        try {
            await loadSession(state.rootId, targetId);
        } catch (error) {
            if (error?.name === 'AbortError') return;
            setStatus(error.message, true);
        }
    }

    async function openForEntry(entry, { autoplay = false } = {}) {
        const rootId = rootIdForEntry(entry);
        if (!rootId) return;
        const targetId = targetIdForEntry(entry);
        dispatchTransportCommand('stop');
        state.opened = true;
        drawer.classList.remove('hidden');
        editorToggle.textContent = 'Close editor';
        setStatus('Opening…');
        try {
            const loaded = await loadSession(rootId, targetId);
            if (loaded && autoplay) togglePlayback();
        } catch (error) {
            if (error?.name === 'AbortError') return;
            state.session = null;
            state.editor = null;
            renderEditor();
            setStatus(error.message || 'This asset has no editor.', true);
        }
    }

    async function closeEditor() {
        if (state.dirty && activeProjectId()) {
            const saved = await saveProjectState(activeProjectId(), { force: true });
            if (!saved && !window.confirm('Project autosave failed. Discard the unsaved media edit?')) return;
        } else if (state.dirty && !window.confirm('Discard the unsaved media edit?')) return;
        state.sessionRequestId += 1;
        cancelBoundaryAudition();
        state.sessionRequestController?.abort();
        state.sessionRequestController = null;
        if (state.detailWaveformTimer) clearTimeout(state.detailWaveformTimer);
        state.detailWaveformTimer = null;
        state.detailWaveformController?.abort();
        state.detailWaveformController = null;
        state.detailWaveformToken += 1;
        if (state.projectSaveTimer) clearTimeout(state.projectSaveTimer);
        state.projectSaveTimer = null;
        state.projectSaveQueued = false;
        clearOwnPlayback();
        dispatchTransportCommand('stop');
        state.opened = false;
        state.session = null;
        state.editor = null;
        state.layers.clear();
        state.soloLayerId = null;
        state.cuts = [];
        state.selectedCutId = null;
        state.loopCutId = null;
        state.editingCutLabelId = null;
        state.mainRange = null;
        state.waveforms.clear();
        state.detailWaveforms.clear();
        state.viewDrag = null;
        state.pendingSwitch = null;
        finishRenderConflictPrompt(null);
        drawer.classList.add('hidden');
        editorToggle.textContent = 'Open editor';
        targetMenu.classList.add('hidden');
        renderTransport();
    }

    async function populateVaults() {
        const response = await fetch('/vaults/');
        const vaults = await response.json().catch(() => []);
        if (!response.ok || !Array.isArray(vaults) || !vaults.length) throw new Error('No destination vault is available');
        projectVault.innerHTML = vaults.map(vault => `<option value="${vault.id}">${escapeHtml(vault.name)}</option>`).join('');
    }

    async function populateProjects(vaultId = null) {
        const query = vaultId ? `?vault_id=${vaultId}` : '';
        const response = await fetch(`/items/summaries${query}`);
        const items = await response.json().catch(() => []);
        const projects = (Array.isArray(items) ? items : []).filter(item => item.type === 'project');
        if (projectExistingSelect) {
            if (projects.length) {
                projectExistingSelect.innerHTML = projects.map(p => `<option value="${p.id}">${escapeHtml(p.title || 'Untitled Project')}</option>`).join('');
                if (existingProjectChoice) existingProjectChoice.classList.remove('hidden');
            } else {
                projectExistingSelect.innerHTML = '<option value="">No existing projects</option>';
                if (existingProjectChoice) existingProjectChoice.classList.add('hidden');
                if (destinationForm.querySelector('input[name="media-destination-mode"]:checked')?.value === 'existing_project') {
                    const projectRadio = destinationForm.querySelector('input[value="project"]');
                    if (projectRadio) projectRadio.checked = true;
                }
            }
        }
    }

    function destinationMode() {
        return destinationForm.querySelector('input[name="media-destination-mode"]:checked')?.value || 'project';
    }

    function updateDestinationFields() {
        const mode = destinationMode();
        const isNewProject = mode === 'project';
        const isExistingProject = mode === 'existing_project';
        projectFields.classList.toggle('hidden', !isNewProject);
        if (existingProjectFields) existingProjectFields.classList.toggle('hidden', !isExistingProject);
        projectName.required = isNewProject;
        projectVault.required = isNewProject;
        if (projectExistingSelect) projectExistingSelect.required = isExistingProject;
    }

    async function openDestinationDialog(scope = 'main', action = 'render') {
        if (!state.editor) return;
        if (state.renderBusy) return;
        if (scope === 'selected' && !selectedCut()) return;
        if (scope === 'all' && !state.cuts.length) return;
        state.renderScope = scope;
        state.destinationAction = action;
        if (action === 'save' && activeProjectId()) {
            await saveProjectState(activeProjectId(), { force: true });
            return;
        }
        if (action === 'render' && activeProjectId()) {
            await submitRender({ mode: 'project', projectId: state.rootId, scope });
            return;
        }
        const savingProgress = action === 'save';
        destinationEyebrow.textContent = savingProgress ? 'Editor progress' : 'Render destination';
        destinationTitle.textContent = savingProgress ? 'Save progress to project' : 'Save media result';
        destinationFormatField.classList.toggle('hidden', savingProgress);
        destinationProjectChoice.classList.remove('hidden');
        destinationOverrideChoice.classList.toggle('hidden', savingProgress);
        destinationSubmit.textContent = savingProgress ? 'Save progress' : 'Continue';
        destinationResult.className = 'result hidden';
        destinationResult.textContent = '';
        projectName.value = state.session?.title ? `${state.session.title} edits` : '';
        try {
            await populateVaults();
            await populateProjects(projectVault?.value || null);
        } catch (error) {
            destinationResult.textContent = error.message;
            destinationResult.className = 'result error';
        }
        const overrideRadio = destinationForm.querySelector('input[value="override"]');
        const projectRadio = destinationForm.querySelector('input[value="project"]');
        const canOverride = state.currentTarget?.type === 'audio' || state.currentTarget?.type === 'track' || state.currentTarget?.type === 'sample';
        const exportingCut = scope !== 'main';
        destinationOverrideChoice.classList.toggle('hidden', savingProgress || exportingCut);
        overrideRadio.disabled = savingProgress || exportingCut || !canOverride;
        if (savingProgress || exportingCut) projectRadio.checked = true;
        else if (canOverride) overrideRadio.checked = true;
        const canMoveSource = canOverride && !exportingCut;
        projectMove.disabled = !canMoveSource;
        if (!canMoveSource) projectMove.checked = false;
        if (!canOverride && destinationMode() === 'override') {
            projectRadio.checked = true;
        }
        updateDestinationFields();
        destinationDialog.showModal();
    }

    async function addSourceToProject(projectId, sourceItemId) {
        const response = await fetch(`/projects/${projectId}/items`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ item_ids: [Number(sourceItemId)] }),
        });
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.detail || 'Could not add item to project');
        }
    }

    function projectSourceId() {
        return Number(state.currentTarget?.item_id) || state.rootId;
    }

    async function createProject(name, vaultId, moveSource, sourceItemId) {
        const response = await fetch('/projects/from-items', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                item_ids: [sourceItemId],
                mode: 'single',
                name,
                project_type: 'project',
                vault_id: Number(vaultId),
                move_files: false,
                move_item_ids: moveSource ? [sourceItemId] : [],
            }),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !Array.isArray(result) || !result[0]?.id) throw new Error(result.detail || 'Could not create the project');
        return result[0];
    }

    async function createFocusedProject(name, vaultId, moveSource, sourceItemId) {
        const project = await createProject(name, vaultId, moveSource, sourceItemId);
        const saved = await saveProjectState(project.id, { force: true });
        if (!saved) throw new Error(`Project "${project.title || name}" was created, but its editor progress could not be saved`);
        await loadSession(project.id);
        window.dispatchEvent(new CustomEvent('gaia:library-refresh'));
        setStatus(`Progress saved to ${project.title || name}`);
        return project;
    }

    function renderPayload(destination, scope = state.renderScope) {
        const mainRange = state.mainRange || fullMainRange();
        const cut = selectedCut();
        const segments = scope === 'all' ? state.cuts : scope === 'selected' && cut ? [cut] : [];
        return {
            source_item_id: projectSourceId(),
            target_id: state.currentTargetId,
            active_layer_ids: activeLayerIds(),
            main_start_frame: mainRange.start_frame,
            main_end_frame: mainRange.end_frame,
            segments,
            layers: [...state.layers.values()].map(layer => ({
                item_id: layer.item_id,
                pre_gain_db: Number(layer.pre_gain_db) || 0,
                volume: clampVolume(layer.volume),
                muted: Boolean(layer.muted),
            })),
            gain_db: 0,
            normalize: false,
            target_peak_db: -1,
            output_format: destinationFormat.value || 'wav',
            destination,
        };
    }

    function finishRenderConflictPrompt(action) {
        const pending = state.pendingOutputConflict;
        state.pendingOutputConflict = null;
        if (renderConflictDialog?.open) renderConflictDialog.close();
        pending?.resolve(action);
    }

    function chooseRenderConflictAction(conflicts) {
        if (!renderConflictDialog || !renderConflictSummary) return Promise.resolve(null);
        const names = conflicts.map(conflict => conflict.filename).filter(Boolean);
        const list = names.map(name => `“${name}”`).join(', ');
        renderConflictSummary.textContent = names.length === 1
            ? `${list} is already a rendered cut in this project.`
            : `${list} already exist as rendered cuts in this project.`;
        renderConflictDialog.showModal();
        return new Promise(resolve => {
            state.pendingOutputConflict = { resolve };
        });
    }

    async function resolveRenderOutputConflict(payload) {
        if (payload.destination.mode !== 'project') return true;
        const response = await fetch('/media-edits/output-conflicts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.detail || 'Could not check render output names');
        const conflicts = Array.isArray(result.conflicts) ? result.conflicts : [];
        if (!conflicts.length) return true;
        const action = await chooseRenderConflictAction(conflicts);
        if (!action) return false;
        payload.destination.existing_output = action;
        return true;
    }

    async function submitRender({ mode, projectId = null, projectNameValue = null, vaultId = null, moveSource = false, scope = state.renderScope }) {
        if (state.renderBusy) return;
        if (mode === 'override') {
            const targetLabel = state.currentTarget?.label || 'the original file';
            if (!window.confirm(`Render the main range and override ${targetLabel}? This cannot be undone.`)) return;
        }
        if (destinationDialog.open) destinationDialog.close();
        state.renderBusy = true;
        updateRenderButtons();
        setStatus('Starting render…');
        const sessionRequestId = state.sessionRequestId;
        const editRevision = state.editRevision;
        try {
            let destination = { mode, project_id: projectId, revision_label: null, set_master: true };
            if (mode === 'existing_project') {
                destination.mode = 'project';
                destination.project_id = projectId;
                await addSourceToProject(projectId, projectSourceId());
                const saved = await saveProjectState(projectId, { force: true });
                if (!saved) throw new Error('Render stopped because editor progress could not be saved');
            } else if (mode === 'project' && !projectId) {
                const project = await createFocusedProject(projectNameValue, vaultId, moveSource, projectSourceId());
                projectId = project.id;
                destination.project_id = projectId;
            } else if (mode === 'project') {
                const saved = await saveProjectState(projectId, { force: true });
                if (!saved) throw new Error('Render stopped because editor progress could not be saved');
            }
            if (mode === 'override') destination.override_item_id = state.currentTarget?.item_id || null;
            const payload = renderPayload(destination, scope);
            if (!await resolveRenderOutputConflict(payload)) {
                setStatus('Render cancelled.');
                return;
            }
            const response = await fetch('/media-edits/render', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const job = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(job.detail || 'Could not start render');
            await pollRender(job.job_id, { scope, sessionRequestId, editRevision });
        } catch (error) {
            if (sessionRequestId === state.sessionRequestId) {
                setStatus(error.message || 'Render failed.', true);
            }
        } finally {
            state.renderBusy = false;
            updateRenderButtons();
        }
    }

    async function pollRender(jobId, renderContext) {
        const response = await fetch(`/media-jobs/${jobId}`);
        const job = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(job.detail || 'Could not read render status');
        if (job.status === 'queued' || job.status === 'running') {
            if (renderContext.sessionRequestId === state.sessionRequestId) setStatus('Rendering…');
            await new Promise(resolve => setTimeout(resolve, 500));
            return pollRender(jobId, renderContext);
        }
        if (job.status !== 'completed') throw new Error(job.error || 'Render failed');
        if (
            renderContext.sessionRequestId === state.sessionRequestId
            && renderContext.editRevision === state.editRevision
        ) {
            const renderedEveryStagedEdit = renderContext.scope === 'all'
                || (renderContext.scope === 'main' && state.cuts.length === 0);
            if (renderedEveryStagedEdit) state.dirty = false;
            const warnings = job.result?.warnings || [];
            setStatus(warnings.length ? `Render complete. ${warnings.join(' ')}` : 'Render complete.');
        }
        window.dispatchEvent(new CustomEvent('gaia:library-refresh'));
    }

    function addCut() {
        const totalFrames = waveformFrames();
        const range = state.draftRange || state.mainRange || { start_frame: 0, end_frame: totalFrames };
        if (range.end_frame <= range.start_frame) return;
        disableCutLoop(state.selectedCutId);
        const cut = {
            id: `cut-${Date.now()}-${state.cuts.length}`,
            start_frame: range.start_frame,
            end_frame: range.end_frame,
            label: `Cut ${state.cuts.length + 1}`,
        };
        state.cuts.push(cut);
        state.selectedCutId = cut.id;
        state.selectedLayerId = null;
        state.editingCutLabelId = null;
        state.draftRange = null;
        markDirty();
        renderLayers();
        renderCuts();
        updateRenderButtons();
        drawWaveform();
        renderTransport();
    }

    function frameAtPointer(event, canvas) {
        const bounds = canvas.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
        const windowState = waveformWindow();
        return Math.round(windowState.startFrame + ratio * windowState.visibleFrames);
    }

    function rangeHandleAtPointer(event, canvas) {
        const cut = selectedCut();
        const range = cut || state.mainRange || fullMainRange();
        const windowState = waveformWindow();
        const bounds = canvas.getBoundingClientRect();
        const startX = ((range.start_frame - windowState.startFrame) / windowState.visibleFrames) * bounds.width;
        const endX = ((range.end_frame - windowState.startFrame) / windowState.visibleFrames) * bounds.width;
        const x = event.clientX - bounds.left;
        const tolerance = Math.max(12, Math.min(20, bounds.width * 0.02));
        const prefix = cut ? 'cut-' : 'main-';
        if (Math.abs(x - startX) <= tolerance) return `${prefix}start`;
        if (Math.abs(x - endX) <= tolerance) return `${prefix}end`;
        return null;
    }

    function updateMainRange(edge, frame) {
        const totalFrames = waveformFrames();
        const range = state.mainRange || fullMainRange();
        const next = Math.max(0, Math.min(totalFrames, frame));
        if (edge === 'start') range.start_frame = Math.min(next, range.end_frame - 1);
        else range.end_frame = Math.max(next, range.start_frame + 1);
        state.mainRange = range;
        drawWaveform();
    }

    function updateCutRange(cutId, edge, frame) {
        const cut = state.cuts.find(value => value.id === cutId);
        if (!cut) return;
        const next = Math.max(0, Math.min(waveformFrames(), frame));
        if (edge === 'start') cut.start_frame = Math.min(next, cut.end_frame - 1);
        else cut.end_frame = Math.max(next, cut.start_frame + 1);
        const sampleRate = Number(state.editor?.sample_rate) || 44100;
        const row = [...editorCuts.querySelectorAll('[data-cut-id]')].find(value => value.dataset.cutId === cut.id);
        if (row) {
            const input = row.querySelector(`[data-cut-field="${edge}"]`);
            if (input) input.value = (cut[`${edge}_frame`] / sampleRate).toFixed(3);
        }
        syncLoopPlayback(cut);
        scheduleBoundaryAudition(cut[`${edge}_frame`]);
        drawWaveform();
    }

    function bindWaveformPointer() {
        const canvas = editorWaveformMain?.querySelector('canvas');
        if (!canvas) return;
        let startFrame = null;
        let startX = 0;
        let dragged = false;
        let mode = null;
        let panStartView = 0;
        let panVisibleFrames = 0;
        canvas.addEventListener('pointerdown', event => {
            const navigationGesture = event.button === 1 || (event.button === 0 && event.altKey);
            if (event.button !== 0 && !navigationGesture) return;
            startFrame = frameAtPointer(event, canvas);
            startX = event.clientX;
            dragged = false;
            mode = navigationGesture ? 'pan' : rangeHandleAtPointer(event, canvas) || 'cut';
            const windowState = waveformWindow();
            panStartView = windowState.startFrame;
            panVisibleFrames = windowState.visibleFrames;
            state.hoverRangeHandle = mode === 'cut' ? null : mode;
            if (mode === 'main-start' || mode === 'main-end') {
                disableCutLoop(state.selectedCutId);
                state.selectedCutId = null;
                state.editingCutLabelId = null;
                renderCuts();
                updateRenderButtons();
            }
            canvas.setPointerCapture?.(event.pointerId);
            if (mode === 'pan') {
                state.hoverRangeHandle = null;
                canvas.style.cursor = 'grabbing';
                event.preventDefault();
            }
        });
        canvas.addEventListener('pointermove', event => {
            if (startFrame === null) {
                const handle = rangeHandleAtPointer(event, canvas);
                if (handle !== state.hoverRangeHandle) {
                    state.hoverRangeHandle = handle;
                    canvas.style.cursor = handle ? 'ew-resize' : event.altKey ? 'grab' : 'crosshair';
                    drawWaveform();
                }
                return;
            }
            if (Math.abs(event.clientX - startX) > 4 || mode !== 'cut') dragged = true;
            if (!dragged) return;
            if (mode === 'pan') {
                const bounds = canvas.getBoundingClientRect();
                const deltaFrames = ((event.clientX - startX) / Math.max(1, bounds.width)) * panVisibleFrames;
                setWaveformViewStart(panStartView - deltaFrames, false);
                return;
            }
            const currentFrame = frameAtPointer(event, canvas);
            if (mode === 'main-start' || mode === 'main-end') updateMainRange(mode.replace('main-', ''), currentFrame);
            else if (mode === 'cut-start' || mode === 'cut-end') updateCutRange(state.selectedCutId, mode.replace('cut-', ''), currentFrame);
            else {
                state.draftRange = {
                    start_frame: Math.min(startFrame, currentFrame),
                    end_frame: Math.max(startFrame, currentFrame),
                };
                drawWaveform();
            }
        });
        canvas.addEventListener('pointerup', event => {
            if (startFrame !== null && dragged && mode === 'pan') scheduleDetailWaveforms(60);
            else if (startFrame !== null && dragged) markDirty();
            else if (startFrame !== null) {
                if (mode !== 'pan') seek(frameAtPointer(event, canvas) / (Number(state.editor?.sample_rate) || 44100));
            }
            startFrame = null;
            dragged = false;
            mode = null;
            state.hoverRangeHandle = null;
            canvas.style.cursor = 'crosshair';
            drawWaveform();
        });
        canvas.addEventListener('pointercancel', () => {
            if (mode === 'pan' && dragged) scheduleDetailWaveforms(60);
            cancelBoundaryAudition();
            startFrame = null;
            dragged = false;
            mode = null;
            state.hoverRangeHandle = null;
            canvas.style.cursor = 'crosshair';
            drawWaveform();
        });
        canvas.addEventListener('pointerleave', () => {
            if (startFrame !== null || !state.hoverRangeHandle) return;
            state.hoverRangeHandle = null;
            canvas.style.cursor = 'crosshair';
            drawWaveform();
        });
        canvas.addEventListener('wheel', event => {
            if (!state.editor) return;
            event.preventDefault();
            const bounds = canvas.getBoundingClientRect();
            const windowState = waveformWindow();
            const horizontalDelta = event.shiftKey ? event.deltaY : event.deltaX;
            const isHorizontalPan = event.shiftKey || Math.abs(horizontalDelta) > Math.abs(event.deltaY) * 0.75;
            if (isHorizontalPan) {
                const modeScale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16
                    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? bounds.width
                        : 1;
                const frameDelta = horizontalDelta * modeScale * windowState.visibleFrames / Math.max(1, bounds.width);
                setWaveformViewStart(windowState.startFrame + frameDelta);
                return;
            }

            const modeScale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16
                : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? bounds.height
                    : 1;
            const delta = Math.max(-160, Math.min(160, event.deltaY * modeScale));
            const pointerRatio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / Math.max(1, bounds.width)));
            const anchorFrame = windowState.startFrame + pointerRatio * windowState.visibleFrames;
            setWaveformZoom(state.waveformZoom * Math.exp(-delta * 0.002), anchorFrame, pointerRatio);
        }, { passive: false });
    }

    function openTargetMenu() {
        if (!state.session) {
            if (state.selectedEntry) openForEntry(state.selectedEntry);
            return;
        }
        renderTargetMenu();
        targetMenu.classList.toggle('hidden');
        targetButton.setAttribute('aria-expanded', String(!targetMenu.classList.contains('hidden')));
    }

    function setLayerSolo(itemId, solo) {
        const layer = state.layers.get(Number(itemId));
        if (!layer) return;
        const nextSoloLayerId = solo ? layer.item_id : null;
        if (state.soloLayerId === nextSoloLayerId) return;
        const playback = state.ownPlayback;
        state.soloLayerId = nextSoloLayerId;
        let restart = false;

        // Solo changes the playback snapshot only. When the requested layer is
        // already in the multitrack graph, change its final gains in place;
        // this avoids a needless context/media teardown during playback.
        if (playback?.kind === 'multi') {
            const now = playback.context.currentTime;
            playback.gains.forEach((gain, id) => {
                const currentLayer = state.layers.get(id);
                gain.gain.cancelScheduledValues(now);
                gain.gain.setValueAtTime(playbackLayerGain(currentLayer), now);
            });
        } else if (playback?.kind === 'audio') {
            const active = activeLayers();
            const canKeepSingleAudio = nextSoloLayerId === playback.itemId
                || (nextSoloLayerId === null && active.length === 1 && active[0].item_id === playback.itemId);
            if (canKeepSingleAudio) {
                playback.audio.muted = nextSoloLayerId === null
                    ? Boolean(state.layers.get(playback.itemId)?.muted)
                    : false;
            } else {
                restart = true;
            }
        } else if (playback) {
            restart = true;
        }

        if (restart) {
            const wasPlaying = playbackIsRunning();
            const position = currentTime();
            clearOwnPlayback(position);
            if (wasPlaying) playActiveLayers(position).catch(reportPlaybackError);
        }
        renderEditor();
    }

    function handleLayerSoloClick(event) {
        const control = event.target.closest('[data-layer-solo]');
        if (!control) return;
        const layerId = Number(control.dataset.layerId);
        setLayerSolo(layerId, state.soloLayerId !== layerId);
        event.preventDefault();
    }

    function setLayerMuted(itemId, muted) {
        const layer = state.layers.get(Number(itemId));
        const nextMuted = Boolean(muted);
        if (!layer || layer.muted === nextMuted) return;
        const playback = state.ownPlayback;
        selectLayer(layer.item_id);
        layer.muted = nextMuted;
        if (playback?.kind === 'multi') {
            const gain = playback.gains.get(layer.item_id);
            if (gain) {
                // Mute in place at the final mix boundary.  Do not tear down
                // the other layers or restart their media elements.
                const now = playback.context.currentTime;
                gain.gain.cancelScheduledValues(now);
                gain.gain.setValueAtTime(playbackLayerGain(layer), now);
            }
        } else if (playback?.kind === 'audio' && playback.itemId === layer.item_id) {
            // HTMLMediaElement.muted is an exact zero-amplitude switch.
            playback.audio.muted = state.soloLayerId === layer.item_id ? false : nextMuted;
        }
        markDirty();
        renderEditor();
    }

    function handleLayerMuteChange(event) {
        const control = event.target;
        if (!control.matches('[data-layer-muted]')) return;
        setLayerMuted(control.dataset.layerId, control.checked);
    }

    function handleLayerGainInput(event) {
        if (!event.target.matches('[data-layer-gain]')) return;
        const row = event.target.closest('[data-layer-id]');
        const layer = row ? state.layers.get(Number(row.dataset.layerId)) : null;
        if (!layer) return;
        selectLayer(layer.item_id);
        updateLayerParameter(layer.item_id, 'volume', event.target.value);
        showMixerValue(event.target);
    }

    function handleGainPointerDown(event) {
        const control = event.target.closest('[data-layer-pre-gain]');
        if (!control) return;
        const row = control.closest('[data-layer-id]');
        const layer = row ? state.layers.get(Number(row.dataset.layerId)) : null;
        if (!layer) return;
        selectLayer(layer.item_id);
        control.focus();
        control.setPointerCapture?.(event.pointerId);
        state.gainDrag = {
            pointerId: event.pointerId,
            itemId: layer.item_id,
            startX: event.clientX,
            startY: event.clientY,
            startValue: Number(layer.pre_gain_db) || 0,
        };
        showMixerValue(control);
        event.preventDefault();
    }

    function handleGainPointerMove(event) {
        const drag = state.gainDrag;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const horizontal = event.clientX - drag.startX;
        const vertical = drag.startY - event.clientY;
        const delta = Math.abs(horizontal) >= Math.abs(vertical) ? horizontal : vertical;
        updateLayerParameter(drag.itemId, 'pre_gain_db', drag.startValue + delta * 0.2);
        showMixerValue(event.target.closest('[data-layer-pre-gain]'));
    }

    function finishGainPointer(event) {
        if (state.gainDrag?.pointerId !== event.pointerId) return;
        event.target.releasePointerCapture?.(event.pointerId);
        state.gainDrag = null;
    }

    function handleGainWheel(event) {
        const control = event.target.closest('[data-layer-pre-gain]');
        if (!control) return;
        const row = control.closest('[data-layer-id]');
        const layer = row ? state.layers.get(Number(row.dataset.layerId)) : null;
        if (!layer) return;
        selectLayer(layer.item_id);
        updateLayerParameter(layer.item_id, 'pre_gain_db', (Number(layer.pre_gain_db) || 0) + (event.deltaY < 0 ? 0.5 : -0.5));
        showMixerValue(control);
        event.preventDefault();
    }

    function handleGainKeydown(event) {
        const control = event.target.closest('[data-layer-pre-gain]');
        if (!control) return;
        const row = control.closest('[data-layer-id]');
        const layer = row ? state.layers.get(Number(row.dataset.layerId)) : null;
        if (!layer) return;
        const direction = event.key === 'ArrowUp' || event.key === 'ArrowRight' ? 0.5
            : event.key === 'ArrowDown' || event.key === 'ArrowLeft' ? -0.5
                : event.key === 'Home' ? -Infinity
                    : event.key === 'End' ? Infinity
                        : null;
        if (direction === null) return;
        const next = direction === -Infinity ? MIN_GAIN_DB : direction === Infinity ? MAX_PRE_GAIN_DB : (Number(layer.pre_gain_db) || 0) + direction;
        selectLayer(layer.item_id);
        updateLayerParameter(layer.item_id, 'pre_gain_db', next);
        showMixerValue(control);
        event.preventDefault();
    }

    function resetLayerParameter(event) {
        const control = event.target.closest('[data-layer-gain], [data-layer-pre-gain]');
        if (!control) return;
        const row = control.closest('[data-layer-id]');
        const layer = row ? state.layers.get(Number(row.dataset.layerId)) : null;
        if (!layer) return;
        const key = control.matches('[data-layer-pre-gain]') ? 'pre_gain_db' : 'volume';
        selectLayer(layer.item_id);
        updateLayerParameter(layer.item_id, key, key === 'volume' ? 1 : 0);
        showMixerValue(control);
        event.preventDefault();
    }

    function selectLayerFromMixer(event) {
        if (event.target.closest('.media-editor-layer-mute, .media-editor-layer-solo')) return;
        const mixer = event.target.closest('[data-layer-mixer]');
        const row = mixer?.closest('[data-layer-id]');
        if (row) selectLayer(Number(row.dataset.layerId));
    }

    function handleCutChange(event) {
        const row = event.target.closest('[data-cut-id]');
        if (!row) return;
        const cut = state.cuts.find(value => value.id === row.dataset.cutId);
        if (!cut) return;
        const sampleRate = Number(state.editor?.sample_rate) || 44100;
        if (event.target.matches('[data-cut-field="label"]')) {
            cut.label = event.target.value.trim() || 'Cut';
            const playButton = row.querySelector('[data-cut-play]');
            playButton?.setAttribute('aria-label', `Play ${cut.label}`);
            playButton?.setAttribute('title', `Play ${cut.label} from start`);
        }
        if (event.target.matches('[data-cut-field="start"]')) cut.start_frame = Math.min(Math.round(Math.max(0, Number(event.target.value) || 0) * sampleRate), cut.end_frame - 1);
        if (event.target.matches('[data-cut-field="end"]')) cut.end_frame = Math.max(Math.round(Math.max(0, Number(event.target.value) || 0) * sampleRate), cut.start_frame + 1);
        if (event.target.matches('[data-cut-field="start"], [data-cut-field="end"]')) syncLoopPlayback(cut);
        markDirty();
        drawWaveform();
    }

    function handleCutRowClick(event) {
        const row = event.target.closest('[data-cut-id]');
        if (!row || event.target.closest('[data-cut-play], [data-cut-loop], [data-cut-export], [data-cut-remove]')) return;
        const label = event.target.closest('[data-cut-label]');
        if (label) {
            if (state.selectedCutId !== row.dataset.cutId) {
                selectCut(row.dataset.cutId);
                return;
            }
            state.editingCutLabelId = row.dataset.cutId;
            renderCuts();
            const input = editorCuts.querySelector(`[data-cut-id="${row.dataset.cutId}"] [data-cut-field="label"]`);
            input?.focus();
            input?.select();
            return;
        }
        if (event.target.closest('input')) {
            if (state.selectedCutId !== row.dataset.cutId) selectCut(row.dataset.cutId);
            return;
        }
        selectCut(row.dataset.cutId);
    }

    function requestLibraryTarget(entry) {
        if (!entry || state.pendingSwitch) return;
        const switchTarget = () => openForEntry(entry, { autoplay: true });
        if (!state.dirty) {
            switchTarget();
            return;
        }
        confirmTargetChange(sourceLabel(entry)).then(accepted => {
            if (accepted) switchTarget();
        });
    }

    function requestEditorTarget(entry) {
        if (!entry || drawer.classList.contains('hidden')) return false;
        const itemId = Number(entry?.item?.id || entry?.content?.child_id);
        const current = Number(state.currentTarget?.item_id) === itemId;
        if (current) togglePlayback();
        else requestLibraryTarget(entry);
        return true;
    }

    window.gaiaTransport = {
        requestPlay(entry) {
            return requestEditorTarget(entry);
        },
        handleCommand(detail) {
            if (!state.opened) return false;
            if (detail.command === 'toggle') togglePlayback();
            else if (detail.command === 'stop') {
                clearOwnPlayback();
                setStatus('');
                detail.handled = false;
                return true;
            }
            else if (detail.command === 'seek') seek(detail.value);
            else return false;
            detail.handled = true;
            return true;
        },
    };

    window.gaiaMediaEditor = { openForEntry, requestTarget: requestEditorTarget };

    targetButton.addEventListener('click', openTargetMenu);
    targetMenu.addEventListener('click', event => {
        const option = event.target.closest('[data-target-id]');
        if (option) switchTarget(option.dataset.targetId);
    });
    editorToggle.addEventListener('click', () => {
        if (state.opened) closeEditor();
        else openForEntry(state.selectedEntry || state.playingEntry);
    });
    editorClose.addEventListener('click', closeEditor);
    transportPlay.addEventListener('click', () => dispatchTransportCommand('toggle'));
    transportStop.addEventListener('click', () => dispatchTransportCommand('stop'));
    transportSeek.addEventListener('input', event => dispatchTransportCommand('seek', Number(event.target.value)));
    editorView.addEventListener('pointerdown', event => {
        if (!state.editor || event.button !== 0) return;
        const windowState = waveformWindow();
        state.viewDrag = {
            pointerId: event.pointerId,
            mode: editorViewPointerMode(event.clientX),
            startX: event.clientX,
            trackWidth: editorView.getBoundingClientRect().width,
            window: { ...windowState },
            moved: false,
        };
        editorView.setPointerCapture?.(event.pointerId);
        editorView.classList.add('is-dragging');
        editorView.style.cursor = state.viewDrag.mode?.startsWith('resize') ? 'ew-resize' : 'grabbing';
        event.preventDefault();
    });
    editorView.addEventListener('pointermove', event => {
        if (state.viewDrag) {
            updateEditorViewDrag(event);
            return;
        }
        const mode = editorViewPointerMode(event.clientX);
        editorView.style.cursor = mode?.startsWith('resize') ? 'ew-resize' : 'grab';
    });
    editorView.addEventListener('pointerup', finishEditorViewDrag);
    editorView.addEventListener('pointercancel', finishEditorViewDrag);
    editorView.addEventListener('pointerleave', () => {
        if (!state.viewDrag) editorView.style.cursor = state.editor ? 'grab' : 'default';
    });
    editorView.addEventListener('keydown', moveEditorViewByKeyboard);
    editorAddCut.addEventListener('click', addCut);
    editorMixerRail.addEventListener('change', handleLayerMuteChange);
    editorMixerRail.addEventListener('click', handleLayerSoloClick);
    editorMixerRail.addEventListener('input', handleLayerGainInput);
    editorMixerRail.addEventListener('pointerdown', selectLayerFromMixer);
    editorMixerRail.addEventListener('pointerdown', handleGainPointerDown);
    editorMixerRail.addEventListener('pointermove', handleGainPointerMove);
    editorMixerRail.addEventListener('pointerup', finishGainPointer);
    editorMixerRail.addEventListener('pointercancel', finishGainPointer);
    editorMixerRail.addEventListener('wheel', handleGainWheel, { passive: false });
    editorMixerRail.addEventListener('keydown', handleGainKeydown);
    editorMixerRail.addEventListener('dblclick', resetLayerParameter);
    editorCuts.addEventListener('change', handleCutChange);
    editorCuts.addEventListener('input', handleCutChange);
    editorCuts.addEventListener('click', handleCutRowClick);
    editorZoomOut.addEventListener('click', () => setWaveformZoom(state.waveformZoom / ZOOM_BUTTON_FACTOR));
    editorZoomIn.addEventListener('click', () => setWaveformZoom(state.waveformZoom * ZOOM_BUTTON_FACTOR));
    editorZoomFit.addEventListener('click', () => setWaveformZoom(1));
    editorCuts.addEventListener('click', event => {
        const play = event.target.closest('[data-cut-play]');
        if (play) {
            const row = play.closest('[data-cut-id]');
            const cut = state.cuts.find(value => value.id === row?.dataset.cutId);
            if (cut) playCut(cut);
            return;
        }
        const loop = event.target.closest('[data-cut-loop]');
        if (loop) {
            const row = loop.closest('[data-cut-id]');
            const cut = state.cuts.find(value => value.id === row?.dataset.cutId);
            if (cut) toggleCutLoop(cut);
            return;
        }
        const exportButton = event.target.closest('[data-cut-export]');
        if (exportButton) {
            const row = exportButton.closest('[data-cut-id]');
            if (row) exportCut(row.dataset.cutId);
            return;
        }
        const remove = event.target.closest('[data-cut-remove]');
        if (!remove) return;
        const row = remove.closest('[data-cut-id]');
        disableCutLoop(row?.dataset.cutId);
        state.cuts = state.cuts.filter(cut => cut.id !== row.dataset.cutId);
        if (state.selectedCutId === row.dataset.cutId) {
            state.selectedCutId = null;
            state.editingCutLabelId = null;
            state.selectedLayerId = defaultSelectedLayerId();
        }
        markDirty();
        editorNormalize.disabled = !state.editor || !selectedLayer();
        updateRenderButtons();
        renderLayers();
        renderCuts();
        drawWaveform();
        renderTransport();
    });
    editorNormalize.addEventListener('click', () => {
        normalizeSelectedLayer();
    });
    editorSave.addEventListener('click', async () => {
        if (activeProjectId()) await saveProjectState(activeProjectId(), { force: true });
        else await openDestinationDialog('main', 'save');
    });
    editorRender.addEventListener('click', () => openDestinationDialog('main'));
    editorRenderAll.addEventListener('click', () => openDestinationDialog('all'));
    destinationForm.addEventListener('change', event => {
        updateDestinationFields();
        if (event.target === projectVault) {
            populateProjects(projectVault.value);
        }
    });
    destinationForm.addEventListener('submit', async event => {
        event.preventDefault();
        const mode = destinationMode();
        if (mode === 'project' && !projectName.value.trim()) {
            destinationResult.textContent = 'Enter a project name.';
            destinationResult.className = 'result error';
            return;
        }
        if (mode === 'existing_project' && (!projectExistingSelect || !projectExistingSelect.value)) {
            destinationResult.textContent = 'Select a project.';
            destinationResult.className = 'result error';
            return;
        }
        if (state.destinationAction === 'save') {
            destinationSubmit.disabled = true;
            destinationResult.textContent = mode === 'existing_project' ? 'Saving progress to project…' : 'Creating project and saving progress…';
            destinationResult.className = 'result';
            try {
                if (mode === 'existing_project') {
                    const existingId = Number(projectExistingSelect.value);
                    await addSourceToProject(existingId, projectSourceId());
                    const saved = await saveProjectState(existingId, { force: true });
                    if (!saved) throw new Error('Could not save editor progress to project');
                    await loadSession(existingId, `item:${projectSourceId()}`);
                    window.dispatchEvent(new CustomEvent('gaia:library-refresh'));
                    setStatus('Progress saved to project');
                } else {
                    await createFocusedProject(
                        projectName.value.trim(),
                        projectVault.value,
                        projectMove.checked,
                        projectSourceId(),
                    );
                }
                destinationDialog.close();
            } catch (error) {
                destinationResult.textContent = error.message || 'Could not save editor progress';
                destinationResult.className = 'result error';
            } finally {
                destinationSubmit.disabled = false;
            }
            return;
        }
        await submitRender({
            mode,
            projectId: mode === 'existing_project' ? Number(projectExistingSelect.value) : null,
            projectNameValue: projectName.value.trim(),
            vaultId: projectVault.value,
            moveSource: projectMove.checked,
            scope: state.renderScope,
        });
    });
    destinationClose.addEventListener('click', () => destinationDialog.close());
    destinationCancel.addEventListener('click', () => destinationDialog.close());
    destinationDialog.addEventListener('click', event => { if (event.target === destinationDialog) destinationDialog.close(); });
    function finishSwitchPrompt(accepted) {
        const pending = state.pendingSwitch;
        state.pendingSwitch = null;
        switchDialog.close();
        pending?.resolve(accepted);
    }
    switchConfirm.addEventListener('click', () => finishSwitchPrompt(true));
    switchStay.addEventListener('click', () => finishSwitchPrompt(false));
    switchClose.addEventListener('click', () => finishSwitchPrompt(false));
    switchDialog.addEventListener('click', event => {
        if (event.target === switchDialog) finishSwitchPrompt(false);
    });
    renderConflictOverride.addEventListener('click', () => finishRenderConflictPrompt('override'));
    renderConflictNewVersion.addEventListener('click', () => finishRenderConflictPrompt('new_version'));
    renderConflictCancel.addEventListener('click', () => finishRenderConflictPrompt(null));
    renderConflictClose.addEventListener('click', () => finishRenderConflictPrompt(null));
    renderConflictDialog.addEventListener('click', event => {
        if (event.target === renderConflictDialog) finishRenderConflictPrompt(null);
    });
    renderConflictDialog.addEventListener('cancel', event => {
        event.preventDefault();
        finishRenderConflictPrompt(null);
    });
    document.addEventListener('click', event => {
        if (!event.target.closest('.media-target-wrap')) {
            targetMenu.classList.add('hidden');
            targetButton.setAttribute('aria-expanded', 'false');
        }
    });
    window.addEventListener('resize', () => {
        renderZoomControls();
        drawWaveform();
        scheduleDetailWaveforms(180);
    });
    window.addEventListener('gaia:selection', event => {
        state.selectedEntry = event.detail?.entry || null;
        if (!state.opened) {
            targetButton.disabled = !state.selectedEntry && !state.playingEntry;
            editorToggle.disabled = !state.selectedEntry && !state.playingEntry;
        }
    });
    window.addEventListener('gaia:play', event => {
        bindExternalAudio(event.detail?.audio, event.detail?.entry);
    });
    window.addEventListener('gaia:stop', () => {
        if (state.externalAudio) state.playheadTime = Number(state.externalAudio.currentTime) || state.playheadTime;
        state.externalAudio = null;
        state.playingEntry = null;
        renderTransport();
    });
    window.addEventListener('keydown', event => {
        if (event.code === 'Space' && state.opened && !event.target.matches('input, textarea, select')) {
            event.preventDefault();
            togglePlayback();
        }
    });

    bindWaveformPointer();
    renderTransport();
})();
