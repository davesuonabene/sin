import { LiteGraph } from 'litegraph.js';
import { BaseNode } from './BaseNode.ts';
import { type FieldSchema } from '../fields/FieldSchema.ts';
import { type NodePanelSchema } from '../fields/NodePanelSchema.ts';
import { SequenceRenderer, type RenderBox, type SignalTelemetry, type SequenceStep, type VisualizationTypeId } from '../../../packages/iride/src/index.ts';
import { compositeSequenceBuffer, getNodeGainMultiplier } from '../audioCompositor.ts';
import {
    type NodeSlot,
    copyNodeSlotToClipboard,
    formatPoolListExpression,
    getCopiedNodeSlotFromClipboard,
    isFieldOperatorExpression,
    resolveStepSlots,
    resolveCycleSeeds,
    resolveModifierSlotSeeds
} from '../../../ermes/ts/slotLanguage.ts';
import { populateOwnerSlotsFromRandom } from '../../../ermes/ts/randomResolver.ts';
import { populateOwnerSlotsFromPool, resolvePoolItemByQuery } from '../../../ermes/ts/assetResolver.ts';

export interface SequenceChannel {
    on: number[];
    probability: number[];
    offset: number[];
    velocity: number[];
    subdivisions: number[];
    sample_start?: number[];
    gate_length?: number[];
}

export interface SequenceDocument {
    format: 'sin-sequence';
    version: 1;
    name: string;
    channels: SequenceChannel[];
}

export class SequenceNode extends BaseNode {
    private sequenceRenderer = new SequenceRenderer({ accentColor: '#ec4899' });
    static readonly stepCount = 16;
    static readonly stepParameterKeys = ['sample_start', 'gate_length', 'velocity', 'offset', 'probability', 'subdivisions'];

    static panelSchema: NodePanelSchema = {
        tabs: [
            {
                id: 'SEQUENCE',
                label: 'Sequence',
                sections: [
                    { type: 'sequence_grid' },
                    { type: 'fields', fields: ['sample_slot', 'total_bars', 'step_length', 'play_mode', 'release', 'fade_ms'] }
                ]
            },
            {
                id: 'CHAIN',
                label: 'FX Chain',
                sections: [
                    { type: 'fx_chain', chainKey: 'chain' }
                ]
            },
            {
                id: 'COMMON',
                label: 'Common',
                sections: [
                    { type: 'appearance' },
                    { type: 'info_table' }
                ]
            }
        ]
    };

    static fields: FieldSchema[] = [
        { key: 'node_name', label: 'Name', type: 'string', default: 'Sequence', tab: 'COMMON' },
        { key: 'sample_slot', label: 'Sample Slot', type: 'string', default: '*', tab: 'SEQUENCE', description: 'Upstream sample slot selector evaluated per step (e.g. "*" for active upstream slot, "0", "0 1", "rand").' },
        { key: 'total_bars', label: 'Total Bars', type: 'global_float', default: 'global', min: 0.25, max: 128, step: 0.25, unit: 'bars', tab: 'SEQUENCE', description: 'Pattern playback duration. "global" inherits from parent track or project setting.' },
        { key: 'sample_start', label: 'Sample Start', type: 'float', default: 0.0, min: 0.0, max: 1.0, step: 0.1, tab: 'SEQUENCE', stepVisual: { mode: 'fill', polarity: 'unipolar', direction: 'vertical' }, description: 'Normalized sample playback start position for this step (0.0 to 1.0).' },
        { key: 'gate_length', label: 'Gate Length', type: 'float', default: 1.0, min: 0.0, max: 1.0, step: 0.1, tab: 'SEQUENCE', stepVisual: { mode: 'fill', polarity: 'unipolar', direction: 'vertical' }, description: 'Multiplier for full sample length (0.0 to 1.0). 1.0 is full sample length; 0.9 is 90% of sample length. In Mono mode, next note shuts previous.' },
        { key: 'velocity', label: 'Velocity', type: 'float', default: 1.0, min: 0.0, max: 1.0, step: 0.1, tab: 'SEQUENCE', stepVisual: { mode: 'fill', polarity: 'unipolar', direction: 'vertical' } },
        { key: 'offset', label: 'Offset', type: 'float', default: 0.0, min: -0.5, max: 0.5, step: 0.1, tab: 'SEQUENCE', stepVisual: { mode: 'fill', polarity: 'bipolar', direction: 'horizontal' } },
        { key: 'probability', label: 'Probability', type: 'float', default: 1.0, min: 0.0, max: 1.0, step: 0.1, tab: 'SEQUENCE', stepVisual: { mode: 'fill', polarity: 'unipolar', direction: 'vertical' } },
        { key: 'subdivisions', label: 'Subdivisions', type: 'int', default: 1, min: 1, max: 16, step: 1, tab: 'SEQUENCE', stepVisual: { mode: 'fragments' } },
        { key: 'step_length', label: 'Step Length', type: 'float', default: 0.25, min: 0.0625, max: 4.0, step: 0.0625, unit: 'beats', tab: 'SEQUENCE' },
        { key: 'play_mode', label: 'Voice Mode', type: 'radio', default: 'gate', options: [{ value: 'gate', label: 'Mono' }, { value: 'trigger', label: 'Multivoice' }], tab: 'SEQUENCE', description: 'Mono cuts previous playing sample when a note comes in; Multivoice allows overlapping voices.' },
        { key: 'release', label: 'Release', type: 'float', default: 0.0, min: 0.0, max: 1.0, step: 0.1, tab: 'SEQUENCE', description: 'Fade-out release mapped to sample percentage (0.0 to 1.0).' },
        { key: 'fade_ms', label: 'Step Fade', type: 'float', default: 0, min: 0, max: 5, step: 0.1, unit: 'ms', tab: 'SEQUENCE', description: 'Applies a short gain fade at the start and end of every triggered sample.' },
        { key: 'seed', label: 'Seed', type: 'seed', default: 42, tab: 'SEQUENCE', description: 'Deterministic seed or seed sequence (e.g. "42", "42 108", "rand") for step probability and sample_slot="rand".' }
    ];

    static defaultColor = "#ec4899";
    static defaultIcon = "sequence";
    static badgeLabel = "SEQ";
    static nodeType = "sequence";
    static defaultTab = "SEQUENCE";
    static tabs = ["SEQUENCE", "CHAIN", "COMMON"];
    static override defaultVisualizationType: VisualizationTypeId = 'sequence';
    static override supportedVisualizationTypes: readonly VisualizationTypeId[] = ['sequence', 'loop', 'realtime', 'spectrum'];

    getStepParameterFields(): FieldSchema[] {
        return SequenceNode.stepParameterKeys
            .map(key => SequenceNode.fields.find(field => field.key === key))
            .filter((field): field is FieldSchema => Boolean(field));
    }

    toSequenceDocument(): SequenceDocument {
        const sequence = Array.isArray(this.properties.sequence) ? this.properties.sequence : [];
        const parameters = Array.isArray(this.properties.step_parameters) ? this.properties.step_parameters : [];
        const valueFor = (key: string, index: number, fallback: number) => {
            const value = Number(parameters[index]?.[key]);
            return Number.isFinite(value) ? value : fallback;
        };
        const normValueFor = (key: string, index: number, fallback: number) => {
            const raw = valueFor(key, index, fallback);
            return raw > 1.0 ? raw / 100.0 : raw;
        };
        return {
            format: 'sin-sequence',
            version: 1,
            name: String(this.properties.node_name || this.title || 'Sequence').trim() || 'Sequence',
            channels: [{
                on: sequence.map(value => value ? 1 : 0),
                probability: sequence.map((_, index) => normValueFor('probability', index, 1.0)),
                offset: sequence.map((_, index) => valueFor('offset', index, 0)),
                velocity: sequence.map((_, index) => valueFor('velocity', index, 1.0)),
                subdivisions: sequence.map((_, index) => valueFor('subdivisions', index, 1)),
                sample_start: sequence.map((_, index) => normValueFor('sample_start', index, 0.0)),
                gate_length: sequence.map((_, index) => normValueFor('gate_length', index, 1.0)),
            }]
        };
    }

