function $(id) {
    return document.getElementById(id);
}

function escapeHtml(text) {
    return String(text ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}

function defaultBaseName(target, segments = []) {
    const raw = String(target?.filename || target?.label || 'export');
    const stem = raw.replace(/\.[^.]+$/, '') || 'export';
    return `${stem}_export`;
}

export function createExportModal() {
    const dialog = $('media-export-dialog');
    const form = $('media-export-form');
    const eyebrow = $('media-export-eyebrow');
    const title = $('media-export-title');
    const closeButton = $('media-export-close');
    const cancelButton = $('media-export-cancel');
    const submitButton = $('media-export-submit');
    const resultEl = $('media-export-result');

    const filenameInput = $('media-export-filename');
    const filenameHint = $('media-export-filename-hint');
    const formatSelect = $('media-export-format');

    const vaultChoice = $('media-export-choice-vault');
    const externalChoice = $('media-export-choice-external');
    const projectChoice = $('media-export-choice-project');

    const vaultFields = $('media-export-vault-fields');
    const vaultSelect = $('media-export-vault');
    const folderSelect = $('media-export-folder');

    const externalFields = $('media-export-external-fields');
    const externalPathInput = $('media-export-external-path');
    const externalBrowseBtn = $('media-export-browse-external');

    const projectFields = $('media-export-project-fields');
    const setMasterCheckbox = $('media-export-set-master');

    const conflictBox = $('media-export-conflict-box');
    const conflictList = $('media-export-conflict-list');
    const newVersionCheckbox = $('media-export-new-version');

    let currentContext = null;
    let busy = false;

    function setResult(message, isError = false) {
        if (!resultEl) return;
        if (!message) {
            resultEl.textContent = '';
            resultEl.classList.add('hidden');
            resultEl.classList.remove('error');
            return;
        }
        resultEl.textContent = message;
        resultEl.classList.remove('hidden');
        resultEl.classList.toggle('error', Boolean(isError));
    }

    function selectedMode() {
        return form?.querySelector('input[name="media-export-dest"]:checked')?.value || 'vault';
    }

    function updateFormatOptions(mediaKind, preferredFormat) {
        if (!formatSelect) return;
        const options = mediaKind === 'video'
            ? [
                { value: 'mp4', label: 'MP4 (H.264 / AAC)' },
                { value: 'mov', label: 'MOV (QuickTime)' },
                { value: 'webm', label: 'WebM (VP9 / Opus)' },
                { value: 'mkv', label: 'MKV (Matroska)' },
            ]
            : [
                { value: 'wav', label: 'WAV (Lossless)' },
                { value: 'mp3', label: 'MP3 (320/192 kbps)' },
            ];
        formatSelect.innerHTML = options.map(opt =>
            `<option value="${opt.value}">${escapeHtml(opt.label)}</option>`
        ).join('');
        const valid = options.some(o => o.value === preferredFormat);
        formatSelect.value = valid ? preferredFormat : options[0].value;
    }

    function updateFilenameHint() {
        if (!filenameHint || !currentContext) return;
        const base = (filenameInput?.value || '').trim() || defaultBaseName(currentContext.target);
        const ext = formatSelect?.value || (currentContext.target?.media_kind === 'video' ? 'mp4' : 'wav');
        const segs = currentContext.segments || [];
        if (segs.length > 1) {
            const firstLabel = (segs[0]?.label || 'cut-01').trim();
            filenameHint.textContent = `Creates ${segs.length} files, e.g. "${base}-${firstLabel}.${ext}"`;
        } else {
            filenameHint.textContent = `Output filename: "${base}.${ext}"`;
        }
    }

    async function loadVaultFolders(vaultId) {
        if (!folderSelect) return;
        folderSelect.innerHTML = '<option value="">Vault root</option>';
        if (!vaultId) return;
        try {
            const res = await fetch(`/vaults/${vaultId}/folders`);
            if (!res.ok) return;
            const data = await res.json();
            const folders = Array.isArray(data.folders) ? data.folders : [];
            for (const folder of folders) {
                const opt = document.createElement('option');
                opt.value = String(folder.id);
                opt.textContent = folder.relative_path || folder.title || `Folder #${folder.id}`;
                folderSelect.appendChild(opt);
            }
        } catch (err) {
            console.warn('Could not load vault folders for export:', err);
        }
    }

    function populateVaults(preferredVaultId) {
        if (!vaultSelect) return;
        const vaultList = window.gaiaAppBridge?.getVaults?.() || [];
        vaultSelect.innerHTML = '';
        for (const v of vaultList) {
            const opt = document.createElement('option');
            opt.value = String(v.id);
            opt.textContent = v.name || `Vault #${v.id}`;
            vaultSelect.appendChild(opt);
        }
        if (!vaultList.length) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = 'Default vault';
            vaultSelect.appendChild(opt);
        }
        if (preferredVaultId && [...vaultSelect.options].some(o => Number(o.value) === Number(preferredVaultId))) {
            vaultSelect.value = String(preferredVaultId);
        }
        void loadVaultFolders(vaultSelect.value ? Number(vaultSelect.value) : null);
    }

    function syncDestinationFields() {
        const mode = selectedMode();
        vaultFields?.classList.toggle('hidden', mode !== 'vault');
        externalFields?.classList.toggle('hidden', mode !== 'external_folder');
        projectFields?.classList.toggle('hidden', mode !== 'project');
        if (conflictBox) {
            conflictBox.classList.add('hidden');
        }
    }

    function buildRequestPayload() {
        if (!currentContext) return null;
        const mode = selectedMode();
        const target = currentContext.target;
        const stateSnap = currentContext.stateSnapshot || {};
        const segments = currentContext.segments || [];
        const filename = (filenameInput?.value || '').trim() || null;

        const destination = {
            mode,
            vault_id: mode === 'vault' && vaultSelect?.value ? Number(vaultSelect.value) : null,
            folder_id: mode === 'vault' && folderSelect?.value ? Number(folderSelect.value) : null,
            directory_path: mode === 'external_folder' ? (externalPathInput?.value || '').trim() || null : null,
            project_id: mode === 'project' ? currentContext.session?.project_id || null : null,
            filename,
            existing_output: newVersionCheckbox?.checked ? 'new_version' : 'cancel',
            set_master: Boolean(setMasterCheckbox?.checked),
            bitrate_kbps: 192,
        };

        return {
            source_item_id: target.item_id,
            target_id: target.id,
            main_start_frame: stateSnap.main_start_frame ?? null,
            main_end_frame: stateSnap.main_end_frame ?? null,
            main_start_sec: stateSnap.main_start_sec ?? null,
            main_end_sec: stateSnap.main_end_sec ?? null,
            segments: segments.map(seg => ({
                id: String(seg.id),
                label: String(seg.label || seg.id),
                start_frame: Math.round(Number(seg.start_frame ?? (Number(seg.start_sec || 0) * (target.sample_rate || 1000)))),
                end_frame: Math.round(Number(seg.end_frame ?? (Number(seg.end_sec || 0) * (target.sample_rate || 1000)))),
            })),
            pre_gain_db: Number(stateSnap.pre_gain_db ?? 0),
            volume: Number(stateSnap.volume ?? 1),
            normalize: Boolean(stateSnap.normalize),
            target_peak_db: Number(stateSnap.target_peak_db ?? -1),
            output_format: formatSelect?.value || (target.media_kind === 'video' ? 'mp4' : 'wav'),
            destination,
        };
    }

    async function pollMediaJob(jobId) {
        for (;;) {
            await new Promise(resolve => window.setTimeout(resolve, 300));
            const res = await fetch(`/media-jobs/${encodeURIComponent(jobId)}`);
            if (!res.ok) {
                throw new Error('Could not read export job status');
            }
            const job = await res.json();
            if (job.status === 'completed') {
                return job;
            }
            if (job.status === 'failed') {
                throw new Error(job.error || 'Media export failed');
            }
        }
    }

    async function handleSubmit(event) {
        event.preventDefault();
        if (busy || !currentContext) return;
        const payload = buildRequestPayload();
        if (!payload) return;

        if (payload.destination.mode === 'external_folder' && !payload.destination.directory_path) {
            setResult('Choose an external destination folder first.', true);
            return;
        }

        busy = true;
        if (submitButton) submitButton.disabled = true;
        setResult('Checking export destination…', false);

        try {
            const conflictRes = await fetch('/editor/export/conflicts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const conflictData = await conflictRes.json().catch(() => ({}));
            if (!conflictRes.ok) {
                throw new Error(conflictData.detail || 'Invalid export configuration');
            }
            const conflicts = Array.isArray(conflictData.conflicts) ? conflictData.conflicts : [];
            if (conflicts.length > 0 && !newVersionCheckbox?.checked) {
                if (conflictList && conflictBox) {
                    conflictList.innerHTML = conflicts.map(c =>
                        `<li><code>${escapeHtml(c.filename || c.path)}</code></li>`
                    ).join('');
                    conflictBox.classList.remove('hidden');
                }
                setResult('Target file(s) already exist. Rename output or enable automatic versioning.', true);
                return;
            }

            setResult('Rendering export with FFmpeg…', false);
            const startRes = await fetch('/editor/export', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const startData = await startRes.json().catch(() => ({}));
            if (!startRes.ok) {
                throw new Error(startData.detail || 'Could not start export');
            }

            const completed = await pollMediaJob(startData.job_id);
            const result = completed.result || {};
            const count = (result.exported_paths || []).length;
            if (result.registered) {
                window.dispatchEvent(new CustomEvent('gaia:library-refresh'));
            }
            const message = result.registered
                ? `Exported ${count} file${count === 1 ? '' : 's'} into GAIA.`
                : `Exported ${count} file${count === 1 ? '' : 's'} directly to disk (not added to GAIA): ${result.exported_paths?.[0] || ''}`;
            setResult(message, false);
            currentContext.onExported?.(result);
            window.setTimeout(() => {
                if (dialog?.open) dialog.close();
            }, 900);
        } catch (err) {
            setResult(err.message || 'Export failed', true);
        } finally {
            busy = false;
            if (submitButton) submitButton.disabled = false;
        }
    }

    function openExportModal({ session, target, stateSnapshot = {}, segments = [], defaultMode = null, onExported = null }) {
        if (!dialog || !target) return;
        currentContext = { session, target, stateSnapshot, segments, onExported };
        setResult('');
        if (conflictBox) conflictBox.classList.add('hidden');
        if (newVersionCheckbox) newVersionCheckbox.checked = false;

        if (eyebrow) {
            eyebrow.textContent = target.media_kind === 'video' ? 'Non-destructive Video Export' : 'Non-destructive Audio Export';
        }
        if (title) {
            title.textContent = segments.length === 1
                ? `Export cut: ${segments[0].label || target.label}`
                : segments.length > 1
                    ? `Export ${segments.length} cuts from ${target.label}`
                    : `Export ${target.label}`;
        }

        if (filenameInput) {
            filenameInput.value = defaultBaseName(target, segments);
        }
        updateFormatOptions(target.media_kind, stateSnapshot.output_format);
        updateFilenameHint();

        const isProject = session?.persistence === 'project' && Boolean(session?.project_id);
        projectChoice?.classList.toggle('hidden', !isProject);
        const projectRadio = projectChoice?.querySelector('input[type="radio"]');
        const vaultRadio = vaultChoice?.querySelector('input[type="radio"]');
        if (defaultMode === 'project' && isProject && projectRadio) {
            projectRadio.checked = true;
        } else if (vaultRadio) {
            vaultRadio.checked = true;
        }

        const preferredVault = window.gaiaAppBridge?.getActiveVaultId?.() || null;
        populateVaults(preferredVault);
        syncDestinationFields();

        if (!dialog.open) dialog.showModal();
        filenameInput?.focus();
        filenameInput?.select();
    }

    form?.addEventListener('submit', handleSubmit);
    for (const radio of form?.querySelectorAll('input[name="media-export-dest"]') || []) {
        radio.addEventListener('change', syncDestinationFields);
    }
    vaultSelect?.addEventListener('change', () => {
        void loadVaultFolders(vaultSelect.value ? Number(vaultSelect.value) : null);
    });
    filenameInput?.addEventListener('input', updateFilenameHint);
    formatSelect?.addEventListener('change', updateFilenameHint);

    externalBrowseBtn?.addEventListener('click', async () => {
        if (!window.gaiaAppBridge?.pickDiskFolder) {
            setResult('Folder browser helper is unavailable; type the folder path manually.', true);
            return;
        }
        const chosen = await window.gaiaAppBridge.pickDiskFolder(externalPathInput?.value || '');
        if (chosen && externalPathInput) {
            externalPathInput.value = chosen;
            if (externalChoice) {
                const radio = externalChoice.querySelector('input[type="radio"]');
                if (radio) radio.checked = true;
                syncDestinationFields();
            }
        }
    });

    closeButton?.addEventListener('click', () => dialog?.close());
    cancelButton?.addEventListener('click', () => dialog?.close());

    return {
        openExportModal,
        close: () => dialog?.close(),
    };
}
