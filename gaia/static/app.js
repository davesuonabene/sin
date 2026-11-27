function initializeGaiaLibrary() {
    const MAIN_COLUMN_DEFINITIONS = Object.freeze({
        favourite: { label: '★', menuLabel: '★ Favourite', width: 26 },
        name: { label: 'Title', width: 240 },
        filename: { label: 'Filename', width: 190 },
        path: { label: 'Path', width: 260 },
        type: { label: 'Type', width: 110 },
        author: { label: 'Author', width: 170 },
        album: { label: 'Album', width: 150 },
        album_artist: { label: 'Album artist', width: 150 },
        release_year: { label: 'Release year', width: 92 },
        genre: { label: 'Genre', width: 130 },
        track_number: { label: 'Track #', width: 78 },
        disc_number: { label: 'Disc #', width: 72 },
        comment: { label: 'Comment', width: 180 },
        duration: { label: 'Duration', width: 92 },
        bpm: { label: 'BPM', width: 72 },
        key: { label: 'Key', width: 72 },
        loop: { label: 'Loop', width: 72 },
        tags: { label: 'Tags', width: 180 },
        size: { label: 'Size', width: 90 },
        mime_type: { label: 'MIME type', width: 135 },
        source: { label: 'Source', width: 220 },
        modified: { label: 'Modified', width: 150 },
        id: { label: 'ID', width: 84 },
    });
    const DEFAULT_MAIN_COLUMN_ORDER = Object.freeze(Object.keys(MAIN_COLUMN_DEFINITIONS));
    const DEFAULT_MAIN_VISIBLE_COLUMNS = Object.freeze(['favourite', 'name', 'type', 'size']);
    const MAIN_COLUMN_PREFERENCES_KEY = 'gaia.mainTableColumns.v1';

    function loadMainColumnPreferences() {
        const fallback = {
            order: [...DEFAULT_MAIN_COLUMN_ORDER],
            visible: [...DEFAULT_MAIN_VISIBLE_COLUMNS],
            widths: Object.fromEntries(Object.entries(MAIN_COLUMN_DEFINITIONS).map(([field, definition]) => [field, definition.width])),
        };
        try {
            const stored = JSON.parse(localStorage.getItem(MAIN_COLUMN_PREFERENCES_KEY) || 'null');
            const validFields = new Set(DEFAULT_MAIN_COLUMN_ORDER);
            const order = Array.isArray(stored?.order)
                ? [...new Set(stored.order.filter(field => validFields.has(field))), ...DEFAULT_MAIN_COLUMN_ORDER.filter(field => !stored.order.includes(field))]
                : fallback.order;
            const visible = Array.isArray(stored?.visible)
                ? [...new Set(stored.visible.filter(field => validFields.has(field)))]
                : fallback.visible;

            const favOrderIdx = order.indexOf('favourite');
            if (favOrderIdx >= 0) order.splice(favOrderIdx, 1);
            order.unshift('favourite');

            const favVisIdx = visible.indexOf('favourite');
            if (favVisIdx >= 0) visible.splice(favVisIdx, 1);
            visible.unshift('favourite');

            if (!visible.includes('name')) visible.splice(1, 0, 'name');
            const widths = { ...fallback.widths };
            Object.entries(stored?.widths || {}).forEach(([field, width]) => {
                const numericWidth = Number(width);
                const minWidth = field === 'favourite' ? 22 : 40;
                if (validFields.has(field) && Number.isFinite(numericWidth)) widths[field] = Math.min(600, Math.max(minWidth, numericWidth));
            });
            return { order, visible, widths };
        } catch (_error) {
            return fallback;
        }
    }

    function saveMainColumnPreferences() {
        try {
            localStorage.setItem(MAIN_COLUMN_PREFERENCES_KEY, JSON.stringify({
                order: state.mainColumnOrder,
                visible: [...state.mainVisibleColumns],
                widths: state.mainColumnWidths,
            }));
        } catch (_error) {
            // Preferences are optional and localStorage may be unavailable in a locked-down browser.
        }
    }

    const mainColumnPreferences = loadMainColumnPreferences();
    const state = {
        items: [],
        catalogItems: [],
        types: [],
        selectedTypes: new Set(),
        selectedTags: new Set(),
        query: '',
        expandedCollections: new Set(),
        expandedSubfolders: new Set(),
        subfolderEntries: new Map(),
        pendingFolderCreation: null,
        selectedEntryIds: new Set(),
        selectionAnchorId: null,
        audio: null,
        playingKey: null,
        vaults: [],
        selectedVaultId: null,
        playlists: [],
        selectedPlaylistId: null,
        vaultSyncStatus: null,
        isCheckingSync: false,
        importVaultId: null,
        importPreview: null,
        importFolderAssignments: new Map(),
        importItemTypes: new Map(),
        importExcludedIndexes: new Set(),
        importSelectedRows: new Set(),
        importSelectionAnchor: null,
        importUpperExpanded: false,
        importTransferMode: 'copy',
        skipTrackAnalysis: false,
        importCollapsedFolders: new Set(),
        importConflictAction: null,
        importJobId: null,
        importLastJob: null,
        importRegisteredJobId: null,
        sourcePickerDirectory: null,
        sourcePickerParent: null,
        sourcePickerSelection: null,
        vaultPathPickerMode: null,
        contextEntry: null,
        clipboard: null,
        isDraggingItem: false,
        projectReferencedItems: new Map(),
        projectReferencesLoading: new Set(),
        projectReferenceControllers: new Map(),
        projectDialogSources: [],
        projectSourceIds: new Set(),
        projectMoveIds: new Set(),
        projectImportPickerActive: false,
        projectImportInspecting: false,
        projectPendingImports: [],
        projectPendingMoveIds: new Set(),
        projectCreationImportContext: null,
        pendingPlacement: null,
        visibleFlatRows: [],
        filterMatches: null,
        versionSelections: new Map(),
        pendingVersionDeletion: null,
        libraryLoadPromise: null,
        searchRafId: null,
        mainColumnOrder: mainColumnPreferences.order,
        mainVisibleColumns: new Set(mainColumnPreferences.visible),
        mainColumnWidths: mainColumnPreferences.widths,
        columnResize: null,
    };

    const catalogStore = new window.GaiaCatalogStore({ cacheKey: 'gaia-manager' });
    let catalogBooted = false;
    let virtualList = null;

    const assetList = document.getElementById('asset-list');
    const assetPanel = document.querySelector('.asset-panel');
    const assetDropOverlay = document.getElementById('asset-drop-overlay');
    const assetDropOverlayTitle = document.getElementById('asset-drop-overlay-title');
    const summary = document.getElementById('library-summary');
    const libraryLayout = document.getElementById('library-layout');
    const sidebarToggle = document.getElementById('sidebar-toggle');
    const sidebarVaultList = document.getElementById('sidebar-vault-list');
    const sidebarPlaylistList = document.getElementById('sidebar-playlist-list');
    const sidebarNewPlaylistButton = document.getElementById('sidebar-new-playlist');
    const vaultPicker = document.getElementById('vault-picker');
    const activeVaultName = document.getElementById('active-vault-name');
    const vaultMenu = document.getElementById('vault-menu');
    const vaultMenuList = document.getElementById('vault-menu-list');
    const vaultDialog = document.getElementById('vault-dialog');
    const vaultForm = document.getElementById('vault-form');
    const vaultDialogEyebrow = document.getElementById('vault-dialog-eyebrow');
    const vaultDialogTitle = document.getElementById('vault-dialog-title');
    const vaultDialogClose = document.getElementById('vault-dialog-close');
    const vaultDialogCancel = document.getElementById('vault-dialog-cancel');
    const vaultDialogSubmit = document.getElementById('vault-dialog-submit');
    const vaultNameInput = document.getElementById('vault-name-input');
    const vaultPathLabel = document.getElementById('vault-path-label');
    const vaultPathInput = document.getElementById('vault-path-input');
    const vaultPathAction = document.getElementById('vault-path-action');
    const vaultPathHelp = document.getElementById('vault-path-help');
    const vaultPreviewSelect = document.getElementById('vault-preview-select');
    const vaultDialogResult = document.getElementById('vault-dialog-result');
    const vaultMirrorsList = document.getElementById('vault-mirrors-list');
    const vaultMirrorSourceInput = document.getElementById('vault-mirror-source-input');
    const vaultMirrorBrowseBtn = document.getElementById('vault-mirror-browse-btn');
    const vaultMirrorModeSelect = document.getElementById('vault-mirror-mode-select');
    const vaultMirrorTargetInput = document.getElementById('vault-mirror-target-input');
    const vaultMirrorAddBtn = document.getElementById('vault-mirror-add-btn');
    const searchInput = document.getElementById('search-input');
    const filterControls = document.getElementById('filter-controls');
    const toggleFiltersButton = document.getElementById('toggle-filters');
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
    const listHeader = document.getElementById('list-header');
    const columnMenu = document.getElementById('column-menu');
    const contextMenu = document.getElementById('context-menu');
    const contextOpenEditorButton = document.getElementById('context-open-editor');
    const contextOpenScratchButton = document.getElementById('context-open-scratch');
    const contextSelectAllButton = document.getElementById('context-select-all');
    const copyEntryMenu = document.getElementById('copy-entry-menu');
    const pasteEntryMenu = document.getElementById('paste-entry-menu');
    const contextGoToLocationButton = document.getElementById('context-go-to-location');
    const contextShowOriginalButton = document.getElementById('context-show-original');
    const contextNewFolderButton = document.getElementById('context-new-folder');
    const contextMakeFolderMoveButton = document.getElementById('context-make-folder-move');
    const contextCollectVaultButton = document.getElementById('context-collect-vault');
    const contextDissolveFolderButton = document.getElementById('context-dissolve-folder');
    const selectionCollectVaultButton = document.getElementById('selection-collect-vault');
    const selectionDissolveFolderButton = document.getElementById('selection-dissolve-folder');
    const folderDialog = document.getElementById('folder-dialog');
    const folderForm = document.getElementById('folder-form');
    const folderNameInput = document.getElementById('folder-name-input');
    const folderDialogTitle = document.getElementById('folder-dialog-title');
    const folderDialogHelp = document.getElementById('folder-dialog-help');
    const folderDialogResult = document.getElementById('folder-dialog-result');
    const folderDialogClose = document.getElementById('folder-dialog-close');
    const folderDialogCancel = document.getElementById('folder-dialog-cancel');
    const folderDialogSubmit = document.getElementById('folder-dialog-submit');
    const analyzeEntryButton = document.getElementById('analyze-entry');
    const deleteEntryMenuButton = document.getElementById('delete-entry-menu');
    const moveBar = document.getElementById('move-bar');
    const moveCount = document.getElementById('move-count');
    const selectionMoveSubmenu = document.getElementById('selection-move-submenu');
    const selectionMoveTrigger = document.getElementById('selection-move-trigger');
    const moveTargetOptions = document.getElementById('move-target-options');
    const selectionPlaylistSubmenu = document.getElementById('selection-playlist-submenu');
    const selectionPlaylistTrigger = document.getElementById('selection-playlist-trigger');
    const playlistTargetOptions = document.getElementById('playlist-target-options');
    const removeFromPlaylistButton = document.getElementById('remove-from-playlist-button');
    const playlistMenuCreateButton = document.getElementById('playlist-menu-create');
    const playlistMenuRenameButton = document.getElementById('playlist-menu-rename');
    const playlistMenuDeleteButton = document.getElementById('playlist-menu-delete');
    const contextPlaylistOptions = document.getElementById('context-playlist-options');
    const playlistDialog = document.getElementById('playlist-dialog');
    const playlistForm = document.getElementById('playlist-form');
    const playlistNameInput = document.getElementById('playlist-name-input');
    const playlistDialogTitle = document.getElementById('playlist-dialog-title');
    const playlistDialogHelp = document.getElementById('playlist-dialog-help');
    const playlistDialogResult = document.getElementById('playlist-dialog-result');
    const playlistDialogClose = document.getElementById('playlist-dialog-close');
    const playlistDialogCancel = document.getElementById('playlist-dialog-cancel');
    const playlistDialogSubmit = document.getElementById('playlist-dialog-submit');
    const analyzeSelectionButton = document.getElementById('analyze-selection');
    const deleteSelectionButton = document.getElementById('delete-selection');
    const selectionTypeActions = document.getElementById('selection-type-actions');
    const filterStatus = document.getElementById('filter-status');
    const typeChips = document.getElementById('type-chips');
    const tagChips = document.getElementById('tag-chips');
    const importSubmit = document.getElementById('import-submit');
    const importSummaryDialog = document.getElementById('import-summary-dialog');
    const importSummaryContent = document.getElementById('import-summary-content');
    const importSummaryClose = document.getElementById('import-summary-close');
    const importSummaryDone = document.getElementById('import-summary-done');
    const reviewSinProposalsButton = document.getElementById('review-sin-proposals');
    const sinProposalsDialog = document.getElementById('sin-proposals-dialog');
    const sinProposalsContent = document.getElementById('sin-proposals-content');
    const sinProposalsClose = document.getElementById('sin-proposals-close');
    const sinProposalsDone = document.getElementById('sin-proposals-done');
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
    const importVaultCreate = document.getElementById('import-vault-create');
    const importVaultName = document.getElementById('import-vault-name');
    const importVaultCreateSubmit = document.getElementById('import-vault-create-submit');
    const importVaultCreateCancel = document.getElementById('import-vault-create-cancel');
    const importVaultCreateResult = document.getElementById('import-vault-create-result');
    const createProjectButton = document.getElementById('create-project');
    const fileNewProjectButton = document.getElementById('file-new-project');
    const fileImportButton = document.getElementById('file-import');
    const fileRefreshButton = document.getElementById('file-refresh');
    const vaultMenuCreateButton = document.getElementById('vault-menu-create');
    const vaultMenuSyncButton = document.getElementById('vault-menu-sync');
    const vaultMenuOptionsButton = document.getElementById('vault-menu-options');
    const vaultMenuDeleteButton = document.getElementById('vault-menu-delete');
    const vaultSyncPill = document.getElementById('vault-sync-pill');
    const vaultSyncPillText = document.getElementById('vault-sync-pill-text');
    const vaultSyncDialog = document.getElementById('vault-sync-dialog');
    const vaultSyncDialogTitle = document.getElementById('vault-sync-dialog-title');
    const vaultSyncDialogClose = document.getElementById('vault-sync-dialog-close');
    const vaultSyncDialogCancel = document.getElementById('vault-sync-dialog-cancel');
    const vaultSyncDialogQuickAll = document.getElementById('vault-sync-dialog-quick-all');
    const vaultSyncSummaryBanner = document.getElementById('vault-sync-summary-banner');
    const vaultSyncSummaryText = document.getElementById('vault-sync-summary-text');
    const vaultSyncDialogResult = document.getElementById('vault-sync-dialog-result');
    const syncMovedSection = document.getElementById('sync-moved-section');
    const syncMovedCount = document.getElementById('sync-moved-count');
    const syncMovedList = document.getElementById('sync-moved-list');
    const syncUntrackedSection = document.getElementById('sync-untracked-section');
    const syncUntrackedCount = document.getElementById('sync-untracked-count');
    const syncUntrackedList = document.getElementById('sync-untracked-list');
    const syncMissingSection = document.getElementById('sync-missing-section');
    const syncMissingCount = document.getElementById('sync-missing-count');
    const syncMissingList = document.getElementById('sync-missing-list');

    const appMenuBar = document.getElementById('app-menu-bar');
    const projectDialog = document.getElementById('project-dialog');
    const projectForm = document.getElementById('project-form');
    const projectDialogTitle = document.getElementById('project-dialog-title');
    const projectDialogClose = document.getElementById('project-dialog-close');
    const projectDialogCancel = document.getElementById('project-dialog-cancel');
    const projectName = document.getElementById('project-name');
    const projectKindSelect = document.getElementById('project-kind');
    const projectEngineSelect = document.getElementById('project-engine');
    const projectEngineHelp = document.getElementById('project-engine-help');
    const projectSourcePreview = document.getElementById('project-source-preview');
    const projectSourceTitle = document.getElementById('project-source-title');
    const projectSourceCount = document.getElementById('project-source-count');
    const projectSourceList = document.getElementById('project-source-list');
    const projectImportAdd = document.getElementById('project-import-add');
    const projectMoveAll = document.getElementById('project-move-all');
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
    const versionDeleteDialog = document.getElementById('version-delete-dialog');
    const versionDeleteTitle = document.getElementById('version-delete-title');
    const versionDeleteSummary = document.getElementById('version-delete-summary');
    const versionDeleteCurrent = document.getElementById('version-delete-current');
    const versionDeletePurge = document.getElementById('version-delete-purge');
    const versionDeleteCancel = document.getElementById('version-delete-cancel');
    let vaultDialogMode = 'create';

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>'"]/g, char => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
        })[char]);
    }

    function filename(path) {
        return String(path || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || 'Untitled asset';
    }

    /**
     * GAIA treats a final dotted stem segment as a file revision when it has
     * sibling files with the same base name and extension. For example,
     * "loop_03.wav", "loop_03.2.wav", and "loop_03.3.wav" form one item.
     * A single dotted filename remains an ordinary file, which avoids
     * misclassifying names such as "MZ 808 [D.O.T.S.].wav".
     */
    function fileVersionInfo(path) {
        const normalizedPath = String(path || '').replace(/\\/g, '/');
        const slashIndex = normalizedPath.lastIndexOf('/');
        const directory = slashIndex >= 0 ? normalizedPath.slice(0, slashIndex) : '';
        const file = slashIndex >= 0 ? normalizedPath.slice(slashIndex + 1) : normalizedPath;
        const extensionIndex = file.lastIndexOf('.');
        if (extensionIndex <= 0 || extensionIndex === file.length - 1) return null;

        const extension = file.slice(extensionIndex);
        const stem = file.slice(0, extensionIndex);
        const versionIndex = stem.lastIndexOf('.');
        const baseName = versionIndex > 0 ? stem.slice(0, versionIndex) : stem;
        const label = versionIndex > 0 ? stem.slice(versionIndex + 1) : null;
        if (!baseName) return null;

        return {
            baseName,
            label,
            filename: file,
            key: JSON.stringify([
                directory.toLocaleLowerCase(),
                baseName.toLocaleLowerCase(),
                extension.toLocaleLowerCase(),
            ]),
        };
    }

    function compareVersionLabels(left, right) {
        if (left === null) return right === null ? 0 : -1;
        if (right === null) return 1;
        if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
            const leftValue = left.replace(/^0+(?=\d)/, '');
            const rightValue = right.replace(/^0+(?=\d)/, '');
            if (leftValue.length !== rightValue.length) return leftValue.length - rightValue.length;
            const numericOrder = leftValue.localeCompare(rightValue);
            if (numericOrder) return numericOrder;
        }
        return left.localeCompare(right, undefined, { sensitivity: 'base', numeric: true });
    }

    function versionLabel(label) {
        return label === null ? 'Original' : `.${label}`;
    }

    /**
     * Return one display record per logical file. Version candidates are kept
     * on the record so a menu can swap the active physical asset without
     * altering the library's underlying item rows.
     */
    function groupFileVersions(records, { pathFor, idFor, scope }) {
        const candidates = records.map((record, index) => ({
            record,
            index,
            id: String(idFor(record)),
            info: fileVersionInfo(pathFor(record)),
        }));
        const groups = new Map();
        candidates.forEach(candidate => {
            if (!candidate.info) return;
            const group = groups.get(candidate.info.key) || [];
            group.push(candidate);
            groups.set(candidate.info.key, group);
        });

        const grouped = new Map();
        groups.forEach((members, key) => {
            if (members.length < 2 || !members.some(member => member.info.label !== null)) return;
            const versions = [...members].sort((left, right) => (
                compareVersionLabels(left.info.label, right.info.label)
                || left.info.filename.localeCompare(right.info.filename, undefined, { sensitivity: 'base' })
            ));
            grouped.set(key, {
                firstIndex: Math.min(...members.map(member => member.index)),
                key: `${scope}:${key}`,
                displayName: members[0].info.baseName,
                versions,
            });
        });

        return candidates.flatMap(candidate => {
            const group = candidate.info ? grouped.get(candidate.info.key) : null;
            if (!group) return [{ record: candidate.record }];
            if (candidate.index !== group.firstIndex) return [];

            const chosenId = state.versionSelections.get(group.key);
            const selected = group.versions.find(version => version.id === chosenId) || group.versions.at(-1);
            return [{
                record: selected.record,
                fileVersionGroup: group.key,
                fileVersionDisplayName: group.displayName,
                fileVersions: group.versions.map(version => ({
                    id: version.id,
                    label: versionLabel(version.info.label),
                    record: version.record,
                })),
            }];
        });
    }

    function typeDefinition(typeId) {
        return state.types.find(type => type.id === typeId);
    }

    function typeLabel(typeId) {
        if (typeId === 'sample_pack') return 'Sample pack';
        if (typeId === 'multitrack') return typeDefinition(typeId)?.label || 'Multitrack';
        return typeDefinition(typeId)?.label || String(typeId || '').replaceAll('_', ' ');
    }

    function typeIsContainer(typeId) {
        return Boolean(typeDefinition(typeId)?.container) || ['folder', 'collection', 'multitrack', 'zoom_h4', 'project'].includes(typeId);
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
        collection: {
            id: 'collection',
            columns: '52px minmax(150px, 1.3fr) minmax(82px, .45fr) minmax(90px, .7fr) 76px',
            fields: ['favourite', 'name', 'type', 'tags', 'size'],
        },
        samplePack: {
            id: 'sample-pack',
            columns: '52px minmax(145px, 1.25fr) minmax(140px, 1fr) minmax(78px, .45fr) 58px 62px minmax(100px, .8fr) 78px',
            fields: ['favourite', 'name', 'path', 'type', 'bpm', 'key', 'tags', 'size'],
        },
    });

    const ROW_HEADER_LABELS = Object.freeze({
        favourite: '★',
        name: 'Title',
        filename: 'Filename',
        path: 'Path',
        type: 'Type',
        author: 'Author',
        album: 'Album',
        album_artist: 'Album artist',
        release_year: 'Release year',
        genre: 'Genre',
        track_number: 'Track #',
        disc_number: 'Disc #',
        comment: 'Comment',
        duration: 'Duration',
        bpm: 'BPM',
        key: 'Key',
        loop: 'Loop',
        tags: 'Tags',
        size: 'Size',
        mime_type: 'MIME type',
        source: 'Source',
        modified: 'Modified',
        id: 'ID',
    });

    function visibleMainColumns() {
        const fields = state.mainColumnOrder.filter(field => (
            state.mainVisibleColumns.has(field) && MAIN_COLUMN_DEFINITIONS[field]
        ));
        return fields.length ? fields : ['name'];
    }

    function mainColumnMinimumWidth() {
        const fields = visibleMainColumns();
        return fields.reduce((total, field) => total + Number(state.mainColumnWidths[field] || MAIN_COLUMN_DEFINITIONS[field].width), 0)
            + Math.max(0, fields.length - 1) * 7 + 14;
    }

    function mainRowLayout() {
        const fields = visibleMainColumns();
        const columns = fields.map((field, index) => {
            const width = Math.round(Number(state.mainColumnWidths[field] || MAIN_COLUMN_DEFINITIONS[field].width));
            return index === fields.length - 1 ? `minmax(${width}px, 1fr)` : `${width}px`;
        }).join(' ');
        return { id: 'main', columns, fields };
    }

    function isSamplePackCollection(collection) {
        const attributes = collection?.attributes || {};
        const profile = [attributes.profile_id, attributes.profile_label]
            .filter(Boolean)
            .join(' ')
            .toLocaleLowerCase();
        return profile.includes('sample_pack') || profile.includes('sample pack');
    }

    const AUDIO_TYPE_SWITCH_OPTIONS = Object.freeze([
        { value: 'audio', label: 'Audio', hint: 'Unclassified audio' },
        { value: 'sample', label: 'Sample', hint: 'One-shot or loop · BPM & key' },
        { value: 'track', label: 'Track', hint: 'Music track · album metadata' },
    ]);

    const CONTAINER_TYPE_SWITCH_OPTIONS = Object.freeze([
        { value: 'folder', label: 'Folder', hint: 'Standard directory' },
        { value: 'sample_pack', label: 'Sample pack', hint: 'Pack · audio as samples' },
        { value: 'multitrack', label: 'Multitrack', hint: 'Aligned stems · SIN group' },
        { value: 'zoom_h4', label: 'Zoom H4', hint: 'Stems + TrLR mixdown' },
    ]);

    function effectiveEntryType(entry) {
        if (!entry) return 'item';
        const record = entry.kind === 'content' ? entry.content : (entry.item || entry);
        const rawType = String(entry.type || record?.type || '').toLowerCase();
        if ((rawType === 'folder' || rawType === 'collection') && isSamplePackCollection(record)) {
            return 'sample_pack';
        }
        if (rawType === 'collection') return 'folder';
        return rawType || 'item';
    }

    function isEntryInsideProject(entry) {
        if (!entry) return false;
        if (entry.kind === 'subfolder' && typeIsProject(entry.collection?.type)) return true;
        const itemId = entry.kind === 'subfolder' ? entryFolderItemId(entry) : numericItemId(entry);
        if (!itemId) return false;
        let current = catalogStore.getItem(itemId);
        const seen = new Set();
        while (current && current.parent_id != null && !seen.has(current.parent_id)) {
            seen.add(current.parent_id);
            const parent = catalogStore.getItem(current.parent_id);
            if (!parent) break;
            if (typeIsProject(parent.type)) return true;
            current = parent;
        }
        return false;
    }

    function switchableTypeOptions(entry) {
        if (!entry) return null;
        const rawType = String(entry.type || entry.item?.type || entry.content?.type || '').toLowerCase();
        if (['audio', 'sample', 'track'].includes(rawType)) {
            return AUDIO_TYPE_SWITCH_OPTIONS;
        }
        if (['folder', 'collection', 'multitrack', 'zoom_h4'].includes(rawType)) {
            if (typeIsProject(rawType) || isEntryInsideProject(entry)) return null;
            const id = entry.kind === 'subfolder' ? entryFolderItemId(entry) : numericItemId(entry);
            if (!id) return null;
            return CONTAINER_TYPE_SWITCH_OPTIONS;
        }
        return null;
    }

    function collectionRowLayout(collection) {
        return mainRowLayout();
    }

    function rowLayoutFor(entry, { nested = false } = {}) {
        return mainRowLayout();
    }

    function renderRowHeader(header, layout, className) {
        header.className = `row-header ${className}`;
        header.style.setProperty('--row-columns', layout.columns);
        if (layout.id === 'main' || className === 'main-row-header') {
            header.style.setProperty('--main-table-width', `${mainColumnMinimumWidth()}px`);
        }
        header.replaceChildren();

        const isMainLayout = (layout.id === 'main');
        layout.fields.forEach(field => {
            const cell = document.createElement('div');
            if (isMainLayout) {
                cell.className = 'row-header-cell';
                cell.dataset.column = field;
                cell.draggable = (className === 'main-row-header');
                cell.title = 'Drag to move this column · right-click for columns';
                const label = document.createElement('span');
                label.className = 'column-header-label';
                label.textContent = MAIN_COLUMN_DEFINITIONS[field]?.label || ROW_HEADER_LABELS[field] || field;
                cell.appendChild(label);
                const resizer = document.createElement('button');
                resizer.type = 'button';
                resizer.className = 'column-resizer';
                resizer.dataset.column = field;
                resizer.setAttribute('aria-label', `Resize ${label.textContent} column`);
                resizer.title = 'Drag to resize';
                cell.appendChild(resizer);
            } else {
                cell.textContent = ROW_HEADER_LABELS[field] || field;
            }
            header.appendChild(cell);
        });

        const settingToggle = document.createElement('button');
        settingToggle.type = 'button';
        settingToggle.className = 'header-settings-toggle';
        settingToggle.setAttribute('aria-label', 'Parameter selector');
        settingToggle.title = 'Customize columns';
        settingToggle.textContent = '⚙';
        settingToggle.addEventListener('click', event => {
            event.stopPropagation();
            event.preventDefault();
            const rect = settingToggle.getBoundingClientRect();
            openColumnMenu(rect.left - 180, rect.bottom + 4);
        });
        header.appendChild(settingToggle);

        return header;
    }

    function renderMainHeader() {
        if (!listHeader) return;
        renderRowHeader(listHeader, mainRowLayout(), 'main-row-header');
    }

    function applyMainColumnLayout() {
        const layout = mainRowLayout();
        const tableWidth = `${mainColumnMinimumWidth()}px`;
        if (listHeader) {
            listHeader.style.setProperty('--row-columns', layout.columns);
            listHeader.style.setProperty('--main-table-width', tableWidth);
        }
        assetList?.querySelectorAll('.main-row, .nested-row, .collection-row-header').forEach(row => {
            row.style.setProperty('--row-columns', layout.columns);
            row.style.setProperty('--main-table-width', tableWidth);
        });
        assetList?.querySelectorAll(':scope > .asset-entry, .collection-contents > .asset-entry').forEach(entry => {
            entry.style.setProperty('--main-table-width', tableWidth);
        });
    }

    function closeColumnMenu() {
        columnMenu?.classList.add('hidden');
    }

    function renderColumnMenu() {
        if (!columnMenu) return;
        columnMenu.replaceChildren();
        const title = document.createElement('div');
        title.className = 'column-menu-title sin-menu-heading';
        title.textContent = 'Show columns';
        columnMenu.appendChild(title);
        state.mainColumnOrder.forEach(field => {
            const definition = MAIN_COLUMN_DEFINITIONS[field];
            if (!definition) return;
            const label = document.createElement('label');
            label.className = 'column-menu-item sin-menu-item';
            label.innerHTML = `<input type="checkbox" data-column="${field}" ${state.mainVisibleColumns.has(field) ? 'checked' : ''} ${field === 'name' ? 'disabled' : ''}><span>${definition.menuLabel || definition.label}</span>`;
            columnMenu.appendChild(label);
        });
    }

    function openColumnMenu(x, y) {
        if (!columnMenu) return;
        renderColumnMenu();
        columnMenu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - 220))}px`;
        columnMenu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - 260))}px`;
        columnMenu.classList.remove('hidden');
    }

    function reorderMainColumn(sourceField, targetField, placeAfter) {
        if (!sourceField || !targetField || sourceField === targetField) return;
        const order = [...state.mainColumnOrder];
        const sourceIndex = order.indexOf(sourceField);
        if (sourceIndex < 0) return;
        order.splice(sourceIndex, 1);
        const adjustedTargetIndex = order.indexOf(targetField);
        order.splice(adjustedTargetIndex + (placeAfter ? 1 : 0), 0, sourceField);
        state.mainColumnOrder = order;
        saveMainColumnPreferences();
        renderMainHeader();
        renderAssets();
    }

    function clearHeaderDropIndicators() {
        listHeader?.querySelectorAll('.drop-before, .drop-after, .is-dragging').forEach(cell => {
            cell.classList.remove('drop-before', 'drop-after', 'is-dragging');
        });
    }

    function handleColumnResizeMove(event) {
        const resize = state.columnResize;
        if (!resize) return;
        const minWidth = resize.field === 'favourite' ? 22 : 50;
        const width = Math.min(600, Math.max(minWidth, resize.startWidth + event.clientX - resize.startX));
        state.mainColumnWidths[resize.field] = Math.round(width);
        applyMainColumnLayout();
    }

    function finishColumnResize() {
        if (!state.columnResize) return;
        state.columnResize = null;
        document.body.classList.remove('resizing-column');
        saveMainColumnPreferences();
        renderMainHeader();
        renderAssets();
    }

    function createCollectionHeader(collection) {
        const header = document.createElement('div');
        renderRowHeader(header, collectionRowLayout(collection), 'collection-row-header');
        header.addEventListener('dragover', event => {
            if (!Array.from(event.dataTransfer?.types || []).includes('application/x-gaia-item-ids')) return;
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = 'move';
            header.classList.add('drop-target');
        });
        header.addEventListener('dragleave', event => {
            if (!header.contains(event.relatedTarget)) header.classList.remove('drop-target');
        });
        header.addEventListener('drop', event => {
            header.classList.remove('drop-target');
            const rawIds = event.dataTransfer?.getData('application/x-gaia-item-ids');
            if (!rawIds) return;
            event.preventDefault();
            event.stopPropagation();
            try {
                const itemIds = JSON.parse(rawIds).map(Number).filter(id => Number.isFinite(id) && id !== Number(collection.id));
                if (itemIds.length) {
                    placeItemsDirectly({ item: collection, collection: collection, title: collection.title || collection.name }, [...new Set(itemIds)], { folder: '', mode: 'move' });
                }
            } catch (_error) {
                window.alert('GAIA could not read the dragged items.');
            }
        });
        return header;
    }

    function normalizeFacetValue(value) {
        return String(value ?? '').trim().toLocaleLowerCase();
    }

    function assetType(item) {
        const declaredType = normalizeFacetValue(item?.type);
        if ((declaredType === 'folder' || declaredType === 'collection') && isSamplePackCollection(item)) {
            return 'sample_pack';
        }
        if (declaredType === 'collection') return 'folder';
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
        if (entry.kind === 'asset') return entry.item;
        if (entry.kind === 'reference') {
            return {
                ...entry.item,
                tags: [...assetTags(entry.item), ...(entry.reference?.tags || entry.reference?.attributes?.tags || [])],
            };
        }
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

    let cachedFacetsKey = null;
    let cachedFacetsResult = null;
    let catalogFacetVersion = 0;

    function invalidateFacetCache() {
        catalogFacetVersion++;
        cachedFacetsKey = null;
        cachedFacetsResult = null;
    }

    const entryRegistry = new Map();

    function canonicalEntry(entry) {
        if (!entry) return entry;
        const item = entry.kind === 'content' ? entry.content : entry.item;
        const concreteId = entry.itemId
            ?? (entry.kind === 'content' ? (entry.content?.child_id || entry.item?.id) : entry.item?.id)
            ?? (entry.kind === 'subfolder' ? (entry.folderItem?.child_id || entry.folderItem?.id || entry.folderItem?.item?.id) : null);
        const numId = concreteId && Number.isFinite(Number(concreteId)) ? Number(concreteId) : null;
        entry.numericId = numId;
        entry.targetId = numId || (entry.collection?.id ? Number(entry.collection.id) : null);
        entry.displayName = entry.title || item?.title || item?.name || (item?.absolute_path ? filename(item.absolute_path) : (entry.path || ''));
        entry.isContainer = Boolean(
            (entry.kind === 'asset' && typeIsContainer(entry.type))
            || entry.type === 'collection'
            || entry.type === 'folder'
            || typeIsContainer(entry.type)
            || item?.attributes?.is_folder
            || entry.content?.attributes?.is_folder
            || entry.kind === 'subfolder'
        );
        if (numId) {
            entry.streamPath = `/items/${numId}/stream`;
        } else if (entry.kind === 'content' && entry.collection?.id && entry.content?.index !== undefined) {
            entry.streamPath = `/items/${entry.collection.id}/contents/${entry.content.index}/stream`;
        } else {
            entry.streamPath = null;
        }
        return entry;
    }

    function registerEntry(entry) {
        if (!entry || !entry.id) return entry;
        canonicalEntry(entry);
        entryRegistry.set(String(entry.id), entry);
        return entry;
    }

    function entryById(id) {
        if (!id) return null;
        const strId = String(id);
        const found = entryRegistry.get(strId);
        if (found) return found;
        const fallback = allEntries().find(e => String(e.id) === strId);
        if (fallback) registerEntry(fallback);
        return fallback || null;
    }

    function filterableEntries() {
        return rootAssetEntries().map(entry => filterableItem(entry));
    }

    function compatibleFacets(selection) {
        const vaultKey = selection?.vaultIds ? [...selection.vaultIds].sort().join(',') : '';
        const typesKey = selection?.types ? [...selection.types].sort().join(',') : '';
        const tagsKey = selection?.tags ? [...selection.tags].sort().join(',') : '';
        const cacheKey = `${catalogFacetVersion}|${vaultKey}|${typesKey}|${tagsKey}`;
        if (cachedFacetsKey === cacheKey && cachedFacetsResult) {
            return cachedFacetsResult;
        }

        const vaultIds = new Set();
        const types = new Set();
        const tags = new Map();
        const facetSourceItems = state.catalogItems.length ? state.catalogItems : state.items;
        for (let i = 0; i < facetSourceItems.length; i++) {
            const item = facetSourceItems[i];
            if (assetMatchesFilters(item, { types: selection.types, tags: selection.tags })) {
                assetVaultIds(item).forEach(id => vaultIds.add(id));
            }
            if (assetMatchesFilters(item, { vaultIds: selection.vaultIds, tags: selection.tags })) {
                const type = assetType(item);
                if (type === 'sample_pack' || typeDefinition(type)) types.add(type);
            }
            if (assetMatchesFilters(item, selection)) {
                assetTags(item).forEach(tag => {
                    const normalized = normalizeFacetValue(tag);
                    if (!tags.has(normalized)) tags.set(normalized, tag);
                });
            }
            if (typeIsContainer(item.type)) {
                const contentTypes = Array.isArray(item.content_types) ? item.content_types : [];
                const contentTags = Array.isArray(item.content_tags) ? item.content_tags : [];
                const vaultMatches = !selection.vaultIds?.size || selection.vaultIds.has(Number(item.vault_id));
                if (!vaultMatches) continue;
                const tagsMatch = !selection.tags?.size || [...selection.tags].every(selectedTag => (
                    contentTags.some(itemTag => tagMatches(normalizeFacetValue(selectedTag), normalizeFacetValue(itemTag)))
                ));
                if (tagsMatch) {
                    for (let j = 0; j < contentTypes.length; j++) {
                        const ct = contentTypes[j];
                        if (!selection.types?.size || selection.types.has(ct)) types.add(ct);
                    }
                }
                if (!selection.types?.size || contentTypes.some(ct => selection.types.has(ct))) {
                    for (let j = 0; j < contentTags.length; j++) {
                        const ct = contentTags[j];
                        const normalized = normalizeFacetValue(ct);
                        if (!tags.has(normalized)) tags.set(normalized, ct);
                    }
                }
            }
        }
        cachedFacetsKey = cacheKey;
        cachedFacetsResult = { vaultIds, types, tags };
        return cachedFacetsResult;
    }

    function allEntries() {
        if (state.visibleFlatRows.length) {
            const entries = [];
            for (let i = 0; i < state.visibleFlatRows.length; i++) {
                const e = state.visibleFlatRows[i].entry;
                if (e) entries.push(e);
            }
            return entries;
        }
        const entries = rootAssetEntries();
        if (state.subfolderEntries?.size) {
            entries.push(...state.subfolderEntries.values());
        }
        return entries;
    }

    function rootAssetEntries() {
        return groupFileVersions(state.items, {
            pathFor: item => item.absolute_path,
            idFor: item => item.id,
            scope: 'root',
        }).map(group => registerEntry({
            kind: 'asset',
            id: group.fileVersionGroup ? `version:${group.fileVersionGroup}` : String(group.record.id),
            type: group.record.type,
            title: group.fileVersionDisplayName || group.record.title || filename(group.record.absolute_path),
            path: group.record.absolute_path,
            item: group.record,
            fileVersionGroup: group.fileVersionGroup,
            fileVersions: group.fileVersions,
        }));
    }

    function isPathExternalToProject(filePath, projectPath) {
        if (!filePath || !projectPath) return true;
        const normItem = String(filePath).replace(/\\/g, '/').toLowerCase();
        let normProj = String(projectPath).replace(/\\/g, '/').toLowerCase();
        if (!normProj.endsWith('/')) normProj += '/';
        return !normItem.startsWith(normProj);
    }

    function isEntryExternalReference(entry) {
        if (!entry) return false;
        const storageMode = String(
            entry.item?.storage_mode
            || entry.content?.storage_mode
            || entry.folderItem?.storage_mode
            || entry.folderItem?.content?.storage_mode
            || entry.folderItem?.item?.storage_mode
            || ''
        ).toLowerCase();
        if (storageMode === 'external_reference') return true;
        if (entry.kind !== 'reference') return false;
        if (typeof entry.is_external === 'boolean') {
            return entry.is_external;
        }
        return isPathExternalToProject(entry.item?.absolute_path || entry.path, entry.collection?.absolute_path);
    }

    function projectReferenceEntries(project) {
        if (!typeIsContainer(project?.type)) return [];
        return (state.projectReferencedItems.get(Number(project.id)) || []).map(record => {
            const groupKey = record.version_group ? `project:${project.id}:${record.version_group}` : null;
            const chosenId = groupKey ? state.versionSelections.get(groupKey) : null;
            const hasVersions = Array.isArray(record.versions) && record.versions.length > 1;
            const selectedVersion = hasVersions && chosenId
                ? (record.versions.find(v => String(v.item.id) === String(chosenId)) || record.versions.at(-1))
                : null;
            const activeItem = selectedVersion ? selectedVersion.item : record.item;
            const activeReference = selectedVersion ? selectedVersion.reference : record.reference;
            const activeIsExternal = selectedVersion
                ? Boolean(selectedVersion.is_external)
                : (record.is_external !== undefined ? Boolean(record.is_external) : isPathExternalToProject(activeItem?.absolute_path, project?.absolute_path));
            const fileVersions = hasVersions
                ? record.versions.map(v => ({
                    id: String(v.item.id),
                    label: v.label,
                    record: v.item,
                    is_external: Boolean(v.is_external),
                }))
                : null;

            return registerEntry({
                kind: 'reference',
                id: `${project.id}:reference:${activeReference.id}`,
                itemId: Number(activeItem.id) || null,
                type: activeItem.type,
                title: activeItem.title || filename(activeItem.absolute_path),
                path: activeItem.absolute_path,
                item: activeItem,
                reference: activeReference,
                is_external: activeIsExternal,
                versions: record.versions || [],
                versionGroup: record.version_group || null,
                fileVersionGroup: groupKey,
                fileVersions,
                collection: project,
            });
        });
    }

    async function loadProjectReferencedItems(projectId, { reset = false } = {}) {
        const numericId = Number(projectId);
        if (!Number.isFinite(numericId)) return;
        if (!reset && (state.projectReferencedItems.has(numericId) || state.projectReferencesLoading.has(numericId))) return;
        state.projectReferenceControllers.get(numericId)?.abort();
        const controller = new AbortController();
        state.projectReferenceControllers.set(numericId, controller);
        if (reset) state.projectReferencedItems.delete(numericId);
        state.projectReferencesLoading.add(numericId);
        try {
            const response = await fetch(`/projects/${numericId}/table`, { signal: controller.signal });
            const table = await response.json().catch(() => ([]));
            if (!response.ok) throw new Error(table.detail || 'Could not load project links');
            if (state.projectReferenceControllers.get(numericId) !== controller) return;
            state.projectReferencedItems.set(numericId, (Array.isArray(table) ? table : [])
                .map(row => ({
                    reference: row.reference,
                    item: row.item,
                    version_group: row.version_group,
                    is_external: Boolean(row.is_external),
                    versions: (row.versions || []).map(v => ({
                        ...v,
                        is_external: Boolean(v.is_external),
                    })),
                }))
                .filter(record => record.item && record.reference));
        } catch (error) {
            if (error?.name === 'AbortError') return;
            console.warn('Could not load folder references', error);
            state.projectReferencedItems.set(numericId, []);
        } finally {
            if (state.projectReferenceControllers.get(numericId) === controller) {
                state.projectReferenceControllers.delete(numericId);
                state.projectReferencesLoading.delete(numericId);
                const entry = allEntries().find(candidate => candidate.kind === 'asset' && candidate.item?.id === numericId);
                if (entry && state.expandedCollections.has(entry.id)) renderAssets();
            }
        }
    }

    function resetNestedLibraryCaches() {
        invalidateFacetCache();
        state.projectReferenceControllers.forEach(controller => controller.abort());
        state.projectReferencedItems.clear();
        state.projectReferencesLoading.clear();
        state.projectReferenceControllers.clear();
    }

    /** Direct 1-level children (plus project references) straight from in-memory catalogStore (< 0.1 ms). */
    function directChildEntries(parentContainer, rootCollection = parentContainer) {
        const parentId = Number(parentContainer?.id);
        const references = typeIsProject(parentContainer?.type) ? projectReferenceEntries(parentContainer) : [];
        const referencedItemIds = references.length
            ? new Set(references.flatMap(entry => [
                Number(entry.item.id),
                ...(entry.versions || []).map(version => Number(version.item?.id)),
            ]))
            : null;
        const rawChildren = catalogStore.getDirectChildren(parentId);
        const folders = [];
        const files = [];
        const rootPath = String(rootCollection?.absolute_path || parentContainer?.absolute_path || '').replace(/\\/g, '/').replace(/\/+$/, '');
        const rootPrefixLower = rootPath ? `${rootPath.toLowerCase()}/` : '';

        for (let i = 0; i < rawChildren.length; i++) {
            const child = rawChildren[i];
            if (referencedItemIds && referencedItemIds.has(Number(child.id))) continue;
            const isSub = typeIsContainer(child.type) || child.type === 'folder' || child.type === 'collection' || Boolean(child.attributes?.is_folder);
            if (isSub) {
                folders.push(child);
            } else {
                files.push(child);
            }
        }

        const versionedFiles = groupFileVersions(files, {
            pathFor: item => item.absolute_path || item.filename,
            idFor: item => item.id,
            scope: `folder:${parentId}`,
        }).map((group, idx) => {
            const rec = group.record;
            const rawAbs = String(rec.absolute_path || '').replace(/\\/g, '/');
            const relPath = (rootPrefixLower && rawAbs.toLowerCase().startsWith(rootPrefixLower))
                ? rawAbs.slice(rootPrefixLower.length)
                : (rec.attributes?.folder ? `${rec.attributes.folder}/${rec.filename}` : rec.filename);
            return registerEntry({
                kind: 'content',
                id: group.fileVersionGroup ? `version:${group.fileVersionGroup}` : `${rootCollection.id}:item:${rec.id}`,
                itemId: Number(rec.id),
                type: rec.type,
                title: group.fileVersionDisplayName || rec.title || rec.filename,
                path: relPath,
                content: { ...rec, child_id: rec.id, index: idx, relative_path: relPath },
                item: rec,
                collection: rootCollection,
                fileVersionGroup: group.fileVersionGroup,
                fileVersions: group.fileVersions,
            });
        });

        return { folders, files: versionedFiles, references };
    }

    function collectionContentEntries(collection) {
        const references = projectReferenceEntries(collection);
        const referencedItemIds = new Set(references.flatMap(entry => [
            Number(entry.item.id),
            ...(entry.versions || []).map(version => Number(version.item?.id)),
        ]));
        const rawContents = catalogStore.getSubtreeContents(Number(collection.id));
        const contents = groupFileVersions(
            rawContents.filter(content => !referencedItemIds.has(Number(content.child_id))),
            {
                pathFor: content => content.relative_path || content.filename,
                idFor: content => content.child_id || `${collection.id}:${content.index}`,
                scope: `collection:${collection.id}`,
            },
        ).map(group => registerEntry({
            kind: 'content',
            id: group.fileVersionGroup ? `version:${group.fileVersionGroup}` : `${collection.id}:item:${group.record.child_id ?? group.record.index}`,
            itemId: Number(group.record.child_id) || null,
            type: group.record.type,
            title: group.fileVersionDisplayName || group.record.title || group.record.filename,
            path: group.record.relative_path,
            content: group.record,
            item: group.record,
            collection,
            fileVersionGroup: group.fileVersionGroup,
            fileVersions: group.fileVersions,
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
        const item = entry.item || entry.content;
        if (item?._search) {
            const tokens = state.query.split(/\s+/).filter(Boolean);
            const refTags = (entry.reference?.tags || entry.reference?.attributes?.tags || []).join(' ').toLowerCase();
            const haystack = refTags ? `${item._search} ${refTags}` : item._search;
            return tokens.every(tok => haystack.includes(tok));
        }
        const haystack = [
            entry.title,
            entry.path,
            entry.collection?.title,
            entry.collection?.source_path,
            ...(entry.item?.tags || []).map(tag => tag?.name || tag),
            ...(entry.reference?.tags || entry.reference?.attributes?.tags || []),
            ...(entry.content?.tags || []),
        ].join(' ').toLowerCase();
        return haystack.includes(state.query);
    }

    function filteringIsActive() {
        return Boolean(state.selectedTypes.size || state.selectedTags.size || state.query);
    }

    function visibleEntries() {
        const assets = rootAssetEntries();
        if (!filteringIsActive()) {
            state.filterMatches = null;
            return assets.sort((a, b) => a.title.localeCompare(b.title));
        }

        const fm = catalogStore.computeFilterMatches({
            roots: state.items,
            query: state.query,
            selectedTypes: state.selectedTypes,
            selectedTags: state.selectedTags,
        });
        state.filterMatches = fm;

        return assets.filter(entry => {
            const id = Number(entry.item?.id);
            if (fm.matchingBranchIds.has(id)) return true;
            if (typeIsProject(entry.type) && state.projectReferencedItems.has(id)) {
                return projectReferenceEntries(entry.item).some(entryMatches);
            }
            return entryMatches(entry);
        }).sort((a, b) => a.title.localeCompare(b.title));
    }

    function selectionEntries() {
        const entries = [];
        for (let i = 0; i < state.visibleFlatRows.length; i++) {
            const e = state.visibleFlatRows[i].entry;
            if (e) entries.push(e);
        }
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
        window.dispatchEvent(new CustomEvent('gaia:selection', {
            detail: {
                entry,
                playable: Boolean(entry && (canPreview(entry) || entry.isContainer || typeIsContainer(entry.type) || entry.type === 'collection')),
            },
        }));
    }

    function entryPath(entry) {
        if (entry.kind === 'content') {
            return `${entry.collection.title || 'Collection'} / ${entry.path || entry.content.filename}`;
        }
        if (entry.kind === 'reference') return entry.item.absolute_path || entry.path || '—';
        return entry.item.absolute_path || '—';
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
        const individual = (Array.isArray(rawTags) ? rawTags : []).map(tag => tag?.name || tag).filter(Boolean);
        const relational = entry.kind === 'reference'
            ? (entry.reference?.tags || entry.reference?.attributes?.tags || [])
            : [];
        return [...new Set([...individual, ...relational])];
    }

    function entryRecord(entry) {
        return entry.kind === 'content' ? entry.content : entry.item;
    }

    function entryMetadata(entry) {
        const record = entryRecord(entry) || {};
        const attributes = record.attributes || {};
        return {
            ...((attributes.analysis && typeof attributes.analysis === 'object') ? attributes.analysis : {}),
            ...((attributes.audio_metadata && typeof attributes.audio_metadata === 'object') ? attributes.audio_metadata : {}),
            ...((record.audio_metadata && typeof record.audio_metadata === 'object') ? record.audio_metadata : {}),
        };
    }

    function firstEntryValue(entry, ...keys) {
        const record = entryRecord(entry) || {};
        const metadata = entryMetadata(entry);
        for (const key of keys) {
            const value = record[key] ?? metadata[key];
            if (value !== null && value !== undefined && value !== '') return value;
        }
        return '';
    }

    function formatDuration(value) {
        if (value === null || value === undefined || value === '') return '';
        const seconds = Number(value);
        if (!Number.isFinite(seconds) || seconds < 0) return String(value || '');
        const rounded = Math.round(seconds);
        const hours = Math.floor(rounded / 3600);
        const minutes = Math.floor((rounded % 3600) / 60);
        const remaining = rounded % 60;
        return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`
            : `${minutes}:${String(remaining).padStart(2, '0')}`;
    }

    function entryColumnValue(entry, field) {
        const record = entryRecord(entry) || {};
        switch (field) {
            case 'favourite': {
                const attributes = record.attributes || {};
                return Boolean(record.favourite ?? attributes.favourite ?? false);
            }
            case 'name': return entry.title || '';
            case 'filename': return record.filename || filename(entryAbsolutePath(entry));
            case 'path': return entryPath(entry);
            case 'type': {
                const profileId = record.attributes?.profile_id || entry.reference?.attributes?.profile_id || entry.content?.attributes?.profile_id;
                const label = record.attributes?.profile_label || entry.reference?.attributes?.profile_label || entry.content?.attributes?.profile_label;
                if (entry.type === 'project' || record.type === 'project') {
                    const kind = record.project_kind || 'audio';
                    const engine = record.editor_engine || (kind === 'video' ? 'simple_media' : 'sin');
                    if (kind === 'video') return 'Project · Video';
                    return engine === 'simple_media' ? 'Project · Audio (Simple)' : 'Project · Audio (SIN)';
                }
                if (entry.type === 'multitrack') return typeLabel('multitrack');
                if (entry.type === 'zoom_h4') return label || typeLabel('zoom_h4');
                if (profileId === 'sample_pack' || isSamplePackCollection(record)) return label || 'Sample pack';
                if (label) return label;
                if (record.attributes?.is_folder || entry.type === 'collection' || entry.type === 'folder') return 'Folder';
                return typeLabel(entry.type);
            }
            case 'author': return firstEntryValue(entry, 'author', 'artist', 'album_artist');
            case 'album': return firstEntryValue(entry, 'album');
            case 'album_artist': return firstEntryValue(entry, 'album_artist');
            case 'release_year': return firstEntryValue(entry, 'release_year', 'year', 'date');
            case 'genre': return firstEntryValue(entry, 'genre');
            case 'track_number': return firstEntryValue(entry, 'track_number', 'track');
            case 'disc_number': return firstEntryValue(entry, 'disc_number', 'disc');
            case 'comment': return firstEntryValue(entry, 'comment', 'description');
            case 'duration': return formatDuration(firstEntryValue(entry, 'duration_seconds', 'duration'));
            case 'bpm': return entryBpm(entry) ?? '';
            case 'key': return entryKey(entry) ?? '';
            case 'loop': {
                const value = firstEntryValue(entry, 'is_loop', 'loop');
                return value === true || value === 1 || value === 'true' ? 'Yes' : value === false || value === 0 || value === 'false' ? 'No' : value;
            }
            case 'tags': return entryTags(entry).join(', ');
            case 'size': {
                const size = entrySize(entry);
                return size !== null && size !== undefined && size !== '' && Number.isFinite(Number(size)) ? formatSize(size) : '';
            }
            case 'mime_type': return firstEntryValue(entry, 'mime_type', 'mime');
            case 'source': return record.source_path || entryAbsolutePath(entry) || '';
            case 'modified': return firstEntryValue(entry, 'updated_at', 'modified_at', 'created_at');
            case 'id': return record.id || record.child_id || '';
            default: return '';
        }
    }

    function entryReferenceLabel(entry) {
        if (entry.kind !== 'reference') return null;
        return entry.reference?.revision_label
            || entry.reference?.attributes?.label
            || entry.reference?.attributes?.stage
            || entry.item?.attributes?.cut_label
            || entry.item?.attributes?.revision_label
            || (entry.item?.attributes?.stage === 'cut' ? 'CUT' : null)
            || null;
    }

    function numericItemId(entry) {
        if (!entry) return null;
        if (entry.numericId !== undefined) return entry.numericId;
        const id = entry.itemId ?? (entry.kind === 'content' ? (entry.content?.child_id || entry.item?.id) : entry.item?.id);
        return id && Number.isFinite(Number(id)) ? Number(id) : null;
    }

    function entryFolderItemId(entry) {
        if (!entry) return null;
        if (entry.kind === 'subfolder' && entry.numericId !== undefined) return entry.numericId;
        const raw = entry.itemId ?? entry.item?.id ?? entry.content?.child_id ?? entry.folderItem?.child_id ?? entry.folderItem?.id ?? entry.folderItem?.item?.id ?? entry.collection?.id;
        return raw && Number.isFinite(Number(raw)) ? Number(raw) : null;
    }

    function entryNumericId(entry) {
        if (!entry) return null;
        if (entry.numericId !== undefined) return entry.numericId;
        const raw = entry.kind === 'subfolder' ? entryFolderItemId(entry) : (numericItemId(entry) || Number(entry.collection?.id) || null);
        return raw && Number.isFinite(Number(raw)) ? Number(raw) : null;
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
        if (!entry) return '';
        if (entry.streamPath) return entry.streamPath;
        const id = numericItemId(entry) || entry.itemId || entry.content?.child_id;
        if (id) return `/items/${id}/stream`;
        if (entry.kind === 'content' && entry.collection?.id != null && entry.content?.index != null) {
            return `/items/${entry.collection.id}/contents/${entry.content.index}/stream`;
        }
        if (entry.item?.id) return `/items/${entry.item.id}/stream`;
        return '';
    }

    function canPreview(entry) {
        const item = entry.kind === 'content' ? entry.content : entry.item;
        if ((item?.availability || 'ready') !== 'ready') return false;
        if (entry.kind === 'content') return Boolean(entry.content.streamable);
        return ['audio', 'track', 'sample', 'video', 'multitrack', 'zoom_h4'].includes(entry.type);
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
        const targetId = entry.item?.id || entry.itemId || entry.content?.child_id || entry.collection?.id;
        if (!targetId) return;
        if (window.gaiaMediaEditor?.requestTarget?.(entry)) return;
        if (window.gaiaTransport?.requestPlay?.(entry)) return;
        try {
            const response = await fetch(`/items/${targetId}/preview`);
            const result = await response.json().catch(() => ({}));
            if (!response.ok || !result?.id) return;
            const previewEntry = itemEntry(result, `preview:${entry.id}:${result.id}`);
            if (canPreview(previewEntry)) play(previewEntry);
        } catch (error) {
            console.warn('Could not resolve the item preview', error);
        }
    }

    function stopPlayback() {
        state.playingKey = null;
        if (window.gaiaAudioPreview) {
            window.gaiaAudioPreview.stop();
            return;
        }
        window.dispatchEvent(new CustomEvent('gaia:stop'));
    }

    function play(entry, { toggleIfSame = true } = {}) {
        if (window.gaiaTransport?.requestPlay?.(entry)) return;
        const key = entry.id;
        if (window.gaiaAudioPreview) {
            state.playingKey = key;
            const itemId = numericItemId(entry) || entry.itemId || entry.item?.id || entry.content?.child_id || null;
            void window.gaiaAudioPreview.play(entry, {
                streamUrl: streamUrl(entry),
                itemId,
                toggleIfSame,
            });
        }
    }

    function canEdit(entry, field) {
        if (!entry) return false;
        if (field === 'tags') return true;
        if (field === 'title') return true;
        const type = entry.type || entry.item?.type || '';
        if (field === 'type') {
            return Boolean(switchableTypeOptions(entry));
        }
        if (field === 'bpm' || field === 'key') {
            return ['audio', 'sample', 'midi', 'multitrack', 'zoom_h4'].includes(type);
        }
        if (['author', 'album', 'album_artist', 'release_year', 'genre', 'track_number', 'disc_number', 'comment'].includes(field)) {
            return ['audio', 'sample', 'track'].includes(type);
        }
        return false;
    }

    function entryValue(entry, field) {
        if (field === 'title') return entry.title;
        if (field === 'type') return effectiveEntryType(entry);
        if (field === 'bpm') return entryBpm(entry);
        if (field === 'key') return entryKey(entry);
        if (field === 'tags') {
            if (entry.reference) {
                return (entry.reference?.tags || entry.reference?.attributes?.tags || entryTags(entry) || []).join(', ');
            }
            return entryTags(entry).join(', ');
        }
        return firstEntryValue(entry, field);
    }

    function updateEntryInState(entry, result) {
        const itemId = Number(result.id || (entry.kind === 'subfolder' ? entryFolderItemId(entry) : numericItemId(entry)) || entry.itemId || entry.item?.id || entry.content?.child_id);
        const normalizedResult = {
            ...result,
            ...(result.attributes && typeof result.attributes === 'object' ? { attributes: { ...result.attributes } } : {}),
        };
        if (entry.title && normalizedResult.title) entry.title = normalizedResult.title;
        if (normalizedResult.type) entry.type = normalizedResult.type;
        if (entry.item) Object.assign(entry.item, normalizedResult);
        if (entry.content) Object.assign(entry.content, normalizedResult);
        if (entry.folderItem) {
            Object.assign(entry.folderItem, normalizedResult);
            if (entry.folderItem.item) Object.assign(entry.folderItem.item, normalizedResult);
            if (entry.folderItem.content) Object.assign(entry.folderItem.content, normalizedResult);
        }

        if (Number.isFinite(itemId)) {
            catalogStore.patchItemLocal(itemId, normalizedResult);
            const index = state.items.findIndex(item => Number(item.id) === itemId);
            if (index >= 0) state.items[index] = { ...state.items[index], ...normalizedResult };
        }

        state.projectReferencedItems.forEach(records => {
            records.forEach(record => {
                if (Number(record.item?.id) === itemId) record.item = { ...record.item, ...normalizedResult };
                (record.versions || []).forEach(version => {
                    if (Number(version.item?.id) === itemId) version.item = { ...version.item, ...normalizedResult };
                });
            });
        });

        if (state.subfolderEntries) {
            state.subfolderEntries.forEach(sub => {
                if (Number(entryFolderItemId(sub)) === itemId) {
                    if (normalizedResult.title) {
                        sub.title = normalizedResult.title;
                        sub.name = normalizedResult.title;
                        if (sub.subfolder) sub.subfolder.name = normalizedResult.title;
                    }
                    if (normalizedResult.type) sub.type = normalizedResult.type;
                    if (sub.item) Object.assign(sub.item, normalizedResult);
                    if (sub.content) Object.assign(sub.content, normalizedResult);
                }
            });
        }
    }

    function apiErrorMessage(result, fallback) {
        const detail = result?.detail;
        if (typeof detail === 'string' && detail.trim()) return detail;
        if (Array.isArray(detail)) {
            const messages = detail
                .map(issue => issue?.msg || issue?.message)
                .filter(Boolean);
            if (messages.length) return messages.join('\n');
        }
        if (detail && typeof detail === 'object') {
            return detail.message || detail.msg || fallback;
        }
        return fallback;
    }

    async function saveMetadata(entry, field, rawValue) {
        let value = rawValue;
        if (field === 'tags') value = String(rawValue).split(',').map(tag => tag.trim()).filter(Boolean);
        if (field === 'bpm') value = rawValue === '' ? null : Number(rawValue);
        if (['release_year', 'track_number', 'disc_number'].includes(field)) {
            value = rawValue === '' ? null : Number(rawValue);
        }
        if (entry.reference && field === 'tags' && entry.collection?.id) {
            const response = await fetch(`/projects/${entry.collection.id}/references/${entry.reference.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tags: value }),
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(apiErrorMessage(result, 'Could not update relationship tags'));
            const records = state.projectReferencedItems.get(Number(entry.collection.id)) || [];
            records.forEach(record => {
                if (Number(record.reference.id) === Number(entry.reference.id)) record.reference = result;
                (record.versions || []).forEach(version => {
                    if (Number(version.reference?.id) === Number(entry.reference.id)) version.reference = result;
                });
            });
            renderFilterUI();
            renderAssets();
            return;
        }
        if (field === 'title' && (typeIsProject(entry.type) || entry.type === 'project')) stopPlayback();

        const itemId = entry.kind === 'subfolder'
            ? entryFolderItemId(entry)
            : (numericItemId(entry) || entry.itemId || entry.item?.id || entry.content?.child_id);
        let url;
        if (itemId) {
            url = `/items/${itemId}`;
        } else if (entry.collection?.id && entry.content?.index !== undefined) {
            url = `/items/${entry.collection.id}/contents/${entry.content.index}`;
        } else {
            throw new Error('This entry cannot be updated directly.');
        }

        const response = await fetch(url, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ [field]: value }),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(apiErrorMessage(result, 'Could not update metadata'));
        updateEntryInState(entry, result);
        if (field === 'type') {
            await catalogStore.sync({ forceSnapshot: false }).catch(() => { });
            state.items = catalogStore.getScopedRoots({
                vaultId: state.selectedVaultId,
                playlistId: state.selectedPlaylistId,
                previewMode: 'quick',
            });
            state.catalogItems = state.items;
        }
        invalidateFacetCache();
        reconcileFilterSelection();
        renderFilterUI();
        renderAssets();
        if (field === 'type') {
            if (state.selectedEntryIds.has(entry.id)) {
                const refreshed = entryById(entry.id) || entry;
                window.dispatchEvent(new CustomEvent('gaia:selection', {
                    detail: {
                        entry: refreshed,
                        playable: Boolean(refreshed && (canPreview(refreshed) || refreshed.isContainer || typeIsContainer(refreshed.type) || refreshed.type === 'collection')),
                    },
                }));
            }
            if (window.gaiaEditorHost?.isOpen?.()) {
                window.gaiaEditorHost.refresh?.();
            }
        }
    }

    function formatSinProposalValue(proposal) {
        if (proposal.field === 'favourite') return proposal.proposed_value ? 'Favourite' : 'Not favourite';
        if (proposal.field === 'bpm') return `${proposal.proposed_value} BPM`;
        return String(proposal.proposed_value || 'Clear key');
    }

    function renderSinProposals(proposals) {
        if (!sinProposalsContent) return;
        if (!proposals.length) {
            sinProposalsContent.innerHTML = '<div class="sin-proposals-empty">No pending metadata proposals from SIN.</div>';
            return;
        }
        sinProposalsContent.innerHTML = proposals.map(proposal => `
            <article class="sin-proposal-row">
                <div class="sin-proposal-copy">
                    <strong>${escapeHtml(filename(proposal.absolute_path))} · ${escapeHtml(proposal.field)}</strong>
                    <span class="sin-proposal-value">${escapeHtml(formatSinProposalValue(proposal))}</span>
                    <small title="${escapeHtml(proposal.absolute_path)}">${escapeHtml(proposal.absolute_path)}</small>
                </div>
                <div class="sin-proposal-actions">
                    <button class="secondary" type="button" data-sin-proposal-action="reject" data-sin-proposal-id="${proposal.id}">Reject</button>
                    <button class="primary" type="button" data-sin-proposal-action="accept" data-sin-proposal-id="${proposal.id}">Accept</button>
                </div>
            </article>
        `).join('');
    }

    async function loadSinProposals() {
        if (!sinProposalsContent) return;
        sinProposalsContent.innerHTML = '<div class="sin-proposals-empty">Loading staged proposals…</div>';
        const response = await fetch('/sin-proposals/?status=pending');
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.detail || 'Could not load SIN proposals');
        renderSinProposals(Array.isArray(result) ? result : []);
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

    let activeTypeSwitcher = null;

    function closeTypeSwitcherMenu({ restoreFocus = false } = {}) {
        if (!activeTypeSwitcher) return;
        const { menu, trigger, cleanup } = activeTypeSwitcher;
        activeTypeSwitcher = null;
        cleanup();
        menu.remove();
        if (trigger?.isConnected) {
            trigger.setAttribute('aria-expanded', 'false');
            trigger.classList.remove('is-open');
            if (restoreFocus) trigger.focus({ preventScroll: true });
        }
    }

    function openTypeSwitcherMenu(trigger, entry) {
        const options = switchableTypeOptions(entry);
        if (!options || !trigger) return;

        if (activeTypeSwitcher && activeTypeSwitcher.trigger === trigger) {
            closeTypeSwitcherMenu();
            return;
        }
        closeTypeSwitcherMenu();
        closeContextMenu();
        closeColumnMenu();

        const currentType = effectiveEntryType(entry);
        const menu = document.createElement('div');
        menu.className = 'type-switcher-menu sin-menu-surface';
        menu.setAttribute('role', 'listbox');
        menu.setAttribute('aria-label', 'Switch item type');

        const buttons = [];
        options.forEach(opt => {
            const isSelected = opt.value === currentType;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = `type-switcher-option sin-menu-item${isSelected ? ' is-selected' : ''}`;
            btn.setAttribute('role', 'option');
            btn.setAttribute('aria-selected', String(isSelected));
            btn.dataset.typeValue = opt.value;
            btn.innerHTML = `
                <span class="type-switcher-check" aria-hidden="true">${isSelected ? '✓' : ''}</span>
                <span class="type-switcher-copy">
                    <span class="type-switcher-label">${escapeHtml(opt.label)}</span>
                    ${opt.hint ? `<span class="type-switcher-hint">${escapeHtml(opt.hint)}</span>` : ''}
                </span>
            `;
            btn.addEventListener('pointerdown', e => e.stopPropagation());
            btn.addEventListener('click', async e => {
                e.preventDefault();
                e.stopPropagation();
                closeTypeSwitcherMenu();
                if (opt.value === currentType) return;
                if (trigger.isConnected) {
                    trigger.classList.add('is-switching');
                    trigger.disabled = true;
                }
                try {
                    await saveMetadata(entry, 'type', opt.value);
                } catch (error) {
                    window.alert(error.message || 'Could not switch type');
                    renderAssets();
                } finally {
                    if (trigger.isConnected) {
                        trigger.classList.remove('is-switching');
                        trigger.disabled = false;
                    }
                }
            });
            menu.appendChild(btn);
            buttons.push(btn);
        });

        document.body.appendChild(menu);
        trigger.setAttribute('aria-expanded', 'true');
        trigger.classList.add('is-open');

        const rect = trigger.getBoundingClientRect();
        const menuWidth = Math.max(196, menu.offsetWidth || 196);
        const menuHeight = menu.offsetHeight || 140;
        const spaceBelow = window.innerHeight - rect.bottom - 8;
        const spaceAbove = rect.top - 8;
        const openUp = spaceBelow < menuHeight && spaceAbove > spaceBelow;
        const left = Math.max(8, Math.min(rect.left, window.innerWidth - menuWidth - 8));
        const top = openUp
            ? Math.max(8, rect.top - menuHeight - 4)
            : Math.min(window.innerHeight - menuHeight - 8, rect.bottom + 4);
        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;

        let highlighted = Math.max(0, buttons.findIndex(b => b.classList.contains('is-selected')));
        const applyHighlight = nextIdx => {
            buttons.forEach(b => b.classList.remove('is-highlighted'));
            if (nextIdx >= 0 && nextIdx < buttons.length) {
                highlighted = nextIdx;
                buttons[highlighted].classList.add('is-highlighted');
                buttons[highlighted].focus({ preventScroll: true });
            }
        };
        applyHighlight(highlighted);

        const onPointerDown = event => {
            if (!menu.contains(event.target) && !trigger.contains(event.target)) {
                closeTypeSwitcherMenu();
            }
        };
        const onKeyDown = event => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                closeTypeSwitcherMenu({ restoreFocus: true });
            } else if (event.key === 'ArrowDown') {
                event.preventDefault();
                applyHighlight((highlighted + 1) % buttons.length);
            } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                applyHighlight((highlighted - 1 + buttons.length) % buttons.length);
            } else if (event.key === 'Home') {
                event.preventDefault();
                applyHighlight(0);
            } else if (event.key === 'End') {
                event.preventDefault();
                applyHighlight(buttons.length - 1);
            } else if (event.key === 'Enter' || event.key === ' ') {
                if (highlighted >= 0 && buttons[highlighted]) {
                    event.preventDefault();
                    buttons[highlighted].click();
                }
            }
        };
        const onViewportMove = () => closeTypeSwitcherMenu();

        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown, true);
        window.addEventListener('resize', onViewportMove);
        assetList?.addEventListener('scroll', onViewportMove, { passive: true });

        activeTypeSwitcher = {
            menu,
            trigger,
            cleanup() {
                document.removeEventListener('pointerdown', onPointerDown, true);
                document.removeEventListener('keydown', onKeyDown, true);
                window.removeEventListener('resize', onViewportMove);
                assetList?.removeEventListener('scroll', onViewportMove);
            },
        };
    }

    function beginCellEdit(cell, entry, field) {
        if (!canEdit(entry, field) || cell.querySelector('input, select')) return;
        if (field === 'type') {
            openTypeSwitcherMenu(cell, entry);
            return;
        }
        const initial = entryValue(entry, field) ?? '';
        const editor = document.createElement('input');
        editor.className = 'cell-editor';
        const editorWidth = Math.max(72, Math.ceil(cell.getBoundingClientRect().width));
        editor.style.width = `${editorWidth}px`;
        const numericField = ['bpm', 'release_year', 'track_number', 'disc_number'].includes(field);
        editor.type = numericField ? 'number' : 'text';
        if (field === 'bpm') {
            editor.min = '20';
            editor.max = '400';
        } else if (field === 'release_year') {
            editor.min = '1';
            editor.max = '9999';
        } else if (field === 'track_number' || field === 'disc_number') {
            editor.min = '1';
        }
        editor.value = initial;
        cell.textContent = '';
        cell.appendChild(editor);
        rowEditing(editor, entry, field, initial);
        editor.focus();
        if (editor.select) editor.select();
    }

    function editableCell(entry, field, className, displayValue) {
        const editable = canEdit(entry, field);
        const value = displayValue === null || displayValue === undefined ? '' : displayValue;
        const isEmpty = editable && String(value).trim() === '';
        const emptyMarker = isEmpty ? '<span class="editable-cell-empty-marker" aria-hidden="true">-</span>' : '';
        return `<span class="${className}${editable ? ' editable-cell' : ''}${isEmpty ? ' is-empty' : ''}" data-field="${field}"${editable ? ' title="Double-click to edit"' : ''}>${isEmpty ? emptyMarker : escapeHtml(value)}</span>`;
    }

    function toggleCollectionExpansion(entry) {
        const id = entry.id;
        const itemId = entry.item?.id ? String(entry.item.id) : (entry.content?.child_id ? String(entry.content.child_id) : null);
        const targetId = entry.item?.id || (entry.content?.child_id ? Number(entry.content.child_id) : null);
        if (state.expandedCollections.has(id) || (itemId && state.expandedCollections.has(itemId))) {
            state.expandedCollections.delete(id);
            if (itemId) state.expandedCollections.delete(itemId);
        } else {
            state.expandedCollections.add(id);
            if (itemId) state.expandedCollections.add(itemId);
            if (targetId && typeIsProject(entry.type)) {
                loadProjectReferencedItems(targetId);
            }
        }
        renderAssets();
    }

    function getCollectionIcon(entry) {
        const type = entry?.type || entry?.item?.type || '';
        const record = entry?.item || entry?.content || entry;
        const sourceKind = entry?.item?.source_kind || entry?.content?.source_kind || '';
        if (type === 'multitrack' || type === 'zoom_h4') {
            const title = type === 'zoom_h4' ? 'Zoom H4' : 'Multitrack';
            return `<span class="collection-title-icon multitrack" aria-hidden="true" title="${title}"><svg viewBox="0 0 16 16"><line x1="2" y1="4.5" x2="14" y2="4.5"/><line x1="2" y1="8" x2="14" y2="8"/><line x1="2" y1="11.5" x2="14" y2="11.5"/><circle cx="5" cy="4.5" r="1.5" fill="currentColor"/><circle cx="11" cy="8" r="1.5" fill="currentColor"/><circle cx="7" cy="11.5" r="1.5" fill="currentColor"/></svg></span>`;
        }
        if (type === 'project' || typeIsProject(type)) {
            return '<span class="collection-title-icon project" aria-hidden="true" title="Project"><svg viewBox="0 0 16 16"><rect x="2" y="5" width="12" height="8.5" rx="1.5"/><path d="M5.5 5V3.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V5M2 8.5h12"/></svg></span>';
        }
        if (isSamplePackCollection(record)) {
            return '<span class="collection-title-icon sample-pack" aria-hidden="true" title="Sample pack"><svg viewBox="0 0 16 16"><rect x="2" y="4" width="12" height="9.5" rx="1.2"/><path d="M4 4V2.5h8V4"/><line x1="5" y1="8.75" x2="11" y2="8.75"/><line x1="8" y1="6.25" x2="8" y2="11.25"/></svg></span>';
        }
        if (sourceKind === 'zip') {
            return '<span class="collection-title-icon archive" aria-hidden="true" title="Archive"><svg viewBox="0 0 16 16"><path d="M2.5 3.5h11v9.5h-11z"/><line x1="8" y1="3.5" x2="8" y2="13"/><line x1="6.5" y1="5.5" x2="9.5" y2="5.5"/><line x1="6.5" y1="7.5" x2="9.5" y2="7.5"/><line x1="6.5" y1="9.5" x2="9.5" y2="9.5"/></svg></span>';
        }
        return '<span class="collection-title-icon folder" aria-hidden="true" title="Folder"><svg viewBox="0 0 16 16"><path d="M1.5 3.5h4l1.5 2h7.5v7h-13z"/></svg></span>';
    }

    function createRow(entry, { nested = false, subfolderDepth = 0, isSubfolder = false, subfolderKey = null } = {}) {
        const row = document.createElement('div');
        const availability = (entry.kind === 'content' ? entry.content?.availability : entry.item?.availability) || 'ready';
        const isExternalReference = isEntryExternalReference(entry);
        row.className = `asset-row${state.selectedEntryIds.has(entry.id) ? ' selected' : ''}${isExternalReference ? ' referenced-row' : ''}${availability !== 'ready' ? ' unavailable-row' : ''}`;
        if (isSubfolder) row.classList.add('is-subfolder-row');
        const layout = rowLayoutFor(entry, { nested });
        row.classList.add(nested ? 'nested-row' : 'main-row', `row-layout-${layout.id}`);
        row.style.setProperty('--row-columns', layout.columns);
        if (layout.id === 'main') row.style.setProperty('--main-table-width', `${mainColumnMinimumWidth()}px`);
        row.setAttribute('role', 'listitem');
        row.dataset.entryId = entry.id;
        row.setAttribute('aria-selected', String(state.selectedEntryIds.has(entry.id)));
        row.draggable = Boolean(numericItemId(entry)) && availability === 'ready';
        const isCollection = Boolean(
            (entry.kind === 'asset' && typeIsContainer(entry.type))
            || entry.type === 'collection'
            || entry.type === 'folder'
            || typeIsContainer(entry.type)
            || entry.item?.attributes?.is_folder
            || entry.content?.attributes?.is_folder
            || entry.kind === 'subfolder'
            || isSubfolder
        );
        if (isCollection) row.title = 'Click the title to preview · double-click to show contents';
        if (isExternalReference) {
            row.title = entry.kind === 'reference'
                ? 'External linked file · points to file outside this project'
                : 'External referenced item (italic) · Select "Collect into vault" to copy into the vault folder';
        } else if (entry.kind === 'reference') {
            row.title = 'Linked file · edit its project tags in the Tags column';
        }
        if (availability !== 'ready') row.title = `Asset ${availability}; playback and project use are unavailable`;

        const referenceLabel = entryReferenceLabel(entry);
        const fileVersionSelector = entry.fileVersions?.length > 1
            ? `<select class="file-version-selector" title="Select file version" aria-label="Select file version">${entry.fileVersions.map(version => `<option value="${escapeHtml(version.id)}" ${String(version.id) === String(numericItemId(entry) || `${entry.collection?.id || 'root'}:${entry.content?.index || ''}`) ? 'selected' : ''}>${escapeHtml(version.label)}</option>`).join('')}</select>`
            : '';
        const isExpandable = isCollection;
        const resolvedSubfolderKey = subfolderKey || (isSubfolder ? `${entry.collection?.id}:${entry.path || entry.fullPath}` : null);
        const isExpanded = isExpandable && (
            resolvedSubfolderKey
                ? state.expandedSubfolders.has(resolvedSubfolderKey)
                : (state.expandedCollections.has(entry.id) || (entry.item?.id && state.expandedCollections.has(String(entry.item.id))))
        );
        const expandToggle = isExpandable
            ? `<button class="item-expand-toggle-btn" type="button" title="${isExpanded ? 'Collapse contents' : 'Expand contents'}" aria-label="${isExpanded ? 'Collapse contents' : 'Expand contents'}" aria-expanded="${isExpanded}">${isExpanded ? '▾' : '▸'}</button>`
            : '';
        const folderIcon = isCollection ? getCollectionIcon(entry) : '';
        const countVal = entry.contentCount ?? entry.item?.content_count ?? entry.content?.content_count;
        const countBadge = (isCollection && countVal !== undefined && countVal !== null)
            ? `<span class="collection-title-count">(${countVal})</span>`
            : '';
        const titleEditable = canEdit(entry, 'title');
        const titleIsEmpty = titleEditable && String(entry.title || '').trim() === '';
        const titleText = titleIsEmpty
            ? '<span class="editable-cell-empty-marker" aria-hidden="true">-</span>'
            : escapeHtml(entry.title);
        const titleIndent = subfolderDepth > 0 ? ` style="padding-left: ${subfolderDepth * 16}px;"` : '';
        const titleCell = `<div class="asset-title"${titleIndent}>
            ${expandToggle}
            ${folderIcon}
            <span class="asset-title-text${titleEditable ? ' editable-cell' : ''}${titleIsEmpty ? ' is-empty' : ''}" data-field="title"${titleEditable ? ' title="Click to preview · double-click to edit"' : ''}>${titleText}</span>
            ${countBadge}
            ${fileVersionSelector}
            ${referenceLabel ? `<button class="reference-label" type="button" title="Double-click to edit relationship label">${escapeHtml(referenceLabel)}</button>` : ''}
            ${entry.kind === 'reference' && !fileVersionSelector && entry.versions?.length > 1 ? `<select class="reference-version-selector" title="Select file revision" aria-label="Select file revision">${entry.versions.map(version => `<option value="${escapeHtml(String(version.item.id))}" ${Number(version.item.id) === Number(entry.item.id) ? 'selected' : ''}>${escapeHtml(version.label)}</option>`).join('')}</select>` : ''}
        </div>`;
        const displayType = entryColumnValue(entry, 'type');
        const effectiveType = effectiveEntryType(entry);
        const typeSwitchable = canEdit(entry, 'type');
        const typeCell = typeSwitchable
            ? `<button type="button" class="type-badge type-badge--${escapeHtml(effectiveType)} editable-cell type-switchable" data-field="type" aria-haspopup="listbox" aria-expanded="false" title="Click to switch type"><span class="type-badge-label">${escapeHtml(displayType)}</span><span class="type-badge-caret" aria-hidden="true">▾</span></button>`
            : `<span class="type-badge type-badge--${escapeHtml(effectiveType)}" data-field="type">${escapeHtml(displayType)}</span>`;
        const isFav = Boolean(entryColumnValue(entry, 'favourite'));
        const favCell = (isSubfolder && !entry.itemId)
            ? '<span></span>'
            : `<button class="favourite-toggle-btn${isFav ? ' active' : ''}" type="button" data-field="favourite" title="${isFav ? 'Remove from favourites' : 'Add to favourites'}" aria-label="Favourite">${isFav ? '★' : '☆'}</button>`;
        const cells = {
            favourite: favCell,
            name: titleCell,
            filename: `<span class="metadata-text">${escapeHtml(entryColumnValue(entry, 'filename'))}</span>`,
            path: `<span class="path-text">${escapeHtml(entryPath(entry))}</span>`,
            type: typeCell,
            author: editableCell(entry, 'author', 'metadata-text', entryColumnValue(entry, 'author')),
            album: editableCell(entry, 'album', 'metadata-text', entryColumnValue(entry, 'album')),
            album_artist: editableCell(entry, 'album_artist', 'metadata-text', entryColumnValue(entry, 'album_artist')),
            release_year: editableCell(entry, 'release_year', 'metadata-text', entryColumnValue(entry, 'release_year')),
            genre: editableCell(entry, 'genre', 'metadata-text', entryColumnValue(entry, 'genre')),
            track_number: editableCell(entry, 'track_number', 'metadata-text', entryColumnValue(entry, 'track_number')),
            disc_number: editableCell(entry, 'disc_number', 'metadata-text', entryColumnValue(entry, 'disc_number')),
            comment: editableCell(entry, 'comment', 'metadata-text', entryColumnValue(entry, 'comment')),
            duration: `<span class="metadata-text">${escapeHtml(entryColumnValue(entry, 'duration'))}</span>`,
            bpm: editableCell(entry, 'bpm', 'metadata-text', entryBpm(entry)),
            key: editableCell(entry, 'key', 'metadata-text', entryKey(entry)),
            loop: `<span class="metadata-text">${escapeHtml(entryColumnValue(entry, 'loop'))}</span>`,
            tags: editableCell(entry, 'tags', 'tags-text', entryTags(entry).join(', ')),
            size: `<span class="size-text">${escapeHtml(entryColumnValue(entry, 'size'))}</span>`,
            mime_type: `<span class="metadata-text">${escapeHtml(entryColumnValue(entry, 'mime_type'))}</span>`,
            source: `<span class="path-text">${escapeHtml(entryColumnValue(entry, 'source'))}</span>`,
            modified: `<span class="metadata-text">${escapeHtml(entryColumnValue(entry, 'modified'))}</span>`,
            id: `<span class="metadata-text">${escapeHtml(entryColumnValue(entry, 'id'))}</span>`,
        };
        row.innerHTML = layout.fields.map(field => cells[field] || '<span></span>').join('');

        if (resolvedSubfolderKey) {
            row.dataset.subfolderKey = resolvedSubfolderKey;
        }
        return row;
    }

    function previewEntry(entry, { toggleIfSame = true } = {}) {
        if (!entry) return;
        selectEntry(entry, { ctrlKey: false, metaKey: false, shiftKey: false });
        if (entry.isContainer || typeIsContainer(entry.type) || entry.type === 'collection') {
            previewContainer(entry);
        } else if (canPreview(entry)) {
            play(entry, { toggleIfSame });
        }
        refreshSelectionPresentation();
    }

    function initAssetListDelegation() {
        if (!assetList || assetList.dataset.delegationInitialized) return;
        assetList.dataset.delegationInitialized = 'true';

        assetList.addEventListener('pointerdown', () => {
            window.gaiaAudioPreview?.warmUp?.();
        }, { once: true, passive: true });

        assetList.addEventListener('click', async event => {
            const favBtn = event.target.closest('.favourite-toggle-btn');
            if (favBtn) {
                event.stopPropagation();
                event.preventDefault();
                const row = favBtn.closest('.asset-row');
                const entry = row ? entryById(row.dataset.entryId) : null;
                if (!entry) return;
                const currentFav = Boolean(entryColumnValue(entry, 'favourite'));
                try {
                    await saveMetadata(entry, 'favourite', !currentFav);
                } catch (err) {
                    console.error('Failed to toggle favourite', err);
                    window.alert(err.message || 'Failed to update favourite');
                }
                return;
            }

            const expandBtn = event.target.closest('.item-expand-toggle-btn');
            if (expandBtn) {
                event.stopPropagation();
                event.preventDefault();
                const row = expandBtn.closest('.asset-row');
                const entry = row ? entryById(row.dataset.entryId) : null;
                if (!entry) return;
                const subfolderKey = row.dataset.subfolderKey;
                if (subfolderKey) {
                    const folderItemId = entryFolderItemId(entry);
                    if (state.expandedSubfolders.has(subfolderKey)) {
                        state.expandedSubfolders.delete(subfolderKey);
                        if (folderItemId) state.expandedCollections.delete(String(folderItemId));
                    } else {
                        state.expandedSubfolders.add(subfolderKey);
                        if (folderItemId) state.expandedCollections.add(String(folderItemId));
                    }
                    renderAssets();
                } else {
                    toggleCollectionExpansion(entry);
                }
                return;
            }

            const titleText = event.target.closest('.asset-title-text');
            if (titleText) {
                const row = titleText.closest('.asset-row');
                const entry = row ? entryById(row.dataset.entryId) : null;
                if (entry && event.detail === 1) {
                    event.stopPropagation();
                    // Instant zero-delay preview (< 5ms via native libsin_dsp / Web Audio LRU)
                    previewEntry(entry);
                }
                return;
            }

            const typeTrigger = event.target.closest('.type-badge.type-switchable');
            if (typeTrigger) {
                event.stopPropagation();
                event.preventDefault();
                const row = typeTrigger.closest('.asset-row');
                const entry = row ? entryById(row.dataset.entryId) : null;
                if (entry) openTypeSwitcherMenu(typeTrigger, entry);
                return;
            }

            if (event.target.closest('.editable-cell, .reference-label, input, select, button')) return;

            const row = event.target.closest('.asset-row');
            if (!row) return;
            if (event.ctrlKey || event.metaKey || event.shiftKey) return;
            const entry = entryById(row.dataset.entryId);
            if (entry) {
                selectEntry(entry, event);
                refreshSelectionPresentation();
            }
        });

        assetList.addEventListener('mousedown', event => {
            const row = event.target.closest('.asset-row');
            if (!row) return;
            if (event.target.closest('.editable-cell, .reference-label, input, select, button')) return;
            if (event.ctrlKey || event.metaKey || event.shiftKey) {
                const entry = entryById(row.dataset.entryId);
                if (entry) {
                    selectEntry(entry, event);
                    event.preventDefault();
                    refreshSelectionPresentation();
                }
            }
        });

        assetList.addEventListener('dblclick', event => {
            const titleText = event.target.closest('.asset-title-text');
            if (titleText) {
                event.preventDefault();
                event.stopPropagation();
                stopPlayback();
                const row = titleText.closest('.asset-row');
                const entry = row ? entryById(row.dataset.entryId) : null;
                if (entry && canEdit(entry, 'title')) {
                    beginCellEdit(titleText, entry, 'title');
                }
                return;
            }

            const typeTrigger = event.target.closest('.type-badge.type-switchable');
            if (typeTrigger) {
                event.preventDefault();
                event.stopPropagation();
                return;
            }

            const cell = event.target.closest('.editable-cell');
            if (cell) {
                event.preventDefault();
                event.stopPropagation();
                const row = cell.closest('.asset-row');
                const entry = row ? entryById(row.dataset.entryId) : null;
                if (entry) {
                    beginCellEdit(cell, entry, cell.dataset.field);
                }
                return;
            }

            const refLabel = event.target.closest('.reference-label');
            if (refLabel) {
                event.preventDefault();
                event.stopPropagation();
                const row = refLabel.closest('.asset-row');
                const entry = row ? entryById(row.dataset.entryId) : null;
                if (entry) beginReferenceLabelEdit(refLabel, entry);
                return;
            }

            if (event.target.closest('button, input, select, textarea')) return;

            const row = event.target.closest('.asset-row');
            if (!row) return;
            const entry = entryById(row.dataset.entryId);
            if (!entry) return;

            const subfolderKey = row.dataset.subfolderKey;
            if (subfolderKey) {
                const folderItemId = entryFolderItemId(entry);
                if (state.expandedSubfolders.has(subfolderKey) || (folderItemId && state.expandedCollections.has(String(folderItemId)))) {
                    state.expandedSubfolders.delete(subfolderKey);
                    if (folderItemId) state.expandedCollections.delete(String(folderItemId));
                } else {
                    state.expandedSubfolders.add(subfolderKey);
                    if (folderItemId) state.expandedCollections.add(String(folderItemId));
                }
                renderAssets();
                return;
            }

            if (entry.isContainer || typeIsContainer(entry.type) || entry.type === 'collection') {
                toggleCollectionExpansion(entry);
                return;
            }

            if (event.target.closest('.metadata-text, .tags-text, .path-text, .size-text, .type-badge')) return;
            if (canPreview(entry)) {
                previewEntry(entry);
            }
        });

        assetList.addEventListener('change', event => {
            const fileVer = event.target.closest('.file-version-selector');
            if (fileVer) {
                const row = fileVer.closest('.asset-row');
                const entry = row ? entryById(row.dataset.entryId) : null;
                if (entry?.fileVersionGroup) {
                    state.versionSelections.set(entry.fileVersionGroup, String(fileVer.value));
                    renderFilterUI();
                    renderAssets();
                }
                return;
            }

            const refVer = event.target.closest('.reference-version-selector');
            if (refVer) {
                const row = refVer.closest('.asset-row');
                const entry = row ? entryById(row.dataset.entryId) : null;
                if (entry) {
                    const selected = (entry.versions || []).find(v => Number(v.item.id) === Number(refVer.value));
                    if (selected) {
                        const record = (state.projectReferencedItems.get(Number(entry.collection?.id)) || [])
                            .find(candidate => candidate.version_group === entry.versionGroup);
                        if (record) {
                            record.item = selected.item;
                            record.reference = selected.reference;
                            record.is_external = Boolean(selected.is_external);
                        }
                        if (entry.fileVersionGroup) {
                            state.versionSelections.set(entry.fileVersionGroup, String(selected.item.id));
                        }
                        const projectId = Number(entry.collection?.id);
                        if (projectId) {
                            fetch(`/items/${projectId}/graph/sample-version`, {
                                method: 'PUT',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    channel_id: '',
                                    target_item_id: Number(selected.item.id),
                                }),
                            }).then(() => {
                                window.gaiaMediaEditor?.refresh?.();
                            }).catch(() => { });
                        }
                        renderAssets();
                    }
                }
            }
        });

        assetList.addEventListener('contextmenu', event => {
            const row = event.target.closest('.asset-row');
            if (!row) return;
            const entry = entryById(row.dataset.entryId);
            if (!entry) return;
            event.preventDefault();
            if (!state.selectedEntryIds.has(entry.id)) {
                state.selectedEntryIds.clear();
                state.selectedEntryIds.add(entry.id);
                state.selectionAnchorId = entry.id;
                refreshSelectionPresentation();
            }
            state.contextEntry = entry;
            closeTypeSwitcherMenu();
            renderContextMenu();
            contextMenu.classList.remove('hidden');
            const width = contextMenu.offsetWidth || 180;
            const height = contextMenu.offsetHeight || 120;
            contextMenu.style.left = `${Math.min(event.clientX, window.innerWidth - width - 8)}px`;
            contextMenu.style.top = `${Math.min(event.clientY, window.innerHeight - height - 8)}px`;
        });

        assetList.addEventListener('dragstart', event => {
            if (!event.dataTransfer) return;
            const row = event.target.closest('.asset-row');
            if (!row) return;
            const entry = entryById(row.dataset.entryId);
            if (!entry) return;
            const selectedEntries = state.selectedEntryIds.has(entry.id)
                ? allEntries().filter(candidate => state.selectedEntryIds.has(candidate.id))
                : [entry];
            const itemIds = [...new Set(selectedEntries.map(numericItemId).filter(Boolean))];
            if (!itemIds.length) {
                event.preventDefault();
                return;
            }
            if (event.target.closest('.type-badge.type-switchable')) {
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
            state.isDraggingItem = true;
            row.classList.add('dragging');
        });

        assetList.addEventListener('dragend', () => {
            state.isDraggingItem = false;
            stopDragAutoScroll();
            assetList.querySelectorAll('.asset-row.dragging, .asset-row.drop-target, .asset-row.drop-between-before, .asset-row.drop-between-after')
                .forEach(el => el.classList.remove('dragging', 'drop-target', 'drop-between-before', 'drop-between-after'));
        });

        assetList.addEventListener('dragover', event => {
            if (!Array.from(event.dataTransfer?.types || []).includes('application/x-gaia-item-ids')) return;
            const row = event.target.closest('.asset-row');
            if (!row) return;
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = 'move';

            const rect = row.getBoundingClientRect();
            const relY = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5;
            const entry = entryById(row.dataset.entryId);
            const isCollection = entry?.isContainer || typeIsContainer(entry?.type) || Boolean(row.dataset.subfolderKey);

            if (isCollection) {
                if (relY < 0.22) {
                    row.classList.remove('drop-target', 'drop-between-after');
                    row.classList.add('drop-between-before');
                } else if (relY > 0.78) {
                    row.classList.remove('drop-target', 'drop-between-before');
                    row.classList.add('drop-between-after');
                } else {
                    row.classList.remove('drop-between-before', 'drop-between-after');
                    row.classList.add('drop-target');
                }
            } else {
                if (relY <= 0.5) {
                    row.classList.remove('drop-between-after');
                    row.classList.add('drop-between-before');
                } else {
                    row.classList.remove('drop-between-before');
                    row.classList.add('drop-between-after');
                }
            }
        });

        assetList.addEventListener('dragleave', event => {
            const row = event.target.closest('.asset-row');
            if (row && !row.contains(event.relatedTarget)) {
                row.classList.remove('drop-target', 'drop-between-before', 'drop-between-after');
            }
        });

        assetList.addEventListener('drop', event => {
            const row = event.target.closest('.asset-row');
            if (!row) return;
            const isBetweenBefore = row.classList.contains('drop-between-before');
            const isBetweenAfter = row.classList.contains('drop-between-after');
            const isTarget = row.classList.contains('drop-target');
            row.classList.remove('drop-target', 'drop-between-before', 'drop-between-after');

            const rawIds = event.dataTransfer?.getData('application/x-gaia-item-ids');
            if (!rawIds) return;
            event.preventDefault();
            event.stopPropagation();
            const entry = entryById(row.dataset.entryId);
            if (!entry) return;
            try {
                const currentId = Number(entry.numericId || entry.itemId || entry.item?.id || entry.collection?.id);
                const itemIds = JSON.parse(rawIds).map(Number).filter(id => Number.isFinite(id) && id !== currentId);
                if (!itemIds.length) return;

                const isCollection = entry.isContainer || typeIsContainer(entry.type) || Boolean(row.dataset.subfolderKey);
                if (isBetweenBefore || isBetweenAfter) {
                    placeItemOutsideContainer(entry, [...new Set(itemIds)]);
                } else if (isTarget && isCollection) {
                    const targetFolder = (row.dataset.subfolderKey || entry.kind === 'subfolder')
                        ? (entry.subfolder?.fullPath || entry.path || entry.fullPath || entry.title)
                        : undefined;
                    placeItemsDirectly(entry, [...new Set(itemIds)], { folder: targetFolder, mode: 'move' });
                }
            } catch (_error) {
                window.alert('GAIA could not read the dragged items.');
            }
        });
    }

    function createEntry(entry, options = {}) {
        const wrapper = document.createElement('article');
        wrapper.className = 'asset-entry';
        wrapper.dataset.entryId = entry.id;
        if (entry.kind === 'asset') wrapper.dataset.itemId = String(entry.item.id);
        if (!options.nested) wrapper.style.setProperty('--main-table-width', `${mainColumnMinimumWidth()}px`);
        wrapper.appendChild(createRow(entry, options));
        return wrapper;
    }

    function contentFolderPath(content) {
        const folder = content.reference?.attributes?.folder
            || content.item?.attributes?.folder
            || content.content?.attributes?.folder
            || content.attributes?.folder;
        if (typeof folder === 'string') {
            const clean = folder.trim().replace(/^\/+|\/+$/g, '');
            return (clean && clean !== '.') ? clean : '';
        }
        if (content.kind === 'reference') return '';
        const rel = content.content?.relative_path || content.path || '';
        if (!rel || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) return '';
        const idx = rel.lastIndexOf('/');
        if (idx > 0) {
            const clean = rel.slice(0, idx).trim().replace(/^\/+|\/+$/g, '');
            return (clean && clean !== '.') ? clean : '';
        }
        return '';
    }

    function resolveTreeNode(root, folderPath) {
        let current = root;
        let currentPath = '';
        for (const segment of (folderPath || '').split('/').filter(Boolean)) {
            if (segment === '.') continue;
            currentPath = currentPath ? `${currentPath}/${segment}` : segment;
            if (!current.subfolders.has(segment)) {
                current.subfolders.set(segment, { name: segment, fullPath: currentPath, files: [], subfolders: new Map() });
            }
            current = current.subfolders.get(segment);
        }
        return current;
    }

    function buildCollectionTree(contents) {
        const root = { files: [], subfolders: new Map() };
        contents.forEach(content => {
            const isFolder = content.type === 'collection' || typeIsContainer(content.type)
                || content.content?.attributes?.is_folder || content.item?.attributes?.is_folder;
            if (isFolder) {
                const name = content.title || content.content?.title || content.filename || 'Folder';
                if (!name || name === '.' || name === './') return;
                const parentNode = resolveTreeNode(root, contentFolderPath(content));
                if (!parentNode.subfolders.has(name)) {
                    parentNode.subfolders.set(name, {
                        name,
                        fullPath: parentNode.fullPath ? `${parentNode.fullPath}/${name}` : name,
                        files: [],
                        subfolders: new Map(),
                        folderItem: content,
                    });
                } else {
                    parentNode.subfolders.get(name).folderItem = content;
                }
            } else {
                resolveTreeNode(root, contentFolderPath(content)).files.push(content);
            }
        });
        return root;
    }

    function countTreeFiles(node) {
        let count = node.files.length;
        for (const sub of node.subfolders.values()) {
            count += countTreeFiles(sub);
        }
        return count;
    }

    function createRollingCursorIndicator({ depth = 0 } = {}) {
        const indicator = document.createElement('div');
        indicator.className = 'rolling-cursor-indicator';
        indicator.setAttribute('aria-hidden', 'true');
        if (depth > 0) {
            indicator.style.paddingLeft = `${depth * 16 + 28}px`;
        }
        const line = document.createElement('div');
        line.className = 'rolling-cursor-line';
        indicator.appendChild(line);
        return indicator;
    }

    function createEndSpacerElement() {
        const endSpacer = document.createElement('div');
        endSpacer.className = 'asset-list-end-spacer';
        endSpacer.dataset.role = 'table-end-spacer';
        endSpacer.style.setProperty('--main-table-width', `${mainColumnMinimumWidth()}px`);

        endSpacer.addEventListener('dragover', event => {
            if (!Array.from(event.dataTransfer?.types || []).includes('application/x-gaia-item-ids')) return;
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = 'move';
            endSpacer.classList.add('drop-target');
        });
        endSpacer.addEventListener('dragleave', event => {
            if (!endSpacer.contains(event.relatedTarget)) {
                endSpacer.classList.remove('drop-target');
            }
        });
        endSpacer.addEventListener('drop', event => {
            endSpacer.classList.remove('drop-target');
            const rawIds = event.dataTransfer?.getData('application/x-gaia-item-ids');
            if (!rawIds) return;
            event.preventDefault();
            event.stopPropagation();
            try {
                const itemIds = JSON.parse(rawIds).map(Number).filter(id => Number.isFinite(id));
                if (!itemIds.length) return;
                const activeVault = selectedVault() || state.vaults[0];
                if (activeVault) {
                    placeItemsDirectly({ isVault: true, vault: activeVault }, [...new Set(itemIds)], { mode: 'move' });
                }
            } catch (_err) {
                window.alert('GAIA could not read the dragged items.');
            }
        });
        return endSpacer;
    }

    function ensureVirtualList() {
        if (virtualList || !assetList || !window.GaiaVirtualList) return virtualList;
        virtualList = new window.GaiaVirtualList(assetList, {
            overscan: 16,
            createEndSpacer: createEndSpacerElement,
            renderItem: renderFlatRow,
        });
        return virtualList;
    }

    function renderFlatRow(spec) {
        if (!spec) return null;
        if (spec.kind === 'empty') {
            const emptyEl = document.createElement('div');
            emptyEl.className = 'empty';
            emptyEl.textContent = spec.text || 'No assets match this view.';
            return emptyEl;
        }
        if (spec.kind === 'root') {
            const el = createEntry(spec.entry);
            if (spec.isExpanded) {
                const btn = el.querySelector('.item-expand-toggle-btn');
                if (btn) {
                    btn.textContent = '▾';
                    btn.setAttribute('aria-expanded', 'true');
                }
            }
            return el;
        }
        if (spec.kind === 'collection-header') {
            const header = createCollectionHeader(spec.collection);
            header.classList.add('virtual-nested-header', `collection-layout-${spec.layout.id}`);
            return header;
        }
        if (spec.kind === 'subfolder') {
            const wrap = document.createElement('div');
            wrap.className = `virtual-nested-entry collection-layout-${spec.layout.id}`;
            if (spec.entry.itemId) wrap.dataset.itemId = String(spec.entry.itemId);
            const row = createRow(spec.entry, {
                nested: true,
                subfolderDepth: spec.depth,
                isSubfolder: true,
                subfolderKey: spec.subfolderKey,
            });
            if (spec.isExpanded) {
                const btn = row.querySelector('.item-expand-toggle-btn');
                if (btn) {
                    btn.textContent = '▾';
                    btn.setAttribute('aria-expanded', 'true');
                }
            }
            wrap.appendChild(row);
            return wrap;
        }
        if (spec.kind === 'nested') {
            const wrapper = createEntry(spec.entry, { nested: true, subfolderDepth: spec.depth });
            wrapper.classList.add('virtual-nested-entry', `collection-layout-${spec.layout.id}`);
            if (spec.entry.itemId) wrapper.dataset.itemId = String(spec.entry.itemId);
            return wrapper;
        }
        if (spec.kind === 'loading') {
            const wrap = document.createElement('div');
            wrap.className = 'virtual-nested-entry';
            wrap.appendChild(createRollingCursorIndicator({ depth: spec.depth }));
            return wrap;
        }
        if (spec.kind === 'empty-sub') {
            const emptyRow = document.createElement('div');
            emptyRow.className = 'virtual-nested-entry empty-subfolder-hint';
            emptyRow.style.paddingLeft = `${(spec.depth || 0) * 16 + 28}px`;
            emptyRow.textContent = spec.text || 'This folder is empty';
            return emptyRow;
        }
        return null;
    }

    function appendLogicalSubtreeFlatRows(rows, node, collection, layout, depth, parentMatchesFilter, filterActive, autoExpandSearch) {
        const collectionId = Number(collection.id);
        const nestedRowHeight = layout.id === 'sample-pack' ? 20 : 28;
        const sortedSubfolders = Array.from(node.subfolders.values()).sort((a, b) =>
            a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
        );

        for (let i = 0; i < sortedSubfolders.length; i++) {
            const subfolder = sortedSubfolders[i];
            const subfolderKey = `${collectionId}:${subfolder.fullPath}`;
            const folderEntryId = `subfolder:${collectionId}:${subfolder.fullPath}`;
            const folderItemId = entryFolderItemId(subfolder.folderItem);
            const isExpanded = state.expandedSubfolders.has(subfolderKey)
                || (folderItemId && state.expandedCollections.has(String(folderItemId)))
                || autoExpandSearch;

            const folderEntry = registerEntry({
                id: folderEntryId,
                kind: 'subfolder',
                type: 'folder',
                title: subfolder.name,
                name: subfolder.name,
                path: subfolder.fullPath,
                fullPath: subfolder.fullPath,
                collection,
                subfolder,
                folderItem: subfolder.folderItem || null,
                itemId: folderItemId,
                item: subfolder.folderItem?.item
                    || (folderItemId ? { id: Number(folderItemId), vault_id: collection.vault_id, type: 'folder', attributes: { is_folder: true }, title: subfolder.name } : { id: null, vault_id: collection.vault_id, type: 'folder', attributes: { is_folder: true }, title: subfolder.name }),
                content: subfolder.folderItem?.content || subfolder.folderItem || { child_id: folderItemId ? Number(folderItemId) : null, vault_id: collection.vault_id, attributes: { is_folder: true } },
                contentCount: countTreeFiles(subfolder),
            });
            state.subfolderEntries.set(folderEntryId, folderEntry);

            rows.push({
                kind: 'subfolder',
                entry: folderEntry,
                collection,
                layout,
                depth,
                subfolderKey,
                isExpanded,
                height: 24,
            });

            if (isExpanded) {
                if (subfolder.files.length === 0 && subfolder.subfolders.size === 0) {
                    rows.push({ kind: 'empty-sub', depth: depth + 1, text: 'This folder is empty', height: 24 });
                } else {
                    appendLogicalSubtreeFlatRows(rows, subfolder, collection, layout, depth + 1, parentMatchesFilter, filterActive, autoExpandSearch);
                }
            }
        }

        for (let i = 0; i < node.files.length; i++) {
            rows.push({
                kind: 'nested',
                entry: node.files[i],
                collection,
                layout,
                depth,
                height: nestedRowHeight,
            });
        }
    }

    function appendDirectFolderFlatRows(rows, parentItem, rootCollection, layout, depth, pathPrefix, parentMatchesFilter) {
        const rootId = Number(rootCollection.id);
        const filterActive = filteringIsActive();
        const fm = state.filterMatches;
        const autoExpandSearch = Boolean(state.query && fm);
        const nestedRowHeight = layout.id === 'sample-pack' ? 20 : 28;
        const { folders, files } = directChildEntries(parentItem, rootCollection);

        let appendedAny = false;
        for (let i = 0; i < folders.length; i++) {
            const sub = folders[i];
            if (filterActive && !parentMatchesFilter && fm && !fm.matchingBranchIds.has(sub.id)) {
                continue;
            }
            const subTitle = sub.title || sub.filename || 'Folder';
            const fullPath = pathPrefix ? `${pathPrefix}/${subTitle}` : subTitle;
            const subfolderKey = `${rootId}:${fullPath}`;
            const folderEntryId = `subfolder:${rootId}:${fullPath}`;
            const isExpanded = state.expandedSubfolders.has(subfolderKey)
                || state.expandedCollections.has(String(sub.id))
                || (autoExpandSearch && fm.matchingBranchIds.has(sub.id));

            const folderEntry = registerEntry({
                id: folderEntryId,
                kind: 'subfolder',
                type: sub.type || 'folder',
                title: subTitle,
                name: subTitle,
                path: fullPath,
                fullPath,
                collection: rootCollection,
                subfolder: { name: subTitle, fullPath, files: [], subfolders: new Map(), folderItem: { item: sub, content: { ...sub, child_id: sub.id } } },
                folderItem: { item: sub, content: { ...sub, child_id: sub.id } },
                itemId: Number(sub.id),
                item: sub,
                content: { ...sub, child_id: sub.id },
                contentCount: sub.content_count ?? catalogStore.getDirectChildren(sub.id).length,
            });
            state.subfolderEntries.set(folderEntryId, folderEntry);

            rows.push({
                kind: 'subfolder',
                entry: folderEntry,
                collection: rootCollection,
                layout,
                depth,
                subfolderKey,
                isExpanded,
                height: 24,
            });
            appendedAny = true;

            if (isExpanded) {
                const subMatchesSelf = parentMatchesFilter || (fm ? fm.matchingItemIds.has(sub.id) : false);
                const beforeCount = rows.length;
                appendDirectFolderFlatRows(rows, sub, rootCollection, layout, depth + 1, fullPath, subMatchesSelf);
                if (rows.length === beforeCount) {
                    rows.push({
                        kind: 'empty-sub',
                        depth: depth + 1,
                        text: filterActive ? 'No matching files in this folder' : 'This folder is empty',
                        height: 24,
                    });
                }
            }
        }

        for (let i = 0; i < files.length; i++) {
            const fileEntry = files[i];
            if (filterActive && !parentMatchesFilter) {
                const fid = Number(fileEntry.itemId || fileEntry.item?.id);
                const hit = fm ? fm.matchingItemIds.has(fid) : entryMatches(fileEntry);
                if (!hit) continue;
            }
            rows.push({
                kind: 'nested',
                entry: fileEntry,
                collection: rootCollection,
                layout,
                depth,
                height: nestedRowHeight,
            });
            appendedAny = true;
        }
        return appendedAny;
    }

    function renderLibraryStatus(entries = visibleEntries()) {
        const current = filteringIsActive()
            ? (state.filterMatches ? state.filterMatches.matchingItemIds.size : entries.length)
            : entries.length;
        const sourceCount = state.items.length;
        const vaultName = state.selectedPlaylistId !== null
            ? (selectedPlaylist()?.name || 'playlist')
            : (state.selectedVaultId !== null ? (selectedVault()?.name || 'vault') : 'Show all');
        const selectionSuffix = state.selectedEntryIds.size ? ` · ${state.selectedEntryIds.size} selected` : '';
        summary.textContent = (filteringIsActive()
            ? `${current} assets match the active filter`
            : `${sourceCount} assets in ${vaultName}`) + selectionSuffix;
        renderFilterStatus();
    }

    function renderAssets() {
        state.subfolderEntries?.clear();
        const entries = visibleEntries();
        renderMoveBar();

        const rows = [];
        const filterActive = filteringIsActive();
        const fm = state.filterMatches;

        if (!entries.length) {
            rows.push({ kind: 'empty', height: 48, text: 'No assets match this view.' });
        } else {
            for (let i = 0; i < entries.length; i++) {
                const entry = entries[i];
                const itemId = Number(entry.item?.id);
                const isContainerItem = typeIsContainer(entry.type) || entry.type === 'collection' || Boolean(entry.item?.attributes?.is_folder || entry.content?.attributes?.is_folder);
                const autoExpandedBySearch = Boolean(
                    state.query && isContainerItem && fm && fm.matchingBranchIds.has(itemId) && !fm.matchingItemIds.has(itemId)
                );
                const isCollectionExpanded = Boolean(
                    entry.kind === 'asset' && isContainerItem && (
                        state.expandedCollections.has(entry.id)
                        || (itemId && state.expandedCollections.has(String(itemId)))
                        || autoExpandedBySearch
                    )
                );

                rows.push({ kind: 'root', entry, height: 28, isExpanded: isCollectionExpanded });

                if (isCollectionExpanded) {
                    const collectionLayout = collectionRowLayout(entry.item);
                    const loadingReferences = state.projectReferencesLoading.has(itemId);
                    const rootMatchesSelf = !filterActive || (fm ? fm.matchingItemIds.has(itemId) : entryMatches(entry));
                    const headerSlot = rows.length;
                    rows.push({ kind: 'collection-header', collection: entry.item, layout: collectionLayout, height: 26 });

                    let hasVisibleChildren = false;
                    if (typeIsProject(entry.type)) {
                        const allProjectContents = collectionContentEntries(entry.item);
                        const displayed = filterActive && !rootMatchesSelf
                            ? allProjectContents.filter(entryMatches)
                            : allProjectContents;
                        if (displayed.length) {
                            const tree = buildCollectionTree(displayed);
                            appendLogicalSubtreeFlatRows(rows, tree, entry.item, collectionLayout, 0, rootMatchesSelf, filterActive, Boolean(state.query));
                            hasVisibleChildren = true;
                        }
                    } else {
                        hasVisibleChildren = appendDirectFolderFlatRows(rows, entry.item, entry.item, collectionLayout, 0, '', rootMatchesSelf);
                    }

                    if (!hasVisibleChildren) {
                        rows.splice(headerSlot, 1);
                        if (loadingReferences) {
                            rows.push({ kind: 'loading', depth: 0, height: 24 });
                        } else {
                            rows.push({
                                kind: 'empty-sub',
                                depth: 0,
                                text: filterActive ? 'No files in this collection match the active filter.' : 'This folder is empty.',
                                height: 26,
                            });
                        }
                    } else if (loadingReferences) {
                        rows.push({ kind: 'loading', depth: 0, height: 24 });
                    }
                }
            }
        }

        state.visibleFlatRows = rows;
        const vlist = ensureVirtualList();
        if (vlist) {
            vlist.setItems(rows, { force: true, tableWidthPx: mainColumnMinimumWidth() });
        }

        renderLibraryStatus(entries);
    }

    function scrollToEntryOrItem({ entryId = null, itemId = null, highlight = false } = {}) {
        const vlist = ensureVirtualList();
        if (!vlist || !state.visibleFlatRows.length) return;
        const numId = itemId != null ? Number(itemId) : null;
        const idx = state.visibleFlatRows.findIndex(r => {
            if (!r.entry) return false;
            if (entryId && r.entry.id === entryId) return true;
            if (numId && (Number(r.entry.itemId) === numId || Number(r.entry.item?.id) === numId || Number(r.entry.content?.child_id) === numId)) return true;
            return false;
        });
        if (idx < 0) return;
        vlist.scrollToIndex(idx, { block: 'center' });
        if (highlight) {
            requestAnimationFrame(() => {
                const mounted = (entryId && vlist.findMountedRowByEntryId(entryId))
                    || (numId && vlist.findMountedRowByItemId(numId));
                if (mounted) {
                    mounted.classList.add('highlight-target');
                    setTimeout(() => mounted.classList.remove('highlight-target'), 2400);
                }
            });
        }
    }

    function refreshSelectionPresentation() {
        const vlist = ensureVirtualList();
        if (vlist) {
            vlist.refreshSelection(state.selectedEntryIds);
        } else {
            assetList.querySelectorAll('.asset-row, .subfolder-row').forEach(row => {
                const entryId = row.dataset.entryId || row.closest('.asset-entry')?.dataset.entryId;
                const selected = entryId ? state.selectedEntryIds.has(entryId) : false;
                row.classList.toggle('selected', selected);
                row.setAttribute('aria-selected', String(selected));
            });
        }
        renderMoveBar();
        renderLibraryStatus();
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

    function handleDragAutoScroll(event) {
        if (!assetList || (!state.isDraggingItem && !Array.from(event.dataTransfer?.types || []).includes('application/x-gaia-item-ids'))) return;
        const rect = assetList.getBoundingClientRect();
        const zone = 50;
        if (event.clientY < rect.top + zone && event.clientY >= rect.top - 20) {
            assetList.scrollTop -= 14;
        } else if (event.clientY > rect.bottom - zone && event.clientY <= rect.bottom + 20) {
            assetList.scrollTop += 14;
        }
    }

    function stopDragAutoScroll() {
        // No persistent timer to clean up for direct delta scroll
    }

    function selectAllEntries() {
        const entries = selectionEntries();
        if (!entries.length) return;
        state.selectedEntryIds.clear();
        entries.forEach(entry => state.selectedEntryIds.add(entry.id));
        state.selectionAnchorId = entries[0]?.id || null;
        state.contextEntry = null;
        refreshSelectionPresentation();
        window.dispatchEvent(new CustomEvent('gaia:selection', {
            detail: {
                entry: entries[0] || null,
                playable: Boolean(entries[0] && (canPreview(entries[0]) || entries[0].isContainer || typeIsContainer(entries[0].type) || entries[0].type === 'collection')),
            },
        }));
    }

    function clearSelection() {
        if (state.selectedEntryIds.size > 0 || state.selectionAnchorId || state.contextEntry) {
            state.selectedEntryIds.clear();
            state.selectionAnchorId = null;
            state.contextEntry = null;
            refreshSelectionPresentation();
            window.dispatchEvent(new CustomEvent('gaia:selection', { detail: { entry: null, playable: false } }));
        }
    }

    function copySelectedEntries() {
        const entries = getSelectedEntries();
        const itemIds = [...new Set(entries.map(numericItemId).filter(Boolean))];
        if (!itemIds.length) return false;
        state.clipboard = {
            type: 'library-items',
            itemIds,
            entries: entries.map(e => ({ id: e.id, title: e.title, itemId: numericItemId(e) })),
        };
        try {
            if (navigator.clipboard?.writeText) {
                const payload = JSON.stringify(entries.length === 1
                    ? dragPayload(entries[0])
                    : { type: 'library-items', items: entries.map(dragPayload) });
                navigator.clipboard.writeText(payload).catch(() => { });
            }
        } catch (_err) { }
        if (summary) {
            const label = itemIds.length === 1 ? '1 item' : `${itemIds.length} items`;
            summary.textContent = `Copied ${label} to clipboard`;
            setTimeout(() => renderLibraryStatus(), 2200);
        }
        return true;
    }

    function getTargetProjectForPaste() {
        if (state.contextEntry) {
            if (state.contextEntry.kind === 'asset' && typeIsContainer(state.contextEntry.type)) {
                return state.contextEntry;
            }
            if (state.contextEntry.collection?.id) {
                const parentProject = allEntries().find(e => e.kind === 'asset' && Number(e.item?.id) === Number(state.contextEntry.collection.id));
                if (parentProject) return parentProject;
            }
        }
        const selected = getSelectedEntries();
        const container = selected.find(e => e.kind === 'asset' && typeIsContainer(e.type));
        if (container) return container;
        const childInContainer = selected.find(e => e.collection?.id);
        if (childInContainer) {
            const parentProject = allEntries().find(e => e.kind === 'asset' && Number(e.item?.id) === Number(childInContainer.collection.id));
            if (parentProject) return parentProject;
        }
        return null;
    }

    function pasteIntoProject() {
        if (!state.clipboard?.itemIds?.length) return false;
        const target = getTargetProjectForPaste();
        if (target) {
            const targetId = Number(target.item?.id);
            const validItemIds = state.clipboard.itemIds.filter(id => id !== targetId);
            if (!validItemIds.length) {
                window.alert('Cannot paste a project into itself.');
                return false;
            }
            openItemPlacementDialog(target, validItemIds, { action: 'copy' });
            return true;
        }

        const currentVault = state.selectedVaultId !== null
            ? state.vaults.find(v => Number(v.id) === Number(state.selectedVaultId))
            : (state.vaults[0] || null);
        if (!currentVault) {
            window.alert('Please select a vault to paste into.');
            return false;
        }
        openItemPlacementDialog({
            isVault: true,
            vault: currentVault,
            title: currentVault.name,
        }, state.clipboard.itemIds, { action: 'copy' });
        return true;
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
        element.addEventListener('wheel', event => {
            if (element.scrollWidth <= element.clientWidth) return;
            const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
            if (!delta) return;
            const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 18 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? element.clientWidth : 1;
            const before = element.scrollLeft;
            element.scrollLeft += delta * unit;
            if (element.scrollLeft !== before) event.preventDefault();
        }, { passive: false });
    }

    function renderFilterStatus() {
        // This row is now the persistent table header. Keep it independent of
        // the active filters so the column controls remain available at all times.
        renderMainHeader();
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
        const visibleTypes = new Set([...facets.types, ...state.selectedTypes]);
        [...visibleTypes].sort().filter(type => (
            state.selectedTypes.has(type)
            || !state.query
            || typeLabel(type).toLowerCase().includes(state.query)
            || String(type).toLowerCase().includes(state.query)
        )).forEach(type => {
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
        const visibleTags = new Map(facets.tags);
        state.selectedTags.forEach(tag => {
            if (!visibleTags.has(tag)) visibleTags.set(tag, tag);
        });
        [...visibleTags.values()].sort((a, b) => a.localeCompare(b)).filter(tag => (
            state.selectedTags.has(normalizeFacetValue(tag))
            || !state.query
            || tag.toLowerCase().includes(state.query)
        )).forEach(tag => {
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
        state.selectedPlaylistId = null;
        state.selectedTypes.clear();
        state.selectedTags.clear();
        state.query = '';
        searchInput.value = '';
        syncViewFromCatalog();
    }

    function getSelectedEntries() {
        const selected = [];
        state.selectedEntryIds.forEach(id => {
            const found = entryById(id) || state.subfolderEntries?.get(id);
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
            const id = entry.kind === 'subfolder' ? entryFolderItemId(entry) : (numericItemId(entry) || Number(entry.collection?.id) || null);
            if (id && Number.isFinite(id)) ids.push(id);
        });
        return [...new Set(ids)];
    }

    function getSelectedProjectSourceEntries() {
        const seen = new Set();
        return getSelectedEntries()
            .filter(entry => ['asset', 'reference'].includes(entry.kind) && entry.item && entry.item.id)
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
        const pendingSources = state.projectPendingImports.map(pending => ({
            kind: 'pending-import',
            id: pending.id,
            type: pending.type,
            title: pending.title,
            pending,
        }));
        const sourceRows = [...selectedSources, ...pendingSources];
        const movableSources = sourceRows.filter(source => source.kind === 'pending-import'
            ? source.pending.movable
            : !typeIsContainer(source.type));
        const movedCount = movableSources.filter(source => source.kind === 'pending-import'
            ? state.projectPendingMoveIds.has(source.id)
            : state.projectMoveIds.has(Number(source.item.id))).length;
        const usingSources = sourceRows.length > 0;

        if (projectImportAdd) projectImportAdd.disabled = Boolean(state.importJobId) || state.projectImportInspecting;
        projectSourcePreview.classList.remove('hidden');
        projectSubmit.textContent = 'Create Project';
        if (!sourceRows.length) {
            projectSourceTitle.textContent = 'Selected files';
            projectSourceCount.textContent = '0';
            if (projectMoveAll) {
                projectMoveAll.checked = false;
                projectMoveAll.indeterminate = false;
                projectMoveAll.disabled = true;
            }
            projectSourceList.innerHTML = `<p class="help" style="margin: 6px 0; color: var(--muted); font-size: 11px;">No files selected (project will be created empty, ready for future work).</p>`;
            return;
        }

        projectSourceTitle.textContent = 'Selected files';
        projectSourceCount.textContent = `${sourceRows.length}`;
        if (projectMoveAll) {
            projectMoveAll.disabled = !usingSources || movableSources.length === 0;
            projectMoveAll.checked = movableSources.length > 0 && movedCount === movableSources.length;
            projectMoveAll.indeterminate = movedCount > 0 && movedCount < movableSources.length;
        }
        projectSourceList.innerHTML = sourceRows.map(source => {
            const isPending = source.kind === 'pending-import';
            const sourceId = isPending ? source.id : Number(source.item.id);
            const movable = isPending ? source.pending.movable : !typeIsContainer(source.type);
            const moved = isPending
                ? state.projectPendingMoveIds.has(source.id)
                : state.projectMoveIds.has(Number(source.item.id));
            return `
                <div class="project-source-item">
                    <span class="project-source-icon" aria-hidden="true">${typeIsContainer(source.type) ? '▣' : isPending ? '⇩' : '♪'}</span>
                    <span class="project-source-copy">
                        <strong>${escapeHtml(source.title)}</strong>
                    </span>
                    <label class="project-source-toggle project-source-row-toggle${movable ? '' : ' is-disabled'}" title="${movable ? 'Move this file into the project' : 'Folders are linked'}">
                        <span>Move</span>
                        <input type="checkbox" data-project-move-id="${escapeHtml(sourceId)}" ${moved ? 'checked' : ''}${movable ? '' : ' disabled'}>
                    </label>
                    <button type="button" class="project-source-remove-btn" data-project-remove-id="${escapeHtml(sourceId)}" title="Deselect this item" aria-label="Deselect this item">✕</button>
                </div>
            `;
        }).join('');
        projectSourceList.querySelectorAll('[data-project-move-id]').forEach(input => {
            input.addEventListener('change', event => {
                const sourceId = event.currentTarget.dataset.projectMoveId;
                const pending = sourceId.startsWith('pending-import:');
                const target = pending ? state.projectPendingMoveIds : state.projectMoveIds;
                const value = pending ? sourceId : Number(sourceId);
                if (event.currentTarget.checked) target.add(value);
                else target.delete(value);
                renderProjectSourcePreview();
            });
        });
        projectSourceList.querySelectorAll('[data-project-remove-id]').forEach(button => {
            button.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                const sourceId = event.currentTarget.dataset.projectRemoveId;
                const pending = sourceId.startsWith('pending-import:');
                if (pending) {
                    state.projectPendingImports = state.projectPendingImports.filter(item => item.id !== sourceId);
                    state.projectPendingMoveIds.delete(sourceId);
                } else {
                    const numericId = Number(sourceId);
                    state.projectSourceIds.delete(numericId);
                    state.projectMoveIds.delete(numericId);
                }
                renderProjectSourcePreview();
            });
        });
    }

    function openProjectImportBrowser() {
        if (!projectDialog?.open || state.importJobId || state.projectImportInspecting) return;
        state.vaultPathPickerMode = null;
        state.projectImportPickerActive = true;
        if (sourcePickerTitle) sourcePickerTitle.textContent = 'Choose a project source';
        if (sourcePickerSubtitle) sourcePickerSubtitle.textContent = 'Select a folder, an individual asset, or a ZIP archive.';
        sourcePickerDialog?.showModal();
        loadSourcePicker(null);
    }

    async function requestImportPreview(path, vaultId, progressive = true) {
        const response = await fetch('/items/import/preview', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source_path: path, vault_id: vaultId, progressive }),
        });
        const preview = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(preview.detail || 'Could not inspect source');
        return preview;
    }

    async function inspectProjectImportSource(path) {
        state.projectImportInspecting = true;
        renderProjectSourcePreview();
        projectResult.className = 'result hidden';
        try {
            const preview = await requestImportPreview(path, selectedProjectVaultId(), false);
            const pendingId = `pending-import:${Date.now()}:${state.projectPendingImports.length}`;
            const sourceType = preview.source_kind === 'file'
                ? preview.entries?.[0]?.type || 'item'
                : 'collection';
            state.projectPendingImports.push({
                id: pendingId,
                title: preview.title || filename(path),
                type: sourceType,
                movable: preview.source_kind === 'file',
                preview,
                sourcePath: path,
            });
            if (preview.source_kind === 'file') state.projectPendingMoveIds.add(pendingId);
            if (!projectName.value.trim()) projectName.value = preview.title || filename(path);
            renderProjectSourcePreview();
        } catch (error) {
            projectResult.textContent = error.message;
            projectResult.className = 'result error';
        } finally {
            state.projectImportInspecting = false;
            renderProjectSourcePreview();
        }
    }

    function projectImportJobPayload(preview) {
        return {
            preview_id: preview.preview_id,
            folder_assignments: Object.fromEntries(
                (preview.nodes || [])
                    .filter(node => node.kind === 'folder')
                    .map(node => [node.relative_path, 'action:contain']),
            ),
            item_types: Object.fromEntries((preview.entries || []).map(entry => [entry.index, entry.type])),
            excluded_indexes: [],
            conflict_action: preview.conflicts?.length ? 'new_snapshot' : null,
        };
    }

    async function createImportJob(payload) {
        const response = await fetch('/items/import/jobs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const job = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(job.detail || 'Could not start import');
        return job;
    }

    function addProjectImportResults(context, pending, resultItems) {
        const importedIds = resultItems
            .map(item => Number(item.id))
            .filter(itemId => Number.isFinite(itemId));
        context.itemIds.push(...importedIds);
        if (pending?.movable) {
            resultItems
                .filter(item => Number.isFinite(Number(item.id)) && !typeIsContainer(item.type))
                .forEach(item => context.moveItemIds.push(Number(item.id)));
        }

        const knownIds = new Set(state.projectDialogSources.map(source => Number(source.item?.id)));
        resultItems.forEach(item => {
            const itemId = Number(item.id);
            if (!Number.isFinite(itemId) || knownIds.has(itemId)) return;
            state.projectDialogSources.push({
                kind: 'asset',
                id: String(itemId),
                type: item.type,
                title: item.title || filename(item.absolute_path),
                path: item.absolute_path,
                item,
            });
            state.projectSourceIds.add(itemId);
            knownIds.add(itemId);
        });
        if (pending) {
            state.projectPendingImports = state.projectPendingImports.filter(source => source.id !== pending.id);
            state.projectPendingMoveIds.delete(pending.id);
        }
        state.projectMoveIds = new Set([...state.projectMoveIds, ...context.moveItemIds]);
        renderProjectSourcePreview();
    }

    function failProjectCreationImport(message) {
        stopImportPolling();
        localStorage.removeItem('gaia.activeImportJobId');
        state.importJobId = null;
        state.projectCreationImportContext = null;
        setImportBusy(false);
        projectSubmit.disabled = false;
        projectName.disabled = false;
        projectResult.textContent = message;
        projectResult.className = 'result error';
        if (!projectDialog.open) projectDialog.showModal();
        renderProjectSourcePreview();
    }

    let pendingProjectInitialSession = null;
    let pendingProjectOnCreated = null;

    function inferKindFromEntries(entries = []) {
        for (const source of entries) {
            if (!source) continue;
            const item = source.item || source;
            if (item.type === 'video' || source.type === 'video' || item.project_kind === 'video') return 'video';
            for (const child of item.contents || source.contents || []) {
                if (child?.type === 'video') return 'video';
            }
        }
        return 'audio';
    }

    function syncProjectKindEngineControls({ preserveEngine = false } = {}) {
        if (!projectKindSelect || !projectEngineSelect) return;
        const kind = projectKindSelect.value === 'video' ? 'video' : 'audio';
        const sinOption = projectEngineSelect.querySelector('option[value="sin"]');
        if (sinOption) sinOption.disabled = kind === 'video';
        if (kind === 'video') {
            projectEngineSelect.value = 'simple_media';
            if (projectEngineHelp) {
                projectEngineHelp.textContent = 'Video projects use the Simple Media Editor (1-channel cutter & FFmpeg export).';
            }
        } else {
            if (!preserveEngine) projectEngineSelect.value = 'sin';
            if (projectEngineHelp) {
                projectEngineHelp.textContent = projectEngineSelect.value === 'simple_media'
                    ? 'Audio project using Simple Media Editor (lightweight 1-channel cutter, no node graph).'
                    : 'Audio projects default to the SIN Node Editor (node graph + snapshots).';
            }
        }
    }

    projectKindSelect?.addEventListener('change', () => syncProjectKindEngineControls({ preserveEngine: false }));
    projectEngineSelect?.addEventListener('change', () => syncProjectKindEngineControls({ preserveEngine: true }));

    async function finishProjectCreationImport(context) {
        const sourceIds = [...new Set(context.itemIds)];
        const payload = {
            vault_id: context.vaultId,
            name: context.name,
            project_kind: context.projectKind || 'audio',
            editor_engine: context.editorEngine || null,
        };
        const url = sourceIds.length ? '/projects/from-items' : '/projects/';
        if (sourceIds.length) {
            payload.item_ids = sourceIds;
            payload.mode = 'single';
            payload.move_item_ids = [...new Set(context.moveItemIds)];
            if (context.initialSession) payload.initial_session = context.initialSession;
        }
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.detail || 'Could not create Project');
            const createdProject = Array.isArray(result) ? result[0] : result;
            const onCreated = context.onCreated || pendingProjectOnCreated;
            pendingProjectInitialSession = null;
            pendingProjectOnCreated = null;
            state.selectedEntryIds.clear();
            state.selectionAnchorId = null;
            state.projectDialogSources = [];
            state.projectSourceIds.clear();
            state.projectMoveIds.clear();
            state.projectPendingImports = [];
            state.projectPendingMoveIds.clear();
            state.projectCreationImportContext = null;
            projectDialog.close();
            await loadLibrary();
            await loadVaultImportLog();
            if (createdProject) onCreated?.(createdProject);
        } catch (error) {
            failProjectCreationImport(error.message);
        }
    }

    async function startNextProjectCreationImport() {
        const context = state.projectCreationImportContext;
        if (!context) return;
        const pending = context.pendingImports[context.index];
        if (!pending) {
            await finishProjectCreationImport(context);
            return;
        }
        setImportBusy(true);
        try {
            const job = await createImportJob(projectImportJobPayload(pending.preview));
            state.importJobId = job.job_id;
            state.importLastJob = null;
            localStorage.setItem('gaia.activeImportJobId', job.job_id);
            renderImportJob(job);
            pollImportJob();
        } catch (error) {
            failProjectCreationImport(error.message);
        }
    }

    function openProjectDialog(options = {}) {
        if (!projectDialog) return;
        const selectedSources = Array.isArray(options.sources) && options.sources.length
            ? options.sources
            : getSelectedProjectSourceEntries();
        // New Project becomes selection-aware: selected library items seed
        // the file list and the first selected item supplies the name.
        state.projectDialogSources = selectedSources;
        state.projectSourceIds = new Set(selectedSources.map(source => Number(source.item.id)));
        state.projectMoveIds.clear();
        state.projectPendingImports = [];
        state.projectPendingMoveIds.clear();
        state.projectImportPickerActive = false;
        state.projectImportInspecting = false;
        state.projectCreationImportContext = null;
        pendingProjectInitialSession = options.initialSession || null;
        pendingProjectOnCreated = typeof options.onCreated === 'function' ? options.onCreated : null;

        const inferredKind = options.projectKind || inferKindFromEntries(selectedSources);
        if (projectKindSelect) {
            projectKindSelect.value = inferredKind === 'video' ? 'video' : 'audio';
        }
        if (projectEngineSelect && options.editorEngine) {
            projectEngineSelect.value = options.editorEngine;
        }
        syncProjectKindEngineControls({ preserveEngine: Boolean(options.editorEngine) });

        projectResult.className = 'result hidden';
        projectSubmit.disabled = false;
        projectName.disabled = false;
        projectName.required = true;
        projectName.placeholder = 'e.g. My Project';
        projectName.value = options.defaultName || (selectedSources.length ? selectedSources[0].title : '');
        if (projectMoveAll) {
            projectMoveAll.checked = false;
            projectMoveAll.indeterminate = false;
        }
        projectDialogTitle.textContent = options.title || 'Create a Project';
        renderProjectSourcePreview();
        projectDialog.showModal();
        projectName.focus();
        if (selectedSources.length === 1 || options.defaultName) projectName.select();
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

    function openItemPlacementDialog(targetEntry, itemIds, { action = 'copy' } = {}) {
        const entryByItemId = new Map();
        allEntries().forEach(candidate => {
            const itemId = numericItemId(candidate);
            if (itemId && !entryByItemId.has(itemId)) entryByItemId.set(itemId, candidate);
        });
        const titles = itemIds.map(itemId => entryByItemId.get(itemId)?.title || `Item ${itemId}`);
        const isVault = Boolean(targetEntry?.isVault);
        const targetTitle = isVault ? targetEntry.vault.name : targetEntry.title;
        const targetId = isVault ? Number(targetEntry.vault.id) : Number(targetEntry.item.id);

        state.pendingPlacement = {
            targetType: isVault ? 'vault' : 'collection',
            targetId,
            targetTitle,
            action,
            itemIds,
            titles,
        };

        const actionLabel = document.getElementById('item-placement-action-label');
        const actionDesc = document.getElementById('item-placement-action-desc');
        const refLabel = document.getElementById('item-placement-ref-label');
        const refDesc = document.getElementById('item-placement-ref-desc');
        const eyebrow = document.getElementById('item-placement-eyebrow');

        if (eyebrow) eyebrow.textContent = isVault ? 'Add to vault' : 'Add to collection';
        itemPlacementTitle.textContent = `Add to ${targetTitle}`;
        itemPlacementSummary.textContent = titles.length === 1
            ? `“${titles[0]}” will be placed in ${targetTitle}.`
            : `${titles.length} items will be placed in ${targetTitle}.`;

        if (actionLabel) actionLabel.textContent = action === 'move' ? 'Full move' : 'Full copy';
        if (actionDesc) actionDesc.textContent = action === 'move'
            ? `Move the physical files into ${targetTitle}.`
            : `Copy physical files into ${targetTitle}.`;
        if (refLabel) refLabel.textContent = 'Reference only';
        if (refDesc) refDesc.textContent = `Keep original files in place. Linked items inherit future updates and versions.`;

        itemPlacementResult.className = 'result error hidden';
        itemPlacementMove.disabled = false;
        itemPlacementReference.disabled = false;
        itemPlacementClose.disabled = false;
        itemPlacementCancel.disabled = false;
        itemPlacementDialog.showModal();
    }

    async function refreshAfterPlacement(contextCollectionId, targetId, isVault, sourceCollectionIds = []) {
        const idsToRefreshProjects = new Set([
            contextCollectionId,
            targetId,
            ...(sourceCollectionIds || []),
        ].map(Number).filter(id => Number.isFinite(id) && id > 0));

        idsToRefreshProjects.forEach(id => {
            state.projectReferencedItems.delete(id);
            state.projectReferencesLoading.delete(id);
        });

        await loadLibrary({ force: false, resetNested: isVault });

        if (!isVault) {
            const expandedProjectIds = Array.from(idsToRefreshProjects).filter(id => {
                const it = catalogStore.getItem(id);
                return it && typeIsProject(it.type) && state.expandedCollections.has(String(id));
            });
            if (expandedProjectIds.length) {
                await Promise.all(expandedProjectIds.map(id => loadProjectReferencedItems(id, { reset: true })));
            }
        }
        renderFilterUI();
        renderAssets();
    }

    async function placeItemsDirectly(targetEntry, itemIds, { folder = undefined, mode = undefined } = {}) {
        const uniqueItemIds = [...new Set((itemIds || []).map(Number).filter(id => Number.isFinite(id) && id > 0))];
        if (!uniqueItemIds.length) return;

        const isVault = Boolean(targetEntry?.isVault);
        const isProject = !isVault && typeIsProject(targetEntry.item?.type || targetEntry.type);
        const resolvedMode = mode || (isProject ? 'reference' : 'move');

        const entryByItemId = new Map();
        allEntries().forEach(candidate => {
            const itemId = numericItemId(candidate);
            if (itemId && !entryByItemId.has(itemId)) entryByItemId.set(itemId, candidate);
        });

        const sourceCollectionIds = new Set();
        uniqueItemIds.forEach(id => {
            const entry = entryByItemId.get(id);
            if (entry?.collection?.id) sourceCollectionIds.add(Number(entry.collection.id));
        });

        const rawTargetId = isVault ? targetEntry.vault?.id : (targetEntry.item?.id || targetEntry.collection?.id);
        const targetId = Number(rawTargetId);
        if (!Number.isFinite(targetId) || targetId <= 0) return;

        const resolvedFolder = folder !== undefined
            ? folder
            : (targetEntry.kind === 'subfolder' ? (targetEntry.path || targetEntry.fullPath || targetEntry.title) : undefined);

        const contextCollectionId = Number(targetEntry.collection?.id || targetId);

        try {
            const url = isVault
                ? `/vaults/${targetId}/place-items`
                : `/items/${targetId}/place-items`;

            const payload = {
                item_ids: uniqueItemIds,
                mode: resolvedMode,
            };
            if (sourceCollectionIds.size) {
                payload.source_context_ids = Array.from(sourceCollectionIds);
            }
            if (resolvedFolder !== undefined) {
                payload.folder = resolvedFolder;
            }

            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.detail || 'Could not place items in folder');

            state.selectedEntryIds.clear();
            state.selectionAnchorId = null;

            if (resolvedFolder) {
                state.expandedSubfolders.add(`${contextCollectionId}:${resolvedFolder}`);
            }
            if (contextCollectionId) {
                state.expandedCollections.add(String(contextCollectionId));
            }

            await refreshAfterPlacement(contextCollectionId, targetId, isVault, Array.from(sourceCollectionIds));
        } catch (error) {
            window.alert(error.message || 'Could not place items');
        }
    }

    function placeItemOutsideContainer(entry, itemIds) {
        if (!itemIds || !itemIds.length) return;
        const activeVault = selectedVault() || state.vaults[0];
        if (entry.kind === 'subfolder') {
            const fullPath = entry.path || entry.fullPath || '';
            const idx = fullPath.lastIndexOf('/');
            const parentFolder = idx > 0 ? fullPath.slice(0, idx) : '';
            placeItemsDirectly(entry.collection, itemIds, { folder: parentFolder, mode: 'move' });
        } else if (entry.kind === 'reference' || entry.kind === 'content') {
            const parentFolder = contentFolderPath(entry);
            const idx = parentFolder.lastIndexOf('/');
            const resolvedParent = idx > 0 ? parentFolder.slice(0, idx) : '';
            if (!parentFolder && activeVault) {
                placeItemsDirectly({ isVault: true, vault: activeVault }, itemIds, { mode: 'move' });
            } else {
                placeItemsDirectly(entry.collection, itemIds, { folder: resolvedParent, mode: 'move' });
            }
        } else {
            if (activeVault) {
                placeItemsDirectly({ isVault: true, vault: activeVault }, itemIds, { mode: 'move' });
            }
        }
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
            const url = placement.targetType === 'vault'
                ? `/vaults/${placement.targetId}/place-items`
                : `/items/${placement.targetId}/place-items`;

            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ item_ids: placement.itemIds, mode }),
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.detail || 'Could not add the selected items');

            const isVault = placement.targetType === 'vault';
            const targetId = Number(placement.targetId);
            const sourceItemIds = placement.itemIds || [];

            state.pendingPlacement = null;
            state.selectedEntryIds.clear();
            state.selectionAnchorId = null;
            itemPlacementDialog.close();

            if (!isVault) {
                const target = result.target;
                const targetIndex = state.items.findIndex(item => Number(item.id) === targetId);
                if (target && targetIndex >= 0) state.items[targetIndex] = { ...state.items[targetIndex], ...target };
                state.expandedCollections.add(String(targetId));
            }

            const entryByItemId = new Map();
            allEntries().forEach(candidate => {
                const itemId = numericItemId(candidate);
                if (itemId && !entryByItemId.has(itemId)) entryByItemId.set(itemId, candidate);
            });
            const sourceCollectionIds = new Set();
            sourceItemIds.forEach(id => {
                const entry = entryByItemId.get(id);
                if (entry?.collection?.id) sourceCollectionIds.add(Number(entry.collection.id));
            });

            await refreshAfterPlacement(targetId, targetId, isVault, Array.from(sourceCollectionIds));
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

    async function moveSelectedEntriesToVault(targetVaultId, mode = 'move') {
        const itemIds = getSelectedNumericItemIds();
        if (!itemIds.length) return;
        const externalSelected = getSelectedEntries().some(entry => (
            String(entryRecord(entry)?.storage_mode || '').toLowerCase() === 'external_reference'
        ));
        if (mode === 'move' && externalSelected && !window.confirm(
            'Move these referenced files into the vault? The original files will be removed from their current locations. This cannot be undone.'
        )) return;
        stopPlayback();
        try {
            const response = await fetch('/items/move-to-vault', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    item_ids: itemIds,
                    vault_id: targetVaultId,
                    mode,
                    move_confirmed: mode !== 'move' || externalSelected,
                }),
            });
            if (!response.ok) {
                const err = await response.json().catch(() => ({}));
                throw new Error(err.detail || 'Move failed');
            }
            const movedItems = await response.json().catch(() => ([]));
            (Array.isArray(movedItems) ? movedItems : []).forEach(moved => {
                catalogStore.patchItemLocal(moved.id, moved);
            });
            state.selectedEntryIds.clear();
            await loadLibrary({ force: false });
        } catch (error) {
            window.alert(error.message);
        }
    }

    function selectedCommandEntries() {
        return getSelectedEntries();
    }

    function renderSelectionTypeActions(selectedEntries) {
        if (!selectionTypeActions) return;
        selectionTypeActions.replaceChildren();

        if (selectedEntries.length === 1 && selectedEntries[0].kind === 'asset' && typeIsProject(selectedEntries[0].type)) {
            const projectEntry = selectedEntries[0];
            const addSourcesButton = document.createElement('button');
            addSourcesButton.type = 'button';
            addSourcesButton.className = 'secondary toolbar-type-action sin-menu-item';
            addSourcesButton.textContent = 'Add files';
            addSourcesButton.title = 'Add files to project';
            addSourcesButton.setAttribute('aria-label', 'Add files to project');
            addSourcesButton.addEventListener('click', event => {
                event.stopPropagation();
                openProjectFilesDialog(projectEntry.item);
            });
            selectionTypeActions.appendChild(addSourcesButton);

            const adoptOrphansButton = document.createElement('button');
            adoptOrphansButton.type = 'button';
            adoptOrphansButton.className = 'secondary toolbar-type-action sin-menu-item';
            adoptOrphansButton.textContent = 'Adopt orphans';
            adoptOrphansButton.title = 'Move linked loose files directly into this project';
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
            loopButton.className = 'secondary toolbar-type-action sin-menu-item';
            loopButton.textContent = allLoops ? 'Set as one-shot' : 'Set as loops';
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
            moveCount.textContent = 'No selection';
            if (selectionMoveTrigger) {
                selectionMoveTrigger.disabled = true;
                selectionMoveTrigger.setAttribute('aria-expanded', 'false');
            }
            selectionMoveSubmenu?.classList.remove('is-open');
            if (selectionPlaylistTrigger) {
                selectionPlaylistTrigger.disabled = true;
                selectionPlaylistTrigger.setAttribute('aria-expanded', 'false');
            }
            selectionPlaylistSubmenu?.classList.remove('is-open');
            if (analyzeSelectionButton) analyzeSelectionButton.disabled = true;
            if (deleteSelectionButton) deleteSelectionButton.disabled = true;
            moveTargetOptions?.replaceChildren();
            playlistTargetOptions?.replaceChildren();
            if (removeFromPlaylistButton) removeFromPlaylistButton.classList.add('hidden');
            if (selectionCollectVaultButton) selectionCollectVaultButton.classList.add('hidden');
            if (selectionDissolveFolderButton) selectionDissolveFolderButton.classList.add('hidden');
            renderSelectionTypeActions([]);
            return;
        }
        moveCount.textContent = `${selectedCount} selected`;
        if (selectionMoveTrigger) selectionMoveTrigger.disabled = false;
        if (selectionPlaylistTrigger) selectionPlaylistTrigger.disabled = false;
        if (analyzeSelectionButton) analyzeSelectionButton.disabled = false;
        if (deleteSelectionButton) deleteSelectionButton.disabled = !selectedEntries.some(deletionTargetForEntry);

        const canCollectAny = selectedEntries.some(entry => (
            isEntryExternalReference(entry)
            || entry.type === 'folder'
            || entry.type === 'collection'
            || entry.kind === 'subfolder'
        ));
        if (selectionCollectVaultButton) {
            selectionCollectVaultButton.classList.toggle('hidden', !canCollectAny);
        }

        const singleEntry0 = selectedCount === 1 ? selectedEntries[0] : null;
        const singleEntry0Eff = singleEntry0 ? effectiveEntryType(singleEntry0) : '';
        const singleDissolvableFolder = Boolean(
            singleEntry0
            && singleEntry0Eff === 'folder'
            && !typeIsProject(singleEntry0.type)
            && entryFolderItemId(singleEntry0)
        );
        if (selectionDissolveFolderButton) {
            selectionDissolveFolderButton.classList.toggle('hidden', !singleDissolvableFolder);
        }

        if (moveTargetOptions) {
            moveTargetOptions.replaceChildren();
            state.vaults.forEach(vault => {
                const option = document.createElement('button');
                option.type = 'button';
                option.className = 'app-menu-item sin-menu-item';
                option.setAttribute('role', 'menuitem');
                option.textContent = vault.name;
                option.disabled = vault.id === state.selectedVaultId;
                option.title = option.disabled ? 'Already in this vault' : `Move selected assets to ${vault.name}`;
                option.addEventListener('click', async event => {
                    event.stopPropagation();
                    selectionMoveSubmenu?.classList.remove('is-open');
                    selectionMoveTrigger?.setAttribute('aria-expanded', 'false');
                    await moveSelectedEntriesToVault(vault.id);
                });
                moveTargetOptions.appendChild(option);
            });
        }

        if (playlistTargetOptions) {
            playlistTargetOptions.replaceChildren();
            const newPlBtn = document.createElement('button');
            newPlBtn.type = 'button';
            newPlBtn.className = 'app-menu-item sin-menu-item';
            newPlBtn.setAttribute('role', 'menuitem');
            newPlBtn.textContent = '＋ New playlist…';
            newPlBtn.addEventListener('click', event => {
                event.stopPropagation();
                closeAppMenus();
                const itemIds = getSelectedNumericItemIds();
                openPlaylistDialog('create', itemIds);
            });
            playlistTargetOptions.appendChild(newPlBtn);

            if (state.playlists && state.playlists.length) {
                const divider = document.createElement('div');
                divider.className = 'app-menu-divider sin-menu-divider';
                playlistTargetOptions.appendChild(divider);

                state.playlists.forEach(pl => {
                    const option = document.createElement('button');
                    option.type = 'button';
                    option.className = 'app-menu-item sin-menu-item';
                    option.setAttribute('role', 'menuitem');
                    option.textContent = pl.name;
                    option.title = `Add selected assets to ${pl.name}`;
                    option.addEventListener('click', async event => {
                        event.stopPropagation();
                        closeAppMenus();
                        const itemIds = getSelectedNumericItemIds();
                        if (itemIds.length) {
                            await addItemsToPlaylist(pl.id, itemIds);
                        }
                    });
                    playlistTargetOptions.appendChild(option);
                });
            }
        }

        if (removeFromPlaylistButton) {
            if (state.selectedPlaylistId !== null) {
                removeFromPlaylistButton.classList.remove('hidden');
                removeFromPlaylistButton.textContent = selectedCount > 1 ? `Remove (${selectedCount}) from playlist` : 'Remove from playlist';
            } else {
                removeFromPlaylistButton.classList.add('hidden');
            }
        }

        renderSelectionTypeActions(selectedEntries);
    }

    async function deleteSelectedEntries() {
        await deleteEntries(getSelectedEntries());
    }

    function versionedAssetEntries(entries) {
        return entries.filter(entry => (
            ['asset', 'content'].includes(entry.kind)
            && deletionTargetForEntry(entry)
            && entry.fileVersionGroup
            && Array.isArray(entry.fileVersions)
            && entry.fileVersions.length > 1
        ));
    }

    function resolveVersionDeletion(choice = null) {
        const pending = state.pendingVersionDeletion;
        state.pendingVersionDeletion = null;
        if (versionDeleteDialog?.open) versionDeleteDialog.close();
        pending?.resolve(choice);
    }

    function chooseVersionDeletion(versionedEntries) {
        if (!versionedEntries.length || !versionDeleteDialog) return Promise.resolve('current');
        const groupedCount = versionedEntries.length;
        const versionCount = versionedEntries.reduce((total, entry) => total + entry.fileVersions.length, 0);
        const singleEntry = groupedCount === 1 ? versionedEntries[0] : null;
        const activeEntryId = singleEntry?.kind === 'content'
            ? (numericItemId(singleEntry) || `${singleEntry.collection?.id}:${singleEntry.content?.index}`)
            : numericItemId(singleEntry);
        const activeVersion = singleEntry?.fileVersions.find(version => (
            String(version.id) === String(activeEntryId)
        ));

        versionDeleteTitle.textContent = groupedCount === 1 ? 'Delete file version?' : 'Delete selected versions?';
        versionDeleteSummary.textContent = groupedCount === 1
            ? `“${singleEntry.title}” has ${singleEntry.fileVersions.length} versions. You are viewing ${activeVersion?.label || 'the current version'}.`
            : `${groupedCount} selected assets have version sets. Choose whether to remove just the current version of each, or all ${versionCount} versions.`;
        versionDeleteCurrent.replaceChildren();
        const currentTitle = document.createElement('strong');
        currentTitle.textContent = groupedCount === 1
            ? `Delete only ${activeVersion?.label || 'current version'}`
            : 'Delete only current versions';
        const currentCopy = document.createElement('small');
        currentCopy.textContent = groupedCount === 1
            ? 'The remaining versions stay in the library.'
            : 'Each selected version set keeps its other versions.';
        versionDeleteCurrent.append(currentTitle, currentCopy);
        versionDeletePurge.replaceChildren();
        const purgeTitle = document.createElement('strong');
        purgeTitle.textContent = groupedCount === 1 ? 'Purge all versions' : 'Purge all versions in these sets';
        const purgeCopy = document.createElement('small');
        purgeCopy.textContent = groupedCount === 1
            ? `Remove all ${singleEntry.fileVersions.length} physical files for “${singleEntry.title}”.`
            : `Remove every version in the ${groupedCount} selected version sets.`;
        versionDeletePurge.append(purgeTitle, purgeCopy);

        return new Promise(resolve => {
            state.pendingVersionDeletion = { resolve };
            versionDeleteDialog.showModal();
        });
    }

    function collectionContentKey(collectionId, contentIndex) {
        return `${Number(collectionId)}:${Number(contentIndex)}`;
    }

    function deletionTargetForEntry(entry) {
        if (!entry) return null;
        if (entry.kind === 'reference') {
            const projectId = Number(entry.collection?.id);
            const referenceId = Number(entry.reference?.id);
            if (!Number.isFinite(projectId) || !Number.isFinite(referenceId)) return null;
            return {
                key: `reference:${projectId}:${referenceId}`,
                label: entry.title || entry.item?.title || 'Project link',
                locator: {
                    kind: 'reference',
                    project_id: projectId,
                    reference_id: referenceId,
                },
            };
        }
        const itemId = numericItemId(entry) || entryFolderItemId(entry);
        if (itemId) {
            return {
                key: `item:${itemId}`,
                label: entry.title || (entry.kind === 'subfolder' ? `Folder ${itemId}` : `Asset ${itemId}`),
                locator: { kind: 'item', item_id: itemId },
            };
        }
        if (entry.kind === 'content') {
            const collectionId = Number(entry.collection?.id);
            const contentIndex = Number(entry.content?.index);
            if (!Number.isFinite(collectionId) || !Number.isInteger(contentIndex)) return null;
            return {
                key: `content:${collectionContentKey(collectionId, contentIndex)}`,
                label: entry.title || entry.content?.filename || 'Nested file',
                locator: {
                    kind: 'content',
                    collection_id: collectionId,
                    content_index: contentIndex,
                },
            };
        }
        return null;
    }

    function versionRecordEntry(entry, record) {
        return entry.kind === 'content'
            ? { ...entry, content: record }
            : { ...entry, item: record };
    }

    function removeDeletedEntries(deletedEntries) {
        const itemIds = new Set(
            deletedEntries
                .filter(entry => ['item', 'content'].includes(entry.kind))
                .map(entry => Number(entry.item_id))
                .filter(Number.isFinite),
        );
        const contentKeys = new Set(
            deletedEntries
                .filter(entry => entry.kind === 'content')
                .map(entry => collectionContentKey(entry.collection_id, entry.content_index)),
        );
        const deletedReferences = deletedEntries.filter(entry => entry.kind === 'reference');
        const deletedContentCounts = new Map();
        deletedEntries.filter(entry => entry.kind === 'content').forEach(entry => {
            const collectionId = Number(entry.collection_id);
            deletedContentCounts.set(collectionId, (deletedContentCounts.get(collectionId) || 0) + 1);
        });
        if (!itemIds.size && !contentKeys.size && !deletedReferences.length) return;
        const filterStateBefore = JSON.stringify({
            vault: state.selectedVaultId,
            types: [...state.selectedTypes].sort(),
            tags: [...state.selectedTags].sort(),
        });

        deletedReferences.forEach(deleted => {
            const projectId = Number(deleted.project_id);
            const referenceId = Number(deleted.reference_id);
            const records = state.projectReferencedItems.get(projectId) || [];
            const remainingRecords = [];
            records.forEach(record => {
                const remainingVersions = (record.versions || []).filter(version => (
                    Number(version.reference?.id) !== referenceId
                ));
                if (Number(record.reference?.id) !== referenceId) {
                    remainingRecords.push({ ...record, versions: remainingVersions });
                    return;
                }
                const replacement = remainingVersions.at(-1);
                if (replacement) {
                    remainingRecords.push({
                        ...record,
                        item: replacement.item,
                        reference: replacement.reference,
                        versions: remainingVersions,
                    });
                }
            });
            state.projectReferencedItems.set(projectId, remainingRecords);
        });

        if (itemIds.size) {
            catalogStore._applyDelta({ rev: catalogStore.rev, deleted_ids: Array.from(itemIds) });
            state.items = catalogStore.getScopedRoots({
                vaultId: state.selectedVaultId,
                playlistId: state.selectedPlaylistId,
                previewMode: 'quick',
            });
            state.catalogItems = state.items;
            invalidateFacetCache();
        }
        [...state.versionSelections.entries()].forEach(([groupKey, itemId]) => {
            if (itemIds.has(Number(itemId))) state.versionSelections.delete(groupKey);
        });
        itemIds.forEach(id => {
            state.expandedCollections.delete(String(id));
            state.projectReferencedItems.delete(id);
            state.projectReferencesLoading.delete(id);
            state.projectReferenceControllers.get(id)?.abort();
            state.projectReferenceControllers.delete(id);
        });
        const availableEntryIds = new Set(allEntries().map(entry => entry.id));
        state.selectedEntryIds = new Set(
            [...state.selectedEntryIds].filter(entryId => availableEntryIds.has(entryId)),
        );
        state.contextEntry = null;
        if (!availableEntryIds.has(state.selectionAnchorId)) state.selectionAnchorId = null;

        stopPlayback();

        reconcileFilterSelection();
        renderVaults();
        renderFilterUI();
        renderAssets();
    }

    async function deleteEntries(entries) {
        const targetMap = new Map();
        const expandedEntries = [];

        function collectSubfolderLeaves(subfolder) {
            const leaves = [];
            if (subfolder.files) leaves.push(...subfolder.files);
            if (subfolder.subfolders) {
                for (const childSub of subfolder.subfolders.values()) {
                    leaves.push(...collectSubfolderLeaves(childSub));
                }
            }
            return leaves;
        }

        entries.forEach(entry => {
            if (entry.kind === 'subfolder') {
                const target = deletionTargetForEntry(entry);
                if (target) {
                    expandedEntries.push(entry);
                } else if (entry.subfolder) {
                    expandedEntries.push(...collectSubfolderLeaves(entry.subfolder));
                }
            } else {
                expandedEntries.push(entry);
            }
        });

        const versionedEntries = versionedAssetEntries(expandedEntries);

        expandedEntries.forEach(entry => {
            const target = deletionTargetForEntry(entry);
            if (target) targetMap.set(target.key, target);
        });

        if (targetMap.size === 0) return;

        const deletionMode = versionedEntries.length
            ? await chooseVersionDeletion(versionedEntries)
            : 'current';
        if (!deletionMode) return;

        if (deletionMode === 'purge') {
            versionedEntries.forEach(entry => {
                entry.fileVersions.forEach(version => {
                    const target = deletionTargetForEntry(versionRecordEntry(entry, version.record));
                    if (target) targetMap.set(target.key, {
                        ...target,
                        label: `${entry.title} ${version.label}`,
                    });
                });
            });
        }

        const targets = [...targetMap.values()];
        const count = targets.length;
        const hasFolder = entries.some(e => e.kind === 'subfolder' || e.type === 'folder' || e.content?.attributes?.is_folder);
        const onlyReferences = targets.every(target => target.locator.kind === 'reference');
        let confirmMsg;
        if (count === 1) {
            if (hasFolder) {
                confirmMsg = `Delete folder “${targets[0].label}” and its contents?`;
            } else if (onlyReferences) {
                confirmMsg = `Remove “${targets[0].label}” from this project?`;
            } else {
                confirmMsg = `Remove “${targets[0].label}” from the library?`;
            }
        } else {
            if (onlyReferences) {
                confirmMsg = `Remove ${count} selected links from their projects?`;
            } else {
                confirmMsg = `Remove ${count} selected entries?`;
            }
        }

        if (!versionedEntries.length && !window.confirm(confirmMsg)) return;

        stopPlayback();
        try {
            const response = await fetch('/items/entries/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ entries: targets.map(target => target.locator) }),
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(apiErrorMessage(result, 'Could not delete the selected entries'));
            }
            removeDeletedEntries(result.deleted || []);
            state.selectedEntryIds.clear();
            state.contextEntry = null;
            refreshSelectionPresentation();
            if (result.warnings?.length) console.warn('Deletion completed with warnings', result.warnings);
            // The delete response is authoritative. Cancel any reads that
            // started before it and reload server state so stale collection or
            // reference responses cannot recreate a blank ghost row.
            await loadLibrary({
                query: state.query || null,
                force: true,
                resetNested: true,
            });
        } catch (error) {
            window.alert(error.message || 'Delete failed');
        }
    }

    async function showOriginalFileForEntry(entry) {
        if (!entry) return;
        const targetId = entry.kind === 'reference'
            ? (entry.item?.id || entry.reference?.to_item_id)
            : (entry.item?.attributes?.source_item_id || entry.content?.attributes?.source_item_id || entry.reference?.to_item_id || entry.item?.id || entry.content?.child_id);
        if (!targetId) return;

        try {
            const response = await fetch(`/items/${targetId}/locate`);
            if (!response.ok) {
                const err = await response.json().catch(() => ({}));
                throw new Error(err.detail || 'Could not locate original file');
            }
            const location = await response.json();

            const targetVaultId = Number(location.vault_id);
            const needsVaultSwitch = state.selectedVaultId !== null && Number(state.selectedVaultId) !== targetVaultId;
            if (needsVaultSwitch) {
                state.selectedVaultId = targetVaultId;
            }
            if (state.selectedPlaylistId !== null) {
                state.selectedPlaylistId = null;
            }
            if (state.query) {
                state.query = '';
                if (searchInput) searchInput.value = '';
            }

            // Expand all ancestor collections/folders directly in RAM (0 network round-trips!)
            if (Array.isArray(location.ancestor_ids) && location.ancestor_ids.length > 0) {
                for (const ancestorId of location.ancestor_ids) {
                    state.expandedCollections.add(String(ancestorId));
                }
            }

            // Expand logical subfolder if any
            if (location.folder_path) {
                const segments = String(location.folder_path).split('/').filter(Boolean);
                let currentSubPath = '';
                const baseCollectionId = location.ancestor_ids?.[location.ancestor_ids.length - 1] || targetVaultId;
                for (const segment of segments) {
                    currentSubPath = currentSubPath ? `${currentSubPath}/${segment}` : segment;
                    state.expandedSubfolders.add(`${baseCollectionId}:${currentSubPath}`);
                }
            }

            syncViewFromCatalog();

            const resolvedItemId = Number(location.item_id);
            const foundEntry = allEntries().find(e => (
                Number(e.item?.id) === resolvedItemId
                || Number(e.itemId) === resolvedItemId
                || (e.kind === 'content' && Number(e.content?.child_id) === resolvedItemId)
            ));

            if (foundEntry) {
                state.selectedEntryIds.clear();
                state.selectedEntryIds.add(foundEntry.id);
                state.selectionAnchorId = foundEntry.id;
                refreshSelectionPresentation();
            }

            scrollToEntryOrItem({ entryId: foundEntry?.id || null, itemId: resolvedItemId, highlight: true });
        } catch (error) {
            console.error('Failed to show original file:', error);
            window.alert(error.message || 'Could not locate original file');
        }
    }

    async function openFileLocationForEntry(entry) {
        if (!entry) return;
        const itemId = numericItemId(entry) || entry.item?.id || entry.content?.child_id;
        const path = entry.path || entry.item?.absolute_path || entry.content?.source_path || null;
        try {
            const response = await fetch('/items/open-location', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    item_id: itemId ? Number(itemId) : null,
                    path: path ? String(path) : null,
                }),
            });
            if (!response.ok) {
                const err = await response.json().catch(() => ({}));
                throw new Error(err.detail || 'Could not open file location');
            }
        } catch (error) {
            console.error('Failed to open file location:', error);
            window.alert(error.message || 'Could not open file location');
        }
    }

    function closeContextMenu() {
        contextMenu?.classList.add('hidden');
    }

    function renderContextMenu() {
        if (!contextMenu) return;

        const count = (state.contextEntry && state.selectedEntryIds.has(state.contextEntry.id))
            ? state.selectedEntryIds.size
            : (state.contextEntry ? 1 : state.selectedEntryIds.size);

        if (contextSelectAllButton) {
            const hasVisibleEntries = selectionEntries().length > 0;
            contextSelectAllButton.disabled = !hasVisibleEntries;
        }

        if (copyEntryMenu) {
            const hasItemsToCopy = count > 0;
            copyEntryMenu.disabled = !hasItemsToCopy;
            copyEntryMenu.textContent = count > 1 ? `Copy (${count})` : 'Copy';
            copyEntryMenu.title = hasItemsToCopy
                ? (count > 1 ? `Copy ${count} items` : 'Copy item')
                : 'No items selected to copy';
        }

        if (pasteEntryMenu) {
            const hasClipboard = Boolean(state.clipboard?.itemIds?.length);
            const targetProject = getTargetProjectForPaste();
            pasteEntryMenu.disabled = !hasClipboard;
            if (!hasClipboard) {
                pasteEntryMenu.textContent = 'Paste';
                pasteEntryMenu.title = 'Clipboard is empty';
            } else if (targetProject) {
                const clipCount = state.clipboard.itemIds.length;
                pasteEntryMenu.textContent = clipCount > 1 ? `Paste (${clipCount})` : 'Paste';
                pasteEntryMenu.title = `Paste into ${targetProject.title}`;
            } else {
                pasteEntryMenu.textContent = 'Paste';
                pasteEntryMenu.title = 'Select a project to paste into';
            }
        }

        const selectedEntries = getSelectedEntries();
        const targetEntry = state.contextEntry || (selectedEntries.length === 1 ? selectedEntries[0] : null);
        const editorOpenableTypes = new Set(['project', 'audio', 'track', 'sample', 'video', 'multitrack', 'zoom_h4', 'folder', 'collection']);
        const targetItemType = targetEntry?.item?.type || targetEntry?.type || '';
        const isOpenableEntry = Boolean(
            count === 1
            && targetEntry
            && (
                (targetEntry.kind === 'content' && (targetEntry.content?.streamable || targetEntry.content?.child_id))
                || editorOpenableTypes.has(targetItemType)
            )
        );
        const isProjectTarget = Boolean(isOpenableEntry && typeIsProject(targetItemType));
        if (contextOpenEditorButton) {
            contextOpenEditorButton.classList.toggle('hidden', !isOpenableEntry);
            contextOpenEditorButton.disabled = !isOpenableEntry;
            contextOpenEditorButton.textContent = isProjectTarget ? 'Open Project in Editor' : 'Open in Editor';
        }
        if (contextOpenScratchButton) {
            contextOpenScratchButton.classList.toggle('hidden', !isProjectTarget);
            contextOpenScratchButton.disabled = !isProjectTarget;
        }
        if (contextGoToLocationButton) {
            const hasLocation = Boolean(targetEntry && (
                targetEntry.path
                || targetEntry.item?.absolute_path
                || targetEntry.content?.source_path
                || numericItemId(targetEntry)
            ));
            contextGoToLocationButton.disabled = !hasLocation;
            contextGoToLocationButton.title = hasLocation ? 'Open file location in OS file explorer' : 'No item selected';
        }

        if (contextShowOriginalButton) {
            const canShowOriginal = count === 1 && targetEntry && (
                targetEntry.kind === 'reference'
                || Boolean(targetEntry.reference)
                || Boolean(targetEntry.item?.attributes?.source_item_id || targetEntry.content?.attributes?.source_item_id)
            );
            if (canShowOriginal) {
                contextShowOriginalButton.classList.remove('hidden');
                contextShowOriginalButton.disabled = false;
            } else {
                contextShowOriginalButton.classList.add('hidden');
                contextShowOriginalButton.disabled = true;
            }
        }

        if (analyzeEntryButton) {
            analyzeEntryButton.disabled = count === 0;
            analyzeEntryButton.textContent = count > 1 ? `Analyze metadata (${count} items)` : 'Analyze metadata';
        }
        if (deleteEntryMenuButton) {
            deleteEntryMenuButton.disabled = count === 0;
            deleteEntryMenuButton.textContent = count > 1 ? `Delete selected (${count})` : 'Delete selected';
        }

        const isSingleContainer = count === 1 && targetEntry && (
            typeIsContainer(targetEntry.type)
            || targetEntry.type === 'collection'
            || targetEntry.type === 'folder'
            || targetEntry.kind === 'subfolder'
            || Boolean(targetEntry.item?.attributes?.is_folder || targetEntry.content?.attributes?.is_folder)
        );

        if (contextNewFolderButton) {
            if (count <= 1) {
                contextNewFolderButton.classList.remove('hidden');
                contextNewFolderButton.disabled = false;
                if (isSingleContainer) {
                    contextNewFolderButton.textContent = `New folder in ${targetEntry.title || targetEntry.name}`;
                    contextNewFolderButton.title = `Create a folder inside ${targetEntry.title || targetEntry.name}`;
                } else {
                    contextNewFolderButton.textContent = 'New folder';
                    contextNewFolderButton.title = 'Create a folder in the active vault';
                }
            } else {
                contextNewFolderButton.classList.add('hidden');
            }
        }

        if (contextMakeFolderMoveButton) {
            if (count > 1) {
                contextMakeFolderMoveButton.classList.remove('hidden');
                contextMakeFolderMoveButton.disabled = false;
                contextMakeFolderMoveButton.textContent = `Make folder and move (${count})`;
                contextMakeFolderMoveButton.title = `Create a folder and move ${count} selected items into it`;
            } else {
                contextMakeFolderMoveButton.classList.add('hidden');
            }
        }

        const canCollectContext = selectedEntries.some(entry => (
            isEntryExternalReference(entry)
            || entry.type === 'folder'
            || entry.type === 'collection'
            || entry.kind === 'subfolder'
        ));
        if (contextCollectVaultButton) {
            if (canCollectContext && count > 0) {
                contextCollectVaultButton.classList.remove('hidden');
                contextCollectVaultButton.disabled = false;
                contextCollectVaultButton.textContent = count > 1 ? `Collect into vault (${count})` : 'Collect into vault';
            } else {
                contextCollectVaultButton.classList.add('hidden');
            }
        }

        const canDissolveFolder = Boolean(
            count === 1
            && targetEntry
            && effectiveEntryType(targetEntry) === 'folder'
            && !typeIsProject(targetEntry.type)
            && entryFolderItemId(targetEntry)
        );
        if (contextDissolveFolderButton) {
            if (canDissolveFolder) {
                contextDissolveFolderButton.classList.remove('hidden');
                contextDissolveFolderButton.disabled = false;
                contextDissolveFolderButton.textContent = `Dissolve folder “${targetEntry.title || targetEntry.name}”`;
            } else {
                contextDissolveFolderButton.classList.add('hidden');
            }
        }

        if (contextPlaylistOptions) {
            contextPlaylistOptions.replaceChildren();
            const plHeader = document.createElement('div');
            plHeader.style.cssText = 'padding: 4px 10px; font-size: 11px; opacity: 0.6; text-transform: uppercase; font-weight: 600; letter-spacing: 0.05em;';
            plHeader.textContent = 'Add to playlist';
            contextPlaylistOptions.appendChild(plHeader);

            const newPlBtn = document.createElement('button');
            newPlBtn.type = 'button';
            newPlBtn.className = 'app-menu-item sin-menu-item';
            newPlBtn.setAttribute('role', 'menuitem');
            newPlBtn.textContent = '＋ New playlist…';
            newPlBtn.addEventListener('click', event => {
                event.stopPropagation();
                closeContextMenu();
                const selectedIds = getSelectedNumericItemIds();
                const singleId = entryNumericId(state.contextEntry);
                const targetIds = (state.contextEntry && state.selectedEntryIds.has(state.contextEntry.id))
                    ? selectedIds
                    : (singleId ? [singleId] : (selectedIds.length ? selectedIds : []));
                openPlaylistDialog('create', targetIds);
            });
            contextPlaylistOptions.appendChild(newPlBtn);

            if (state.playlists && state.playlists.length) {
                state.playlists.forEach(pl => {
                    const opt = document.createElement('button');
                    opt.type = 'button';
                    opt.className = 'app-menu-item sin-menu-item';
                    opt.setAttribute('role', 'menuitem');
                    opt.textContent = pl.name;
                    opt.addEventListener('click', async event => {
                        event.stopPropagation();
                        closeContextMenu();
                        const selectedIds = getSelectedNumericItemIds();
                        const singleId = entryNumericId(state.contextEntry);
                        const targetIds = (state.contextEntry && state.selectedEntryIds.has(state.contextEntry.id))
                            ? selectedIds
                            : (singleId ? [singleId] : (selectedIds.length ? selectedIds : []));
                        if (targetIds.length) {
                            await addItemsToPlaylist(pl.id, targetIds);
                        }
                    });
                    contextPlaylistOptions.appendChild(opt);
                });
            }
        }
    }

    function openFolderDialog({ parentEntry = null, itemIds = [], referenceIds = [] } = {}) {
        const activeVault = selectedVault() || state.vaults[0];
        state.pendingFolderCreation = {
            parentEntry,
            itemIds,
            referenceIds,
            vaultId: parentEntry?.item?.vault_id ?? activeVault?.id ?? null,
        };
        if (folderNameInput) folderNameInput.value = '';
        if (folderDialogResult) {
            folderDialogResult.className = 'result hidden';
            folderDialogResult.textContent = '';
        }
        const totalCount = (itemIds.length || 0) + (referenceIds.length || 0);
        if (folderDialogTitle) {
            if (totalCount > 0) {
                folderDialogTitle.textContent = `Make folder and move (${totalCount})`;
            } else if (parentEntry) {
                folderDialogTitle.textContent = `New folder in ${parentEntry.title || parentEntry.name}`;
            } else {
                folderDialogTitle.textContent = 'Create a folder';
            }
        }
        if (folderDialogHelp) {
            if (totalCount > 0) {
                folderDialogHelp.textContent = `Creates a new folder and moves the ${totalCount} selected asset(s) into it.`;
            } else if (parentEntry) {
                folderDialogHelp.textContent = `The folder will be created inside "${parentEntry.title || parentEntry.name}".`;
            } else {
                const vault = selectedVault();
                folderDialogHelp.textContent = vault
                    ? `The folder will be created in "${vault.name}".`
                    : 'The folder will be created in the active vault.';
            }
        }
        if (folderDialogSubmit) {
            folderDialogSubmit.textContent = totalCount > 0 ? 'Make folder and move' : 'Create folder';
        }
        folderDialog?.showModal();
        folderNameInput?.focus();
    }

    function selectedVault() {
        return state.vaults.find(vault => vault.id === state.selectedVaultId);
    }

    function selectedPlaylist() {
        if (state.selectedPlaylistId === null) return null;
        return state.playlists.find(pl => pl.id === state.selectedPlaylistId) || null;
    }

    async function loadPlaylists({ signal } = {}) {
        try {
            const res = await fetch('/playlists/', { signal });
            if (!res.ok) return [];
            state.playlists = await res.json();
            return state.playlists;
        } catch (err) {
            if (err.name !== 'AbortError') console.error('Failed to load playlists:', err);
            return [];
        }
    }

    let pendingPlaylistAddIds = [];
    let playlistDialogMode = 'create';

    function openPlaylistDialog(mode = 'create', itemIds = []) {
        playlistDialogMode = mode;
        pendingPlaylistAddIds = (itemIds || []).map(Number).filter(id => Number.isFinite(id) && id > 0);
        const pl = selectedPlaylist();
        if (mode === 'rename' && !pl) return;

        if (playlistDialogTitle) playlistDialogTitle.textContent = mode === 'rename' ? 'Rename playlist' : 'New playlist';
        if (playlistDialogSubmit) playlistDialogSubmit.textContent = mode === 'rename' ? 'Save changes' : 'Create playlist';
        if (playlistNameInput) {
            playlistNameInput.value = mode === 'rename' ? pl.name : '';
            playlistNameInput.select();
        }
        playlistDialogResult?.classList.add('hidden');
        playlistDialog?.showModal();
        playlistNameInput?.focus();
    }

    async function handlePlaylistFormSubmit(event) {
        event.preventDefault();
        const name = playlistNameInput?.value?.trim();
        if (!name) return;

        try {
            if (playlistDialogMode === 'create') {
                const res = await fetch('/playlists/', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name }),
                });
                if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    throw new Error(err.detail || 'Could not create playlist');
                }
                const created = await res.json();
                const addIds = [...pendingPlaylistAddIds];
                pendingPlaylistAddIds = [];
                if (addIds.length) {
                    await fetch(`/playlists/${created.id}/items`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ item_ids: addIds }),
                    });
                }
                playlistDialog?.close();
                await loadPlaylists();
                state.selectedVaultId = null;
                state.selectedPlaylistId = created.id;
                renderVaultMenu();
                await loadLibrary({ force: true, resetNested: true });
            } else if (playlistDialogMode === 'rename') {
                const pl = selectedPlaylist();
                if (!pl) return;
                const res = await fetch(`/playlists/${pl.id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name }),
                });
                if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    throw new Error(err.detail || 'Could not rename playlist');
                }
                playlistDialog?.close();
                await loadPlaylists();
                renderVaultMenu();
            }
        } catch (err) {
            if (playlistDialogResult) {
                playlistDialogResult.textContent = err.message;
                playlistDialogResult.classList.remove('hidden');
            }
        }
    }

    async function addItemsToPlaylist(playlistId, itemIds) {
        if (!itemIds || !itemIds.length) return;
        try {
            const res = await fetch(`/playlists/${playlistId}/items`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ item_ids: itemIds }),
            });
            if (!res.ok) throw new Error('Failed to add items to playlist');
            const data = await res.json();
            await loadPlaylists();
            renderVaultMenu();
            if (summary) {
                const count = data.added_count;
                summary.textContent = `Added ${count} ${count === 1 ? 'item' : 'items'} to playlist`;
            }
        } catch (err) {
            console.error('Error adding to playlist:', err);
        }
    }

    async function deleteActivePlaylist() {
        const pl = selectedPlaylist();
        if (!pl) return;
        if (!confirm(`Are you sure you want to delete the playlist "${pl.name}"?\n(Assets inside vaults will not be deleted)`)) return;
        try {
            const res = await fetch(`/playlists/${pl.id}`, { method: 'DELETE' });
            if (!res.ok) throw new Error('Failed to delete playlist');
            state.selectedPlaylistId = null;
            await loadPlaylists();
            renderVaultMenu();
            await loadLibrary({ force: true, resetNested: true });
        } catch (err) {
            console.error('Error deleting playlist:', err);
        }
    }

    function closeVaultMenu() {
        vaultMenu?.classList.add('hidden');
        vaultPicker?.setAttribute('aria-expanded', 'false');
    }

    function selectVaultOption(value) {
        state.selectedPlaylistId = null;
        state.selectedVaultId = value;
        closeVaultMenu();
        syncViewFromCatalog();
        if (assetList) assetList.scrollTop = 0;
        scheduleVaultSyncCheck(value, 250);
    }

    function selectPlaylistOption(playlistId) {
        state.selectedVaultId = null;
        state.selectedPlaylistId = playlistId;
        closeVaultMenu();
        syncViewFromCatalog();
        if (assetList) assetList.scrollTop = 0;
    }

    function renderSidebar() {
        const showAll = state.selectedVaultId === null && state.selectedPlaylistId === null;
        if (sidebarVaultList) {
            sidebarVaultList.replaceChildren();
            const addSidebarVault = (value, label, selected) => {
                const item = document.createElement('button');
                item.type = 'button';
                item.className = `sidebar-nav-item${selected ? ' active' : ''}`;
                item.setAttribute('role', 'listitem');
                item.setAttribute('aria-current', selected ? 'true' : 'false');
                const text = document.createElement('span');
                text.className = 'sidebar-nav-item-label';
                text.textContent = label;
                item.appendChild(text);
                item.addEventListener('click', () => selectVaultOption(value));
                sidebarVaultList.appendChild(item);
            };

            addSidebarVault(null, 'Show all', showAll);
            state.vaults.forEach(vault => {
                const isSelectedVault = state.selectedPlaylistId === null && vault.id === state.selectedVaultId;
                addSidebarVault(vault.id, vault.name, isSelectedVault);

                const mirrors = Array.isArray(vault.mirrors) ? vault.mirrors : [];
                const topFolders = isSelectedVault
                    ? state.items.filter(item => Number(item.vault_id) === Number(vault.id) && (typeIsContainer(item.type) || item.type === 'folder' || item.type === 'collection'))
                    : [];
                if (mirrors.length > 0 || topFolders.length > 0) {
                    const tree = document.createElement('div');
                    tree.className = 'sidebar-vault-tree';
                    const mirrorRootIds = new Set(mirrors.map(m => Number(m.root_item_id)).filter(Boolean));
                    mirrors.forEach(mirror => {
                        const btn = document.createElement('button');
                        btn.type = 'button';
                        btn.className = `sidebar-folder-item${mirror.mirror_mode === 'reference_1to1' ? ' is-referenced' : ''}`;
                        btn.title = `${mirror.source_path} (${mirror.mirror_mode === 'distill_copy' ? 'Distill & Copy' : '1-1 Reference'})`;
                        const labelSpan = document.createElement('span');
                        labelSpan.className = 'sidebar-folder-label';
                        labelSpan.textContent = mirror.target_folder_path || filename(mirror.source_path);
                        const badgeSpan = document.createElement('span');
                        badgeSpan.className = 'sidebar-mirror-badge';
                        badgeSpan.textContent = '⇄';
                        btn.append(labelSpan, badgeSpan);
                        btn.addEventListener('click', event => {
                            event.stopPropagation();
                            if (state.selectedVaultId !== vault.id || state.selectedPlaylistId !== null) {
                                selectVaultOption(vault.id);
                            }
                            if (mirror.root_item_id) {
                                state.expandedCollections.add(String(mirror.root_item_id));
                                renderAssets();
                                scrollToEntryOrItem({ itemId: mirror.root_item_id, highlight: true });
                            }
                        });
                        tree.appendChild(btn);
                    });

                    topFolders
                        .filter(folder => !mirrorRootIds.has(Number(folder.id)))
                        .slice(0, 20)
                        .forEach(folder => {
                            const btn = document.createElement('button');
                            btn.type = 'button';
                            const isRef = String(folder.storage_mode || '').toLowerCase() === 'external_reference';
                            btn.className = `sidebar-folder-item${isRef ? ' is-referenced' : ''}`;
                            btn.title = folder.title || filename(folder.absolute_path);
                            const labelSpan = document.createElement('span');
                            labelSpan.className = 'sidebar-folder-label';
                            labelSpan.textContent = folder.title || filename(folder.absolute_path);
                            btn.appendChild(labelSpan);
                            btn.addEventListener('click', event => {
                                event.stopPropagation();
                                const idStr = String(folder.id);
                                if (state.expandedCollections.has(idStr)) {
                                    state.expandedCollections.delete(idStr);
                                } else {
                                    state.expandedCollections.add(idStr);
                                    if (typeIsProject(folder.type)) loadProjectReferencedItems(folder.id);
                                }
                                renderAssets();
                                scrollToEntryOrItem({ itemId: folder.id, highlight: true });
                            });
                            tree.appendChild(btn);
                        });
                    sidebarVaultList.appendChild(tree);
                }
            });
        }

        if (sidebarPlaylistList) {
            sidebarPlaylistList.replaceChildren();
            if (state.playlists && state.playlists.length) {
                state.playlists.forEach(pl => {
                    const selected = state.selectedPlaylistId === pl.id;
                    const item = document.createElement('button');
                    item.type = 'button';
                    item.className = `sidebar-nav-item${selected ? ' active' : ''}`;
                    item.setAttribute('role', 'listitem');
                    item.setAttribute('aria-current', selected ? 'true' : 'false');
                    const label = document.createElement('span');
                    label.className = 'sidebar-nav-item-label';
                    label.textContent = pl.name;
                    const count = document.createElement('span');
                    count.className = 'sidebar-nav-item-count';
                    count.textContent = String(pl.item_count ?? 0);
                    item.append(label, count);
                    item.addEventListener('click', () => selectPlaylistOption(pl.id));
                    sidebarPlaylistList.appendChild(item);
                });
            } else {
                const empty = document.createElement('div');
                empty.className = 'sidebar-empty';
                empty.textContent = 'No playlists';
                sidebarPlaylistList.appendChild(empty);
            }
        }
    }

    function renderVaultMenu() {
        const activeVault = selectedVault();
        const activePlaylist = selectedPlaylist();
        const showAll = state.selectedVaultId === null && state.selectedPlaylistId === null;
        if (activeVaultName) {
            if (activePlaylist) activeVaultName.textContent = `Playlist: ${activePlaylist.name}`;
            else activeVaultName.textContent = activeVault?.name || 'Show all';
        }
        if (vaultMenuDeleteButton) {
            vaultMenuDeleteButton.disabled = !activeVault || state.vaults.length <= 1;
            vaultMenuDeleteButton.title = state.vaults.length <= 1 ? 'The last vault cannot be deleted' : 'Delete active vault';
        }
        if (vaultMenuOptionsButton) vaultMenuOptionsButton.disabled = !activeVault;
        if (playlistMenuRenameButton) playlistMenuRenameButton.disabled = !activePlaylist;
        if (playlistMenuDeleteButton) playlistMenuDeleteButton.disabled = !activePlaylist;

        renderSidebar();

        if (!vaultMenuList) return;
        vaultMenuList.replaceChildren();
        const addOption = (value, label, selected) => {
            const option = document.createElement('button');
            option.type = 'button';
            option.className = `vault-menu-option sin-menu-item${selected ? ' active' : ''}`;
            option.setAttribute('role', 'option');
            option.setAttribute('aria-selected', String(selected));
            const text = document.createElement('span');
            text.textContent = label;
            option.append(text);
            option.addEventListener('click', event => {
                event.stopPropagation();
                selectVaultOption(value);
            });

            vaultMenuList.appendChild(option);
        };

        addOption(null, 'Show all', showAll);
        if (state.vaults.length) {
            const divider = document.createElement('div');
            divider.className = 'vault-menu-divider sin-menu-divider';
            divider.setAttribute('aria-hidden', 'true');
            vaultMenuList.appendChild(divider);
        }
        state.vaults.forEach(vault => addOption(vault.id, vault.name, state.selectedPlaylistId === null && vault.id === state.selectedVaultId));
    }

    function renderVaultDialogMirrors() {
        if (!vaultMirrorsList) return;
        vaultMirrorsList.replaceChildren();
        const activeVault = selectedVault();
        const mirrors = vaultDialogMode === 'rename'
            ? (Array.isArray(activeVault?.mirrors) ? activeVault.mirrors : [])
            : (Array.isArray(state.stagedVaultMirrors) ? state.stagedVaultMirrors : []);

        if (!mirrors.length) {
            const empty = document.createElement('div');
            empty.className = 'help';
            empty.textContent = 'No mirrored folders configured for this vault.';
            vaultMirrorsList.appendChild(empty);
            return;
        }

        mirrors.forEach((mirror, index) => {
            const row = document.createElement('div');
            row.className = 'vault-mirror-row';
            const modeLabel = mirror.mirror_mode === 'distill_copy' ? 'Distill & Copy' : '1-1 Reference';
            const targetFolder = mirror.target_folder_path || filename(mirror.source_path);
            row.innerHTML = `
                <div class="vault-mirror-info">
                    <span class="vault-mirror-path" title="${escapeHtml(mirror.source_path)}">${escapeHtml(mirror.source_path)}</span>
                    <div class="vault-mirror-meta">
                        <span class="vault-mirror-badge">${escapeHtml(modeLabel)}</span>
                        <span>→ /${escapeHtml(targetFolder)}</span>
                    </div>
                </div>
                <div class="vault-mirror-actions">
                    ${vaultDialogMode === 'rename' && mirror.id ? `<button type="button" class="sync-action-btn" data-dialog-sync-mirror="${mirror.id}">Sync</button>` : ''}
                    <button type="button" class="sync-action-btn danger-action" data-dialog-remove-mirror="${vaultDialogMode === 'rename' ? mirror.id : index}">Remove</button>
                </div>
            `;
            vaultMirrorsList.appendChild(row);
        });
    }

    function openVaultDialog(mode) {
        const activeVault = selectedVault();
        if (mode === 'rename' && !activeVault) return;
        vaultDialogMode = mode;
        state.stagedVaultMirrors = [];
        if (vaultMirrorSourceInput) vaultMirrorSourceInput.value = '';
        if (vaultMirrorTargetInput) vaultMirrorTargetInput.value = '';
        if (vaultMirrorModeSelect) vaultMirrorModeSelect.value = 'reference_1to1';
        if (vaultDialogEyebrow) vaultDialogEyebrow.textContent = mode === 'rename' ? 'Vault options' : 'New vault';
        if (vaultDialogTitle) vaultDialogTitle.textContent = mode === 'rename' ? 'Vault options' : 'Create a vault';
        if (vaultDialogSubmit) vaultDialogSubmit.textContent = mode === 'rename' ? 'Save changes' : 'Create vault';
        if (vaultNameInput) {
            vaultNameInput.value = mode === 'rename' ? activeVault.name : '';
            vaultNameInput.select();
        }
        if (vaultPathInput) {
            vaultPathInput.value = mode === 'rename' ? activeVault.path : '';
            vaultPathInput.title = vaultPathInput.value || 'GAIA will use its standard asset folder';
        }
        if (vaultPathLabel) vaultPathLabel.textContent = mode === 'rename' ? 'Vault path' : 'Storage root';
        if (vaultPathAction) vaultPathAction.textContent = mode === 'rename' ? 'Migrate' : 'Choose storage root';
        if (vaultPathHelp) {
            vaultPathHelp.textContent = mode === 'rename'
                ? 'Migration moves the complete vault and updates every tracked managed path.'
                : 'GAIA creates a storage-key folder for this vault inside the selected root. Leave it unchanged to use the standard asset folder.';
        }
        if (vaultPreviewSelect) vaultPreviewSelect.value = mode === 'rename' ? activeVault.preview : 'quick';
        renderVaultDialogMirrors();
        if (mode === 'rename' && activeVault?.id) {
            fetch(`/vaults/${activeVault.id}/mirrors`)
                .then(res => res.ok ? res.json() : null)
                .then(mirrors => {
                    if (Array.isArray(mirrors)) {
                        activeVault.mirrors = mirrors;
                        renderVaultDialogMirrors();
                        renderSidebar();
                    }
                })
                .catch(() => { });
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

    async function createVaultRecord(name, path = null, preview = 'quick', mirrors = null) {
        const payload = { name, description: null, path: path || null, preview };
        if (Array.isArray(mirrors) && mirrors.length) {
            payload.mirrors = mirrors;
        }
        const response = await fetch('/vaults/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
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
                    body: JSON.stringify({
                        name,
                        description: activeVault.description || null,
                        preview: vaultPreviewSelect?.value || 'quick',
                    }),
                });
                const updated = await response.json().catch(() => ({}));
                if (!response.ok) throw new Error(updated.detail || 'Could not rename vault');
                state.vaults = state.vaults.map(vault => vault.id === updated.id ? updated : vault);
            } else {
                const pendingSource = vaultMirrorSourceInput?.value.trim();
                const stagedMirrors = Array.isArray(state.stagedVaultMirrors) ? [...state.stagedVaultMirrors] : [];
                if (pendingSource) {
                    stagedMirrors.push({
                        source_path: pendingSource,
                        target_folder_path: vaultMirrorTargetInput?.value.trim() || '',
                        mirror_mode: vaultMirrorModeSelect?.value || 'reference_1to1',
                        enabled: true,
                    });
                }
                const vault = await createVaultRecord(
                    name,
                    vaultPathInput?.value.trim() || null,
                    vaultPreviewSelect?.value || 'quick',
                    stagedMirrors,
                );
                state.vaults.push(vault);
                state.selectedVaultId = vault.id;
                state.importVaultId = vault.id;
            }
            vaultDialog?.close();
            reconcileFilterSelection();
            renderVaults();
            renderFilterUI();
            renderAssets();
            loadLibrary({ force: true, resetNested: true });
        } catch (error) {
            showVaultDialogError(error.message || 'Could not save vault');
        } finally {
            if (vaultDialogSubmit) {
                vaultDialogSubmit.disabled = false;
                vaultDialogSubmit.textContent = vaultDialogMode === 'rename' ? 'Save changes' : 'Create vault';
            }
        }
    }

    async function migrateActiveVault(path) {
        const activeVault = selectedVault();
        if (!activeVault || !path) return;
        if (vaultPathAction) {
            vaultPathAction.disabled = true;
            vaultPathAction.textContent = 'Migrating…';
        }
        try {
            const response = await fetch(`/vaults/${activeVault.id}/migrate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path }),
            });
            const updated = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(updated.detail || 'Could not migrate vault');
            state.vaults = state.vaults.map(vault => vault.id === updated.id ? updated : vault);
            if (vaultPathInput) {
                vaultPathInput.value = updated.path;
                vaultPathInput.title = updated.path;
            }
            renderVaults();
            await loadLibrary({ force: true, resetNested: true });
        } catch (error) {
            showVaultDialogError(error.message || 'Could not migrate vault');
        } finally {
            if (vaultPathAction) {
                vaultPathAction.disabled = false;
                vaultPathAction.textContent = 'Migrate';
            }
        }
    }

    async function deleteActiveVault() {
        const activeVault = selectedVault();
        if (!activeVault || state.vaults.length <= 1) return;
        if (!window.confirm(`Delete the vault “${activeVault.name}” and every file it contains? This cannot be undone.`)) return;
        if (vaultMenuDeleteButton) vaultMenuDeleteButton.disabled = true;
        try {
            const response = await fetch(`/vaults/${activeVault.id}?delete_contents=true`, { method: 'DELETE' });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.detail || 'Could not delete vault');
            state.vaults = state.vaults.filter(vault => vault.id !== activeVault.id);
            state.selectedVaultId = null;
            if (state.importVaultId === activeVault.id) state.importVaultId = state.vaults[0]?.id ?? null;
            reconcileFilterSelection();
            renderVaults();
            renderFilterUI();
            renderAssets();
            loadLibrary({ force: true, resetNested: true });
        } catch (error) {
            window.alert(error.message || 'Could not delete vault');
            renderVaultMenu();
        }
    }

    const vaultReconciler = window.GaiaVaultReconciler?.init({ state, loadLibrary });

    function checkVaultSync(vaultId = state.selectedVaultId) {
        return vaultReconciler?.checkVaultSync(vaultId);
    }

    function scheduleVaultSyncCheck(vaultId = state.selectedVaultId, delayMs = 120) {
        if (vaultReconciler?.scheduleVaultSyncCheck) {
            return vaultReconciler.scheduleVaultSyncCheck(vaultId, delayMs);
        }
        return vaultReconciler?.checkVaultSync(vaultId);
    }

    function renderSyncPill(status) {
        return vaultReconciler?.renderSyncPill(status);
    }

    function closeVaultSyncDialog() {
        return vaultReconciler?.closeVaultSyncDialog();
    }

    async function openVaultSyncDialog() {
        return vaultReconciler?.openVaultSyncDialog();
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
            option.textContent = 'Create new vault…';
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
        createOption.textContent = 'Create new vault…';
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

    async function loadVaults({ signal } = {}) {
        const response = await fetch('/vaults/', { signal });
        if (!response.ok) throw new Error('GAIA could not load vaults');
        state.vaults = await response.json();
        renderVaults();
    }

    async function loadVaultImportLog() {
        // Import history is now written per job under gaia/log/imports.
    }

    function syncViewFromCatalog({ resetProjects = false, changedProjectIds = [] } = {}) {
        if (!catalogStore.ready) return;
        state.vaults = catalogStore.vaults;
        state.playlists = catalogStore.playlists;
        state.types = catalogStore.types;
        state.items = catalogStore.getScopedRoots({
            vaultId: state.selectedVaultId,
            playlistId: state.selectedPlaylistId,
            previewMode: 'quick',
        });
        state.catalogItems = state.items;

        if (resetProjects) {
            state.projectReferenceControllers.forEach(activeController => activeController.abort());
            state.projectReferencedItems.clear();
            state.projectReferencesLoading.clear();
            state.projectReferenceControllers.clear();
        } else if (changedProjectIds.length) {
            changedProjectIds.forEach(pid => {
                const numId = Number(pid);
                state.projectReferencedItems.delete(numId);
                if (state.expandedCollections.has(String(numId))) {
                    loadProjectReferencedItems(numId, { reset: true });
                }
            });
        }

        invalidateFacetCache();
        reconcileFilterSelection();
        renderVaults();
        renderFilterUI();
        renderAssets();

        // Keep selection pruned to existing items without rebuilding unused subtrees
        if (state.selectedEntryIds.size) {
            const visibleIds = new Set(allEntries().map(e => e.id));
            let changed = false;
            state.selectedEntryIds.forEach(id => {
                if (!visibleIds.has(id)) {
                    state.selectedEntryIds.delete(id);
                    changed = true;
                }
            });
            if (state.selectionAnchorId && !visibleIds.has(state.selectionAnchorId)) {
                state.selectionAnchorId = null;
            }
            if (changed) refreshSelectionPresentation();
        }

        // Load project reference tables only for currently expanded projects
        for (let i = 0; i < state.items.length; i++) {
            const item = state.items[i];
            if (typeIsProject(item.type) && state.expandedCollections.has(String(item.id))) {
                loadProjectReferencedItems(item.id);
            }
        }
    }

    catalogStore.onChange(({ changedProjectIds }) => {
        syncViewFromCatalog({ changedProjectIds: changedProjectIds || [] });
    });

    async function loadLibrary({
        force = false,
        resetNested = false,
    } = {}) {
        if (!force && state.libraryLoadPromise) return state.libraryLoadPromise;
        if (resetNested) resetNestedLibraryCaches();

        const requestPromise = (async () => {
            const hasExistingLibrary = catalogStore.ready && state.items.length > 0;
            if (!hasExistingLibrary) {
                summary.textContent = 'Loading library…';
            }
            try {
                if (!catalogBooted) {
                    catalogBooted = true;
                    await catalogStore.boot({ connectEvents: true });
                } else {
                    await catalogStore.sync({ forceSnapshot: Boolean(force) });
                }
                syncViewFromCatalog({ resetProjects: Boolean(resetNested) });
            } catch (error) {
                if (error?.name === 'AbortError') return;
                if (!catalogStore.ready) {
                    assetList.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
                }
                summary.textContent = catalogStore.ready ? `Library update failed: ${error.message}` : 'Library unavailable';
            }
        })();
        state.libraryLoadPromise = requestPromise;
        try {
            await requestPromise;
        } finally {
            if (state.libraryLoadPromise === requestPromise) {
                state.libraryLoadPromise = null;
            }
        }
    }

    let currentAnalysisPollTimer = null;
    let currentAnalysisTaskId = null;
    let currentAnalysisUpdateCursor = 0;

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
        const loadedChildCount = Array.isArray(entry.item?.contents)
            ? entry.item.contents.length
            : Number(entry.item?.content_count || 0);
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
        currentAnalysisUpdateCursor = 0;
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
                if (progressDetail) {
                    const failureCount = Number(data.failed || 0);
                    const firstFailure = Array.isArray(data.errors) && data.errors.length ? data.errors[0]?.error : '';
                    progressDetail.textContent = data.current_title
                        ? `Current: ${data.current_title}`
                        : failureCount
                            ? `${failureCount} item${failureCount === 1 ? '' : 's'} failed${firstFailure ? ` · ${firstFailure}` : ''}`
                            : (data.status === 'completed' ? 'Analysis complete' : 'Processing...');
                }

                const allUpdates = Array.isArray(data.updated_items) ? data.updated_items : [];
                const newUpdates = allUpdates.slice(currentAnalysisUpdateCursor);
                currentAnalysisUpdateCursor = allUpdates.length;
                if (newUpdates.length > 0) {
                    newUpdates.forEach(update => {
                        if (update.kind === 'content') {
                            const entry = allEntries().find(e => e.kind === 'content' && e.collection.id === update.item_id && e.content.index === update.content_index);
                            if (entry) updateEntryInState(entry, update.content);
                        } else if (update.kind === 'item' && update.item_id) {
                            const index = state.items.findIndex(item => Number(item.id) === Number(update.item_id));
                            if (index >= 0) state.items[index] = { ...state.items[index], ...update.item };
                        }
                    });
                    renderFilterUI();
                    renderAssets();
                }

                if (data.status === 'completed' || data.status === 'cancelled' || data.status === 'failed') {
                    stopBatchAnalysisPolling();
                    await loadLibrary();
                    const failed = Number(data.failed || 0);
                    if (progressLabel) progressLabel.textContent = failed
                        ? `Completed ${completed} of ${total} ${progressUnit} · ${failed} failed`
                        : `Completed ${completed} of ${total} ${progressUnit}`;
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
                        await fetch(`/items/analyze-batch/${currentAnalysisTaskId}/cancel`, { method: 'POST' }).catch(() => { });
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

    function closeAppMenus() {
        appMenuBar?.querySelectorAll('.app-menu-root.is-open').forEach(root => {
            root.classList.remove('is-open');
            root.querySelector('.app-menu-trigger')?.setAttribute('aria-expanded', 'false');
        });
        selectionMoveSubmenu?.classList.remove('is-open');
        selectionMoveTrigger?.setAttribute('aria-expanded', 'false');
        selectionPlaylistSubmenu?.classList.remove('is-open');
        selectionPlaylistTrigger?.setAttribute('aria-expanded', 'false');
    }

    appMenuBar?.addEventListener('click', event => {
        const trigger = event.target.closest('.app-menu-trigger');
        const root = trigger?.closest('.app-menu-root');
        if (!trigger || !root) return;
        const isOpen = root.classList.contains('is-open');
        closeAppMenus();
        if (!isOpen) {
            root.classList.add('is-open');
            trigger.setAttribute('aria-expanded', 'true');
        }
    });

    selectionMoveTrigger?.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        if (selectionMoveTrigger.disabled) return;
        const isOpen = selectionMoveSubmenu?.classList.contains('is-open');
        selectionPlaylistSubmenu?.classList.remove('is-open');
        selectionPlaylistTrigger?.setAttribute('aria-expanded', 'false');
        selectionMoveSubmenu?.classList.toggle('is-open', !isOpen);
        selectionMoveTrigger.setAttribute('aria-expanded', String(!isOpen));
    });

    selectionPlaylistTrigger?.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        if (selectionPlaylistTrigger.disabled) return;
        const isOpen = selectionPlaylistSubmenu?.classList.contains('is-open');
        selectionMoveSubmenu?.classList.remove('is-open');
        selectionMoveTrigger?.setAttribute('aria-expanded', 'false');
        selectionPlaylistSubmenu?.classList.toggle('is-open', !isOpen);
        selectionPlaylistTrigger.setAttribute('aria-expanded', String(!isOpen));
    });

    selectionMoveSubmenu?.addEventListener('mouseenter', () => {
        if (!selectionMoveTrigger?.disabled) {
            selectionPlaylistSubmenu?.classList.remove('is-open');
            selectionPlaylistTrigger?.setAttribute('aria-expanded', 'false');
            selectionMoveSubmenu?.classList.add('is-open');
            selectionMoveTrigger?.setAttribute('aria-expanded', 'true');
        }
    });

    selectionPlaylistSubmenu?.addEventListener('mouseenter', () => {
        if (!selectionPlaylistTrigger?.disabled) {
            selectionMoveSubmenu?.classList.remove('is-open');
            selectionMoveTrigger?.setAttribute('aria-expanded', 'false');
            selectionPlaylistSubmenu?.classList.add('is-open');
            selectionPlaylistTrigger?.setAttribute('aria-expanded', 'true');
        }
    });

    removeFromPlaylistButton?.addEventListener('click', async () => {
        if (state.selectedPlaylistId === null) return;
        const selected = getSelectedEntries();
        for (const entry of selected) {
            const itemId = entryNumericId(entry);
            if (itemId) {
                await fetch(`/playlists/${state.selectedPlaylistId}/items/${itemId}`, { method: 'DELETE' });
            }
        }
        await loadPlaylists();
        await loadLibrary({ force: true });
    });

    playlistMenuCreateButton?.addEventListener('click', () => {
        closeAppMenus();
        openPlaylistDialog('create');
    });
    playlistMenuRenameButton?.addEventListener('click', () => {
        closeAppMenus();
        openPlaylistDialog('rename');
    });
    playlistMenuDeleteButton?.addEventListener('click', () => {
        closeAppMenus();
        deleteActivePlaylist();
    });
    playlistDialogClose?.addEventListener('click', () => playlistDialog?.close());
    playlistDialogCancel?.addEventListener('click', () => playlistDialog?.close());
    playlistDialog?.addEventListener('click', event => {
        if (event.target === playlistDialog) playlistDialog.close();
    });
    playlistForm?.addEventListener('submit', handlePlaylistFormSubmit);

    listHeader?.addEventListener('contextmenu', event => {
        event.preventDefault();
        openColumnMenu(event.clientX, event.clientY);
    });
    listHeader?.addEventListener('dragstart', event => {
        const cell = event.target.closest('.row-header-cell');
        if (!cell || !event.dataTransfer) return;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', cell.dataset.column || '');
        cell.classList.add('is-dragging');
    });
    listHeader?.addEventListener('dragover', event => {
        const target = event.target.closest('.row-header-cell');
        const sourceField = Array.from(event.dataTransfer?.types || []).includes('text/plain')
            ? event.dataTransfer.getData('text/plain')
            : '';
        if (!target || !sourceField || target.dataset.column === sourceField) return;
        event.preventDefault();
        clearHeaderDropIndicators();
        const placeAfter = event.clientX >= target.getBoundingClientRect().left + target.offsetWidth / 2;
        target.classList.add(placeAfter ? 'drop-after' : 'drop-before');
    });
    listHeader?.addEventListener('drop', event => {
        const target = event.target.closest('.row-header-cell');
        const sourceField = event.dataTransfer?.getData('text/plain');
        if (!target || !sourceField || target.dataset.column === sourceField) return;
        event.preventDefault();
        const placeAfter = event.clientX >= target.getBoundingClientRect().left + target.offsetWidth / 2;
        clearHeaderDropIndicators();
        reorderMainColumn(sourceField, target.dataset.column, placeAfter);
    });
    listHeader?.addEventListener('dragend', clearHeaderDropIndicators);
    listHeader?.addEventListener('pointerdown', event => {
        const resizer = event.target.closest('.column-resizer');
        if (!resizer) return;
        const field = resizer.dataset.column;
        if (!field || !MAIN_COLUMN_DEFINITIONS[field]) return;
        state.columnResize = {
            field,
            startX: event.clientX,
            startWidth: Number(state.mainColumnWidths[field] || MAIN_COLUMN_DEFINITIONS[field].width),
        };
        document.body.classList.add('resizing-column');
        event.preventDefault();
        event.stopPropagation();
    });
    document.addEventListener('pointermove', handleColumnResizeMove);
    document.addEventListener('pointerup', finishColumnResize);
    document.addEventListener('pointercancel', finishColumnResize);
    columnMenu?.addEventListener('change', event => {
        const checkbox = event.target.closest('input[data-column]');
        const field = checkbox?.dataset.column;
        if (!checkbox || !field || field === 'name') return;
        checkbox.checked ? state.mainVisibleColumns.add(field) : state.mainVisibleColumns.delete(field);
        saveMainColumnPreferences();
        renderColumnMenu();
        renderMainHeader();
        renderAssets();
    });
    document.addEventListener('click', event => {
        if (columnMenu && !columnMenu.contains(event.target) && !listHeader?.contains(event.target)) closeColumnMenu();
    });
    filterStatus?.addEventListener('scroll', () => {
        if (assetList && assetList.scrollLeft !== filterStatus.scrollLeft) {
            assetList.scrollLeft = filterStatus.scrollLeft;
        }
    });
    assetList?.addEventListener('scroll', () => {
        if (filterStatus && filterStatus.scrollLeft !== assetList.scrollLeft) {
            filterStatus.scrollLeft = assetList.scrollLeft;
        }
    });

    renderMainHeader();

    searchInput.addEventListener('input', () => {
        if (state.searchRafId !== null) cancelAnimationFrame(state.searchRafId);
        state.searchRafId = requestAnimationFrame(() => {
            state.searchRafId = null;
            state.query = searchInput.value.trim().toLowerCase();
            renderFilterUI();
            renderAssets();
        });
    });
    toggleFiltersButton?.addEventListener('click', () => {
        const hidden = !filterControls?.classList.contains('hidden');
        filterControls?.classList.toggle('hidden', hidden);
        toggleFiltersButton.setAttribute('aria-expanded', String(!hidden));
        toggleFiltersButton.setAttribute('aria-label', hidden ? 'Show filters' : 'Hide filters');
        toggleFiltersButton.title = hidden ? 'Show filters' : 'Hide filters';
    });
    refreshButton.addEventListener('click', loadLibrary);

    reviewSinProposalsButton?.addEventListener('click', async () => {
        try {
            await loadSinProposals();
            sinProposalsDialog?.showModal();
        } catch (error) {
            window.alert(error.message || 'Could not load SIN proposals');
        }
    });
    sinProposalsClose?.addEventListener('click', () => sinProposalsDialog?.close());
    sinProposalsDone?.addEventListener('click', () => sinProposalsDialog?.close());
    sinProposalsDialog?.addEventListener('click', event => {
        if (event.target === sinProposalsDialog) sinProposalsDialog.close();
    });
    sinProposalsContent?.addEventListener('click', async event => {
        const button = event.target.closest('[data-sin-proposal-action]');
        if (!button) return;
        const action = button.dataset.sinProposalAction;
        const proposalId = Number(button.dataset.sinProposalId);
        if (!proposalId || !['accept', 'reject'].includes(action)) return;
        button.disabled = true;
        try {
            const response = await fetch(`/sin-proposals/${proposalId}/${action}`, { method: 'POST' });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.detail || `Could not ${action} the proposal`);
            await loadSinProposals();
            if (action === 'accept') await loadLibrary();
        } catch (error) {
            button.disabled = false;
            window.alert(error.message || `Could not ${action} the proposal`);
        }
    });

    createProjectButton?.addEventListener('click', () => openProjectDialog());
    fileNewProjectButton?.addEventListener('click', () => {
        closeAppMenus();
        openProjectDialog();
    });
    fileImportButton?.addEventListener('click', () => {
        closeAppMenus();
        openImportButton?.click();
    });
    fileRefreshButton?.addEventListener('click', () => {
        closeAppMenus();
        refreshButton?.click();
    });
    vaultMenuCreateButton?.addEventListener('click', () => {
        closeAppMenus();
        openVaultDialog('create');
    });
    vaultMenuOptionsButton?.addEventListener('click', () => {
        closeAppMenus();
        openVaultDialog('rename');
    });
    vaultMenuDeleteButton?.addEventListener('click', () => {
        closeAppMenus();
        deleteActiveVault();
    });
    vaultMenuSyncButton?.addEventListener('click', () => {
        closeAppMenus();
        openVaultSyncDialog();
    });

    function setSidebarOpen(isOpen, { persist = true } = {}) {
        const open = Boolean(isOpen);
        libraryLayout?.classList.toggle('sidebar-collapsed', !open);
        sidebarToggle?.setAttribute('aria-expanded', String(open));
        sidebarToggle?.classList.toggle('is-active', open);
        if (persist) {
            try {
                localStorage.setItem('gaia_sidebar_open', open ? 'true' : 'false');
            } catch (_err) {
                // Ignore storage errors
            }
        }
    }

    try {
        setSidebarOpen(localStorage.getItem('gaia_sidebar_open') === 'true', { persist: false });
    } catch (_err) {
        setSidebarOpen(false, { persist: false });
    }

    sidebarToggle?.addEventListener('click', () => {
        const currentlyCollapsed = libraryLayout?.classList.contains('sidebar-collapsed') ?? true;
        setSidebarOpen(currentlyCollapsed);
    });

    sidebarNewPlaylistButton?.addEventListener('click', () => {
        openPlaylistDialog('create');
    });

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
        if (event.key === 'Escape') {
            closeVaultMenu();
            closeColumnMenu();
        }
    });
    vaultForm?.addEventListener('submit', submitVaultDialog);
    vaultDialogClose?.addEventListener('click', () => vaultDialog?.close());
    vaultDialogCancel?.addEventListener('click', () => vaultDialog?.close());
    vaultDialog?.addEventListener('click', event => {
        if (event.target === vaultDialog) vaultDialog.close();
    });

    folderForm?.addEventListener('submit', async event => {
        event.preventDefault();
        const name = folderNameInput?.value?.trim();
        if (!name) return;
        const { parentEntry, itemIds, referenceIds, vaultId } = state.pendingFolderCreation || {};
        const resolvedParentId = entryFolderItemId(parentEntry);
        try {
            if (folderDialogSubmit) folderDialogSubmit.disabled = true;
            const payload = {
                name,
                vault_id: vaultId ? Number(vaultId) : null,
                parent_id: resolvedParentId,
                item_ids: Array.isArray(itemIds) && itemIds.length ? itemIds.map(Number) : [],
                reference_ids: Array.isArray(referenceIds) && referenceIds.length ? referenceIds.map(Number) : [],
            };
            const response = await fetch('/items/folders/create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!response.ok) {
                const err = await response.json().catch(() => ({}));
                let detailMsg = 'Could not create folder';
                if (typeof err.detail === 'string') {
                    detailMsg = err.detail;
                } else if (Array.isArray(err.detail)) {
                    detailMsg = err.detail.map(d => d.msg || JSON.stringify(d)).join(', ');
                } else if (err.detail && typeof err.detail === 'object') {
                    detailMsg = JSON.stringify(err.detail);
                } else if (err.message) {
                    detailMsg = err.message;
                }
                throw new Error(detailMsg);
            }
            folderDialog?.close();
            state.pendingFolderCreation = null;
            await loadLibrary({ force: false, resetNested: false });
            const refreshId = entryFolderItemId(parentEntry);
            if (refreshId && typeIsProject(parentEntry.item?.type || parentEntry.type)) {
                loadProjectReferencedItems(refreshId, { reset: true });
            }
            const collId = Number(parentEntry?.collection?.id);
            if (collId && collId !== refreshId && typeIsProject(parentEntry?.collection?.type)) {
                loadProjectReferencedItems(collId, { reset: true });
            }
        } catch (err) {
            if (folderDialogResult) {
                folderDialogResult.className = 'result error';
                folderDialogResult.textContent = err.message;
                folderDialogResult.classList.remove('hidden');
            }
        } finally {
            if (folderDialogSubmit) folderDialogSubmit.disabled = false;
        }
    });
    folderDialogClose?.addEventListener('click', () => {
        folderDialog?.close();
        state.pendingFolderCreation = null;
    });
    folderDialogCancel?.addEventListener('click', () => {
        folderDialog?.close();
        state.pendingFolderCreation = null;
    });
    folderDialog?.addEventListener('click', event => {
        if (event.target === folderDialog) {
            folderDialog.close();
            state.pendingFolderCreation = null;
        }
    });
    projectDialogClose?.addEventListener('click', () => {
        projectSubmit.disabled = false;
        projectDialog.close();
    });

    projectDialogCancel?.addEventListener('click', () => {
        projectSubmit.disabled = false;
        projectDialog.close();
    });
    projectDialog?.addEventListener('close', () => {
        projectSubmit.disabled = false;
        projectName.disabled = false;
        if (projectImportAdd) projectImportAdd.disabled = false;
        pendingProjectInitialSession = null;
        pendingProjectOnCreated = null;
    });
    projectImportAdd?.addEventListener('click', openProjectImportBrowser);
    projectMoveAll?.addEventListener('change', event => {
        const movableSources = [
            ...state.projectDialogSources
                .filter(source => state.projectSourceIds.has(Number(source.item.id)))
                .filter(source => !typeIsContainer(source.type))
                .map(source => ({ id: Number(source.item.id), pending: false })),
            ...state.projectPendingImports
                .filter(source => source.movable)
                .map(source => ({ id: source.id, pending: true })),
        ];
        movableSources.forEach(source => {
            const target = source.pending ? state.projectPendingMoveIds : state.projectMoveIds;
            if (event.currentTarget.checked) target.add(source.id);
            else target.delete(source.id);
        });
        renderProjectSourcePreview();
    });
    projectFilesClose?.addEventListener('click', () => projectFilesDialog.close());
    itemPlacementClose?.addEventListener('click', () => itemPlacementDialog.close());
    itemPlacementCancel?.addEventListener('click', () => itemPlacementDialog.close());
    itemPlacementMove?.addEventListener('click', () => {
        const action = state.pendingPlacement?.action || 'copy';
        performItemPlacement(action === 'move' ? 'move' : 'copy');
    });
    itemPlacementReference?.addEventListener('click', () => performItemPlacement('reference'));
    itemPlacementDialog?.addEventListener('close', () => {
        if (!itemPlacementMove.disabled && !itemPlacementReference.disabled) state.pendingPlacement = null;
    });

    projectForm?.addEventListener('submit', async event => {
        event.preventDefault();
        const sourceIds = [...state.projectSourceIds];
        const pendingImports = [...state.projectPendingImports];
        const name = projectName.value;
        const vaultId = selectedProjectVaultId();
        const projectKind = projectKindSelect?.value || 'audio';
        const editorEngine = projectEngineSelect?.value || (projectKind === 'video' ? 'simple_media' : 'sin');
        projectResult.className = 'result hidden';

        if (pendingImports.length) {
            state.projectCreationImportContext = {
                name,
                vaultId,
                projectKind,
                editorEngine,
                initialSession: pendingProjectInitialSession,
                onCreated: pendingProjectOnCreated,
                itemIds: sourceIds,
                moveItemIds: [...state.projectMoveIds],
                pendingImports,
                index: 0,
            };
            projectSubmit.disabled = true;
            projectName.disabled = true;
            projectImportAdd.disabled = true;
            projectDialog.close();
            await startNextProjectCreationImport();
            return;
        }

        const payload = {
            vault_id: vaultId,
            name,
            project_kind: projectKind,
            editor_engine: editorEngine,
        };
        const url = sourceIds.length ? '/projects/from-items' : '/projects/';
        if (sourceIds.length) {
            payload.item_ids = sourceIds;
            payload.mode = 'single';
            payload.move_item_ids = [...state.projectMoveIds];
            if (pendingProjectInitialSession) {
                payload.initial_session = pendingProjectInitialSession;
            }
        }
        projectSubmit.disabled = true;
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.detail || 'Could not create Project');
            const createdProject = Array.isArray(result) ? result[0] : result;
            const onCreated = pendingProjectOnCreated;
            pendingProjectInitialSession = null;
            pendingProjectOnCreated = null;
            state.selectedEntryIds.clear();
            state.selectionAnchorId = null;
            state.projectDialogSources = [];
            state.projectSourceIds.clear();
            state.projectMoveIds.clear();
            state.projectPendingImports = [];
            state.projectPendingMoveIds.clear();
            state.projectCreationImportContext = null;
            projectSubmit.disabled = false;
            projectName.disabled = false;
            if (projectImportAdd) projectImportAdd.disabled = false;
            projectDialog.close();
            await loadLibrary();
            await loadVaultImportLog();
            if (createdProject) onCreated?.(createdProject);
        } catch (error) {
            projectResult.textContent = error.message;
            projectResult.className = 'result error';
            projectSubmit.disabled = false;
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

    if (copyEntryMenu) {
        const handleCopy = (event) => {
            if (event) { event.preventDefault(); event.stopPropagation(); }
            contextMenu.classList.add('hidden');
            copySelectedEntries();
        };
        copyEntryMenu.addEventListener('click', handleCopy);
    }

    if (pasteEntryMenu) {
        const handlePaste = (event) => {
            if (event) { event.preventDefault(); event.stopPropagation(); }
            contextMenu.classList.add('hidden');
            pasteIntoProject();
        };
        pasteEntryMenu.addEventListener('click', handlePaste);
    }

    contextOpenEditorButton?.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        const entry = state.contextEntry;
        contextMenu.classList.add('hidden');
        if (entry) window.gaiaEditorHost?.openForEntry?.(entry, { ephemeral: false });
    });

    contextOpenScratchButton?.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        const entry = state.contextEntry;
        contextMenu.classList.add('hidden');
        if (entry) window.gaiaEditorHost?.openForEntry?.(entry, { ephemeral: true });
    });

    if (contextGoToLocationButton) {
        contextGoToLocationButton.addEventListener('click', async (event) => {
            if (event) { event.preventDefault(); event.stopPropagation(); }
            const entry = state.contextEntry;
            contextMenu.classList.add('hidden');
            if (entry) {
                await openFileLocationForEntry(entry);
            }
        });
    }

    if (contextShowOriginalButton) {
        contextShowOriginalButton.addEventListener('click', async (event) => {
            if (event) { event.preventDefault(); event.stopPropagation(); }
            const entry = state.contextEntry;
            contextMenu.classList.add('hidden');
            if (entry) {
                await showOriginalFileForEntry(entry);
            }
        });
    }

    if (analyzeEntryButton) {
        const handleAnalyze = async (event) => {
            if (event) { event.preventDefault(); event.stopPropagation(); }
            contextMenu.classList.add('hidden');
            await analyzeSelectedEntries();
        };
        analyzeEntryButton.addEventListener('click', handleAnalyze);
    }

    if (contextSelectAllButton) {
        contextSelectAllButton.addEventListener('click', (event) => {
            if (event) { event.preventDefault(); event.stopPropagation(); }
            contextMenu.classList.add('hidden');
            selectAllEntries();
        });
    }

    if (deleteEntryMenuButton) {
        const handleDeleteMenu = async (event) => {
            if (event) { event.preventDefault(); event.stopPropagation(); }
            contextMenu.classList.add('hidden');
            await deleteSelectedEntries();
        };
        deleteEntryMenuButton.addEventListener('click', handleDeleteMenu);
    }

    if (contextNewFolderButton) {
        const handleNewFolder = (event) => {
            if (event) { event.preventDefault(); event.stopPropagation(); }
            contextMenu.classList.add('hidden');
            const selectedEntries = getSelectedEntries();
            const targetEntry = state.contextEntry || (selectedEntries.length === 1 ? selectedEntries[0] : null);
            const isSingleContainer = targetEntry && (
                typeIsContainer(targetEntry.type)
                || targetEntry.type === 'collection'
                || targetEntry.type === 'folder'
                || targetEntry.kind === 'subfolder'
                || Boolean(targetEntry.item?.attributes?.is_folder || targetEntry.content?.attributes?.is_folder)
            );
            const parentCollection = isSingleContainer
                ? targetEntry
                : (targetEntry?.collection ? { item: targetEntry.collection, title: targetEntry.collection.title || targetEntry.collection.name } : null);
            openFolderDialog({
                parentEntry: parentCollection,
                itemIds: [],
                referenceIds: [],
            });
        };
        contextNewFolderButton.addEventListener('click', handleNewFolder);
    }

    if (contextMakeFolderMoveButton) {
        const handleMakeFolderMove = (event) => {
            if (event) { event.preventDefault(); event.stopPropagation(); }
            contextMenu.classList.add('hidden');
            const selectedEntries = getSelectedEntries();
            const referenceIds = selectedEntries
                .filter(e => e.kind === 'reference' && e.reference?.id)
                .map(e => Number(e.reference.id));
            const itemIds = selectedEntries
                .filter(e => e.kind !== 'reference')
                .map(e => numericItemId(e))
                .filter(id => id !== null && Number.isFinite(id));
            const firstCol = selectedEntries.find(e => e.collection)?.collection || state.contextEntry?.collection;
            const parentCollection = (selectedEntries.length > 0 && selectedEntries.every(e => !e.collection || Number(e.collection.id) === Number(firstCol?.id))) && firstCol
                ? { item: firstCol, title: firstCol.title || firstCol.name }
                : (firstCol ? { item: firstCol, title: firstCol.title || firstCol.name } : null);
            openFolderDialog({
                parentEntry: parentCollection,
                itemIds,
                referenceIds,
            });
        };
        contextMakeFolderMoveButton.addEventListener('click', handleMakeFolderMove);
    }


    async function collectSelectedEntriesIntoVault() {
        const selected = getSelectedEntries();
        const itemIds = [...new Set(
            selected
                .map(entry => entry.kind === 'subfolder' ? entryFolderItemId(entry) : (numericItemId(entry) || entryFolderItemId(entry)))
                .filter(id => id && Number.isFinite(Number(id)))
                .map(Number)
        )];
        if (!itemIds.length) return;
        try {
            const response = await fetch('/items/collect', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ item_ids: itemIds }),
            });
            const result = await response.json().catch(() => ([]));
            if (!response.ok) {
                throw new Error(apiErrorMessage(result, 'Could not collect items into vault'));
            }
            const collectedCount = Array.isArray(result) ? result.length : 0;
            if (summary) {
                summary.textContent = collectedCount > 0
                    ? `Collected ${collectedCount} ${collectedCount === 1 ? 'item' : 'items'} into vault`
                    : 'Selected items are already stored in the vault';
            }
            await loadLibrary({ force: true, resetNested: true });
            await checkVaultSync();
        } catch (error) {
            window.alert(error.message || 'Could not collect items into vault');
        }
    }

    async function dissolveSelectedFolder() {
        const selected = getSelectedEntries();
        const targetEntry = state.contextEntry || (selected.length === 1 ? selected[0] : null);
        if (!targetEntry) return;
        const folderId = entryFolderItemId(targetEntry);
        if (!folderId) return;
        const folderTitle = targetEntry.title || targetEntry.name || `Folder ${folderId}`;
        if (!window.confirm(`Dissolve folder “${folderTitle}” and move its contents into its parent folder?`)) return;
        try {
            const response = await fetch(`/items/folders/${folderId}/dissolve`, {
                method: 'POST',
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(apiErrorMessage(result, 'Could not dissolve folder'));
            }
            state.selectedEntryIds.clear();
            state.contextEntry = null;
            await loadLibrary({ force: true, resetNested: true });
            await checkVaultSync();
        } catch (error) {
            window.alert(error.message || 'Could not dissolve folder');
        }
    }

    vaultMirrorBrowseBtn?.addEventListener('click', () => {
        openVaultPathPicker('mirror');
    });

    vaultMirrorAddBtn?.addEventListener('click', async () => {
        const source = vaultMirrorSourceInput?.value.trim() || '';
        const targetFolder = vaultMirrorTargetInput?.value.trim() || '';
        const mirrorMode = vaultMirrorModeSelect?.value || 'reference_1to1';
        if (!source) {
            showVaultDialogError('Choose or enter an external folder path to mirror.');
            vaultMirrorSourceInput?.focus();
            return;
        }
        vaultDialogResult?.classList.add('hidden');
        if (vaultDialogMode === 'rename') {
            const activeVault = selectedVault();
            if (!activeVault) return;
            vaultMirrorAddBtn.disabled = true;
            try {
                const response = await fetch(`/vaults/${activeVault.id}/mirrors`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        source_path: source,
                        target_folder_path: targetFolder,
                        mirror_mode: mirrorMode,
                        enabled: true,
                    }),
                });
                const created = await response.json().catch(() => ({}));
                if (!response.ok) throw new Error(apiErrorMessage(created, 'Could not add mirrored folder'));
                if (!Array.isArray(activeVault.mirrors)) activeVault.mirrors = [];
                activeVault.mirrors.push(created);
                if (vaultMirrorSourceInput) vaultMirrorSourceInput.value = '';
                if (vaultMirrorTargetInput) vaultMirrorTargetInput.value = '';
                renderVaultDialogMirrors();
                renderSidebar();
                await loadLibrary({ force: true, resetNested: true });
                await checkVaultSync(activeVault.id);
            } catch (error) {
                showVaultDialogError(error.message || 'Could not add mirrored folder');
            } finally {
                vaultMirrorAddBtn.disabled = false;
            }
        } else {
            if (!Array.isArray(state.stagedVaultMirrors)) state.stagedVaultMirrors = [];
            state.stagedVaultMirrors.push({
                source_path: source,
                target_folder_path: targetFolder,
                mirror_mode: mirrorMode,
                enabled: true,
            });
            if (vaultMirrorSourceInput) vaultMirrorSourceInput.value = '';
            if (vaultMirrorTargetInput) vaultMirrorTargetInput.value = '';
            renderVaultDialogMirrors();
        }
    });

    vaultMirrorsList?.addEventListener('click', async event => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const activeVault = selectedVault();

        const syncBtn = target.closest('[data-dialog-sync-mirror]');
        if (syncBtn && vaultDialogMode === 'rename' && activeVault) {
            const mirrorId = Number(syncBtn.getAttribute('data-dialog-sync-mirror'));
            if (!mirrorId) return;
            syncBtn.disabled = true;
            try {
                const res = await fetch(`/vaults/${activeVault.id}/mirrors/${mirrorId}/sync`, { method: 'POST' });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(apiErrorMessage(data, 'Could not sync mirrored folder'));
                await loadLibrary({ force: true, resetNested: true });
                await checkVaultSync(activeVault.id);
            } catch (error) {
                showVaultDialogError(error.message || 'Could not sync mirror');
            } finally {
                syncBtn.disabled = false;
            }
            return;
        }

        const removeBtn = target.closest('[data-dialog-remove-mirror]');
        if (removeBtn) {
            const rawId = removeBtn.getAttribute('data-dialog-remove-mirror');
            if (vaultDialogMode === 'rename' && activeVault) {
                const mirrorId = Number(rawId);
                if (!mirrorId) return;
                removeBtn.disabled = true;
                try {
                    const res = await fetch(`/vaults/${activeVault.id}/mirrors/${mirrorId}`, { method: 'DELETE' });
                    if (!res.ok) {
                        const err = await res.json().catch(() => ({}));
                        throw new Error(apiErrorMessage(err, 'Could not remove mirror'));
                    }
                    activeVault.mirrors = (activeVault.mirrors || []).filter(m => Number(m.id) !== mirrorId);
                    renderVaultDialogMirrors();
                    renderSidebar();
                    await checkVaultSync(activeVault.id);
                } catch (error) {
                    showVaultDialogError(error.message || 'Could not remove mirror');
                } finally {
                    removeBtn.disabled = false;
                }
            } else {
                const idx = Number(rawId);
                if (Number.isInteger(idx) && Array.isArray(state.stagedVaultMirrors)) {
                    state.stagedVaultMirrors.splice(idx, 1);
                    renderVaultDialogMirrors();
                }
            }
        }
    });

    contextCollectVaultButton?.addEventListener('click', async event => {
        event.preventDefault();
        event.stopPropagation();
        contextMenu.classList.add('hidden');
        await collectSelectedEntriesIntoVault();
    });

    selectionCollectVaultButton?.addEventListener('click', async event => {
        event.preventDefault();
        closeAppMenus();
        await collectSelectedEntriesIntoVault();
    });

    contextDissolveFolderButton?.addEventListener('click', async event => {
        event.preventDefault();
        event.stopPropagation();
        contextMenu.classList.add('hidden');
        await dissolveSelectedFolder();
    });

    selectionDissolveFolderButton?.addEventListener('click', async event => {
        event.preventDefault();
        closeAppMenus();
        await dissolveSelectedFolder();
    });

    analyzeSelectionButton?.addEventListener('click', async event => {
        event.preventDefault();
        closeAppMenus();
        await analyzeSelectedEntries();
    });

    deleteSelectionButton?.addEventListener('click', async event => {
        event.preventDefault();
        closeAppMenus();
        await deleteSelectedEntries();
    });

    versionDeleteCurrent?.addEventListener('click', () => resolveVersionDeletion('current'));
    versionDeletePurge?.addEventListener('click', () => resolveVersionDeletion('purge'));
    versionDeleteCancel?.addEventListener('click', () => resolveVersionDeletion());
    versionDeleteDialog?.addEventListener('cancel', event => {
        event.preventDefault();
        resolveVersionDeletion();
    });

    contextMenu.addEventListener('pointerdown', event => event.stopPropagation());
    contextMenu.addEventListener('mousedown', event => event.stopPropagation());

    window.addEventListener('pointerdown', event => {
        if (!contextMenu.contains(event.target)) contextMenu.classList.add('hidden');
        if (!appMenuBar?.contains(event.target)) closeAppMenus();
    });
    window.addEventListener('keydown', async event => {
        if (event.key === 'Escape') {
            contextMenu.classList.add('hidden');
            closeAppMenus();
            clearSelection();
            return;
        }
        const activeEl = document.activeElement;
        const isEditing = activeEl && (
            activeEl.tagName === 'INPUT' ||
            activeEl.tagName === 'SELECT' ||
            activeEl.tagName === 'TEXTAREA' ||
            activeEl.isContentEditable
        );
        if (isEditing) return;

        if ((event.ctrlKey || event.metaKey) && (event.key === 'a' || event.key === 'A')) {
            event.preventDefault();
            selectAllEntries();
            return;
        }

        if ((event.ctrlKey || event.metaKey) && (event.key === 'c' || event.key === 'C')) {
            if (state.selectedEntryIds.size > 0 || state.contextEntry) {
                event.preventDefault();
                copySelectedEntries();
            }
            return;
        }

        if ((event.ctrlKey || event.metaKey) && (event.key === 'v' || event.key === 'V')) {
            if (state.clipboard?.itemIds?.length) {
                event.preventDefault();
                pasteIntoProject();
            }
            return;
        }

        if (event.key === 'Delete' || event.key === 'Backspace') {
            if (state.selectedEntryIds.size > 0) {
                event.preventDefault();
                await deleteSelectedEntries();
            }
            return;
        }

        // Fast DAW-style keyboard browsing (ArrowUp/Down/Left/Right, Space preview, F2 rename)
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            const navRows = [];
            for (let i = 0; i < state.visibleFlatRows.length; i++) {
                if (state.visibleFlatRows[i].entry) navRows.push({ flatIdx: i, row: state.visibleFlatRows[i] });
            }
            if (!navRows.length) return;
            event.preventDefault();
            const anchorId = state.selectionAnchorId || [...state.selectedEntryIds].at(-1);
            let curPos = navRows.findIndex(item => item.row.entry.id === anchorId);
            const delta = event.key === 'ArrowDown' ? 1 : -1;
            const nextPos = curPos < 0
                ? (delta > 0 ? 0 : navRows.length - 1)
                : Math.max(0, Math.min(navRows.length - 1, curPos + delta));
            const target = navRows[nextPos];
            if (!target) return;
            const targetEntry = target.row.entry;
            selectEntry(targetEntry, { ctrlKey: false, metaKey: false, shiftKey: event.shiftKey });
            ensureVirtualList()?.scrollToIndex(target.flatIdx, { block: 'nearest' });
            refreshSelectionPresentation();
            // Prefetch adjacent audio row for zero-latency scrubbing
            const lookahead = navRows[nextPos + delta]?.row?.entry;
            if (lookahead && canPreview(lookahead)) {
                window.gaiaAudioPreview?.prefetch?.(lookahead, streamUrl(lookahead));
            }
            // If playback was already active, immediately audition the newly highlighted audio file
            if (!event.shiftKey && state.playingKey && canPreview(targetEntry)) {
                play(targetEntry, { toggleIfSame: false });
            }
            return;
        }

        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
            const anchorId = state.selectionAnchorId || [...state.selectedEntryIds].at(-1);
            const flatIdx = state.visibleFlatRows.findIndex(r => r.entry?.id === anchorId);
            if (flatIdx < 0) return;
            const rowSpec = state.visibleFlatRows[flatIdx];
            const entry = rowSpec.entry;
            const isExpandable = rowSpec.kind === 'subfolder' || (rowSpec.kind === 'root' && typeIsContainer(entry.type));
            if (event.key === 'ArrowRight' && isExpandable) {
                event.preventDefault();
                if (rowSpec.kind === 'subfolder') {
                    if (!rowSpec.isExpanded) {
                        state.expandedSubfolders.add(rowSpec.subfolderKey);
                        if (entry.itemId) state.expandedCollections.add(String(entry.itemId));
                        renderAssets();
                    }
                } else if (!rowSpec.isExpanded) {
                    toggleCollectionExpansion(entry);
                }
            } else if (event.key === 'ArrowLeft') {
                event.preventDefault();
                if (rowSpec.kind === 'subfolder' && rowSpec.isExpanded) {
                    state.expandedSubfolders.delete(rowSpec.subfolderKey);
                    if (entry.itemId) state.expandedCollections.delete(String(entry.itemId));
                    renderAssets();
                } else if (rowSpec.kind === 'root' && rowSpec.isExpanded) {
                    toggleCollectionExpansion(entry);
                } else if (rowSpec.kind === 'nested' || rowSpec.kind === 'subfolder') {
                    // Jump up to enclosing parent folder/root row
                    const targetDepth = (rowSpec.depth ?? 0) - 1;
                    for (let j = flatIdx - 1; j >= 0; j--) {
                        const cand = state.visibleFlatRows[j];
                        if ((targetDepth < 0 && cand.kind === 'root') || (cand.kind === 'subfolder' && cand.depth === targetDepth)) {
                            selectEntry(cand.entry, { ctrlKey: false, metaKey: false, shiftKey: false });
                            ensureVirtualList()?.scrollToIndex(j, { block: 'nearest' });
                            refreshSelectionPresentation();
                            break;
                        }
                    }
                }
            }
            return;
        }

        if (event.key === 'F2') {
            const anchorId = state.selectionAnchorId || [...state.selectedEntryIds].at(-1);
            const entry = anchorId ? entryById(anchorId) : null;
            if (entry && canEdit(entry, 'title')) {
                event.preventDefault();
                const mountedRow = ensureVirtualList()?.findMountedRowByEntryId(entry.id);
                const titleCell = mountedRow?.querySelector('.asset-title-text');
                if (titleCell) beginCellEdit(titleCell, entry, 'title');
            }
        }
    });
    assetList?.addEventListener('scroll', () => contextMenu.classList.add('hidden'));

    window.addEventListener('dragover', handleDragAutoScroll, { capture: true, passive: true });
    function clearDropIndicators() {
        document.querySelectorAll('.drop-target, .drop-between-before, .drop-between-after').forEach(el => {
            el.classList.remove('drop-target', 'drop-between-before', 'drop-between-after');
        });
    }

    function isExternalFileDrag(event) {
        const types = event.dataTransfer?.types;
        if (!types) return false;
        const typesList = Array.from(types).map(t => String(t).toLowerCase());
        const hasFiles = typesList.includes('files');
        const isInternal = state.isDraggingItem || typesList.includes('application/x-gaia-item-ids');
        return hasFiles && !isInternal;
    }

    function showDropOverlay() {
        if (!assetDropOverlay) return;
        const targetVault = selectedVault() || state.vaults[0];
        const vaultName = targetVault ? targetVault.name : 'active vault';
        if (assetDropOverlayTitle) {
            assetDropOverlayTitle.textContent = `Drop to import into “${vaultName}”`;
        }
        assetDropOverlay.classList.remove('hidden');
        assetPanel?.classList.add('file-drop-active');
    }

    function hideDropOverlay() {
        if (assetDropOverlay) {
            assetDropOverlay.classList.add('hidden');
        }
        assetPanel?.classList.remove('file-drop-active');
    }

    window.addEventListener('dragover', event => {
        if (isExternalFileDrag(event)) {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
        }
    });

    window.addEventListener('drop', event => {
        if (isExternalFileDrag(event)) {
            event.preventDefault();
            hideDropOverlay();
        }
    });

    window.addEventListener('dragend', () => {
        state.isDraggingItem = false;
        stopDragAutoScroll();
        clearDropIndicators();
        hideDropOverlay();
    }, { capture: true });

    assetPanel?.addEventListener('dragenter', event => {
        if (!isExternalFileDrag(event)) return;
        event.preventDefault();
        showDropOverlay();
    });

    assetPanel?.addEventListener('dragover', event => {
        if (!isExternalFileDrag(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        showDropOverlay();
    });

    assetDropOverlay?.addEventListener('dragover', event => {
        if (!isExternalFileDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'copy';
    });

    assetDropOverlay?.addEventListener('dragleave', event => {
        if (!isExternalFileDrag(event)) return;
        if (!event.relatedTarget || !assetPanel?.contains(event.relatedTarget)) {
            hideDropOverlay();
        }
    });

    assetDropOverlay?.addEventListener('drop', async event => {
        if (!isExternalFileDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        hideDropOverlay();
        await handleExternalFileDrop(event);
    });

    assetList?.addEventListener('dragover', event => {
        if (isExternalFileDrag(event)) {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
            showDropOverlay();
        } else if (state.isDraggingItem || Array.from(event.dataTransfer?.types || []).includes('application/x-gaia-item-ids')) {
            event.preventDefault();
        }
    });
    assetList?.addEventListener('contextmenu', event => {
        if (event.target.closest('.asset-row')) return;
        event.preventDefault();
        state.contextEntry = null;
        renderContextMenu();
        contextMenu.classList.remove('hidden');
        const width = contextMenu.offsetWidth || 180;
        const height = contextMenu.offsetHeight || 120;
        contextMenu.style.left = `${Math.min(event.clientX, window.innerWidth - width - 8)}px`;
        contextMenu.style.top = `${Math.min(event.clientY, window.innerHeight - height - 8)}px`;
    });

    document.addEventListener('click', event => {
        if (event.button !== 0) return;
        if (event.target.closest('.asset-row, .subfolder-row')) return;
        if (event.target.closest('button, input, select, textarea, label, dialog, .sin-menu-surface, .sin-menu-item, .app-header, .app-menu-bar, .library-sidebar, .media-editor-dock, .filter-chip, .column-resizer, .file-version-selector')) {
            return;
        }
        clearSelection();
    });

    const importWizard = window.GaiaImportWizard?.init({
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
        getVaultDialogMode: () => vaultDialogMode,
    });

    window.gaiaAppBridge = {
        openProjectDialog,
        pickDiskFolder: initialPath => importWizard?.pickDiskFolder?.(initialPath),
        getVaults: () => state.vaults,
        getActiveVaultId: () => selectedVault()?.id ?? state.vaults[0]?.id ?? null,
        refreshLibrary: () => loadLibrary(),
    };

    function pollImportJob() {
        return importWizard?.pollImportJob();
    }

    function stopImportPolling() {
        return importWizard?.stopImportPolling();
    }

    function setImportBusy(busy) {
        return importWizard?.setImportBusy(busy);
    }

    function resetImportFlow() {
        return importWizard?.resetImportFlow();
    }

    function renderImportJob(job) {
        return importWizard?.renderImportJob(job);
    }

    function renderImportPollingIssue(message) {
        return importWizard?.renderImportPollingIssue(message);
    }

    function showImportJobSummary(job) {
        return importWizard?.showImportJobSummary(job);
    }

    function startImportJob() {
        return importWizard?.startImportJob();
    }

    function cancelImportJob() {
        return importWizard?.cancelImportJob();
    }

    function openInspectTableForPreview(preview, vaultId) {
        return importWizard?.openInspectTableForPreview(preview, vaultId);
    }

    function startDirectFileImport(file, vaultId) {
        return importWizard?.startDirectFileImport(file, vaultId);
    }

    function stageDroppedFile(file, sessionId, relativePath) {
        return importWizard?.stageDroppedFile(file, sessionId, relativePath);
    }

    function handleExternalFileDrop(event) {
        return importWizard?.handleExternalFileDrop(event);
    }

    function openSourcePicker() {
        return importWizard?.openSourcePicker();
    }

    function openVaultPathPicker(mode) {
        return importWizard?.openVaultPathPicker(mode);
    }

    function chooseSourcePickerPath() {
        return importWizard?.chooseSourcePickerPath();
    }

    function inspectImportSource() {
        return importWizard?.inspectImportSource();
    }

    function loadSourcePicker(path = null) {
        return importWizard?.loadSourcePicker(path);
    }

    document.getElementById('version-delete-close')?.addEventListener('click', () => versionDeleteDialog?.close());

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
    window.addEventListener('gaia:transport-command', event => {
        const detail = event.detail || {};
        window.gaiaTransport?.handleCommand?.(detail);
        if (detail.handled) return;
        if (detail.command === 'play-selected') {
            const anchorId = state.selectionAnchorId || [...state.selectedEntryIds].at(-1);
            const entry = anchorId ? entryById(anchorId) : null;
            if (entry) {
                previewEntry(entry, { toggleIfSame: true });
            }
            return;
        }
        if (detail.command === 'toggle') {
            const anchorId = state.selectionAnchorId || [...state.selectedEntryIds].at(-1);
            const entry = anchorId ? entryById(anchorId) : null;
            if (entry) previewEntry(entry, { toggleIfSame: true });
        } else if (detail.command === 'stop') {
            stopPlayback();
        }
    });
    let lastFocusSyncAt = 0;
    const scheduleThrottledFocusSync = () => {
        const now = Date.now();
        if (now - lastFocusSyncAt < 10000) return;
        lastFocusSyncAt = now;
        scheduleVaultSyncCheck(state.selectedVaultId, 400);
    };
    window.addEventListener('gaia:library-refresh', () => loadLibrary({ force: false }));
    window.addEventListener('focus', scheduleThrottledFocusSync);
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) scheduleThrottledFocusSync();
    });
    initAssetListDelegation();
    loadLibrary().then(() => scheduleVaultSyncCheck(state.selectedVaultId, 800));
}



if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeGaiaLibrary, { once: true });
} else {
    initializeGaiaLibrary();
}