    applySequenceDocument(document: SequenceDocument, channelIndex = 0): void {
        const channel = document.channels?.[channelIndex];
        if (!channel) throw new Error('Sequence file has no playable channel');
        const stepCount = channel.on.length;
        const arrays = [channel.probability, channel.offset, channel.velocity, channel.subdivisions];
        if (!stepCount || arrays.some(values => !Array.isArray(values) || values.length !== stepCount)) {
            throw new Error('Sequence parameter arrays do not have matching lengths');
        }
        const bounded = (value: unknown, min: number, max: number, fallback: number) => {
            const numeric = Number(value);
            return Number.isFinite(numeric) ? Math.max(min, Math.min(max, numeric)) : fallback;
        };
        const stepParameters = Array.from({ length: stepCount }, (_, index) => {
            const rawProb = Number(channel.probability?.[index] ?? 1.0);
            const normProb = rawProb > 1.0 ? rawProb / 100.0 : rawProb;
            const rawStart = Number(channel.sample_start?.[index] ?? 0.0);
            const normStart = rawStart > 1.0 ? rawStart / 100.0 : rawStart;
            const rawGate = Number(channel.gate_length?.[index] ?? 1.0);
            const normGate = rawGate > 1.0 ? rawGate / 100.0 : rawGate;
            return {
                probability: bounded(normProb, 0.0, 1.0, 1.0),
                offset: bounded(channel.offset[index], -0.5, 0.5, 0),
                velocity: bounded(channel.velocity[index], 0, 1, 1),
                subdivisions: Math.round(bounded(channel.subdivisions[index], 1, 16, 1)),
                subdivision_enabled: bounded(channel.subdivisions[index], 1, 16, 1) > 1,
                sample_start: bounded(normStart, 0.0, 1.0, 0.0),
                gate_length: bounded(normGate, 0.0, 1.0, 1.0),
            };
        });
        const seqTitle = document.name || 'Sequence';
        this.updateProperty('node_name', seqTitle);
        this.updateProperty('sequence_name', seqTitle);
        this.updateProperty('sequence', channel.on.map(value => value ? 1 : 0));
        this.updateProperty('step_parameters', stepParameters);

        const graph = this.graph || (typeof window !== 'undefined' ? (window as any).editorGraph : null);
        const allNodes = ((graph as any)?._nodes || (graph as any)?.nodes || []) as any[];
        for (const candidate of allNodes) {
            const isRandom = candidate?.type === 'Audio/Random'
                || candidate?.properties?.node_type === 'random'
                || (candidate?.isModifier && candidate?.modifierKind === 'random');
            if (isRandom && candidate?.properties?.parentId === this.id) {
                if (Array.isArray(candidate.properties?.destinations)) {
                    for (const dest of candidate.properties.destinations) {
                        if (dest && typeof dest === 'object') {
                            delete dest.baseValueArray;
                        }
                    }
                }
                populateOwnerSlotsFromRandom(candidate, this);
            }
        }
    }

    static readonly slotPropertyKeys = [
        'filepath',
        'pool_query',
        'library_item_id',
        'sequence_name',
        'node_name',
        'sequence',
        'step_parameters',
        'sample_slot',
        'step_length',
        'target_bpm',
        'total_bars',
        'play_mode',
        'release',
        'fade_ms',
        'seed',
    ] as const;

    public activeSlotIndex = 0;
    public selectedSlotIndices: number[] = [0];

    public getSelectedSlotIndices(): number[] {
        const slots = this.getSlots();
        const valid = (Array.isArray(this.selectedSlotIndices) ? this.selectedSlotIndices : [])
            .filter(idx => Number.isInteger(idx) && idx >= 0 && idx < slots.length);
        if (valid.length === 0) {
            const fallback = Math.min(Math.max(0, this.activeSlotIndex), Math.max(0, slots.length - 1));
            this.selectedSlotIndices = [fallback];
            return this.selectedSlotIndices;
        }
        return valid;
    }

