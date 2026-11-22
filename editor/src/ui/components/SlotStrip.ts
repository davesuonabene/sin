import { type BaseNode } from '../../nodes/BaseNode.ts';
import { type NodeSlot } from '../../../../ermes/ts/slotLanguage.ts';

export interface SlotSelectModifiers {
    toggle?: boolean;
    range?: boolean;
}

export interface SlotStripOptions {
    node?: BaseNode;
    slots: NodeSlot[];
    activeSlot: number;
    selectedSlots?: number[];
    onSelectSlot: (slotIndex: number, modifiers?: SlotSelectModifiers) => void;
    onAddSlot: () => void;
    onRemoveSlot: (slotIndex: number) => void;
    onCopySlot?: (slotIndex: number) => void;
    onPasteSlot?: (slotIndex: number) => void;
    canAcceptDrop?: (dataTransfer: DataTransfer | null) => boolean;
    onDragHoverSlot?: (slotIndex: number) => void;
    onDropOnSlot?: (slotIndex: number, dataTransfer: DataTransfer) => void;
    onDropOnAdd?: (dataTransfer: DataTransfer) => void;
    getSlotTooltip?: (slot: NodeSlot, index: number) => string;
}

export interface SlotStripRenderOptions {
    node?: BaseNode;
    slots?: NodeSlot[];
    slotCount: number;
    activeSlot: number;
    selectedSlots?: number[];
    accentColor?: string;
    onSelect: (slotIndex: number, modifiers?: SlotSelectModifiers) => void;
    onAdd: () => void;
    onRemove: (slotIndex: number) => void;
    onCopy?: (slotIndex: number) => void;
    onPaste?: (slotIndex: number) => void;
    canAcceptDrop?: (dataTransfer: DataTransfer | null) => boolean;
    onDragHoverSlot?: (slotIndex: number) => void;
    onDropOnSlot?: (slotIndex: number, dataTransfer: DataTransfer) => void;
    onDropOnAdd?: (dataTransfer: DataTransfer) => void;
}

/**
 * Reusable TouchDesigner-style Slot Strip (`0 1 ... + ×`)
 * shared across SampleNode (`WaveformCropSection`) and SequenceNode (`SequenceGridSection`).
 */
export class SlotStrip {
    static render(options: SlotStripRenderOptions): HTMLElement {
        const count = Math.max(1, Math.floor(Number(options.slotCount) || 1));
        const slots: NodeSlot[] = Array.isArray(options.slots) && options.slots.length > 0
            ? options.slots
            : Array.from({ length: count }, (_, idx) => ({ slot: idx, index: idx }));
        return SlotStrip.create({
            node: options.node,
            slots,
            activeSlot: options.activeSlot,
            selectedSlots: options.selectedSlots,
            onSelectSlot: options.onSelect,
            onAddSlot: options.onAdd,
            onRemoveSlot: options.onRemove,
            onCopySlot: options.onCopy,
            onPasteSlot: options.onPaste,
            canAcceptDrop: options.canAcceptDrop,
            onDragHoverSlot: options.onDragHoverSlot,
            onDropOnSlot: options.onDropOnSlot,
            onDropOnAdd: options.onDropOnAdd,
        });
    }

    static create(options: SlotStripOptions): HTMLElement {
        const {
            node,
            slots,
            activeSlot,
            selectedSlots,
            onSelectSlot,
            onAddSlot,
            onRemoveSlot,
            onCopySlot,
            onPasteSlot,
            canAcceptDrop,
            onDragHoverSlot,
            onDropOnSlot,
            onDropOnAdd,
            getSlotTooltip,
        } = options;

        const bar = document.createElement('div');
        bar.className = 'td-slot-strip';
        bar.tabIndex = 0;

        const leftGroup = document.createElement('div');
        leftGroup.className = 'td-slot-strip-left';

        const label = document.createElement('span');
        label.className = 'td-slot-strip-label';
        label.textContent = 'Slots';
        leftGroup.appendChild(label);

        const safeSlots = slots.length > 0 ? slots : [{ slot: 0 }];
        let clampedActive = Math.max(0, Math.min(safeSlots.length - 1, activeSlot || 0));
        const nodeSelected = typeof (node as any)?.getSelectedSlotIndices === 'function'
            ? (node as any).getSelectedSlotIndices()
            : undefined;
        const selectedSet = new Set<number>(
            Array.isArray(selectedSlots) && selectedSlots.length > 0
                ? selectedSlots
                : Array.isArray(nodeSelected) && nodeSelected.length > 0
                    ? nodeSelected
                    : [clampedActive]
        );

        const markSlotFocused = (idx: number) => {
            if (typeof window !== 'undefined') {
                (window as any).__sinFocusedSlot = {
                    nodeId: node?.id ?? null,
                    slotIndex: idx,
                    timestamp: Date.now()
                };
            }
        };

        const pillButtons: HTMLButtonElement[] = [];

        const applyPillStyle = (btn: HTMLButtonElement, idx: number, isDragOver = false) => {
            const isPrimary = idx === clampedActive;
            const isMultiSelected = selectedSet.has(idx);
            btn.classList.toggle('is-active', isPrimary);
            btn.classList.toggle('active', isPrimary);
            btn.classList.toggle('is-selected', isMultiSelected);
            btn.classList.toggle('is-dragover', isDragOver);
        };

        safeSlots.forEach((slotObj, idx) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'td-slot-pill';
            btn.dataset.slotIndex = String(idx);
            btn.textContent = String(idx);
            const baseTip = getSlotTooltip
                ? getSlotTooltip(slotObj, idx)
                : (slotObj.filepath ? `Slot ${idx}: ${String(slotObj.filepath).split(/[\\/]/).pop()}` : `Slot ${idx}`);
            btn.title = `${baseTip} · Click, Ctrl+Click, or Shift+Click · Ctrl+C/V · Drop asset to load`;
            applyPillStyle(btn, idx);

            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                markSlotFocused(idx);
                bar.focus({ preventScroll: true });
                const isToggle = e.ctrlKey || e.metaKey;
                const isRange = e.shiftKey;
                if (isToggle || isRange || idx !== clampedActive || selectedSet.size > 1) {
                    onSelectSlot(idx, { toggle: isToggle, range: isRange });
                }
            });

