document.addEventListener('DOMContentLoaded', () => {
    const state = {
        items: [],
        types: [],
        selectedType: null,
        query: '',
        expandedCollections: new Set(),
        selectedEntryId: null,
        audio: null,
        playingKey: null,
        vaults: [],
        selectedVaultId: null,
    };

    const typeTree = document.getElementById('type-tree');
    const assetList = document.getElementById('asset-list');
    const summary = document.getElementById('library-summary');
    const searchInput = document.getElementById('search-input');
    const clearFilter = document.getElementById('clear-filter');
    const refreshButton = document.getElementById('refresh');
    const importForm = document.getElementById('import-form');
    const sourcePath = document.getElementById('source-path');
    const browseFolder = document.getElementById('browse-folder');
    const importResult = document.getElementById('import-result');
    const sidebar = document.querySelector('.sidebar');
    const libraryLayout = document.getElementById('library-layout');
    const toggleSidebar = document.getElementById('toggle-sidebar');
    const toggleTree = document.getElementById('toggle-tree');
    const vaultNav = document.getElementById('vault-nav');
    const vaultSelect = document.getElementById('vault-select');
    const vaultForm = document.getElementById('vault-form');
    const vaultName = document.getElementById('vault-name');
    const vaultResult = document.getElementById('vault-result');
    const vaultImportLog = document.getElementById('vault-import-log');
    const vaultLogDescription = document.getElementById('vault-log-description');

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

    function descendants(typeId) {
        const ids = new Set([typeId]);
        const visit = id => {
            state.types.filter(type => type.parent === id).forEach(type => {
                ids.add(type.id);
                visit(type.id);
            });
        };
        visit(typeId);
        return ids;
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
                    title: content.filename,
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
            title: content.filename,
            path: content.relative_path,
            content,
            collection,
        }));
    }

    function entryMatches(entry) {
        if (state.selectedType && !descendants(state.selectedType).has(entry.type)) return false;
        if (!state.query) return true;
        const haystack = [
            entry.title,
            entry.path,
            entry.collection?.title,
            entry.collection?.source_path,
            ...(entry.item?.tags || []).map(tag => tag?.name || tag),
        ].join(' ').toLowerCase();
        return haystack.includes(state.query);
    }

    function filteringIsActive() {
        return Boolean(state.selectedType || state.query);
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

    function collectionDetails(item) {
        const parts = [`${item.content_count || (item.contents || []).length || 0} files`];
        if (item.type === 'multitrack') {
            const stemCount = (item.stems || []).length;
            parts.push(`${stemCount} matching stems`);
        }
        return parts.join(' · ');
    }

    function entryDetails(entry) {
        if (entry.kind === 'asset') {
            if (typeIsContainer(entry.type)) return collectionDetails(entry.item);
            return [entry.item.bpm ? `${entry.item.bpm} BPM` : '', entry.item.key || ''].filter(Boolean).join(' · ') || 'Library asset';
        }
        return [entry.content.bpm ? `${entry.content.bpm} BPM` : '', entry.content.key || '', entry.content.duration_seconds ? `${entry.content.duration_seconds}s` : '']
            .filter(Boolean).join(' · ') || 'Read-only content';
    }

    function entrySource(entry) {
        if (entry.kind === 'content') return `in ${entry.collection.title || filename(entry.collection.absolute_path)}`;
        if (typeIsContainer(entry.type)) return entry.item.source_kind === 'zip' ? 'ZIP snapshot' : 'Folder snapshot';
        return filename(entry.item.absolute_path);
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
        return entry.kind === 'content' ? entry.content.size : entry.item.size;
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
        return `${(value / (1024 * 1024)).toFixed(1)} MB`;
    }

    function entryTags(entry) {
        if (entry.kind === 'content') return [{ label: 'Read-only', className: 'read-only' }];

        const rawTags = Array.isArray(entry.item.tags) ? entry.item.tags : [];
        const tags = rawTags.map(tag => ({ label: tag?.name || tag })).filter(tag => tag.label);
        if (typeIsContainer(entry.type)) {
            const count = entry.item.content_count || (entry.item.contents || []).length || 0;
            tags.unshift({ label: `${count} files` });
            if (entry.type === 'multitrack') tags.push({ label: `${(entry.item.stems || []).length} stems` });
        }
        return tags;
    }

    function dragPayload(entry) {
        const item = entry.kind === 'content' ? entry.content : entry.item;
        const collection = entry.kind === 'content' ? entry.collection : null;
        return {
            type: 'library-item',
            itemType: entry.type || 'audio',
            id: collection ? collection.id : item.id,
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

    function createRow(entry, { nested = false } = {}) {
        const row = document.createElement('div');
        row.className = `asset-row${state.selectedEntryId === entry.id ? ' selected' : ''}`;
        row.setAttribute('role', 'listitem');
        row.draggable = true;
        const isCollection = entry.kind === 'asset' && typeIsContainer(entry.type);
        if (isCollection) row.title = 'Double-click to show collection contents';
        const expanded = isCollection && state.expandedCollections.has(entry.id);
        const actions = [];

        if (isCollection) {
            actions.push(`<button class="expand" type="button" aria-label="Toggle ${escapeHtml(entry.title)}" aria-expanded="${expanded}">${expanded ? '⌄' : '›'}</button>`);
        }
        if (entry.kind === 'asset') {
            actions.push(`<button class="delete" type="button" aria-label="Delete ${escapeHtml(entry.title)}">Delete</button>`);
        }

        row.innerHTML = `
            <div class="asset-title"><span class="asset-title-text">${escapeHtml(entry.title)}</span></div>
            <span class="path-text">${escapeHtml(entryPath(entry))}</span>
            <span class="type-badge">${escapeHtml(typeLabel(entry.type))}</span>
            <span class="metadata-text">${escapeHtml(entryBpm(entry) ?? '—')}</span>
            <span class="metadata-text">${escapeHtml(entryKey(entry) ?? '—')}</span>
            <span class="size-text">${escapeHtml(formatSize(entrySize(entry)))}</span>
            <span>${actions.join('')}</span>
        `;

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
            deleteButton.addEventListener('click', async event => {
                event.stopPropagation();
                await deleteEntry(entry);
            });
        }
        row.addEventListener('dragstart', event => {
            if (!event.dataTransfer) return;
            const payload = JSON.stringify(dragPayload(entry));
            event.dataTransfer.effectAllowed = 'copy';
            event.dataTransfer.setData('application/x-gaia-library-item', payload);
            event.dataTransfer.setData('text/plain', payload);
            row.classList.add('dragging');
        });
        row.addEventListener('dragend', () => row.classList.remove('dragging'));
        row.addEventListener('click', () => {
            state.selectedEntryId = entry.id;
            if (!isCollection && canPreview(entry)) {
                play(entry);
            }
            renderAssets();
        });
        row.addEventListener('dblclick', event => {
            if (!isCollection || event.target.closest('button')) return;
            if (state.expandedCollections.has(entry.id)) state.expandedCollections.delete(entry.id);
            else state.expandedCollections.add(entry.id);
            renderAssets();
        });
        return row;
    }

    async function deleteEntry(entry) {
        if (!window.confirm(`Remove “${entry.title}” from the library?`)) return;
        try {
            const response = await fetch(`/items/${entry.item.id}`, { method: 'DELETE' });
            if (!response.ok) {
                const result = await response.json().catch(() => ({}));
                throw new Error(result.detail || 'Could not remove the asset');
            }
            if (state.playingKey === entry.id && state.audio) {
                state.audio.pause();
                state.audio = null;
                state.playingKey = null;
            }
            state.items = state.items.filter(item => item.id !== entry.item.id);
            state.expandedCollections.delete(entry.id);
            if (state.selectedEntryId === entry.id) state.selectedEntryId = null;
            renderTypeTree();
            renderAssets();
        } catch (error) {
            window.alert(error.message);
        }
    }

    function createEntry(entry, options = {}) {
        const wrapper = document.createElement('article');
        wrapper.className = 'asset-entry';
        wrapper.appendChild(createRow(entry, options));

        const tags = entryTags(entry);
        if (tags.length) {
            const tagList = document.createElement('div');
            tagList.className = 'asset-tags';
            tags.forEach(({ label, className = '' }) => {
                const tag = document.createElement('span');
                tag.className = `tag${className ? ` ${className}` : ''}`;
                tag.textContent = label;
                tagList.appendChild(tag);
            });
            wrapper.appendChild(tagList);
        }
        return wrapper;
    }

    function renderAssets() {
        const entries = visibleEntries();
        assetList.innerHTML = '';
        clearFilter.classList.toggle('hidden', !filteringIsActive());

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

        const current = filteringIsActive()
            ? entries.reduce((count, entry) => {
                if (!typeIsContainer(entry.type)) return count + 1;
                const matchingContents = collectionContentEntries(entry.item).filter(entryMatches).length;
                return count + (matchingContents || (entryMatches(entry) ? 1 : 0));
            }, 0)
            : entries.length;
        const sourceCount = state.items.length;
        const vaultName = selectedVault()?.name || 'vault';
        summary.textContent = filteringIsActive()
            ? `${current} assets match the active filter`
            : `${sourceCount} assets in ${vaultName}`;
    }

    function renderTypeTree() {
        typeTree.innerHTML = '';
        const catalogue = allEntries();
        const renderNode = (type, depth) => {
            const node = document.createElement('div');
            node.className = 'type-node';
            node.dataset.depth = String(depth);
            const count = catalogue.filter(entry => descendants(type.id).has(entry.type)).length;
            const button = document.createElement('button');
            button.className = `type-button${state.selectedType === type.id ? ' active' : ''}`;
            button.type = 'button';
            button.setAttribute('aria-pressed', String(state.selectedType === type.id));
            button.innerHTML = `<span>${escapeHtml(type.label)}</span><span class="type-count">${count}</span>`;
            button.addEventListener('click', () => {
                state.selectedType = type.id;
                renderTypeTree();
                renderAssets();
            });
            node.appendChild(button);
            state.types.filter(candidate => candidate.parent === type.id).forEach(child => node.appendChild(renderNode(child, depth + 1)));
            return node;
        };
        state.types.filter(type => type.parent === null).forEach(root => typeTree.appendChild(renderNode(root, 0)));
    }

    function selectedVault() {
        return state.vaults.find(vault => vault.id === state.selectedVaultId);
    }

    function renderVaults() {
        vaultNav.innerHTML = '';
        vaultSelect.innerHTML = '';
        state.vaults.forEach(vault => {
            const nav = document.createElement('button');
            nav.className = `vault-button${vault.id === state.selectedVaultId ? ' active' : ''}`;
            nav.type = 'button';
            nav.innerHTML = `<span>▣</span><small>${escapeHtml(vault.name)}</small>`;
            nav.title = vault.description || vault.name;
            nav.addEventListener('click', () => {
                state.selectedVaultId = vault.id;
                document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === 'library'));
                document.querySelectorAll('.view').forEach(view => view.classList.toggle('hidden', view.id !== 'library-view'));
                renderVaults();
                loadLibrary();
            });
            vaultNav.appendChild(nav);
            const option = document.createElement('option');
            option.value = String(vault.id);
            option.textContent = vault.name;
            option.selected = vault.id === state.selectedVaultId;
            vaultSelect.appendChild(option);
        });
    }

    async function loadVaults() {
        const response = await fetch('/vaults/');
        if (!response.ok) throw new Error('GAIA could not load vaults');
        state.vaults = await response.json();
        if (!state.vaults.some(vault => vault.id === state.selectedVaultId)) state.selectedVaultId = state.vaults[0]?.id ?? null;
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
            const [typesResponse, itemsResponse] = await Promise.all([fetch('/items/types'), fetch(`/items/?limit=1000&vault_id=${state.selectedVaultId}`)]);
            if (!typesResponse.ok || !itemsResponse.ok) throw new Error('GAIA could not load the library');
            state.types = await typesResponse.json();
            state.items = await itemsResponse.json();
            renderTypeTree();
            renderAssets();
        } catch (error) {
            assetList.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
            summary.textContent = 'Library unavailable';
        }
    }

    document.querySelectorAll('.nav-item').forEach(button => {
        button.addEventListener('click', () => {
            document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item === button));
            document.querySelectorAll('.view').forEach(view => view.classList.toggle('hidden', view.id !== `${button.dataset.view}-view`));
        });
    });

    searchInput.addEventListener('input', () => {
        state.query = searchInput.value.trim().toLowerCase();
        renderAssets();
    });
    clearFilter.addEventListener('click', () => {
        state.selectedType = null;
        state.query = '';
        searchInput.value = '';
        renderTypeTree();
        renderAssets();
    });
    refreshButton.addEventListener('click', loadLibrary);

    function updateViewToggle(button, collapsed, panelName) {
        button.textContent = collapsed ? '›' : '‹';
        const action = collapsed ? 'Expand' : 'Collapse';
        button.setAttribute('aria-label', `${action} ${panelName}`);
        button.title = `${action} ${panelName}`;
        button.setAttribute('aria-pressed', String(collapsed));
    }

    toggleSidebar.addEventListener('click', () => {
        sidebar.classList.toggle('hidden-sidebar');
        updateViewToggle(toggleSidebar, sidebar.classList.contains('hidden-sidebar'), 'sidebar');
    });

    toggleTree.addEventListener('click', () => {
        libraryLayout.classList.toggle('tree-hidden');
        updateViewToggle(toggleTree, libraryLayout.classList.contains('tree-hidden'), 'types');
    });

    browseFolder.addEventListener('click', async () => {
        try {
            const response = await fetch('/items/browse');
            const result = await response.json();
            if (result.path) sourcePath.value = result.path;
            else throw new Error(result.error || 'Could not open the folder picker');
        } catch (error) {
            importResult.textContent = error.message;
            importResult.className = 'result error';
        }
    });

    importForm.addEventListener('submit', async event => {
        event.preventDefault();
        const submit = document.getElementById('import-submit');
        submit.disabled = true;
        submit.textContent = 'Importing…';
        importResult.className = 'result hidden';
        try {
            const response = await fetch('/items/import-collection', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ source_path: sourcePath.value, vault_id: Number(vaultSelect.value) }),
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.detail || 'Import failed');
            const vault = state.vaults.find(entry => entry.id === Number(vaultSelect.value));
            importResult.textContent = `${result.title || filename(result.absolute_path)} imported into ${vault?.name || 'the vault'} as ${typeLabel(result.type)}.`;
            importResult.className = 'result';
            sourcePath.value = '';
            await loadLibrary();
            await loadVaultImportLog();
        } catch (error) {
            importResult.textContent = error.message;
            importResult.className = 'result error';
        } finally {
            submit.disabled = false;
            submit.textContent = 'Import snapshot';
        }
    });

    vaultSelect.addEventListener('change', async () => {
        state.selectedVaultId = Number(vaultSelect.value);
        renderVaults();
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

    loadLibrary();
});
