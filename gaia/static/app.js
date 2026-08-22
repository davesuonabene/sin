function initializeGaiaLibrary() {
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
        importVaultId: null,
        importPreview: null,
        importFolderAssignments: new Map(),
        importItemTypes: new Map(),
        importExcludedIndexes: new Set(),
        importCollapsedFolders: new Set(),
        importConflictAction: null,
        importJobId: null,
        importLastJob: null,
        sourcePickerDirectory: null,
        sourcePickerParent: null,
        sourcePickerSelection: null,
        contextEntry: null,
        projectReferencedItems: new Map(),
        projectReferencesLoading: new Set(),
        projectDialogSources: [],
        projectSourceIds: new Set(),
        pendingPlacement: null,
    };

    const assetList = document.getElementById('asset-list');
    const summary = document.getElementById('library-summary');
    const vaultPicker = document.getElementById('vault-picker');
    const activeVaultName = document.getElementById('active-vault-name');
    const vaultMenu = document.getElementById('vault-menu');
    const vaultMenuList = document.getElementById('vault-menu-list');
    const createVaultButton = document.getElementById('create-vault');
    const deleteVaultButton = document.getElementById('delete-vault');
    const vaultOptionsButton = document.getElementById('vault-options');
    const vaultDialog = document.getElementById('vault-dialog');
    const vaultForm = document.getElementById('vault-form');
    const vaultDialogEyebrow = document.getElementById('vault-dialog-eyebrow');
    const vaultDialogTitle = document.getElementById('vault-dialog-title');
    const vaultDialogClose = document.getElementById('vault-dialog-close');
    const vaultDialogCancel = document.getElementById('vault-dialog-cancel');
    const vaultDialogSubmit = document.getElementById('vault-dialog-submit');
    const vaultNameInput = document.getElementById('vault-name-input');
    const vaultDialogResult = document.getElementById('vault-dialog-result');
    const searchInput = document.getElementById('search-input');
    const clearFilter = document.getElementById('clear-filter');
    const refreshButton = document.getElementById('refresh');
    const importForm = document.getElementById('import-form');
    const importDialog = document.getElementById('import-dialog');
    const openImportButton = document.getElementById('open-import');
    const importDialogClose = document.getElementById('import-dialog-close');
    const importHeadingSource = document.getElementById('import-heading-source');
    const importCancel = document.getElementById('import-cancel');
    const sourcePath = document.getElementById('source-path');
    const chooseSourcePath = document.getElementById('choose-source-path');
    const sourcePickerDialog = document.getElementById('source-picker-dialog');
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
    const listHeader = document.getElementById('list-header');
    const contextMenu = document.getElementById('context-menu');
    const analyzeEntryButton = document.getElementById('analyze-entry');
    const deleteEntryMenuButton = document.getElementById('delete-entry-menu');
    const moveBar = document.getElementById('move-bar');
    const moveCount = document.getElementById('move-count');
    const moveTargetSelect = document.getElementById('move-target-select');
    const moveSubmitBtn = document.getElementById('move-submit-btn');
    const analyzeSelectionButton = document.getElementById('analyze-selection');
    const deleteSelectionButton = document.getElementById('delete-selection');
    const selectionTypeActions = document.getElementById('selection-type-actions');
    const contextVaultOptions = document.getElementById('context-vault-options');
    const filterStatus = document.getElementById('filter-status');
    const typeChips = document.getElementById('type-chips');
    const tagChips = document.getElementById('tag-chips');
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
    const importProgressCancel = document.getElementById('import-progress-cancel');
    const importProgressResults = document.getElementById('import-progress-results');
    const importProgressDismiss = document.getElementById('import-progress-dismiss');
    const importVaultCreate = document.getElementById('import-vault-create');
    const importVaultName = document.getElementById('import-vault-name');
    const importVaultCreateSubmit = document.getElementById('import-vault-create-submit');
    const importVaultCreateCancel = document.getElementById('import-vault-create-cancel');
    const importVaultCreateResult = document.getElementById('import-vault-create-result');
    const createProjectButton = document.getElementById('create-project');
    const projectDialog = document.getElementById('project-dialog');
    const projectForm = document.getElementById('project-form');
    const projectDialogTitle = document.getElementById('project-dialog-title');
    const projectDialogSubtitle = document.getElementById('project-dialog-subtitle');
    const projectDialogClose = document.getElementById('project-dialog-close');
    const projectDialogCancel = document.getElementById('project-dialog-cancel');
    const projectMode = document.getElementById('project-mode');
    const projectName = document.getElementById('project-name');
    const projectType = document.getElementById('project-type');
    const projectSourcePreview = document.getElementById('project-source-preview');
    const projectSourceTitle = document.getElementById('project-source-title');
    const projectSourceCount = document.getElementById('project-source-count');
    const projectSourceList = document.getElementById('project-source-list');
    const projectSelectionNote = document.getElementById('project-selection-note');
    const projectSubmit = document.getElementById('project-submit');
    const projectResult = document.getElementById('project-result');
    const projectFilesDialog = document.getElementById('project-files-dialog');
    const projectFilesForm = document.getElementById('project-files-form');
    const projectFilesTitle = document.getElementById('project-files-title');
    const projectFilesClose = document.getElementById('project-files-close');
    const projectFilesId = document.getElementById('project-files-id');
    const projectFilePaths = document.getElementById('project-file-paths');
    const projectFilesResult = document.getElementById('project-files-result');
    const itemPlacementDialog = document.getElementById('item-placement-dialog');
    const itemPlacementTitle = document.getElementById('item-placement-title');
    const itemPlacementSummary = document.getElementById('item-placement-summary');
    const itemPlacementClose = document.getElementById('item-placement-close');
    const itemPlacementCancel = document.getElementById('item-placement-cancel');
    const itemPlacementMove = document.getElementById('item-placement-move');
    const itemPlacementReference = document.getElementById('item-placement-reference');
    const itemPlacementResult = document.getElementById('item-placement-result');
    let vaultDialogMode = 'create';

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

    const ROW_LAYOUTS = Object.freeze({
        main: {
            id: 'main',
            columns: 'minmax(0, 1fr) minmax(82px, .35fr) 80px',
            fields: ['name', 'type', 'size'],
        },
        collection: {
            id: 'collection',
            columns: 'minmax(150px, 1.3fr) minmax(82px, .45fr) minmax(90px, .7fr) 76px',
            fields: ['name', 'type', 'tags', 'size'],
        },
        samplePack: {
            id: 'sample-pack',
            columns: 'minmax(145px, 1.25fr) minmax(140px, 1fr) minmax(78px, .45fr) 58px 62px minmax(100px, .8fr) 78px',
            fields: ['name', 'path', 'type', 'bpm', 'key', 'tags', 'size'],
        },
    });

    const ROW_HEADER_LABELS = Object.freeze({
        name: 'Name',
        path: 'Path',
        type: 'Type',
        bpm: 'BPM',
        key: 'Key',
        tags: 'Tags',
        size: 'Size',
    });

    function isSamplePackCollection(collection) {
        const attributes = collection?.attributes || {};
        const profile = [attributes.profile_id, attributes.profile_label]
            .filter(Boolean)
            .join(' ')
            .toLocaleLowerCase();
        return profile.includes('sample_pack') || profile.includes('sample pack');
    }

    function collectionRowLayout(collection) {
        return isSamplePackCollection(collection) ? ROW_LAYOUTS.samplePack : ROW_LAYOUTS.collection;
    }

    function rowLayoutFor(entry, { nested = false } = {}) {
        return nested ? collectionRowLayout(entry.collection) : ROW_LAYOUTS.main;
    }

    function renderRowHeader(header, layout, className) {
        header.className = `row-header ${className}`;
        header.style.setProperty('--row-columns', layout.columns);
        header.replaceChildren();
        layout.fields.forEach(field => {
            const cell = document.createElement('span');
            cell.textContent = ROW_HEADER_LABELS[field];
            header.appendChild(cell);
        });
        return header;
    }

    function createCollectionHeader(collection) {
        const header = document.createElement('div');
        renderRowHeader(header, collectionRowLayout(collection), 'collection-row-header');
        return header;
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
        const vaultId = Number(item?.vault_id);
        return Number.isFinite(vaultId) ? [vaultId] : [];
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
        if (entry.kind === 'asset' || entry.kind === 'reference') return entry.item;
        return {
            type: entry.type,
            tags: [...assetTags(entry.collection), ...assetTags(entry.content)],
            vault_id: entry.collection?.vault_id,
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
            entries.push(...collectionContentEntries(collection));
        });
        return entries;
    }

    function projectReferenceEntries(project) {
        if (!typeIsContainer(project?.type)) return [];
        return (state.projectReferencedItems.get(Number(project.id)) || []).map(record => ({
            kind: 'reference',
            id: `${project.id}:reference:${record.reference.id}`,
            type: record.item.type,
            title: record.item.title || filename(record.item.absolute_path),
            path: record.item.absolute_path,
            item: record.item,
            reference: record.reference,
            collection: project,
        }));
    }

    async function loadProjectReferencedItems(projectId) {
        const numericId = Number(projectId);
        if (!Number.isFinite(numericId) || state.projectReferencedItems.has(numericId) || state.projectReferencesLoading.has(numericId)) return;
        state.projectReferencesLoading.add(numericId);
        try {
            const [itemsResponse, referencesResponse] = await Promise.all([
                fetch(`/projects/${numericId}/referenced-items`),
                fetch(`/projects/${numericId}/references`),
            ]);
            const items = await itemsResponse.json().catch(() => ([]));
            const references = await referencesResponse.json().catch(() => ([]));
            if (!itemsResponse.ok || !referencesResponse.ok) {
                throw new Error(items.detail || references.detail || 'Could not load folder references');
            }
            const itemsById = new Map((Array.isArray(items) ? items : []).map(item => [Number(item.id), item]));
            state.projectReferencedItems.set(numericId, (Array.isArray(references) ? references : [])
                .map(reference => ({ reference, item: itemsById.get(Number(reference.to_item_id)) }))
                .filter(record => record.item));
        } catch (error) {
            console.warn('Could not load folder references', error);
            state.projectReferencedItems.set(numericId, []);
        } finally {
            state.projectReferencesLoading.delete(numericId);
            const entry = allEntries().find(candidate => candidate.kind === 'asset' && candidate.item?.id === numericId);
            if (entry && state.expandedCollections.has(entry.id)) renderAssets();
        }
    }

    function collectionContentEntries(collection) {
        const references = projectReferenceEntries(collection);
        const referencedItemIds = new Set(references.map(entry => Number(entry.item.id)));
        const contents = (collection.contents || [])
            .filter(content => !referencedItemIds.has(Number(content.child_id)))
            .map(content => ({
            kind: 'content',
            id: `${collection.id}:${content.index}`,
            type: content.type,
            title: content.title || content.filename,
            path: content.relative_path,
            content,
            collection,
        }));
        return contents.concat(references);
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
                entries.push(...(filteringIsActive() && !entryMatches(entry) ? contents.filter(entryMatches) : contents));
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
        if (entry.kind === 'reference') return entry.item.absolute_path || entry.path || '—';
        return entry.item.source_path || entry.item.absolute_path || '—';
    }

    function entryBpm(entry) {
        return entry.kind === 'content' ? entry.content.bpm : (entry.item.bpm ?? entry.item.attributes?.analysis?.bpm);
    }

    function entryKey(entry) {
        return entry.kind === 'content' ? entry.content.key : (entry.item.key ?? entry.item.attributes?.analysis?.key);
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

    function entryReferenceLabel(entry) {
        if (entry.kind !== 'reference') return null;
        return entry.reference?.revision_label
            || entry.reference?.stage_name
            || entry.reference?.attributes?.label
            || entry.reference?.relation_kind
            || 'source';
    }

    function numericItemId(entry) {
        if (entry.kind === 'content') return Number(entry.content?.child_id) || null;
        return Number(entry.item?.id) || null;
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
            gaia_item_id: numericItemId(entry),
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
        return ['audio', 'track', 'sample', 'multitrack'].includes(entry.type);
    }

    function itemEntry(item, id) {
        return {
            kind: 'asset',
            id,
            type: item.type,
            title: item.title || filename(item.absolute_path),
            path: item.absolute_path,
            item,
        };
    }

    async function previewContainer(entry) {
        if (!entry.item?.id) return;
        try {
            const response = await fetch(`/items/${entry.item.id}/preview`);
            const result = await response.json().catch(() => ({}));
            if (!response.ok || !result?.id) return;
            const previewEntry = itemEntry(result, `preview:${entry.id}:${result.id}`);
            if (canPreview(previewEntry)) play(previewEntry);
        } catch (error) {
            console.warn('Could not resolve the item preview', error);
        }
    }

    function stopPlayback() {
        if (!state.audio) return;
        const audio = state.audio;
        state.audio = null;
        state.playingKey = null;
        try {
            audio.pause();
            audio.removeAttribute('src');
            audio.load();
        } catch (_error) {
            // The media element is already detached; clearing GAIA state is enough.
        }
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

        if (state.audio) stopPlayback();
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
        if (entry.kind === 'reference') return false;
        if (field === 'tags') return true;
        if (field === 'title') return entry.kind === 'content' || typeIsContainer(entry.type);
        if (field === 'type') {
            if (entry.kind === 'content') return ['audio', 'sample', 'track'].includes(entry.type);
            return ['audio', 'sample', 'track'].includes(entry.type);
        }
        if (field === 'bpm') return ['audio', 'sample', 'midi', 'multitrack'].includes(entry.type);
        if (field === 'key') return ['audio', 'sample', 'midi', 'multitrack'].includes(entry.type);
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
        if (field === 'title' && entry.kind === 'asset' && typeIsProject(entry.type)) stopPlayback();
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

    async function saveReferenceLabel(entry, rawValue) {
        const response = await fetch(`/projects/${entry.collection.id}/references/${entry.reference.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ revision_label: rawValue.trim() || null }),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.detail || 'Could not update the relationship label');
        const records = state.projectReferencedItems.get(Number(entry.collection.id)) || [];
        const record = records.find(candidate => Number(candidate.reference.id) === Number(entry.reference.id));
        if (record) record.reference = result;
        renderAssets();
    }

    function beginReferenceLabelEdit(button, entry) {
        if (button.querySelector('input')) return;
        const initial = entryReferenceLabel(entry) || '';
        const editor = document.createElement('input');
        editor.className = 'reference-label-editor';
        editor.type = 'text';
        editor.maxLength = 120;
        editor.value = initial;
        button.replaceWith(editor);
        let finished = false;
        const finish = async save => {
            if (finished) return;
            finished = true;
            const value = editor.value.trim();
            if (!save || value === initial) {
                renderAssets();
                return;
            }
            try {
                await saveReferenceLabel(entry, value);
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
        editor.focus();
        editor.select();
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
            const options = ['audio', 'sample', 'track'];
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
        row.className = `asset-row${state.selectedEntryIds.has(entry.id) ? ' selected' : ''}${entry.kind === 'reference' ? ' referenced-row' : ''}`;
        const layout = rowLayoutFor(entry, { nested });
        row.classList.add(nested ? 'nested-row' : 'main-row', `row-layout-${layout.id}`);
        row.style.setProperty('--row-columns', layout.columns);
        row.setAttribute('role', 'listitem');
        row.setAttribute('aria-selected', String(state.selectedEntryIds.has(entry.id)));
        row.draggable = Boolean(numericItemId(entry));
        const isCollection = entry.kind === 'asset' && typeIsContainer(entry.type);
        if (isCollection) row.title = 'Click to preview the master · double-click to show contents';
        if (entry.kind === 'reference') row.title = 'Referenced file · click its relationship tag to edit';

        const referenceLabel = entryReferenceLabel(entry);
        const titleCell = `<div class="asset-title${canEdit(entry, 'title') ? ' editable-cell' : ''}" data-field="title"${canEdit(entry, 'title') ? ' title="Click to edit"' : ''}>
            <span class="asset-title-text">${escapeHtml(entry.title)}</span>
            ${referenceLabel ? `<button class="reference-label" type="button" title="Click to edit relationship label">${escapeHtml(referenceLabel)}</button>` : ''}
        </div>`;
        const displayType = entry.kind === 'asset' ? entry.item.attributes?.profile_label || typeLabel(entry.type) : typeLabel(entry.type);
        const cells = {
            name: titleCell,
            path: `<span class="path-text">${escapeHtml(entryPath(entry))}</span>`,
            type: editableCell(entry, 'type', 'type-badge', displayType),
            bpm: editableCell(entry, 'bpm', 'metadata-text', entryBpm(entry)),
            key: editableCell(entry, 'key', 'metadata-text', entryKey(entry)),
            tags: editableCell(entry, 'tags', 'tags-text', entryTags(entry).join(', ')),
            size: `<span class="size-text">${escapeHtml(formatSize(entrySize(entry)))}</span>`,
        };
        row.innerHTML = layout.fields.map(field => cells[field]).join('');

        row.querySelectorAll('.editable-cell').forEach(cell => {
            cell.addEventListener('click', event => {
                event.stopPropagation();
                beginCellEdit(cell, entry, cell.dataset.field);
            });
        });
        row.querySelector('.reference-label')?.addEventListener('click', event => {
            event.stopPropagation();
            beginReferenceLabelEdit(event.currentTarget, entry);
        });

        row.addEventListener('dragstart', event => {
            if (!event.dataTransfer) return;
            const selectedEntries = state.selectedEntryIds.has(entry.id)
                ? allEntries().filter(candidate => state.selectedEntryIds.has(candidate.id))
                : [entry];
            const itemIds = [...new Set(selectedEntries.map(numericItemId).filter(Boolean))];
            if (!itemIds.length) {
                event.preventDefault();
                return;
            }
            const payload = JSON.stringify(selectedEntries.length === 1
                ? dragPayload(selectedEntries[0])
                : { type: 'library-items', items: selectedEntries.map(dragPayload) });
            event.dataTransfer.effectAllowed = 'copyMove';
            event.dataTransfer.setData('application/x-gaia-library-item', payload);
            event.dataTransfer.setData('application/x-gaia-item-ids', JSON.stringify(itemIds));
            event.dataTransfer.setData('text/plain', payload);
            row.classList.add('dragging');
        });
        row.addEventListener('dragend', () => row.classList.remove('dragging'));
        if (isCollection) {
            row.addEventListener('dragover', event => {
                if (!Array.from(event.dataTransfer?.types || []).includes('application/x-gaia-item-ids')) return;
                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect = 'move';
                row.classList.add('drop-target');
            });
            row.addEventListener('dragleave', event => {
                if (!row.contains(event.relatedTarget)) row.classList.remove('drop-target');
            });
            row.addEventListener('drop', event => {
                row.classList.remove('drop-target');
                const rawIds = event.dataTransfer?.getData('application/x-gaia-item-ids');
                if (!rawIds) return;
                event.preventDefault();
                event.stopPropagation();
                try {
                    const itemIds = JSON.parse(rawIds).map(Number).filter(id => Number.isFinite(id) && id !== Number(entry.item.id));
                    if (itemIds.length) openItemPlacementDialog(entry, [...new Set(itemIds)]);
                } catch (_error) {
                    window.alert('GAIA could not read the dragged items.');
                }
            });
        }
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
            if (isCollection) previewContainer(entry);
            else if (canPreview(entry)) play(entry);
            renderAssets();
        });
        row.addEventListener('dblclick', event => {
            if (!isCollection || event.target.closest('button, .editable-cell')) return;
            if (state.expandedCollections.has(entry.id)) state.expandedCollections.delete(entry.id);
            else {
                state.expandedCollections.add(entry.id);
                loadProjectReferencedItems(entry.item.id);
            }
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
        const vaultName = state.selectedVaultId !== null ? (selectedVault()?.name || 'vault') : 'Show all';
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
        renderMoveBar();

        if (!entries.length) {
            assetList.innerHTML += '<div class="empty">No assets match this view.</div>';
        } else {
            entries.forEach(entry => {
                const wrapper = createEntry(entry);

                if (entry.kind === 'asset' && typeIsContainer(entry.type) && state.expandedCollections.has(entry.id)) {
                    const contentContainer = document.createElement('div');
                    const collectionLayout = collectionRowLayout(entry.item);
                    contentContainer.className = `collection-contents collection-layout-${collectionLayout.id}`;
                    const contents = collectionContentEntries(entry.item);
                    const displayedContents = filteringIsActive() && !entryMatches(entry) ? contents.filter(entryMatches) : contents;
                    if (displayedContents.length) contentContainer.appendChild(createCollectionHeader(entry.item));
                    displayedContents.forEach(content => contentContainer.appendChild(createEntry(content, { nested: true })));
                    if (!displayedContents.length) {
                        const loadingReferences = state.projectReferencesLoading.has(Number(entry.item.id));
                        contentContainer.innerHTML = `<div class="empty">${loadingReferences ? 'Loading referenced files…' : filteringIsActive() ? 'No files in this collection match the active filter.' : 'This snapshot has no readable files.'}</div>`;
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

    function reconcileFilterSelection() {
        const items = filterableEntries();
        if (state.selectedVaultId !== null && !state.vaults.some(vault => vault.id === state.selectedVaultId)) {
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

    function getSelectedProjectSourceEntries() {
        const seen = new Set();
        return allEntries()
            .filter(entry => state.selectedEntryIds.has(entry.id))
            .filter(entry => entry.kind === 'asset' && entry.item && entry.item.id)
            .filter(entry => {
                const id = Number(entry.item.id);
                if (!Number.isFinite(id) || seen.has(id)) return false;
                seen.add(id);
                return true;
            });
    }

    function getSelectedProjectSourceIds() {
        return getSelectedProjectSourceEntries().map(entry => Number(entry.item.id));
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

    function renderProjectSourcePreview() {
        const candidates = state.projectDialogSources;
        const selectedSources = candidates.filter(source => state.projectSourceIds.has(Number(source.item.id)));
        const hasCandidates = candidates.length > 0;
        const usingSources = selectedSources.length > 0;

        projectMode.value = usingSources ? 'single' : 'empty';
        projectDialogSubtitle.textContent = usingSources
            ? 'Selected material stays in the library and is linked read-only.'
            : 'Create a workspace in the active vault.';
        projectSourcePreview.classList.toggle('hidden', !hasCandidates);
        projectSubmit.textContent = 'Create Project';
        if (!hasCandidates) {
            projectSourceList.replaceChildren();
            return;
        }

        projectSourceTitle.textContent = 'Selected source files';
        projectSourceCount.textContent = `${selectedSources.length} of ${candidates.length} selected`;
        projectSelectionNote.textContent = usingSources
            ? 'Choose which selected files to link. They remain in the library and are not moved.'
            : 'No sources selected. This will create an empty project.';
        projectSourceList.innerHTML = candidates.map(source => {
            const sourceId = Number(source.item.id);
            return `
                <label class="project-source-item">
                    <input type="checkbox" data-project-source-id="${sourceId}" ${state.projectSourceIds.has(sourceId) ? 'checked' : ''}>
                    <span class="project-source-icon" aria-hidden="true">${typeIsContainer(source.type) ? '▣' : '♪'}</span>
                    <span class="project-source-copy">
                        <strong>${escapeHtml(source.title)}</strong>
                        <small>${escapeHtml(typeLabel(source.type))}</small>
                    </span>
                </label>
            `;
        }).join('');
        projectSourceList.querySelectorAll('[data-project-source-id]').forEach(input => {
            input.addEventListener('change', event => {
                const sourceId = Number(event.currentTarget.dataset.projectSourceId);
                if (event.currentTarget.checked) state.projectSourceIds.add(sourceId);
                else state.projectSourceIds.delete(sourceId);
                renderProjectSourcePreview();
            });
        });
    }

    function openProjectDialog() {
        if (!projectDialog) return;
        const selectedSources = getSelectedProjectSourceEntries();
        // New Project becomes selection-aware: selected library items are
        // linked as read-only sources and a single selection suggests a name.
        state.projectDialogSources = selectedSources;
        state.projectSourceIds = new Set(selectedSources.map(source => Number(source.item.id)));
        populateProjectTypes();
        projectResult.className = 'result hidden';
        projectName.value = selectedSources.length === 1 ? selectedSources[0].title : '';
        projectName.required = true;
        projectName.disabled = false;
        projectDialogTitle.textContent = 'Create a Project';
        renderProjectSourcePreview();
        projectDialog.showModal();
        projectName.focus();
        if (selectedSources.length === 1) projectName.select();
    }

    function openProjectFilesDialog(project) {
        if (!projectFilesDialog) return;
        projectFilesId.value = String(project.id);
        projectFilesTitle.textContent = `Add source files to ${project.title || filename(project.absolute_path)}`;
        projectFilePaths.value = '';
        projectFilesResult.className = 'result hidden';
        projectFilesDialog.showModal();
        projectFilePaths.focus();
    }

    function openItemPlacementDialog(targetEntry, itemIds) {
        const entryByItemId = new Map();
        allEntries().forEach(candidate => {
            const itemId = numericItemId(candidate);
            if (itemId && !entryByItemId.has(itemId)) entryByItemId.set(itemId, candidate);
        });
        const titles = itemIds.map(itemId => entryByItemId.get(itemId)?.title || `Item ${itemId}`);
        state.pendingPlacement = {
            targetId: Number(targetEntry.item.id),
            targetTitle: targetEntry.title,
            itemIds,
            titles,
        };
        itemPlacementTitle.textContent = `Add to ${targetEntry.title}`;
        itemPlacementSummary.textContent = titles.length === 1
            ? `“${titles[0]}” will be added as a source.`
            : `${titles.length} items will be added as sources.`;
        itemPlacementResult.className = 'result error hidden';
        itemPlacementMove.disabled = false;
        itemPlacementReference.disabled = false;
        itemPlacementClose.disabled = false;
        itemPlacementCancel.disabled = false;
        itemPlacementDialog.showModal();
    }

    async function performItemPlacement(mode) {
        const placement = state.pendingPlacement;
        if (!placement) return;
        if (mode === 'move') stopPlayback();
        itemPlacementMove.disabled = true;
        itemPlacementReference.disabled = true;
        itemPlacementClose.disabled = true;
        itemPlacementCancel.disabled = true;
        itemPlacementResult.className = 'result error hidden';
        try {
            const response = await fetch(`/items/${placement.targetId}/place-items`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ item_ids: placement.itemIds, mode }),
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.detail || 'Could not add the selected items');
            const targetId = placement.targetId;
            state.pendingPlacement = null;
            state.selectedEntryIds.clear();
            state.selectionAnchorId = null;
            state.expandedCollections.add(String(targetId));
            state.projectReferencedItems.delete(targetId);
            itemPlacementDialog.close();
            await loadLibrary();
        } catch (error) {
            itemPlacementResult.textContent = error.message;
            itemPlacementResult.className = 'result error';
        } finally {
            itemPlacementMove.disabled = false;
            itemPlacementReference.disabled = false;
            itemPlacementClose.disabled = false;
            itemPlacementCancel.disabled = false;
        }
    }

    async function moveSelectedEntriesToVault(targetVaultId) {
        const itemIds = getSelectedNumericItemIds();
        if (!itemIds.length) return;
        stopPlayback();
        try {
            const response = await fetch('/items/move-to-vault', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ item_ids: itemIds, vault_id: targetVaultId }),
            });
            if (!response.ok) {
                const err = await response.json().catch(() => ({}));
                throw new Error(err.detail || 'Move failed');
            }
            state.selectedEntryIds.clear();
            await loadLibrary();
        } catch (error) {
            window.alert(error.message);
        }
    }

    function selectedCommandEntries() {
        return allEntries().filter(entry => state.selectedEntryIds.has(entry.id));
    }

    function renderSelectionTypeActions(selectedEntries) {
        if (!selectionTypeActions) return;
        selectionTypeActions.replaceChildren();

        if (selectedEntries.length === 1 && selectedEntries[0].kind === 'asset' && typeIsProject(selectedEntries[0].type)) {
            const projectEntry = selectedEntries[0];
            const addSourcesButton = document.createElement('button');
            addSourcesButton.type = 'button';
            addSourcesButton.className = 'secondary toolbar-type-action toolbar-icon-button';
            addSourcesButton.textContent = '＋';
            addSourcesButton.title = 'Add source files to project';
            addSourcesButton.setAttribute('aria-label', 'Add source files to project');
            addSourcesButton.addEventListener('click', event => {
                event.stopPropagation();
                openProjectFilesDialog(projectEntry.item);
            });
            selectionTypeActions.appendChild(addSourcesButton);

            const adoptOrphansButton = document.createElement('button');
            adoptOrphansButton.type = 'button';
            adoptOrphansButton.className = 'secondary toolbar-type-action';
            adoptOrphansButton.textContent = 'Adopt orphans';
            adoptOrphansButton.title = 'Move loose files already referenced by this project into its sources folder';
            adoptOrphansButton.setAttribute('aria-label', 'Adopt orphan assets into project');
            adoptOrphansButton.addEventListener('click', async event => {
                event.stopPropagation();
                const confirmed = window.confirm(`Move loose files already referenced by “${projectEntry.title}” into that project?`);
                if (!confirmed) return;
                stopPlayback();
                adoptOrphansButton.disabled = true;
                try {
                    const response = await fetch(`/projects/${projectEntry.item.id}/adopt-orphans`, { method: 'POST' });
                    const result = await response.json().catch(() => ({}));
                    if (!response.ok) throw new Error(result.detail || 'Could not adopt orphan assets');
                    await loadLibrary();
                    window.alert(result.adopted
                        ? `Adopted ${result.adopted} orphan asset${result.adopted === 1 ? '' : 's'}.`
                        : 'This vault has no orphan assets to adopt.');
                } catch (error) {
                    window.alert(error.message);
                } finally {
                    adoptOrphansButton.disabled = false;
                }
            });
            selectionTypeActions.appendChild(adoptOrphansButton);
        }

        const sampleEntries = selectedEntries.filter(entry => entry.type === 'sample' && entry.kind !== 'reference');
        if (sampleEntries.length === selectedEntries.length && sampleEntries.length > 0) {
            const allLoops = sampleEntries.every(entry => Boolean(entry.kind === 'content' ? entry.content.is_loop : entry.item.is_loop));
            const loopButton = document.createElement('button');
            loopButton.type = 'button';
            loopButton.className = 'secondary toolbar-type-action toolbar-icon-button';
            loopButton.textContent = '◌';
            loopButton.title = allLoops ? 'Set selected samples as one-shot' : 'Set selected samples as loops';
            loopButton.setAttribute('aria-label', loopButton.title);
            loopButton.addEventListener('click', async event => {
                event.stopPropagation();
                loopButton.disabled = true;
                try {
                    for (const entry of sampleEntries) await saveMetadata(entry, 'is_loop', !allLoops);
                } catch (error) {
                    window.alert(error.message);
                } finally {
                    loopButton.disabled = false;
                }
            });
            selectionTypeActions.appendChild(loopButton);
        }
    }

    function renderMoveBar() {
        if (!moveBar) return;
        const selectedEntries = selectedCommandEntries();
        const selectedCount = selectedEntries.length;
        if (selectedCount === 0) {
            moveBar.classList.add('hidden');
            renderSelectionTypeActions([]);
            return;
        }
        moveBar.classList.remove('hidden');
        moveCount.textContent = `${selectedCount} selected`;
        analyzeSelectionButton?.classList.remove('hidden');
        deleteSelectionButton?.classList.toggle('hidden', !selectedEntries.some(entry => entry.kind === 'asset'));
        moveTargetSelect.innerHTML = '';
        state.vaults.forEach(vault => {
            const option = document.createElement('option');
            option.value = String(vault.id);
            option.textContent = vault.name;
            moveTargetSelect.appendChild(option);
        });
        renderSelectionTypeActions(selectedEntries);
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

        stopPlayback();

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
        renderMoveBar();
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

        stopPlayback();
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

        contextVaultOptions.innerHTML = '<div class="context-header">Move to Vault</div>';
        state.vaults.forEach(vault => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = `▶ ${vault.name}`;
            const handleMove = async event => {
                if (event) { event.preventDefault(); event.stopPropagation(); }
                contextMenu.classList.add('hidden');
                await moveSelectedEntriesToVault(vault.id);
            };
            btn.addEventListener('click', handleMove);
            contextVaultOptions.appendChild(btn);
        });

    }

    function selectedVault() {
        return state.vaults.find(vault => vault.id === state.selectedVaultId);
    }

    function closeVaultMenu() {
        vaultMenu?.classList.add('hidden');
        vaultPicker?.setAttribute('aria-expanded', 'false');
    }

    function renderVaultMenu() {
        if (!vaultMenuList) return;
        const activeVault = selectedVault();
        const showAll = state.selectedVaultId === null;
        if (activeVaultName) activeVaultName.textContent = activeVault?.name || 'Show all';
        if (deleteVaultButton) {
            deleteVaultButton.disabled = !activeVault || state.vaults.length <= 1;
            deleteVaultButton.title = state.vaults.length <= 1 ? 'The last vault cannot be deleted' : 'Delete active vault';
        }
        if (vaultOptionsButton) vaultOptionsButton.disabled = !activeVault;

        vaultMenuList.replaceChildren();
        const addOption = (value, label, selected) => {
            const option = document.createElement('button');
            option.type = 'button';
            option.className = `vault-menu-option${selected ? ' active' : ''}`;
            option.setAttribute('role', 'option');
            option.setAttribute('aria-selected', String(selected));
            const check = document.createElement('span');
            check.className = 'vault-menu-option-check';
            check.textContent = selected ? '✓' : '';
            const text = document.createElement('span');
            text.textContent = label;
            option.append(check, text);
            option.addEventListener('click', event => {
                event.stopPropagation();
                state.selectedVaultId = value;
                closeVaultMenu();
                reconcileFilterSelection();
                renderVaults();
                renderFilterUI();
                renderAssets();
                loadVaultImportLog();
            });
            vaultMenuList.appendChild(option);
        };

        addOption(null, 'Show all', showAll);
        if (state.vaults.length) {
            const divider = document.createElement('div');
            divider.className = 'vault-menu-divider';
            divider.setAttribute('aria-hidden', 'true');
            vaultMenuList.appendChild(divider);
        }
        state.vaults.forEach(vault => addOption(vault.id, vault.name, vault.id === state.selectedVaultId));
    }

    function openVaultDialog(mode) {
        const activeVault = selectedVault();
        if (mode === 'rename' && !activeVault) return;
        vaultDialogMode = mode;
        if (vaultDialogEyebrow) vaultDialogEyebrow.textContent = mode === 'rename' ? 'Vault options' : 'New vault';
        if (vaultDialogTitle) vaultDialogTitle.textContent = mode === 'rename' ? 'Vault options' : 'Create a vault';
        if (vaultDialogSubmit) vaultDialogSubmit.textContent = mode === 'rename' ? 'Save changes' : 'Create vault';
        if (vaultNameInput) {
            vaultNameInput.value = mode === 'rename' ? activeVault.name : '';
            vaultNameInput.select();
        }
        vaultDialogResult?.classList.add('hidden');
        vaultDialogResult.textContent = '';
        vaultDialog?.showModal();
        vaultNameInput?.focus();
    }

    function showVaultDialogError(message) {
        if (!vaultDialogResult) return;
        vaultDialogResult.textContent = message;
        vaultDialogResult.className = 'result error';
        vaultDialogResult.classList.remove('hidden');
    }

    async function createVaultRecord(name) {
        const response = await fetch('/vaults/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, description: null }),
        });
        const vault = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(vault.detail || 'Could not create vault');
        return vault;
    }

    async function submitVaultDialog(event) {
        event.preventDefault();
        const name = vaultNameInput?.value.trim() || '';
        if (!name) {
            showVaultDialogError('Enter a vault name.');
            vaultNameInput?.focus();
            return;
        }
        const activeVault = selectedVault();
        if (vaultDialogMode === 'rename' && !activeVault) return;
        if (vaultDialogSubmit) {
            vaultDialogSubmit.disabled = true;
            vaultDialogSubmit.textContent = vaultDialogMode === 'rename' ? 'Saving…' : 'Creating…';
        }
        try {
            if (vaultDialogMode === 'rename') {
                const response = await fetch(`/vaults/${activeVault.id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, description: activeVault.description || null }),
                });
                const updated = await response.json().catch(() => ({}));
                if (!response.ok) throw new Error(updated.detail || 'Could not rename vault');
                state.vaults = state.vaults.map(vault => vault.id === updated.id ? updated : vault);
            } else {
                const vault = await createVaultRecord(name);
                state.vaults.push(vault);
                state.selectedVaultId = vault.id;
                state.importVaultId = vault.id;
            }
            vaultDialog?.close();
            reconcileFilterSelection();
            renderVaults();
            renderFilterUI();
            renderAssets();
        } catch (error) {
            showVaultDialogError(error.message || 'Could not save vault');
        } finally {
            if (vaultDialogSubmit) {
                vaultDialogSubmit.disabled = false;
                vaultDialogSubmit.textContent = vaultDialogMode === 'rename' ? 'Save changes' : 'Create vault';
            }
        }
    }

    async function deleteActiveVault() {
        const activeVault = selectedVault();
        if (!activeVault || state.vaults.length <= 1) return;
        if (!window.confirm(`Delete the vault “${activeVault.name}”? Only empty vaults can be deleted.`)) return;
        deleteVaultButton.disabled = true;
        try {
            const response = await fetch(`/vaults/${activeVault.id}`, { method: 'DELETE' });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.detail || 'Could not delete vault');
            state.vaults = state.vaults.filter(vault => vault.id !== activeVault.id);
            state.selectedVaultId = null;
            if (state.importVaultId === activeVault.id) state.importVaultId = state.vaults[0]?.id ?? null;
            reconcileFilterSelection();
            renderVaults();
            renderFilterUI();
            renderAssets();
        } catch (error) {
            window.alert(error.message || 'Could not delete vault');
            renderVaultMenu();
        }
    }

    function showImportVaultCreate(show) {
        importVaultCreate.classList.toggle('hidden', !show);
        if (!show) {
            importVaultCreateResult.classList.add('hidden');
            importVaultCreateResult.textContent = '';
        }
    }

    function renderVaults() {
        renderVaultMenu();
        vaultSelect.innerHTML = '';
        if (!state.vaults.length) {
            const option = document.createElement('option');
            option.value = '__create__';
            option.textContent = '＋ Create new vault…';
            option.selected = true;
            vaultSelect.appendChild(option);
            state.importVaultId = null;
            showImportVaultCreate(true);
            return;
        }
        if (state.importVaultId === null || !state.vaults.some(vault => vault.id === state.importVaultId)) {
            state.importVaultId = state.selectedVaultId ?? state.vaults[0].id;
        }
        state.vaults.forEach(vault => {
            const option = document.createElement('option');
            option.value = String(vault.id);
            option.textContent = vault.name;
            option.selected = vault.id === state.importVaultId;
            vaultSelect.appendChild(option);
        });
        const createOption = document.createElement('option');
        createOption.value = '__create__';
        createOption.textContent = '＋ Create new vault…';
        vaultSelect.appendChild(createOption);
        vaultSelect.value = String(state.importVaultId);
        showImportVaultCreate(false);
    }

    async function createImportVault() {
        const name = importVaultName.value.trim();
        if (!name) {
            importVaultCreateResult.textContent = 'Enter a vault name.';
            importVaultCreateResult.classList.remove('hidden');
            importVaultName.focus();
            return;
        }
        importVaultCreateSubmit.disabled = true;
        importVaultCreateResult.classList.add('hidden');
        try {
            const vault = await createVaultRecord(name);
            state.vaults.push(vault);
            state.importVaultId = vault.id;
            importVaultName.value = '';
            renderVaults();
            renderFilterUI();
        } catch (error) {
            importVaultCreateResult.textContent = error.message;
            importVaultCreateResult.classList.remove('hidden');
        } finally {
            importVaultCreateSubmit.disabled = false;
        }
    }

    async function loadVaults() {
        const response = await fetch('/vaults/');
        if (!response.ok) throw new Error('GAIA could not load vaults');
        state.vaults = await response.json();
        renderVaults();
    }

    async function loadVaultImportLog() {
        // Import history is now written per job under gaia/log/imports.
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
            state.projectReferencedItems.clear();
            state.projectReferencesLoading.clear();
            const availableEntryIds = new Set(allEntries().map(entry => entry.id));
            state.selectedEntryIds = new Set([...state.selectedEntryIds].filter(id => availableEntryIds.has(id)));
            if (!availableEntryIds.has(state.selectionAnchorId)) state.selectionAnchorId = null;
            reconcileFilterSelection();
            renderFilterUI();
            renderAssets();
            state.items
                .filter(item => typeIsContainer(item.type) && state.expandedCollections.has(String(item.id)))
                .forEach(item => loadProjectReferencedItems(item.id));
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

    renderRowHeader(listHeader, ROW_LAYOUTS.main, 'main-row-header');

    searchInput.addEventListener('input', () => {
        state.query = searchInput.value.trim().toLowerCase();
        renderAssets();
    });
    clearFilter.addEventListener('click', () => {
        clearAllFilters();
    });
    refreshButton.addEventListener('click', loadLibrary);

    createProjectButton?.addEventListener('click', () => openProjectDialog());
    projectDialogClose?.addEventListener('click', () => projectDialog.close());
    projectDialogCancel?.addEventListener('click', () => projectDialog.close());
    projectFilesClose?.addEventListener('click', () => projectFilesDialog.close());
    itemPlacementClose?.addEventListener('click', () => itemPlacementDialog.close());
    itemPlacementCancel?.addEventListener('click', () => itemPlacementDialog.close());
    itemPlacementMove?.addEventListener('click', () => performItemPlacement('move'));
    itemPlacementReference?.addEventListener('click', () => performItemPlacement('reference'));
    itemPlacementDialog?.addEventListener('close', () => {
        if (!itemPlacementMove.disabled && !itemPlacementReference.disabled) state.pendingPlacement = null;
    });

    projectForm?.addEventListener('submit', async event => {
        event.preventDefault();
        const sourceIds = [...state.projectSourceIds];
        const payload = {
            project_type: projectType.value,
            vault_id: selectedProjectVaultId(),
        };
        const url = sourceIds.length ? '/projects/from-items' : '/projects/';
        payload.name = projectName.value;
        if (sourceIds.length) {
            payload.item_ids = sourceIds;
            payload.mode = 'single';
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
            state.selectionAnchorId = null;
            state.projectDialogSources = [];
            state.projectSourceIds.clear();
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
            if (!response.ok) throw new Error(result.detail || 'Could not add sources');
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

    if (moveSubmitBtn) {
        moveSubmitBtn.addEventListener('click', async () => {
            const targetVaultId = Number(moveTargetSelect.value);
            if (targetVaultId) {
                await moveSelectedEntriesToVault(targetVaultId);
            }
        });
    }

    analyzeSelectionButton?.addEventListener('click', async event => {
        event.preventDefault();
        await analyzeSelectedEntries();
    });

    deleteSelectionButton?.addEventListener('click', async event => {
        event.preventDefault();
        await deleteSelectedEntries();
    });

    contextMenu.addEventListener('pointerdown', event => event.stopPropagation());
    contextMenu.addEventListener('mousedown', event => event.stopPropagation());

    window.addEventListener('pointerdown', event => {
        if (!contextMenu.contains(event.target)) contextMenu.classList.add('hidden');
    });
    window.addEventListener('keydown', async event => {
        if (event.key === 'Escape') {
            contextMenu.classList.add('hidden');
            if (state.selectedEntryIds.size || state.selectionAnchorId) {
                state.selectedEntryIds.clear();
                state.selectionAnchorId = null;
                state.contextEntry = null;
                renderAssets();
            }
            return;
        }
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
    assetList?.addEventListener('scroll', () => contextMenu.classList.add('hidden'));

    let importPollTimer = null;

    function stopImportPolling() {
        if (importPollTimer) clearTimeout(importPollTimer);
        importPollTimer = null;
    }

    function setImportBusy(busy) {
        importDialogClose.disabled = busy;
        importCancel.disabled = busy;
        importSubmit.disabled = busy;
        sourcePath.disabled = busy;
        chooseSourcePath.disabled = busy;
        vaultSelect.disabled = busy;
        importVaultName.disabled = busy;
        importVaultCreateSubmit.disabled = busy;
        importVaultCreateCancel.disabled = busy;
    }

    function resetImportFlow() {
        state.importPreview = null;
        state.importFolderAssignments = new Map();
        state.importItemTypes = new Map();
        state.importExcludedIndexes = new Set();
        state.importCollapsedFolders = new Set();
        state.importConflictAction = null;
        importResult.className = 'result hidden';
        importSourceStep.classList.remove('hidden');
        importPreviewStep.classList.add('hidden');
        importPreviewStep.replaceChildren();
        importHeadingSource.classList.add('hidden');
        importHeadingSource.replaceChildren();
        importSubmit.textContent = 'Inspect source';
        renderVaults();
        setImportBusy(false);
    }

    function importTypeLabel(type, displayType = null) {
        return displayType || typeLabel(type);
    }

    function folderAssignmentOptions(preview, selected) {
        const typeOptions = (preview.folder_type_options || []).map(option =>
            `<option value="${escapeHtml(option.value)}" ${selected === option.value ? 'selected' : ''}>${escapeHtml(option.label)}</option>`
        ).join('');
        const profileOptions = (preview.profiles || [])
            .filter(profile => ['collection', 'multitrack'].includes(profile.container_type))
            .map(profile => {
                const value = `profile:${profile.id}`;
                return `<option value="${escapeHtml(value)}" ${selected === value ? 'selected' : ''}>${escapeHtml(profile.label)}</option>`;
            }).join('');
        return `<option value="" ${selected ? '' : 'selected'}>Unclassified folder</option>${typeOptions ? `<optgroup label="Folder types">${typeOptions}</optgroup>` : ''}${profileOptions ? `<optgroup label="Profiles">${profileOptions}</optgroup>` : ''}`;
    }

    function fileTypeOptions(entry, selected) {
        const familyLabel = entry.family === 'midi' ? 'MIDI' : entry.family === 'sequence' ? 'Sequence' : entry.family === 'audio' ? 'Audio' : 'File';
        const options = (entry.allowed_types || [entry.type]).map(type =>
            `<option value="${escapeHtml(type)}" ${selected === type ? 'selected' : ''}>${escapeHtml(typeLabel(type))}</option>`
        ).join('');
        return `<optgroup label="${escapeHtml(familyLabel)}">${options}</optgroup>`;
    }

    function importNodeSort(left, right) {
        if (left.relative_path === '.') return -1;
        if (right.relative_path === '.') return 1;
        return left.relative_path.localeCompare(right.relative_path, undefined, { numeric: true, sensitivity: 'base' })
            || (left.kind === 'folder' ? -1 : 1);
    }

    function assignedAncestor(node) {
        if (node.kind !== 'folder' || node.relative_path === '.') return null;
        const parts = node.relative_path.split('/');
        for (let length = parts.length - 1; length >= 0; length -= 1) {
            const candidate = length === 0 ? '.' : parts.slice(0, length).join('/');
            if (state.importFolderAssignments.get(candidate)) return candidate;
        }
        return null;
    }

    function importPathIsWithin(relativePath, folderPath) {
        return folderPath === '.' ? relativePath !== '.' : relativePath.startsWith(`${folderPath}/`);
    }

    function hiddenByCollapsedFolder(node) {
        return [...state.importCollapsedFolders].some(folderPath => importPathIsWithin(node.relative_path, folderPath));
    }

    function renderImportPreview() {
        const preview = state.importPreview;
        if (!preview) return;
        const includedCount = preview.file_count - state.importExcludedIndexes.size;
        const remainingArtifacts = (preview.entries || []).filter(entry => entry.artifact && !state.importExcludedIndexes.has(entry.index));
        importHeadingSource.innerHTML = `<div class="import-heading-source-copy"><h3>${escapeHtml(preview.title)}</h3><p>${escapeHtml(preview.source_path)}</p></div><div class="import-preview-stats"><span>${escapeHtml(preview.source_kind)}</span><span>${preview.folder_count || 0} folders</span><span>${includedCount}/${preview.file_count} files</span><span>${escapeHtml(formatSize(preview.size_bytes))}</span><span>${preview.inspection_ms || 0} ms</span></div>`;
        importHeadingSource.classList.remove('hidden');
        const rows = [...(preview.nodes || [])].sort(importNodeSort).filter(node => !hiddenByCollapsedFolder(node)).map(node => {
            if (node.kind === 'folder') {
                const selected = state.importFolderAssignments.get(node.relative_path) || '';
                const inheritedFrom = assignedAncestor(node);
                const collapsed = state.importCollapsedFolders.has(node.relative_path);
                const detection = node.detection_label
                    ? `<span class="import-detection ${node.detected_assignment ? 'detected' : 'suggested'}">${escapeHtml(node.detected_assignment ? 'Detected' : 'Suggested')}: ${escapeHtml(node.detection_label)}</span>`
                    : '';
                const reason = node.detection_reason ? `<small title="${escapeHtml(node.detection_reason)}">${escapeHtml(node.detection_reason)}</small>` : '';
                const warning = node.warning_count
                    ? `<span class="import-folder-warning" title="${escapeHtml(`${node.warning_count} flagged file${node.warning_count === 1 ? '' : 's'}: ${(node.warning_messages || []).join(', ')}`)}">⚠<span>${node.warning_count}</span></span>`
                    : '';
                return `<div class="import-tree-row folder" style="--import-depth:${Number(node.depth) || 0}">
                    <div class="import-tree-name"><button class="import-folder-toggle" type="button" data-import-collapse="${escapeHtml(node.relative_path)}" aria-label="${collapsed ? 'Expand' : 'Collapse'} ${escapeHtml(node.relative_path === '.' ? preview.title : node.name)}" aria-expanded="${!collapsed}">${collapsed ? '▸' : '▾'}</button><span class="import-tree-label"><strong>${escapeHtml(node.relative_path === '.' ? preview.title : node.name)}</strong>${reason}</span>${warning}</div>
                    <div class="import-tree-detection">${detection}</div>
                    <select data-import-folder="${escapeHtml(node.relative_path)}" ${inheritedFrom ? `disabled title="Contained by classified folder ${escapeHtml(inheritedFrom)}"` : ''}>${folderAssignmentOptions(preview, selected)}</select>
                    <span class="import-tree-size">${node.relative_path === '.' ? escapeHtml(formatSize(preview.size_bytes)) : '—'}</span>
                </div>`;
            }
            const selected = state.importItemTypes.get(node.index) || node.type;
            const locked = (node.allowed_types || []).length <= 1;
            const excluded = state.importExcludedIndexes.has(node.index);
            const inspection = [
                node.artifact ? `<span class="import-artifact-flag" title="${escapeHtml(node.artifact_reason)}">⚑ Artifact</span>` : '',
                node.profile_role ? `<span class="import-role-badge ${escapeHtml(node.profile_role)}" title="${escapeHtml(node.profile_role_reason)}">${escapeHtml(node.profile_role === 'mixdown' ? 'Mixdown' : 'Source channel')}</span>` : '',
                !node.artifact && !node.profile_role ? `<span class="import-family">${escapeHtml(node.family)}</span>` : '',
            ].filter(Boolean).join('');
            return `<div class="import-tree-row file${excluded ? ' excluded' : ''}" style="--import-depth:${Number(node.depth) || 0}">
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
        const canStart = includedCount > 0 && (!conflicts.length || state.importConflictAction);
        importPreviewStep.innerHTML = `
            ${preview.warnings?.length ? `<div class="import-warning-box"><strong>Inspection warnings</strong>${preview.warnings.map(warning => `<div>${escapeHtml(warning)}</div>`).join('')}</div>` : ''}
            ${conflictPanel}
            <section class="import-preview-section"><div class="import-section-heading"><h3>Inspected folders and files</h3><button id="import-exclude-artifacts" class="secondary compact" type="button" ${remainingArtifacts.length ? '' : 'disabled'}>Exclude flagged artifacts${remainingArtifacts.length ? ` (${remainingArtifacts.length})` : ''}</button></div><div class="import-tree-head"><span>Name</span><span>Inspection</span><span>Type or profile</span><span>Size</span></div><div class="import-tree">${rows || '<div class="empty">No files were found.</div>'}</div></section>
            <div class="dialog-actions"><button id="import-preview-back" class="secondary" type="button">Choose another source</button><button id="import-job-start" class="primary" type="button" ${canStart ? '' : 'disabled'}>Start background import</button></div>`;
        importPreviewStep.querySelectorAll('[data-import-collapse]').forEach(button => button.addEventListener('click', () => {
            const path = button.dataset.importCollapse;
            if (state.importCollapsedFolders.has(path)) state.importCollapsedFolders.delete(path);
            else state.importCollapsedFolders.add(path);
            renderImportPreview();
        }));
        importPreviewStep.querySelectorAll('[data-import-folder]').forEach(select => select.addEventListener('change', () => {
            if (select.value) state.importFolderAssignments.set(select.dataset.importFolder, select.value);
            else state.importFolderAssignments.delete(select.dataset.importFolder);
            renderImportPreview();
        }));
        importPreviewStep.querySelectorAll('[data-import-item]').forEach(select => select.addEventListener('change', () => {
            state.importItemTypes.set(Number(select.dataset.importItem), select.value);
        }));
        importPreviewStep.querySelectorAll('[data-import-include]').forEach(input => input.addEventListener('change', () => {
            const index = Number(input.dataset.importInclude);
            if (input.checked) state.importExcludedIndexes.delete(index);
            else state.importExcludedIndexes.add(index);
            renderImportPreview();
        }));
        importPreviewStep.querySelector('#import-exclude-artifacts')?.addEventListener('click', () => {
            (preview.entries || []).filter(entry => entry.artifact).forEach(entry => state.importExcludedIndexes.add(entry.index));
            renderImportPreview();
        });
        importPreviewStep.querySelector('#import-conflict-action')?.addEventListener('change', event => {
            state.importConflictAction = event.target.value || null;
            renderImportPreview();
        });
        importPreviewStep.querySelector('#import-preview-back')?.addEventListener('click', resetImportFlow);
        importPreviewStep.querySelector('#import-job-start')?.addEventListener('click', startImportJob);
    }

    function renderImportJob(job) {
        const total = Math.max(1, Number(job.total) || 1);
        const progress = Math.min(100, Math.round((Number(job.completed) / total) * 100));
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
        importProgressFill.style.width = `${job.status === 'completed' ? 100 : progress}%`;
        importProgressCount.textContent = active ? `${job.completed || 0} / ${job.total || 0} · ${progress}%` : `${job.completed || 0} / ${job.total || 0}`;
        importProgressCancel.classList.toggle('hidden', !active);
        importProgressCancel.disabled = job.status === 'cancelling';
        importProgressCancel.textContent = job.status === 'cancelling' ? 'Cancelling…' : 'Cancel';
        importProgressResults.classList.toggle('hidden', active);
        importProgressDismiss.classList.toggle('hidden', active);
        openImportButton.disabled = active;
        openImportButton.title = active ? 'An import is already running' : 'Import assets';
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
                    return;
                }
                throw new Error(job.detail || 'Could not read import progress');
            }
            renderImportJob(job);
            if (['completed', 'failed', 'cancelled', 'stale'].includes(job.status)) {
                stopImportPolling();
                localStorage.removeItem('gaia.activeImportJobId');
                state.importLastJob = job;
                state.importJobId = null;
                setImportBusy(false);
                if (job.status === 'completed') {
                    sourcePath.value = '';
                    await loadLibrary();
                }
                return;
            }
            importPollTimer = setTimeout(pollImportJob, 650);
        } catch (error) {
            renderImportPollingIssue(error.message);
            importPollTimer = setTimeout(pollImportJob, 1800);
        }
    }

    async function startImportJob() {
        const preview = state.importPreview;
        if (!preview) return;
        setImportBusy(true);
        try {
            const response = await fetch('/items/import/jobs', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    preview_id: preview.preview_id,
                    folder_assignments: Object.fromEntries(state.importFolderAssignments),
                    item_types: Object.fromEntries(state.importItemTypes),
                    excluded_indexes: [...state.importExcludedIndexes],
                    conflict_action: state.importConflictAction,
                }),
            });
            const job = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(job.detail || 'Could not start import');
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

    vaultPicker?.addEventListener('click', event => {
        event.stopPropagation();
        const isOpen = !vaultMenu?.classList.contains('hidden');
        if (isOpen) closeVaultMenu();
        else {
            renderVaultMenu();
            vaultMenu?.classList.remove('hidden');
            vaultPicker?.setAttribute('aria-expanded', 'true');
        }
    });
    vaultMenu?.addEventListener('click', event => event.stopPropagation());
    document.addEventListener('click', closeVaultMenu);
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') closeVaultMenu();
    });
    createVaultButton?.addEventListener('click', () => openVaultDialog('create'));
    deleteVaultButton?.addEventListener('click', deleteActiveVault);
    vaultOptionsButton?.addEventListener('click', () => openVaultDialog('rename'));
    vaultForm?.addEventListener('submit', submitVaultDialog);
    vaultDialogClose?.addEventListener('click', () => vaultDialog?.close());
    vaultDialogCancel?.addEventListener('click', () => vaultDialog?.close());
    vaultDialog?.addEventListener('click', event => {
        if (event.target === vaultDialog) vaultDialog.close();
    });

    openImportButton?.addEventListener('click', () => {
        if (state.importJobId) return;
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

    function renderSourcePicker(result) {
        state.sourcePickerDirectory = result.path;
        state.sourcePickerParent = result.parent;
        state.sourcePickerSelection = result.selected_path || null;
        sourcePickerLocation.value = result.path;
        sourcePickerUp.disabled = !result.parent;

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
                const selected = entry.path === state.sourcePickerSelection;
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
        if (state.sourcePickerSelection) {
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
            state.sourcePickerDirectory = null;
            state.sourcePickerParent = null;
            state.sourcePickerSelection = null;
            sourcePickerList.innerHTML = '<div class="source-picker-empty">Location unavailable.</div>';
            sourcePickerResult.textContent = error.message;
            sourcePickerResult.className = 'inline-error';
            sourcePickerChoose.disabled = true;
        }
    }

    async function openSourcePicker() {
        if (!sourcePickerDialog.open) sourcePickerDialog.showModal();
        await loadSourcePicker(sourcePath.value.trim() || null);
    }

    function chooseSourcePickerPath() {
        const path = state.sourcePickerSelection || state.sourcePickerDirectory;
        if (!path) return;
        sourcePath.value = path;
        sourcePickerDialog.close();
        importResult.className = 'result hidden';
        importSubmit.focus();
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
            const response = await fetch('/items/import/preview', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ source_path: sourcePath.value, vault_id: state.importVaultId }),
            });
            const preview = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(preview.detail || 'Could not inspect source');
            state.importPreview = preview;
            state.importFolderAssignments = new Map(
                (preview.nodes || [])
                    .filter(node => node.kind === 'folder' && node.detected_assignment)
                    .map(node => [node.relative_path, node.detected_assignment]),
            );
            state.importItemTypes = new Map((preview.entries || []).map(entry => [entry.index, entry.type]));
            state.importExcludedIndexes = new Set();
            state.importCollapsedFolders = new Set(
                (preview.nodes || []).filter(node => node.kind === 'folder').map(node => node.relative_path),
            );
            state.importConflictAction = preview.conflicts?.length ? null : 'skip';
            importSourceStep.classList.add('hidden');
            importPreviewStep.classList.remove('hidden');
            renderImportPreview();
        } catch (error) {
            importResult.textContent = error.message;
            importResult.className = 'result error';
        } finally {
            importSubmit.disabled = false;
            importSubmit.textContent = 'Inspect source';
        }
    }

    importForm.addEventListener('submit', async event => {
        event.preventDefault();
        await inspectImportSource();
    });
    chooseSourcePath.addEventListener('click', openSourcePicker);
    sourcePickerClose.addEventListener('click', () => sourcePickerDialog.close());
    sourcePickerCancel.addEventListener('click', () => sourcePickerDialog.close());
    sourcePickerUp.addEventListener('click', () => {
        if (state.sourcePickerParent) loadSourcePicker(state.sourcePickerParent);
    });
    sourcePickerLocationForm.addEventListener('submit', event => {
        event.preventDefault();
        loadSourcePicker(sourcePickerLocation.value.trim());
    });
    sourcePickerLocations.addEventListener('click', event => {
        const location = event.target.closest('[data-path]');
        if (location) loadSourcePicker(location.dataset.path);
    });
    sourcePickerList.addEventListener('click', event => {
        const entry = event.target.closest('.source-picker-row');
        if (!entry) return;
        if (entry.dataset.kind === 'folder') {
            loadSourcePicker(entry.dataset.path);
            return;
        }
        state.sourcePickerSelection = entry.dataset.path;
        updateSourcePickerSelection();
    });
    sourcePickerList.addEventListener('dblclick', event => {
        const entry = event.target.closest('.source-picker-row[data-kind="file"]');
        if (!entry) return;
        state.sourcePickerSelection = entry.dataset.path;
        chooseSourcePickerPath();
    });
    sourcePickerChoose.addEventListener('click', chooseSourcePickerPath);
    sourcePickerDialog.addEventListener('click', event => {
        if (event.target === sourcePickerDialog) sourcePickerDialog.close();
    });

    vaultSelect.addEventListener('change', () => {
        if (vaultSelect.value === '__create__') {
            showImportVaultCreate(true);
            importVaultName.focus();
            return;
        }
        state.importVaultId = Number(vaultSelect.value);
        showImportVaultCreate(false);
    });
    importVaultCreateSubmit.addEventListener('click', createImportVault);
    importVaultCreateCancel.addEventListener('click', () => renderVaults());
    importVaultName.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            createImportVault();
        }
    });

    [typeChips, tagChips].forEach(chips => {
        if (!chips) return;
        const parent = chips.parentNode;
        const rail = createFilterRail(chips);
        parent.appendChild(rail);
        enableHorizontalDragScroll(chips);
    });
    const restoredImportJobId = localStorage.getItem('gaia.activeImportJobId');
    if (restoredImportJobId) {
        state.importJobId = restoredImportJobId;
        renderImportPollingIssue('Reconnecting to background import');
        pollImportJob();
    }
    loadLibrary();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeGaiaLibrary, { once: true });
} else {
    initializeGaiaLibrary();
}
