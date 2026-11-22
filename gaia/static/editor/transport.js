import { WaveformScrubCanvas, renderIcon } from '/packages/ui/src/index.js?v=2';

function $(id) {
    return document.getElementById(id);
}

export function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const whole = Math.floor(seconds);
    const mins = Math.floor(whole / 60);
    const secs = whole % 60;
    return `${mins}:${String(secs).padStart(2, '0')}`;
}

export function formatPreciseTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00.000';
    const mins = Math.floor(seconds / 60);
    const rem = seconds - mins * 60;
    const whole = Math.floor(rem);
    const ms = Math.round((rem - whole) * 1000);
    return `${mins}:${String(whole).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

function escapeHtml(text) {
    return String(text ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}

const MAX_WAVEFORM_CACHE = 48;

export function createTransportController() {
    const playButton = $('media-transport-play');
    const stopButton = $('media-transport-stop');
    const cueButton = $('media-transport-cue');
    const timeLabel = $('media-transport-time');
    const waveformContainer = $('media-transport-waveform');
    const targetButton = $('media-target-button');
    const targetLabel = $('media-target-label');
    const targetMenu = $('media-target-menu');
    const dock = $('media-editor-dock');

    // Quick video preview popover (used only when user clicks Preview on a video row outside the editor drawer)
    let quickVideoBox = null;
    let quickVideoEl = null;
    let quickVideoEntry = null;

    let customDriver = null;
    let selectedEntryLabel = null;
    let selectedEntryPlayable = false;
    let editorOpen = false;
    let seeking = false;
    let seekStartedPlaying = false;
    let seekHoldUntil = 0;
    let seekHoldValue = 0;
    let seekBreathTimer = null;
    let lastSeekSentAt = 0;
    let pendingSeekVal = null;
    let lastTargetMenuKey = '';
    let lastRenderedLabel = '';
    let lastTrackIdentity = '';
    let lastPlayingIconState = null;
    let rafId = null;

    // Transport waveform cache + abort tracking
    const waveformCache = new Map();
    let waveformAbortController = null;
    let activeWaveformKey = '';

    // Ableton-style Cue state (active ONLY while editor drawer is open):
    // when toggled ON, Stop/Pause returns playhead to the last clicked Cue point and Play starts from Cue.
    const CUE_STORAGE_KEY = 'gaia_transport_cue_enabled';
    let cueEnabled = false;
    try {
        cueEnabled = window.localStorage?.getItem(CUE_STORAGE_KEY) === '1';
    } catch {
        cueEnabled = false;
    }
    let cuePointSec = 0;
    let lastDurationSec = 0;
    const cueListeners = new Set();

    if (stopButton) {
        stopButton.innerHTML = renderIcon('stop');
    }

    function isCueActive() {
        return Boolean(cueEnabled && editorOpen);
    }

    function resetTransientSeek() {
        seeking = false;
        seekStartedPlaying = false;
        seekHoldUntil = 0;
        seekHoldValue = 0;
        pendingSeekVal = null;
        if (seekBreathTimer !== null) {
            window.clearTimeout(seekBreathTimer);
            seekBreathTimer = null;
        }
    }

    let waveformScrub = null;

    function emitCueChange() {
        updateCueUi();
        const active = isCueActive();
        for (const cb of cueListeners) {
            try { cb({ enabled: active, cuePointSec }); } catch { /* ignore */ }
        }
    }

    function updateCueUi() {
        if (cueButton) {
            cueButton.classList.toggle('hidden', !editorOpen);
            cueButton.classList.toggle('active', cueEnabled);
            cueButton.classList.toggle('is-active', cueEnabled);
            cueButton.setAttribute('aria-pressed', String(cueEnabled));
            cueButton.title = cueEnabled
                ? 'Cue ON — Stop & Play return to the clicked cue point'
                : 'Cue OFF — enable to return to the clicked start point on Stop & Play';
        }
        waveformScrub?.setCue(cuePointSec, isCueActive());
    }

    function setCueEnabled(next) {
        const val = Boolean(next);
        if (cueEnabled === val) return;
        cueEnabled = val;
        try {
            window.localStorage?.setItem(CUE_STORAGE_KEY, cueEnabled ? '1' : '0');
        } catch { /* ignore */ }
        emitCueChange();
    }

    function setEditorOpen(next) {
        const val = Boolean(next);
        if (editorOpen === val) return;
        editorOpen = val;
        if (!editorOpen) {
            cuePointSec = 0;
            resetTransientSeek();
        }
        emitCueChange();
        render();
    }

    function setCuePoint(seconds) {
        if (!editorOpen) return;
        const num = Math.max(0, Number(seconds) || 0);
        const clamped = lastDurationSec > 0 ? Math.min(lastDurationSec, num) : num;
        if (Math.abs(clamped - cuePointSec) < 1e-4) return;
        cuePointSec = clamped;
        emitCueChange();
    }

    cueButton?.addEventListener('click', event => {
        setCueEnabled(!cueEnabled);
        if (event.detail > 0) cueButton.blur();
    });

    function dispatchSeekNow(val, { scrubbing = false, keepPlaying = null, setCue = false } = {}) {
        lastSeekSentAt = performance.now();
        pendingSeekVal = null;
        if (seekBreathTimer !== null) {
            window.clearTimeout(seekBreathTimer);
            seekBreathTimer = null;
        }
        seekHoldValue = val;
        seekHoldUntil = performance.now() + 140;
        if (setCue && editorOpen) {
            setCuePoint(val);
        }
        if (customDriver) {
            customDriver.seek?.(val, { scrubbing, keepPlaying });
        } else if (quickVideoEl && quickVideoEntry) {
            quickVideoEl.currentTime = val;
        } else {
            window.dispatchEvent(new CustomEvent('gaia:transport-command', { detail: { command: 'seek', value: val } }));
        }
    }

    function scheduleSeek(val, { scrubbing = true, immediate = false, keepPlaying = null, setCue = false } = {}) {
        if (immediate) {
            dispatchSeekNow(val, { scrubbing, keepPlaying, setCue });
            return;
        }
        const elapsed = performance.now() - lastSeekSentAt;
        if (elapsed >= 40) {
            dispatchSeekNow(val, { scrubbing, keepPlaying, setCue });
            return;
        }
        pendingSeekVal = { val, scrubbing, keepPlaying, setCue };
        if (seekBreathTimer === null) {
            seekBreathTimer = window.setTimeout(() => {
                seekBreathTimer = null;
                if (pendingSeekVal !== null) {
                    const next = pendingSeekVal;
                    pendingSeekVal = null;
                    dispatchSeekNow(next.val, {
                        scrubbing: next.scrubbing,
                        keepPlaying: next.keepPlaying,
                        setCue: next.setCue,
                    });
                }
            }, Math.max(8, 40 - elapsed));
        }
    }

    if (waveformContainer) {
        waveformScrub = new WaveformScrubCanvas(waveformContainer, {
            emptyMessage: 'No media selected',
            ariaLabel: 'Playback position',
            onSeekStart() {
                seeking = true;
                seekStartedPlaying = Boolean(currentSnapshot()?.playing);
            },
            onSeek(progress, meta) {
                const dur = waveformScrub?.duration || lastDurationSec || 0;
                const val = progress * dur;
                if (timeLabel) timeLabel.textContent = `${formatTime(val)} / ${formatTime(dur)}`;
                if (meta?.scrubbing) {
                    scheduleSeek(val, { scrubbing: true, keepPlaying: seeking ? seekStartedPlaying : null });
                } else {
                    dispatchSeekNow(val, { scrubbing: false, keepPlaying: seekStartedPlaying, setCue: true });
                }
            },
            onSeekEnd(progress) {
                if (!seeking) return;
                const keepPlaying = seekStartedPlaying;
                seeking = false;
                const dur = waveformScrub?.duration || lastDurationSec || 0;
                const val = progress * dur;
                dispatchSeekNow(val, { scrubbing: false, keepPlaying, setCue: true });
                render();
            },
        });
    }

    function setWaveformPeaks(pairs, durationSec = 0) {
        if (!waveformScrub) return;
        activeWaveformKey = '__explicit__';
        waveformAbortController?.abort();
        waveformAbortController = null;
        const dur = Math.max(0, Number(durationSec) || lastDurationSec || 0);
        if (Array.isArray(pairs) && pairs.length > 0) {
            waveformScrub.setPeakPairs(pairs, dur);
        } else if (dur > 0) {
            waveformScrub.setProgressOnly(dur, '');
        } else {
            waveformScrub.clear('No media selected');
        }
    }

    function setWaveformAudioBuffer(buffer, durationSec = 0) {
        if (!waveformScrub) return;
        activeWaveformKey = '__buffer__';
        waveformAbortController?.abort();
        waveformAbortController = null;
        if (buffer) {
            waveformScrub.setAudioBuffer(buffer, durationSec || buffer.duration);
        } else {
            waveformScrub.clear('No media selected');
        }
    }

    function setWaveformProgressOnly(durationSec = 0, message = '') {
        if (!waveformScrub) return;
        activeWaveformKey = '__progress__';
        waveformAbortController?.abort();
        waveformAbortController = null;
        waveformScrub.setProgressOnly(Math.max(0, Number(durationSec) || 0), message);
    }

    function clearWaveform(message = 'No media selected') {
        if (!waveformScrub) return;
        activeWaveformKey = '';
        waveformAbortController?.abort();
        waveformAbortController = null;
        waveformScrub.clear(message);
    }

    async function loadWaveformForItem(itemId, durationSec = 0) {
        if (!waveformScrub) return;
        const idNum = Number(itemId);
        if (!Number.isFinite(idNum) || idNum <= 0) {
            if (durationSec > 0) {
                setWaveformProgressOnly(durationSec, '');
            } else {
                clearWaveform('No media selected');
            }
            return;
        }
        const key = String(idNum);
        if (waveformAbortController && activeWaveformKey === key) {
            return;
        }
        activeWaveformKey = key;
        const cached = waveformCache.get(key);
        if (cached) {
            waveformCache.delete(key);
            waveformCache.set(key, cached);
            const dur = Math.max(0, Number(cached.duration_seconds || cached.duration_sec || durationSec) || 0);
            waveformScrub.setPeakPairs(cached.peaks, dur);
            return;
        }

        waveformAbortController?.abort();
        const controller = new AbortController();
        waveformAbortController = controller;
        if (durationSec > 0) {
            waveformScrub.setProgressOnly(durationSec, '');
        } else {
            waveformScrub.setMessage('Loading waveform...');
        }

        try {
            const res = await fetch(`/items/${encodeURIComponent(key)}/waveform?resolution=400`, {
                signal: controller.signal,
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (controller.signal.aborted || activeWaveformKey !== key) return;
            const peaks = Array.isArray(data?.peaks) ? data.peaks : [];
            const dur = Math.max(0, Number(data?.duration_seconds || data?.duration_sec || durationSec) || 0);
            waveformCache.set(key, { peaks, duration_sec: dur });
            if (waveformCache.size > MAX_WAVEFORM_CACHE) {
                const oldestKey = waveformCache.keys().next().value;
                waveformCache.delete(oldestKey);
            }
            if (peaks.length > 0) {
                waveformScrub.setPeakPairs(peaks, dur);
            } else if (dur > 0) {
                waveformScrub.setProgressOnly(dur, '');
            } else {
                waveformScrub.clear('No waveform');
            }
        } catch (err) {
            if (err?.name === 'AbortError') return;
            if (activeWaveformKey === key) {
                if (durationSec > 0) {
                    waveformScrub.setProgressOnly(durationSec, '');
                } else {
                    waveformScrub.clear('Waveform unavailable');
                }
            }
        } finally {
            if (waveformAbortController === controller) {
                waveformAbortController = null;
            }
        }
    }

    function ensureQuickVideoBox() {
        if (quickVideoBox) return quickVideoBox;
        quickVideoBox = document.createElement('div');
        quickVideoBox.id = 'video-quick-preview';
        quickVideoBox.className = 'video-quick-preview hidden';
        quickVideoBox.innerHTML = `
            <div class="video-quick-preview-header">
                <strong id="video-quick-preview-title">Video preview</strong>
                <div class="video-quick-preview-actions">
                    <button id="video-quick-preview-open" class="ui-btn ui-btn--bordered secondary micro-btn" type="button">Edit</button>
                    <button id="video-quick-preview-close" class="ui-btn ui-btn--icon ui-btn--bordered secondary icon-button" type="button" aria-label="Close video preview">${renderIcon('close')}</button>
                </div>
            </div>
            <video id="video-quick-preview-el" class="video-quick-preview-player" preload="metadata" playsinline></video>
        `;
        if (dock) {
            dock.insertBefore(quickVideoBox, dock.firstChild);
        } else {
            document.body.appendChild(quickVideoBox);
        }
        quickVideoEl = quickVideoBox.querySelector('#video-quick-preview-el');
        quickVideoEl.addEventListener('timeupdate', render);
        quickVideoEl.addEventListener('loadedmetadata', render);
        quickVideoEl.addEventListener('play', () => {
            ensureTicker();
            render();
        });
        quickVideoEl.addEventListener('pause', render);
        quickVideoEl.addEventListener('ended', render);
        quickVideoEl.addEventListener('click', () => {
            if (!quickVideoEl) return;
            if (quickVideoEl.paused) quickVideoEl.play().catch(() => { });
            else quickVideoEl.pause();
        });
        quickVideoBox.querySelector('#video-quick-preview-close')?.addEventListener('click', () => {
            closeQuickVideo();
        });
        quickVideoBox.querySelector('#video-quick-preview-open')?.addEventListener('click', () => {
            const targetEntry = quickVideoEntry;
            closeQuickVideo();
            if (targetEntry) {
                window.gaiaEditorHost?.openForEntry?.(targetEntry);
            }
        });
        return quickVideoBox;
    }

    function closeQuickVideo() {
        if (quickVideoEl) {
            try {
                quickVideoEl.pause();
                quickVideoEl.removeAttribute('src');
                quickVideoEl.load();
            } catch {
                // Ignore media reset errors
            }
        }
        quickVideoEntry = null;
        if (quickVideoBox) quickVideoBox.classList.add('hidden');
        render();
    }

    function openQuickVideo(entry) {
        const box = ensureQuickVideoBox();
        const item = entry?.item || entry;
        if (!item?.id) return;
        // Stop any library audio first
        window.dispatchEvent(new CustomEvent('gaia:transport-command', { detail: { command: 'stop' } }));
        quickVideoEntry = entry;
        setWaveformProgressOnly(Number(item.duration_seconds) || 0, '');
        const titleEl = box.querySelector('#video-quick-preview-title');
        if (titleEl) {
            titleEl.textContent = item.title || item.filename || `Video #${item.id}`;
        }
        if (quickVideoEl) {
            quickVideoEl.src = `/items/${item.id}/stream`;
            box.classList.remove('hidden');
            quickVideoEl.play().catch(() => {
                // Autoplay policy can pause initial video; user can still click Play
            });
        }
        render();
    }

    function currentSnapshot() {
        if (customDriver) {
            try {
                return customDriver.getState();
            } catch {
                return { hasPlayback: false, playing: false, currentTime: 0, duration: 0 };
            }
        }
        if (quickVideoEl && quickVideoEntry) {
            const duration = Number.isFinite(quickVideoEl.duration) ? quickVideoEl.duration : 0;
            const currentTime = Number.isFinite(quickVideoEl.currentTime) ? quickVideoEl.currentTime : 0;
            return {
                hasPlayback: true,
                playing: !quickVideoEl.paused && !quickVideoEl.ended,
                currentTime,
                duration,
            };
        }
        return { hasPlayback: false, playing: false, currentTime: 0, duration: 0 };
    }

    function stopTicker() {
        if (rafId !== null) {
            cancelAnimationFrame(rafId);
            rafId = null;
        }
    }

    function ensureTicker() {
        if (rafId !== null) return;
        const tick = () => {
            const snap = currentSnapshot();
            renderState(snap);
            if (snap.playing) {
                rafId = requestAnimationFrame(tick);
            } else {
                rafId = null;
            }
        };
        rafId = requestAnimationFrame(tick);
    }

    function renderTargetSelector(targets, activeTargetId, fallbackLabel = null) {
        if (!targetButton || !targetLabel || !targetMenu) return;
        const list = Array.isArray(targets) ? targets : [];
        targetButton.classList.remove('hidden');
        targetButton.disabled = list.length <= 1;
        if (list.length <= 1) {
            targetMenu.classList.add('hidden');
            targetButton.setAttribute('aria-expanded', 'false');
        }
        const active = list.find(t => t.id === activeTargetId) || list[0] || null;
        const label = active?.label
            || fallbackLabel
            || quickVideoEntry?.title
            || selectedEntryLabel
            || 'No media';
        if (lastRenderedLabel !== label) {
            lastRenderedLabel = label;
            targetLabel.textContent = label;
        }
        const menuKey = list.length > 1
            ? `${active?.id || ''}|${list.map(t => `${t.id}:${t.label}:${t.role || t.media_kind || ''}`).join('|')}`
            : '';
        if (menuKey !== lastTargetMenuKey) {
            lastTargetMenuKey = menuKey;
            if (list.length > 1) {
                targetMenu.innerHTML = list.map(t => `
                    <button class="media-target-option sin-menu-item${t.id === active?.id ? ' active' : ''}"
                        type="button" role="option" aria-selected="${t.id === active?.id}"
                        data-target-id="${escapeHtml(t.id)}">
                        <span>${escapeHtml(t.label)}</span>
                        <small>${escapeHtml(t.role || t.media_kind || '')}</small>
                    </button>
                `).join('');
            } else {
                targetMenu.innerHTML = '';
            }
        }
    }

    function renderState(snap) {
        const hasPlayback = Boolean(snap?.hasPlayback);
        const playing = Boolean(snap?.playing);
        const duration = hasPlayback ? Math.max(0, Number(snap?.duration) || 0) : 0;
        const trackId = `${hasPlayback ? 1 : 0}|${snap?.activeTargetId || ''}|${snap?.targetLabel || ''}|${Math.round(duration * 10)}`;
        if (trackId !== lastTrackIdentity) {
            lastTrackIdentity = trackId;
            if (!seeking) {
                seekHoldUntil = 0;
                seekHoldValue = 0;
            }
        }
        lastDurationSec = duration;
        if (duration > 0 && cuePointSec > duration) {
            cuePointSec = 0;
        }
        const rawTime = hasPlayback
            ? Math.max(0, duration > 0 ? Math.min(duration, Number(snap?.currentTime) || 0) : (Number(snap?.currentTime) || 0))
            : 0;
        const now = performance.now();
        const holdingSeek = !seeking && hasPlayback && now < seekHoldUntil && Math.abs(rawTime - seekHoldValue) > 0.12;
        const time = holdingSeek ? (duration > 0 ? Math.min(duration, seekHoldValue) : seekHoldValue) : rawTime;
        const canStartPlay = hasPlayback || (!editorOpen && selectedEntryPlayable);

        if (playButton) {
            playButton.disabled = !canStartPlay;
            if (lastPlayingIconState !== playing) {
                lastPlayingIconState = playing;
                playButton.innerHTML = renderIcon(playing ? 'pause' : 'play');
            }
            playButton.classList.toggle('is-active', playing);
            playButton.setAttribute('aria-label', playing ? 'Pause' : 'Play');
        }
        if (stopButton) {
            stopButton.disabled = !hasPlayback;
        }
        if (waveformScrub && !seeking) {
            if (hasPlayback) {
                waveformScrub.setPlayback(time, duration > 0 ? duration : waveformScrub.duration);
            } else if (!selectedEntryPlayable && !editorOpen) {
                waveformScrub.setPlayback(0, 0);
            } else {
                waveformScrub.setPlayback(0, waveformScrub.duration);
            }
        }
        updateCueUi();
        if (timeLabel && !seeking) {
            timeLabel.textContent = hasPlayback
                ? `${formatTime(time)} / ${formatTime(duration)}`
                : '0:00 / 0:00';
        }
        if (snap && 'targets' in snap) {
            renderTargetSelector(snap.targets, snap.activeTargetId, snap.targetLabel || null);
        } else {
            renderTargetSelector([], null, snap?.targetLabel || null);
        }
    }

    function render() {
        const snap = currentSnapshot();
        renderState(snap);
        if (snap.playing) {
            ensureTicker();
        } else {
            stopTicker();
        }
    }

    function togglePlayPause() {
        if (customDriver) {
            customDriver.playPause?.();
            render();
            return true;
        }
        if (quickVideoEl && quickVideoEntry) {
            if (quickVideoEl.paused || quickVideoEl.ended) {
                quickVideoEl.play().catch(() => { });
            } else {
                quickVideoEl.pause();
            }
            render();
            return true;
        }
        window.dispatchEvent(new CustomEvent('gaia:transport-command', { detail: { command: 'play-selected' } }));
        return true;
    }

    playButton?.addEventListener('click', event => {
        togglePlayPause();
        if (event.detail > 0) playButton.blur();
    });

    stopButton?.addEventListener('click', event => {
        if (event.detail > 0) stopButton.blur();
        if (customDriver) {
            customDriver.stop?.();
            render();
            return;
        }
        if (quickVideoEl && quickVideoEntry) {
            quickVideoEl.pause();
            quickVideoEl.currentTime = 0;
            render();
            return;
        }
        window.dispatchEvent(new CustomEvent('gaia:transport-command', { detail: { command: 'stop' } }));
    });

    function isTextEntryElement(el) {
        if (!el) return false;
        if (el.isContentEditable) return true;
        const tag = el.tagName;
        if (tag === 'TEXTAREA') return true;
        if (tag === 'INPUT') {
            const type = String(el.type || 'text').toLowerCase();
            return !['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file'].includes(type);
        }
        return false;
    }

    function isModalDialogOpen() {
        return Boolean(document.querySelector('dialog[open]'));
    }

    window.addEventListener('keydown', event => {
        if (event.code !== 'Space' && event.key !== ' ') return;
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (isTextEntryElement(document.activeElement) || isModalDialogOpen()) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.repeat) return;
        togglePlayPause();
    }, { capture: true });

    window.addEventListener('keyup', event => {
        if (event.code !== 'Space' && event.key !== ' ') return;
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (isTextEntryElement(document.activeElement) || isModalDialogOpen()) return;
        event.preventDefault();
        event.stopImmediatePropagation();
    }, { capture: true });

    targetButton?.addEventListener('click', event => {
        event.stopPropagation();
        if (!targetMenu) return;
        const open = targetMenu.classList.toggle('hidden') === false;
        targetButton.setAttribute('aria-expanded', String(open));
    });

    targetMenu?.addEventListener('click', event => {
        const btn = event.target.closest('[data-target-id]');
        if (!btn) return;
        const targetId = btn.dataset.targetId;
        targetMenu.classList.add('hidden');
        targetButton?.setAttribute('aria-expanded', 'false');
        customDriver?.selectTarget?.(targetId);
    });

    document.addEventListener('click', event => {
        if (targetMenu && !targetMenu.classList.contains('hidden')) {
            if (!targetMenu.contains(event.target) && !targetButton?.contains(event.target)) {
                targetMenu.classList.add('hidden');
                targetButton?.setAttribute('aria-expanded', 'false');
            }
        }
    });

    window.addEventListener('gaia:selection', event => {
        const entry = event.detail?.entry || null;
        const item = entry?.item || entry?.content || entry;
        const itemId = entry?.content?.child_id || entry?.item?.id || entry?.itemId || (Number.isFinite(Number(entry?.id)) ? Number(entry.id) : null);
        const itemType = String(entry?.type || entry?.item?.type || entry?.content?.type || '').toLowerCase();
        const durationSec = Number(item?.duration_seconds || item?.duration || 0);

        selectedEntryLabel = entry?.title || entry?.item?.title || null;
        selectedEntryPlayable = Boolean(
            event.detail?.playable
            ?? (entry && ['audio', 'track', 'sample', 'video', 'multitrack', 'zoom_h4', 'project'].includes(itemType))
        );
        if (!customDriver) {
            if (itemType === 'video' || entry?.media_kind === 'video') {
                setWaveformProgressOnly(durationSec, 'Video');
            } else if (selectedEntryPlayable && itemId && !['project', 'multitrack', 'zoom_h4'].includes(itemType)) {
                void loadWaveformForItem(itemId, durationSec);
            } else if (selectedEntryPlayable) {
                setWaveformProgressOnly(durationSec, itemType ? itemType.replace('_', ' ') : '');
            } else {
                clearWaveform('No media selected');
            }
            render();
        }
    });

    window.addEventListener('gaia:stop', () => {
        resetTransientSeek();
        closeQuickVideo();
        render();
    });

    function requestPlay(entry) {
        if (window.gaiaEditorHost?.isOpen?.()) {
            void window.gaiaEditorHost.requestTarget?.(entry);
            return true;
        }
        const itemType = entry?.type || entry?.item?.type || entry?.content?.type || '';
        if (itemType === 'video') {
            openQuickVideo(entry);
            return true;
        }
        return false;
    }

    function handleCommand(detail) {
        if (!detail || typeof detail !== 'object') return false;
        if (customDriver) {
            if (detail.command === 'toggle') customDriver.playPause?.();
            else if (detail.command === 'stop') customDriver.stop?.();
            else if (detail.command === 'seek') customDriver.seek?.(detail.value);
            else return false;
            detail.handled = true;
            render();
            return true;
        }
        if (quickVideoEl && quickVideoEntry) {
            if (detail.command === 'toggle') {
                if (quickVideoEl.paused || quickVideoEl.ended) quickVideoEl.play().catch(() => { });
                else quickVideoEl.pause();
            } else if (detail.command === 'stop') {
                quickVideoEl.pause();
                quickVideoEl.currentTime = 0;
            } else if (detail.command === 'seek') {
                quickVideoEl.currentTime = Math.max(0, Number(detail.value) || 0);
            } else {
                return false;
            }
            detail.handled = true;
            render();
            return true;
        }
        return false;
    }

    const controller = {
        setCustomDriver(driver) {
            closeQuickVideo();
            resetTransientSeek();
            customDriver = driver || null;
            cuePointSec = 0;
            lastTrackIdentity = '';
            if (targetMenu) {
                targetMenu.classList.add('hidden');
                targetButton?.setAttribute('aria-expanded', 'false');
            }
            render();
        },
        clearCustomDriver(driver) {
            if (!driver || customDriver === driver) {
                resetTransientSeek();
                customDriver = null;
                cuePointSec = 0;
                lastTrackIdentity = '';
                if (targetMenu) {
                    targetMenu.classList.add('hidden');
                    targetButton?.setAttribute('aria-expanded', 'false');
                }
                render();
            }
        },
        setEditorOpen,
        isEditorOpen: () => editorOpen,
        isCueEnabled: () => isCueActive(),
        setCueEnabled,
        getCuePoint: () => cuePointSec,
        setCuePoint,
        onCueChange(cb) {
            if (typeof cb !== 'function') return () => { };
            cueListeners.add(cb);
            return () => cueListeners.delete(cb);
        },
        setWaveformPeaks,
        setWaveformAudioBuffer,
        setWaveformProgressOnly,
        loadWaveformForItem,
        clearWaveform,
        isFooterSeeking: () => seeking,
        togglePlayPause,
        requestPlay,
        handleCommand,
        openQuickVideo,
        closeQuickVideo,
        render,
    };

    window.gaiaTransport = controller;
    render();
    return controller;
}