    private buildSlotSnapshotFromProperties(slotIndex: number, base?: NodeSlot): NodeSlot {
        const rawSeq = Array.isArray(this.properties?.sequence)
            ? [...this.properties.sequence]
            : (Array.isArray(base?.sequence) ? [...base.sequence] : [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
        const rawParams = Array.isArray(this.properties?.step_parameters)
            ? this.properties.step_parameters.map((s: any) => ({ ...(s || {}) }))
            : (Array.isArray(base?.step_parameters) ? base.step_parameters.map((s: any) => ({ ...(s || {}) })) : []);
        return {
            ...(base || {}),
            slot: slotIndex,
            index: slotIndex,
            pool_query: this.properties?.pool_query !== undefined ? String(this.properties.pool_query) : base?.pool_query,
            filepath: this.properties?.filepath !== undefined ? String(this.properties.filepath) : base?.filepath,
            library_item_id: this.properties?.library_item_id ?? base?.library_item_id,
            sequence_name: this.properties?.sequence_name !== undefined
                ? String(this.properties.sequence_name)
                : (this.properties?.node_name !== undefined ? String(this.properties.node_name) : base?.sequence_name),
            sequence: rawSeq,
            step_parameters: rawParams,
            sample_slot: String(this.properties?.sample_slot ?? base?.sample_slot ?? '*'),
            step_length: Number(this.properties?.step_length ?? base?.step_length ?? 0.25),
            target_bpm: this.properties?.target_bpm ?? base?.target_bpm ?? 'global',
            total_bars: this.properties?.total_bars ?? base?.total_bars ?? 'global',
            play_mode: this.properties?.play_mode ?? base?.play_mode ?? 'gate',
            release: Number(this.properties?.release ?? base?.release ?? 0),
            fade_ms: Number(this.properties?.fade_ms ?? base?.fade_ms ?? 0),
            seed: this.properties?.seed ?? base?.seed ?? 42,
            field_operators: this.properties?.field_operators && typeof this.properties.field_operators === 'object'
                ? { ...this.properties.field_operators }
                : (base?.field_operators ? { ...base.field_operators } : {}),
        };
    }

    private getSlotPropertyValue(slot: NodeSlot | undefined, key: string): any {
        if (!slot) return undefined;
        if (key === 'node_name' || key === 'sequence_name') {
            return String(slot.sequence_name ?? '');
        }
        if (key === 'pool_query') {
            return String(slot.pool_query ?? '');
        }
        if (key === 'filepath') {
            return String(slot.filepath ?? '');
        }
        const fieldDef = SequenceNode.fields.find(f => f.key === key);
        return slot[key] !== undefined ? slot[key] : fieldDef?.default;
    }

    public applyPropertyToSelectedSlots(key: string, value: any): void {
        const slots = this.getSlots();
        const selected = this.getSelectedSlotIndices();
        for (const idx of selected) {
            const slot = slots[idx];
            if (!slot) continue;
            if (key === 'sequence' && Array.isArray(value)) {
                slot.sequence = [...value];
            } else if (key === 'step_parameters' && Array.isArray(value)) {
                slot.step_parameters = value.map((s: any) => ({ ...(s || {}) }));
            } else if (key === 'node_name' || key === 'sequence_name') {
                slot.sequence_name = String(value ?? '');
            } else {
                slot[key] = value;
            }
        }
    }

    override hasMixedSlotValues(key: string): boolean {
        const selected = this.getSelectedSlotIndices();
        if (selected.length <= 1) return false;
        const slots = this.getSlots();
        const firstVal = this.getSlotPropertyValue(slots[selected[0]], key);
        const firstSerialized = typeof firstVal === 'object' && firstVal !== null ? JSON.stringify(firstVal) : String(firstVal ?? '');
        for (let i = 1; i < selected.length; i++) {
            const otherVal = this.getSlotPropertyValue(slots[selected[i]], key);
            const otherSerialized = typeof otherVal === 'object' && otherVal !== null ? JSON.stringify(otherVal) : String(otherVal ?? '');
            if (firstSerialized !== otherSerialized) {
                return true;
            }
        }
        return false;
    }

    override get acceptedPoolAssetType(): 'audio' | 'sequence_source' {
        return 'sequence_source';
    }

    override getGhostBoundFieldOverrides(): Record<string, string[]> {
        return {
            'probability': ['step_parameters'],
            'sample start': ['step_parameters']
        };
    }

    public getSlots(): NodeSlot[] {
        if (!this.properties) this.properties = {};
        if (!Array.isArray(this.properties.slots) || this.properties.slots.length === 0) {
            this.properties.slots = [this.buildSlotSnapshotFromProperties(0)];
        }
        return this.properties.slots;
    }

    public syncActiveSlotFromProperties(): void {
        const slots = this.getSlots();
        const idx = Math.min(Math.max(0, this.activeSlotIndex), slots.length - 1);
        this.activeSlotIndex = idx;
        this.properties.active_slot = idx;
        slots[idx] = this.buildSlotSnapshotFromProperties(idx, slots[idx]);
    }

    public applySlotToProperties(slot: NodeSlot): void {
        if (!slot || !this.properties) return;
        this.properties.pool_query = slot.pool_query !== undefined ? String(slot.pool_query) : '';
        if (slot.filepath !== undefined) {
            this.properties.filepath = String(slot.filepath);
        }
        if (slot.library_item_id !== undefined) {
            this.properties.library_item_id = slot.library_item_id;
        }
        if (slot.sequence_name !== undefined) {
            this.properties.sequence_name = String(slot.sequence_name);
        }
        if (Array.isArray(slot.sequence)) {
            this.properties.sequence = [...slot.sequence];
        }
        if (Array.isArray(slot.step_parameters)) {
            this.properties.step_parameters = slot.step_parameters.map((s: any) => ({ ...(s || {}) }));
        }
        if (slot.sample_slot !== undefined) {
            this.properties.sample_slot = String(slot.sample_slot);
        }
        if (slot.step_length !== undefined) {
            this.properties.step_length = Number(slot.step_length);
        }
        if (slot.target_bpm !== undefined) {
            this.properties.target_bpm = slot.target_bpm;
        }
        if (slot.total_bars !== undefined) {
            this.properties.total_bars = slot.total_bars;
        }
        if (slot.play_mode !== undefined) {
            this.properties.play_mode = slot.play_mode;
        }
        if (slot.release !== undefined) {
            this.properties.release = Number(slot.release);
        }
        if (slot.fade_ms !== undefined) {
            this.properties.fade_ms = Number(slot.fade_ms);
        }
        if (slot.seed !== undefined) {
            this.properties.seed = slot.seed;
        }
        this.properties.field_operators = slot.field_operators && typeof slot.field_operators === 'object'
            ? { ...slot.field_operators }
            : {};
        delete (this as any).manifestStemBuffer;
        (this as any)._lastRenderedBuffer = null;
        this._cachedCompositedBuffer = null;
        this.resetPropertySnapshots();
        const trackData = (typeof window !== 'undefined') ? (window as any).trackNodes?.get?.(this.id) : null;
        if (trackData) {
            trackData.sequence = Array.isArray(this.properties.sequence) ? [...this.properties.sequence] : [];
            trackData.step_parameters = Array.isArray(this.properties.step_parameters)
                ? this.properties.step_parameters.map((s: any) => ({ ...(s || {}) }))
                : [];
            trackData.step_length = this.properties.step_length;
            trackData.sample_slot = this.properties.sample_slot;
            trackData.active_slot = this.activeSlotIndex;
        }
        this.setDirtyCanvas(true, true);
    }

    public copySlot(index?: number): NodeSlot | null {
        this.syncActiveSlotFromProperties();
        const slots = this.getSlots();
        const targetIdx = Math.min(Math.max(0, index ?? this.activeSlotIndex), slots.length - 1);
        const slot = slots[targetIdx];
        if (!slot) return null;
        return copyNodeSlotToClipboard('sequence', slot);
    }

    public pasteSlot(index?: number, customSlot?: NodeSlot): boolean {
        this.syncActiveSlotFromProperties();
        const sourceSlot = customSlot
            ? JSON.parse(JSON.stringify(customSlot))
            : getCopiedNodeSlotFromClipboard('sequence')?.slot;
        if (!sourceSlot) return false;
        const slots = this.getSlots();
        const targets = index !== undefined
            ? [Math.min(Math.max(0, index), slots.length - 1)]
            : this.getSelectedSlotIndices();
        for (const targetIdx of targets) {
            slots[targetIdx] = {
                ...JSON.parse(JSON.stringify(sourceSlot)),
                slot: targetIdx,
                index: targetIdx,
                sequence: Array.isArray(sourceSlot.sequence) ? [...sourceSlot.sequence] : [],
                step_parameters: Array.isArray(sourceSlot.step_parameters)
                    ? sourceSlot.step_parameters.map((s: any) => ({ ...(s || {}) }))
                    : []
            };
        }
        if (targets.includes(this.activeSlotIndex)) {
            this.applySlotToProperties(slots[this.activeSlotIndex]);
        }
        if (typeof window !== 'undefined' && this.id != null) {
            window.dispatchEvent(new CustomEvent('node-property-changed', {
                detail: { nodeId: this.id, key: 'slots', value: slots.map(s => ({ ...s })) }
            }));
            window.dispatchEvent(new CustomEvent('node-properties-refreshed', {
                detail: { nodeId: this.id }
            }));
        }
        return true;
    }

    override setFieldOperator(key: string, expr: string): void {
        super.setFieldOperator(key, expr);
        const slots = this.getSlots();
        const selected = this.getSelectedSlotIndices();
        const trimmed = String(expr ?? '').trim();
        const isOp = isFieldOperatorExpression(trimmed);
        for (const idx of selected) {
            const slot = slots[idx];
            if (!slot) continue;
            if (!slot.field_operators || typeof slot.field_operators !== 'object') {
                slot.field_operators = {};
            }
            if (isOp) {
                slot.field_operators[key] = trimmed;
            } else {
                delete slot.field_operators[key];
            }
        }
    }

    override evaluateAllFieldOperators(triggerOverride?: number): void {
        const triggerCount = triggerOverride !== undefined ? triggerOverride : this.getTriggerCount();
        const slots = this.getSlots();
        for (let idx = 0; idx < slots.length; idx++) {
            const slot = slots[idx];
            if (!slot) continue;
            const ops = slot.field_operators || (idx === this.activeSlotIndex ? this.properties?.field_operators : undefined);
            if (ops && typeof ops === 'object') {
                for (const [key, expr] of Object.entries(ops)) {
                    if (key === 'sample_slot' || key === 'pool_query' || key === 'seed') continue;
                    if (typeof expr === 'string' && isFieldOperatorExpression(expr)) {
                        const resolved = this.evaluateFieldOperatorForKey(key, expr, undefined, triggerCount);
                        slot[key] = resolved;
                        if (idx === this.activeSlotIndex && this.properties) {
                            this.properties[key] = resolved;
                        }
                    }
                }
            }
        }
        const activeQuery = String(slots[this.activeSlotIndex]?.pool_query ?? this.properties?.pool_query ?? '').trim();
        if (isFieldOperatorExpression(activeQuery)) {
            void this.applyPoolQuery(activeQuery, false);
        } else if (slots[this.activeSlotIndex]) {
            this.applySlotToProperties(slots[this.activeSlotIndex]);
        }
    }

    private ensureItemsInPool(items: any[]): void {
        if (!Array.isArray(items) || items.length === 0) return;
        if (!this.properties) this.properties = {};
        let modNode = this.getAttachedPoolNode();
        if (!modNode && typeof window !== 'undefined' && this.id != null) {
            window.dispatchEvent(new CustomEvent('add-asset-filter-to-param', {
                detail: { nodeId: this.id, silent: true }
            }));
            modNode = this.getAttachedPoolNode();
        }
        const targetContainer = modNode?.properties || this.properties;
        const existing: any[] = Array.isArray(targetContainer.selected_items)
            ? [...targetContainer.selected_items]
            : [];
        const byKey = new Map<string, any>();
        for (const it of existing) {
            const k = String(it?.id ?? it?.filepath ?? it?.absolute_path ?? '');
            if (k) byKey.set(k, it);
        }
        for (const it of items) {
            const fp = String(it?.filepath || it?.absolute_path || '');
            const poolItem = {
                id: it?.id ?? fp,
                filepath: fp,
                absolute_path: fp,
                name: it?.name || fp.split(/[\\/]/).pop() || 'Sequence',
                type: it?.itemType || it?.type || 'sequence',
                bpm: it?.bpm ?? null,
                key: it?.key ?? null,
                duration_seconds: it?.duration_seconds ?? null,
                ...(Array.isArray(it?.sequence) ? { sequence: [...it.sequence] } : {}),
                ...(Array.isArray(it?.step_parameters)
                    ? { step_parameters: it.step_parameters.map((s: any) => ({ ...(s || {}) })) }
                    : {}),
            };
            const k = String(poolItem.id || poolItem.filepath);
            if (k) byKey.set(k, poolItem);
        }
        const merged = [...byKey.values()];
        targetContainer.selected_items = merged;
        if (this.properties !== targetContainer) {
            this.properties.selected_items = merged;
        }
    }

    public async createSlotsFromDroppedItems(items: any[], startSlotIndex?: number): Promise<void> {
        if (!Array.isArray(items) || items.length === 0) return;
        this.syncActiveSlotFromProperties();
        const slots = this.getSlots();
        const isSingleEmptySlot = slots.length === 1 && !slots[0]?.filepath;
        const baseIdx = startSlotIndex !== undefined
            ? Math.max(0, startSlotIndex)
            : (isSingleEmptySlot ? 0 : slots.length);

        const targetIndices: number[] = [];
        for (let i = 0; i < items.length; i++) {
            targetIndices.push(baseIdx + i);
        }

        const applySequence = typeof window !== 'undefined' ? (window as any).applyLibraryItemToSequence : undefined;
        for (let i = 0; i < targetIndices.length; i++) {
            const slotIdx = targetIndices[i];
            const item = items[i];
            while (slots.length <= slotIdx) {
                const template = slots[slots.length - 1] || slots[0] || {};
                const nextIdx = slots.length;
                slots.push({
                    ...template,
                    slot: nextIdx,
                    index: nextIdx,
                    sequence: Array.isArray(template.sequence) ? [...template.sequence] : [],
                    step_parameters: Array.isArray(template.step_parameters)
                        ? template.step_parameters.map((s: any) => ({ ...(s || {}) }))
                        : []
                });
            }
            const filepath = String(item.filepath || item.absolute_path || '');
            const seqName = item.name || filepath.split(/[\\/]/).pop() || 'Sequence';
            this.activeSlotIndex = slotIdx;
            this.selectedSlotIndices = [slotIdx];
            slots[slotIdx] = {
                ...(slots[slotIdx] || {}),
                slot: slotIdx,
                index: slotIdx,
                pool_query: '',
                filepath,
                library_item_id: item.id ?? slots[slotIdx]?.library_item_id,
                sequence_name: seqName,
                ...(Array.isArray(item.sequence) ? { sequence: [...item.sequence] } : {}),
                ...(Array.isArray(item.step_parameters)
                    ? { step_parameters: item.step_parameters.map((s: any) => ({ ...(s || {}) })) }
                    : {}),
            };
            this.applySlotToProperties(slots[slotIdx]);
            if (typeof applySequence === 'function') {
                await applySequence(this, {
                    id: item.id,
                    filepath,
                    itemType: item.itemType || item.type || (filepath.toLowerCase().endsWith('.seq') ? 'sequence' : 'midi'),
                    name: seqName,
                    bpm: item.bpm ?? null,
                    key: item.key ?? null
                });
                this.properties.pool_query = '';
                this.syncActiveSlotFromProperties();
            }
        }

        this.activeSlotIndex = baseIdx;
        this.selectedSlotIndices = targetIndices;
        this.properties.active_slot = this.activeSlotIndex;
        this.applySlotToProperties(slots[this.activeSlotIndex]);
    }

    public async loadDroppedItemsIntoSlots(
        items: any[],
        target?: number | 'plus' | { slotIndex?: number; createSlots?: boolean }
    ): Promise<void> {
        if (!Array.isArray(items) || items.length === 0) return;
        if (target === 'plus' || (typeof target === 'object' && target?.createSlots)) {
            const startIdx = typeof target === 'object' ? target.slotIndex : undefined;
            await this.createSlotsFromDroppedItems(items, startIdx);
            return;
        }

        const startSlotIndex = typeof target === 'number' ? target : target?.slotIndex;

        // Multiple items dropped onto a slot pill, grid, or title field -> write a cycling text list operator
        if (items.length > 1) {
            this.syncActiveSlotFromProperties();
            this.ensureItemsInPool(items);
            if (!this.properties) this.properties = {};
            this.properties.trigger_count = 0;
            if (startSlotIndex !== undefined) {
                this.selectSlot(startSlotIndex);
            }
            const listExpr = formatPoolListExpression(items);
            await this.applyPoolQuery(listExpr, false);
            return;
        }

        this.syncActiveSlotFromProperties();
        const slots = this.getSlots();
        const baseIdx = startSlotIndex !== undefined
            ? Math.max(0, startSlotIndex)
            : Math.min(Math.max(0, this.activeSlotIndex), slots.length - 1);

        const targetIndices: number[] = startSlotIndex === undefined && this.getSelectedSlotIndices().length > 1
            ? [...this.getSelectedSlotIndices()]
            : [baseIdx];

        const applySequence = typeof window !== 'undefined' ? (window as any).applyLibraryItemToSequence : undefined;
        const item = items[0];

        for (const slotIdx of targetIndices) {
            while (slots.length <= slotIdx) {
                const template = slots[slots.length - 1] || slots[0] || {};
                const nextIdx = slots.length;
                slots.push({
                    ...template,
                    slot: nextIdx,
                    index: nextIdx,
                    sequence: Array.isArray(template.sequence) ? [...template.sequence] : [],
                    step_parameters: Array.isArray(template.step_parameters)
                        ? template.step_parameters.map((s: any) => ({ ...(s || {}) }))
                        : []
                });
            }
            const filepath = String(item.filepath || item.absolute_path || '');
            const seqName = item.name || filepath.split(/[\\/]/).pop() || 'Sequence';
            this.activeSlotIndex = slotIdx;
            this.selectedSlotIndices = [slotIdx];
            slots[slotIdx] = {
                ...(slots[slotIdx] || {}),
                slot: slotIdx,
                index: slotIdx,
                pool_query: '',
                filepath,
                library_item_id: item.id ?? slots[slotIdx]?.library_item_id,
                sequence_name: seqName,
                ...(Array.isArray(item.sequence) ? { sequence: [...item.sequence] } : {}),
                ...(Array.isArray(item.step_parameters)
                    ? { step_parameters: item.step_parameters.map((s: any) => ({ ...(s || {}) })) }
                    : {}),
            };
            this.applySlotToProperties(slots[slotIdx]);
            if (typeof applySequence === 'function') {
                await applySequence(this, {
                    id: item.id,
                    filepath,
                    itemType: item.itemType || item.type || (filepath.toLowerCase().endsWith('.seq') ? 'sequence' : 'midi'),
                    name: seqName,
                    bpm: item.bpm ?? null,
                    key: item.key ?? null
                });
                this.properties.pool_query = '';
                this.syncActiveSlotFromProperties();
            }
        }

        this.activeSlotIndex = baseIdx;
        this.selectedSlotIndices = startSlotIndex !== undefined ? [baseIdx] : this.getSelectedSlotIndices();
        this.properties.active_slot = this.activeSlotIndex;
        this.applySlotToProperties(slots[this.activeSlotIndex]);
    }

    public async applyPoolQuery(rawQuery: string, advanceSaltOnRand: boolean = true): Promise<boolean> {
        const query = String(rawQuery ?? '').trim();
        this.updateProperty('pool_query', query);
        const modNode = this.getAttachedPoolNode();
        const rawItems = Array.isArray(modNode?.properties?.selected_items)
            ? modNode.properties.selected_items
            : (Array.isArray(this.properties?.selected_items) ? this.properties.selected_items : []);
        const items = rawItems.filter((item: any) => Boolean(item?.absolute_path || item?.filepath));
        if (items.length === 0) return false;

        const slots = this.getSlots();
        const targets = this.getSelectedSlotIndices();
        const triggerCount = this.getTriggerCount();

        if (advanceSaltOnRand && (query.toLowerCase() === 'rand' || query.toLowerCase() === 'random')) {
            if (modNode?.properties) {
                modNode.properties.seed_salt = (Number(modNode.properties.seed_salt) || 0) + 1;
            } else if (this.properties) {
                this.properties.seed_salt = (Number(this.properties.seed_salt) || 0) + 1;
            }
        }
        const seedSalt = Number(modNode?.properties?.seed_salt || this.properties?.seed_salt || 0) * 9973;
        const slotSeeds = resolveModifierSlotSeeds(
            modNode?.properties?.seed ?? this.properties?.seed ?? 42,
            slots.length,
            Number(this.id || modNode?.id || 1) + seedSalt
        );
        const isSequential = modNode?.properties?.playbackMode === 'Sequential';
        const applySequence = typeof window !== 'undefined' ? (window as any).applyLibraryItemToSequence : undefined;

        const savedActive = this.activeSlotIndex;
        const savedSelected = [...targets];
        let anyMatched = false;

        for (const idx of targets) {
            slots[idx] = {
                ...(slots[idx] || {}),
                pool_query: query
            };
            const chosen = resolvePoolItemByQuery(
                items,
                query,
                idx,
                isSequential ? slotSeeds[0] : slotSeeds[idx],
                isSequential,
                triggerCount
            );
            if (!chosen) continue;
            anyMatched = true;
            const filepath = String(chosen.absolute_path || chosen.filepath || '');
            const seqName = chosen.name || filepath.split(/[\\/]/).pop() || slots[idx]?.sequence_name || 'Sequence';
            slots[idx] = {
                ...(slots[idx] || {}),
                slot: idx,
                index: idx,
                pool_query: query,
                filepath,
                library_item_id: chosen.id,
                sequence_name: seqName,
                ...(Array.isArray(chosen.sequence) ? { sequence: [...chosen.sequence] } : {}),
                ...(Array.isArray(chosen.step_parameters)
                    ? { step_parameters: chosen.step_parameters.map((s: any) => ({ ...(s || {}) })) }
                    : {}),
            };
            if (typeof applySequence === 'function') {
                this.activeSlotIndex = idx;
                this.selectedSlotIndices = [idx];
                await applySequence(this, {
                    id: chosen.id,
                    filepath,
                    itemType: chosen.type || (filepath.toLowerCase().endsWith('.seq') ? 'sequence' : 'midi'),
                    name: seqName,
                    bpm: chosen.bpm ?? null,
                    key: chosen.key ?? null
                });
                this.properties.pool_query = query;
                this.syncActiveSlotFromProperties();
            }
        }

        this.activeSlotIndex = savedActive;
        this.selectedSlotIndices = savedSelected;
        this.properties.active_slot = savedActive;
        if (!anyMatched) return false;
        const activeSlot = slots[savedActive] || slots[0];
        this.applySlotToProperties(activeSlot);
        if (modNode?.properties) {
            modNode.properties.output_value = activeSlot.filepath;
            if (activeSlot.library_item_id != null) modNode.properties.output_item_id = activeSlot.library_item_id;
        }
        return true;
    }

    public selectSlot(index: number, options?: { toggle?: boolean; range?: boolean }): void {
        this.syncActiveSlotFromProperties();
        const slots = this.getSlots();
        const nextIdx = Math.min(Math.max(0, index), slots.length - 1);

        if (options?.range) {
            const start = Math.min(this.activeSlotIndex, nextIdx);
            const end = Math.max(this.activeSlotIndex, nextIdx);
            this.selectedSlotIndices = Array.from({ length: end - start + 1 }, (_, i) => start + i);
            this.activeSlotIndex = nextIdx;
        } else if (options?.toggle) {
            const set = new Set(this.getSelectedSlotIndices());
            if (set.has(nextIdx)) {
                if (set.size > 1) set.delete(nextIdx);
                if (this.activeSlotIndex === nextIdx) {
                    const remaining = [...set];
                    this.activeSlotIndex = remaining[remaining.length - 1] ?? 0;
                }
            } else {
                set.add(nextIdx);
                this.activeSlotIndex = nextIdx;
            }
            this.selectedSlotIndices = [...set].sort((a, b) => a - b);
        } else {
            this.activeSlotIndex = nextIdx;
            this.selectedSlotIndices = [nextIdx];
        }

        this._liveTriggerIteration = null;
        this._liveTriggeredSequenceName = null;
        this._liveTriggeredSequence = null;
        this.applySlotToProperties(slots[this.activeSlotIndex]);
        this.updateProperty('active_slot', this.activeSlotIndex);
    }

    public addSlot(): number {
        this.syncActiveSlotFromProperties();
        const slots = this.getSlots();
        const current = slots[this.activeSlotIndex] || slots[0];
        const newIdx = slots.length;
        slots.push({
            ...(current || {}),
            slot: newIdx,
            index: newIdx,
            sequence: Array.isArray(current?.sequence) ? [...current.sequence] : [],
            step_parameters: Array.isArray(current?.step_parameters)
                ? current.step_parameters.map((s: any) => ({ ...(s || {}) }))
                : []
        });

        const modNode = this.getAttachedPoolNode();
        if (modNode) {
            populateOwnerSlotsFromPool(modNode, this);
        }

        // If any RandomNode modifier is attached to this sequence, immediately populate seed-dependent slot values
        const graph = this.graph || (typeof window !== 'undefined' ? (window as any).editorGraph : null);
        const allNodes = ((graph as any)?._nodes || (graph as any)?.nodes || []) as any[];
        for (const candidate of allNodes) {
            const isRandom = candidate?.type === 'Audio/Random'
                || candidate?.properties?.node_type === 'random'
                || (candidate?.isModifier && candidate?.modifierKind === 'random');
            if (isRandom && candidate?.properties?.parentId === this.id) {
                populateOwnerSlotsFromRandom(candidate, this);
            }
        }

        this.activeSlotIndex = newIdx;
        this.selectedSlotIndices = [newIdx];
        this.applySlotToProperties(slots[newIdx]);
        this.updateProperty('active_slot', newIdx);
        return newIdx;
    }

    public removeSlot(index?: number): void {
        const slots = this.getSlots();
        if (slots.length <= 1) return;
        const selected = this.getSelectedSlotIndices();
        const targetIdx = index !== undefined ? Math.min(Math.max(0, index), slots.length - 1) : this.activeSlotIndex;
        const indicesToRemove = (selected.length > 1 && selected.includes(targetIdx))
            ? [...selected].sort((a, b) => b - a)
            : [targetIdx];

        for (const rmIdx of indicesToRemove) {
            if (slots.length <= 1) break;
            slots.splice(rmIdx, 1);
        }
        slots.forEach((s, idx) => {
            s.slot = idx;
            s.index = idx;
        });
        this.activeSlotIndex = Math.min(this.activeSlotIndex, slots.length - 1);
        this.selectedSlotIndices = [this.activeSlotIndex];
        this.applySlotToProperties(slots[this.activeSlotIndex]);
        this.updateProperty('active_slot', this.activeSlotIndex);
        if (typeof window !== 'undefined' && this.id != null) {
            window.dispatchEvent(new CustomEvent('node-property-changed', {
                detail: { nodeId: this.id, key: 'slots', value: slots.map(s => ({ ...s })) }
            }));
        }
    }

    protected override onBeforePropertyChanged(key: string): void {
        if ((SequenceNode.slotPropertyKeys as readonly string[]).includes(key)) {
            this.syncActiveSlotFromProperties();
        }
    }

    override updateProperty(key: string, value: any): void {
        super.updateProperty(key, value);
        if ((SequenceNode.slotPropertyKeys as readonly string[]).includes(key)) {
            this.syncActiveSlotFromProperties();
            this.applyPropertyToSelectedSlots(key, value);
        }
    }

    override onConfigure(data: any): void {
        super.onConfigure?.(data);
        if (this.properties && Array.isArray(this.properties.slots)) {
            this.properties.slots = this.properties.slots.map((s: any, idx: number) => ({
                ...(s || {}),
                slot: idx,
                index: idx,
                sequence: Array.isArray(s?.sequence) ? [...s.sequence] : [],
                step_parameters: Array.isArray(s?.step_parameters)
                    ? s.step_parameters.map((p: any) => ({ ...(p || {}) }))
                    : []
            }));
        }
        const slots = this.getSlots();
        const savedActive = Number(this.properties?.active_slot ?? 0);
        const idx = Number.isFinite(savedActive)
            ? Math.min(Math.max(0, Math.trunc(savedActive)), Math.max(0, slots.length - 1))
            : 0;
        this.activeSlotIndex = idx;
        this.selectedSlotIndices = [idx];
        this.properties.active_slot = idx;
        if (slots[idx]) {
            this.applySlotToProperties(slots[idx]);
        }
    }

    override prepareSerializedModel(model: any): any {
        this.syncActiveSlotFromProperties();
        return {
            ...model,
            active_slot: this.activeSlotIndex,
            sample_slot: String(this.properties?.sample_slot ?? '*')
        };
    }

    constructor() {
        super();
        this.title = "Sequence";
        this.size = this.computeSize();

        // Vibrant Pink / Magenta theme for Sequence loop generator
        this.color = "#ec4899";
        this.bgcolor = "#ec4899";
        this.boxcolor = "#db2777";

        this.properties = {
            ...this.properties,
            node_name: "Sequence",
            node_type: "sequence",
            active_slot: 0,
            sample_slot: "*",
            target_bpm: "global",
            bpm: "global",
            total_bars: "global",
            length_inherited: true,
            sequence: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
            step_parameters: Array.from({ length: SequenceNode.stepCount }, () => ({
                sample_start: 0.0,
                gate_length: 1.0,
                offset: 0.0,
                velocity: 1.0,
                probability: 1.0,
                subdivision_enabled: false,
                subdivisions: 1
            })),
            step_length: 0.25,
            play_mode: "gate",
            release: 0,
            fade_ms: 0,
            selected_step: 0,
            seed: 42,
            seed_refresh: true,
            color: "#ec4899",
            icon: "sequence"
        };

        this.addInput("Input", "audio");
        this.addOutput("Audio", "audio");
    }

    public getUpstreamSlotCount(): number {
        const inputNodes = this.getInputNodes();
        for (const inputNode of inputNodes) {
            if (typeof (inputNode as any)?.getSlots === 'function') {
                return Math.max(1, (inputNode as any).getSlots().length);
            }
            if (Array.isArray(inputNode?.properties?.slots) && inputNode.properties.slots.length > 0) {
                return inputNode.properties.slots.length;
            }
        }
        return 1;
    }

    public getUpstreamActiveSlot(): number {
        const inputNodes = this.getInputNodes();
        for (const inputNode of inputNodes) {
            const active = (inputNode as any)?.activeSlotIndex ?? inputNode?.properties?.active_slot;
            if (active !== undefined && Number.isFinite(Number(active))) {
                return Math.max(0, Math.trunc(Number(active)));
            }
        }
        return 0;
    }

    public _liveTriggeredSequenceName: string | null = null;
    public _liveTriggeredSequence: number[] | null = null;

    public getResolvedStepSlots(stepCount = SequenceNode.stepCount): number[] {
        const sampleSlotExpr = this.getFieldOperator('sample_slot') || String(this.properties?.sample_slot ?? '*');
        if (isFieldOperatorExpression(sampleSlotExpr)) {
            const cycleSlot = Number(this.evaluateFieldOperatorForKey('sample_slot', sampleSlotExpr));
            return Array(stepCount).fill(Number.isFinite(cycleSlot) ? cycleSlot : 0);
        }
        const upstreamCount = this.getUpstreamSlotCount();
        const upstreamActive = this.getUpstreamActiveSlot();
        const seedSalt = Number(this.properties?.seed_salt || 0) * 9973;
        const cycleSeeds = resolveCycleSeeds(this.properties?.seed ?? 42, 1, (this.id || 1) + seedSalt);
        return resolveStepSlots(
            sampleSlotExpr,
            stepCount,
            upstreamCount,
            cycleSeeds[0] ?? 42,
            upstreamActive
        );
    }

    protected override drawDedicatedVisualization(ctx: CanvasRenderingContext2D, bounds: RenderBox, telemetry?: SignalTelemetry): void {
        const win = (typeof window !== 'undefined') ? (window as any) : undefined;
        const isPlaying = Boolean(telemetry?.isPlaying);
        const slots = this.getSlots();
        const slotCount = Math.max(1, slots.length);
        let irideActiveSlot = this.activeSlotIndex;
        let irideCycleSeq: number[] | null = null;
        let irideStepSlotOverride: number | null = null;

        if (!isPlaying && (this._liveTriggerIteration !== null || this._liveTriggeredSequenceName !== null || this._liveTriggeredSequence !== null)) {
            this._liveTriggerIteration = null;
            this._liveTriggeredSequenceName = null;
            this._liveTriggeredSequence = null;
            if (typeof window !== 'undefined' && this.id != null) {
                window.dispatchEvent(new CustomEvent('node-properties-refreshed', {
                    detail: { nodeId: this.id, liveTelemetry: true }
                }));
            }
        }

        if (isPlaying && telemetry) {
            const manifestEvents = ((this as any).manifestEvents as Array<{ time: number; duration: number; slot?: number; iteration?: number; sequence_name?: string; sequence?: number[]; sample_slot_resolved?: number }> | undefined)
                || (win?.activeWorkspaceManifest?.nodes?.[String(this.id)]?.events as Array<{ time: number; duration: number; slot?: number; iteration?: number; sequence_name?: string; sequence?: number[]; sample_slot_resolved?: number }> | undefined);
            const totalTrackDur = telemetry.duration > 0
                ? telemetry.duration
                : Number(win?.activeWorkspaceManifest?.total_duration || 0);
            const curTime = totalTrackDur > 0 ? ((telemetry.time % totalTrackDur) + totalTrackDur) % totalTrackDur : telemetry.time;
            let activeCycleEvt = manifestEvents?.find(e => curTime >= e.time && curTime < (e.time + Math.max(0.02, e.duration)));
            if (!activeCycleEvt && manifestEvents && manifestEvents.length > 0) {
                for (let i = manifestEvents.length - 1; i >= 0; i--) {
                    if (manifestEvents[i].time <= curTime) {
                        activeCycleEvt = manifestEvents[i];
                        break;
                    }
                }
            }

            // 1. IRIDE canvas reactivity: follow the currently playing cycle event across all slots
            if (activeCycleEvt) {
                if (typeof activeCycleEvt.slot === 'number') {
                    irideActiveSlot = ((Math.trunc(activeCycleEvt.slot) % slotCount) + slotCount) % slotCount;
                }
                if (Array.isArray(activeCycleEvt.sequence)) {
                    irideCycleSeq = activeCycleEvt.sequence;
                }
                if (typeof activeCycleEvt.sample_slot_resolved === 'number' && Number.isFinite(activeCycleEvt.sample_slot_resolved)) {
                    irideStepSlotOverride = activeCycleEvt.sample_slot_resolved;
                }
            }

            // 2. Inspector live telemetry: NEVER switch slots; only update when the active slot itself has a Field Operator
            const inspectorSlot = Math.min(Math.max(0, this.activeSlotIndex), slotCount - 1);
            const activeSlotQuery = String(slots[inspectorSlot]?.pool_query ?? this.properties?.pool_query ?? '').trim();
            const hasActiveSlotPoolOp = isFieldOperatorExpression(activeSlotQuery);
            const sampleSlotExpr = this.getFieldOperator('sample_slot') || String(this.properties?.sample_slot ?? '*');
            const hasSampleSlotOp = isFieldOperatorExpression(sampleSlotExpr);
            const activeSlotOps = slots[inspectorSlot]?.field_operators || this.properties?.field_operators;
            const hasActiveSlotFieldOp = hasActiveSlotPoolOp || hasSampleSlotOp || Boolean(activeSlotOps && Object.keys(activeSlotOps).length > 0);

            if (hasActiveSlotFieldOp) {
                const matchesInspectorSlot = (e: any): boolean => {
                    if (typeof e?.slot !== 'number') return true;
                    const s = ((Math.trunc(e.slot) % slotCount) + slotCount) % slotCount;
                    return s === inspectorSlot;
                };
                let inspectorCycleEvt = (activeCycleEvt && matchesInspectorSlot(activeCycleEvt)) ? activeCycleEvt : undefined;
                if (!inspectorCycleEvt && manifestEvents && manifestEvents.length > 0) {
                    for (let i = manifestEvents.length - 1; i >= 0; i--) {
                        if (manifestEvents[i].time <= curTime && matchesInspectorSlot(manifestEvents[i])) {
                            inspectorCycleEvt = manifestEvents[i];
                            break;
                        }
                    }
                }
                if (inspectorCycleEvt && typeof inspectorCycleEvt.iteration === 'number') {
                    const nextIter = inspectorCycleEvt.iteration;
                    const nextName = hasActiveSlotPoolOp ? (inspectorCycleEvt.sequence_name || null) : null;
                    this._liveTriggeredSequence = (hasActiveSlotPoolOp && Array.isArray(inspectorCycleEvt.sequence))
                        ? inspectorCycleEvt.sequence
                        : null;
                    if (this._liveTriggerIteration !== nextIter || this._liveTriggeredSequenceName !== nextName) {
                        this._liveTriggerIteration = nextIter;
                        this._liveTriggeredSequenceName = nextName;
                        if (typeof window !== 'undefined' && this.id != null) {
                            window.dispatchEvent(new CustomEvent('node-properties-refreshed', {
                                detail: { nodeId: this.id, liveTelemetry: true }
                            }));
                        }
                    }
                } else if (!manifestEvents || manifestEvents.length === 0) {
                    const stepLen = Number(this.properties?.step_length) || 0.25;
                    const patternBeats = Math.max(0.25, SequenceNode.stepCount * stepLen);
                    const totalBars = Number(this.properties?.total_bars) || 4;
                    const totalBeats = totalBars * 4;
                    const wrappedBeat = totalBeats > 0 ? ((telemetry.beat % totalBeats) + totalBeats) % totalBeats : telemetry.beat;
                    const cycleIdx = Math.max(0, Math.floor(wrappedBeat / patternBeats));
                    if (this._liveTriggerIteration !== cycleIdx) {
                        this._liveTriggerIteration = cycleIdx;
                        if (typeof window !== 'undefined' && this.id != null) {
                            window.dispatchEvent(new CustomEvent('node-properties-refreshed', {
                                detail: { nodeId: this.id, liveTelemetry: true }
                            }));
                        }
                    }
                }
            } else if (this._liveTriggerIteration !== null || this._liveTriggeredSequenceName !== null || this._liveTriggeredSequence !== null) {
                this._liveTriggerIteration = null;
                this._liveTriggeredSequenceName = null;
                this._liveTriggeredSequence = null;
            }
        }

        let rawSeq: any[] | null = irideCycleSeq || this._liveTriggeredSequence;
        const activeSlotSeq = slots[irideActiveSlot]?.sequence;
        if (!rawSeq && Array.isArray(activeSlotSeq) && activeSlotSeq.length > 0) {
            rawSeq = activeSlotSeq;
        }
        if (!rawSeq && Array.isArray(this.properties?.sequence) && this.properties.sequence.length > 0) {
            rawSeq = this.properties.sequence;
        }

        if (!rawSeq) {
            const trackData = (window as any).trackNodes?.get?.(this.id);
            if (Array.isArray(trackData?.sequence) && trackData.sequence.length > 0) {
                rawSeq = trackData.sequence;
            }
        }

        if (!rawSeq) {
            const channels = (this.properties as any)?.channels;
            if (Array.isArray(channels) && channels[0] && Array.isArray(channels[0].on) && channels[0].on.length > 0) {
                rawSeq = channels[0].on;
            }
        }

        if (!rawSeq || rawSeq.length === 0) {
            rawSeq = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
            if (this.properties) {
                this.properties.sequence = [...rawSeq];
            }
        }

        const rawParams = Array.isArray(this.properties?.step_parameters) ? this.properties.step_parameters : [];
        const stepCount = SequenceNode.stepCount;
        const stepSlots = irideStepSlotOverride !== null
            ? Array(stepCount).fill(irideStepSlotOverride)
            : this.getResolvedStepSlots(stepCount);
        const steps: SequenceStep[] = [];

        for (let i = 0; i < stepCount; i++) {
            const rawVal = rawSeq[i];
            const isGateOn = typeof rawVal === 'number'
                ? rawVal > 0
                : typeof rawVal === 'string'
                    ? (rawVal === '1' || rawVal === 'true')
                    : typeof rawVal === 'object' && rawVal !== null
                        ? Boolean((rawVal as any).gate ?? (rawVal as any).on)
                        : Boolean(rawVal);

            const param = rawParams[i] || {};
            const velocity = typeof param.velocity === 'number' ? param.velocity : 1.0;
            const subdivisions = Number(param.subdivisions) || 1;
            const rawProb = typeof param.probability === 'number' ? param.probability : 1.0;
            const probability = rawProb > 1.0 ? rawProb / 100 : Math.max(0.0, Math.min(1.0, rawProb));
            const rawStart = typeof param.sample_start === 'number' ? param.sample_start : 0.0;
            const sampleStart = rawStart > 1.0 ? rawStart / 100 : Math.max(0.0, Math.min(1.0, rawStart));
            const rawGate = typeof param.gate_length === 'number' ? param.gate_length : 1.0;
            const gateLength = rawGate > 1.0 ? rawGate / 100 : Math.max(0.0, Math.min(1.0, rawGate));

            steps.push({
                gate: isGateOn,
                velocity,
                subdivisions,
                probability,
                sampleStart,
                gateLength,
                slotIndex: stepSlots[i] ?? 0
            });
        }

        this.sequenceRenderer.setOptions({
            minified: this.isMinifiedStage
        });
        this.sequenceRenderer.setSignal({
            stepCount,
            steps,
            stepLength: Number(this.properties?.step_length) || 0.25,
            accentColor: this.nodeColor || '#ec4899',
            slotCount: slots.length,
            activeSlot: irideActiveSlot
        });

        this.sequenceRenderer.render(ctx, bounds, telemetry);
    }

    override getLiveActivityState(telemetry?: SignalTelemetry): { isTriggered: boolean; progress?: number } {
        if (!telemetry?.isPlaying) return { isTriggered: false };
        const stepCount = SequenceNode.stepCount;
        const stepLength = Number(this.properties?.step_length) || 0.25;
        const currentStep = (((Math.floor(telemetry.beat / stepLength) % stepCount) + stepCount) % stepCount);
        const rawSeq = Array.isArray(this.properties?.sequence) ? this.properties.sequence : [];
        const rawVal = rawSeq[currentStep];
        const isGateOn = typeof rawVal === 'number'
            ? rawVal > 0
            : typeof rawVal === 'string'
                ? (rawVal === '1' || rawVal === 'true')
                : typeof rawVal === 'object' && rawVal !== null
                    ? Boolean((rawVal as any).gate ?? (rawVal as any).on)
                    : Boolean(rawVal);
        return {
            isTriggered: isGateOn,
            progress: (currentStep + 1) / stepCount
        };
    }

    private _cachedCompositedBuffer: AudioBuffer | null = null;
    private _lastSampleBufferRef: AudioBuffer | null = null;
    private _lastSeqFingerprint: string = '';

    public getSlotBuffersMap(visited?: Set<number>): Map<number, AudioBuffer> {
        this.syncActiveSlotFromProperties();
        const slots = this.getSlots();
        if (slots.length <= 1 && (this as any).manifestStemBuffer) {
            return new Map([[0, (this as any).manifestStemBuffer]]);
        }
        const out = new Map<number, AudioBuffer>();
        const cycleSet = visited ? new Set(visited) : new Set<number>();
        if (cycleSet.has(this.id)) return out;
        cycleSet.add(this.id);

        const inputNodes = this.getInputNodes();
        let sampleSlotsMap: Map<number, AudioBuffer> | AudioBuffer | null = null;
        for (const inputNode of inputNodes) {
            if (typeof (inputNode as any)?.getSlotBuffersMap === 'function') {
                const map = (inputNode as any).getSlotBuffersMap(cycleSet);
                if (map && map.size > 0) {
                    sampleSlotsMap = map;
                    break;
                }
            }
            const buf = inputNode?.getAudioBuffer?.(cycleSet) || inputNode?.audioBuffer;
            if (buf) {
                sampleSlotsMap = buf;
                break;
            }
        }
        if (!sampleSlotsMap) return out;

        const getGlobal = (typeof window !== 'undefined') ? (window as any).getGlobalParameter : null;
        const globalBars = typeof getGlobal === 'function' ? Number(getGlobal('total_bars')) : 4;
        const globalBpm = typeof getGlobal === 'function' ? Number(getGlobal('bpm')) : 120;
        const totalBarsSetting = this.properties?.total_bars;
        const totalBars = (totalBarsSetting === 'global' || !Number.isFinite(Number(totalBarsSetting)))
            ? (Number.isFinite(globalBars) && globalBars > 0 ? globalBars : 4)
            : Math.max(0.25, Number(totalBarsSetting));
        const bpm = Number.isFinite(globalBpm) && globalBpm > 0 ? globalBpm : 120;
        const nodeGain = getNodeGainMultiplier(this);
        const upstreamCount = this.getUpstreamSlotCount();
        const upstreamActive = this.getUpstreamActiveSlot();
        const seedSalt = Number(this.properties?.seed_salt || 0) * 9973;
        const cycleSeeds = resolveCycleSeeds(this.properties?.seed ?? 42, 8, (this.id || 1) + seedSalt);

        for (let s = 0; s < slots.length; s++) {
            const slotObj = slots[s];
            const seq = Array.isArray(slotObj?.sequence) ? slotObj.sequence : (Array.isArray(this.properties?.sequence) ? this.properties.sequence : []);
            const params = Array.isArray(slotObj?.step_parameters) ? slotObj.step_parameters : (Array.isArray(this.properties?.step_parameters) ? this.properties.step_parameters : []);
            const stepLen = Number(slotObj?.step_length ?? this.properties?.step_length ?? 0.25);
            const sampleSlotExpr = String(slotObj?.sample_slot ?? this.properties?.sample_slot ?? '*');
            const stepSlots = resolveStepSlots(sampleSlotExpr, seq.length || 16, upstreamCount, cycleSeeds[0] ?? 42, upstreamActive);

            const buf = compositeSequenceBuffer(
                sampleSlotsMap,
                seq,
                params,
                stepLen,
                totalBars,
                bpm,
                nodeGain,
                {
                    stepSlots,
                    cycleSeeds,
                    playMode: String(this.properties?.play_mode || 'gate'),
                    release: Number(this.properties?.release ?? 0),
                    fadeMs: Number(this.properties?.fade_ms ?? 0)
                }
            );
            if (buf) out.set(s, buf);
        }
        return out;
    }

    override getAudioBuffer(visited?: Set<number>): AudioBuffer | null {
        if ((this as any).manifestStemBuffer) return (this as any).manifestStemBuffer;
        if ((this as any)._lastRenderedBuffer) return (this as any)._lastRenderedBuffer;

        const cycleSet = visited || new Set<number>();
        if (cycleSet.has(this.id)) return null;
        cycleSet.add(this.id);

        const inputNodes = this.getInputNodes();
        let inputSampleBuffer: AudioBuffer | null = null;
        let sampleSlotsMap: Map<number, AudioBuffer> | null = null;
        for (const inputNode of inputNodes) {
            if (typeof (inputNode as any)?.getSlotBuffersMap === 'function') {
                const map = (inputNode as any).getSlotBuffersMap(cycleSet);
                if (map && map.size > 0) {
                    sampleSlotsMap = map;
                }
            }
            const buf = inputNode?.getAudioBuffer?.(cycleSet) || inputNode?.audioBuffer;
            if (buf) {
                inputSampleBuffer = buf;
                break;
            }
        }
        if (!inputSampleBuffer && (!sampleSlotsMap || sampleSlotsMap.size === 0)) return null;

        const getGlobal = (typeof window !== 'undefined') ? (window as any).getGlobalParameter : null;
        const globalBars = typeof getGlobal === 'function' ? Number(getGlobal('total_bars')) : 4;
        const globalBpm = typeof getGlobal === 'function' ? Number(getGlobal('bpm')) : 120;

        const totalBarsSetting = this.properties?.total_bars;
        const totalBars = (totalBarsSetting === 'global' || !Number.isFinite(Number(totalBarsSetting)))
            ? (Number.isFinite(globalBars) && globalBars > 0 ? globalBars : 4)
            : Math.max(0.25, Number(totalBarsSetting));

        const bpm = Number.isFinite(globalBpm) && globalBpm > 0 ? globalBpm : 120;
        const stepLength = Number(this.properties?.step_length) || 0.25;
        const seq = Array.isArray(this.properties?.sequence) ? this.properties.sequence : [];
        const params = Array.isArray(this.properties?.step_parameters) ? this.properties.step_parameters : [];
        const stepSlots = this.getResolvedStepSlots(seq.length || 16);
        const seedSalt = Number(this.properties?.seed_salt || 0) * 9973;
        const cycleSeeds = resolveCycleSeeds(this.properties?.seed ?? 42, 8, (this.id || 1) + seedSalt);

        const nodeGain = getNodeGainMultiplier(this);
        const fp = `${this.activeSlotIndex}_${totalBars}_${bpm}_${stepLength}_${seq.join(',')}_${JSON.stringify(params)}_${stepSlots.join(',')}_${cycleSeeds.join(',')}_${nodeGain}`;
        if (this._cachedCompositedBuffer && this._lastSampleBufferRef === inputSampleBuffer && this._lastSeqFingerprint === fp) {
            return this._cachedCompositedBuffer;
        }

        const composited = compositeSequenceBuffer(
            sampleSlotsMap && sampleSlotsMap.size > 0 ? sampleSlotsMap : (inputSampleBuffer as AudioBuffer),
            seq,
            params,
            stepLength,
            totalBars,
            bpm,
            nodeGain,
            {
                stepSlots,
                cycleSeeds,
                playMode: String(this.properties?.play_mode || 'gate'),
                release: Number(this.properties?.release ?? 0),
                fadeMs: Number(this.properties?.fade_ms ?? 0)
            }
        );

        this._cachedCompositedBuffer = composited;
        this._lastSampleBufferRef = inputSampleBuffer;
        this._lastSeqFingerprint = fp;
        return composited;
    }
}

(SequenceNode as any).title = "Sequence";
LiteGraph.registerNodeType("Audio/Sequence", SequenceNode);
