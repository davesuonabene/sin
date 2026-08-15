document.addEventListener('DOMContentLoaded', () => {
    const state = {
        items: [],
        types: [],
        selectedTypes: new Set(),
        selectedTags: new Set(),
        query: '',
        expandedCollections: new Set(),
        selectedEntryIds: new Set(),
        selectionAnchorId: null,
        audio: null,
        playingKey: null,
        vaults: [],
        selectedVaultId: null,
        contextEntry: null,
        importAnalysisTypes: new Set(),
        importAnalysisTypesInitialized: false,
        importMode: 'auto',
    };

    const assetList = document.getElementById('asset-list');
    const summary = document.getElementById('library-summary');
    const searchInput = document.getElementById('search-input');
    const clearFilter = document.getElementById('clear-filter');
    const refreshButton = document.getElementById('refresh');
    const importForm = document.getElementById('import-form');
    const importDialog = document.getElementById('import-dialog');
    const openImportButton = document.getElementById('open-import');
    const importDialogClose = document.getElementById('import-dialog-close');
    const importCancel = document.getElementById('import-cancel');
    const importModeAuto = document.getElementById('import-mode-auto');
    const importModeSpecific = document.getElementById('import-mode-specific');
    const specificTypePanel = document.getElementById('specific-type-panel');
    const sourcePath = document.getElementById('source-path');
    const sourceFileChoice = document.getElementById('source-file-choice');
    const sourceFolderChoice = document.getElementById('source-folder-choice');
    const importResult = document.getElementById('import-result');
    const vaultSelect = document.getElementById('vault-select');
    const vaultForm = document.getElementById('vault-form');
    const vaultName = document.getElementById('vault-name');
    const vaultResult = document.getElementById('vault-result');
    const vaultImportLog = document.getElementById('vault-import-log');
    const vaultLogDescription = document.getElementById('vault-log-description');
    const listHeader = document.getElementById('list-header');
    const assetPanel = document.querySelector('.asset-panel');
    const contextMenu = document.getElementById('context-menu');
    const analyzeEntryButton = document.getElementById('analyze-entry');
    const deleteEntryMenuButton = document.getElementById('delete-entry-menu');
    const dispatchBar = document.getElementById('dispatch-bar');
    const dispatchCount = document.getElementById('dispatch-count');
    const dispatchTargetSelect = document.getElementById('dispatch-target-select');
    const dispatchSubmitBtn = document.getElementById('dispatch-submit-btn');
    const contextVaultOptions = document.getElementById('context-vault-options');
    const removeVaultEntryButton = document.getElementById('remove-vault-entry');
    const scrollLeftBtn = document.getElementById('scroll-left-header');
    const scrollRightBtn = document.getElementById('scroll-right-header');
    const filterStatus = document.getElementById('filter-status');
    const vaultChips = document.getElementById('vault-chips');
    const typeChips = document.getElementById('type-chips');
    const tagChips = document.getElementById('tag-chips');
    const analysisTypeList = document.getElementById('analysis-type-list');
    const analysisTypeStatus = document.getElementById('analysis-type-status');
    const importSubmit = document.getElementById('import-submit');
    const importSummaryDialog = document.getElementById('import-summary-dialog');
    const importSummaryContent = document.getElementById('import-summary-content');
    const importSummaryClose = document.getElementById('import-summary-close');
    const importSummaryDone = document.getElementById('import-summary-done');
    const createProjectButton = document.getElementById('create-project');
    const projectFromSelectionButton = document.getElementById('project-from-selection');
    const projectsPerSelectionButton = document.getElementById('projects-per-selection');
    const projectDialog = document.getElementById('project-dialog');
    const projectForm = document.getElementById('project-form');
    const projectDialogTitle = document.getElementById('project-dialog-title');
    const projectDialogClose = document.getElementById('project-dialog-close');
    const projectMode = document.getElementById('project-mode');
    const projectName = document.getElementById('project-name');
    const projectType = document.getElementById('project-type');
    const projectSelectionNote = document.getElementById('project-selection-note');
    const projectResult = document.getElementById('project-result');
    const projectFilesDialog = document.getElementById('project-files-dialog');
    const projectFilesForm = document.getElementById('project-files-form');
    const projectFilesTitle = document.getElementById('project-files-title');
    const projectFilesClose = document.getElementById('project-files-close');
    const projectFilesId = document.getElementById('project-files-id');
    const projectFilePaths = document.getElementById('project-file-paths');
    const projectFilesResult = document.getElementById('project-files-result');

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>'"]/g, char => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
        })[char]);
    }

    function filename(path) {
        return String(path || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || 'Untitled asset';
    }

    function typeDefinition(typeId) {
        return state.types.find(type => type.id === typeId);
    }

    function typeLabel(typeId) {
        return typeDefinition(typeId)?.label || typeId.replaceAll('_', ' ');
    }

    function typeIsContainer(typeId) {
        return Boolean(typeDefinition(typeId)?.container);
    }

    function typeIsProject(typeId) {
        let current = typeDefinition(typeId);
        while (current) {
            if (current.id === 'project' || current.project_type) return true;
            current = current.parent ? typeDefinition(current.parent) : null;
        }
        return false;
    }

    function normalizeFacetValue(value) {
        return String(value ?? '').trim().toLocaleLowerCase();
    }

    function assetType(item) {
        const declaredType = normalizeFacetValue(item?.type);
        if (declaredType && declaredType !== 'item') return declaredType;
        const source = normalizeFacetValue(item?.name || item?.title || item?.absolute_path);
        if (source.endsWith('.mid') || source.endsWith('.midi')) return 'midi';
        if (source.endsWith('.seq')) return 'sequence';
        return 'audio';
    }

    function assetTags(item) {
        if (!Array.isArray(item?.tags)) return [];
        const seen = new Set();
        return item.tags.map(tag => String(typeof tag === 'string' ? tag : tag?.name || '').trim())
            .filter(tag => {
                if (!tag) return false;
                const normalized = normalizeFacetValue(tag);
                if (seen.has(normalized)) return false;
                seen.add(normalized);
                return true;
            });
    }

    function assetVaultIds(item) {
        const rawIds = [
            ...(Array.isArray(item?.vault_ids) ? item.vault_ids : []),
            item?.vault_id,
        ];
        return [...new Set(rawIds.map(value => Number(value)).filter(Number.isFinite))];
    }

    function tagMatches(selectedTag, itemTag) {
        return itemTag === selectedTag
            || itemTag.startsWith(`${selectedTag}/`)
            || itemTag.startsWith(`${selectedTag}:`);
    }

    function assetMatchesFilters(item, selection = {}) {
        const selectedVaultIds = [...(selection.vaultIds || [])]
            .map(value => Number(value)).filter(Number.isFinite);
        if (selectedVaultIds.length && !selectedVaultIds.some(id => assetVaultIds(item).includes(id))) return false;

        const selectedTypes = [...(selection.types || [])].map(normalizeFacetValue).filter(Boolean);
        if (selectedTypes.length && !selectedTypes.includes(assetType(item))) return false;

        const selectedTags = [...(selection.tags || [])].map(normalizeFacetValue).filter(Boolean);
        if (!selectedTags.length) return true;
        const itemTags = assetTags(item).map(normalizeFacetValue);
        return selectedTags.every(selectedTag => itemTags.some(itemTag => tagMatches(selectedTag, itemTag)));
    }

    function filterableItem(entry) {
        if (entry.kind === 'asset') return entry.item;
        return {
            type: entry.type,
            tags: [...assetTags(entry.collection), ...assetTags(entry.content)],
            vault_ids: assetVaultIds(entry.collection),
            name: entry.title,
            absolute_path: entry.path,
        };
    }

    function selectedVaultIds() {
        return state.selectedVaultId === null ? [] : [state.selectedVaultId];
    }

    function filterableEntries() {
        return allEntries().map(entry => filterableItem(entry));
    }

    function compatibleFacets(selection) {
        const vaultIds = new Set();
        const types = new Set();
        const tags = new Map();
        filterableEntries().forEach(item => {
            if (assetMatchesFilters(item, { types: selection.types, tags: selection.tags })) {
                assetVaultIds(item).forEach(id => vaultIds.add(id));
            }
            if (assetMatchesFilters(item, { vaultIds: selection.vaultIds, tags: selection.tags })) {
                const type = assetType(item);
                if (typeDefinition(type)) types.add(type);
            }
            if (assetMatchesFilters(item, selection)) {
                assetTags(item).forEach(tag => {
                    const normalized = normalizeFacetValue(tag);
                    if (!tags.has(normalized)) tags.set(normalized, tag);
                });
            }
        });
        return { vaultIds, types, tags };
    }

    function allEntries() {
        const entries = state.items.map(item => ({
            kind: 'asset',
            id: String(item.id),
            type: item.type,
            title: item.title || filename(item.absolute_path),
            path: item.absolute_path,
            item,
        }));

        state.items.filter(item => typeIsContainer(item.type)).forEach(collection => {
            (collection.contents || []).forEach(content => {
                entries.push({
                    kind: 'content',
                    id: `${collection.id}:${content.index}`,
                    type: content.type,
                    title: content.title || content.filename,
                    path: content.relative_path,
                    content,
                    collection,
                });
            });
        });
        return entries;
    }

    function collectionContentEntries(collection) {
        return (collection.contents || []).map(content => ({
            kind: 'content',
            id: `${collection.id}:${content.index}`,
            type: content.type,
            title: content.title || content.filename,
            path: content.relative_path,
            content,
            collection,
        }));
    }

    function entryMatches(entry) {
        if (!assetMatchesFilters(filterableItem(entry), {
            vaultIds: selectedVaultIds(),
            types: state.selectedTypes,
            tags: state.selectedTags,
        })) return false;
        if (!state.query) return true;
        const haystack = [
            entry.title,
            entry.path,
            entry.collection?.title,
            entry.collection?.source_path,
            ...(entry.item?.tags || []).map(tag => tag?.name || tag),
            ...(entry.content?.tags || []),
        ].join(' ').toLowerCase();
        return haystack.includes(state.query);
    }

    function filteringIsActive() {
        return Boolean(state.selectedVaultId !== null || state.selectedTypes.size || state.selectedTags.size || state.query);
    }

    function visibleEntries() {
        const assets = state.items.map(item => ({
            kind: 'asset',
            id: String(item.id),
            type: item.type,
            title: item.title || filename(item.absolute_path),
            path: item.absolute_path,
            item,
        }));
        if (!filteringIsActive()) return assets.sort((a, b) => a.title.localeCompare(b.title));

        return assets.filter(entry => {
            if (entryMatches(entry)) return true;
            return typeIsContainer(entry.type) && collectionContentEntries(entry.item).some(entryMatches);
        }).sort((a, b) => a.title.localeCompare(b.title));
    }

    function selectionEntries() {
        const entries = [];
        visibleEntries().forEach(entry => {
            entries.push(entry);
            if (entry.kind === 'asset' && typeIsContainer(entry.type) && state.expandedCollections.has(entry.id)) {
                const contents = collectionContentEntries(entry.item);
                entries.push(...(filteringIsActive() ? contents.filter(entryMatches) : contents));
            }
        });
        return entries;
    }

    function selectEntry(entry, event) {
        const additive = event.ctrlKey || event.metaKey;
        if (event.shiftKey && state.selectionAnchorId) {
            const entries = selectionEntries();
            const start = entries.findIndex(candidate => candidate.id === state.selectionAnchorId);
            const end = entries.findIndex(candidate => candidate.id === entry.id);
            if (start >= 0 && end >= 0) {
                if (!additive) state.selectedEntryIds.clear();
                const [first, last] = start < end ? [start, end] : [end, start];
                entries.slice(first, last + 1).forEach(candidate => state.selectedEntryIds.add(candidate.id));
            } else {
                state.selectedEntryIds.clear();
                state.selectedEntryIds.add(entry.id);
            }
        } else if (additive) {
            state.selectedEntryIds.has(entry.id)
                ? state.selectedEntryIds.delete(entry.id)
                : state.selectedEntryIds.add(entry.id);
            state.selectionAnchorId = entry.id;
        } else {
            state.selectedEntryIds.clear();
            state.selectedEntryIds.add(entry.id);
            state.selectionAnchorId = entry.id;
        }
    }

    function entryPath(entry) {
        if (entry.kind === 'content') {
            return `${entry.collection.title || 'Collection'} / ${entry.path || entry.content.filename}`;
        }
        return entry.item.source_path || entry.item.absolute_path || '—';
    }

    function entryBpm(entry) {
        return entry.kind === 'content' ? entry.content.bpm : entry.item.bpm;
    }

    function entryKey(entry) {
        return entry.kind === 'content' ? entry.content.key : entry.item.key;
    }

    function entrySize(entry) {
        return entry.kind === 'content' ? entry.content.size_bytes : entry.item.size_bytes;
    }

    function entryAbsolutePath(entry) {
        if (entry.kind !== 'content') return entry.item.absolute_path;
        const root = String(entry.collection.absolute_path || '').replace(/[\\/]$/, '');
        return root ? `${root}/${entry.content.relative_path}` : entry.content.relative_path;
    }

    function formatSize(bytes) {
        const value = Number(bytes);
        if (!Number.isFinite(value) || value < 0) return '—';
        if (value < 1024) return `${value} B`;
        if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
        if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
        return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    }

    function entryTags(entry) {
        const rawTags = entry.kind === 'content' ? entry.content.tags : entry.item.tags;
        return (Array.isArray(rawTags) ? rawTags : []).map(tag => tag?.name || tag).filter(Boolean);
    }

    function dragPayload(entry) {
        const item = entry.kind === 'content' ? entry.content : entry.item;
        const collection = entry.kind === 'content' ? entry.collection : null;
        const stableId = collection
            ? (item.child_id || `collection:${collection.id}:${item.index}`)
            : item.id;
        return {
            type: 'library-item',
            itemType: entry.type || 'audio',
            id: stableId,
            collection_id: collection?.id,
            content_index: collection ? item.index : undefined,
            filepath: entryAbsolutePath(entry),
            name: entry.title,
            key: entryKey(entry) || null,
            bpm: entryBpm(entry) || null,
            stems: collection ? [] : (item.stems || []),
            is_valid_length: collection ? true : (item.is_valid_length ?? true),
            length_variance: collection ? 0 : (item.length_variance ?? 0),
        };
    }

    function streamUrl(entry) {
        if (entry.kind === 'content') return `/items/${entry.collection.id}/contents/${entry.content.index}/stream`;
        return `/items/${entry.item.id}/stream`;
    }

    function canPreview(entry) {
        if (entry.kind === 'content') return Boolean(entry.content.streamable);
        return ['audio', 'track', 'sample', 'loop', 'one_shot', 'multitrack'].includes(entry.type);
    }

    function play(entry) {
        const key = entry.id;
        if (state.audio && state.playingKey === key) {
            if (state.audio.paused) {
                state.audio.play();
            } else {
                state.audio.pause();
            }
            return;
        }

        if (state.audio) state.audio.pause();
        state.audio = new Audio(streamUrl(entry));
        state.playingKey = key;
        state.audio.onended = () => {
            state.playingKey = null;
        };
        state.audio.play().catch(() => {
            state.playingKey = null;
        });
    }

    function canEdit(entry, field) {
        if (field === 'tags') return true;
        if (field === 'title') return entry.kind === 'content' || typeIsContainer(entry.type);
        if (field === 'type') {
            if (entry.kind === 'content') return ['sample', 'loop', 'one_shot'].includes(entry.type);
            return ['sample', 'loop', 'one_shot', 'collection', 'sample_pack'].includes(entry.type);
        }
        if (field === 'bpm') return ['audio', 'sample', 'loop', 'one_shot', 'midi', 'multitrack'].includes(entry.type);
        if (field === 'key') return ['sample', 'loop', 'one_shot', 'midi', 'multitrack'].includes(entry.type);
        return false;
    }

    function entryValue(entry, field) {
        if (field === 'title') return entry.title;
        if (field === 'type') return entry.type;
        if (field === 'bpm') return entryBpm(entry);
        if (field === 'key') return entryKey(entry);
        if (field === 'tags') return entryTags(entry).join(', ');
        return '';
    }

    function updateEntryInState(entry, result) {
        if (entry.kind === 'content') {
            const collection = state.items.find(item => item.id === entry.collection.id);
            const index = collection?.contents?.findIndex(content => content.index === entry.content.index) ?? -1;
            if (index >= 0) collection.contents[index] = result;
        } else {
            const index = state.items.findIndex(item => item.id === entry.item.id);
            if (index >= 0) state.items[index] = result;
        }
    }

    async function saveMetadata(entry, field, rawValue) {
        let value = rawValue;
        if (field === 'tags') value = String(rawValue).split(',').map(tag => tag.trim()).filter(Boolean);
        if (field === 'bpm') value = rawValue === '' ? null : Number(rawValue);
        const url = entry.kind === 'content'
            ? `/items/${entry.collection.id}/contents/${entry.content.index}`
            : `/items/${entry.item.id}`;
        const response = await fetch(url, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ [field]: value }),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.detail || 'Could not update metadata');
        updateEntryInState(entry, result);
        renderFilterUI();
        renderAssets();
    }

    function rowEditing(editor, entry, field, initial) {
        let finished = false;
        const finish = async save => {
            if (finished) return;
            finished = true;
            const value = editor.value.trim();
            if (!save || value === String(initial ?? '')) {
                renderAssets();
                return;
            }
            try {
                await saveMetadata(entry, field, value);
            } catch (error) {
                window.alert(error.message);
                renderAssets();
            }
        };
        editor.addEventListener('click', event => event.stopPropagation());
        editor.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                finish(true);
            } else if (event.key === 'Escape') {
                event.preventDefault();
                finish(false);
            }
        });
        editor.addEventListener('blur', () => finish(true));
        if (editor.tagName === 'SELECT') editor.addEventListener('change', () => finish(true));
    }

    function beginCellEdit(cell, entry, field) {
        if (!canEdit(entry, field) || cell.querySelector('input, select')) return;
        const initial = entryValue(entry, field) ?? '';
        const editor = field === 'type' ? document.createElement('select') : document.createElement('input');
        editor.className = 'cell-editor';
        if (field === 'type') {
            const options = ['collection', 'sample_pack'].includes(entry.type)
                ? ['collection', 'sample_pack']
                : ['sample', 'loop', 'one_shot'];
            options.forEach(type => {
                const option = document.createElement('option');
                option.value = type;
                option.textContent = typeLabel(type);
                option.selected = type === initial;
                editor.appendChild(option);
            });
        } else {
            editor.type = field === 'bpm' ? 'number' : 'text';
            if (field === 'bpm') {
                editor.min = '20';
                editor.max = '400';
            }
            editor.value = initial;
        }
        cell.textContent = '';
        cell.appendChild(editor);
        rowEditing(editor, entry, field, initial);
        editor.focus();
        if (editor.select) editor.select();
    }

    function editableCell(entry, field, className, displayValue) {
        const editable = canEdit(entry, field);
        const value = displayValue === null || displayValue === undefined || displayValue === '' ? '—' : displayValue;
        return `<span class="${className}${editable ? ' editable-cell' : ''}" data-field="${field}"${editable ? ' title="Click to edit"' : ''}>${escapeHtml(value)}</span>`;
    }

    function createRow(entry, { nested = false } = {}) {
        const row = document.createElement('div');
        const isSamplePack = entry.kind === 'asset' && entry.type === 'sample_pack';
        row.className = `asset-row${isSamplePack ? ' sample-pack-row' : ''}${state.selectedEntryIds.has(entry.id) ? ' selected' : ''}`;
        row.setAttribute('role', 'listitem');
        row.setAttribute('aria-selected', String(state.selectedEntryIds.has(entry.id)));
        row.draggable = true;
        const isCollection = entry.kind === 'asset' && typeIsContainer(entry.type);
        if (isCollection) row.title = 'Double-click to show collection contents';
        const expanded = isCollection && state.expandedCollections.has(entry.id);
        const actions = [];

        if (isCollection) {
            actions.push(`<button class="expand" type="button" aria-label="Toggle ${escapeHtml(entry.title)}" aria-expanded="${expanded}">${expanded ? '⌄' : '›'}</button>`);
        }
        if (entry.kind === 'asset' && typeIsProject(entry.type)) {
            actions.push(`<button class="add-project-files" type="button" aria-label="Add files to ${escapeHtml(entry.title)}">Add files</button>`);
        }
        if (entry.kind === 'asset') {
            actions.push(`<button class="delete" type="button" aria-label="Delete ${escapeHtml(entry.title)}">Delete</button>`);
        }

        const titleCell = `<div class="asset-title${canEdit(entry, 'title') ? ' editable-cell' : ''}" data-field="title"${canEdit(entry, 'title') ? ' title="Click to edit"' : ''}><span class="asset-title-text">${escapeHtml(entry.title)}</span></div>`;
        row.innerHTML = isSamplePack ? `
            ${titleCell}
            <span></span><span></span><span></span><span></span><span></span><span></span>
            <span>${actions.join('')}</span>
        ` : `
            ${titleCell}
            <span class="path-text">${escapeHtml(entryPath(entry))}</span>
            ${editableCell(entry, 'type', 'type-badge', typeLabel(entry.type))}
            ${editableCell(entry, 'bpm', 'metadata-text', entryBpm(entry))}
            ${editableCell(entry, 'key', 'metadata-text', entryKey(entry))}
            ${editableCell(entry, 'tags', 'tags-text', entryTags(entry).join(', '))}
            <span class="size-text">${escapeHtml(formatSize(entrySize(entry)))}</span>
            <span>${actions.join('')}</span>
        `;

        row.querySelectorAll('.editable-cell').forEach(cell => {
            cell.addEventListener('click', event => {
                event.stopPropagation();
                beginCellEdit(cell, entry, cell.dataset.field);
            });
        });

        const expandButton = row.querySelector('.expand');
        if (expandButton) {
            expandButton.addEventListener('click', event => {
                event.stopPropagation();
                if (state.expandedCollections.has(entry.id)) state.expandedCollections.delete(entry.id);
                else state.expandedCollections.add(entry.id);
                renderAssets();
            });
        }
        const deleteButton = row.querySelector('.delete');
        if (deleteButton) {
            const handleDelete = async event => {
                event.preventDefault();
                event.stopPropagation();
                await deleteEntry(entry);
            };
            deleteButton.addEventListener('click', handleDelete);
            deleteButton.addEventListener('mousedown', event => event.stopPropagation());
        }
        const addProjectFilesButton = row.querySelector('.add-project-files');
        if (addProjectFilesButton) {
            addProjectFilesButton.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                openProjectFilesDialog(entry.item);
            });
        }
        row.addEventListener('dragstart', event => {
            if (!event.dataTransfer) return;
            const selectedEntries = state.selectedEntryIds.has(entry.id)
                ? allEntries().filter(candidate => state.selectedEntryIds.has(candidate.id))
                : [entry];
            const payload = JSON.stringify(selectedEntries.length === 1
                ? dragPayload(selectedEntries[0])
                : { type: 'library-items', items: selectedEntries.map(dragPayload) });
            event.dataTransfer.effectAllowed = 'copy';
            event.dataTransfer.setData('application/x-gaia-library-item', payload);
            event.dataTransfer.setData('text/plain', payload);
            row.classList.add('dragging');
        });
        row.addEventListener('dragend', () => row.classList.remove('dragging'));
        row.addEventListener('mousedown', event => {
            if (event.target.closest('.editable-cell, input, select, button')) return;
            if (event.ctrlKey || event.metaKey || event.shiftKey) {
                selectEntry(entry, event);
                event.preventDefault();
                renderAssets();
            }
        });
        row.addEventListener('click', event => {
            if (event.target.closest('.editable-cell, input, select, button')) return;
            if (event.ctrlKey || event.metaKey || event.shiftKey) return;
            selectEntry(entry, event);
            if (!isCollection && canPreview(entry)) {
                play(entry);
            }
            renderAssets();
        });
        row.addEventListener('dblclick', event => {
            if (!isCollection || event.target.closest('button, .editable-cell')) return;
            if (state.expandedCollections.has(entry.id)) state.expandedCollections.delete(entry.id);
            else state.expandedCollections.add(entry.id);
            renderAssets();
        });
        row.addEventListener('contextmenu', event => {
            event.preventDefault();
            if (!state.selectedEntryIds.has(entry.id)) {
                state.selectedEntryIds.clear();
                state.selectedEntryIds.add(entry.id);
                state.selectionAnchorId = entry.id;
                renderAssets();
            }
            state.contextEntry = entry;
            renderContextMenu();
            contextMenu.classList.remove('hidden');
            const width = contextMenu.offsetWidth || 180;
            const height = contextMenu.offsetHeight || 120;
            contextMenu.style.left = `${Math.min(event.clientX, window.innerWidth - width - 8)}px`;
            contextMenu.style.top = `${Math.min(event.clientY, window.innerHeight - height - 8)}px`;
        });
        return row;
    }

    async function deleteEntry(entry) {
        await deleteEntries([entry]);
    }

    function createEntry(entry, options = {}) {
        const wrapper = document.createElement('article');
        wrapper.className = 'asset-entry';
        wrapper.dataset.entryId = entry.id;
        if (entry.kind === 'asset') wrapper.dataset.itemId = String(entry.item.id);
        wrapper.appendChild(createRow(entry, options));
        return wrapper;
    }

    function renderLibraryStatus(entries = visibleEntries()) {
        const current = filteringIsActive()
            ? entries.reduce((count, entry) => {
                if (!typeIsContainer(entry.type)) return count + 1;
                const matchingContents = collectionContentEntries(entry.item).filter(entryMatches).length;
                return count + (matchingContents || (entryMatches(entry) ? 1 : 0));
            }, 0)
            : entries.length;
        const sourceCount = state.items.length;
        const vaultName = state.selectedVaultId !== null ? (selectedVault()?.name || 'vault') : 'All Central Assets';
        const selectionSuffix = state.selectedEntryIds.size ? ` · ${state.selectedEntryIds.size} selected` : '';
        summary.textContent = (filteringIsActive()
            ? `${current} assets match the active filter`
            : `${sourceCount} assets in ${vaultName}`) + selectionSuffix;
        const filterEntries = allEntries();
        const statusCurrent = filteringIsActive()
            ? filterEntries.filter(entryMatches).length
            : entries.length;
        const statusSourceCount = filteringIsActive() ? filterEntries.length : sourceCount;
        renderFilterStatus(statusCurrent, statusSourceCount);
    }

    function renderAssets() {
        const entries = visibleEntries();
        assetList.innerHTML = '';
        clearFilter.classList.toggle('hidden', !filteringIsActive());
        renderDispatchBar();

        if (filteringIsActive()) {
            const note = document.createElement('div');
            note.className = 'read-only-note';
            note.textContent = 'The active filter selects matching files inside each collection.';
            assetList.appendChild(note);
        }

        if (!entries.length) {
            assetList.innerHTML += '<div class="empty">No assets match this view.</div>';
        } else {
            entries.forEach(entry => {
                const wrapper = createEntry(entry);

                if (entry.kind === 'asset' && typeIsContainer(entry.type) && state.expandedCollections.has(entry.id)) {
                    const contentContainer = document.createElement('div');
                    contentContainer.className = 'collection-contents';
                    const contents = collectionContentEntries(entry.item);
                    const displayedContents = filteringIsActive() ? contents.filter(entryMatches) : contents;
                    displayedContents.forEach(content => contentContainer.appendChild(createEntry(content, { nested: true })));
                    if (!displayedContents.length) {
                        contentContainer.innerHTML = `<div class="empty">${filteringIsActive() ? 'No files in this collection match the active filter.' : 'This snapshot has no readable files.'}</div>`;
                    }
                    wrapper.appendChild(contentContainer);
                }
                assetList.appendChild(wrapper);
            });
        }

        renderLibraryStatus(entries);
    }

    function createFilterRail(chips) {
        const rail = document.createElement('div');
        rail.className = 'filter-rail';
        const makeArrow = direction => {
            const arrow = document.createElement('button');
            arrow.type = 'button';
            arrow.className = 'filter-scroll-control';
            arrow.textContent = direction < 0 ? '\u2039' : '\u203A';
            arrow.title = direction < 0 ? 'Scroll filters left' : 'Scroll filters right';
            arrow.setAttribute('aria-label', arrow.title);
            arrow.addEventListener('click', event => {
                event.stopPropagation();
                chips.scrollBy({ left: direction * Math.max(100, chips.clientWidth * 0.7), behavior: 'smooth' });
            });
            return arrow;
        };
        rail.append(makeArrow(-1), chips, makeArrow(1));
        return rail;
    }

    function enableHorizontalDragScroll(element) {
        let pointerId = null;
        let lastX = 0;
        let distance = 0;
        let suppressClick = false;
        element.addEventListener('pointerdown', event => {
            if (event.button !== 0 && event.button !== 1) return;
            pointerId = event.pointerId;
            lastX = event.clientX;
            distance = 0;
            if (event.button === 1) event.preventDefault();
        });
        element.addEventListener('pointermove', event => {
            if (pointerId !== event.pointerId) return;
            const delta = event.clientX - lastX;
            lastX = event.clientX;
            distance += Math.abs(delta);
            if (distance < 4) return;
            if (!element.hasPointerCapture(event.pointerId)) element.setPointerCapture(event.pointerId);
            element.scrollLeft -= delta;
            element.classList.add('is-dragging');
            event.preventDefault();
        });
        const stopDragging = event => {
            if (pointerId !== event.pointerId) return;
            suppressClick = distance >= 4;
            pointerId = null;
            element.classList.remove('is-dragging');
            if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
        };
        element.addEventListener('pointerup', stopDragging);
        element.addEventListener('pointercancel', stopDragging);
        element.addEventListener('click', event => {
            if (!suppressClick) return;
            suppressClick = false;
            event.preventDefault();
            event.stopImmediatePropagation();
        }, true);
    }

    function renderFilterStatus(current, sourceCount) {
        if (!filterStatus) return;
        filterStatus.replaceChildren();
        const activeFilterCount = state.selectedTypes.size + state.selectedTags.size + (state.selectedVaultId === null ? 0 : 1);
        const message = document.createElement('span');
        message.textContent = `${current} of ${sourceCount} assets${activeFilterCount ? ' \u00b7 types match any, tags match all' : ''}`;
        filterStatus.appendChild(message);
        if (activeFilterCount || state.query) {
            const clearButton = document.createElement('button');
            clearButton.type = 'button';
            clearButton.textContent = 'Clear filters';
            clearButton.addEventListener('click', clearAllFilters);
            filterStatus.appendChild(clearButton);
        }
    }

    function updateVaultChips(availableVaultIds) {
        if (!vaultChips) return;
        const scrollLeft = vaultChips.scrollLeft;
        vaultChips.replaceChildren();
        state.vaults.filter(vault => availableVaultIds.has(vault.id)).forEach(vault => {
            const selected = vault.id === state.selectedVaultId;
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = `filter-chip${selected ? ' active' : ''}`;
            chip.textContent = vault.name;
            chip.title = selected ? 'Show assets from all vaults' : vault.description || `Show assets from ${vault.name}`;
            chip.setAttribute('aria-pressed', String(selected));
            chip.addEventListener('click', event => {
                event.stopPropagation();
                state.selectedVaultId = selected ? null : vault.id;
                reconcileFilterSelection();
                renderVaults();
                renderFilterUI();
                renderAssets();
                loadVaultImportLog();
            });
            vaultChips.appendChild(chip);
        });
        if (!vaultChips.children.length) vaultChips.innerHTML = '<span class="filter-empty">No vaults available</span>';
        vaultChips.scrollLeft = scrollLeft;
    }

    function reconcileFilterSelection() {
        const items = filterableEntries();
        const populatedVaultIds = new Set(items.flatMap(assetVaultIds));
        if (state.selectedVaultId !== null && !populatedVaultIds.has(state.selectedVaultId)) {
            state.selectedVaultId = null;
        }

        const vaultIds = selectedVaultIds();
        const typesInVault = new Set(
            items.filter(item => assetMatchesFilters(item, { vaultIds })).map(assetType),
        );
        state.selectedTypes.forEach(type => {
            if (!typesInVault.has(type)) state.selectedTypes.delete(type);
        });

        const compatibleTags = new Set();
        state.selectedTags.forEach(tag => {
            const candidateTags = new Set([...compatibleTags, tag]);
            if (items.some(item => assetMatchesFilters(item, {
                vaultIds,
                types: state.selectedTypes,
                tags: candidateTags,
            }))) compatibleTags.add(tag);
        });
        state.selectedTags = compatibleTags;

        const compatibleTypes = new Set(
            items.filter(item => assetMatchesFilters(item, { vaultIds, tags: state.selectedTags })).map(assetType),
        );
        state.selectedTypes.forEach(type => {
            if (!compatibleTypes.has(type)) state.selectedTypes.delete(type);
        });
    }

    function renderFilterUI() {
        const facets = compatibleFacets({
            vaultIds: selectedVaultIds(),
            types: state.selectedTypes,
            tags: state.selectedTags,
        });
        updateVaultChips(facets.vaultIds);

        const typeScrollLeft = typeChips.scrollLeft;
        typeChips.replaceChildren();
        [...facets.types].sort().forEach(type => {
            const selected = state.selectedTypes.has(type);
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = `filter-chip${selected ? ' active' : ''}`;
            chip.textContent = typeLabel(type);
            chip.title = 'Types match any selected type';
            chip.setAttribute('aria-pressed', String(selected));
            chip.addEventListener('click', event => {
                event.stopPropagation();
                selected ? state.selectedTypes.delete(type) : state.selectedTypes.add(type);
                renderFilterUI();
                renderAssets();
            });
            typeChips.appendChild(chip);
        });
        if (!typeChips.children.length) typeChips.innerHTML = '<span class="filter-empty">No types available</span>';
        typeChips.scrollLeft = typeScrollLeft;

        const tagScrollLeft = tagChips.scrollLeft;
        tagChips.replaceChildren();
        [...facets.tags.values()].sort((a, b) => a.localeCompare(b)).forEach(tag => {
            const key = normalizeFacetValue(tag);
            const selected = state.selectedTags.has(key);
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = `filter-chip${selected ? ' active' : ''}`;
            chip.textContent = tag;
            chip.title = 'Every selected tag must match';
            chip.setAttribute('aria-pressed', String(selected));
            chip.addEventListener('click', event => {
                event.stopPropagation();
                selected ? state.selectedTags.delete(key) : state.selectedTags.add(key);
                renderFilterUI();
                renderAssets();
            });
            tagChips.appendChild(chip);
        });
        if (!tagChips.children.length) tagChips.innerHTML = '<span class="filter-empty">No tags available</span>';
        tagChips.scrollLeft = tagScrollLeft;
    }

    function clearAllFilters() {
        state.selectedVaultId = null;
        state.selectedTypes.clear();
        state.selectedTags.clear();
        state.query = '';
        searchInput.value = '';
        renderVaults();
        renderFilterUI();
        renderAssets();
    }

    function getSelectedEntries() {
        const entries = allEntries();
        const selected = [];
        state.selectedEntryIds.forEach(id => {
            const found = entries.find(e => e.id === id);
            if (found) selected.push(found);
        });
        if (selected.length === 0 && state.contextEntry) {
            selected.push(state.contextEntry);
        }
        return selected;
    }

    function getSelectedNumericItemIds() {
        const selected = getSelectedEntries();
        const ids = [];
        selected.forEach(entry => {
            if (entry.kind === 'asset' && entry.item && entry.item.id) {
                ids.push(Number(entry.item.id));
            } else if (entry.kind === 'content' && entry.collection && entry.collection.id) {
                ids.push(Number(entry.collection.id));
            }
        });
        return [...new Set(ids)];
    }

    function getSelectedLooseItemIds() {
        return allEntries()
            .filter(entry => state.selectedEntryIds.has(entry.id))
            .filter(entry => entry.kind === 'asset' && !typeIsContainer(entry.type) && !entry.item.parent_id)
            .map(entry => Number(entry.item.id))
            .filter(Number.isFinite);
    }

    function selectedProjectVaultId() {
        const fallback = Number(vaultSelect?.value);
        return state.selectedVaultId ?? (Number.isFinite(fallback) ? fallback : state.vaults[0]?.id);
    }

    function populateProjectTypes() {
        if (!projectType) return;
        projectType.replaceChildren();
        state.types.filter(type => type.project_type).forEach(type => {
            const option = document.createElement('option');
            option.value = type.id;
            option.textContent = type.label;
            projectType.appendChild(option);
        });
    }

    function importableFolderTypes() {
        return state.types.filter(type => (
            type.importable
            && type.container
            && !type.project_type
            && type.id !== 'collection'
        ));
    }

    function renderAnalysisTypeToggles() {
        if (!analysisTypeList) return;
        const availableTypes = importableFolderTypes();
        const availableIds = new Set(availableTypes.map(type => type.id));
        state.importAnalysisTypes = new Set(
            [...state.importAnalysisTypes].filter(typeId => availableIds.has(typeId))
        );
        if (!state.importAnalysisTypesInitialized) {
            if (availableTypes[0]) state.importAnalysisTypes.add(availableTypes[0].id);
            state.importAnalysisTypesInitialized = true;
        }

        analysisTypeList.replaceChildren();
        availableTypes.forEach(type => {
            const active = state.importAnalysisTypes.has(type.id);
            const button = document.createElement('button');
            button.type = 'button';
            button.className = `filter-chip analysis-type-toggle${active ? ' active' : ''}`;
            button.dataset.typeId = type.id;
            button.setAttribute('aria-pressed', String(active));
            button.textContent = type.id === 'multitrack' ? 'Stems' : type.label;
            button.addEventListener('click', () => {
                state.importAnalysisTypes.clear();
                state.importAnalysisTypes.add(type.id);
                renderAnalysisTypeToggles();
            });
            analysisTypeList.appendChild(button);
        });

        if (analysisTypeStatus) analysisTypeStatus.textContent = '';
        if (importSubmit) {
            importSubmit.disabled = state.importMode === 'specific' && !state.importAnalysisTypes.size;
        }
    }

    function renderImportMode() {
        const isAuto = state.importMode === 'auto';
        importModeAuto?.classList.toggle('active', isAuto);
        importModeAuto?.setAttribute('aria-pressed', String(isAuto));
        importModeSpecific?.classList.toggle('active', !isAuto);
        importModeSpecific?.setAttribute('aria-pressed', String(!isAuto));
        specificTypePanel?.classList.toggle('hidden', isAuto);
        renderAnalysisTypeToggles();
    }

    function renderImportSummary(result) {
        if (!importSummaryDialog || !importSummaryContent) return;
        const isBatch = result.type === 'batch';
        const isCollection = !isBatch && typeIsContainer(result.type);
        const items = isBatch
            ? (Array.isArray(result.items) ? result.items : [])
            : isCollection ? (Array.isArray(result.contents) ? result.contents : []) : [result];
        const collectionCount = isCollection ? 1 : 0;
        const totalSize = Number(result.size_bytes) || items.reduce(
            (sum, item) => sum + (Number(item.size_bytes) || 0),
            0,
        );
        const counts = new Map();
        items.forEach(item => {
            const itemType = item.type || 'item';
            counts.set(itemType, (counts.get(itemType) || 0) + 1);
        });
        const typeBreakdown = [...counts.entries()]
            .sort((left, right) => right[1] - left[1] || typeLabel(left[0]).localeCompare(typeLabel(right[0])))
            .map(([itemType, count]) => `
                <span class="import-type-count">
                    <strong>${escapeHtml(count)}</strong>${escapeHtml(typeLabel(itemType))}
                </span>
            `).join('');
        const previewLimit = 14;
        const rows = items.slice(0, previewLimit).map(item => {
            const itemName = item.title || item.filename || filename(item.absolute_path);
            const itemPath = item.relative_path || item.absolute_path || 'Managed asset';
            return `
                <div class="import-summary-row">
                    <span class="import-summary-row-name" title="${escapeHtml(itemName)}">${escapeHtml(itemName)}</span>
                    <span class="import-summary-row-path" title="${escapeHtml(itemPath)}">${escapeHtml(itemPath)}</span>
                    <span class="type-badge">${escapeHtml(typeLabel(item.type || 'item'))}</span>
                </div>
            `;
        }).join('');
        const warnings = Array.isArray(result.warnings) ? result.warnings.filter(Boolean) : [];
        const collectionSection = isCollection ? `
            <section class="import-summary-section">
                <h3>Collections found</h3>
                <div class="import-summary-list">
                    <div class="import-summary-row">
                        <span class="import-summary-row-name">${escapeHtml(result.title || filename(result.absolute_path))}</span>
                        <span class="import-summary-row-path" title="${escapeHtml(result.absolute_path)}">${escapeHtml(result.absolute_path)}</span>
                        <span class="type-badge">${escapeHtml(typeLabel(result.type))}</span>
                    </div>
                </div>
            </section>
        ` : '';
        const itemList = rows || '<div class="import-summary-more">No files were found inside this collection.</div>';

        importSummaryContent.innerHTML = `
            <div class="import-summary-hero">
                <div class="import-summary-title">
                    <h3>${escapeHtml(result.title || result.filename || filename(result.absolute_path))}</h3>
                    <p>${escapeHtml(result.absolute_path || '')}</p>
                </div>
                <div class="import-summary-metrics">
                    <div class="import-summary-metric"><strong>${collectionCount}</strong><span>Collections</span></div>
                    <div class="import-summary-metric"><strong>${items.length}</strong><span>Items</span></div>
                    <div class="import-summary-metric"><strong>${escapeHtml(formatSize(totalSize))}</strong><span>Size</span></div>
                </div>
            </div>
            ${warnings.length ? `
                <div class="import-warning-box">
                    <strong>Imported with ${warnings.length === 1 ? 'a warning' : 'warnings'}</strong>
                    ${warnings.map(warning => `<div>${escapeHtml(warning)}</div>`).join('')}
                </div>
            ` : ''}
            ${collectionSection}
            <section class="import-summary-section">
                <h3>Items found</h3>
                ${typeBreakdown ? `<div class="import-type-breakdown">${typeBreakdown}</div>` : ''}
                <div class="import-summary-list" style="margin-top: 8px">
                    ${itemList}
                    ${items.length > previewLimit ? `<div class="import-summary-more">${items.length - previewLimit} more items are available in the Library.</div>` : ''}
                </div>
            </section>
        `;
        importSummaryDialog.showModal();
    }

    function openProjectDialog(mode = 'empty') {
        if (!projectDialog) return;
        const selectedIds = getSelectedLooseItemIds();
        if (mode !== 'empty' && !selectedIds.length) {
            window.alert('Select one or more loose files first.');
            return;
        }
        populateProjectTypes();
        projectMode.value = mode;
        projectResult.className = 'result hidden';
        projectName.value = '';
        const nameLabel = projectName.previousElementSibling;
        const onePerItem = mode === 'one_per_item';
        projectName.required = !onePerItem;
        projectName.disabled = onePerItem;
        projectName.classList.toggle('hidden', onePerItem);
        nameLabel?.classList.toggle('hidden', onePerItem);
        projectDialogTitle.textContent = mode === 'empty'
            ? 'Create a Project'
            : onePerItem ? 'Create one Project per file' : 'Create a Project from files';
        projectSelectionNote.classList.toggle('hidden', mode === 'empty');
        projectSelectionNote.textContent = mode === 'empty'
            ? ''
            : `${selectedIds.length} loose file${selectedIds.length === 1 ? '' : 's'} will be encapsulated.`;
        projectDialog.showModal();
        if (!onePerItem) projectName.focus();
    }

    function openProjectFilesDialog(project) {
        if (!projectFilesDialog) return;
        projectFilesId.value = String(project.id);
        projectFilesTitle.textContent = `Add files to ${project.title || filename(project.absolute_path)}`;
        projectFilePaths.value = '';
        projectFilesResult.className = 'result hidden';
        projectFilesDialog.showModal();
        projectFilePaths.focus();
    }

    async function dispatchSelectedEntriesToVault(targetVaultId) {
        const itemIds = getSelectedNumericItemIds();
        if (!itemIds.length) return;
        try {
            const response = await fetch('/items/dispatch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ item_ids: itemIds, vault_id: targetVaultId }),
            });
            if (!response.ok) {
                const err = await response.json().catch(() => ({}));
                throw new Error(err.detail || 'Dispatch failed');
            }
            state.selectedEntryIds.clear();
            await loadLibrary();
        } catch (error) {
            window.alert(error.message);
        }
    }

    function renderDispatchBar() {
        if (!dispatchBar) return;
        const selectedCount = state.selectedEntryIds.size;
        if (selectedCount === 0) {
            dispatchBar.classList.add('hidden');
            return;
        }
        dispatchBar.classList.remove('hidden');
        dispatchCount.textContent = `${selectedCount} selected`;
        const projectableCount = getSelectedLooseItemIds().length;
        const canCreateProjects = projectableCount > 0 && projectableCount === selectedCount;
        projectFromSelectionButton?.classList.toggle('hidden', !canCreateProjects);
        projectsPerSelectionButton?.classList.toggle('hidden', !canCreateProjects);
        dispatchTargetSelect.innerHTML = '';
        state.vaults.forEach(vault => {
            const option = document.createElement('option');
            option.value = String(vault.id);
            option.textContent = vault.name;
            dispatchTargetSelect.appendChild(option);
        });
    }

    async function deleteSelectedEntries() {
        await deleteEntries(getSelectedEntries());
    }

    function removeDeletedItems(itemIds) {
        if (!itemIds.size) return;
        const filterStateBefore = JSON.stringify({
            vault: state.selectedVaultId,
            types: [...state.selectedTypes].sort(),
            tags: [...state.selectedTags].sort(),
        });

        state.items = state.items.filter(item => !itemIds.has(Number(item.id)));
        itemIds.forEach(id => state.expandedCollections.delete(String(id)));
        state.selectedEntryIds = new Set(
            [...state.selectedEntryIds].filter(entryId => (
                ![...itemIds].some(id => entryId === String(id) || entryId.startsWith(`${id}:`))
            )),
        );
        state.contextEntry = null;
        state.selectionAnchorId = null;

        if (state.audio) {
            state.audio.pause();
            state.audio = null;
            state.playingKey = null;
        }

        reconcileFilterSelection();
        renderVaults();
        renderFilterUI();
        const filterStateAfter = JSON.stringify({
            vault: state.selectedVaultId,
            types: [...state.selectedTypes].sort(),
            tags: [...state.selectedTags].sort(),
        });
        if (filterStateBefore !== filterStateAfter) {
            renderAssets();
            return;
        }

        itemIds.forEach(id => {
            assetList.querySelector(`[data-item-id="${id}"]`)?.remove();
        });
        clearFilter.classList.toggle('hidden', !filteringIsActive());
        renderDispatchBar();
        const entries = visibleEntries();
        if (!entries.length && !assetList.querySelector('.empty')) {
            assetList.innerHTML = '<div class="empty">No assets match this view.</div>';
        }
        renderLibraryStatus(entries);
    }

    async function deleteEntries(entries) {
        const itemMap = new Map();

        entries.forEach(entry => {
            if (entry.kind === 'asset' && entry.item && entry.item.id) {
                itemMap.set(Number(entry.item.id), entry.title || `Asset ${entry.item.id}`);
            }
        });

        if (itemMap.size === 0) return;

        const count = itemMap.size;
        const confirmMsg = count === 1
            ? `Remove “${[...itemMap.values()][0]}” from the library?`
            : `Remove ${count} selected items from the library?`;

        if (!window.confirm(confirmMsg)) return;

        try {
            const deletedIds = new Set();
            const failures = [];
            for (const id of itemMap.keys()) {
                const response = await fetch(`/items/${id}`, { method: 'DELETE' });
                if (!response.ok) {
                    const result = await response.json().catch(() => ({}));
                    failures.push(result.detail || `Could not remove asset ${id}`);
                } else {
                    deletedIds.add(id);
                }
            }
            removeDeletedItems(deletedIds);
            if (failures.length) window.alert(failures.join('\n'));
        } catch (error) {
            window.alert(error.message || 'Delete failed');
        }
    }

    function renderContextMenu() {
        if (!contextVaultOptions) return;

        const count = (state.contextEntry && state.selectedEntryIds.has(state.contextEntry.id))
            ? state.selectedEntryIds.size
            : 1;

        if (analyzeEntryButton) {
            analyzeEntryButton.textContent = count > 1 ? `Analyze metadata (${count} items)` : 'Analyze metadata';
        }
        if (deleteEntryMenuButton) {
            deleteEntryMenuButton.textContent = count > 1 ? `Delete selected (${count})` : 'Delete selected';
        }

        contextVaultOptions.innerHTML = '<div class="context-header">Dispatch to Vault</div>';
        state.vaults.forEach(vault => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = `▶ ${vault.name}`;
            const handleDispatch = async event => {
                if (event) { event.preventDefault(); event.stopPropagation(); }
                contextMenu.classList.add('hidden');
                await dispatchSelectedEntriesToVault(vault.id);
            };
            btn.addEventListener('click', handleDispatch);
            contextVaultOptions.appendChild(btn);
        });

        if (state.selectedVaultId !== null) {
            removeVaultEntryButton.classList.remove('hidden');
            const vault = selectedVault();
            removeVaultEntryButton.textContent = `Remove from ${vault?.name || 'Vault'}`;
        } else {
            removeVaultEntryButton.classList.add('hidden');
        }
    }

    function selectedVault() {
        return state.vaults.find(vault => vault.id === state.selectedVaultId);
    }

    function renderVaults() {
        vaultSelect.innerHTML = '';
        if (!state.vaults.length) {
            const option = document.createElement('option');
            option.textContent = 'No vaults available';
            option.disabled = true;
            option.selected = true;
            vaultSelect.appendChild(option);
            return;
        }
        const importVaultId = state.selectedVaultId ?? state.vaults[0].id;
        state.vaults.forEach(vault => {
            const option = document.createElement('option');
            option.value = String(vault.id);
            option.textContent = vault.name;
            option.selected = vault.id === importVaultId;
            vaultSelect.appendChild(option);
        });
    }

    async function loadVaults() {
        const response = await fetch('/vaults/');
        if (!response.ok) throw new Error('GAIA could not load vaults');
        state.vaults = await response.json();
        renderVaults();
    }

    async function loadVaultImportLog() {
        if (!state.selectedVaultId) return;
        const vault = selectedVault();
        vaultLogDescription.textContent = `Recent imports and file actions for ${vault?.name || 'this vault'}.`;
        try {
            const response = await fetch(`/vaults/${state.selectedVaultId}/imports?limit=10`);
            if (!response.ok) throw new Error('Could not load vault activity');
            const logs = await response.json();
            vaultImportLog.innerHTML = logs.length
                ? logs.map(log => `<div class="vault-log-entry"><strong>${escapeHtml(log.action.replaceAll('_', ' '))}</strong><span title="${escapeHtml(log.source_path)}">${escapeHtml(filename(log.source_path))} — ${escapeHtml(log.detail || log.status)}</span></div>`).join('')
                : '<div class="empty">No imports have been recorded for this vault yet.</div>';
        } catch (error) {
            vaultImportLog.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
        }
    }

    async function loadLibrary() {
        assetList.innerHTML = '<div class="empty">Loading library…</div>';
        try {
            if (!state.vaults.length) await loadVaults();
            const [typesResponse, itemsResponse] = await Promise.all([
                fetch('/items/types'),
                fetch('/items/?limit=10000'),
            ]);
            if (!typesResponse.ok || !itemsResponse.ok) throw new Error('GAIA could not load the library');
            state.types = await typesResponse.json();
            state.items = await itemsResponse.json();
            renderAnalysisTypeToggles();
            const availableEntryIds = new Set(allEntries().map(entry => entry.id));
            state.selectedEntryIds = new Set([...state.selectedEntryIds].filter(id => availableEntryIds.has(id)));
            if (!availableEntryIds.has(state.selectionAnchorId)) state.selectionAnchorId = null;
            reconcileFilterSelection();
            renderFilterUI();
            renderAssets();
        } catch (error) {
            assetList.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
            summary.textContent = 'Library unavailable';
        }
    }

    let currentAnalysisPollTimer = null;
    let currentAnalysisTaskId = null;

    function stopBatchAnalysisPolling() {
        if (currentAnalysisPollTimer) {
            clearInterval(currentAnalysisPollTimer);
            currentAnalysisPollTimer = null;
        }
    }

    function showAnalysisProgress(entry) {
        const progressContainer = document.getElementById('analysis-progress-container');
        const progressLabel = document.getElementById('analysis-progress-label');
        const progressDetail = document.getElementById('analysis-progress-detail');
        const progressPercent = document.getElementById('analysis-progress-percent');
        const progressFill = document.getElementById('analysis-progress-fill');
        const isCollection = entry.kind === 'asset' && typeIsContainer(entry.type);
        const loadedChildCount = Array.isArray(entry.item?.contents) ? entry.item.contents.length : 0;
        const declaredChildCount = Number(entry.item?.content_count) || 0;
        const childCount = isCollection
            ? Math.max(declaredChildCount, loadedChildCount)
            : entry.kind === 'content' ? 1 : 0;

        if (progressContainer) progressContainer.classList.remove('hidden');
        if (progressLabel) progressLabel.textContent = isCollection
            ? `Analyzing ${entry.title}...`
            : 'Analyzing metadata...';
        if (progressDetail) progressDetail.textContent = isCollection
            ? `Found ${childCount} children · analyzing metadata...`
            : 'Analyzing metadata...';
        if (progressPercent) progressPercent.textContent = '0%';
        if (progressFill) {
            progressFill.classList.add('is-indeterminate');
            progressFill.style.width = '34%';
        }
        return { childCount, progressContainer, progressDetail, progressFill, progressLabel, progressPercent };
    }

    function completeAnalysisProgress(progress, entry, result) {
        if (!progress) return;
        const analyzedChildCount = entry.kind === 'asset' && typeIsContainer(entry.type)
            ? Array.isArray(result?.contents) ? result.contents.length : progress.childCount
            : progress.childCount;
        if (progress.progressFill) {
            progress.progressFill.classList.remove('is-indeterminate');
            progress.progressFill.style.width = '100%';
        }
        if (progress.progressPercent) progress.progressPercent.textContent = '100%';
        if (progress.progressLabel) progress.progressLabel.textContent = 'Analysis complete';
        if (progress.progressDetail) progress.progressDetail.textContent = entry.kind === 'asset' && typeIsContainer(entry.type)
            ? `${analyzedChildCount} children analyzed`
            : 'Metadata analysis complete';
        setTimeout(() => {
            if (progress.progressContainer) progress.progressContainer.classList.add('hidden');
        }, 1800);
    }

    function hideAnalysisProgress(progress) {
        if (!progress) return;
        if (progress.progressFill) progress.progressFill.classList.remove('is-indeterminate');
        if (progress.progressContainer) progress.progressContainer.classList.add('hidden');
    }

    function startBatchAnalysisPolling(taskId, totalCount, unitLabel = 'items') {
        stopBatchAnalysisPolling();
        const progressContainer = document.getElementById('analysis-progress-container');
        const progressLabel = document.getElementById('analysis-progress-label');
        const progressDetail = document.getElementById('analysis-progress-detail');
        const progressPercent = document.getElementById('analysis-progress-percent');
        const progressFill = document.getElementById('analysis-progress-fill');

        currentAnalysisPollTimer = setInterval(async () => {
            try {
                const res = await fetch(`/items/analyze-batch/${taskId}`);
                if (!res.ok) return;
                const data = await res.json();

                const completed = data.completed || 0;
                const total = data.total || totalCount;
                const pct = Math.round((completed / total) * 100);
                const progressUnit = data.children_found && total === data.children_found ? 'children' : unitLabel;

                if (progressPercent) progressPercent.textContent = `${pct}%`;
                if (progressFill) {
                    progressFill.classList.remove('is-indeterminate');
                    progressFill.style.width = `${pct}%`;
                }
                if (progressLabel) progressLabel.textContent = `Analyzing ${completed} / ${total} ${progressUnit}...`;
                if (progressDetail) progressDetail.textContent = data.current_title ? `Current: ${data.current_title}` : (data.status === 'completed' ? 'Analysis complete' : 'Processing...');

                if (Array.isArray(data.updated_items) && data.updated_items.length > 0) {
                    data.updated_items.forEach(update => {
                        if (update.kind === 'content') {
                            const entry = allEntries().find(e => e.kind === 'content' && e.collection.id === update.item_id && e.content.index === update.content_index);
                            if (entry) updateEntryInState(entry, update.content);
                        }
                    });
                    renderFilterUI();
                    renderAssets();
                }

                if (data.status === 'completed' || data.status === 'cancelled' || data.status === 'failed') {
                    stopBatchAnalysisPolling();
                    await loadLibrary();
                    if (progressLabel) progressLabel.textContent = `Completed ${completed} of ${total} ${progressUnit}`;
                    setTimeout(() => {
                        if (progressContainer) progressContainer.classList.add('hidden');
                    }, 2500);
                }
            } catch (err) {
                console.error("Batch polling error", err);
            }
        }, 250);
    }

    async function analyzeSelectedEntries() {
        const contextEntry = state.contextEntry;
        let selectedEntries = [];
        if (contextEntry && state.selectedEntryIds.has(contextEntry.id)) {
            selectedEntries = allEntries().filter(e => state.selectedEntryIds.has(e.id));
        } else if (contextEntry) {
            selectedEntries = [contextEntry];
        } else if (state.selectedEntryIds.size > 0) {
            selectedEntries = allEntries().filter(e => state.selectedEntryIds.has(e.id));
        }

        if (selectedEntries.length === 0) return;

        const includesCollection = selectedEntries.some(entry => entry.kind === 'asset' && typeIsContainer(entry.type));
        if (selectedEntries.length === 1 && !includesCollection) {
            await analyzeEntry(selectedEntries[0]);
            return;
        }

        const targets = selectedEntries.map(e => {
            if (e.kind === 'content') {
                return { kind: 'content', item_id: e.collection.id, content_index: e.content.index };
            }
            return { kind: 'item', item_id: e.item.id };
        });

        const progressContainer = document.getElementById('analysis-progress-container');
        const progressLabel = document.getElementById('analysis-progress-label');
        const progressDetail = document.getElementById('analysis-progress-detail');
        const progressPercent = document.getElementById('analysis-progress-percent');
        const progressFill = document.getElementById('analysis-progress-fill');
        const cancelBtn = document.getElementById('cancel-analysis-btn');

        if (progressContainer) progressContainer.classList.remove('hidden');
        if (progressLabel) progressLabel.textContent = includesCollection ? 'Finding pack children...' : `Analyzing ${selectedEntries.length} items...`;
        if (progressDetail) progressDetail.textContent = includesCollection ? 'Preparing child analysis...' : 'Initializing background worker thread...';
        if (progressPercent) progressPercent.textContent = '0%';
        if (progressFill) progressFill.style.width = '0%';
        if (progressFill) progressFill.classList.remove('is-indeterminate');

        try {
            const res = await fetch('/items/analyze-batch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ targets })
            });

            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.detail || 'Failed to start batch analysis');
            }

            const data = await res.json();
            currentAnalysisTaskId = data.task_id;
            const unitLabel = data.children_found && data.total === data.children_found ? 'children' : 'items';

            if (data.children_found) {
                if (progressLabel) progressLabel.textContent = `Found ${data.children_found} children`;
                if (progressDetail) progressDetail.textContent = 'Starting child analysis...';
            }

            if (cancelBtn) {
                cancelBtn.onclick = async () => {
                    if (currentAnalysisTaskId) {
                        await fetch(`/items/analyze-batch/${currentAnalysisTaskId}/cancel`, { method: 'POST' }).catch(() => {});
                    }
                    stopBatchAnalysisPolling();
                    if (progressContainer) progressContainer.classList.add('hidden');
                };
            }

            startBatchAnalysisPolling(currentAnalysisTaskId, data.total || selectedEntries.length, unitLabel);
        } catch (err) {
            window.alert(err.message);
            if (progressContainer) progressContainer.classList.add('hidden');
        }
    }

    async function analyzeEntry(entry) {
        const url = entry.kind === 'content'
            ? `/items/${entry.collection.id}/contents/${entry.content.index}/analyze`
            : `/items/${entry.item.id}/analyze`;
        const progress = showAnalysisProgress(entry);
        analyzeEntryButton.disabled = true;
        analyzeEntryButton.textContent = typeIsContainer(entry.type) ? 'Analyzing collection…' : 'Analyzing…';
        try {
            const response = await fetch(url, { method: 'POST' });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.detail || 'Analysis failed');
            updateEntryInState(entry, result);
            renderFilterUI();
            renderAssets();
            completeAnalysisProgress(progress, entry, result);
        } catch (error) {
            hideAnalysisProgress(progress);
            window.alert(error.message);
        } finally {
            analyzeEntryButton.disabled = false;
            analyzeEntryButton.textContent = 'Analyze metadata';
        }
    }

    function initializeColumnResizing() {
        const minimums = [120, 160, 82, 58, 72, 110, 68, 56];
        listHeader.querySelectorAll('.column-resizer').forEach((handle, index) => {
            handle.addEventListener('pointerdown', event => {
                event.preventDefault();
                event.stopPropagation();
                const cells = [...listHeader.children];
                const widths = cells.map(cell => cell.getBoundingClientRect().width);
                const startX = event.clientX;
                document.body.classList.add('resizing-columns');

                const move = moveEvent => {
                    const combined = widths[index] + widths[index + 1];
                    const left = Math.max(minimums[index], Math.min(combined - minimums[index + 1], widths[index] + moveEvent.clientX - startX));
                    const next = [...widths];
                    next[index] = left;
                    next[index + 1] = combined - left;
                    assetPanel.style.setProperty('--asset-columns', next.map(width => `${width}px`).join(' '));
                };
                const stop = () => {
                    document.body.classList.remove('resizing-columns');
                    window.removeEventListener('pointermove', move);
                    window.removeEventListener('pointerup', stop);
                };
                window.addEventListener('pointermove', move);
                window.addEventListener('pointerup', stop, { once: true });
            });
        });
    }

    searchInput.addEventListener('input', () => {
        state.query = searchInput.value.trim().toLowerCase();
        renderAssets();
    });
    clearFilter.addEventListener('click', () => {
        clearAllFilters();
    });
    refreshButton.addEventListener('click', loadLibrary);

    createProjectButton?.addEventListener('click', () => openProjectDialog('empty'));
    projectFromSelectionButton?.addEventListener('click', () => openProjectDialog('single'));
    projectsPerSelectionButton?.addEventListener('click', () => openProjectDialog('one_per_item'));
    projectDialogClose?.addEventListener('click', () => projectDialog.close());
    projectFilesClose?.addEventListener('click', () => projectFilesDialog.close());

    projectForm?.addEventListener('submit', async event => {
        event.preventDefault();
        const mode = projectMode.value;
        const payload = {
            project_type: projectType.value,
            vault_id: selectedProjectVaultId(),
        };
        const url = mode === 'empty' ? '/projects/' : '/projects/from-items';
        if (mode === 'empty') {
            payload.name = projectName.value;
        } else {
            payload.item_ids = getSelectedLooseItemIds();
            payload.mode = mode;
            if (mode === 'single') payload.name = projectName.value;
        }
        projectResult.className = 'result hidden';
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.detail || 'Could not create Project');
            state.selectedEntryIds.clear();
            projectDialog.close();
            await loadLibrary();
            await loadVaultImportLog();
        } catch (error) {
            projectResult.textContent = error.message;
            projectResult.className = 'result error';
        }
    });

    projectFilesForm?.addEventListener('submit', async event => {
        event.preventDefault();
        const sourcePaths = projectFilePaths.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
        projectFilesResult.className = 'result hidden';
        try {
            const response = await fetch(`/projects/${projectFilesId.value}/files`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ source_paths: sourcePaths }),
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.detail || 'Could not add files');
            projectFilesDialog.close();
            await loadLibrary();
        } catch (error) {
            projectFilesResult.textContent = error.message;
            projectFilesResult.className = 'result error';
        }
    });

    if (analyzeEntryButton) {
        const handleAnalyze = async (event) => {
            if (event) { event.preventDefault(); event.stopPropagation(); }
            contextMenu.classList.add('hidden');
            await analyzeSelectedEntries();
        };
        analyzeEntryButton.addEventListener('click', handleAnalyze);
    }

    if (deleteEntryMenuButton) {
        const handleDeleteMenu = async (event) => {
            if (event) { event.preventDefault(); event.stopPropagation(); }
            contextMenu.classList.add('hidden');
            await deleteSelectedEntries();
        };
        deleteEntryMenuButton.addEventListener('click', handleDeleteMenu);
    }

    if (dispatchSubmitBtn) {
        dispatchSubmitBtn.addEventListener('click', async () => {
            const targetVaultId = Number(dispatchTargetSelect.value);
            if (targetVaultId) {
                await dispatchSelectedEntriesToVault(targetVaultId);
            }
        });
    }

    if (removeVaultEntryButton) {
        const handleRemove = async (event) => {
            if (event) { event.preventDefault(); event.stopPropagation(); }
            contextMenu.classList.add('hidden');
            const entry = state.contextEntry;
            if (!entry || state.selectedVaultId === null) return;
            try {
                const response = await fetch(`/items/${entry.item.id}/vaults/${state.selectedVaultId}`, {
                    method: 'DELETE',
                });
                if (!response.ok) throw new Error('Could not remove item from vault');
                await loadLibrary();
            } catch (error) {
                console.error(error);
            }
        };
        removeVaultEntryButton.addEventListener('click', handleRemove);
    }

    if (scrollLeftBtn) {
        const doScrollLeft = (event) => {
            if (event) { event.preventDefault(); event.stopPropagation(); }
            if (listHeader) listHeader.scrollBy({ left: -160, behavior: 'smooth' });
            if (assetList) assetList.scrollBy({ left: -160, behavior: 'smooth' });
        };
        scrollLeftBtn.addEventListener('click', doScrollLeft);
    }
    if (scrollRightBtn) {
        const doScrollRight = (event) => {
            if (event) { event.preventDefault(); event.stopPropagation(); }
            if (listHeader) listHeader.scrollBy({ left: 160, behavior: 'smooth' });
            if (assetList) assetList.scrollBy({ left: 160, behavior: 'smooth' });
        };
        scrollRightBtn.addEventListener('click', doScrollRight);
    }

    contextMenu.addEventListener('pointerdown', event => event.stopPropagation());
    contextMenu.addEventListener('mousedown', event => event.stopPropagation());

    window.addEventListener('pointerdown', event => {
        if (!contextMenu.contains(event.target)) contextMenu.classList.add('hidden');
    });
    window.addEventListener('keydown', async event => {
        if (event.key === 'Escape') contextMenu.classList.add('hidden');
        if (event.key === 'Delete' || event.key === 'Backspace') {
            const activeEl = document.activeElement;
            if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'SELECT' || activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable)) {
                return;
            }
            if (state.selectedEntryIds.size > 0) {
                event.preventDefault();
                await deleteSelectedEntries();
            }
        }
    });
    if (assetList && listHeader) {
        assetList.addEventListener('scroll', () => {
            listHeader.scrollLeft = assetList.scrollLeft;
            contextMenu.classList.add('hidden');
        });
        listHeader.addEventListener('scroll', () => {
            assetList.scrollLeft = listHeader.scrollLeft;
        });
    }

    async function browseImportSource(endpoint) {
        try {
            const response = await fetch(endpoint);
            const result = await response.json();
            if (result.path) sourcePath.value = result.path;
            else if (result.error) throw new Error(result.error);
        } catch (error) {
            importResult.textContent = error.message;
            importResult.className = 'result error';
        }
    }

    openImportButton?.addEventListener('click', async () => {
        state.importMode = 'auto';
        importResult.className = 'result hidden';
        renderImportMode();
        importDialog?.showModal();
        if (state.selectedVaultId === null && vaultSelect?.value) {
            state.selectedVaultId = Number(vaultSelect.value);
        }
        await loadVaultImportLog();
    });
    importDialogClose?.addEventListener('click', () => importDialog?.close());
    importCancel?.addEventListener('click', () => importDialog?.close());
    importModeAuto?.addEventListener('click', () => {
        state.importMode = 'auto';
        renderImportMode();
    });
    importModeSpecific?.addEventListener('click', () => {
        state.importMode = 'specific';
        renderImportMode();
    });
    sourceFileChoice?.addEventListener('click', () => browseImportSource('/items/browse-file'));
    sourceFolderChoice?.addEventListener('click', () => browseImportSource('/items/browse'));
    importSummaryClose?.addEventListener('click', () => importSummaryDialog?.close());
    importSummaryDone?.addEventListener('click', () => importSummaryDialog?.close());

    importForm.addEventListener('submit', async event => {
        event.preventDefault();
        importSubmit.disabled = true;
        importSubmit.textContent = 'Importing…';
        importResult.className = 'result hidden';
        try {
            const availableTypeIds = importableFolderTypes().map(type => type.id);
            const analysisTypes = state.importMode === 'auto'
                ? availableTypeIds
                : [...state.importAnalysisTypes];
            const response = await fetch('/items/import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    source_path: sourcePath.value,
                    vault_id: Number(vaultSelect.value),
                    expected_type: 'auto',
                    analysis_types: analysisTypes,
                    fallback_to_files: state.importMode === 'auto',
                }),
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.detail || 'Import failed');
            const vault = state.vaults.find(entry => entry.id === Number(vaultSelect.value));
            const warnings = Array.isArray(result.warnings) && result.warnings.length
                ? ` Warning: ${result.warnings.join(' ')}`
                : '';
            importResult.textContent = result.type === 'batch'
                ? `${result.imported} independent ${result.imported === 1 ? 'item' : 'items'} imported into ${vault?.name || 'the vault'}.`
                : `${result.title || filename(result.absolute_path)} imported into ${vault?.name || 'the vault'} as ${typeLabel(result.type)}.${warnings}`;
            importResult.className = 'result';
            importDialog?.close();
            renderImportSummary(result);
            sourcePath.value = '';
            await loadLibrary();
            await loadVaultImportLog();
        } catch (error) {
            importResult.textContent = error.message;
            importResult.className = 'result error';
        } finally {
            importSubmit.disabled = false;
            importSubmit.textContent = 'Import assets';
        }
    });

    vaultSelect.addEventListener('change', async () => {
        state.selectedVaultId = Number(vaultSelect.value);
        reconcileFilterSelection();
        renderVaults();
        renderFilterUI();
        renderAssets();
        await loadVaultImportLog();
    });

    vaultForm.addEventListener('submit', async event => {
        event.preventDefault();
        vaultResult.className = 'result hidden';
        try {
            const response = await fetch('/vaults/', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: vaultName.value }),
            });
            const vault = await response.json();
            if (!response.ok) throw new Error(vault.detail || 'Could not create vault');
            state.vaults.push(vault);
            state.selectedVaultId = vault.id;
            renderVaults();
            vaultName.value = '';
            vaultResult.textContent = `${vault.name} is ready. Its imports and duplicate checks are now isolated.`;
            vaultResult.className = 'result';
            await loadLibrary();
        } catch (error) {
            vaultResult.textContent = error.message;
            vaultResult.className = 'result error';
        }
    });

    [vaultChips, typeChips, tagChips].forEach(chips => {
        if (!chips) return;
        const parent = chips.parentNode;
        const rail = createFilterRail(chips);
        parent.appendChild(rail);
        enableHorizontalDragScroll(chips);
    });
    initializeColumnResizing();
    loadLibrary();
});
