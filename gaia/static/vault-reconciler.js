// GAIA Vault Reconciler Module
// Manages vault sync checks, reconciliation dialog, and discrepancy resolution.

(function initializeVaultReconcilerModule() {
    function createVaultReconciler(context) {
        const { state, loadLibrary } = context;

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
        const syncMirrorsSection = document.getElementById('sync-mirrors-section');
        const syncMirrorsCount = document.getElementById('sync-mirrors-count');
        const syncMirrorsList = document.getElementById('sync-mirrors-list');
        const syncMovedSection = document.getElementById('sync-moved-section');
        const syncMovedCount = document.getElementById('sync-moved-count');
        const syncMovedList = document.getElementById('sync-moved-list');
        const syncUntrackedSection = document.getElementById('sync-untracked-section');
        const syncUntrackedCount = document.getElementById('sync-untracked-count');
        const syncUntrackedList = document.getElementById('sync-untracked-list');
        const syncMissingSection = document.getElementById('sync-missing-section');
        const syncMissingCount = document.getElementById('sync-missing-count');
        const syncMissingList = document.getElementById('sync-missing-list');

        function escapeHtml(text) {
            return String(text ?? '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        }

        function formatSize(bytes) {
            const numeric = Number(bytes);
            if (!Number.isFinite(numeric) || numeric <= 0) return '0 B';
            const units = ['B', 'KB', 'MB', 'GB', 'TB'];
            let size = numeric;
            let unitIndex = 0;
            while (size >= 1024 && unitIndex < units.length - 1) {
                size /= 1024;
                unitIndex += 1;
            }
            return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
        }

        function renderSyncPill(status) {
            if (!vaultSyncPill || !vaultSyncPillText) return;
            if (!status) {
                vaultSyncPill.classList.add('hidden');
                return;
            }

            vaultSyncPill.classList.remove('hidden', 'is-synced', 'is-unsynced', 'is-error');
            if (status.error) {
                vaultSyncPill.classList.add('is-error');
                vaultSyncPillText.textContent = 'sync error';
                vaultSyncPill.title = 'Could not check vault sync status. Click to retry.';
            } else if (status.in_sync) {
                vaultSyncPill.classList.add('is-synced');
                vaultSyncPill.title = 'Vault folders and database are in sync. Click to review.';
                vaultSyncPillText.textContent = 'synced';
            } else {
                vaultSyncPill.classList.add('is-unsynced');
                const untracked = status.untracked?.length || 0;
                const missing = status.missing?.length || 0;
                const moved = status.moved?.length || 0;
                const mirrorChanges = (status.mirrors || []).reduce(
                    (sum, m) => sum + (m.new_files?.length || 0) + (m.modified_files?.length || 0) + (m.missing_files?.length || m.removed_items?.length || 0),
                    0
                );
                const parts = [];
                if (mirrorChanges > 0) parts.push(`${mirrorChanges} mirror`);
                if (untracked > 0) parts.push(`+${untracked} new`);
                if (missing > 0) parts.push(`-${missing} missing`);
                if (moved > 0) parts.push(`${moved} moved`);
                const summaryText = parts.length ? `unsynced (${parts.join(', ')})` : 'unsynced';
                vaultSyncPillText.textContent = summaryText;
                vaultSyncPill.title = `Vault out of sync: ${summaryText}. Click to review.`;
            }
        }

        let syncCheckController = null;
        let syncCheckDebounceTimer = null;

        function syncEndpointForVault(vaultId) {
            const numeric = vaultId === null || vaultId === undefined ? null : Number(vaultId);
            if (Number.isFinite(numeric) && numeric > 0) {
                return `/vaults/${numeric}/sync-status`;
            }
            return '/vaults/sync-status';
        }

        function reconcileEndpointForVault(vaultId) {
            const numeric = vaultId === null || vaultId === undefined ? null : Number(vaultId);
            if (Number.isFinite(numeric) && numeric > 0) {
                return `/vaults/${numeric}/reconcile`;
            }
            return '/vaults/reconcile';
        }

        async function checkVaultSync(vaultId = state.selectedVaultId) {
            if (!vaultSyncPill || !state.vaults?.length) return;
            if (syncCheckDebounceTimer) {
                clearTimeout(syncCheckDebounceTimer);
                syncCheckDebounceTimer = null;
            }
            syncCheckController?.abort();
            const controller = new AbortController();
            syncCheckController = controller;

            state.isCheckingSync = true;
            try {
                const endpoint = syncEndpointForVault(vaultId);
                const response = await fetch(endpoint, { signal: controller.signal });
                if (syncCheckController !== controller) return;
                if (!response.ok) {
                    renderSyncPill({ error: true });
                    return;
                }
                const status = await response.json();
                if (syncCheckController !== controller) return;
                state.vaultSyncStatus = status;
                renderSyncPill(status);
            } catch (err) {
                if (err?.name === 'AbortError') return;
                renderSyncPill({ error: true });
            } finally {
                if (syncCheckController === controller) {
                    syncCheckController = null;
                    state.isCheckingSync = false;
                }
            }
        }

        function scheduleVaultSyncCheck(vaultId = state.selectedVaultId, delayMs = 120) {
            if (syncCheckDebounceTimer) clearTimeout(syncCheckDebounceTimer);
            syncCheckDebounceTimer = setTimeout(() => {
                syncCheckDebounceTimer = null;
                checkVaultSync(vaultId);
            }, delayMs);
        }

        function closeVaultSyncDialog() {
            if (vaultSyncDialog?.open) vaultSyncDialog.close();
        }

        async function openVaultSyncDialog() {
            if (!vaultSyncDialog || !state.vaults?.length) return;
            const targetVaultId = state.selectedVaultId;

            vaultSyncDialog.showModal();
            vaultSyncDialogResult?.classList.add('hidden');
            if (vaultSyncSummaryText) vaultSyncSummaryText.textContent = 'Scanning vault folders…';
            if (vaultSyncSummaryBanner) vaultSyncSummaryBanner.className = 'vault-sync-summary-banner';

            try {
                const response = await fetch(syncEndpointForVault(targetVaultId));
                if (!response.ok) throw new Error('Could not check vault sync status');
                const status = await response.json();
                state.vaultSyncStatus = status;
                renderSyncDialogContent(status);
                renderSyncPill(status);
            } catch (err) {
                if (vaultSyncSummaryText) vaultSyncSummaryText.textContent = err.message || 'Scan failed';
            }
        }

        function renderSyncDialogContent(status) {
            if (!status) return;
            const { in_sync, untracked = [], missing = [], moved = [], mirrors = [], vault_name } = status;
            const isAllVaults = !status.vault_id || Number(status.vault_id) <= 0;
            if (vaultSyncDialogTitle) vaultSyncDialogTitle.textContent = `Sync: ${vault_name || 'All Vaults'}`;

            if (in_sync) {
                if (vaultSyncSummaryBanner) vaultSyncSummaryBanner.className = 'vault-sync-summary-banner is-clean';
                if (vaultSyncSummaryText) vaultSyncSummaryText.textContent = '✓ All local files, mirrored folders, and database records are in sync.';
                syncMirrorsSection?.classList.add('hidden');
                syncMovedSection?.classList.add('hidden');
                syncUntrackedSection?.classList.add('hidden');
                syncMissingSection?.classList.add('hidden');
                if (vaultSyncDialogQuickAll) vaultSyncDialogQuickAll.disabled = true;
                return;
            }

            if (vaultSyncDialogQuickAll) vaultSyncDialogQuickAll.disabled = false;
            if (vaultSyncSummaryBanner) vaultSyncSummaryBanner.className = 'vault-sync-summary-banner';
            const discCount = status.total_discrepancies || (untracked.length + missing.length);
            if (vaultSyncSummaryText) {
                vaultSyncSummaryText.textContent = `Found ${discCount} discrepanc${discCount === 1 ? 'y' : 'ies'} between local storage, mirrors, and database.`;
            }

            const vaultPrefix = item => (isAllVaults && item?.vault_name ? `[${item.vault_name}] ` : '');

            // 0. Mirrored Folder discrepancies
            const dirtyMirrors = mirrors.filter(m => !m.in_sync || m.offline || m.source_exists === false);
            if (dirtyMirrors.length > 0 && syncMirrorsSection && syncMirrorsCount && syncMirrorsList) {
                syncMirrorsSection.classList.remove('hidden');
                const totalMirrorOps = dirtyMirrors.reduce(
                    (sum, m) => sum + (m.new_files?.length || 0) + (m.modified_files?.length || 0) + (m.missing_files?.length || m.removed_items?.length || 0),
                    0
                );
                syncMirrorsCount.textContent = totalMirrorOps || dirtyMirrors.length;
                syncMirrorsList.innerHTML = '';
                dirtyMirrors.forEach(m => {
                    const row = document.createElement('div');
                    row.className = 'sync-item-row';
                    const modeLabel = (m.mode || m.mirror_mode) === 'distill_copy' ? 'Distill & Copy' : '1-1 Reference';
                    const isOffline = Boolean(m.offline || m.source_exists === false);
                    const missingLen = m.missing_files?.length || m.removed_items?.length || 0;
                    const counts = [];
                    if (isOffline) {
                        counts.push('Source folder offline / unreachable');
                    } else {
                        if (m.new_files?.length) counts.push(`+${m.new_files.length} new`);
                        if (m.modified_files?.length) counts.push(`~${m.modified_files.length} updated`);
                        if (missingLen) counts.push(`-${missingLen} missing`);
                    }
                    const itemVaultAttr = m.vault_id ? ` data-vault-id="${m.vault_id}"` : '';
                    row.innerHTML = `
                        <div class="sync-item-info">
                            <span class="sync-item-name">${escapeHtml(vaultPrefix(m))}${escapeHtml(m.target_folder_path || m.source_path)} <small>(${escapeHtml(modeLabel)})</small></span>
                            <span class="sync-item-detail">${escapeHtml(m.source_path)} · ${escapeHtml(counts.join(', ') || 'Out of sync')}</span>
                        </div>
                        <div class="sync-item-actions">
                            ${!isOffline ? `<button type="button" class="sync-action-btn primary-action" data-sync-mirror="${m.mirror_id}"${itemVaultAttr}>Sync Mirror</button>` : ''}
                        </div>
                    `;
                    syncMirrorsList.appendChild(row);
                });
            } else if (syncMirrorsSection) {
                syncMirrorsSection.classList.add('hidden');
            }

            // 1. Moved candidates
            if (moved.length > 0 && syncMovedSection && syncMovedCount && syncMovedList) {
                syncMovedSection.classList.remove('hidden');
                syncMovedCount.textContent = moved.length;
                syncMovedList.innerHTML = '';
                moved.forEach(m => {
                    const row = document.createElement('div');
                    row.className = 'sync-item-row';
                    const itemVaultAttr = m.vault_id ? ` data-vault-id="${m.vault_id}"` : '';
                    row.innerHTML = `
                        <div class="sync-item-info">
                            <span class="sync-item-name">${escapeHtml(vaultPrefix(m))}${escapeHtml(m.filename)}</span>
                            <span class="sync-item-detail">Moved to: ${escapeHtml(m.new_path)}</span>
                        </div>
                        <div class="sync-item-actions">
                            <button type="button" class="sync-action-btn primary-action" data-relink-item="${m.item_id}" data-new-path="${escapeHtml(m.new_path)}"${itemVaultAttr}>Relink</button>
                        </div>
                    `;
                    syncMovedList.appendChild(row);
                });
            } else if (syncMovedSection) {
                syncMovedSection.classList.add('hidden');
            }

            // 2. Untracked files
            const movedNewPaths = new Set(moved.map(m => m.new_path));
            const pureUntracked = untracked.filter(u => !movedNewPaths.has(u.path));
            if (pureUntracked.length > 0 && syncUntrackedSection && syncUntrackedCount && syncUntrackedList) {
                syncUntrackedSection.classList.remove('hidden');
                syncUntrackedCount.textContent = pureUntracked.length;
                syncUntrackedList.innerHTML = '';
                pureUntracked.forEach(u => {
                    const row = document.createElement('div');
                    row.className = 'sync-item-row';
                    const itemVaultAttr = u.vault_id ? ` data-vault-id="${u.vault_id}"` : '';
                    row.innerHTML = `
                        <div class="sync-item-info">
                            <span class="sync-item-name">${escapeHtml(vaultPrefix(u))}${escapeHtml(u.filename)}</span>
                            <span class="sync-item-detail">${escapeHtml(u.relative_path || u.path)} · ${formatSize(u.size_bytes)} · ${escapeHtml(u.type)}</span>
                        </div>
                        <div class="sync-item-actions">
                            <button type="button" class="sync-action-btn primary-action" data-add-path="${escapeHtml(u.path)}"${itemVaultAttr}>Add to Library</button>
                        </div>
                    `;
                    syncUntrackedList.appendChild(row);
                });
            } else if (syncUntrackedSection) {
                syncUntrackedSection.classList.add('hidden');
            }

            // 3. Missing files
            const movedOldItemIds = new Set(moved.map(m => m.item_id));
            const pureMissing = missing.filter(m => !movedOldItemIds.has(m.id));
            if (pureMissing.length > 0 && syncMissingSection && syncMissingCount && syncMissingList) {
                syncMissingSection.classList.remove('hidden');
                syncMissingCount.textContent = pureMissing.length;
                syncMissingList.innerHTML = '';
                pureMissing.forEach(m => {
                    const row = document.createElement('div');
                    row.className = 'sync-item-row';
                    const itemVaultAttr = m.vault_id ? ` data-vault-id="${m.vault_id}"` : '';
                    row.innerHTML = `
                        <div class="sync-item-info">
                            <span class="sync-item-name">${escapeHtml(vaultPrefix(m))}${escapeHtml(m.filename)}</span>
                            <span class="sync-item-detail">${escapeHtml(m.path)} · ${escapeHtml(m.type)}</span>
                        </div>
                        <div class="sync-item-actions">
                            <button type="button" class="sync-action-btn" data-mark-missing="${m.id}"${itemVaultAttr}>Mark Missing</button>
                            <button type="button" class="sync-action-btn danger-action" data-purge-missing="${m.id}"${itemVaultAttr} title="Remove database record">Remove</button>
                        </div>
                    `;
                    syncMissingList.appendChild(row);
                });
            } else if (syncMissingSection) {
                syncMissingSection.classList.add('hidden');
            }
        }

        async function applyVaultReconcile(payload, explicitVaultId = null) {
            const targetVaultId = explicitVaultId ?? state.selectedVaultId;

            if (vaultSyncDialogResult) {
                vaultSyncDialogResult.classList.remove('hidden');
                vaultSyncDialogResult.textContent = 'Applying reconciliation…';
            }
            try {
                const response = await fetch(reconcileEndpointForVault(targetVaultId), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                });
                const res = await response.json();
                if (!response.ok) throw new Error(res.detail || 'Failed to reconcile vault');

                const summaryParts = [];
                const mirroredCount = res.mirrored_count ?? res.mirrors_synced_count ?? 0;
                if (mirroredCount > 0) summaryParts.push(`${mirroredCount} mirror item(s) synced`);
                if (res.added_count > 0) summaryParts.push(`+${res.added_count} added`);
                if (res.marked_missing_count > 0) summaryParts.push(`${res.marked_missing_count} marked missing`);
                if (res.relinked_count > 0) summaryParts.push(`${res.relinked_count} relinked`);
                if (res.purged_count > 0) summaryParts.push(`${res.purged_count} removed`);
                if (vaultSyncDialogResult) {
                    vaultSyncDialogResult.textContent = `Reconciled: ${summaryParts.join(', ') || 'Done'}.`;
                }

                await loadLibrary({ force: true, resetNested: true });
                await checkVaultSync(state.selectedVaultId);
                if (state.vaultSyncStatus) {
                    renderSyncDialogContent(state.vaultSyncStatus);
                }
            } catch (err) {
                if (vaultSyncDialogResult) {
                    vaultSyncDialogResult.textContent = err.message || 'Reconciliation failed';
                }
            }
        }

        // Bind dialog and action listeners
        vaultSyncPill?.addEventListener('click', openVaultSyncDialog);
        vaultSyncPill?.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                openVaultSyncDialog();
            }
        });
        vaultSyncDialogClose?.addEventListener('click', closeVaultSyncDialog);
        vaultSyncDialogCancel?.addEventListener('click', closeVaultSyncDialog);

        vaultSyncDialogQuickAll?.addEventListener('click', async () => {
            const status = state.vaultSyncStatus;
            if (!status) return;
            const relink_moved = (status.moved || []).map(m => ({ item_id: m.item_id, new_path: m.new_path }));
            await applyVaultReconcile({
                relink_moved,
                add_all_untracked: true,
                mark_all_missing: true,
                sync_all_mirrors: true,
            });
        });

        vaultSyncDialog?.addEventListener('click', async event => {
            const target = event.target;
            if (!(target instanceof HTMLElement)) return;

            const syncMirrorBtn = target.closest('[data-sync-mirror]');
            if (syncMirrorBtn) {
                const mirrorId = Number(syncMirrorBtn.dataset.syncMirror || syncMirrorBtn.getAttribute('data-sync-mirror'));
                const btnVaultId = Number(syncMirrorBtn.dataset.vaultId || syncMirrorBtn.getAttribute('data-vault-id')) || null;
                if (mirrorId) {
                    await applyVaultReconcile({ sync_mirror_ids: [mirrorId] }, btnVaultId);
                }
                return;
            }

            const relinkBtn = target.closest('[data-relink-item]');
            if (relinkBtn) {
                const itemId = Number(relinkBtn.dataset.relinkItem || relinkBtn.getAttribute('data-relink-item'));
                const newPath = relinkBtn.dataset.newPath || relinkBtn.getAttribute('data-new-path');
                const btnVaultId = Number(relinkBtn.dataset.vaultId || relinkBtn.getAttribute('data-vault-id')) || null;
                if (itemId && newPath) {
                    await applyVaultReconcile({ relink_moved: [{ item_id: itemId, new_path: newPath }] }, btnVaultId);
                }
                return;
            }

            const addBtn = target.closest('[data-add-path]');
            if (addBtn) {
                const addPath = addBtn.dataset.addPath || addBtn.getAttribute('data-add-path');
                const btnVaultId = Number(addBtn.dataset.vaultId || addBtn.getAttribute('data-vault-id')) || null;
                if (addPath) {
                    await applyVaultReconcile({ add_untracked: [addPath] }, btnVaultId);
                }
                return;
            }

            const markBtn = target.closest('[data-mark-missing]');
            if (markBtn) {
                const missingId = Number(markBtn.dataset.markMissing || markBtn.getAttribute('data-mark-missing'));
                const btnVaultId = Number(markBtn.dataset.vaultId || markBtn.getAttribute('data-vault-id')) || null;
                if (missingId) {
                    await applyVaultReconcile({ mark_missing: [missingId] }, btnVaultId);
                }
                return;
            }

            const purgeBtn = target.closest('[data-purge-missing]');
            if (purgeBtn) {
                const purgeId = Number(purgeBtn.dataset.purgeMissing || purgeBtn.getAttribute('data-purge-missing'));
                const btnVaultId = Number(purgeBtn.dataset.vaultId || purgeBtn.getAttribute('data-vault-id')) || null;
                if (purgeId && window.confirm('Remove this asset record from GAIA?')) {
                    await applyVaultReconcile({ purge_missing: [purgeId] }, btnVaultId);
                }
            }
        });

        return {
            checkVaultSync,
            scheduleVaultSyncCheck,
            openVaultSyncDialog,
            closeVaultSyncDialog,
            renderSyncPill,
        };
    }

    window.GaiaVaultReconciler = {
        init: createVaultReconciler,
    };
})();
