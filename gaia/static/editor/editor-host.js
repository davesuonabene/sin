function $(id) {
    return document.getElementById(id);
}

const OPENABLE_TYPES = new Set([
    'project',
    'audio',
    'track',
    'sample',
    'video',
    'multitrack',
    'zoom_h4',
    'folder',
]);

function resolveEntryItemId(entry) {
    if (!entry) return null;
    if (entry.kind === 'content') {
        return entry.content?.child_id || entry.collection?.id || null;
    }
    return entry.item?.id || entry.itemId || entry.collection?.id || (Number.isFinite(Number(entry.id)) ? Number(entry.id) : null);
}

function isEntryOpenable(entry) {
    if (!entry) return false;
    const item = entry.kind === 'content' ? entry.content : entry.item;
    if (item && (item.availability || 'ready') !== 'ready') return false;
    if (entry.kind === 'content') return Boolean(entry.content?.streamable || entry.content?.child_id);
    return OPENABLE_TYPES.has(entry.type) || Boolean(entry.item?.id && OPENABLE_TYPES.has(entry.item.type));
}

export function createEditorHost({ exportModal, transport }) {
    const drawer = $('media-editor-drawer');
    const titleEl = $('media-editor-title');
    const detailEl = $('media-editor-detail');
    const modePill = $('editor-mode-pill');
    const statusEl = $('media-editor-status');
    const trackInfoEl = $('media-editor-track-info');
    const targetSelect = $('editor-target-select');
    const checkpointsWrap = $('editor-checkpoints-wrap');
    const checkpointSelect = $('editor-checkpoint-select');
    const checkpointSaveBtn = $('editor-checkpoint-save');
    const checkpointRestoreBtn = $('editor-checkpoint-restore');
    const checkpointDeleteBtn = $('editor-checkpoint-delete');
    const saveBtn = $('editor-save-btn');
    const saveAsProjectBtn = $('editor-save-as-project-btn');
    const closeBtn = $('media-editor-close');
    const viewport = $('editor-engine-viewport');
    const toggleBtn = $('media-editor-toggle');

    const engines = new Map();
    let currentSession = null;
    let currentEntry = null;
    let selectedLibraryEntry = null;
    let mountedEngine = null;
    let dirty = false;
    let opened = false;
    let statusClearTimer = null;
    let sessionLoadController = null;
    let sessionLoadGen = 0;

    function setTrackInfo(text) {
        if (!trackInfoEl) return;
        trackInfoEl.textContent = String(text || '').trim();
    }

    function formatDefaultTrackInfo(session) {
        if (!session) return '';
        const parts = [];
        if (session.editor_engine === 'sin') {
            const count = Array.isArray(session.layers) ? session.layers.length : (session.targets?.length || 0);
            if (count > 0) parts.push(`${count} ${count === 1 ? 'track' : 'tracks'}`);
            const sr = session.layers?.[0]?.sample_rate || session.current_target?.sample_rate;
            if (sr) parts.push(`${Math.round(Number(sr) / 100) / 10} kHz`);
            const bpm = session.session_data?.graph?.settings?.bpm;
            if (bpm && !count) parts.push(`${bpm} BPM`);
        } else {
            const t = session.current_target || session.targets?.[0];
            if (t?.media_kind === 'video') {
                if (t.width && t.height) parts.push(`${t.width}×${t.height}`);
                if (t.fps) parts.push(`${Number(t.fps).toFixed(2).replace(/\.00$/, '')} fps`);
                if (t.video_codec) parts.push(String(t.video_codec).toUpperCase());
            } else if (t) {
                if (t.sample_rate) parts.push(`${Math.round(Number(t.sample_rate) / 100) / 10} kHz`);
                if (t.channels) parts.push(t.channels === 1 ? 'Mono' : `${t.channels} ch`);
            }
        }
        return parts.join(' · ');
    }

    function setStatus(message, isError = false) {
        if (!statusEl) return;
        if (statusClearTimer) {
            window.clearTimeout(statusClearTimer);
            statusClearTimer = null;
        }
        const text = String(message || '').trim();
        statusEl.textContent = text;
        statusEl.classList.toggle('is-error', Boolean(isError));
        if (text && !isError && !text.endsWith('…')) {
            statusClearTimer = window.setTimeout(() => {
                if (statusEl.textContent === text) {
                    statusEl.textContent = '';
                }
            }, 2600);
        }
    }

    function setDirty(isDirty) {
        dirty = Boolean(isDirty);
        if (saveBtn) {
            saveBtn.textContent = dirty ? '● Save' : 'Save';
        }
        renderModePill();
    }

    function renderModePill() {
        if (!modePill) return;
        if (!currentSession) {
            modePill.textContent = 'Idle';
            modePill.title = '';
            modePill.className = 'editor-mode-pill ui-badge';
            return;
        }
        const kindLabel = currentSession.project_kind_label || currentSession.project_kind || 'Media';
        const engLabel = currentSession.editor_engine_label || currentSession.editor_engine || '';
        const isSin = currentSession.editor_engine === 'sin';
        if (currentSession.persistence === 'project') {
            modePill.textContent = `${isSin ? 'SIN' : 'Project'}${dirty ? ' •' : ''}`;
            modePill.title = `Project · ${kindLabel} · ${engLabel}${dirty ? ' (Unsaved changes)' : ''}`;
            modePill.className = 'editor-mode-pill ui-badge is-project';
        } else {
            modePill.textContent = 'Scratch';
            modePill.title = `Scratch (Unsaved) · ${kindLabel} · ${engLabel} — export freely or save as a project`;
            modePill.className = 'editor-mode-pill ui-badge is-ephemeral';
        }
    }

    function renderCheckpoints(checkpoints = []) {
        if (!checkpointsWrap || !checkpointSelect) return;
        const canSave = Boolean(currentSession?.can_save && currentSession?.project_id);
        checkpointsWrap.classList.toggle('hidden', !canSave);
        if (!canSave) return;
        const hasCheckpoints = checkpoints.length > 0;
        const previousVal = checkpointSelect.value;
        checkpointSelect.innerHTML = '<option value="">Checkpoints…</option>';
        for (const cp of checkpoints) {
            const opt = document.createElement('option');
            opt.value = cp.id;
            const dateStr = cp.created_at ? String(cp.created_at).slice(5, 16).replace('T', ' ') : '';
            opt.textContent = `${cp.label || cp.id}${dateStr ? ` · ${dateStr}` : ''}`;
            checkpointSelect.appendChild(opt);
        }
        if (previousVal && checkpoints.some(cp => cp.id === previousVal)) {
            checkpointSelect.value = previousVal;
        }
        const hasSelection = Boolean(checkpointSelect.value);
        checkpointSelect.classList.toggle('hidden', !hasCheckpoints);
        window.sinUI?.enhanceSelect?.(checkpointSelect, { size: 'sm' })?.sync?.();
        if (checkpointRestoreBtn) {
            checkpointRestoreBtn.classList.toggle('hidden', !hasCheckpoints);
            checkpointRestoreBtn.disabled = !hasSelection;
        }
        if (checkpointDeleteBtn) {
            checkpointDeleteBtn.classList.toggle('hidden', !hasCheckpoints);
            checkpointDeleteBtn.disabled = !hasSelection;
        }
    }

    function renderHeaderControls() {
        if (!currentSession) {
            if (titleEl) titleEl.textContent = 'No media';
            if (detailEl) {
                detailEl.textContent = '';
                detailEl.classList.add('hidden');
            }
            targetSelect?.classList.add('hidden');
            targetSelect?.__sinDropdownController?.sync?.();
            checkpointsWrap?.classList.add('hidden');
            saveBtn?.classList.add('hidden');
            saveAsProjectBtn?.classList.add('hidden');
            renderModePill();
            return;
        }

        if (titleEl) {
            titleEl.textContent = currentSession.title || 'Untitled';
            titleEl.title = currentSession.title || 'Untitled';
        }
        if (detailEl) {
            const count = currentSession.targets?.length || 0;
            if (currentSession.persistence === 'project' && count > 1) {
                detailEl.textContent = `${count} tracks`;
                detailEl.classList.remove('hidden');
            } else {
                detailEl.textContent = '';
                detailEl.classList.add('hidden');
            }
        }

        // Target selector dropdown inside header (only when multi-target & non-SIN or helpful)
        const targets = currentSession.targets || [];
        if (targetSelect) {
            if (targets.length > 1 && currentSession.editor_engine !== 'sin') {
                targetSelect.classList.remove('hidden');
                targetSelect.innerHTML = '';
                for (const t of targets) {
                    const opt = document.createElement('option');
                    opt.value = t.id;
                    opt.textContent = t.label;
                    targetSelect.appendChild(opt);
                }
                const activeId = currentSession.current_target?.id
                    || currentSession.session_data?.active_target_id
                    || targets[0]?.id;
                if (activeId) targetSelect.value = activeId;
            } else {
                targetSelect.classList.add('hidden');
            }
            window.sinUI?.enhanceSelect?.(targetSelect, { size: 'sm' })?.sync?.();
        }

        // Save vs Save as Project buttons
        const canSave = Boolean(currentSession.can_save);
        if (saveBtn) {
            saveBtn.classList.toggle('hidden', !canSave);
            saveBtn.disabled = !canSave;
            saveBtn.textContent = dirty ? '● Save' : 'Save';
        }
        if (saveAsProjectBtn) {
            saveAsProjectBtn.classList.toggle('hidden', canSave);
            saveAsProjectBtn.disabled = canSave;
        }

        renderCheckpoints(currentSession.checkpoints || []);
        renderModePill();
        setTrackInfo(formatDefaultTrackInfo(currentSession));
    }

    function updateToggleButton() {
        if (!toggleBtn) return;
        if (opened) {
            toggleBtn.disabled = false;
            toggleBtn.textContent = 'Close';
            toggleBtn.title = 'Close editor drawer';
            return;
        }
        const canOpen = Boolean(currentSession || isEntryOpenable(selectedLibraryEntry));
        toggleBtn.disabled = !canOpen;
        toggleBtn.textContent = 'Editor';
        toggleBtn.title = 'Open media editor';
    }

    function confirmDiscardIfDirty() {
        if (!dirty) return true;
        return window.confirm('Discard unsaved editor changes?');
    }

    function showDrawer() {
        opened = true;
        drawer?.classList.remove('hidden');
        transport?.closeQuickVideo?.();
        transport?.setEditorOpen?.(true);
        updateToggleButton();
    }

    function close({ force = false } = {}) {
        if (!opened) return true;
        if (!force && !confirmDiscardIfDirty()) return false;
        opened = false;
        drawer?.classList.add('hidden');
        if (mountedEngine) {
            mountedEngine.unmount();
            mountedEngine = null;
        }
        dirty = false;
        setStatus('');
        setTrackInfo('');
        transport?.setEditorOpen?.(false);
        updateToggleButton();
        return true;
    }

    async function loadAndMountSession(url, entry = null) {
        const gen = ++sessionLoadGen;
        if (sessionLoadController) {
            sessionLoadController.abort();
        }
        sessionLoadController = new AbortController();
        try {
            setStatus('Loading…');
            const res = await fetch(url, { signal: sessionLoadController.signal });
            const session = await res.json().catch(() => ({}));
            if (gen !== sessionLoadGen) return;
            if (!res.ok) {
                throw new Error(session.detail || 'Could not open editor session');
            }

            const nextEngineId = session.editor_engine || 'simple_media';
            const nextEngine = engines.get(nextEngineId);
            if (!nextEngine) {
                throw new Error(`No frontend engine registered for '${nextEngineId}'`);
            }

            currentSession = session;
            if (entry) currentEntry = entry;
            dirty = false;
            showDrawer();
            renderHeaderControls();

            if (mountedEngine && mountedEngine === nextEngine) {
                mountedEngine.onSessionUpdated(session);
            } else {
                mountedEngine?.unmount?.();
                mountedEngine = nextEngine;
                mountedEngine.mount(viewport, session, api);
            }
            setStatus('');
            renderHeaderControls();
        } catch (err) {
            if (err?.name === 'AbortError' || gen !== sessionLoadGen) return;
            setStatus(err.message || 'Could not open editor', true);
            showDrawer();
        }
    }

    async function openItem(itemId, { targetId = null, ephemeral = false, entry = null } = {}) {
        if (!itemId) return;
        const params = new URLSearchParams();
        if (targetId) params.set('target_id', targetId);
        if (ephemeral) params.set('ephemeral', 'true');
        const qs = params.toString() ? `?${params.toString()}` : '';
        await loadAndMountSession(`/editor/sessions/${encodeURIComponent(itemId)}${qs}`, entry);
    }

    async function openForEntry(entry, { ephemeral = false } = {}) {
        const itemId = resolveEntryItemId(entry);
        if (!itemId) return false;
        const nextSameItem = currentSession
            && Number(currentSession.root_item_id) === Number(itemId)
            && Boolean(ephemeral) === (currentSession.persistence === 'ephemeral');
        if (!nextSameItem && opened && !confirmDiscardIfDirty()) {
            return false;
        }
        // Stop library preview audio cleanly without interfering with an already-mounted editor driver
        window.gaiaAudioPreview?.stop?.();
        let targetId = null;
        if (entry?.kind === 'content' && entry.content?.child_id) {
            targetId = `item:${entry.content.child_id}`;
        }
        await openItem(itemId, { targetId, ephemeral, entry });
        return true;
    }

    async function requestTarget(entry) {
        if (!opened) return false;
        return openForEntry(entry);
    }

    async function reloadCurrentSession() {
        if (!currentSession) return;
        await openItem(currentSession.root_item_id, {
            targetId: currentSession.current_target?.id || null,
            ephemeral: currentSession.persistence === 'ephemeral',
            entry: currentEntry,
        });
    }

    async function saveCurrentProjectSession() {
        if (!currentSession?.can_save || !currentSession?.project_id || !mountedEngine) return;
        const payload = mountedEngine.getSavePayload?.();
        if (!payload) return;
        try {
            if (saveBtn) saveBtn.disabled = true;
            setStatus('Saving project session…');
            const res = await fetch(`/projects/${currentSession.project_id}/editor-session`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.detail || 'Could not save session');
            mountedEngine.clearDirty?.();
            setDirty(false);
            setStatus('Saved project session.');
        } catch (err) {
            setStatus(err.message || 'Save failed', true);
        } finally {
            if (saveBtn) saveBtn.disabled = false;
        }
    }

    function openSaveAsProjectDialog() {
        if (!currentSession || !window.gaiaAppBridge?.openProjectDialog) return;
        const rootId = Number(currentSession.root_item_id);
        const sourceEntry = currentEntry && Number(resolveEntryItemId(currentEntry)) === rootId
            ? currentEntry
            : {
                kind: 'asset',
                id: `item:${rootId}`,
                type: currentSession.root_type || 'audio',
                title: currentSession.title || `Item #${rootId}`,
                item: {
                    id: rootId,
                    type: currentSession.root_type || 'audio',
                    title: currentSession.title || `Item #${rootId}`,
                    absolute_path: '',
                },
            };

        const initData = mountedEngine?.getProjectInitData?.()
            || mountedEngine?.getSavePayload?.()?.data
            || {};

        window.gaiaAppBridge.openProjectDialog({
            sources: [sourceEntry],
            projectKind: currentSession.project_kind || 'audio',
            defaultName: currentSession.title || '',
            title: 'Save as Project',
            initialSession: {
                engine: 'simple_media',
                data: initData,
            },
            onCreated: createdProject => {
                if (createdProject?.id) {
                    dirty = false;
                    void openItem(createdProject.id);
                }
            },
        });
    }

    // Bind host header listeners
    targetSelect?.addEventListener('change', () => {
        const nextId = targetSelect.value;
        mountedEngine?.handleTargetSelect?.(nextId);
        if (currentSession?.current_target) {
            const nextDesc = (currentSession.targets || []).find(t => t.id === nextId);
            if (nextDesc) currentSession.current_target = nextDesc;
        }
    });

    checkpointSelect?.addEventListener('change', () => {
        const hasVal = Boolean(checkpointSelect.value);
        if (checkpointRestoreBtn) checkpointRestoreBtn.disabled = !hasVal;
        if (checkpointDeleteBtn) checkpointDeleteBtn.disabled = !hasVal;
    });

    checkpointSaveBtn?.addEventListener('click', async () => {
        const pid = currentSession?.project_id;
        if (!pid) return;
        if (dirty) {
            await saveCurrentProjectSession();
        }
        const nextNum = (currentSession.checkpoints?.length || 0) + 1;
        const label = window.prompt('Checkpoint label:', `Checkpoint ${nextNum}`);
        if (label === null) return;
        try {
            setStatus('Saving checkpoint…');
            const res = await fetch(`/projects/${pid}/checkpoints`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ label: label.trim() || null }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.detail || 'Could not save checkpoint');
            currentSession.checkpoints = [...(currentSession.checkpoints || []), data.checkpoint];
            renderCheckpoints(currentSession.checkpoints);
            if (checkpointSelect && data.checkpoint?.id) {
                checkpointSelect.value = data.checkpoint.id;
                checkpointSelect.dispatchEvent(new Event('change'));
            }
            setStatus(`Saved checkpoint "${data.checkpoint?.label || 'Checkpoint'}".`);
        } catch (err) {
            setStatus(err.message || 'Checkpoint failed', true);
        }
    });

    checkpointRestoreBtn?.addEventListener('click', async () => {
        const pid = currentSession?.project_id;
        const cid = checkpointSelect?.value;
        if (!pid || !cid) return;
        if (!window.confirm('Restore project session to this checkpoint? Current unsaved changes will be replaced.')) return;
        try {
            setStatus('Restoring checkpoint…');
            const res = await fetch(`/projects/${pid}/checkpoints/${encodeURIComponent(cid)}/restore`, {
                method: 'POST',
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.detail || 'Could not restore checkpoint');
            dirty = false;
            await reloadCurrentSession();
            setStatus('Restored checkpoint.');
        } catch (err) {
            setStatus(err.message || 'Restore failed', true);
        }
    });

    checkpointDeleteBtn?.addEventListener('click', async () => {
        const pid = currentSession?.project_id;
        const cid = checkpointSelect?.value;
        if (!pid || !cid) return;
        try {
            const res = await fetch(`/projects/${pid}/checkpoints/${encodeURIComponent(cid)}`, {
                method: 'DELETE',
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.detail || 'Could not delete checkpoint');
            currentSession.checkpoints = data.checkpoints || [];
            renderCheckpoints(currentSession.checkpoints);
            setStatus('Deleted checkpoint.');
        } catch (err) {
            setStatus(err.message || 'Delete failed', true);
        }
    });

    saveBtn?.addEventListener('click', () => {
        void saveCurrentProjectSession();
    });

    saveAsProjectBtn?.addEventListener('click', () => {
        openSaveAsProjectDialog();
    });

    closeBtn?.addEventListener('click', () => {
        close();
    });

    toggleBtn?.addEventListener('click', () => {
        if (opened) {
            close();
            return;
        }
        if (selectedLibraryEntry && isEntryOpenable(selectedLibraryEntry)) {
            void openForEntry(selectedLibraryEntry);
        } else if (currentSession) {
            void reloadCurrentSession();
        }
    });

    window.addEventListener('gaia:selection', event => {
        selectedLibraryEntry = event.detail?.entry || null;
        updateToggleButton();
    });

    const api = {
        registerEngine(engineInstance) {
            if (engineInstance?.id) {
                engines.set(engineInstance.id, engineInstance);
            }
        },
        openItem,
        openForEntry,
        requestTarget,
        reloadCurrentSession,
        refresh() {
            if (opened && currentSession) {
                void reloadCurrentSession();
            }
        },
        close,
        isOpen: () => opened,
        getCurrentSession: () => currentSession,
        setStatus,
        setTrackInfo,
        setDirty,
        openExportModal(options) {
            exportModal?.openExportModal?.(options);
        },
    };

    window.gaiaEditorHost = api;
    window.gaiaMediaEditor = {
        openForEntry,
        requestTarget,
        refresh: () => api.refresh(),
    };

    updateToggleButton();
    return api;
}
