import { type BaseNode } from '../../nodes/BaseNode.ts';
import { getAssetDisplayName } from '../libraryFilters.ts';
import {
    deduplicatePoolItemName,
    getPoolItemCallName,
    getPoolItemIdentityKey,
    getPoolPermutationOrder,
    isCalculatedPoolQuery,
    isExternalPoolItem,
    isFieldOperatorExpression,
    isInlinePoolItem,
} from '../../../../ermes/ts/slotLanguage.ts';
import { resolveEffectivePoolSeed, resolvePoolItemByQuery } from '../../../../ermes/ts/assetResolver.ts';
import {
    attachLibraryDragData,
    clearActiveLibraryDragData,
    DRAG_MIME_POOL_REORDER,
    hasAudioDragPayload,
    hasSequenceDragPayload,
    resolveDroppedPoolItemsByType,
} from '../dragPayload.ts';
import { SlotStrip } from './SlotStrip.ts';

function isSequencePoolMode(poolNode: any, ownerNode: any): boolean {
    const ownerType = ownerNode?.getNodeType?.() || ownerNode?.properties?.node_type;
    const acceptedType = poolNode?.properties?.accepted_asset_type || ownerNode?.acceptedPoolAssetType;
    return acceptedType === 'sequence_source' || ownerType === 'sequence';
}

function getPoolSourceKind(item: any): 'inline' | 'external' | 'gaia' {
    if (isInlinePoolItem(item)) return 'inline';
    if (isExternalPoolItem(item)) return 'external';
    return 'gaia';
}

function buildSequenceMinimap(sequence: number[] | undefined): HTMLElement {
    const strip = document.createElement('span');
    strip.className = 'pool-seq-minimap';
    const steps = Array.isArray(sequence) && sequence.length > 0 ? sequence.slice(0, 16) : null;
    for (let i = 0; i < 16; i++) {
        const dot = document.createElement('span');
        const isOn = steps ? Boolean(steps[i]) : false;
        dot.className = `pool-seq-minimap-dot ${isOn ? 'is-on' : ''} ${!steps ? 'is-unparsed' : ''}`;
        strip.appendChild(dot);
    }
    return strip;
}