            btn.addEventListener('dragover', (e: DragEvent) => {
                if (canAcceptDrop && !canAcceptDrop(e.dataTransfer)) return;
                e.preventDefault();
                e.stopPropagation();
                if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
                if (clampedActive !== idx) {
                    clampedActive = idx;
                    selectedSet.clear();
                    selectedSet.add(idx);
                    pillButtons.forEach((b, bIdx) => applyPillStyle(b, bIdx, bIdx === idx));
                    onDragHoverSlot?.(idx);
                } else {
                    applyPillStyle(btn, idx, true);
                }
            });

            btn.addEventListener('dragleave', () => {
                applyPillStyle(btn, idx, false);
            });

            btn.addEventListener('drop', (e: DragEvent) => {
                if (canAcceptDrop && !canAcceptDrop(e.dataTransfer)) return;
                e.preventDefault();
                e.stopPropagation();
                applyPillStyle(btn, idx, false);
                if (e.dataTransfer) {
                    onDropOnSlot?.(idx, e.dataTransfer);
                }
            });

            pillButtons.push(btn);
            leftGroup.appendChild(btn);
        });

        bar.addEventListener('keydown', (e: KeyboardEvent) => {
            if ((e.key === 'Delete' || e.key === 'Backspace') && !e.ctrlKey && !e.metaKey && !e.altKey) {
                if (safeSlots.length > 1) {
                    e.preventDefault();
                    e.stopPropagation();
                    onRemoveSlot(clampedActive);
                }
                return;
            }
            if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
            const key = e.key.toLowerCase();
            if (key === 'c') {
                e.preventDefault();
                e.stopPropagation();
                (node as any)?.copySlot?.(clampedActive);
                onCopySlot?.(clampedActive);
            } else if (key === 'v') {
                e.preventDefault();
                e.stopPropagation();
                const pasted = (node as any)?.pasteSlot?.(clampedActive);
                if (pasted !== false) {
                    onPasteSlot?.(clampedActive);
                }
            }
        });

        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'td-slot-add-btn td-param-action-btn';
        addBtn.textContent = '+';
        addBtn.title = 'Add slot variation · Drop assets here to create multiple slots';
        addBtn.setAttribute('aria-label', 'Add slot');
        const applyAddBtnStyle = (isDragOver = false) => {
            addBtn.classList.toggle('is-dragover', isDragOver);
        };
        addBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            onAddSlot();
        });
        addBtn.addEventListener('dragover', (e: DragEvent) => {
            if (!onDropOnAdd || (canAcceptDrop && !canAcceptDrop(e.dataTransfer))) return;
            e.preventDefault();
            e.stopPropagation();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
            applyAddBtnStyle(true);
        });
        addBtn.addEventListener('dragleave', () => {
            applyAddBtnStyle(false);
        });
        addBtn.addEventListener('drop', (e: DragEvent) => {
            if (!onDropOnAdd || (canAcceptDrop && !canAcceptDrop(e.dataTransfer))) return;
            e.preventDefault();
            e.stopPropagation();
            applyAddBtnStyle(false);
            if (e.dataTransfer) {
                onDropOnAdd(e.dataTransfer);
            }
        });
        leftGroup.appendChild(addBtn);

        const actionsGroup = document.createElement('div');
        actionsGroup.className = 'td-slot-strip-actions';

        if (safeSlots.length > 1) {
            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'td-slot-remove-btn td-param-action-btn';
            removeBtn.textContent = '×';
            const removeCount = selectedSet.size;
            removeBtn.title = removeCount > 1
                ? `Remove ${removeCount} selected slots`
                : `Remove active slot ${clampedActive}`;
            removeBtn.setAttribute('aria-label', removeBtn.title);
            removeBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                onRemoveSlot(clampedActive);
            });
            actionsGroup.appendChild(removeBtn);
        }

        bar.append(leftGroup, actionsGroup);
        return bar;
    }
}
