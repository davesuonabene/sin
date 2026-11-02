import { type BaseNode } from '../../nodes/BaseNode.ts';
import { type NodeSlot } from '../../../../ermes/ts/slotLanguage.ts';

export interface SlotStripOptions {
    node?: BaseNode;
    slots: NodeSlot[];
    activeSlot: number;
    onSelectSlot: (slotIndex: number) => void;
    onAddSlot: () => void;
    onRemoveSlot: (slotIndex: number) => void;
    getSlotTooltip?: (slot: NodeSlot, index: number) => string;
}

export interface SlotStripRenderOptions {
    slotCount: number;
    activeSlot: number;
    accentColor?: string;
    onSelect: (slotIndex: number) => void;
    onAdd: () => void;
    onRemove: (slotIndex: number) => void;
}

/**
 * Reusable TouchDesigner-style Slot Strip (`0 1 ... + ×`)
 * shared across SampleNode (`WaveformCropSection`) and SequenceNode (`SequenceGridSection`).
 */
export class SlotStrip {
    static render(options: SlotStripRenderOptions): HTMLElement {
        const count = Math.max(1, Math.floor(Number(options.slotCount) || 1));
        const slots: NodeSlot[] = Array.from({ length: count }, (_, idx) => ({ slot: idx, index: idx }));
        return SlotStrip.create({
            slots,
            activeSlot: options.activeSlot,
            onSelectSlot: options.onSelect,
            onAddSlot: options.onAdd,
            onRemoveSlot: options.onRemove,
        });
    }

    static create(options: SlotStripOptions): HTMLElement {
        const {
            slots,
            activeSlot,
            onSelectSlot,
            onAddSlot,
            onRemoveSlot,
            getSlotTooltip,
        } = options;

        const bar = document.createElement('div');
        bar.className = 'td-slot-strip';
        bar.style.display = 'flex';
        bar.style.alignItems = 'center';
        bar.style.justifyContent = 'space-between';
        bar.style.gap = '4px';
        bar.style.marginBottom = '4px';
        bar.style.padding = '2px 5px';
        bar.style.background = '#f8fafc';
        bar.style.border = '1px solid #e2e8f0';
        bar.style.borderRadius = '4px';

        const leftGroup = document.createElement('div');
        leftGroup.style.display = 'flex';
        leftGroup.style.alignItems = 'center';
        leftGroup.style.gap = '3px';
        leftGroup.style.flexWrap = 'wrap';
        leftGroup.style.minWidth = '0';

        const label = document.createElement('span');
        label.textContent = 'Slots';
        label.style.fontSize = '9.5px';
        label.style.fontWeight = '600';
        label.style.color = '#64748b';
        label.style.marginRight = '2px';
        label.style.lineHeight = '1';
        leftGroup.appendChild(label);

        const safeSlots = slots.length > 0 ? slots : [{ slot: 0 }];
        const clampedActive = Math.max(0, Math.min(safeSlots.length - 1, activeSlot || 0));

        safeSlots.forEach((slotObj, idx) => {
            const isSelected = idx === clampedActive;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = `td-slot-pill ${isSelected ? 'is-active active' : ''}`;
            btn.dataset.slotIndex = String(idx);
            btn.textContent = String(idx);
            btn.title = getSlotTooltip
                ? getSlotTooltip(slotObj, idx)
                : (slotObj.filepath ? `Slot ${idx}: ${String(slotObj.filepath).split(/[\\/]/).pop()}` : `Slot ${idx}`);
            btn.style.display = 'inline-flex';
            btn.style.alignItems = 'center';
            btn.style.justifyContent = 'center';
            btn.style.boxSizing = 'border-box';
            btn.style.minWidth = '16px';
            btn.style.height = '16px';
            btn.style.padding = '0 3px';
            btn.style.fontSize = '9.5px';
            btn.style.lineHeight = '1';
            btn.style.fontWeight = isSelected ? '700' : '600';
            btn.style.fontFamily = 'monospace';
            btn.style.borderRadius = '3px';
            btn.style.border = isSelected ? '1px solid #0284c7' : '1px solid #cbd5e1';
            btn.style.background = isSelected ? '#e0f2fe' : '#ffffff';
            btn.style.color = isSelected ? '#0369a1' : '#475569';
            btn.style.cursor = 'pointer';

            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (idx !== clampedActive) {
                    onSelectSlot(idx);
                }
            });
            leftGroup.appendChild(btn);
        });

        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'td-slot-add-btn td-param-action-btn';
        addBtn.textContent = '+';
        addBtn.title = 'Add slot variation';
        addBtn.setAttribute('aria-label', 'Add slot');
        addBtn.style.display = 'inline-flex';
        addBtn.style.alignItems = 'center';
        addBtn.style.justifyContent = 'center';
        addBtn.style.boxSizing = 'border-box';
        addBtn.style.width = '16px';
        addBtn.style.minWidth = '16px';
        addBtn.style.height = '16px';
        addBtn.style.padding = '0';
        addBtn.style.fontSize = '11px';
        addBtn.style.lineHeight = '1';
        addBtn.style.fontWeight = '700';
        addBtn.style.borderRadius = '3px';
        addBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            onAddSlot();
        });
        leftGroup.appendChild(addBtn);

        const actionsGroup = document.createElement('div');
        actionsGroup.style.display = 'flex';
        actionsGroup.style.alignItems = 'center';
        actionsGroup.style.gap = '3px';
        actionsGroup.style.flexShrink = '0';

        if (safeSlots.length > 1) {
            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'td-slot-remove-btn td-param-action-btn';
            removeBtn.textContent = '×';
            removeBtn.title = `Remove active slot ${clampedActive}`;
            removeBtn.setAttribute('aria-label', `Remove slot ${clampedActive}`);
            removeBtn.style.display = 'inline-flex';
            removeBtn.style.alignItems = 'center';
            removeBtn.style.justifyContent = 'center';
            removeBtn.style.boxSizing = 'border-box';
            removeBtn.style.width = '16px';
            removeBtn.style.minWidth = '16px';
            removeBtn.style.height = '16px';
            removeBtn.style.padding = '0';
            removeBtn.style.fontSize = '11px';
            removeBtn.style.lineHeight = '1';
            removeBtn.style.fontWeight = '700';
            removeBtn.style.borderRadius = '3px';
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