export class AssetPoolSection {
    static async render(
        container: HTMLElement,
        node: BaseNode,
        windowContext: any
    ): Promise<void> {
        const isOwnerNode = node.getNodeType?.() !== 'asset_filter' && node.type !== 'Audio/AssetFilter';
        const poolNode: any = isOwnerNode ? (node.getAttachedPoolNode?.() || node) : node;
        const ownerNode: any = isOwnerNode
            ? node
            : (() => {
                const graph = (node as any).graph || (typeof window !== 'undefined' ? (window as any).editorGraph : null);
                const parentId = poolNode?.properties?.parentId;
                return parentId != null && graph ? graph.getNodeById?.(parentId) : null;
            })();

        if (!poolNode.properties) poolNode.properties = {};
        if (!Array.isArray(poolNode.properties.selected_items)) {
            poolNode.properties.selected_items = [];
        }

        const isSequencePool = isSequencePoolMode(poolNode, ownerNode);

        const group = document.createElement('div');
        group.className = 'asset-pool-group';

        const baseItems: any[] = (isOwnerNode && typeof (ownerNode as any).getPoolItems === 'function')
            ? [...(ownerNode as any).getPoolItems()]
            : (Array.isArray(poolNode.properties.selected_items) ? [...poolNode.properties.selected_items] : []);

        const effPoolSeed = resolveEffectivePoolSeed(poolNode, ownerNode);
        const poolSalt = (isOwnerNode && typeof (ownerNode as any).getPoolSalt === 'function')
            ? (ownerNode as any).getPoolSalt()
            : Number(poolNode?.id || ownerNode?.id || 0);
        const permOrder = getPoolPermutationOrder(baseItems.length, effPoolSeed, poolSalt);
        const items = permOrder.map(origIdx => baseItems[origIdx]);

        // 1. Slot Strip + Active Slot Call Bar for owner nodes (SampleNode / SequenceNode)
        if (isOwnerNode && typeof ownerNode?.getSlots === 'function') {
            const slots = ownerNode.getSlots();
            const activeSlotIdx = Math.max(0, Number(ownerNode.activeSlotIndex ?? ownerNode.properties?.active_slot ?? 0));

            const handleDroppedIntoSlots = async (dt: DataTransfer, target?: number | 'plus') => {
                const dropped = await resolveDroppedPoolItemsByType(dt, isSequencePool);
                if (dropped.length === 0) return;
                if (typeof ownerNode.loadDroppedItemsIntoSlots === 'function') {
                    await ownerNode.loadDroppedItemsIntoSlots(dropped, target);
                }
                windowContext?.refreshAudioPreview?.();
                await windowContext?.renderTabContent?.();
            };

            const stripEl = SlotStrip.render({
                node: ownerNode,
                slots,
                slotCount: slots.length,
                activeSlot: activeSlotIdx,
                selectedSlots: ownerNode.getSelectedSlotIndices?.() ?? [activeSlotIdx],
                accentColor: (ownerNode as any).nodeColor || (ownerNode as any).color || (isSequencePool ? '#ec4899' : '#10b981'),
                canAcceptDrop: dt => isSequencePool ? hasSequenceDragPayload(dt) : hasAudioDragPayload(dt),
                onSelect: async (idx, modifiers) => {
                    ownerNode.selectSlot?.(idx, modifiers);
                    windowContext?.refreshAudioPreview?.();
                    await windowContext?.renderTabContent?.();
                },
                onDropOnSlot: (idx, dt) => {
                    void handleDroppedIntoSlots(dt, idx);
                },
                onDropOnAdd: (dt) => {
                    void handleDroppedIntoSlots(dt, 'plus');
                },
                onAdd: async () => {
                    ownerNode.addSlot?.();
                    windowContext?.refreshAudioPreview?.();
                    await windowContext?.renderTabContent?.();
                },
                onRemove: async (idx) => {
                    ownerNode.removeSlot?.(idx);
                    windowContext?.refreshAudioPreview?.();
                    await windowContext?.renderTabContent?.();
                },
                onPaste: async () => {
                    windowContext?.refreshAudioPreview?.();
                    await windowContext?.renderTabContent?.();
                }
            });
            group.appendChild(stripEl);

            // Active Slot Call Bar
            const callBar = document.createElement('div');
            callBar.className = 'asset-pool-call-bar';

            const slotLabel = document.createElement('span');
            slotLabel.className = 'asset-pool-call-slot-label';
            slotLabel.textContent = `S${activeSlotIdx}`;
            slotLabel.title = `Active slot ${activeSlotIdx}`;

            const currentQuery = String(ownerNode.properties?.pool_query ?? '').trim();
            const isCalc = isCalculatedPoolQuery(currentQuery, baseItems);
            const activeFp = String(ownerNode.properties?.filepath || '');
            const activeId = ownerNode.properties?.library_item_id;

            const resolvedActiveItem = isCalc && baseItems.length > 0
                ? resolvePoolItemByQuery(
                    baseItems,
                    currentQuery,
                    activeSlotIdx,
                    ownerNode.properties?.seed ?? 42,
                    false,
                    ownerNode.getTriggerCount?.() ?? 0,
                    { poolSeed: effPoolSeed, nodeId: poolSalt }
                )
                : (baseItems.find((it: any) =>
                    (activeId != null && String(it?.id) === String(activeId))
                    || (activeFp && String(it?.filepath || it?.absolute_path || '') === activeFp)
                ) || null);

            const activeRunIdx = resolvedActiveItem
                ? items.findIndex(it => getPoolItemIdentityKey(it) === getPoolItemIdentityKey(resolvedActiveItem))
                : (typeof ownerNode.findPoolItemRunIndex === 'function'
                    ? ownerNode.findPoolItemRunIndex({ filepath: activeFp, id: activeId })
                    : -1);

            const callInput = document.createElement('input');
            callInput.type = 'text';
            callInput.className = `td-pool-selector-input asset-pool-call-input ${isCalc ? 'is-pool-computed' : ''}`;
            callInput.placeholder = 'Call by name, index (0..), or rand';
            callInput.title = 'Call asset from pool by name, run index (0, 1, …), or operator (rand, [0 1], <0 1>)';
            callInput.setAttribute('aria-label', 'Active slot pool call expression');

            const getDisplayValue = (): string => {
                if (resolvedActiveItem) return getPoolItemCallName(resolvedActiveItem, isSequencePool);
                if (activeFp) return activeFp.split(/[\\/]/).pop() || activeFp;
                if (isSequencePool && ownerNode.properties?.sequence_name) {
                    return String(ownerNode.properties.sequence_name);
                }
                return currentQuery;
            };
            const getEditValue = (): string => {
                if (isCalc) return currentQuery;
                return currentQuery || getDisplayValue();
            };
            callInput.value = getDisplayValue();

            let beforeFocus = '';
            let committedEnter = false;
            const commitCall = async () => {
                const raw = callInput.value.trim();
                if (raw === beforeFocus) {
                    callInput.value = getDisplayValue();
                    callInput.classList.toggle('is-pool-computed', isCalculatedPoolQuery(ownerNode.properties?.pool_query, baseItems));
                    return;
                }
                if (typeof ownerNode.applyPoolQuery === 'function') {
                    if (isFieldOperatorExpression(raw, baseItems)) {
                        ownerNode.resetTriggerCount?.();
                    }
                    const ok = await Promise.resolve(ownerNode.applyPoolQuery(raw));
                    if (ok) {
                        windowContext?.refreshAudioPreview?.();
                        await windowContext?.renderTabContent?.();
                        return;
                    }
                }
                callInput.value = getDisplayValue();
                callInput.classList.toggle('is-pool-computed', isCalculatedPoolQuery(ownerNode.properties?.pool_query, baseItems));
            };

            callInput.addEventListener('focus', () => {
                committedEnter = false;
                beforeFocus = getEditValue();
                callInput.value = beforeFocus;
                callInput.classList.remove('is-pool-computed');
                callInput.select();
            });
            callInput.addEventListener('blur', () => {
                if (!committedEnter) void commitCall();
                else {
                    callInput.value = getDisplayValue();
                    callInput.classList.toggle('is-pool-computed', isCalculatedPoolQuery(ownerNode.properties?.pool_query, baseItems));
                }
            });
            callInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    committedEnter = true;
                    void commitCall().then(() => callInput.blur());
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    committedEnter = true;
                    callInput.blur();
                }
            });

            const indexBadge = document.createElement('span');
            indexBadge.className = `td-pool-index-pill ${isCalc ? 'is-pool-computed' : ''}`;
            indexBadge.textContent = activeRunIdx >= 0 ? `#${activeRunIdx}` : '#—';
            indexBadge.title = activeRunIdx >= 0
                ? `Current run index ${activeRunIdx} (seed ${effPoolSeed})`
                : 'No pool item active';

            callBar.append(slotLabel, callInput, indexBadge);
            group.appendChild(callBar);
        }

        // 2. Pool Toolbar
        const toolbar = document.createElement('div');
        toolbar.className = 'asset-pool-toolbar';

        const toolbarMeta = document.createElement('div');
        toolbarMeta.className = 'asset-pool-toolbar-meta';

        const countSpan = document.createElement('span');
        countSpan.className = 'asset-pool-count';
        countSpan.textContent = `${items.length} ${items.length === 1 ? 'item' : 'items'}`;

        const seedPill = document.createElement('span');
        seedPill.className = `asset-pool-seed-pill ${effPoolSeed !== 0 ? 'is-permuted' : ''}`;
        seedPill.textContent = effPoolSeed === 0 ? 'Seed 0 · User order' : `Seed ${effPoolSeed} · Run order`;
        seedPill.title = effPoolSeed === 0
            ? 'Pool indices match user order (global seed is 0)'
            : `Pool indices are deterministically permuted by global seed ${effPoolSeed}`;

        toolbarMeta.append(countSpan, seedPill);
        toolbar.appendChild(toolbarMeta);

        if (isOwnerNode && isSequencePool && typeof ownerNode?.createNewInlineSequence === 'function') {
            const newSeqBtn = document.createElement('button');
            newSeqBtn.type = 'button';
            newSeqBtn.className = 'asset-pool-new-btn';
            newSeqBtn.textContent = '+ New';
            newSeqBtn.title = 'Create a new blank sequence in this pool';
            newSeqBtn.addEventListener('click', async () => {
                ownerNode.createNewInlineSequence();
                windowContext?.refreshAudioPreview?.();
                await windowContext?.renderTabContent?.();
            });
            toolbar.appendChild(newSeqBtn);
        }
        group.appendChild(toolbar);

        // 3. Compute slot usage map for chips (`S0`, `S1`, ...)
        const slotUsageByKey = new Map<string, number[]>();
        if (isOwnerNode && typeof ownerNode?.getSlots === 'function') {
            const ownerSlots = ownerNode.getSlots();
            ownerSlots.forEach((slot: any, sIdx: number) => {
                const sQuery = String(slot?.pool_query ?? '').trim();
                let matchedItem: any = null;
                if (sQuery && baseItems.length > 0 && isCalculatedPoolQuery(sQuery, baseItems)) {
                    matchedItem = resolvePoolItemByQuery(
                        baseItems,
                        sQuery,
                        sIdx,
                        slot?.seed ?? ownerNode.properties?.seed ?? 42,
                        false,
                        ownerNode.getTriggerCount?.() ?? 0,
                        { poolSeed: effPoolSeed, nodeId: poolSalt }
                    );
                }
                if (!matchedItem) {
                    const sId = slot?.library_item_id;
                    const sFp = String(slot?.filepath || '');
                    matchedItem = baseItems.find((it: any) =>
                        (sId != null && String(it?.id) === String(sId))
                        || (sFp && String(it?.filepath || it?.absolute_path || '') === sFp)
                    ) || null;
                }
                const key = matchedItem ? getPoolItemIdentityKey(matchedItem) : '';
                if (key) {
                    const list = slotUsageByKey.get(key) || [];
                    if (!list.includes(sIdx)) list.push(sIdx);
                    slotUsageByKey.set(key, list);
                }
            });
        }

        const listEl = document.createElement('div');
        listEl.className = `asset-pool-list ${items.length === 0 ? 'is-empty' : ''}`;
        listEl.id = 'prop-pool-items';
        listEl.tabIndex = 0;
        group.appendChild(listEl);
        container.appendChild(group);

        if (!(poolNode._selectedPoolIndices instanceof Set)) {
            poolNode._selectedPoolIndices = new Set<number>();
        }
        const selectedIndices: Set<number> = poolNode._selectedPoolIndices;
        for (const idx of [...selectedIndices]) {
            if (idx < 0 || idx >= items.length) selectedIndices.delete(idx);
        }
        let anchorIndex: number | null = selectedIndices.size > 0 ? [...selectedIndices][0] : null;

        const commitItems = async (nextItems: any[]) => {
            const attachedPool = isOwnerNode ? (ownerNode.getAttachedPoolNode?.() || poolNode) : poolNode;
            if (attachedPool?.properties) {
                attachedPool.updateProperty?.('selected_items', nextItems);
                attachedPool.updateProperty?.('sequence_index', -1);
            }
            if (ownerNode?.properties) {
                ownerNode.properties.selected_items = nextItems.map((it: any) => ({ ...it }));
                ownerNode.evaluateAllFieldOperators?.();
            }
            if (typeof window !== 'undefined') {
                if (attachedPool && attachedPool !== ownerNode) {
                    window.dispatchEvent(new CustomEvent('item-pool-preview-refresh', {
                        detail: { nodeId: attachedPool.id }
                    }));
                }
                if (ownerNode?.id != null) {
                    window.dispatchEvent(new CustomEvent('node-properties-refreshed', {
                        detail: { nodeId: ownerNode.id }
                    }));
                }
            }
            await windowContext?.renderTabContent?.();
        };

        const moveSelectedItems = async (sourceIndices: number[], targetIndex: number) => {
            const validSources = [...new Set(sourceIndices)]
                .filter(i => i >= 0 && i < items.length)
                .sort((a, b) => a - b);
            if (validSources.length === 0) return;

            const movingSet = new Set(validSources);
            const movingItems = validSources.map(i => items[i]);
            const remaining: Array<{ origIdx: number; item: any }> = [];
            items.forEach((item, idx) => {
                if (!movingSet.has(idx)) {
                    remaining.push({ origIdx: idx, item });
                }
            });

            let insertAt = remaining.findIndex(entry => entry.origIdx >= targetIndex);
            if (insertAt === -1) insertAt = remaining.length;
            else if (targetIndex > validSources[0]) {
                const afterTarget = remaining.findIndex(entry => entry.origIdx > targetIndex);
                insertAt = afterTarget === -1 ? remaining.length : afterTarget;
            }

            const nextItems = [
                ...remaining.slice(0, insertAt).map(e => e.item),
                ...movingItems,
                ...remaining.slice(insertAt).map(e => e.item),
            ];

            selectedIndices.clear();
            for (let i = 0; i < movingItems.length; i++) {
                selectedIndices.add(insertAt + i);
            }
            await commitItems(nextItems);
        };

        const deleteIndices = async (indicesToDelete: number[]) => {
            const origToDelete = new Set(
                indicesToDelete
                    .map(dispIdx => permOrder[dispIdx])
                    .filter((origIdx): origIdx is number => origIdx !== undefined)
            );
            if (origToDelete.size === 0) return;
            selectedIndices.clear();
            await commitItems(baseItems.filter((_, origIdx) => !origToDelete.has(origIdx)));
        };

        const rowElements: HTMLElement[] = [];
        const syncRowSelectionUI = () => {
            rowElements.forEach((el, idx) => {
                el.classList.toggle('is-selected', selectedIndices.has(idx));
            });
        };

        if (items.length === 0) {
            listEl.textContent = isSequencePool
                ? 'Drop MIDI / .seq files (from GAIA or OS), or edit steps / click + New'
                : 'Drop samples from GAIA or your OS file explorer';
        } else {
            const activeFilepath = String(ownerNode?.properties?.filepath || poolNode?.properties?.output_value || '');
            const activeItemId = ownerNode?.properties?.library_item_id ?? poolNode?.properties?.output_item_id;

            items.forEach((item, idx) => {
                const row = document.createElement('div');
                const itemPath = String(item?.filepath || item?.absolute_path || '');
                const itemKey = getPoolItemIdentityKey(item);
                const isActive = Boolean(
                    (activeItemId != null && item?.id != null && String(activeItemId) === String(item.id))
                    || (activeFilepath && itemPath && activeFilepath === itemPath)
                );
                row.className = `asset-pool-item-row ${isActive ? 'is-active' : ''} ${selectedIndices.has(idx) ? 'is-selected' : ''}`;
                row.draggable = true;
                row.dataset.index = String(idx);

                const order = document.createElement('span');
                order.className = 'asset-pool-item-order';
                order.textContent = String(idx);
                order.title = `Run index ${idx}`;

                // Audition button (audio) or 16-step minimap (sequence)
                let previewEl: HTMLElement;
                if (isSequencePool) {
                    previewEl = buildSequenceMinimap(item?.sequence);
                } else {
                    const previewBtn = document.createElement('button');
                    previewBtn.type = 'button';
                    previewBtn.className = 'asset-pool-item-preview-btn';
                    previewBtn.textContent = '▶';
                    previewBtn.title = 'Audition sample';
                    previewBtn.setAttribute('aria-label', `Audition ${getPoolItemCallName(item, false)}`);
                    previewBtn.addEventListener('click', (event) => {
                        event.stopPropagation();
                        if (!itemPath) return;
                        const wasThisPlaying = windowContext?.currentPoolPreviewButton === previewBtn;
                        windowContext?.stopPoolItemPreview?.();
                        if (wasThisPlaying) return;
                        const audio = new Audio(`/api/audio/file?filepath=${encodeURIComponent(itemPath)}`);
                        previewBtn.textContent = '■';
                        previewBtn.classList.add('is-playing');
                        if (windowContext) {
                            windowContext.currentPoolPreviewAudio = audio;
                            windowContext.currentPoolPreviewButton = previewBtn;
                        }
                        audio.addEventListener('ended', () => {
                            if (windowContext?.currentPoolPreviewButton === previewBtn) {
                                windowContext.stopPoolItemPreview?.();
                            }
                        });
                        audio.play().catch(() => {
                            if (windowContext?.currentPoolPreviewButton === previewBtn) {
                                windowContext.stopPoolItemPreview?.();
                            }
                        });
                    });
                    previewEl = previewBtn;
                }

                const callName = getPoolItemCallName(item, isSequencePool) || getAssetDisplayName(item);
                const sourceKind = getPoolSourceKind(item);
                const label = document.createElement('span');
                label.className = 'asset-pool-item-label';
                label.textContent = callName;
                label.title = sourceKind === 'external'
                    ? `${callName}\nExternal: ${itemPath}\nDouble-click to call in active slot`
                    : sourceKind === 'inline'
                        ? `${callName}\nInline sequence\nDouble-click to call in active slot`
                        : `${callName}\n${itemPath}\nDouble-click to call in active slot`;

                // Slot usage micro-chips
                const usedSlots = slotUsageByKey.get(itemKey) || [];
                const chipsWrap = document.createElement('span');
                chipsWrap.className = 'pool-slot-chips';
                for (const sIdx of usedSlots) {
                    const chip = document.createElement('span');
                    chip.className = 'pool-slot-chip';
                    chip.textContent = `S${sIdx}`;
                    chip.title = `Referenced by Slot ${sIdx}`;
                    chipsWrap.appendChild(chip);
                }

                // Source badge
                const sourceBadge = document.createElement('span');
                sourceBadge.className = `pool-source-badge pool-source-badge--${sourceKind}`;
                sourceBadge.textContent = sourceKind === 'external' ? 'EXT' : sourceKind === 'inline' ? 'INLINE' : 'GAIA';
                sourceBadge.title = sourceKind === 'external'
                    ? `External local file: ${itemPath}`
                    : sourceKind === 'inline'
                        ? 'Inline sequence stored in graph'
                        : 'GAIA library asset';

                // Inline rename button
                const renameBtn = document.createElement('button');
                renameBtn.type = 'button';
                renameBtn.textContent = '✎';
                renameBtn.title = 'Rename callable pool name';
                renameBtn.className = 'asset-pool-item-rename';
                renameBtn.setAttribute('aria-label', `Rename ${callName}`);
                if (!isOwnerNode || typeof ownerNode?.renamePoolItem !== 'function') {
                    renameBtn.style.display = 'none';
                }
                renameBtn.addEventListener('click', (event) => {
                    event.stopPropagation();
                    const editInput = document.createElement('input');
                    editInput.type = 'text';
                    editInput.className = 'asset-pool-item-rename-input';
                    editInput.value = callName;
                    let finished = false;
                    const commitRename = async () => {
                        if (finished) return;
                        finished = true;
                        const nextName = editInput.value.trim();
                        if (nextName && nextName !== callName) {
                            ownerNode.renamePoolItem(itemKey || String(item?.id ?? ''), nextName);
                        }
                        await windowContext?.renderTabContent?.();
                    };
                    editInput.addEventListener('click', ev => ev.stopPropagation());
                    editInput.addEventListener('keydown', ev => {
                        ev.stopPropagation();
                        if (ev.key === 'Enter') {
                            ev.preventDefault();
                            void commitRename();
                        } else if (ev.key === 'Escape') {
                            ev.preventDefault();
                            finished = true;
                            void windowContext?.renderTabContent?.();
                        }
                    });
                    editInput.addEventListener('blur', () => void commitRename());
                    label.replaceWith(editInput);
                    editInput.focus();
                    editInput.select();
                });

                const deleteButton = document.createElement('button');
                deleteButton.type = 'button';
                deleteButton.textContent = '×';
                deleteButton.title = 'Remove from pool';
                deleteButton.className = 'asset-pool-item-delete';
                deleteButton.setAttribute('aria-label', `Remove ${callName} from pool`);
                deleteButton.addEventListener('click', event => {
                    event.stopPropagation();
                    const targets = (selectedIndices.has(idx) && selectedIndices.size > 1)
                        ? [...selectedIndices]
                        : [idx];
                    void deleteIndices(targets);
                });

                row.append(order, previewEl, label, chipsWrap, sourceBadge, renameBtn, deleteButton);

                row.addEventListener('click', event => {
                    event.stopPropagation();
                    listEl.focus({ preventScroll: true });
                    if (event.shiftKey && anchorIndex !== null) {
                        const start = Math.min(anchorIndex, idx);
                        const end = Math.max(anchorIndex, idx);
                        if (!event.ctrlKey && !event.metaKey) selectedIndices.clear();
                        for (let i = start; i <= end; i++) selectedIndices.add(i);
                    } else if (event.ctrlKey || event.metaKey) {
                        if (selectedIndices.has(idx)) selectedIndices.delete(idx);
                        else selectedIndices.add(idx);
                        anchorIndex = idx;
                    } else {
                        selectedIndices.clear();
                        selectedIndices.add(idx);
                        anchorIndex = idx;
                    }
                    syncRowSelectionUI();
                });

                // Double-click calls the item by string name in the active slot
                row.addEventListener('dblclick', async (event) => {
                    event.stopPropagation();
                    if (!isOwnerNode || typeof ownerNode?.applyPoolQuery !== 'function') return;
                    const targetCall = getPoolItemCallName(item, isSequencePool);
                    if (!targetCall) return;
                    await Promise.resolve(ownerNode.applyPoolQuery(targetCall));
                    windowContext?.refreshAudioPreview?.();
                    await windowContext?.renderTabContent?.();
                });

                row.addEventListener('dragstart', event => {
                    if (!event.dataTransfer) return;
                    if (!selectedIndices.has(idx)) {
                        selectedIndices.clear();
                        selectedIndices.add(idx);
                        anchorIndex = idx;
                        syncRowSelectionUI();
                    }
                    const draggedIdxList = [...selectedIndices].sort((a, b) => a - b);
                    const draggedItems = draggedIdxList.map(i => {
                        const it = items[i];
                        return {
                            id: it.id,
                            filepath: String(it.filepath || it.absolute_path || ''),
                            itemType: it.type || (isSequencePool ? 'sequence' : 'audio'),
                            name: it.name || getPoolItemCallName(it, isSequencePool),
                            key: it.key ?? null,
                            bpm: it.bpm ?? null,
                            duration_seconds: it.duration_seconds ?? null,
                            is_external: isExternalPoolItem(it),
                            is_inline: isInlinePoolItem(it),
                            source: getPoolSourceKind(it),
                            sequence: Array.isArray(it.sequence) ? [...it.sequence] : undefined,
                            step_parameters: Array.isArray(it.step_parameters) ? it.step_parameters.map((s: any) => ({ ...s })) : undefined,
                            fromPool: true,
                            poolIndex: i
                        };
                    });
                    attachLibraryDragData(event.dataTransfer, draggedItems, {
                        effectAllowed: 'copyMove',
                        poolReorderIndices: draggedIdxList
                    });
                    draggedIdxList.forEach(i => rowElements[i]?.classList.add('is-reordering'));
                });

                row.addEventListener('dragend', () => {
                    clearActiveLibraryDragData();
                    rowElements.forEach(element => {
                        element.classList.remove('is-reordering', 'is-reorder-target');
                    });
                });

                row.addEventListener('dragover', event => {
                    if (!event.dataTransfer?.types.includes(DRAG_MIME_POOL_REORDER)) return;
                    event.preventDefault();
                    event.stopPropagation();
                    event.dataTransfer.dropEffect = 'move';
                    row.classList.add('is-reorder-target');
                });
                row.addEventListener('dragleave', () => row.classList.remove('is-reorder-target'));
                row.addEventListener('drop', event => {
                    if (!event.dataTransfer?.types.includes(DRAG_MIME_POOL_REORDER)) return;
                    const rawIndices = event.dataTransfer.getData(DRAG_MIME_POOL_REORDER);
                    const sourceIndices = rawIndices
                        .split(',')
                        .map(s => Number(s.trim()))
                        .filter(n => Number.isInteger(n));
                    if (sourceIndices.length === 0) return;
                    event.preventDefault();
                    event.stopPropagation();
                    row.classList.remove('is-reorder-target');
                    void moveSelectedItems(sourceIndices, idx);
                });

                rowElements.push(row);
                listEl.appendChild(row);
            });
        }

        listEl.addEventListener('keydown', (event: KeyboardEvent) => {
            if ((event.key === 'Delete' || event.key === 'Backspace') && selectedIndices.size > 0) {
                event.preventDefault();
                event.stopPropagation();
                void deleteIndices([...selectedIndices]);
            }
        });

        const canAcceptPoolDrop = (dt: DataTransfer | null): boolean => {
            return isSequencePool ? hasSequenceDragPayload(dt) : hasAudioDragPayload(dt);
        };

        listEl.addEventListener('dragover', event => {
            if (event.dataTransfer?.types.includes(DRAG_MIME_POOL_REORDER)) {
                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect = 'move';
                return;
            }
            if (!canAcceptPoolDrop(event.dataTransfer)) return;
            event.preventDefault();
            event.stopPropagation();
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
            listEl.classList.add('is-dragover');
        });
        listEl.addEventListener('dragleave', event => {
            if (!listEl.contains(event.relatedTarget as Node | null)) {
                listEl.classList.remove('is-dragover');
            }
        });
        listEl.addEventListener('drop', async event => {
            listEl.classList.remove('is-dragover');
            if (!event.dataTransfer) return;
            if (event.dataTransfer.types.includes(DRAG_MIME_POOL_REORDER)) {
                event.preventDefault();
                event.stopPropagation();
                const rawIndices = event.dataTransfer.getData(DRAG_MIME_POOL_REORDER);
                const sourceIndices = rawIndices
                    .split(',')
                    .map(s => Number(s.trim()))
                    .filter(n => Number.isInteger(n));
                if (sourceIndices.length > 0) {
                    await moveSelectedItems(sourceIndices, items.length - 1);
                }
                return;
            }
            if (!canAcceptPoolDrop(event.dataTransfer)) return;
            event.preventDefault();
            event.stopPropagation();
            const droppedItems = await resolveDroppedPoolItemsByType(event.dataTransfer, isSequencePool);
            if (droppedItems.length === 0) return;

            if (isOwnerNode && typeof ownerNode?.ensureItemsInPool === 'function') {
                const hadActiveAsset = Boolean(ownerNode.properties?.filepath || ownerNode.properties?.is_inline);
                const registered = ownerNode.ensureItemsInPool(droppedItems);
                if (!hadActiveAsset && registered.length > 0 && typeof ownerNode.applyPoolQuery === 'function') {
                    const firstCall = getPoolItemCallName(registered[0], isSequencePool);
                    if (firstCall) {
                        await Promise.resolve(ownerNode.applyPoolQuery(firstCall));
                    }
                }
                windowContext?.refreshAudioPreview?.();
                await windowContext?.renderTabContent?.();
                return;
            }

            const merged = new Map<string, any>();
            for (const item of baseItems) {
                const key = getPoolItemIdentityKey(item);
                if (key) merged.set(key, item);
            }
            for (const item of droppedItems) {
                const isExt = isExternalPoolItem(item);
                const isInline = isInlinePoolItem(item);
                const key = getPoolItemIdentityKey(item);
                const already = key ? merged.get(key) : null;
                const rawName = item.name || (item.filepath ? item.filepath.split(/[\\/]/).pop() : 'Sequence') || 'Item';
                const dedupedName = already?.name || deduplicatePoolItemName(rawName, [...merged.values()], key);
                const poolItem = {
                    id: item.id ?? (isExt ? `ext:${item.filepath}` : `inline:${Date.now()}`),
                    absolute_path: isInline ? '' : item.filepath,
                    filepath: isInline ? '' : item.filepath,
                    name: dedupedName,
                    type: item.itemType || (isInline || item.filepath.toLowerCase().endsWith('.seq') ? 'sequence' : item.filepath.toLowerCase().match(/\.midi?$/) ? 'midi' : 'audio'),
                    key: item.key ?? null,
                    bpm: item.bpm ?? null,
                    duration_seconds: item.duration_seconds ?? null,
                    is_external: isExt,
                    is_inline: isInline,
                    source: isInline ? 'inline' : isExt ? 'external' : 'gaia',
                    ...(Array.isArray(item.sequence) ? { sequence: [...item.sequence] } : {}),
                    ...(Array.isArray(item.step_parameters) ? { step_parameters: item.step_parameters.map(s => ({ ...s })) } : {}),
                };
                const finalKey = getPoolItemIdentityKey(poolItem);
                if (finalKey) merged.set(finalKey, poolItem);
            }

            await commitItems([...merged.values()]);
        });
    }
}
