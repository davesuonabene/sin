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

            vaultSyncPill.classList.remove('hidden');
            if (status.in_sync) {
                vaultSyncPill.classList.remove('is-unsynced');
                vaultSyncPill.classList.add('is-synced');
                vaultSyncPill.title = 'Vault folders and database are in sync';
                vaultSyncPillText.textContent = 'In sync';
            } else {
                vaultSyncPill.classList.add('is-unsynced');
                vaultSyncPill.classList.remove('is-synced');
                const untracked = status.untracked?.length || 0;
                const missing = status.missing?.length || 0;
                const parts = [];
                if (untracked > 0) parts.push(`+${untracked} new`);
                if (missing > 0) parts.push(`-${missing} missing`);
                const summaryText = parts.join(', ') || 'Unsynced';
                vaultSyncPillText.textContent = summaryText;
                vaultSyncPill.title = `Vault out of sync: ${summaryText}. Click to review.`;
            }
        }

        async function checkVaultSync(vaultId = state.selectedVaultId) {
            const targetVaultId = vaultId ?? (state.vaults[0]?.id ?? null);
            if (!targetVaultId || !vaultSyncPill) return;

            state.isCheckingSync = true;
            try {
                const response = await fetch(`/vaults/${targetVaultId}/sync-status`);
                if (!response.ok) return;
                const status = await response.json();
                state.vaultSyncStatus = status;
                renderSyncPill(status);
            } catch (_err) {
                // Non-blocking background sync check
            } finally {
                state.isCheckingSync = false;
            }
        }

        function closeVaultSyncDialog() {
            if (vaultSyncDialog?.open) vaultSyncDialog.close();
        }

        async function openVaultSyncDialog() {
            if (!vaultSyncDialog) return;
            const targetVaultId = state.selectedVaultId ?? (state.vaults[0]?.id ?? null);
            if (!targetVaultId) return;

            vaultSyncDialog.showModal();
            vaultSyncDialogResult?.classList.add('hidden');
            if (vaultSyncSummaryText) vaultSyncSummaryText.textContent = 'Scanning vault folders…';
            if (vaultSyncSummaryBanner) vaultSyncSummaryBanner.className = 'vault-sync-summary-banner';

            try {
                const response = await fetch(`/vaults/${targetVaultId}/sync-status`);
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
            const { in_sync, untracked = [], missing = [], moved = [], vault_name } = status;
            if (vaultSyncDialogTitle) vaultSyncDialogTitle.textContent = `Sync: ${vault_name}`;

            if (in_sync) {
                if (vaultSyncSummaryBanner) vaultSyncSummaryBanner.className = 'vault-sync-summary-banner is-clean';
                if (vaultSyncSummaryText) vaultSyncSummaryText.textContent = '✓ All local files and database records are in sync.';
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
                vaultSyncSummaryText.textContent = `Found ${discCount} discrepanc${discCount === 1 ? 'y' : 'ies'} between local storage and database.`;
            }

            // 1. Moved candidates
            if (moved.length > 0 && syncMovedSection && syncMovedCount && syncMovedList) {
                syncMovedSection.classList.remove('hidden');
                syncMovedCount.textContent = moved.length;
                syncMovedList.innerHTML = '';
                moved.forEach(m => {
                    const row = document.createElement('div');
                    row.className = 'sync-item-row';
                    row.innerHTML = `
                        <div class="sync-item-info">
                            <span class="sync-item-name">${escapeHtml(m.filename)}</span>
                            <span class="sync-item-detail">Moved to: ${escapeHtml(m.new_path)}</span>
                        </div>
                        <div class="sync-item-actions">
                            <button type="button" class="sync-action-btn primary-action" data-relink-item="${m.item_id}" data-new-path="${escapeHtml(m.new_path)}">Relink</button>
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
                    row.innerHTML = `
                        <div class="sync-item-info">
                            <span class="sync-item-name">${escapeHtml(u.filename)}</span>
                            <span class="sync-item-detail">${escapeHtml(u.relative_path || u.path)} · ${formatSize(u.size_bytes)} · ${escapeHtml(u.type)}</span>
                        </div>
                        <div class="sync-item-actions">
                            <button type="button" class="sync-action-btn primary-action" data-add-path="${escapeHtml(u.path)}">Add to Library</button>
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
                    row.innerHTML = `
                        <div class="sync-item-info">
                            <span class="sync-item-name">${escapeHtml(m.filename)}</span>
                            <span class="sync-item-detail">${escapeHtml(m.path)} · ${escapeHtml(m.type)}</span>
                        </div>
                        <div class="sync-item-actions">
                            <button type="button" class="sync-action-btn" data-mark-missing="${m.id}">Mark Missing</button>
                            <button type="button" class="sync-action-btn danger-action" data-purge-missing="${m.id}" title="Remove database record">Remove</button>
                        </div>
                    `;
                    syncMissingList.appendChild(row);
                });
            } else if (syncMissingSection) {
                syncMissingSection.classList.add('hidden');
            }
        }

        async function applyVaultReconcile(payload) {
            const targetVaultId = state.selectedVaultId ?? (state.vaults[0]?.id ?? null);
            if (!targetVaultId) return;

            if (vaultSyncDialogResult) {
                vaultSyncDialogResult.classList.remove('hidden');
                vaultSyncDialogResult.textContent = 'Applying reconciliation…';
            }
            try {
                const response = await fetch(`/vaults/${targetVaultId}/reconcile`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                });
                const res = await response.json();
                if (!response.ok) throw new Error(res.detail || 'Failed to reconcile vault');

                const summaryParts = [];
                if (res.added_count > 0) summaryParts.push(`+${res.added_count} added`);
                if (res.marked_missing_count > 0) summaryParts.push(`${res.marked_missing_count} marked missing`);
                if (res.relinked_count > 0) summaryParts.push(`${res.relinked_count} relinked`);
                if (res.purged_count > 0) summaryParts.push(`${res.purged_count} removed`);
                if (vaultSyncDialogResult) {
                    vaultSyncDialogResult.textContent = `Reconciled: ${summaryParts.join(', ') || 'Done'}.`;
                }

                await loadLibrary({ force: true, resetNested: true });
                await checkVaultSync(targetVaultId);
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
            });
        });

        vaultSyncDialog?.addEventListener('click', async event => {
            const target = event.target;
            if (!(target instanceof HTMLElement)) return;

            const relinkBtn = target.closest('[data-relink-item]');
            if (relinkBtn) {
                const itemId = Number(relinkBtn.dataset.relinkItem || relinkBtn.getAttribute('data-relink-item'));
                const newPath = relinkBtn.dataset.newPath || relinkBtn.getAttribute('data-new-path');
                if (itemId && newPath) {
                    await applyVaultReconcile({ relink_moved: [{ item_id: itemId, new_path: newPath }] });
                }
                return;
            }

            const addBtn = target.closest('[data-add-path]');
            if (addBtn) {
                const addPath = addBtn.dataset.addPath || addBtn.getAttribute('data-add-path');
                if (addPath) {
                    await applyVaultReconcile({ add_untracked: [addPath] });
                }
                return;
            }

            const markBtn = target.closest('[data-mark-missing]');
            if (markBtn) {
                const missingId = Number(markBtn.dataset.markMissing || markBtn.getAttribute('data-mark-missing'));
                if (missingId) {
                    await applyVaultReconcile({ mark_missing: [missingId] });
                }
                return;
            }

            const purgeBtn = target.closest('[data-purge-missing]');
            if (purgeBtn) {
                const purgeId = Number(purgeBtn.dataset.purgeMissing || purgeBtn.getAttribute('data-purge-missing'));
                if (purgeId && window.confirm('Remove this asset record from GAIA?')) {
                    await applyVaultReconcile({ purge_missing: [purgeId] });
                }
            }
        });

        return {
            checkVaultSync,
            openVaultSyncDialog,
            closeVaultSyncDialog,
            renderSyncPill,
        };
    }

    window.GaiaVaultReconciler = {
        init: createVaultReconciler,
    };
})();
