// GAIA Import Wizard Module
// Manages asset inspection, transfer mode, folder hierarchy assignment, background polling, and source browsing.

(function initializeGaiaImportWizardModule() {
    function createImportWizard(context) {
        const {
            state,
            loadLibrary,
            selectedVault,
            renderVaults,
            showImportVaultCreate,
            createVaultRecord,
            createImportVault,
            createImportJob,
            migrateActiveVault,
            inspectProjectImportSource,
            addProjectImportResults,
            finishProjectCreationImport,
            failProjectCreationImport,
            startNextProjectCreationImport,
            requestImportPreview,
            typeLabel,
            escapeHtml,
            formatSize,
            getVaultDialogMode,
            vaultDialogMode,
        } = context;

        const importForm = document.getElementById('import-form');
        const importDialog = document.getElementById('import-dialog');
        const openImportButton = document.getElementById('open-import');
        const importDialogClose = document.getElementById('import-dialog-close');
        const importHeadingSource = document.getElementById('import-heading-source');
        const importCancel = document.getElementById('import-cancel');
        const sourcePath = document.getElementById('source-path');
        const chooseSourcePath = document.getElementById('choose-source-path');
        const sourcePickerDialog = document.getElementById('source-picker-dialog');
        const sourcePickerTitle = document.getElementById('source-picker-title');
        const sourcePickerSubtitle = document.getElementById('source-picker-subtitle');
        const sourcePickerClose = document.getElementById('source-picker-close');
        const sourcePickerCancel = document.getElementById('source-picker-cancel');
        const sourcePickerUp = document.getElementById('source-picker-up');
        const sourcePickerLocationForm = document.getElementById('source-picker-location-form');
        const sourcePickerLocation = document.getElementById('source-picker-location');
        const sourcePickerLocations = document.getElementById('source-picker-locations');
        const sourcePickerList = document.getElementById('source-picker-list');
        const sourcePickerResult = document.getElementById('source-picker-result');
        const sourcePickerSelection = document.getElementById('source-picker-selection');
        const sourcePickerChoose = document.getElementById('source-picker-choose');
        const importResult = document.getElementById('import-result');
        const vaultSelect = document.getElementById('vault-select');
        const importSourceStep = document.getElementById('import-source-step');
        const importPreviewStep = document.getElementById('import-preview-step');
        const importSubmit = document.getElementById('import-submit');
        const importSummaryDialog = document.getElementById('import-summary-dialog');
        const importSummaryContent = document.getElementById('import-summary-content');
        const importSummaryClose = document.getElementById('import-summary-close');
        const importSummaryDone = document.getElementById('import-summary-done');
        const importProgressContainer = document.getElementById('import-progress-container');
        const importProgressLabel = document.getElementById('import-progress-label');
        const importProgressDetail = document.getElementById('import-progress-detail');
        const importProgressFill = document.getElementById('import-progress-fill');
        const importProgressCount = document.getElementById('import-progress-count');
        const importRegistrationStage = document.getElementById('import-registration-stage');
        const importRegistrationFill = document.getElementById('import-registration-fill');
        const importRegistrationCount = document.getElementById('import-registration-count');
        const importStagingStage = document.getElementById('import-staging-stage');
        const importProcessingStage = document.getElementById('import-processing-stage');
        const importProcessingFill = document.getElementById('import-processing-fill');
        const importProcessingCount = document.getElementById('import-processing-count');
        const importProgressCancel = document.getElementById('import-progress-cancel');
        const importProgressResults = document.getElementById('import-progress-results');
        const importProgressDismiss = document.getElementById('import-progress-dismiss');
        const vaultPathAction = document.getElementById('vault-path-action');
        const vaultPathInput = document.getElementById('vault-path-input');
        const importVaultName = document.getElementById('import-vault-name');
        const importVaultCreateSubmit = document.getElementById('import-vault-create-submit');
        const importVaultCreateCancel = document.getElementById('import-vault-create-cancel');
        const projectImportAdd = document.getElementById('project-import-add');
        const importInspectProgress = document.getElementById('import-inspect-progress');
        const importInspectProgressLabel = document.getElementById('import-inspect-progress-label');
        const importInspectProgressPct = document.getElementById('import-inspect-progress-pct');
        const importInspectProgressFill = document.getElementById('import-inspect-progress-fill');

    let importPollTimer = null;

    function stopImportPolling() {
        if (importPollTimer) clearTimeout(importPollTimer);
        importPollTimer = null;
    }

    function setImportBusy(busy) {
        importDialogClose.disabled = busy;
        if (importCancel) importCancel.disabled = busy;
        importSubmit.disabled = busy;
        sourcePath.disabled = busy;
        chooseSourcePath.disabled = busy;
        vaultSelect.disabled = busy;
        importVaultName.disabled = busy;
        importVaultCreateSubmit.disabled = busy;
        importVaultCreateCancel.disabled = busy;
        openImportButton.disabled = busy || Boolean(state.importJobActiveTransfer);
        openImportButton.title = busy || state.importJobActiveTransfer ? 'An import file transfer is in progress' : 'Import assets';
    }

    let previewPollTimer = null;

    function stopPreviewPolling() {
        if (previewPollTimer) {
            clearTimeout(previewPollTimer);
            previewPollTimer = null;
        }
    }

    function updateInspectProgressBar(preview) {
        if (!importInspectProgress) return;
        if (!preview) {
            importInspectProgress.classList.add('hidden');
            importInspectProgress.classList.remove('is-complete');
            if (importInspectProgressFill) importInspectProgressFill.style.width = '0%';
            if (importInspectProgressPct) importInspectProgressPct.textContent = '0%';
            return;
        }
        const isScanning = preview.scan_status === 'scanning';
        const rawPct = isScanning
            ? Math.min(99, Math.max(1, Number(preview.scan_progress_pct) || 1))
            : 100;
        importInspectProgress.classList.remove('hidden');
        importInspectProgress.classList.toggle('is-complete', !isScanning);
        if (importInspectProgressFill) {
            importInspectProgressFill.style.width = `${rawPct}%`;
        }
        if (importInspectProgressPct) {
            importInspectProgressPct.textContent = `${rawPct}%`;
        }
        if (importInspectProgressLabel) {
            const foldersScanned = Number(preview.scanned_folders || preview.folder_count || 1);
            const foldersTotal = Number(preview.total_discovered_folders || preview.folder_count || 1);
            const filesCount = Number(preview.file_count || 0);
            importInspectProgressLabel.textContent = isScanning
                ? `Scanning source folders (${foldersScanned.toLocaleString()} / ${foldersTotal.toLocaleString()} folders · ${filesCount.toLocaleString()} files)…`
                : `Inspection complete · ${(preview.folder_count || 0).toLocaleString()} folders · ${filesCount.toLocaleString()} files (${preview.inspection_ms || 0} ms)`;
        }
    }

    function resetImportFlow() {
        stopPreviewPolling();
        state.importPreview = null;
        state.importFolderAssignments = new Map();
        state.importItemTypes = new Map();
        state.importUserModifiedFolders = new Set();
        state.importUserModifiedItems = new Set();
        state.importExcludedIndexes = new Set();
        state.importSelectedRows.clear();
        state.importSelectionAnchor = null;
        state.importUpperExpanded = false;
        state.importTransferMode = 'copy';
        state.skipTrackAnalysis = false;
        state.importCollapsedFolders = new Set();
        state.importConflictAction = null;
        importResult.className = 'result hidden';
        importSourceStep.classList.remove('hidden');
        importPreviewStep.classList.add('hidden');
        importPreviewStep.replaceChildren();
        importHeadingSource.classList.add('hidden');
        importHeadingSource.replaceChildren();
        updateInspectProgressBar(null);
        importSubmit.textContent = 'Inspect';
        importDialog?.classList.add('is-initial');
        renderVaults();
        setImportBusy(false);
    }

    function importTypeLabel(type, displayType = null) {
        return displayType || typeLabel(type);
    }

    function getImportRowKey(node) {
        return node.kind === 'folder' ? `folder:${node.relative_path}` : `file:${node.index}`;
    }

    function isFolderUnderSamplePack(folderPath) {
        if (!state.importFolderAssignments || !folderPath) return false;
        for (const [assignedPath, assignment] of state.importFolderAssignments.entries()) {
            if (assignment === 'profile:sample_pack' && assignedPath !== folderPath) {
                if (assignedPath === '.' && folderPath !== '.') return true;
                if (folderPath.startsWith(`${assignedPath}/`)) return true;
            }
        }
        return false;
    }

    function computeFolderStatsMap(preview) {
        const statsByFolder = new Map();
        const folders = [];
        for (const node of (preview?.nodes || [])) {
            if (node.kind === 'folder') {
                folders.push(node);
                statsByFolder.set(node.relative_path, {
                    totalCount: 0,
                    includedCount: 0,
                    audioCount: 0,
                    hasMedia: false,
                });
            }
        }
        if (!statsByFolder.size) return statsByFolder;

        const excluded = state.importExcludedIndexes;
        for (const entry of (preview?.entries || [])) {
            const parent = entry.parent_path || '.';
            const st = statsByFolder.get(parent);
            if (!st) continue;
            st.totalCount += 1;
            if (!excluded.has(entry.index)) {
                st.includedCount += 1;
            }
            if (entry.family === 'audio') {
                st.audioCount += 1;
                st.hasMedia = true;
            } else if (entry.family === 'midi') {
                st.hasMedia = true;
            }
        }

        const foldersDesc = [...folders].sort((a, b) => (Number(b.depth) || 0) - (Number(a.depth) || 0));
        for (const folder of foldersDesc) {
            const fpath = folder.relative_path;
            if (fpath === '.') continue;
            const parentPath = folder.parent_path || '.';
            const childSt = statsByFolder.get(fpath);
            const parentSt = statsByFolder.get(parentPath);
            if (childSt && parentSt) {
                parentSt.totalCount += childSt.totalCount;
                parentSt.includedCount += childSt.includedCount;
                parentSt.audioCount += childSt.audioCount;
                if (childSt.hasMedia) parentSt.hasMedia = true;
            }
        }
        return statsByFolder;
    }

    function folderAssignmentOptions(preview, selected, node, folderStatsMap = null) {
        const isIgnore = selected === 'action:ignore';
        const isUnderSamplePack = isFolderUnderSamplePack(node?.relative_path);
        const isSamplePack = !isUnderSamplePack && selected === 'profile:sample_pack';
        const isMultitrack = selected === 'type:multitrack';
        const isZoomH4 = selected === 'profile:zoom_h4';

        const st = folderStatsMap?.get(node?.relative_path);
        const hasMedia = st ? st.hasMedia : false;
        const audioCount = st ? st.audioCount : 0;
        const isPossibleSamplePack = !isUnderSamplePack && (
            node?.suggested_assignment === 'profile:sample_pack' ||
            node?.detected_assignment === 'profile:sample_pack' ||
            isSamplePack ||
            hasMedia
        );
        const isPossibleMultitrack = node?.detected_assignment === 'type:multitrack' ||
            node?.suggested_assignment === 'type:multitrack' ||
            isMultitrack ||
            audioCount >= 2;

        let html = `<option value="action:contain" ${(!isSamplePack && (selected === 'action:contain' || isUnderSamplePack)) ? 'selected' : ''}>Container</option>`;
        if (isPossibleSamplePack) {
            html += `<option value="profile:sample_pack" ${isSamplePack ? 'selected' : ''}>Sample pack</option>`;
        }
        if (isPossibleMultitrack) {
            html += `<option value="type:multitrack" ${isMultitrack ? 'selected' : ''}>Multitrack</option>`;
        }
        if (node?.detected_assignment === 'profile:zoom_h4' || isZoomH4) {
            html += `<option value="profile:zoom_h4" ${isZoomH4 ? 'selected' : ''}>Zoom H4</option>`;
        }
        html += `<option value="action:ignore" ${isIgnore ? 'selected' : ''}>Ignore</option>`;
        return html;
    }

    function fileTypeOptions(entry, selected) {
        const familyLabel = entry.family === 'midi' ? 'MIDI' : entry.family === 'sequence' ? 'Sequence' : entry.family === 'audio' ? 'Audio' : 'File';
        const options = (entry.allowed_types || [entry.type]).map(type =>
            `<option value="${escapeHtml(type)}" ${selected === type ? 'selected' : ''}>${escapeHtml(typeLabel(type))}</option>`
        ).join('');
        return `<optgroup label="${escapeHtml(familyLabel)}">${options}</optgroup>`;
    }

    function importFilterOptions(preview) {
        const configured = preview.filter_options || {};
        const types = configured.types?.length
            ? configured.types
            : [...new Set((preview.entries || []).map(entry => entry.family || 'file'))]
                .map(value => ({ value, label: value, count: (preview.entries || []).filter(entry => (entry.family || 'file') === value).length }));
        const extensions = configured.extensions?.length
            ? configured.extensions
            : [...new Set((preview.entries || []).map(entry => entry.extension || ''))]
                .map(value => ({ value, label: value || '(no extension)', count: (preview.entries || []).filter(entry => (entry.extension || '') === value).length }));
        return { types, extensions };
    }

    function computeFilterExclusionSummary(preview) {
        const typeTotal = new Map();
        const typeExcluded = new Map();
        const extTotal = new Map();
        const extExcluded = new Map();
        let remainingArtifactCount = 0;
        let hasAudioEntries = false;
        const excluded = state.importExcludedIndexes;

        for (const entry of (preview?.entries || [])) {
            const fam = entry.family || 'file';
            const ext = entry.extension || '';
            const isExcl = excluded.has(entry.index);
            if (fam === 'audio') hasAudioEntries = true;
            if (entry.artifact && !isExcl) remainingArtifactCount += 1;

            typeTotal.set(fam, (typeTotal.get(fam) || 0) + 1);
            if (isExcl) typeExcluded.set(fam, (typeExcluded.get(fam) || 0) + 1);

            extTotal.set(ext, (extTotal.get(ext) || 0) + 1);
            if (isExcl) extExcluded.set(ext, (extExcluded.get(ext) || 0) + 1);
        }
        return { typeTotal, typeExcluded, extTotal, extExcluded, remainingArtifactCount, hasAudioEntries };
    }

    function importFilterControl(preview, kind, option, filterSummary = null) {
        const value = option.value || '';
        let total = 0;
        let checked = false;
        if (filterSummary) {
            total = (kind === 'type' ? filterSummary.typeTotal.get(value) : filterSummary.extTotal.get(value)) || 0;
            const excl = (kind === 'type' ? filterSummary.typeExcluded.get(value) : filterSummary.extExcluded.get(value)) || 0;
            checked = total > 0 && excl === total;
        } else {
            const entries = (preview.entries || []).filter(entry => kind === 'type'
                ? (entry.family || 'file') === value
                : (entry.extension || '') === value);
            total = entries.length;
            checked = total > 0 && entries.every(entry => state.importExcludedIndexes.has(entry.index));
        }
        const dataName = kind === 'type' ? 'data-import-exclude-type' : 'data-import-exclude-extension';
        return `<label class="import-filter-chip"><input type="checkbox" ${dataName}="${escapeHtml(value)}" ${checked ? 'checked' : ''}><span>${escapeHtml(option.label)}</span><small>${Number(option.count) || total}</small></label>`;
    }

    function renderImportFilters(preview, filterSummary = null) {
        const options = importFilterOptions(preview);
        const hasTypes = options.types && options.types.length > 0;
        const hasExtensions = options.extensions && options.extensions.length > 0;
        if (!hasTypes && !hasExtensions) return '';

        return `<section class="import-filter-section"><div class="import-section-heading"><div><h3>Bulk exclusions</h3><p class="import-filter-help">Exclude file families or extensions from this import. The source remains untouched.</p></div><div class="import-filter-actions"><button id="import-keep-audio" class="secondary compact" type="button">Keep audio only</button><button id="import-include-all" class="secondary compact" type="button">Include all</button></div></div><div class="import-filter-groups">${hasTypes ? `<div class="import-filter-group"><span>File types</span><div class="import-filter-chips">${options.types.map(option => importFilterControl(preview, 'type', option, filterSummary)).join('')}</div></div>` : ''}${hasExtensions ? `<div class="import-filter-group"><span>Extensions</span><div class="import-filter-chips">${options.extensions.map(option => importFilterControl(preview, 'extension', option, filterSummary)).join('')}</div></div>` : ''}</div></section>`;
    }

    function importNodeSort(left, right) {
        if (left.relative_path === '.') return -1;
        if (right.relative_path === '.') return 1;
        return left.relative_path.localeCompare(right.relative_path, undefined, { numeric: true, sensitivity: 'base' })
            || (left.kind === 'folder' ? -1 : 1);
    }

    function importPathIsWithin(relativePath, folderPath) {
        return folderPath === '.' ? relativePath !== '.' : relativePath.startsWith(`${folderPath}/`);
    }

    function isPathHiddenByCollapsed(relativePath) {
        if (!relativePath || relativePath === '.' || state.importCollapsedFolders.size === 0) return false;
        if (state.importCollapsedFolders.has('.')) return true;
        const parts = relativePath.split('/');
        let current = '';
        for (let i = 0; i < parts.length - 1; i += 1) {
            current = current ? `${current}/${parts[i]}` : parts[i];
            if (state.importCollapsedFolders.has(current)) return true;
        }
        return false;
    }

    function getVisibleNodes(preview) {
        const visibleNodes = [];
        const visibleExpandedFolders = new Set();

        for (const node of (preview?.nodes || [])) {
            if (node.kind !== 'folder') continue;
            if (!isPathHiddenByCollapsed(node.relative_path)) {
                visibleNodes.push(node);
                if (!state.importCollapsedFolders.has(node.relative_path)) {
                    visibleExpandedFolders.add(node.relative_path);
                }
            }
        }

        if (visibleExpandedFolders.size > 0) {
            for (const entry of (preview?.entries || [])) {
                const parent = entry.parent_path || '.';
                if (visibleExpandedFolders.has(parent)) {
                    visibleNodes.push(entry);
                }
            }
        }

        return visibleNodes.sort(importNodeSort);
    }

    function renderImportPreview(options = {}) {
        const preview = state.importPreview;
        if (!preview) return;
        updateInspectProgressBar(preview);

        const existingTree = importPreviewStep.querySelector('.import-tree');
        const activeEl = document.activeElement;
        if (options.fromPoll && existingTree && activeEl && activeEl.tagName === 'SELECT' && existingTree.contains(activeEl)) {
            // Do not tear down the tree while the user is actively interacting with a row dropdown
            const includedCount = preview.file_count - state.importExcludedIndexes.size;
            const toggleUpperLabel = state.importUpperExpanded ? 'Hide options ▴' : 'Show options ▾';
            const scanStatusBadge = preview.scan_status === 'scanning'
                ? `<span class="import-scan-live"><span class="import-scan-spinner" aria-hidden="true"></span> Scanning source...</span>`
                : '';
            const statsEl = importHeadingSource.querySelector('.import-preview-stats');
            if (statsEl) {
                statsEl.innerHTML = `<span>${escapeHtml(preview.source_kind)}</span><span>${preview.folder_count || 0} folders</span><span>${includedCount}/${preview.file_count} files</span><span>${escapeHtml(formatSize(preview.size_bytes))}</span><span>${preview.inspection_ms || 0} ms</span>${scanStatusBadge}`;
            } else {
                importHeadingSource.innerHTML = `<div class="import-heading-source-copy"><h3>${escapeHtml(preview.title)}</h3><p>${escapeHtml(preview.source_path)}</p></div><div class="import-preview-stats"><span>${escapeHtml(preview.source_kind)}</span><span>${preview.folder_count || 0} folders</span><span>${includedCount}/${preview.file_count} files</span><span>${escapeHtml(formatSize(preview.size_bytes))}</span><span>${preview.inspection_ms || 0} ms</span>${scanStatusBadge}</div><div class="import-heading-actions"><button id="import-upper-toggle" class="secondary compact" type="button" aria-expanded="${state.importUpperExpanded}">${toggleUpperLabel}</button><button id="import-heading-change" class="secondary compact" type="button">Change source</button></div>`;
            }
            return;
        }

        const treeScrollTop = existingTree ? existingTree.scrollTop : 0;
        const treeScrollLeft = existingTree ? existingTree.scrollLeft : 0;
        const dialogScrollTop = importDialog ? importDialog.scrollTop : 0;
        const dialogScrollLeft = importDialog ? importDialog.scrollLeft : 0;

        let activeSelector = null;
        if (activeEl && importPreviewStep.contains(activeEl)) {
            if (activeEl.dataset.importFolder !== undefined) {
                activeSelector = `select[data-import-folder="${CSS.escape(activeEl.dataset.importFolder)}"]`;
            } else if (activeEl.dataset.importItem !== undefined) {
                activeSelector = `select[data-import-item="${CSS.escape(activeEl.dataset.importItem)}"]`;
            } else if (activeEl.dataset.importCollapse !== undefined) {
                activeSelector = `button[data-import-collapse="${CSS.escape(activeEl.dataset.importCollapse)}"]`;
            } else if (activeEl.dataset.importFolderInclude !== undefined) {
                activeSelector = `input[data-import-folder-include="${CSS.escape(activeEl.dataset.importFolderInclude)}"]`;
            } else if (activeEl.dataset.importInclude !== undefined) {
                activeSelector = `input[data-import-include="${CSS.escape(activeEl.dataset.importInclude)}"]`;
            } else if (activeEl.dataset.importExcludeType !== undefined) {
                activeSelector = `input[data-import-exclude-type="${CSS.escape(activeEl.dataset.importExcludeType)}"]`;
            } else if (activeEl.dataset.importExcludeExtension !== undefined) {
                activeSelector = `input[data-import-exclude-extension="${CSS.escape(activeEl.dataset.importExcludeExtension)}"]`;
            } else if (activeEl.id) {
                activeSelector = `#${CSS.escape(activeEl.id)}`;
            }
        }

        const folderStatsMap = computeFolderStatsMap(preview);
        const filterSummary = computeFilterExclusionSummary(preview);
        const includedCount = Math.max(0, preview.file_count - state.importExcludedIndexes.size);
        const remainingArtifactCount = filterSummary.remainingArtifactCount;
        const toggleUpperLabel = state.importUpperExpanded ? 'Hide options ▴' : 'Show options ▾';
        const scanStatusBadge = preview.scan_status === 'scanning'
            ? `<span class="import-scan-live"><span class="import-scan-spinner" aria-hidden="true"></span> Scanning source...</span>`
            : '';
        importHeadingSource.innerHTML = `<div class="import-heading-source-copy"><h3>${escapeHtml(preview.title)}</h3><p>${escapeHtml(preview.source_path)}</p></div><div class="import-preview-stats"><span>${escapeHtml(preview.source_kind)}</span><span>${preview.folder_count || 0} folders</span><span>${includedCount}/${preview.file_count} files</span><span>${escapeHtml(formatSize(preview.size_bytes))}</span><span>${preview.inspection_ms || 0} ms</span>${scanStatusBadge}</div><div class="import-heading-actions"><button id="import-upper-toggle" class="secondary compact" type="button" aria-expanded="${state.importUpperExpanded}">${toggleUpperLabel}</button><button id="import-heading-change" class="secondary compact" type="button">Change source</button></div>`;
        importHeadingSource.classList.remove('hidden');
        const visibleNodes = getVisibleNodes(preview);
        const rows = visibleNodes.map(node => {
            const rowKey = getImportRowKey(node);
            const isSelected = state.importSelectedRows.has(rowKey);
            if (node.kind === 'folder') {
                const selected = state.importFolderAssignments.get(node.relative_path) || 'action:contain';
                const collapsed = state.importCollapsedFolders.has(node.relative_path);
                const alreadyInDb = node.already_in_db
                    ? `<span class="import-already-in-db-flag" title="1-1 identical to an existing collection in this vault">ALREADY IN DATABASE</span>`
                    : '';
                const scanningBadge = node.scan_complete === false
                    ? `<span class="import-detection scanning">Scanning…</span>`
                    : '';
                const detection = node.scan_complete !== false && node.detection_label
                    ? `<span class="import-detection ${node.detected_assignment ? 'detected' : 'suggested'}">${escapeHtml(node.detected_assignment ? 'Detected' : 'Suggested')}: ${escapeHtml(node.detection_label)}</span>`
                    : '';
                const reason = node.scan_complete !== false && node.detection_reason ? `<small title="${escapeHtml(node.detection_reason)}">${escapeHtml(node.detection_reason)}</small>` : '';
                const warning = node.warning_count
                    ? `<span class="import-folder-warning" title="${escapeHtml(`${node.warning_count} flagged file${node.warning_count === 1 ? '' : 's'}: ${(node.warning_messages || []).join(', ')}`)}">⚠<span>${node.warning_count}</span></span>`
                    : '';
                return `<div class="import-tree-row folder${isSelected ? ' is-selected' : ''}" data-import-row-key="${escapeHtml(rowKey)}" style="--import-depth:${Number(node.depth) || 0}">
                    <div class="import-tree-name"><input type="checkbox" class="import-folder-checkbox" data-import-folder-include="${escapeHtml(node.relative_path)}" aria-label="Include folder ${escapeHtml(node.relative_path === '.' ? preview.title : node.name)}"><button class="import-folder-toggle" type="button" data-import-collapse="${escapeHtml(node.relative_path)}" aria-label="${collapsed ? 'Expand' : 'Collapse'} ${escapeHtml(node.relative_path === '.' ? preview.title : node.name)}" aria-expanded="${!collapsed}">${collapsed ? '▸' : '▾'}</button><span class="import-tree-label"><strong>${escapeHtml(node.relative_path === '.' ? preview.title : node.name)}</strong>${reason}</span>${warning}</div>
                    <div class="import-tree-detection">${alreadyInDb}${scanningBadge}${detection}</div>
                    <select data-import-folder="${escapeHtml(node.relative_path)}">${folderAssignmentOptions(preview, selected, node, folderStatsMap)}</select>
                    <span class="import-tree-size">${node.relative_path === '.' ? escapeHtml(formatSize(preview.size_bytes)) : '—'}</span>
                </div>`;
            }
            const selected = state.importItemTypes.get(node.index) || node.type;
            const locked = (node.allowed_types || []).length <= 1;
            const excluded = state.importExcludedIndexes.has(node.index);
            const alreadyInDb = node.already_in_db
                ? `<span class="import-already-in-db-flag" title="1-1 identical to an asset in this vault">ALREADY IN DATABASE</span>`
                : '';
            const inspection = [
                alreadyInDb,
                node.artifact ? `<span class="import-artifact-flag" title="${escapeHtml(node.artifact_reason)}">⚑ Artifact</span>` : '',
                node.profile_role ? `<span class="import-role-badge ${escapeHtml(node.profile_role)}" title="${escapeHtml(node.profile_role_reason)}">${escapeHtml(node.profile_role === 'mixdown' ? 'Mixdown' : 'Source channel')}</span>` : '',
                !node.artifact && !node.profile_role ? `<span class="import-family">${escapeHtml(node.family)}</span>` : '',
            ].filter(Boolean).join('');
            return `<div class="import-tree-row file${excluded ? ' excluded' : ''}${isSelected ? ' is-selected' : ''}" data-import-row-key="${escapeHtml(rowKey)}" style="--import-depth:${Number(node.depth) || 0}">
                <div class="import-tree-name" title="${escapeHtml(node.relative_path)}"><input type="checkbox" data-import-include="${node.index}" ${excluded ? '' : 'checked'} aria-label="Include ${escapeHtml(node.filename)}"><span class="import-tree-label">${escapeHtml(node.filename)}</span></div>
                <div class="import-tree-detection">${inspection}</div>
                <select data-import-item="${node.index}" ${locked ? 'disabled' : ''}>${fileTypeOptions(node, selected)}</select>
                <span class="import-tree-size">${escapeHtml(formatSize(node.size_bytes))}</span>
            </div>`;
        }).join('');
        const conflicts = preview.conflicts || [];
        const conflictPanel = conflicts.length ? `
            <div class="import-conflicts"><strong>${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'} need a decision</strong>
                <ul>${conflicts.slice(0, 6).map(conflict => `<li>${escapeHtml(conflict.message)}</li>`).join('')}</ul>
                <label>On conflict <select id="import-conflict-action"><option value="">Choose an action</option><option value="skip" ${state.importConflictAction === 'skip' ? 'selected' : ''}>Skip existing content</option><option value="new_snapshot" ${state.importConflictAction === 'new_snapshot' ? 'selected' : ''}>Keep a new immutable snapshot</option></select></label>
            </div>` : '';
        const isScanning = preview.scan_status === 'scanning';
        const canStart = !isScanning && includedCount > 0 && (!conflicts.length || state.importConflictAction);
        if (preview.source_kind === 'zip' && state.importTransferMode === 'keep') state.importTransferMode = 'copy';
        const transferHelp = {
            move: 'Moves the selected files into the vault. Originals disappear only after verified publication.',
            copy: 'Copies the selected files into the vault and leaves every original untouched.',
            keep: 'Registers read-only references to the original paths. No source file is changed.',
        }[state.importTransferMode];
        const startLabel = isScanning
            ? 'Scanning source...'
            : (state.importTransferMode === 'move' ? 'Move files and import' : 'Start background import');
        const hasAudioEntries = filterSummary.hasAudioEntries;

        const selectedFolderCount = [...state.importSelectedRows].filter(k => k.startsWith('folder:')).length;
        const selectedFileCount = [...state.importSelectedRows].filter(k => k.startsWith('file:')).length;
        let bulkToolbarHtml = '';
        if (state.importSelectedRows.size > 0) {
            let countText = '';
            if (selectedFolderCount > 0 && selectedFileCount > 0) {
                countText = `${selectedFolderCount} folder${selectedFolderCount > 1 ? 's' : ''}, ${selectedFileCount} file${selectedFileCount > 1 ? 's' : ''} selected`;
            } else if (selectedFolderCount > 0) {
                countText = `${selectedFolderCount} folder${selectedFolderCount > 1 ? 's' : ''} selected`;
            } else {
                countText = `${selectedFileCount} file${selectedFileCount > 1 ? 's' : ''} selected`;
            }

            bulkToolbarHtml = `
                <div class="import-bulk-toolbar">
                    <div class="import-bulk-summary">
                        <span class="import-bulk-badge">${countText}</span>
                    </div>
                    <div class="import-bulk-actions">
                        ${selectedFolderCount > 0 ? `
                            <div class="import-bulk-group">
                                <span class="import-bulk-group-label">Set folders:</span>
                                <button id="bulk-folder-sample-pack" class="secondary compact" type="button" title="Set selected folders as Sample pack (audio files will be marked as samples)">Sample pack</button>
                                <button id="bulk-folder-container" class="secondary compact" type="button" title="Set selected folders as Container">Container</button>
                                <button id="bulk-folder-multitrack" class="secondary compact" type="button" title="Set selected folders as Multitrack">Multitrack</button>
                                <button id="bulk-folder-ignore" class="secondary compact" type="button" title="Ignore selected folders">Ignore</button>
                            </div>
                        ` : ''}
                        ${selectedFileCount > 0 ? `
                            <div class="import-bulk-group">
                                <span class="import-bulk-group-label">Set files:</span>
                                <button id="bulk-file-sample" class="secondary compact" type="button" title="Set selected audio files to Sample">Sample</button>
                                <button id="bulk-file-track" class="secondary compact" type="button" title="Set selected audio files to Track">Track</button>
                                <button id="bulk-file-audio" class="secondary compact" type="button" title="Set selected audio files to Audio">Audio</button>
                                <button id="bulk-file-toggle-include" class="secondary compact" type="button" title="Toggle include/exclude for selected files">Toggle include</button>
                            </div>
                        ` : ''}
                        <button id="bulk-deselect-all" class="secondary compact import-bulk-deselect" type="button">Deselect all</button>
                    </div>
                </div>
            `;
        }

        importPreviewStep.innerHTML = `
            <div id="import-preview-upper" class="import-preview-upper${state.importUpperExpanded ? '' : ' is-collapsed'}">
                ${preview.warnings?.length ? `<div class="import-warning-box"><strong>Inspection warnings</strong>${preview.warnings.map(warning => `<div>${escapeHtml(warning)}</div>`).join('')}</div>` : ''}
                ${renderImportFilters(preview, filterSummary)}
                ${conflictPanel}
                <section class="import-transfer-choice"><label for="import-transfer-mode"><strong>File handling</strong></label><select id="import-transfer-mode"><option value="move" ${state.importTransferMode === 'move' ? 'selected' : ''}>Move files into vault</option><option value="copy" ${state.importTransferMode === 'copy' ? 'selected' : ''}>Copy files into vault</option><option value="keep" ${state.importTransferMode === 'keep' ? 'selected' : ''} ${preview.source_kind === 'zip' ? 'disabled' : ''}>Keep files in original position (reference)</option></select><p>${escapeHtml(transferHelp)}</p></section>
                ${hasAudioEntries ? `<label class="import-analysis-choice"><input id="import-skip-track-analysis" type="checkbox" ${state.skipTrackAnalysis ? 'checked' : ''}><span><strong>Skip analysis for tracks</strong><small>Import rows assigned the Track type using inspection only; BPM, key, duration, and embedded metadata will remain empty until analyzed later.</small></span></label>` : ''}
            </div>
            <section class="import-table-section">
                <div class="import-section-heading">
                    <div>
                        <h3>Inspected folders and files</h3>
                    </div>
                    <div class="import-heading-actions">
                        <button id="import-select-all-folders" class="secondary compact" type="button">Select all folders</button>
                        <button id="import-select-all-files" class="secondary compact" type="button">Select all files</button>
                        <button id="import-exclude-artifacts" class="secondary compact" type="button" ${remainingArtifactCount ? '' : 'disabled'}>Exclude flagged artifacts${remainingArtifactCount ? ` (${remainingArtifactCount})` : ''}</button>
                    </div>
                </div>
                ${bulkToolbarHtml}
                <div class="import-tree-head"><span>Name</span><span>Inspection</span><span>Type or profile</span><span>Size</span></div>
                <div class="import-tree">${rows || '<div class="empty">No files were found.</div>'}</div>
            </section>
            <div class="dialog-actions"><button id="import-preview-back" class="secondary" type="button">Choose another source</button><button id="import-job-start" class="primary" type="button" ${canStart ? '' : 'disabled'}>${escapeHtml(startLabel)}</button></div>`;
        importPreviewStep.querySelectorAll('input[data-import-folder-include]').forEach(checkbox => {
            const folderPath = checkbox.dataset.importFolderInclude;
            const st = folderStatsMap.get(folderPath);
            if (!st || st.totalCount === 0) {
                const folderNode = (preview.nodes || []).find(n => n.kind === 'folder' && n.relative_path === folderPath);
                checkbox.checked = !folderNode?.already_in_db;
                checkbox.indeterminate = false;
                return;
            }
            if (st.includedCount === 0) {
                checkbox.checked = false;
                checkbox.indeterminate = false;
            } else if (st.includedCount === st.totalCount) {
                checkbox.checked = true;
                checkbox.indeterminate = false;
            } else {
                checkbox.checked = false;
                checkbox.indeterminate = true;
            }
        });
        importPreviewStep.querySelector('#import-transfer-mode')?.addEventListener('change', event => {
            state.importTransferMode = event.target.value;
            renderImportPreview();
        });
        importPreviewStep.querySelector('#import-skip-track-analysis')?.addEventListener('change', event => {
            state.skipTrackAnalysis = event.target.checked;
            renderImportPreview();
        });
        importPreviewStep.querySelectorAll('[data-import-collapse]').forEach(button => button.addEventListener('click', () => {
            const path = button.dataset.importCollapse;
            if (state.importCollapsedFolders.has(path)) state.importCollapsedFolders.delete(path);
            else state.importCollapsedFolders.add(path);
            renderImportPreview();
        }));

        importPreviewStep.querySelectorAll('.import-tree-row').forEach(row => {
            row.addEventListener('click', event => {
                if (event.target.closest('input, select, button, a')) return;
                const rowKey = row.dataset.importRowKey;
                if (!rowKey) return;
                const additive = event.ctrlKey || event.metaKey;
                if (event.shiftKey && state.importSelectionAnchor) {
                    const visibleKeys = visibleNodes.map(getImportRowKey);
                    const start = visibleKeys.indexOf(state.importSelectionAnchor);
                    const end = visibleKeys.indexOf(rowKey);
                    if (start >= 0 && end >= 0) {
                        if (!additive) state.importSelectedRows.clear();
                        const [first, last] = start < end ? [start, end] : [end, start];
                        visibleKeys.slice(first, last + 1).forEach(k => state.importSelectedRows.add(k));
                    } else {
                        state.importSelectedRows.clear();
                        state.importSelectedRows.add(rowKey);
                    }
                } else if (additive) {
                    if (state.importSelectedRows.has(rowKey)) {
                        state.importSelectedRows.delete(rowKey);
                    } else {
                        state.importSelectedRows.add(rowKey);
                    }
                    state.importSelectionAnchor = rowKey;
                } else {
                    state.importSelectedRows.clear();
                    state.importSelectedRows.add(rowKey);
                    state.importSelectionAnchor = rowKey;
                }
                renderImportPreview();
            });
        });

        importPreviewStep.querySelectorAll('[data-import-folder]').forEach(select => select.addEventListener('change', () => {
            const folderPath = select.dataset.importFolder;
            const assignment = select.value;
            const selectedFolderPaths = [...state.importSelectedRows]
                .filter(k => k.startsWith('folder:'))
                .map(k => k.slice(7));
            const targetFolders = selectedFolderPaths.includes(folderPath)
                ? selectedFolderPaths
                : [folderPath];

            if (!state.importUserModifiedFolders) state.importUserModifiedFolders = new Set();
            if (!state.importUserModifiedItems) state.importUserModifiedItems = new Set();

            targetFolders.forEach(targetPath => {
                state.importUserModifiedFolders.add(targetPath);
                state.importFolderAssignments.set(targetPath, assignment);
                if (assignment === 'profile:sample_pack') {
                    // Descendant subfolders inside a sample pack are containers (no nested sample packs)
                    for (const otherPath of state.importFolderAssignments.keys()) {
                        if (otherPath !== targetPath && (targetPath === '.' || otherPath.startsWith(`${targetPath}/`))) {
                            state.importFolderAssignments.set(otherPath, 'action:contain');
                        }
                    }
                    (preview.entries || []).forEach(entry => {
                        if (targetPath === '.' || entry.relative_path.startsWith(`${targetPath}/`)) {
                            if (entry.family === 'audio' || (entry.allowed_types || []).includes('sample')) {
                                state.importItemTypes.set(entry.index, 'sample');
                            }
                        }
                    });
                } else if (assignment === 'action:contain') {
                    (preview.entries || []).forEach(entry => {
                        if (targetPath === '.' || entry.relative_path.startsWith(`${targetPath}/`)) {
                            if (entry.family === 'audio' && !state.importUserModifiedItems.has(entry.index)) {
                                state.importItemTypes.set(entry.index, entry.type || 'track');
                            }
                        }
                    });
                }
            });
            renderImportPreview();
        }));
        importPreviewStep.querySelectorAll('[data-import-folder-include]').forEach(input => input.addEventListener('change', () => {
            const folderPath = input.dataset.importFolderInclude;
            const isChecked = input.checked;
            const selectedFolderPaths = [...state.importSelectedRows]
                .filter(k => k.startsWith('folder:'))
                .map(k => k.slice(7));
            const targetFolders = selectedFolderPaths.includes(folderPath)
                ? selectedFolderPaths
                : [folderPath];

            targetFolders.forEach(targetPath => {
                if (state.importPreview?.scan_status === 'scanning') {
                    fetch(`/items/import/preview/${encodeURIComponent(state.importPreview.preview_id)}/skip-folder`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ folder_path: targetPath, skip: !isChecked }),
                    }).catch(() => {});
                }
                const descendants = (preview.entries || []).filter(entry =>
                    targetPath === '.' || entry.relative_path === targetPath || entry.relative_path.startsWith(`${targetPath}/`)
                );
                if (isChecked) {
                    descendants.forEach(entry => state.importExcludedIndexes.delete(entry.index));
                } else {
                    descendants.forEach(entry => state.importExcludedIndexes.add(entry.index));
                }
            });
            renderImportPreview();
        }));
        importPreviewStep.querySelectorAll('[data-import-item]').forEach(select => select.addEventListener('change', () => {
            const itemIndex = Number(select.dataset.importItem);
            const value = select.value;
            const selectedFileIndexes = [...state.importSelectedRows]
                .filter(k => k.startsWith('file:'))
                .map(k => Number(k.slice(5)));
            const targetIndexes = selectedFileIndexes.includes(itemIndex)
                ? selectedFileIndexes
                : [itemIndex];

            if (!state.importUserModifiedItems) state.importUserModifiedItems = new Set();
            targetIndexes.forEach(targetIdx => {
                state.importUserModifiedItems.add(targetIdx);
                state.importItemTypes.set(targetIdx, value);
            });
            renderImportPreview();
        }));
        importPreviewStep.querySelectorAll('[data-import-exclude-type], [data-import-exclude-extension]').forEach(input => input.addEventListener('change', () => {
            const kind = input.hasAttribute('data-import-exclude-type') ? 'type' : 'extension';
            const value = kind === 'type' ? input.dataset.importExcludeType : input.dataset.importExcludeExtension;
            (preview.entries || []).filter(entry => kind === 'type'
                ? (entry.family || 'file') === value
                : (entry.extension || '') === value
            ).forEach(entry => input.checked
                ? state.importExcludedIndexes.add(entry.index)
                : state.importExcludedIndexes.delete(entry.index));
            renderImportPreview();
        }));
        importPreviewStep.querySelectorAll('[data-import-include]').forEach(input => input.addEventListener('change', () => {
            const index = Number(input.dataset.importInclude);
            const isChecked = input.checked;
            const selectedFileIndexes = [...state.importSelectedRows]
                .filter(k => k.startsWith('file:'))
                .map(k => Number(k.slice(5)));
            const targetIndexes = selectedFileIndexes.includes(index)
                ? selectedFileIndexes
                : [index];

            targetIndexes.forEach(targetIdx => {
                if (isChecked) state.importExcludedIndexes.delete(targetIdx);
                else state.importExcludedIndexes.add(targetIdx);
            });
            renderImportPreview();
        }));
        importPreviewStep.querySelector('#import-exclude-artifacts')?.addEventListener('click', () => {
            (preview.entries || []).filter(entry => entry.artifact).forEach(entry => state.importExcludedIndexes.add(entry.index));
            renderImportPreview();
        });
        importPreviewStep.querySelector('#import-keep-audio')?.addEventListener('click', () => {
            (preview.entries || []).filter(entry => (entry.family || 'file') !== 'audio').forEach(entry => state.importExcludedIndexes.add(entry.index));
            renderImportPreview();
        });
        importPreviewStep.querySelector('#import-include-all')?.addEventListener('click', () => {
            state.importExcludedIndexes.clear();
            renderImportPreview();
        });

        importPreviewStep.querySelector('#bulk-folder-sample-pack')?.addEventListener('click', () => {
            if (!state.importUserModifiedFolders) state.importUserModifiedFolders = new Set();
            const folderPaths = [...state.importSelectedRows]
                .filter(k => k.startsWith('folder:'))
                .map(k => k.slice(7));
            folderPaths.forEach(folderPath => {
                state.importUserModifiedFolders.add(folderPath);
                state.importFolderAssignments.set(folderPath, 'profile:sample_pack');
                for (const otherPath of state.importFolderAssignments.keys()) {
                    if (otherPath !== folderPath && (folderPath === '.' || otherPath.startsWith(`${folderPath}/`))) {
                        state.importFolderAssignments.set(otherPath, 'action:contain');
                    }
                }
                (preview.entries || []).forEach(entry => {
                    if (folderPath === '.' || entry.relative_path.startsWith(`${folderPath}/`)) {
                        if (entry.family === 'audio' || (entry.allowed_types || []).includes('sample')) {
                            state.importItemTypes.set(entry.index, 'sample');
                        }
                    }
                });
            });
            renderImportPreview();
        });

        importPreviewStep.querySelector('#bulk-folder-container')?.addEventListener('click', () => {
            if (!state.importUserModifiedFolders) state.importUserModifiedFolders = new Set();
            const folderPaths = [...state.importSelectedRows]
                .filter(k => k.startsWith('folder:'))
                .map(k => k.slice(7));
            folderPaths.forEach(folderPath => {
                state.importUserModifiedFolders.add(folderPath);
                state.importFolderAssignments.set(folderPath, 'action:contain');
                (preview.entries || []).forEach(entry => {
                    if (folderPath === '.' || entry.relative_path.startsWith(`${folderPath}/`)) {
                        if (entry.family === 'audio') {
                            state.importItemTypes.set(entry.index, entry.type || 'track');
                        }
                    }
                });
            });
            renderImportPreview();
        });

        importPreviewStep.querySelector('#bulk-folder-multitrack')?.addEventListener('click', () => {
            if (!state.importUserModifiedFolders) state.importUserModifiedFolders = new Set();
            const folderPaths = [...state.importSelectedRows]
                .filter(k => k.startsWith('folder:'))
                .map(k => k.slice(7));
            folderPaths.forEach(folderPath => {
                state.importUserModifiedFolders.add(folderPath);
                state.importFolderAssignments.set(folderPath, 'type:multitrack');
            });
            renderImportPreview();
        });

        importPreviewStep.querySelector('#bulk-folder-ignore')?.addEventListener('click', () => {
            if (!state.importUserModifiedFolders) state.importUserModifiedFolders = new Set();
            const folderPaths = [...state.importSelectedRows]
                .filter(k => k.startsWith('folder:'))
                .map(k => k.slice(7));
            folderPaths.forEach(folderPath => {
                state.importUserModifiedFolders.add(folderPath);
                state.importFolderAssignments.set(folderPath, 'action:ignore');
            });
            renderImportPreview();
        });

        importPreviewStep.querySelector('#bulk-file-sample')?.addEventListener('click', () => {
            if (!state.importUserModifiedItems) state.importUserModifiedItems = new Set();
            const fileIndexes = [...state.importSelectedRows]
                .filter(k => k.startsWith('file:'))
                .map(k => Number(k.slice(5)));
            fileIndexes.forEach(idx => {
                const entry = (preview.entries || []).find(e => e.index === idx);
                if (entry && (entry.family === 'audio' || (entry.allowed_types || []).includes('sample'))) {
                    state.importUserModifiedItems.add(idx);
                    state.importItemTypes.set(idx, 'sample');
                }
            });
            renderImportPreview();
        });

        importPreviewStep.querySelector('#bulk-file-track')?.addEventListener('click', () => {
            if (!state.importUserModifiedItems) state.importUserModifiedItems = new Set();
            const fileIndexes = [...state.importSelectedRows]
                .filter(k => k.startsWith('file:'))
                .map(k => Number(k.slice(5)));
            fileIndexes.forEach(idx => {
                const entry = (preview.entries || []).find(e => e.index === idx);
                if (entry && (entry.family === 'audio' || (entry.allowed_types || []).includes('track'))) {
                    state.importUserModifiedItems.add(idx);
                    state.importItemTypes.set(idx, 'track');
                }
            });
            renderImportPreview();
        });

        importPreviewStep.querySelector('#bulk-file-audio')?.addEventListener('click', () => {
            if (!state.importUserModifiedItems) state.importUserModifiedItems = new Set();
            const fileIndexes = [...state.importSelectedRows]
                .filter(k => k.startsWith('file:'))
                .map(k => Number(k.slice(5)));
            fileIndexes.forEach(idx => {
                state.importUserModifiedItems.add(idx);
                state.importItemTypes.set(idx, 'audio');
            });
            renderImportPreview();
        });

        importPreviewStep.querySelector('#bulk-file-toggle-include')?.addEventListener('click', () => {
            const fileIndexes = [...state.importSelectedRows]
                .filter(k => k.startsWith('file:'))
                .map(k => Number(k.slice(5)));
            const anyExcluded = fileIndexes.some(idx => state.importExcludedIndexes.has(idx));
            fileIndexes.forEach(idx => {
                if (anyExcluded) state.importExcludedIndexes.delete(idx);
                else state.importExcludedIndexes.add(idx);
            });
            renderImportPreview();
        });

        importPreviewStep.querySelector('#bulk-deselect-all')?.addEventListener('click', () => {
            state.importSelectedRows.clear();
            state.importSelectionAnchor = null;
            renderImportPreview();
        });

        importPreviewStep.querySelector('#import-select-all-folders')?.addEventListener('click', () => {
            visibleNodes.filter(node => node.kind === 'folder').forEach(node => {
                state.importSelectedRows.add(getImportRowKey(node));
            });
            renderImportPreview();
        });

        importPreviewStep.querySelector('#import-select-all-files')?.addEventListener('click', () => {
            visibleNodes.filter(node => node.kind !== 'folder').forEach(node => {
                state.importSelectedRows.add(getImportRowKey(node));
            });
            renderImportPreview();
        });
        importPreviewStep.querySelector('#import-conflict-action')?.addEventListener('change', event => {
            state.importConflictAction = event.target.value || null;
            renderImportPreview();
        });
        importPreviewStep.querySelector('#import-preview-back')?.addEventListener('click', resetImportFlow);
        importHeadingSource.querySelector('#import-upper-toggle')?.addEventListener('click', () => {
            state.importUpperExpanded = !state.importUpperExpanded;
            renderImportPreview();
        });
        importHeadingSource.querySelector('#import-heading-change')?.addEventListener('click', resetImportFlow);
        importPreviewStep.querySelector('#import-job-start')?.addEventListener('click', startImportJob);
        const newTree = importPreviewStep.querySelector('.import-tree');
        if (newTree) {
            newTree.scrollTop = treeScrollTop;
            newTree.scrollLeft = treeScrollLeft;
        }
        if (importDialog) {
            importDialog.scrollTop = dialogScrollTop;
            importDialog.scrollLeft = dialogScrollLeft;
        }
        if (activeSelector) {
            const restoredEl = importPreviewStep.querySelector(activeSelector);
            if (restoredEl && typeof restoredEl.focus === 'function') {
                restoredEl.focus({ preventScroll: true });
            }
        }
    }

    function renderImportJob(job) {
        const registrationTotal = Math.max(1, Number(job.registration_total ?? job.total) || 1);
        const registrationCompleted = Number(job.registration_completed) || 0;
        const stagingTotal = Math.max(1, Number(job.staging_total ?? job.total) || 1);
        const stagingCompleted = Number(job.staging_completed ?? (job.phase === 'staging' ? job.completed : 0)) || 0;
        const stagingBytesTotal = Number(job.staging_bytes_total) || 0;
        const stagingBytesCompleted = Number(job.staging_bytes_completed) || 0;
        const processingTotal = Math.max(1, Number(job.processing_total ?? job.total) || 1);
        const processingCompleted = Number(job.processing_completed ?? job.completed) || 0;
        const stagingProgressRaw = Math.min(100,
            stagingBytesTotal > 0
                ? (stagingBytesCompleted / stagingBytesTotal) * 100
                : (stagingCompleted / stagingTotal) * 100
        );
        const stagingProgress = stagingProgressRaw >= 10
            ? stagingProgressRaw.toFixed(1)
            : stagingProgressRaw.toFixed(2);
        const processingProgress = Math.min(100, Math.round((processingCompleted / processingTotal) * 100));
        const registrationProgress = Math.min(100, Math.round((registrationCompleted / registrationTotal) * 100));
        const active = ['queued', 'running', 'cancelling'].includes(job.status);
        const labels = {
            queued: 'Import queued', running: 'Importing assets', cancelling: 'Cancelling import',
            completed: 'Import complete', failed: 'Import failed', cancelled: 'Import cancelled', stale: 'Import source changed',
        };
        const terminalDetail = job.status === 'completed'
            ? `${job.imported || 0} assets imported · ${job.excluded || 0} files excluded`
            : job.error || job.current_title || job.phase || job.status;
        importProgressContainer.classList.remove('hidden');
        importProgressContainer.classList.toggle('failed', ['failed', 'stale'].includes(job.status));
        importProgressContainer.classList.toggle('complete', job.status === 'completed');
        importProgressLabel.textContent = labels[job.status] || job.phase || job.status;
        importProgressDetail.textContent = active ? (job.current_title || job.phase || 'Preparing managed import…') : terminalDetail;
        importRegistrationFill.style.width = `${job.status === 'completed' ? 100 : registrationProgress}%`;
        importRegistrationCount.textContent = `${registrationCompleted} / ${job.registration_total ?? job.total ?? 0}`;
        importProgressFill.style.width = `${job.status === 'completed' ? 100 : stagingProgress}%`;
        const transferredSize = stagingBytesTotal > 0
            ? ` · ${formatSize(stagingBytesCompleted)} / ${formatSize(stagingBytesTotal)}`
            : '';
        importProgressCount.textContent = `${stagingCompleted} / ${job.staging_total ?? job.total ?? 0}${transferredSize} · ${job.status === 'completed' ? '100' : stagingProgress}%`;
        importProcessingFill.style.width = `${job.status === 'completed' ? 100 : processingProgress}%`;
        importProcessingCount.textContent = `${processingCompleted} / ${job.processing_total ?? job.total ?? 0} · ${job.status === 'completed' ? 100 : processingProgress}%`;
        importRegistrationStage.classList.toggle('complete', job.status === 'completed' || registrationProgress === 100);
        importRegistrationStage.classList.toggle('active', job.phase === 'registering');
        importStagingStage.classList.toggle('complete', job.status === 'completed' || stagingProgress === 100);
        importStagingStage.classList.toggle('active', job.phase === 'transferring');
        importProcessingStage.classList.toggle('complete', job.status === 'completed' || processingProgress === 100);
        importProcessingStage.classList.toggle('active', job.phase === 'analyzing' || job.phase === 'finalizing');
        importProgressCancel.classList.toggle('hidden', !active);
        importProgressCancel.disabled = job.status === 'cancelling';
        importProgressCancel.textContent = job.status === 'cancelling' ? 'Cancelling…' : 'Cancel';
        importProgressResults.classList.toggle('hidden', active);
        importProgressDismiss.classList.toggle('hidden', active);
        const transferActive = active && ['queued', 'revalidating', 'registering', 'transferring'].includes(job.phase);
        state.importJobActiveTransfer = transferActive;
        const projectImportAddBtn = projectImportAdd || document.getElementById('project-import-add');
        if (projectImportAddBtn) projectImportAddBtn.disabled = active;
        openImportButton.disabled = transferActive;
        openImportButton.title = transferActive ? 'An import file transfer is in progress' : 'Import assets';
    }

    function renderImportPollingIssue(message) {
        importProgressContainer.classList.remove('hidden');
        importProgressContainer.classList.add('failed');
        importProgressLabel.textContent = 'Import status unavailable';
        importProgressDetail.textContent = `${message} · retrying…`;
        importProgressCancel.classList.add('hidden');
        importProgressResults.classList.add('hidden');
        importProgressDismiss.classList.add('hidden');
        openImportButton.disabled = true;
        openImportButton.title = 'Reconnecting to background import';
    }

    function showImportJobSummary(job) {
        const resultItems = Array.isArray(job.result_items) ? job.result_items : [];
        importSummaryContent.innerHTML = `<div class="import-summary-hero"><div class="import-summary-title"><h3>${escapeHtml(job.status === 'completed' ? 'Import complete' : `Import ${job.status}`)}</h3><p>${escapeHtml(job.log_path || '')}</p></div><div class="import-summary-metrics"><div class="import-summary-metric"><strong>${job.imported || 0}</strong><span>Imported</span></div><div class="import-summary-metric"><strong>${job.skipped || 0}</strong><span>Skipped</span></div><div class="import-summary-metric"><strong>${job.excluded || 0}</strong><span>Excluded</span></div></div></div>${job.error ? `<div class="import-warning-box"><strong>Import error</strong><div>${escapeHtml(job.error)}</div></div>` : ''}${job.warnings?.length ? `<div class="import-warning-box"><strong>Warnings</strong>${job.warnings.map(warning => `<div>${escapeHtml(warning)}</div>`).join('')}</div>` : ''}<section class="import-summary-section"><h3>Imported assets</h3><div class="import-summary-list">${resultItems.length ? resultItems.map(item => `<div class="import-summary-row"><span class="import-summary-row-name">${escapeHtml(item.title)}</span><span class="import-summary-row-path">${escapeHtml(item.absolute_path)}</span><span class="type-badge">${escapeHtml(importTypeLabel(item.type, item.display_type))}</span></div>`).join('') : '<div class="import-summary-more">No managed assets were created.</div>'}</div></section>`;
        importSummaryDialog.showModal();
    }

    async function pollImportJob() {
        if (!state.importJobId) return;
        try {
            const projectContext = state.projectCreationImportContext;
            const response = await fetch(`/items/import/jobs/${state.importJobId}`);
            const job = await response.json().catch(() => ({}));
            if (!response.ok) {
                if (response.status === 404) {
                    stopImportPolling();
                    localStorage.removeItem('gaia.activeImportJobId');
                    state.importJobId = null;
                    state.importLastJob = null;
                    importProgressContainer.classList.add('hidden');
                    openImportButton.disabled = false;
                    openImportButton.title = 'Import assets';
                    if (projectContext) failProjectCreationImport('The project import job could not be found.');
                    return;
                }
                throw new Error(job.detail || 'Could not read import progress');
            }
            renderImportJob(job);
            if (
                job.status === 'running'
                && (job.phase === 'analyzing' || job.files_ready || Number(job.staging_completed || 0) >= Number(job.staging_total || job.total || 0))
                && state.importFilesReadyJobId !== job.job_id
            ) {
                state.importFilesReadyJobId = job.job_id;
                await loadLibrary({ force: true, resetNested: true });
            }
            if (['completed', 'failed', 'cancelled', 'stale'].includes(job.status)) {
                stopImportPolling();
                localStorage.removeItem('gaia.activeImportJobId');
                state.importLastJob = job;
                state.importRegisteredJobId = null;
                state.importJobId = null;
                setImportBusy(false);
                if (job.status === 'completed') {
                    sourcePath.value = '';
                    await loadLibrary();
                    if (projectContext) {
                        const pending = projectContext.pendingImports[projectContext.index];
                        const resultItems = Array.isArray(job.result_items) ? job.result_items : [];
                        addProjectImportResults(projectContext, pending, resultItems);
                        projectContext.index += 1;
                        if (projectContext.index < projectContext.pendingImports.length) {
                            await startNextProjectCreationImport();
                        } else {
                            await finishProjectCreationImport(projectContext);
                        }
                    }
                } else if (projectContext) {
                    failProjectCreationImport(job.error || `Import ${job.status}`);
                }
                return;
            }
            importPollTimer = setTimeout(pollImportJob, job.phase === 'staging' ? 180 : 500);
        } catch (error) {
            renderImportPollingIssue(error.message);
            importPollTimer = setTimeout(pollImportJob, 1800);
        }
    }

    async function startImportJob() {
        const preview = state.importPreview;
        if (!preview) return;
        const moving = state.importTransferMode === 'move';
        if (moving && !window.confirm('Move these files into the vault? The original files will be removed from their current locations after GAIA verifies the vault copies. This cannot be undone by cancelling later.')) return;
        setImportBusy(true);
        try {
            const job = await createImportJob({
                preview_id: preview.preview_id,
                transfer_mode: state.importTransferMode,
                move_confirmed: moving,
                skip_track_analysis: state.skipTrackAnalysis,
                folder_assignments: Object.fromEntries(state.importFolderAssignments),
                item_types: Object.fromEntries(state.importItemTypes),
                excluded_indexes: [...state.importExcludedIndexes],
                conflict_action: state.importConflictAction,
            });
            state.importJobId = job.job_id;
            state.importLastJob = null;
            localStorage.setItem('gaia.activeImportJobId', job.job_id);
            renderImportJob(job);
            importDialog.close();
            resetImportFlow();
            pollImportJob();
        } catch (error) {
            importResult.textContent = error.message;
            importResult.className = 'result error';
            setImportBusy(false);
        }
    }

    async function cancelImportJob() {
        if (!state.importJobId) return;
        importProgressCancel.disabled = true;
        try {
            const response = await fetch(`/items/import/jobs/${state.importJobId}/cancel`, { method: 'POST' });
            if (!response.ok) {
                const error = await response.json().catch(() => ({}));
                throw new Error(error.detail || 'Could not cancel import');
            }
        } catch (error) {
            renderImportPollingIssue(error.message);
        }
    }


    function syncPreviewAssignmentsAndTypes(preview, newEntriesOnly = null) {
        if (!preview) return;
        if (!state.importUserModifiedFolders) state.importUserModifiedFolders = new Set();
        if (!state.importUserModifiedItems) state.importUserModifiedItems = new Set();

        const sortedFolders = (preview.nodes || [])
            .filter(node => node.kind === 'folder')
            .sort((a, b) => (Number(a.depth) || 0) - (Number(b.depth) || 0));

        const samplePackRoots = new Set();
        let packRootsChanged = false;
        const prevRootsKey = state.importLastSamplePackRootsKey || '';

        for (const folder of sortedFolders) {
            const fpath = folder.relative_path;
            const scanComplete = folder.scan_complete !== false;

            if (state.importUserModifiedFolders.has(fpath)) {
                const current = state.importFolderAssignments.get(fpath) || 'action:contain';
                if (current === 'profile:sample_pack') {
                    samplePackRoots.add(fpath);
                }
                continue;
            }

            if (!scanComplete) {
                if (!state.importFolderAssignments.has(fpath)) {
                    state.importFolderAssignments.set(fpath, 'action:contain');
                }
                continue;
            }

            const isUnderSamplePack = [...samplePackRoots].some(root =>
                root === '.' ? fpath !== '.' : fpath.startsWith(`${root}/`)
            );

            if (isUnderSamplePack) {
                state.importFolderAssignments.set(fpath, 'action:contain');
            } else if (folder.detected_assignment) {
                state.importFolderAssignments.set(fpath, folder.detected_assignment);
                if (folder.detected_assignment === 'profile:sample_pack') {
                    samplePackRoots.add(fpath);
                }
            } else if (folder.suggested_assignment === 'profile:sample_pack') {
                state.importFolderAssignments.set(fpath, 'profile:sample_pack');
                samplePackRoots.add(fpath);
            } else {
                state.importFolderAssignments.set(fpath, 'action:contain');
            }
        }

        const nextRootsKey = [...samplePackRoots].sort().join('|');
        if (nextRootsKey !== prevRootsKey) {
            packRootsChanged = true;
            state.importLastSamplePackRootsKey = nextRootsKey;
        }

        const targetEntries = (!packRootsChanged && Array.isArray(newEntriesOnly))
            ? newEntriesOnly
            : (preview.entries || []);
        const rootsList = [...samplePackRoots];
        const hasGlobalRoot = samplePackRoots.has('.');

        for (const entry of targetEntries) {
            if (state.importUserModifiedItems.has(entry.index)) {
                continue;
            }
            let resolvedType = entry.type;
            if (rootsList.length > 0 && (entry.family === 'audio' || (entry.allowed_types || []).includes('sample'))) {
                const isUnderSamplePack = hasGlobalRoot || rootsList.some(root => entry.relative_path.startsWith(`${root}/`));
                if (isUnderSamplePack) {
                    resolvedType = 'sample';
                }
            }
            state.importItemTypes.set(entry.index, resolvedType);
        }
    }


    async function pollInspectPreview(previewId) {
        if (!state.importPreview || state.importPreview.preview_id !== previewId) {
            stopPreviewPolling();
            return;
        }
        try {
            const sinceIndex = state.importPreview.entries?.length || 0;
            const res = await fetch(`/items/import/preview/${encodeURIComponent(previewId)}?since_index=${sinceIndex}`);
            if (!res.ok) {
                stopPreviewPolling();
                return;
            }
            const update = await res.json();
            if (!state.importPreview || state.importPreview.preview_id !== previewId) {
                return;
            }

            if (!Array.isArray(state.importPreview.nodes)) state.importPreview.nodes = [];
            if (!Array.isArray(state.importPreview.entries)) state.importPreview.entries = [];

            let changed = false;
            const newlyMatchedDbFolders = [];

            if (Array.isArray(update.folder_nodes)) {
                const existingFoldersByPath = new Map();
                for (const node of state.importPreview.nodes) {
                    if (node.kind === 'folder') {
                        existingFoldersByPath.set(node.relative_path, node);
                    }
                }
                for (const folderNode of update.folder_nodes) {
                    const existing = existingFoldersByPath.get(folderNode.relative_path);
                    if (!existing) {
                        state.importPreview.nodes.push(folderNode);
                        existingFoldersByPath.set(folderNode.relative_path, folderNode);
                        if (folderNode.relative_path !== '.') {
                            state.importCollapsedFolders.add(folderNode.relative_path);
                        }
                        if (folderNode.already_in_db) {
                            newlyMatchedDbFolders.push(folderNode.relative_path);
                        }
                        changed = true;
                    } else {
                        if (!existing.already_in_db && folderNode.already_in_db) {
                            newlyMatchedDbFolders.push(folderNode.relative_path);
                        }
                        if (
                            existing.scan_complete !== folderNode.scan_complete ||
                            existing.detected_assignment !== folderNode.detected_assignment ||
                            existing.suggested_assignment !== folderNode.suggested_assignment ||
                            existing.already_in_db !== folderNode.already_in_db ||
                            existing.warning_count !== folderNode.warning_count
                        ) {
                            changed = true;
                        }
                        Object.assign(existing, folderNode);
                    }
                }
            }

            const addedEntries = [];
            const allMatchedDbFolders = (update.folder_nodes || [])
                .filter(f => f.already_in_db)
                .map(f => f.relative_path);
            if (Array.isArray(update.new_entries) && update.new_entries.length > 0) {
                const startLen = state.importPreview.entries.length;
                for (const entry of update.new_entries) {
                    if (entry.index >= startLen) {
                        if (!entry.already_in_db && allMatchedDbFolders.length > 0) {
                            const inDbFolder = allMatchedDbFolders.some(fpath =>
                                fpath === '.' || entry.parent_path === fpath || entry.relative_path.startsWith(`${fpath}/`)
                            );
                            if (inDbFolder) entry.already_in_db = true;
                        }
                        state.importPreview.entries.push(entry);
                        state.importPreview.nodes.push(entry);
                        addedEntries.push(entry);
                        if (entry.already_in_db) {
                            state.importExcludedIndexes.add(entry.index);
                        }
                        changed = true;
                    }
                }
            }

            if (newlyMatchedDbFolders.length > 0) {
                for (const entry of state.importPreview.entries) {
                    if (entry.already_in_db && state.importExcludedIndexes.has(entry.index)) continue;
                    const inMatchedFolder = newlyMatchedDbFolders.some(fpath =>
                        fpath === '.' || entry.parent_path === fpath || entry.relative_path.startsWith(`${fpath}/`)
                    );
                    if (inMatchedFolder) {
                        entry.already_in_db = true;
                        state.importExcludedIndexes.add(entry.index);
                    }
                }
                changed = true;
            }

            if (state.importPreview.scan_status !== update.scan_status) {
                changed = true;
            }
            state.importPreview.scan_status = update.scan_status;
            state.importPreview.scan_progress_pct = update.scan_progress_pct;
            state.importPreview.scanned_folders = update.scanned_folders;
            state.importPreview.total_discovered_folders = update.total_discovered_folders;
            state.importPreview.file_count = update.file_count;
            state.importPreview.folder_count = update.folder_count;
            state.importPreview.size_bytes = update.size_bytes;
            if (update.conflicts) state.importPreview.conflicts = update.conflicts;
            if (update.filter_options) state.importPreview.filter_options = update.filter_options;
            state.importPreview.inspection_ms = update.inspection_ms;

            updateInspectProgressBar(state.importPreview);

            if (changed) {
                syncPreviewAssignmentsAndTypes(state.importPreview, addedEntries);
                renderImportPreview({ fromPoll: true });
            }

            if (update.scan_status === 'scanning') {
                previewPollTimer = setTimeout(() => pollInspectPreview(previewId), 160);
            } else {
                stopPreviewPolling();
            }
        } catch (err) {
            console.error('Error polling import preview:', err);
            stopPreviewPolling();
        }
    }


    function openInspectTableForPreview(preview, vaultId) {
        state.importVaultId = vaultId;
        state.importPreview = preview;
        state.importFolderAssignments = new Map();
        state.importItemTypes = new Map();
        state.importUserModifiedFolders = new Set();
        state.importUserModifiedItems = new Set();
        state.importLastSamplePackRootsKey = '';
        syncPreviewAssignmentsAndTypes(preview);

        state.importExcludedIndexes = new Set(
            (preview.entries || []).filter(entry => entry.already_in_db).map(entry => entry.index)
        );
        state.importSelectedRows.clear();
        state.importSelectionAnchor = null;
        state.importTransferMode = 'copy';
        state.skipTrackAnalysis = false;
        state.importCollapsedFolders = new Set(
            (preview.nodes || []).filter(node => node.kind === 'folder' && node.relative_path !== '.').map(node => node.relative_path),
        );
        state.importConflictAction = preview.conflicts?.length ? null : 'skip';
        state.importUpperExpanded = true;
        importDialog?.classList.remove('is-initial');
        importSourceStep.classList.add('hidden');
        importPreviewStep.classList.remove('hidden');
        renderVaults();
        renderImportPreview();
        if (importDialog && !importDialog.open) importDialog.showModal();

        stopPreviewPolling();
        if (preview.scan_status === 'scanning') {
            pollInspectPreview(preview.preview_id);
        }
    }

    async function startDirectFileImport(filePath, vaultId) {
        try {
            const preview = await requestImportPreview(filePath, vaultId);
            const job = await createImportJob({
                preview_id: preview.preview_id,
                transfer_mode: 'copy',
                move_confirmed: false,
                skip_track_analysis: false,
                folder_assignments: {},
                item_types: {},
                excluded_indexes: [],
                conflict_action: preview.conflicts?.length ? 'new_snapshot' : 'skip',
            });
            state.importJobId = job.job_id;
            state.importLastJob = null;
            localStorage.setItem('gaia.activeImportJobId', job.job_id);
            renderImportJob(job);
            pollImportJob();
        } catch (error) {
            renderImportPollingIssue(error.message || 'Direct file import failed');
        }
    }

    async function stageDroppedFile(file, sessionId, relativePath = '') {
        const url = `/items/import/drop-file?session_id=${encodeURIComponent(sessionId)}&filename=${encodeURIComponent(file.name)}&relative_path=${encodeURIComponent(relativePath)}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: file,
        });
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.detail || `Failed to stage ${file.name}`);
        }
        return await response.json();
    }

    async function readDirectoryEntries(dirEntry) {
        const entries = [];
        async function readAllInDir(entry, currentPath) {
            if (entry.isFile) {
                const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
                entries.push({ file, relativePath: currentPath + entry.name });
            } else if (entry.isDirectory) {
                const reader = entry.createReader();
                const readBatch = () => new Promise((resolve, reject) => reader.readEntries(resolve, reject));
                let batch = await readBatch();
                while (batch.length > 0) {
                    for (const child of batch) {
                        await readAllInDir(child, currentPath + entry.name + '/');
                    }
                    batch = await readBatch();
                }
            }
        }
        const reader = dirEntry.createReader();
        const readBatch = () => new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        let batch = await readBatch();
        while (batch.length > 0) {
            for (const child of batch) {
                await readAllInDir(child, dirEntry.name + '/');
            }
            batch = await readBatch();
        }
        return entries;
    }

    async function handleExternalFileDrop(event) {
        if (state.importJobId) {
            alert('An import job is already running. Please wait for it to complete.');
            return;
        }

        const targetVaultId = state.selectedVaultId ?? state.vaults[0]?.id;
        if (!targetVaultId) {
            alert('Please create or select a vault first.');
            return;
        }

        const dataTransfer = event.dataTransfer;
        const items = dataTransfer?.items;
        const files = dataTransfer?.files;
        if (!files || files.length === 0) return;

        let dirEntry = null;
        if (items && items.length > 0 && typeof items[0].webkitGetAsEntry === 'function') {
            const entry = items[0].webkitGetAsEntry();
            if (entry && entry.isDirectory) {
                dirEntry = entry;
            }
        }

        const firstFile = files[0];
        const isZip = firstFile.name.toLowerCase().endsWith('.zip');

        // Check if native path is available (e.g. Electron or desktop wrapper)
        if (firstFile && typeof firstFile.path === 'string' && firstFile.path.length > 0) {
            try {
                if (dirEntry || isZip) {
                    const preview = await requestImportPreview(firstFile.path, targetVaultId);
                    openInspectTableForPreview(preview, targetVaultId);
                } else if (files.length === 1) {
                    await startDirectFileImport(firstFile.path, targetVaultId);
                } else {
                    const preview = await requestImportPreview(firstFile.path, targetVaultId);
                    openInspectTableForPreview(preview, targetVaultId);
                }
            } catch (error) {
                renderImportPollingIssue(error.message || 'Import preview failed');
            }
            return;
        }

        // Standard browser: stream to temporary drop staging
        const sessionId = `drop_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        try {
            if (dirEntry) {
                const entries = await readDirectoryEntries(dirEntry);
                if (entries.length === 0) {
                    alert('The dropped folder is empty.');
                    return;
                }
                let stagedRoot = null;
                const concurrency = 6;
                for (let i = 0; i < entries.length; i += concurrency) {
                    const chunk = entries.slice(i, i + concurrency);
                    const results = await Promise.all(chunk.map(e => stageDroppedFile(e.file, sessionId, e.relativePath)));
                    if (!stagedRoot && results.length > 0) {
                        stagedRoot = results[0].staged_root;
                    }
                }
                const stagedFolderPath = `${stagedRoot}/${dirEntry.name}`;
                const preview = await requestImportPreview(stagedFolderPath, targetVaultId);
                openInspectTableForPreview(preview, targetVaultId);
            } else if (isZip) {
                const staged = await stageDroppedFile(firstFile, sessionId);
                const preview = await requestImportPreview(staged.staged_path, targetVaultId);
                openInspectTableForPreview(preview, targetVaultId);
            } else if (files.length === 1) {
                const staged = await stageDroppedFile(firstFile, sessionId);
                await startDirectFileImport(staged.staged_path, targetVaultId);
            } else {
                let stagedRoot = null;
                const concurrency = 6;
                for (let i = 0; i < files.length; i += concurrency) {
                    const chunk = Array.from(files).slice(i, i + concurrency);
                    const results = await Promise.all(chunk.map(f => stageDroppedFile(f, sessionId, `Dropped_Assets/${f.name}`)));
                    if (!stagedRoot && results.length > 0) {
                        stagedRoot = results[0].staged_root;
                    }
                }
                const stagedFolderPath = `${stagedRoot}/Dropped_Assets`;
                const preview = await requestImportPreview(stagedFolderPath, targetVaultId);
                openInspectTableForPreview(preview, targetVaultId);
            }
        } catch (error) {
            renderImportPollingIssue(error.message || 'Drop import failed');
        }
    }

    openImportButton?.addEventListener('click', () => {
        if (state.importJobActiveTransfer) return;
        state.importVaultId = state.selectedVaultId ?? state.importVaultId ?? state.vaults[0]?.id ?? null;
        renderVaults();
        resetImportFlow();
        importDialog?.showModal();
    });
    importDialogClose?.addEventListener('click', () => importDialog?.close());
    importCancel?.addEventListener('click', () => importDialog?.close());
    importSummaryClose?.addEventListener('click', () => importSummaryDialog?.close());
    importSummaryDone?.addEventListener('click', () => importSummaryDialog?.close());
    importProgressCancel?.addEventListener('click', cancelImportJob);
    importProgressResults?.addEventListener('click', () => {
        if (state.importLastJob) showImportJobSummary(state.importLastJob);
    });
    importProgressDismiss?.addEventListener('click', () => {
        state.importLastJob = null;
        importProgressContainer.classList.add('hidden');
    });

    function sourcePickerIcon(entry) {
        if (entry.kind === 'folder') {
            return '<span class="source-picker-file-icon folder" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M3.5 6.5h6l2 2h9v9.5a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18z"/></svg></span>';
        }
        if (entry.is_archive) {
            return '<span class="source-picker-file-icon archive" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M7 3.5h7l3 3V20H7zM14 3.5V7h3M11.7 7.5h1.8M11.7 10h1.8M11.7 12.5h1.8M11.8 15h1.6v2.5h-1.6z"/></svg></span>';
        }
        return '<span class="source-picker-file-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M7 3.5h7l3 3V20H7zM14 3.5V7h3"/></svg></span>';
    }

    function sourcePickerDate(value) {
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '—';
        return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
    }

    function getParentDirectoryPath(dirPath) {
        if (!dirPath) return null;
        const clean = dirPath.replace(/[\\/]+$/, '');
        const lastSep = Math.max(clean.lastIndexOf('\\'), clean.lastIndexOf('/'));
        if (lastSep < 0) return null;
        let parent = clean.slice(0, lastSep);
        if (/^[a-zA-Z]:$/.test(parent)) parent += '\\';
        return parent || null;
    }

    function renderSourcePicker(result) {
        const choosingVaultPath = Boolean(state.vaultPathPickerMode);
        state.sourcePickerDirectory = result.path;
        state.sourcePickerParent = result.parent || getParentDirectoryPath(result.path);
        state.sourcePickerSelection = choosingVaultPath ? null : result.selected_path || null;
        sourcePickerLocation.value = result.path;
        sourcePickerUp.disabled = !state.sourcePickerParent;

        sourcePickerLocations.innerHTML = (result.locations || []).map(location => {
            const active = String(location.path).toLocaleLowerCase() === String(result.path).toLocaleLowerCase();
            const symbol = location.kind === 'home' ? '⌂' : location.kind === 'music' ? '♫' : location.kind === 'drive' ? '▣' : '▱';
            return `<button class="source-picker-location ${active ? 'active' : ''}" type="button" data-path="${escapeHtml(location.path)}">
                <span class="source-picker-location-symbol" aria-hidden="true">${symbol}</span>
                <span class="source-picker-location-label">${escapeHtml(location.label)}</span>
            </button>`;
        }).join('');

        if (!result.entries?.length) {
            sourcePickerList.innerHTML = '<div class="source-picker-empty">This folder is empty.</div>';
        } else {
            sourcePickerList.innerHTML = result.entries.map(entry => {
                const selected = !choosingVaultPath && entry.path === state.sourcePickerSelection;
                const actionLabel = entry.kind === 'folder' ? `Open ${entry.name}` : `Select ${entry.name}`;
                return `<button class="source-picker-row" type="button" role="option" aria-label="${escapeHtml(actionLabel)}" aria-selected="${selected}" data-kind="${escapeHtml(entry.kind)}" data-path="${escapeHtml(entry.path)}" data-name="${escapeHtml(entry.name)}">
                    <span class="source-picker-name">${sourcePickerIcon(entry)}<strong>${escapeHtml(entry.name)}</strong></span>
                    <span class="source-picker-date">${escapeHtml(sourcePickerDate(entry.modified_at))}</span>
                    <span class="source-picker-size">${entry.kind === 'folder' ? '—' : escapeHtml(formatSize(entry.size_bytes))}</span>
                </button>`;
            }).join('');
        }
        updateSourcePickerSelection();
    }

    function updateSourcePickerSelection() {
        sourcePickerList.querySelectorAll('.source-picker-row').forEach(row => {
            row.setAttribute('aria-selected', String(row.dataset.path === state.sourcePickerSelection));
        });
        if (state.vaultPathPickerMode) {
            sourcePickerSelection.textContent = state.sourcePickerDirectory || 'No folder selected.';
            sourcePickerChoose.textContent = state.vaultPathPickerMode === 'migrate' ? 'Migrate to this root' : 'Use this root';
        } else if (state.sourcePickerSelection) {
            sourcePickerSelection.textContent = state.sourcePickerSelection;
            sourcePickerChoose.textContent = 'Choose file';
        } else {
            sourcePickerSelection.textContent = 'No file selected — the current folder will be used.';
            sourcePickerChoose.textContent = 'Choose this folder';
        }
        sourcePickerChoose.disabled = !state.sourcePickerDirectory;
    }

    async function loadSourcePicker(path = null) {
        sourcePickerResult.className = 'inline-error hidden';
        sourcePickerList.innerHTML = '<div class="source-picker-empty">Loading location…</div>';
        sourcePickerChoose.disabled = true;
        try {
            const query = path ? `?${new URLSearchParams({ path })}` : '';
            const response = await fetch(`/items/import/browse-source${query}`);
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.detail || 'Could not open that location');
            renderSourcePicker(result);
        } catch (error) {
            const fallback = getParentDirectoryPath(sourcePickerLocation?.value?.trim() || path);
            state.sourcePickerDirectory = null;
            state.sourcePickerParent = fallback;
            state.sourcePickerSelection = null;
            sourcePickerList.innerHTML = '<div class="source-picker-empty">Location unavailable.</div>';
            sourcePickerResult.textContent = error.message;
            sourcePickerResult.className = 'inline-error';
            sourcePickerChoose.disabled = true;
            sourcePickerUp.disabled = !fallback;
        }
    }

    async function openSourcePicker() {
        state.vaultPathPickerMode = null;
        if (sourcePickerTitle) sourcePickerTitle.textContent = 'Choose an import source';
        if (sourcePickerSubtitle) sourcePickerSubtitle.textContent = 'Select a folder, an individual asset, or a ZIP archive.';
        if (!sourcePickerDialog.open) sourcePickerDialog.showModal();
        await loadSourcePicker(sourcePath.value.trim() || null);
    }

    async function openVaultPathPicker(mode) {
        const activeVault = selectedVault();
        state.vaultPathPickerMode = mode;
        state.projectImportPickerActive = false;
        if (sourcePickerTitle) sourcePickerTitle.textContent = mode === 'migrate' ? 'Migrate vault' : 'Choose vault storage';
        if (sourcePickerSubtitle) sourcePickerSubtitle.textContent = 'Choose the asset-store folder that should contain this vault.';
        if (!sourcePickerDialog.open) sourcePickerDialog.showModal();
        const initialPath = mode === 'migrate' ? activeVault?.root_path : vaultPathInput?.value.trim();
        await loadSourcePicker(initialPath || null);
    }

    function chooseSourcePickerPath() {
        if (state.vaultPathPickerMode) {
            const mode = state.vaultPathPickerMode;
            const path = state.sourcePickerDirectory;
            state.vaultPathPickerMode = null;
            sourcePickerDialog.close();
            if (!path) return;
            if (mode === 'migrate') migrateActiveVault(path);
            else if (vaultPathInput) {
                vaultPathInput.value = path;
                vaultPathInput.title = path;
            }
            return;
        }
        const path = state.sourcePickerSelection || state.sourcePickerDirectory;
        if (!path) return;
        if (state.projectImportPickerActive) {
            state.projectImportPickerActive = false;
            sourcePickerDialog.close();
            inspectProjectImportSource(path);
            return;
        }
        sourcePath.value = path;
        sourcePickerDialog.close();
        importResult.className = 'result hidden';
        inspectImportSource();
    }

    async function inspectImportSource() {
        if (!state.importVaultId || vaultSelect.value === '__create__') {
            importResult.textContent = 'Choose or create a destination vault first.';
            importResult.className = 'result error';
            return;
        }
        if (!sourcePath.value.trim()) {
            importResult.textContent = 'Choose a source first.';
            importResult.className = 'result error';
            return;
        }
        importSubmit.disabled = true;
        importSubmit.textContent = 'Inspecting…';
        importResult.className = 'result hidden';
        try {
            const preview = await requestImportPreview(sourcePath.value, state.importVaultId);
            openInspectTableForPreview(preview, state.importVaultId);
        } catch (error) {
            importResult.textContent = error.message;
            importResult.className = 'result error';
        } finally {
            importSubmit.disabled = false;
            importSubmit.textContent = 'Inspect source';
        }
    }

    importForm?.addEventListener('submit', async event => {
        event.preventDefault();
        await inspectImportSource();
    });
    chooseSourcePath?.addEventListener('click', openSourcePicker);
    sourcePickerClose?.addEventListener('click', () => sourcePickerDialog?.close());
    sourcePickerCancel?.addEventListener('click', () => sourcePickerDialog?.close());
    sourcePickerDialog?.addEventListener('close', () => {
        state.projectImportPickerActive = false;
        state.vaultPathPickerMode = null;
    });
    sourcePickerUp?.addEventListener('click', () => {
        const target = state.sourcePickerParent || getParentDirectoryPath(state.sourcePickerDirectory || sourcePickerLocation?.value?.trim());
        if (target) loadSourcePicker(target);
    });
    sourcePickerLocationForm?.addEventListener('submit', event => {
        event.preventDefault();
        if (sourcePickerLocation) loadSourcePicker(sourcePickerLocation.value.trim());
    });
    sourcePickerLocations?.addEventListener('click', event => {
        const location = event.target.closest('[data-path]');
        if (location) loadSourcePicker(location.dataset.path);
    });
    sourcePickerList?.addEventListener('click', event => {
        const entry = event.target.closest('.source-picker-row');
        if (!entry) return;
        if (entry.dataset.kind === 'folder') {
            loadSourcePicker(entry.dataset.path);
            return;
        }
        if (state.vaultPathPickerMode) return;
        state.sourcePickerSelection = entry.dataset.path;
        updateSourcePickerSelection();
    });
    sourcePickerList?.addEventListener('dblclick', event => {
        if (state.vaultPathPickerMode) return;
        const entry = event.target.closest('.source-picker-row[data-kind="file"]');
        if (!entry) return;
        state.sourcePickerSelection = entry.dataset.path;
        chooseSourcePickerPath();
    });
    sourcePickerChoose?.addEventListener('click', chooseSourcePickerPath);
    vaultPathAction?.addEventListener('click', () => {
        const mode = getVaultDialogMode ? getVaultDialogMode() : vaultDialogMode;
        openVaultPathPicker(mode === 'rename' ? 'migrate' : 'create');
    });
    sourcePickerDialog?.addEventListener('click', event => {
        if (event.target === sourcePickerDialog) sourcePickerDialog.close();
    });

    vaultSelect?.addEventListener('change', () => {
        if (vaultSelect.value === '__create__') {
            showImportVaultCreate(true);
            importVaultName?.focus();
            return;
        }
        state.importVaultId = Number(vaultSelect.value);
        showImportVaultCreate(false);
    });
    importVaultCreateSubmit?.addEventListener('click', createImportVault);
    importVaultCreateCancel?.addEventListener('click', () => renderVaults());
    importVaultName?.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            createImportVault();
        }
    });


        return {
            pollImportJob,
            stopImportPolling,
            setImportBusy,
            resetImportFlow,
            renderImportJob,
            renderImportPollingIssue,
            showImportJobSummary,
            startImportJob,
            cancelImportJob,
            openInspectTableForPreview,
            startDirectFileImport,
            stageDroppedFile,
            handleExternalFileDrop,
            openSourcePicker,
            openVaultPathPicker,
            chooseSourcePickerPath,
            inspectImportSource,
            loadSourcePicker,
        };

    }

    window.GaiaImportWizard = {
        init: createImportWizard,
    };
})();
