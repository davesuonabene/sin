function initializeGaiaLibrary() {
    const MAIN_COLUMN_DEFINITIONS = Object.freeze({
        favourite: { label: '★', menuLabel: '★ Favourite', width: 52 },
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
                if (validFields.has(field) && Number.isFinite(numericWidth)) widths[field] = Math.min(600, Math.max(40, numericWidth));
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
        importVaultId: null,
        importPreview: null,
        importFolderAssignments: new Map(),
        importItemTypes: new Map(),
        importExcludedIndexes: new Set(),
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
        collectionContents: new Map(),
        collectionContentPaging: new Map(),
        collectionContentsLoading: new Set(),
        collectionContentsErrors: new Map(),
        collectionContentControllers: new Map(),
        collectionContentQuery: '',
        versionSelections: new Map(),
        pendingVersionDeletion: null,
        libraryLoadPromise: null,
        libraryLoadController: null,
        libraryLoadQuery: null,
        searchDebounceTimer: null,
        mainColumnOrder: mainColumnPreferences.order,
        mainVisibleColumns: new Set(mainColumnPreferences.visible),
        mainColumnWidths: mainColumnPreferences.widths,
        columnResize: null,
    };

    const assetList = document.getElementById('asset-list');
    const summary = document.getElementById('library-summary');
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
    const copyEntryMenu = document.getElementById('copy-entry-menu');
    const pasteEntryMenu = document.getElementById('paste-entry-menu');
    const contextNewFolderButton = document.getElementById('context-new-folder');
    const contextMakeFolderMoveButton = document.getElementById('context-make-folder-move');
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
    const vaultMenuOptionsButton = document.getElementById('vault-menu-options');
    const vaultMenuDeleteButton = document.getElementById('vault-menu-delete');
    const appMenuBar = document.getElementById('app-menu-bar');
    const projectDialog = document.getElementById('project-dialog');
    const projectForm = document.getElementById('project-form');
    const projectDialogTitle = document.getElementById('project-dialog-title');
    const projectDialogClose = document.getElementById('project-dialog-close');
    const projectDialogCancel = document.getElementById('project-dialog-cancel');
    const projectName = document.getElementById('project-name');
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

    function collectionRowLayout(collection) {
        return isSamplePackCollection(collection) ? ROW_LAYOUTS.samplePack : mainRowLayout();
    }

    function rowLayoutFor(entry, { nested = false } = {}) {
        return nested ? collectionRowLayout(entry.collection) : mainRowLayout();
    }

    function renderRowHeader(header, layout, className) {
        header.className = `row-header ${className}`;
        header.style.setProperty('--row-columns', layout.columns);
        if (layout.id === 'main' || className === 'main-row-header') {
            header.style.setProperty('--main-table-width', `${mainColumnMinimumWidth()}px`);
        }
        header.replaceChildren();
        const isMainLayout = layout.id === 'main';
        layout.fields.forEach(field => {
            const cell = document.createElement(isMainLayout ? 'div' : 'span');
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
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = state.mainVisibleColumns.has(field);
            checkbox.disabled = field === 'name';
            checkbox.dataset.column = field;
            const text = document.createElement('span');
            text.textContent = definition.menuLabel || definition.label;
            label.append(checkbox, text);
            columnMenu.appendChild(label);
        });
    }

    function openColumnMenu(clientX, clientY) {
        if (!columnMenu) return;
        renderColumnMenu();
        columnMenu.classList.remove('hidden');
        const width = columnMenu.offsetWidth || 220;
        const height = columnMenu.offsetHeight || 300;
        columnMenu.style.left = `${Math.max(8, Math.min(clientX, window.innerWidth - width - 8))}px`;
        columnMenu.style.top = `${Math.max(8, Math.min(clientY, window.innerHeight - height - 8))}px`;
    }

    function reorderMainColumn(sourceField, targetField, placeAfter) {
        if (!sourceField || !targetField || sourceField === targetField) return;
        const order = [...state.mainColumnOrder];
        const sourceIndex = order.indexOf(sourceField);
        const targetIndex = order.indexOf(targetField);
        if (sourceIndex < 0 || targetIndex < 0) return;
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
        const width = Math.min(600, Math.max(70, resize.startWidth + event.clientX - resize.startX));
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
                    placeItemsDirectly({ item: collection, collection: collection, title: collection.title || collection.name }, [...new Set(itemIds)], { folder: '' });
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

    function filterableEntries() {
        return allEntries().map(entry => filterableItem(entry));
    }

    function compatibleFacets(selection) {
        const vaultIds = new Set();
        const types = new Set();
        const tags = new Map();
        const facetSourceItems = state.query && state.catalogItems.length ? state.catalogItems : state.items;
        const facetItems = state.query
            ? facetSourceItems.map(item => item)
            : filterableEntries();
        facetItems.forEach(item => {
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

        // Root summaries carry child facets, keeping the filter rail useful
        // without loading every collapsed collection into the browser.
        facetSourceItems.filter(item => typeIsContainer(item.type)).forEach(collection => {
            const contentTypes = Array.isArray(collection.content_types) ? collection.content_types : [];
            const contentTags = Array.isArray(collection.content_tags) ? collection.content_tags : [];
            const vaultMatches = !selection.vaultIds?.size || selection.vaultIds.has(Number(collection.vault_id));
            if (!vaultMatches) return;
            const tagsMatch = !selection.tags?.size || [...selection.tags].every(selectedTag => (
                contentTags.some(itemTag => tagMatches(normalizeFacetValue(selectedTag), normalizeFacetValue(itemTag)))
            ));
            if (tagsMatch) {
                contentTypes.forEach(type => {
                    if (!selection.types?.size || selection.types.has(type)) types.add(type);
                });
            }
            if (!selection.types?.size || contentTypes.some(type => selection.types.has(type))) {
                contentTags.forEach(tag => {
                    const normalized = normalizeFacetValue(tag);
                    if (!tags.has(normalized)) tags.set(normalized, tag);
                });
            }
        });
        return { vaultIds, types, tags };
    }

    function allEntries() {
        const entries = rootAssetEntries();

        state.items.filter(item => typeIsContainer(item.type)).forEach(collection => {
            entries.push(...collectionContentEntries(collection));
        });
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
        }).map(group => ({
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
            const fileVersions = hasVersions
                ? record.versions.map(v => ({
                    id: String(v.item.id),
                    label: v.label,
                    record: v.item,
                }))
                : null;

            return {
                kind: 'reference',
                id: `${project.id}:reference:${activeReference.id}`,
                type: activeItem.type,
                title: activeItem.title || filename(activeItem.absolute_path),
                path: activeItem.absolute_path,
                item: activeItem,
                reference: activeReference,
                versions: record.versions || [],
                versionGroup: record.version_group || null,
                fileVersionGroup: groupKey,
                fileVersions,
                collection: project,
            };
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
                    versions: row.versions || [],
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
        state.collectionContentControllers.forEach(controller => controller.abort());
        state.collectionContents.clear();
        state.collectionContentPaging.clear();
        state.collectionContentsErrors.clear();
        state.collectionContentsLoading.clear();
        state.collectionContentControllers.clear();

        state.projectReferenceControllers.forEach(controller => controller.abort());
        state.projectReferencedItems.clear();
        state.projectReferencesLoading.clear();
        state.projectReferenceControllers.clear();
    }

    async function loadCollectionContents(collectionId, { reset = false } = {}) {
        const numericId = Number(collectionId);
        if (!Number.isFinite(numericId)) return;
        if (!reset && state.collectionContentsLoading.has(numericId)) return;
        const currentPage = state.collectionContentPaging.get(numericId);
        if (!reset && currentPage && !currentPage.hasMore) return;

        const offset = reset ? 0 : currentPage?.nextOffset || 0;
        const requestedQuery = state.collectionContentQuery;
        state.collectionContentControllers.get(numericId)?.abort();
        const controller = new AbortController();
        state.collectionContentControllers.set(numericId, controller);
        state.collectionContentsLoading.add(numericId);
        state.collectionContentsErrors.delete(numericId);
        renderAssets();
        try {
            const querySuffix = requestedQuery ? `&query=${encodeURIComponent(requestedQuery)}` : '';
            const response = await fetch(`/items/${numericId}/contents-page?offset=${offset}&limit=250${querySuffix}`, { signal: controller.signal });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.detail || 'Could not load collection contents');
            if (requestedQuery !== state.collectionContentQuery) return;
            const incoming = Array.isArray(result.contents) ? result.contents : [];
            const existing = reset ? [] : (state.collectionContents.get(numericId) || []);
            state.collectionContents.set(numericId, existing.concat(incoming));
            state.collectionContentPaging.set(numericId, {
                nextOffset: offset + incoming.length,
                hasMore: Boolean(result.has_more),
                total: Number(result.total) || existing.length + incoming.length,
            });
        } catch (error) {
            if (error?.name === 'AbortError') return;
            state.collectionContentsErrors.set(numericId, error.message || 'Could not load collection contents');
        } finally {
            if (state.collectionContentControllers.get(numericId) === controller) {
                state.collectionContentControllers.delete(numericId);
                state.collectionContentsLoading.delete(numericId);
            }
            renderFilterUI();
            renderAssets();
        }
    }

    function collectionContentEntries(collection) {
        const references = projectReferenceEntries(collection);
        const referencedItemIds = new Set(references.flatMap(entry => [
            Number(entry.item.id),
            ...(entry.versions || []).map(version => Number(version.item?.id)),
        ]));
        const rawContents = state.collectionContents.has(Number(collection.id))
            ? state.collectionContents.get(Number(collection.id))
            : (collection.contents || []);
        const contents = groupFileVersions(
            (rawContents || []).filter(content => !referencedItemIds.has(Number(content.child_id))),
            {
                pathFor: content => content.relative_path || content.filename,
                idFor: content => content.child_id || `${collection.id}:${content.index}`,
                scope: `collection:${collection.id}`,
            },
        ).map(group => ({
            kind: 'content',
            id: group.fileVersionGroup ? `version:${group.fileVersionGroup}` : `${collection.id}:${group.record.index}`,
            type: group.record.type,
            title: group.fileVersionDisplayName || group.record.title || group.record.filename,
            path: group.record.relative_path,
            content: group.record,
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
        return Boolean(state.selectedVaultId !== null || state.selectedTypes.size || state.selectedTags.size || state.query);
    }

    function unloadedCollectionMatches(collection) {
        if (!typeIsContainer(collection?.type)) return false;
        // Text search needs actual content rows. Type/tag filters can use the
        // compact facets returned with the root summary.
        if (state.query) return Boolean(collection.matches_query);
        if (state.selectedVaultId !== null && Number(collection.vault_id) !== Number(state.selectedVaultId)) return false;
        const contentTypes = new Set((collection.content_types || []).map(normalizeFacetValue));
        if (state.selectedTypes.size && ![...state.selectedTypes].some(type => contentTypes.has(normalizeFacetValue(type)))) return false;
        const contentTags = (collection.content_tags || []).map(normalizeFacetValue);
        return [...state.selectedTags].every(selectedTag => contentTags.some(itemTag => (
            tagMatches(normalizeFacetValue(selectedTag), itemTag)
        )));
    }

    function visibleEntries() {
        const assets = rootAssetEntries();
        if (!filteringIsActive()) return assets.sort((a, b) => a.title.localeCompare(b.title));

        return assets.filter(entry => {
            if (entryMatches(entry)) return true;
            if (!typeIsContainer(entry.type)) return false;
            if (state.collectionContents.has(Number(entry.item.id))) {
                return collectionContentEntries(entry.item).some(entryMatches);
            }
            return unloadedCollectionMatches(entry.item);
        }).sort((a, b) => a.title.localeCompare(b.title));
    }

    function selectionEntries() {
        const entries = [];
        function collectNodeEntries(node, collection) {
            const sortedSubfolders = Array.from(node.subfolders.values()).sort((a, b) =>
                a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
            );
            sortedSubfolders.forEach(subfolder => {
                const folderEntryId = `subfolder:${collection.id}:${subfolder.fullPath}`;
                const folderEntry = state.subfolderEntries?.get(folderEntryId);
                if (folderEntry) entries.push(folderEntry);
                const subfolderKey = `${collection.id}:${subfolder.fullPath}`;
                if (state.expandedSubfolders.has(subfolderKey)) {
                    collectNodeEntries(subfolder, collection);
                }
            });
            node.files.forEach(file => entries.push(file));
        }

        visibleEntries().forEach(entry => {
            entries.push(entry);
            if (entry.kind === 'asset' && typeIsContainer(entry.type) && state.expandedCollections.has(entry.id)) {
                const contents = collectionContentEntries(entry.item);
                const matchingContents = filteringIsActive() && !entryMatches(entry) ? contents.filter(entryMatches) : contents;
                const tree = buildCollectionTree(matchingContents);
                collectNodeEntries(tree, entry.item);
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
        window.dispatchEvent(new CustomEvent('gaia:selection', { detail: { entry } }));
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
                const label = record.attributes?.profile_label || entry.reference?.attributes?.profile_label || entry.content?.attributes?.profile_label;
                if (label) return label;
                if (record.attributes?.is_folder || entry.type === 'collection') return 'Folder';
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
        if (entry.kind === 'content') return Number(entry.content?.child_id) || null;
        return Number(entry.item?.id) || null;
    }

    function entryFolderItemId(entry) {
        if (!entry) return null;
        const raw = entry.item?.id ?? entry.content?.child_id ?? entry.folderItem?.child_id ?? entry.folderItem?.id ?? entry.folderItem?.item?.id ?? entry.collection?.id;
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
        if (entry.kind === 'content') return `/items/${entry.collection.id}/contents/${entry.content.index}/stream`;
        return `/items/${entry.item.id}/stream`;
    }

    function canPreview(entry) {
        const item = entry.kind === 'content' ? entry.content : entry.item;
        if ((item?.availability || 'ready') !== 'ready') return false;
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
        if (window.gaiaMediaEditor?.requestTarget?.(entry)) return;
        if (window.gaiaTransport?.requestPlay?.(entry)) return;
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
        if (!state.audio) {
            window.dispatchEvent(new CustomEvent('gaia:stop'));
            return;
        }
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
        window.dispatchEvent(new CustomEvent('gaia:stop'));
    }

    function play(entry) {
        if (window.gaiaTransport?.requestPlay?.(entry)) return;
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
            window.dispatchEvent(new CustomEvent('gaia:stop'));
        };
        window.dispatchEvent(new CustomEvent('gaia:play', { detail: { entry, audio: state.audio } }));
        state.audio.play().catch(() => {
            state.playingKey = null;
            window.dispatchEvent(new CustomEvent('gaia:stop'));
        });
    }

    function canEdit(entry, field) {
        if (entry.kind === 'reference') return field === 'tags';
        if (field === 'tags') return true;
        if (field === 'title') return entry.kind === 'asset' || entry.kind === 'content';
        if (field === 'type') {
            if (entry.kind === 'content') return ['audio', 'sample', 'track'].includes(entry.type);
            return ['audio', 'sample', 'track'].includes(entry.type);
        }
        if (field === 'bpm') return ['audio', 'sample', 'midi', 'multitrack'].includes(entry.type);
        if (field === 'key') return ['audio', 'sample', 'midi', 'multitrack'].includes(entry.type);
        if (['author', 'album', 'album_artist', 'release_year', 'genre', 'track_number', 'disc_number', 'comment'].includes(field)) {
            return ['audio', 'sample', 'track'].includes(entry.type);
        }
        return false;
    }

    function entryValue(entry, field) {
        if (field === 'title') return entry.title;
        if (field === 'type') return entry.type;
        if (field === 'bpm') return entryBpm(entry);
        if (field === 'key') return entryKey(entry);
        if (field === 'tags') {
            if (entry.kind === 'reference') return (entry.reference?.tags || entry.reference?.attributes?.tags || []).join(', ');
            return entryTags(entry).join(', ');
        }
        return firstEntryValue(entry, field);
    }

    function updateEntryInState(entry, result) {
        if (entry.kind === 'content') {
            const collectionId = Number(entry.collection.id);
            const contents = state.collectionContents.get(collectionId);
            const index = contents?.findIndex(content => content.index === entry.content.index) ?? -1;
            if (index >= 0) contents[index] = result;
            return;
        }

        const itemId = Number(entry.item?.id);
        const index = state.items.findIndex(item => Number(item.id) === itemId);
        if (index >= 0) state.items[index] = result;
        if (entry.kind === 'reference') {
            const records = state.projectReferencedItems.get(Number(entry.collection.id)) || [];
            records.forEach(record => {
                if (Number(record.item?.id) === itemId) record.item = result;
                (record.versions || []).forEach(version => {
                    if (Number(version.item?.id) === itemId) version.item = result;
                });
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
        if (entry.kind === 'reference' && field === 'tags') {
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
        if (!response.ok) throw new Error(apiErrorMessage(result, 'Could not update metadata'));
        updateEntryInState(entry, result);
        renderFilterUI();
        renderAssets();
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

    function beginCellEdit(cell, entry, field) {
        if (!canEdit(entry, field) || cell.querySelector('input, select')) return;
        const initial = entryValue(entry, field) ?? '';
        const editor = field === 'type' ? document.createElement('select') : document.createElement('input');
        editor.className = field === 'type' ? 'cell-editor sin-select' : 'cell-editor';
        const editorWidth = Math.max(72, Math.ceil(cell.getBoundingClientRect().width));
        editor.style.width = `${editorWidth}px`;
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
        }
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
        if (state.expandedCollections.has(id) || (itemId && state.expandedCollections.has(itemId))) {
            state.expandedCollections.delete(id);
            if (itemId) state.expandedCollections.delete(itemId);
        } else {
            state.expandedCollections.add(id);
            if (itemId) state.expandedCollections.add(itemId);
            const targetId = entry.item?.id || (entry.content?.child_id ? Number(entry.content.child_id) : null);
            if (targetId) {
                loadCollectionContents(targetId);
                if (typeIsProject(entry.type)) loadProjectReferencedItems(targetId);
            }
        }
        renderAssets();
    }

    function createRow(entry, { nested = false, subfolderDepth = 0 } = {}) {
        const row = document.createElement('div');
        const availability = (entry.kind === 'content' ? entry.content?.availability : entry.item?.availability) || 'ready';
        row.className = `asset-row${state.selectedEntryIds.has(entry.id) ? ' selected' : ''}${entry.kind === 'reference' ? ' referenced-row' : ''}${availability !== 'ready' ? ' unavailable-row' : ''}`;
        const layout = rowLayoutFor(entry, { nested });
        row.classList.add(nested ? 'nested-row' : 'main-row', `row-layout-${layout.id}`);
        row.style.setProperty('--row-columns', layout.columns);
        if (layout.id === 'main') row.style.setProperty('--main-table-width', `${mainColumnMinimumWidth()}px`);
        row.setAttribute('role', 'listitem');
        row.setAttribute('aria-selected', String(state.selectedEntryIds.has(entry.id)));
        row.draggable = Boolean(numericItemId(entry)) && availability === 'ready';
        const isCollection = Boolean(
            (entry.kind === 'asset' && typeIsContainer(entry.type))
            || entry.type === 'collection'
            || typeIsContainer(entry.type)
            || entry.item?.attributes?.is_folder
            || entry.content?.attributes?.is_folder
        );
        if (isCollection) row.title = 'Click the title to preview the master · double-click the row to show contents';
        if (entry.kind === 'reference') row.title = 'Linked file · edit its project tags in the Tags column';
        if (availability !== 'ready') row.title = `Asset ${availability}; playback and project use are unavailable`;

        const referenceLabel = entryReferenceLabel(entry);
        const fileVersionSelector = entry.fileVersions?.length > 1
            ? `<select class="file-version-selector" title="Select file version" aria-label="Select file version">${entry.fileVersions.map(version => `<option value="${escapeHtml(version.id)}" ${String(version.id) === String(numericItemId(entry) || `${entry.collection?.id || 'root'}:${entry.content?.index || ''}`) ? 'selected' : ''}>${escapeHtml(version.label)}</option>`).join('')}</select>`
            : '';
        const isExpandable = isCollection;
        const isExpanded = isExpandable && (state.expandedCollections.has(entry.id) || (entry.item?.id && state.expandedCollections.has(String(entry.item.id))));
        const expandToggle = isExpandable
            ? `<button class="item-expand-toggle-btn" type="button" title="${isExpanded ? 'Collapse contents' : 'Expand contents'}" aria-label="${isExpanded ? 'Collapse contents' : 'Expand contents'}" aria-expanded="${isExpanded}">${isExpanded ? '▾' : '▸'}</button>`
            : '';
        const folderIcon = isCollection
            ? `<span class="collection-title-icon" aria-hidden="true">📁</span>`
            : '';
        const countVal = entry.item?.content_count ?? entry.content?.content_count;
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
        const isFav = Boolean(entryColumnValue(entry, 'favourite'));
        const favCell = `<button class="favourite-toggle-btn${isFav ? ' active' : ''}" type="button" data-field="favourite" title="${isFav ? 'Remove from favourites' : 'Add to favourites'}" aria-label="Favourite">${isFav ? '★' : '☆'}</button>`;
        const cells = {
            favourite: favCell,
            name: titleCell,
            filename: `<span class="metadata-text">${escapeHtml(entryColumnValue(entry, 'filename'))}</span>`,
            path: `<span class="path-text">${escapeHtml(entryPath(entry))}</span>`,
            type: editableCell(entry, 'type', 'type-badge', displayType),
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

        row.querySelector('.favourite-toggle-btn')?.addEventListener('click', async event => {
            event.stopPropagation();
            event.preventDefault();
            const currentFav = Boolean(entryColumnValue(entry, 'favourite'));
            try {
                await saveMetadata(entry, 'favourite', !currentFav);
            } catch (err) {
                console.error('Failed to toggle favourite', err);
                window.alert(err.message || 'Failed to update favourite');
            }
        });
        row.querySelector('.item-expand-toggle-btn')?.addEventListener('click', event => {
            event.stopPropagation();
            event.preventDefault();
            toggleCollectionExpansion(entry);
        });

        let titlePreviewTimer = null;
        const previewEntry = () => {
            selectEntry(entry, { ctrlKey: false, metaKey: false, shiftKey: false });
            if (isCollection) previewContainer(entry);
            else if (canPreview(entry)) play(entry);
            refreshSelectionPresentation();
        };
        const titleCellElement = row.querySelector('.asset-title');
        const titleTextElement = titleCellElement?.querySelector('.asset-title-text');
        titleCellElement?.addEventListener('click', event => {
            if (!event.target.closest('.asset-title-text')) return;
            event.stopPropagation();
            if (event.detail !== 1) return;

            // A short delay distinguishes a title click (preview) from a
            // double-click (edit) without briefly starting then stopping audio.
            titlePreviewTimer = window.setTimeout(() => {
                titlePreviewTimer = null;
                previewEntry();
            }, 220);
        });
        if (titleEditable) {
            titleCellElement?.addEventListener('dblclick', event => {
                if (!event.target.closest('.asset-title-text')) return;
                if (titlePreviewTimer !== null) {
                    window.clearTimeout(titlePreviewTimer);
                    titlePreviewTimer = null;
                }
                event.preventDefault();
                event.stopPropagation();
                if (titleTextElement) beginCellEdit(titleTextElement, entry, 'title');
            });
        }
        row.querySelectorAll('.editable-cell').forEach(cell => {
            if (cell.dataset.field === 'title') return;
            cell.addEventListener('click', event => {
                event.stopPropagation();
            });
            cell.addEventListener('dblclick', event => {
                event.preventDefault();
                event.stopPropagation();
                beginCellEdit(cell, entry, cell.dataset.field);
            });
        });
        row.querySelector('.reference-label')?.addEventListener('click', event => {
            event.stopPropagation();
        });
        row.querySelector('.reference-label')?.addEventListener('dblclick', event => {
            event.preventDefault();
            event.stopPropagation();
            beginReferenceLabelEdit(event.currentTarget, entry);
        });
        row.querySelector('.file-version-selector')?.addEventListener('change', event => {
            if (!entry.fileVersionGroup) return;
            state.versionSelections.set(entry.fileVersionGroup, String(event.currentTarget.value));
            renderFilterUI();
            renderAssets();
        });
        row.querySelector('.reference-version-selector')?.addEventListener('change', event => {
            const selected = entry.versions.find(version => Number(version.item.id) === Number(event.currentTarget.value));
            if (!selected) return;
            const record = (state.projectReferencedItems.get(Number(entry.collection.id)) || [])
                .find(candidate => candidate.version_group === entry.versionGroup);
            if (record) {
                record.item = selected.item;
                record.reference = selected.reference;
            }
            renderAssets();
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
            state.isDraggingItem = true;
            row.classList.add('dragging');
        });
        row.addEventListener('dragend', () => {
            state.isDraggingItem = false;
            stopDragAutoScroll();
            row.classList.remove('dragging');
        });
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
                    if (itemIds.length) placeItemsDirectly(entry, [...new Set(itemIds)]);
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
                refreshSelectionPresentation();
            }
        });
        row.addEventListener('click', event => {
            if (event.target.closest('.editable-cell, input, select, button')) return;
            if (event.ctrlKey || event.metaKey || event.shiftKey) return;
            selectEntry(entry, event);
            refreshSelectionPresentation();
        });
        row.addEventListener('dblclick', event => {
            if (event.target.closest('button, input, select, textarea, .editable-cell')) return;
            if (isCollection) {
                toggleCollectionExpansion(entry);
                return;
            }
            if (event.target.closest('.metadata-text, .tags-text, .path-text, .size-text, .type-badge')) return;
            if (!canPreview(entry)) return;
            previewEntry();
        });
        row.addEventListener('contextmenu', event => {
            event.preventDefault();
            if (!state.selectedEntryIds.has(entry.id)) {
                state.selectedEntryIds.clear();
                state.selectedEntryIds.add(entry.id);
                state.selectionAnchorId = entry.id;
                refreshSelectionPresentation();
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
            if (clean && clean !== '.') return clean;
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

    function renderCollectionTree(node, collection, collectionLayout, container, depth = 0) {
        const collectionId = Number(collection.id);

        const sortedSubfolders = Array.from(node.subfolders.values()).sort((a, b) =>
            a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
        );

        sortedSubfolders.forEach(subfolder => {
            const subfolderKey = `${collectionId}:${subfolder.fullPath}`;
            const folderEntryId = `subfolder:${collectionId}:${subfolder.fullPath}`;
            const totalFiles = countTreeFiles(subfolder);
            const isExpanded = state.expandedSubfolders.has(subfolderKey);

            const folderItemId = entryFolderItemId(subfolder.folderItem);

            const folderEntry = {
                id: folderEntryId,
                kind: 'subfolder',
                type: 'folder',
                title: subfolder.name,
                name: subfolder.name,
                path: subfolder.fullPath,
                fullPath: subfolder.fullPath,
                collection: collection,
                subfolder: subfolder,
                folderItem: subfolder.folderItem || null,
                item: subfolder.folderItem?.item
                    || (folderItemId ? { id: Number(folderItemId), vault_id: collection.vault_id, type: 'collection', attributes: { is_folder: true } } : { id: null, vault_id: collection.vault_id, type: 'folder', attributes: { is_folder: true } }),
                content: subfolder.folderItem?.content || subfolder.folderItem || { child_id: folderItemId ? Number(folderItemId) : null, vault_id: collection.vault_id, attributes: { is_folder: true } },
            };
            state.subfolderEntries.set(folderEntryId, folderEntry);

            const row = document.createElement('div');
            row.className = 'subfolder-row';
            row.dataset.entryId = folderEntryId;
            row.setAttribute('role', 'listitem');
            const isSelected = state.selectedEntryIds.has(folderEntryId);
            row.classList.toggle('selected', isSelected);
            row.setAttribute('aria-selected', String(isSelected));
            row.style.setProperty('--row-columns', collectionLayout.columns);

            const favPlaceholder = document.createElement('span');

            const nameCell = document.createElement('div');
            nameCell.className = 'subfolder-name-cell';
            nameCell.style.paddingLeft = `${depth * 16 + 8}px`;

            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'subfolder-toggle';
            toggle.setAttribute('aria-label', isExpanded ? 'Collapse folder' : 'Expand folder');
            toggle.textContent = isExpanded ? '▾' : '▸';

            const icon = document.createElement('span');
            icon.className = 'subfolder-icon';
            icon.setAttribute('aria-hidden', 'true');
            icon.textContent = '📁';

            const title = document.createElement('span');
            title.className = 'subfolder-title';
            title.textContent = subfolder.name;

            const count = document.createElement('span');
            count.className = 'subfolder-count';
            count.textContent = `(${totalFiles})`;

            nameCell.appendChild(toggle);
            nameCell.appendChild(icon);
            nameCell.appendChild(title);
            nameCell.appendChild(count);

            row.appendChild(favPlaceholder);
            row.appendChild(nameCell);

            for (let i = 2; i < collectionLayout.fields.length; i += 1) {
                row.appendChild(document.createElement('span'));
            }

            const toggleSubfolder = () => {
                if (state.expandedSubfolders.has(subfolderKey)) {
                    state.expandedSubfolders.delete(subfolderKey);
                } else {
                    state.expandedSubfolders.add(subfolderKey);
                }
                renderAssets();
            };

            toggle.addEventListener('click', event => {
                event.stopPropagation();
                toggleSubfolder();
            });

            row.addEventListener('click', event => {
                if (event.target.closest('.subfolder-toggle, button, input, select')) return;
                selectEntry(folderEntry, event);
                refreshSelectionPresentation();
            });

            row.addEventListener('dblclick', event => {
                if (event.target.closest('.subfolder-toggle, button, input, select')) return;
                toggleSubfolder();
            });

            row.addEventListener('contextmenu', event => {
                event.preventDefault();
                if (!state.selectedEntryIds.has(folderEntry.id)) {
                    state.selectedEntryIds.clear();
                    state.selectedEntryIds.add(folderEntry.id);
                    state.selectionAnchorId = folderEntry.id;
                    refreshSelectionPresentation();
                }
                state.contextEntry = folderEntry;
                renderContextMenu();
                contextMenu.classList.remove('hidden');
                const width = contextMenu.offsetWidth || 180;
                const height = contextMenu.offsetHeight || 120;
                contextMenu.style.left = `${Math.min(event.clientX, window.innerWidth - width - 8)}px`;
                contextMenu.style.top = `${Math.min(event.clientY, window.innerHeight - height - 8)}px`;
            });

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
                    const itemIds = JSON.parse(rawIds).map(Number).filter(id => Number.isFinite(id) && id !== Number(folderItemId));
                    if (itemIds.length) {
                        const targetFolder = subfolder.fullPath || folderEntry.path || folderEntry.title;
                        placeItemsDirectly(folderEntry, [...new Set(itemIds)], { folder: targetFolder });
                    }
                } catch (_error) {
                    window.alert('GAIA could not read the dragged items.');
                }
            });

            container.appendChild(row);

            if (isExpanded) {
                if (subfolder.files.length === 0 && subfolder.subfolders.size === 0) {
                    const emptyRow = document.createElement('div');
                    emptyRow.className = 'empty-subfolder-hint';
                    emptyRow.style.paddingLeft = `${(depth + 1) * 16 + 28}px`;
                    emptyRow.textContent = 'This folder is empty';
                    container.appendChild(emptyRow);
                } else {
                    renderCollectionTree(subfolder, collection, collectionLayout, container, depth + 1);
                }
            }
        });

        node.files.forEach(content => {
            container.appendChild(createEntry(content, { nested: true, subfolderDepth: depth }));
        });
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
        renderFilterStatus();
    }

    function renderAssets() {
        state.subfolderEntries?.clear();
        const entries = visibleEntries();
        assetList.innerHTML = '';
        renderMoveBar();

        if (!entries.length) {
            assetList.innerHTML += '<div class="empty">No assets match this view.</div>';
        } else {
            entries.forEach(entry => {
                const wrapper = createEntry(entry);

                const isCollectionExpanded = state.expandedCollections.has(entry.id) || (entry.item?.id && state.expandedCollections.has(String(entry.item.id)));
                const isContainerItem = typeIsContainer(entry.type) || entry.type === 'collection' || Boolean(entry.item?.attributes?.is_folder || entry.content?.attributes?.is_folder);
                if (entry.kind === 'asset' && isContainerItem && isCollectionExpanded) {
                    const contentContainer = document.createElement('div');
                    const collectionLayout = collectionRowLayout(entry.item);
                    contentContainer.className = `collection-contents collection-layout-${collectionLayout.id}`;
                    const collectionId = Number(entry.item.id);
                    const contents = collectionContentEntries(entry.item);
                    const displayedContents = filteringIsActive() && !entryMatches(entry) ? contents.filter(entryMatches) : contents;
                    if (displayedContents.length) contentContainer.appendChild(createCollectionHeader(entry.item));
                    const tree = buildCollectionTree(displayedContents);
                    renderCollectionTree(tree, entry.item, collectionLayout, contentContainer, 0);
                    if (!displayedContents.length) {
                        const loadingReferences = state.projectReferencesLoading.has(Number(entry.item.id));
                        const loadingContents = state.collectionContentsLoading.has(collectionId);
                        const error = state.collectionContentsErrors.get(collectionId);
                        contentContainer.innerHTML = `<div class="empty">${loadingContents ? 'Loading collection contents…' : error ? escapeHtml(error) : loadingReferences ? 'Loading referenced files…' : filteringIsActive() ? 'No files in this collection match the active filter.' : 'This folder is empty.'}</div>`;
                    }
                    const page = state.collectionContentPaging.get(collectionId);
                    if (page?.hasMore) {
                        const loadMore = document.createElement('button');
                        loadMore.type = 'button';
                        loadMore.className = 'secondary collection-load-more';
                        loadMore.textContent = state.collectionContentsLoading.has(collectionId)
                            ? 'Loading…'
                            : `Load more (${Math.max(0, page.total - page.nextOffset)} remaining)`;
                        loadMore.disabled = state.collectionContentsLoading.has(collectionId);
                        loadMore.addEventListener('click', event => {
                            event.stopPropagation();
                            loadCollectionContents(collectionId);
                        });
                        contentContainer.appendChild(loadMore);
                    }
                    wrapper.appendChild(contentContainer);
                }
                assetList.appendChild(wrapper);
            });
        }

        renderLibraryStatus(entries);
    }

    function refreshSelectionPresentation() {
        assetList.querySelectorAll('.asset-row, .subfolder-row').forEach(row => {
            const entryId = row.dataset.entryId || row.closest('.asset-entry')?.dataset.entryId;
            const selected = entryId ? state.selectedEntryIds.has(entryId) : false;
            row.classList.toggle('selected', selected);
            row.setAttribute('aria-selected', String(selected));
        });
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

    function clearSelection() {
        if (state.selectedEntryIds.size > 0 || state.selectionAnchorId || state.contextEntry) {
            state.selectedEntryIds.clear();
            state.selectionAnchorId = null;
            state.contextEntry = null;
            refreshSelectionPresentation();
            window.dispatchEvent(new CustomEvent('gaia:selection', { detail: { entry: null } }));
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
                navigator.clipboard.writeText(payload).catch(() => {});
            }
        } catch (_err) {}
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
        state.selectedTypes.clear();
        state.selectedTags.clear();
        state.query = '';
        searchInput.value = '';
        state.collectionContentControllers.forEach(controller => controller.abort());
        state.collectionContentControllers.clear();
        state.collectionContentsLoading.clear();
        state.collectionContents.clear();
        state.collectionContentPaging.clear();
        state.collectionContentsErrors.clear();
        state.collectionContentQuery = '';
        renderVaults();
        renderFilterUI();
        renderAssets();
        loadLibrary({ query: null });
    }

    function getSelectedEntries() {
        const entries = allEntries();
        const selected = [];
        state.selectedEntryIds.forEach(id => {
            let found = entries.find(e => e.id === id);
            if (!found && state.subfolderEntries?.has(id)) {
                found = state.subfolderEntries.get(id);
            }
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
            projectSourceList.replaceChildren();
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

    async function requestImportPreview(path, vaultId) {
        const response = await fetch('/items/import/preview', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source_path: path, vault_id: vaultId }),
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
            const preview = await requestImportPreview(path, selectedProjectVaultId());
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
                    .filter(node => node.kind === 'folder' && node.detected_assignment)
                    .map(node => [node.relative_path, node.detected_assignment]),
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

    async function finishProjectCreationImport(context) {
        const sourceIds = [...new Set(context.itemIds)];
        const payload = { vault_id: context.vaultId, name: context.name };
        const url = sourceIds.length ? '/projects/from-items' : '/projects/';
        if (sourceIds.length) {
            payload.item_ids = sourceIds;
            payload.mode = 'single';
            payload.move_item_ids = [...new Set(context.moveItemIds)];
        }
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
            state.projectMoveIds.clear();
            state.projectPendingImports = [];
            state.projectPendingMoveIds.clear();
            state.projectCreationImportContext = null;
            projectDialog.close();
            await loadLibrary();
            await loadVaultImportLog();
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

    function openProjectDialog() {
        if (!projectDialog) return;
        const selectedSources = getSelectedProjectSourceEntries();
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
        projectResult.className = 'result hidden';
        projectName.value = selectedSources.length ? selectedSources[0].title : '';
        projectName.required = true;
        projectName.disabled = false;
        if (projectMoveAll) {
            projectMoveAll.checked = false;
            projectMoveAll.indeterminate = false;
        }
        projectDialogTitle.textContent = 'Create a Project';
        renderProjectSourcePreview();
        projectDialog.showModal();
        projectName.focus();
        if (selectedSources.length === 1) projectName.select();
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
        if (isVault) {
            await loadLibrary({ force: true, resetNested: true });
            renderFilterUI();
            renderAssets();
            return;
        }

        const idsToInvalidate = new Set([
            contextCollectionId,
            targetId,
            ...(sourceCollectionIds || []),
        ].map(Number).filter(id => Number.isFinite(id) && id > 0));

        idsToInvalidate.forEach(id => {
            state.collectionContents.delete(id);
            state.projectReferencedItems.delete(id);
            state.collectionContentPaging.delete(id);
            state.collectionContentsLoading.delete(id);
            state.projectReferencesLoading.delete(id);
        });

        await Promise.all([
            ...Array.from(idsToInvalidate).map(id => loadCollectionContents(id, { reset: true })),
            ...Array.from(idsToInvalidate).map(id => loadProjectReferencedItems(id, { reset: true })),
            loadLibrary({ force: true, resetNested: true }),
        ]);

        renderFilterUI();
        renderAssets();
    }

    async function placeItemsDirectly(targetEntry, itemIds, { folder = undefined, mode = 'reference' } = {}) {
        const uniqueItemIds = [...new Set((itemIds || []).map(Number).filter(id => Number.isFinite(id) && id > 0))];
        if (!uniqueItemIds.length) return;

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

        const isVault = Boolean(targetEntry?.isVault);
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
                mode,
            };
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
                const index = state.items.findIndex(item => Number(item.id) === Number(moved.id));
                if (index >= 0) state.items[index] = { ...state.items[index], ...moved };
                state.collectionContents.delete(Number(moved.id));
                state.collectionContentPaging.delete(Number(moved.id));
            });
            state.selectedEntryIds.clear();
            reconcileFilterSelection();
            renderFilterUI();
            renderAssets();
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
            if (analyzeSelectionButton) analyzeSelectionButton.disabled = true;
            if (deleteSelectionButton) deleteSelectionButton.disabled = true;
            moveTargetOptions?.replaceChildren();
            renderSelectionTypeActions([]);
            return;
        }
        moveCount.textContent = `${selectedCount} selected`;
        if (selectionMoveTrigger) selectionMoveTrigger.disabled = false;
        if (analyzeSelectionButton) analyzeSelectionButton.disabled = false;
        if (deleteSelectionButton) deleteSelectionButton.disabled = !selectedEntries.some(deletionTargetForEntry);
        if (moveTargetOptions) moveTargetOptions.replaceChildren();
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
            moveTargetOptions?.appendChild(option);
        });
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
        if (entry.kind === 'asset') {
            const itemId = numericItemId(entry);
            if (!itemId) return null;
            return {
                key: `item:${itemId}`,
                label: entry.title || `Asset ${itemId}`,
                locator: { kind: 'item', item_id: itemId },
            };
        }
        if (entry.kind === 'subfolder') {
            const id = entryFolderItemId(entry);
            if (id) {
                return {
                    key: `item:${id}`,
                    label: entry.title || `Folder ${id}`,
                    locator: { kind: 'item', item_id: id },
                };
            }
            return null;
        }
        if (entry.kind === 'content') {
            const collectionId = Number(entry.collection?.id);
            const contentIndex = Number(entry.content?.index);
            const childId = Number(entry.content?.child_id || entry.item?.id);
            if (entry.content?.attributes?.is_folder && Number.isFinite(childId)) {
                return {
                    key: `item:${childId}`,
                    label: entry.title || `Folder ${childId}`,
                    locator: { kind: 'item', item_id: childId },
                };
            }
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

        state.items = state.items.filter(item => !itemIds.has(Number(item.id)));
        const contentWasDeleted = (content, collectionId) => (
            itemIds.has(Number(content?.child_id))
            || contentKeys.has(collectionContentKey(collectionId, content?.index))
        );
        state.items.forEach(collection => {
            if (!typeIsContainer(collection.type) || !Array.isArray(collection.contents)) return;
            collection.contents = collection.contents.filter(content => !contentWasDeleted(content, collection.id));
        });
        state.items.forEach(collection => {
            const deletedCount = deletedContentCounts.get(Number(collection.id)) || 0;
            if (deletedCount && Number.isFinite(Number(collection.content_count))) {
                collection.content_count = Math.max(0, Number(collection.content_count) - deletedCount);
            }
        });
        state.collectionContents.forEach((contents, collectionId) => {
            const remaining = contents.filter(content => !contentWasDeleted(content, collectionId));
            const removed = contents.length - remaining.length;
            if (!removed) return;
            state.collectionContents.set(collectionId, remaining);
            const page = state.collectionContentPaging.get(collectionId);
            if (page) {
                const nextOffset = Math.max(remaining.length, page.nextOffset - removed);
                const total = Math.max(remaining.length, page.total - removed);
                state.collectionContentPaging.set(collectionId, {
                    ...page,
                    nextOffset,
                    total,
                    hasMore: page.hasMore && nextOffset < total,
                });
            }
        });
        [...state.versionSelections.entries()].forEach(([groupKey, itemId]) => {
            if (itemIds.has(Number(itemId))) state.versionSelections.delete(groupKey);
        });
        itemIds.forEach(id => {
            state.expandedCollections.delete(String(id));
            state.collectionContents.delete(id);
            state.collectionContentPaging.delete(id);
            state.collectionContentsErrors.delete(id);
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
        const filterStateAfter = JSON.stringify({
            vault: state.selectedVaultId,
            types: [...state.selectedTypes].sort(),
            tags: [...state.selectedTags].sort(),
        });
        if (filterStateBefore !== filterStateAfter) {
            renderAssets();
            return;
        }

        // Version groups can retain sibling files after their currently shown
        // version is deleted, so redraw rather than removing one DOM row.
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

    function renderContextMenu() {
        if (!contextVaultOptions) return;

        const count = (state.contextEntry && state.selectedEntryIds.has(state.contextEntry.id))
            ? state.selectedEntryIds.size
            : (state.contextEntry ? 1 : state.selectedEntryIds.size);

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

        if (analyzeEntryButton) {
            analyzeEntryButton.disabled = count === 0;
            analyzeEntryButton.textContent = count > 1 ? `Analyze metadata (${count} items)` : 'Analyze metadata';
        }
        if (deleteEntryMenuButton) {
            deleteEntryMenuButton.disabled = count === 0;
            deleteEntryMenuButton.textContent = count > 1 ? `Delete selected (${count})` : 'Delete selected';
        }

        const selectedEntries = getSelectedEntries();
        const targetEntry = state.contextEntry || (selectedEntries.length === 1 ? selectedEntries[0] : null);
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

        contextVaultOptions.innerHTML = '<div class="context-header sin-menu-heading">Move or copy to vault</div>';
        if (count === 0) {
            contextVaultOptions.classList.add('hidden');
            return;
        }
        contextVaultOptions.classList.remove('hidden');
        const externalSelected = selectedCommandEntries().some(entry => (
            String(entryRecord(entry)?.storage_mode || '').toLowerCase() === 'external_reference'
        ));
        state.vaults.forEach(vault => {
            const group = document.createElement('div');
            group.className = 'context-vault-actions';
            const label = document.createElement('span');
            label.className = 'context-vault-name';
            label.textContent = vault.name;
            group.appendChild(label);
            [['move', 'Move'], ['copy', 'Copy']].forEach(([mode, labelText]) => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'sin-menu-item';
                btn.textContent = labelText;
                btn.disabled = mode === 'copy' && !externalSelected;
                btn.title = mode === 'move'
                    ? `Move selected assets to ${vault.name}`
                    : (externalSelected ? `Copy external references into ${vault.name}` : 'Copy is available for external references');
                btn.addEventListener('click', async event => {
                    event.preventDefault();
                    event.stopPropagation();
                    contextMenu.classList.add('hidden');
                    await moveSelectedEntriesToVault(vault.id, mode);
                });
                group.appendChild(btn);
            });
            contextVaultOptions.appendChild(group);
        });

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

    function closeVaultMenu() {
        vaultMenu?.classList.add('hidden');
        vaultPicker?.setAttribute('aria-expanded', 'false');
    }

    function renderVaultMenu() {
        if (!vaultMenuList) return;
        const activeVault = selectedVault();
        const showAll = state.selectedVaultId === null;
        if (activeVaultName) activeVaultName.textContent = activeVault?.name || 'Show all';
        if (vaultMenuDeleteButton) {
            vaultMenuDeleteButton.disabled = !activeVault || state.vaults.length <= 1;
            vaultMenuDeleteButton.title = state.vaults.length <= 1 ? 'The last vault cannot be deleted' : 'Delete active vault';
        }
        if (vaultMenuOptionsButton) vaultMenuOptionsButton.disabled = !activeVault;

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
                state.selectedVaultId = value;
                closeVaultMenu();
                reconcileFilterSelection();
                renderVaults();
                renderFilterUI();
                renderAssets();
                loadVaultImportLog();
                loadLibrary({ force: true, resetNested: true });
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

    async function createVaultRecord(name, path = null, preview = 'quick') {
        const response = await fetch('/vaults/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, description: null, path: path || null, preview }),
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
                const vault = await createVaultRecord(
                    name,
                    vaultPathInput?.value.trim() || null,
                    vaultPreviewSelect?.value || 'quick',
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

    async function loadLibrary({
        query = state.query || null,
        force = false,
        resetNested = false,
    } = {}) {
        const requestedQuery = query?.trim().toLowerCase() || null;
        if (!force && state.libraryLoadPromise && state.libraryLoadQuery === requestedQuery) return state.libraryLoadPromise;
        if (force) state.libraryLoadController?.abort();
        if (resetNested) resetNestedLibraryCaches();
        const controller = new AbortController();
        state.libraryLoadController?.abort();
        state.libraryLoadController = controller;
        state.libraryLoadQuery = requestedQuery;

        const requestPromise = (async () => {
            const hasExistingLibrary = state.items.length > 0;
            if (!hasExistingLibrary) assetList.innerHTML = '<div class="empty">Loading library…</div>';
            else summary.textContent = 'Updating library…';
            try {
                const vaultsPromise = state.vaults.length
                    ? Promise.resolve(state.vaults)
                    : loadVaults({ signal: controller.signal });
                const typesPromise = state.types.length
                    ? Promise.resolve(state.types)
                    : fetch('/items/types', { signal: controller.signal }).then(async response => {
                        if (!response.ok) throw new Error('GAIA could not load item types');
                        return response.json();
                    });
                const vaultScope = state.selectedVaultId === null
                    ? '&vault_preview=quick'
                    : `&vault_id=${encodeURIComponent(state.selectedVaultId)}`;
                const querySuffix = requestedQuery ? `&query=${encodeURIComponent(requestedQuery)}` : '';
                const itemsPromise = fetch(`/items/summaries?limit=10000${vaultScope}${querySuffix}`, { signal: controller.signal }).then(async response => {
                    if (!response.ok) throw new Error('GAIA could not load the library');
                    return response.json();
                });
                const [loadedTypes, loadedItems] = await Promise.all([typesPromise, itemsPromise, vaultsPromise]).then(values => [values[0], values[1]]);
                if (state.libraryLoadController !== controller) return;
                state.types = loadedTypes;
                state.items = loadedItems;
                if (!requestedQuery) state.catalogItems = loadedItems;
                const nextCollectionQuery = requestedQuery || '';
                if (state.collectionContentQuery !== nextCollectionQuery) {
                    resetNestedLibraryCaches();
                }
                state.collectionContentQuery = nextCollectionQuery;
                const validCollectionIds = new Set(
                    state.items.filter(item => typeIsContainer(item.type)).map(item => Number(item.id)),
                );
                [...state.collectionContents.keys()].forEach(id => {
                    if (!validCollectionIds.has(Number(id))) {
                        state.collectionContents.delete(id);
                        state.collectionContentPaging.delete(id);
                    }
                });
                state.projectReferenceControllers.forEach(activeController => activeController.abort());
                state.projectReferencedItems.clear();
                state.projectReferencesLoading.clear();
                state.projectReferenceControllers.clear();
                const availableEntryIds = new Set(allEntries().map(entry => entry.id));
                state.selectedEntryIds = new Set([...state.selectedEntryIds].filter(id => availableEntryIds.has(id)));
                if (!availableEntryIds.has(state.selectionAnchorId)) state.selectionAnchorId = null;
                if (!requestedQuery) reconcileFilterSelection();
                renderFilterUI();
                renderAssets();
                state.items
                    .filter(item => typeIsContainer(item.type) && (
                        state.expandedCollections.has(String(item.id)) || (requestedQuery && item.matches_query)
                    ))
                    .forEach(item => {
                        if (!state.collectionContents.has(Number(item.id))) loadCollectionContents(item.id, { reset: true });
                        loadProjectReferencedItems(item.id);
                    });
            } catch (error) {
                if (error?.name === 'AbortError') return;
                if (!hasExistingLibrary) assetList.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
                summary.textContent = hasExistingLibrary ? `Library update failed: ${error.message}` : 'Library unavailable';
            } finally {
                if (state.libraryLoadController === controller) state.libraryLoadController = null;
            }
        })();
        state.libraryLoadPromise = requestPromise;
        try {
            await requestPromise;
        } finally {
            if (state.libraryLoadPromise === requestPromise) {
                state.libraryLoadPromise = null;
                state.libraryLoadQuery = null;
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

    function closeAppMenus() {
        appMenuBar?.querySelectorAll('.app-menu-root.is-open').forEach(root => {
            root.classList.remove('is-open');
            root.querySelector('.app-menu-trigger')?.setAttribute('aria-expanded', 'false');
        });
        selectionMoveSubmenu?.classList.remove('is-open');
        selectionMoveTrigger?.setAttribute('aria-expanded', 'false');
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
        selectionMoveSubmenu?.classList.toggle('is-open', !isOpen);
        selectionMoveTrigger.setAttribute('aria-expanded', String(!isOpen));
    });

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
        if (filterStatus.dataset.syncing === '1') return;
        assetList.scrollLeft = filterStatus.scrollLeft;
    });
    assetList?.addEventListener('scroll', () => {
        if (assetList.dataset.syncing === '1') return;
        filterStatus.dataset.syncing = '1';
        filterStatus.scrollLeft = assetList.scrollLeft;
        delete filterStatus.dataset.syncing;
    });

    renderMainHeader();

    searchInput.addEventListener('input', () => {
        clearTimeout(state.searchDebounceTimer);
        state.searchDebounceTimer = setTimeout(() => {
            state.query = searchInput.value.trim().toLowerCase();
            state.collectionContentControllers.forEach(controller => controller.abort());
            state.collectionContentControllers.clear();
            state.collectionContentsLoading.clear();
            state.collectionContents.clear();
            state.collectionContentPaging.clear();
            state.collectionContentsErrors.clear();
            state.collectionContentQuery = state.query;
            renderFilterUI();
            renderAssets();
            loadLibrary({ query: state.query || null });
        }, 180);
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
    projectDialogClose?.addEventListener('click', () => projectDialog.close());
    projectDialogCancel?.addEventListener('click', () => projectDialog.close());
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
        projectResult.className = 'result hidden';

        if (pendingImports.length) {
            state.projectCreationImportContext = {
                name,
                vaultId,
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

        const payload = { vault_id: vaultId, name };
        const url = sourceIds.length ? '/projects/from-items' : '/projects/';
        if (sourceIds.length) {
            payload.item_ids = sourceIds;
            payload.mode = 'single';
            payload.move_item_ids = [...state.projectMoveIds];
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
        }
    });
    assetList?.addEventListener('scroll', () => contextMenu.classList.add('hidden'));

    window.addEventListener('dragover', handleDragAutoScroll, { capture: true, passive: true });
    window.addEventListener('dragend', () => {
        state.isDraggingItem = false;
        stopDragAutoScroll();
    }, { capture: true });
    window.addEventListener('drop', () => {
        state.isDraggingItem = false;
        stopDragAutoScroll();
    }, { capture: true });

    assetList?.addEventListener('dragover', event => {
        if (state.isDraggingItem || Array.from(event.dataTransfer?.types || []).includes('application/x-gaia-item-ids')) {
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
        if (event.target.closest('button, input, select, textarea, label, dialog, .sin-menu-surface, .sin-menu-item, .app-menu-bar, .media-editor-dock, .filter-chip, .column-resizer, .file-version-selector')) {
            return;
        }
        clearSelection();
    });

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
        openImportButton.disabled = busy || Boolean(state.importJobId);
        openImportButton.title = busy || state.importJobId ? 'An import is already running' : 'Import assets';
    }

    function resetImportFlow() {
        state.importPreview = null;
        state.importFolderAssignments = new Map();
        state.importItemTypes = new Map();
        state.importExcludedIndexes = new Set();
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
        importSubmit.textContent = 'Inspect source';
        renderVaults();
        setImportBusy(false);
    }

    function importTypeLabel(type, displayType = null) {
        return displayType || typeLabel(type);
    }

    function folderAssignmentOptions(preview, selected) {
        const defaultFolderOptions = [
            { value: 'action:contain', label: 'Contain folder' },
            { value: 'action:ignore', label: 'Ignore folder (flatten)' },
            { value: 'type:multitrack', label: 'Multitrack' },
        ];
        const rawOptions = (preview.folder_type_options && preview.folder_type_options.length)
            ? preview.folder_type_options
            : defaultFolderOptions;
        const typeOptions = rawOptions.map(option =>
            `<option value="${escapeHtml(option.value)}" ${selected === option.value ? 'selected' : ''}>${escapeHtml(option.label)}</option>`
        ).join('');
        const profileOptions = (preview.profiles || [])
            .filter(profile => ['collection', 'multitrack'].includes(profile.container_type))
            .map(profile => {
                const value = `profile:${profile.id}`;
                return `<option value="${escapeHtml(value)}" ${selected === value ? 'selected' : ''}>${escapeHtml(profile.label)}</option>`;
            }).join('');
        return `<option value="" ${selected ? '' : 'selected'}>Unclassified folder</option>${typeOptions ? `<optgroup label="Folder actions & types">${typeOptions}</optgroup>` : ''}${profileOptions ? `<optgroup label="Profiles">${profileOptions}</optgroup>` : ''}`;
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

    function importFilterControl(preview, kind, option) {
        const value = option.value || '';
        const entries = (preview.entries || []).filter(entry => kind === 'type'
            ? (entry.family || 'file') === value
            : (entry.extension || '') === value);
        const checked = entries.length > 0 && entries.every(entry => state.importExcludedIndexes.has(entry.index));
        const dataName = kind === 'type' ? 'data-import-exclude-type' : 'data-import-exclude-extension';
        return `<label class="import-filter-chip"><input type="checkbox" ${dataName}="${escapeHtml(value)}" ${checked ? 'checked' : ''}><span>${escapeHtml(option.label)}</span><small>${Number(option.count) || entries.length}</small></label>`;
    }

    function renderImportFilters(preview) {
        const options = importFilterOptions(preview);
        return `<section class="import-preview-section import-filter-section"><div class="import-section-heading"><div><h3>Bulk exclusions</h3><p class="import-filter-help">Exclude file families or extensions from this import. The source remains untouched.</p></div><div class="import-filter-actions"><button id="import-keep-audio" class="secondary compact" type="button">Keep audio only</button><button id="import-include-all" class="secondary compact" type="button">Include all</button></div></div><div class="import-filter-groups"><div class="import-filter-group"><span>File types</span><div class="import-filter-chips">${options.types.map(option => importFilterControl(preview, 'type', option)).join('')}</div></div><div class="import-filter-group"><span>Extensions</span><div class="import-filter-chips">${options.extensions.map(option => importFilterControl(preview, 'extension', option)).join('')}</div></div></div></section>`;
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
                    <div class="import-tree-name"><input type="checkbox" class="import-folder-checkbox" data-import-folder-include="${escapeHtml(node.relative_path)}" aria-label="Include folder ${escapeHtml(node.relative_path === '.' ? preview.title : node.name)}"><button class="import-folder-toggle" type="button" data-import-collapse="${escapeHtml(node.relative_path)}" aria-label="${collapsed ? 'Expand' : 'Collapse'} ${escapeHtml(node.relative_path === '.' ? preview.title : node.name)}" aria-expanded="${!collapsed}">${collapsed ? '▸' : '▾'}</button><span class="import-tree-label"><strong>${escapeHtml(node.relative_path === '.' ? preview.title : node.name)}</strong>${reason}</span>${warning}</div>
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
        if (preview.source_kind === 'zip' && state.importTransferMode === 'keep') state.importTransferMode = 'copy';
        const transferHelp = {
            move: 'Moves the selected files into the vault. Originals disappear only after verified publication.',
            copy: 'Copies the selected files into the vault and leaves every original untouched.',
            keep: 'Registers read-only references to the original paths. No source file is changed.',
        }[state.importTransferMode];
        const startLabel = state.importTransferMode === 'move' ? 'Move files and import' : 'Start background import';
        const hasAudioEntries = (preview.entries || []).some(entry => (entry.family || '') === 'audio');
        importPreviewStep.innerHTML = `
            ${preview.warnings?.length ? `<div class="import-warning-box"><strong>Inspection warnings</strong>${preview.warnings.map(warning => `<div>${escapeHtml(warning)}</div>`).join('')}</div>` : ''}
            ${renderImportFilters(preview)}
            ${conflictPanel}
            <section class="import-transfer-choice"><label for="import-transfer-mode"><strong>File handling</strong></label><select id="import-transfer-mode"><option value="move" ${state.importTransferMode === 'move' ? 'selected' : ''}>Move files into vault</option><option value="copy" ${state.importTransferMode === 'copy' ? 'selected' : ''}>Copy files into vault</option><option value="keep" ${state.importTransferMode === 'keep' ? 'selected' : ''} ${preview.source_kind === 'zip' ? 'disabled' : ''}>Keep files in original position (reference)</option></select><p>${escapeHtml(transferHelp)}</p></section>
            ${hasAudioEntries ? `<label class="import-analysis-choice"><input id="import-skip-track-analysis" type="checkbox" ${state.skipTrackAnalysis ? 'checked' : ''}><span><strong>Skip analysis for tracks</strong><small>Import rows assigned the Track type using inspection only; BPM, key, duration, and embedded metadata will remain empty until analyzed later.</small></span></label>` : ''}
            <section class="import-preview-section"><div class="import-section-heading"><h3>Inspected folders and files</h3><button id="import-exclude-artifacts" class="secondary compact" type="button" ${remainingArtifacts.length ? '' : 'disabled'}>Exclude flagged artifacts${remainingArtifacts.length ? ` (${remainingArtifacts.length})` : ''}</button></div><div class="import-tree-head"><span>Name</span><span>Inspection</span><span>Type or profile</span><span>Size</span></div><div class="import-tree">${rows || '<div class="empty">No files were found.</div>'}</div></section>
            <div class="dialog-actions"><button id="import-preview-back" class="secondary" type="button">Choose another source</button><button id="import-job-start" class="primary" type="button" ${canStart ? '' : 'disabled'}>${escapeHtml(startLabel)}</button></div>`;
        importPreviewStep.querySelectorAll('input[data-import-folder-include]').forEach(checkbox => {
            const folderPath = checkbox.dataset.importFolderInclude;
            const descendants = (preview.entries || []).filter(entry =>
                folderPath === '.' || entry.relative_path === folderPath || entry.relative_path.startsWith(`${folderPath}/`)
            );
            if (!descendants.length) {
                checkbox.checked = true;
                checkbox.indeterminate = false;
                return;
            }
            const included = descendants.filter(e => !state.importExcludedIndexes.has(e.index)).length;
            if (included === 0) {
                checkbox.checked = false;
                checkbox.indeterminate = false;
            } else if (included === descendants.length) {
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
        importPreviewStep.querySelectorAll('[data-import-folder]').forEach(select => select.addEventListener('change', () => {
            if (select.value) state.importFolderAssignments.set(select.dataset.importFolder, select.value);
            else state.importFolderAssignments.delete(select.dataset.importFolder);
            renderImportPreview();
        }));
        importPreviewStep.querySelectorAll('[data-import-folder-include]').forEach(input => input.addEventListener('change', () => {
            const folderPath = input.dataset.importFolderInclude;
            const descendants = (preview.entries || []).filter(entry =>
                folderPath === '.' || entry.relative_path === folderPath || entry.relative_path.startsWith(`${folderPath}/`)
            );
            if (input.checked) {
                descendants.forEach(entry => state.importExcludedIndexes.delete(entry.index));
            } else {
                descendants.forEach(entry => state.importExcludedIndexes.add(entry.index));
            }
            renderImportPreview();
        }));
        importPreviewStep.querySelectorAll('[data-import-item]').forEach(select => select.addEventListener('change', () => {
            state.importItemTypes.set(Number(select.dataset.importItem), select.value);
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
            if (input.checked) state.importExcludedIndexes.delete(index);
            else state.importExcludedIndexes.add(index);
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
        importPreviewStep.querySelector('#import-conflict-action')?.addEventListener('change', event => {
            state.importConflictAction = event.target.value || null;
            renderImportPreview();
        });
        importPreviewStep.querySelector('#import-preview-back')?.addEventListener('click', resetImportFlow);
        importPreviewStep.querySelector('#import-job-start')?.addEventListener('click', startImportJob);
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
        if (projectImportAdd) projectImportAdd.disabled = active;
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
                && Number(job.registration_completed || 0) >= Number(job.registration_total || job.total || 0)
                && state.importRegisteredJobId !== job.job_id
            ) {
                state.importRegisteredJobId = job.job_id;
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
            await loadLibrary({ force: true, resetNested: true });
            const refreshId = entryFolderItemId(parentEntry);
            if (refreshId) {
                state.collectionContents.delete(refreshId);
                loadCollectionContents(refreshId, { reset: true });
                if (typeIsProject(parentEntry.item?.type || parentEntry.type)) {
                    loadProjectReferencedItems(refreshId, { reset: true });
                }
            }
            const collId = Number(parentEntry?.collection?.id);
            if (collId && collId !== refreshId) {
                state.collectionContents.delete(collId);
                loadCollectionContents(collId, { reset: true });
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
        const choosingVaultPath = Boolean(state.vaultPathPickerMode);
        state.sourcePickerDirectory = result.path;
        state.sourcePickerParent = result.parent;
        state.sourcePickerSelection = choosingVaultPath ? null : result.selected_path || null;
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
            const preview = await requestImportPreview(sourcePath.value, state.importVaultId);
            state.importPreview = preview;
            state.importFolderAssignments = new Map(
                (preview.nodes || [])
                    .filter(node => node.kind === 'folder' && node.detected_assignment)
                    .map(node => [node.relative_path, node.detected_assignment]),
            );
            state.importItemTypes = new Map((preview.entries || []).map(entry => [entry.index, entry.type]));
            state.importExcludedIndexes = new Set();
            state.importTransferMode = 'copy';
            state.skipTrackAnalysis = false;
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
    sourcePickerDialog.addEventListener('close', () => {
        state.projectImportPickerActive = false;
        state.vaultPathPickerMode = null;
    });
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
        if (state.vaultPathPickerMode) return;
        state.sourcePickerSelection = entry.dataset.path;
        updateSourcePickerSelection();
    });
    sourcePickerList.addEventListener('dblclick', event => {
        if (state.vaultPathPickerMode) return;
        const entry = event.target.closest('.source-picker-row[data-kind="file"]');
        if (!entry) return;
        state.sourcePickerSelection = entry.dataset.path;
        chooseSourcePickerPath();
    });
    sourcePickerChoose.addEventListener('click', chooseSourcePickerPath);
    vaultPathAction?.addEventListener('click', () => {
        openVaultPathPicker(vaultDialogMode === 'rename' ? 'migrate' : 'create');
    });
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
    window.addEventListener('gaia:transport-command', event => {
        const detail = event.detail || {};
        window.gaiaTransport?.handleCommand?.(detail);
        if (detail.handled) return;
        if (detail.command === 'toggle') {
            if (!state.audio) return;
            if (state.audio.paused) state.audio.play();
            else state.audio.pause();
        } else if (detail.command === 'stop') {
            stopPlayback();
        } else if (detail.command === 'seek' && state.audio) {
            state.audio.currentTime = Math.max(0, Number(detail.value) || 0);
        }
    });
    window.addEventListener('gaia:library-refresh', () => loadLibrary());
    loadLibrary();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeGaiaLibrary, { once: true });
} else {
    initializeGaiaLibrary();
}
