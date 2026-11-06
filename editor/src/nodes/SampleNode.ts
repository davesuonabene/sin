import { LiteGraph } from 'litegraph.js';
import { BaseNode, DEFAULT_SAMPLE_INPUT_GAIN_DB, getDefaultFxChain } from './BaseNode.ts';
import { type FieldSchema } from '../fields/FieldSchema.ts';
import { type NodePanelSchema } from '../fields/NodePanelSchema.ts';
import { findLibraryFileForSnapshot, resolveLibraryAssets, submitLibraryMetadataProposal, type LibraryFile } from '../api.ts';
import { type SignalTelemetry, type WaveformSignal, type VisualizationTypeId } from '../../../packages/iride/src/index.ts';
import { fetchAudioBuffer, getCachedAudioBufferSync } from '../audioBufferCache.ts';
import { getNodeGainMultiplier, applyGainToBuffer } from '../audioCompositor.ts';
import { globalAudioScheduler } from '../audioScheduler.ts';
import {
    type NodeSlot,
    copyNodeSlotToClipboard,
    formatPoolListExpression,
    getCopiedNodeSlotFromClipboard,
    isFieldOperatorExpression,
    resolveModifierSlotSeeds
} from '../../../ermes/ts/slotLanguage.ts';
import { populateOwnerSlotsFromPool, resolvePoolItemByQuery, parseBpmFromFilename } from '../../../ermes/ts/assetResolver.ts';

type MusicalMode = 'major' | 'minor' | null;
type KeyMatchAlgorithm = 'nearest' | 'higher' | 'lower';

interface ParsedKey {
    pitchClass: number;
    mode: MusicalMode;
}

export class SampleNode extends BaseNode {
    static readonly slotPropertyKeys = [
        'filepath',
        'pool_query',
        'library_item_id',
        'duration_seconds',
        'sample_type',
        'start_beat',
        'original_bpm',
        'target_bpm',
        'key',
        'key_match_mode',
        'key_match_algorithm',
        'transpose',
        'cents',
        'stretch_mode',
        'stretch_algorithm',
        'stretch_factor',
        'crop_start',
        'crop_end',
    ] as const;

    public audioBuffer: AudioBuffer | null = null;
    public slotBuffers: Map<number, AudioBuffer> = new Map();
    private slotLoadedPaths: Map<number, string> = new Map();
    public activeSlotIndex = 0;
    public selectedSlotIndices: number[] = [0];
    public loadedFilepath = '';
    public isLoadingAudio = false;
    private loadingAudioPromise: Promise<AudioBuffer | null> | null = null;
    private failedAudioFilepath: string | null = null;

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
        const cropStart = Number(this.properties?.crop_start ?? base?.crop_start ?? base?.sample_start ?? 0);
        const cropEnd = Number(this.properties?.crop_end ?? base?.crop_end ?? base?.sample_end ?? 1);
        const transpose = Number(this.properties?.transpose ?? base?.transpose ?? base?.pitch_shift ?? 0);
        const stretchFactor = Number(this.properties?.stretch_factor ?? base?.stretch_factor ?? base?.time_stretch ?? 1);
        return {
            ...(base || {}),
            slot: slotIndex,
            index: slotIndex,
            pool_query: this.properties?.pool_query !== undefined ? String(this.properties.pool_query) : base?.pool_query,
            filepath: String(this.properties?.filepath ?? base?.filepath ?? ''),
            library_item_id: this.properties?.library_item_id ?? base?.library_item_id,
            duration_seconds: this.properties?.duration_seconds ?? base?.duration_seconds,
            sample_type: this.properties?.sample_type ?? base?.sample_type ?? 'loop',
            start_beat: Number(this.properties?.start_beat ?? base?.start_beat ?? 0),
            original_bpm: this.properties?.original_bpm ?? base?.original_bpm ?? 120,
            target_bpm: this.properties?.target_bpm ?? base?.target_bpm ?? 'global',
            key: String(this.properties?.key ?? base?.key ?? ''),
            key_match_mode: this.properties?.key_match_mode ?? base?.key_match_mode ?? 'off',
            key_match_algorithm: this.properties?.key_match_algorithm ?? base?.key_match_algorithm ?? 'nearest',
            transpose,
            pitch_shift: transpose,
            cents: Number(this.properties?.cents ?? base?.cents ?? 0),
            stretch_mode: this.properties?.stretch_mode ?? base?.stretch_mode ?? 'time_stretch',
            stretch_algorithm: this.properties?.stretch_algorithm ?? base?.stretch_algorithm ?? 'rubberband',
            stretch_factor: stretchFactor,
            time_stretch: stretchFactor,
            crop_start: cropStart,
            crop_end: cropEnd,
            sample_start: cropStart,
            sample_end: cropEnd,
            field_operators: this.properties?.field_operators && typeof this.properties.field_operators === 'object'
                ? { ...this.properties.field_operators }
                : (base?.field_operators ? { ...base.field_operators } : {}),
        };
    }

    private getSlotPropertyValue(slot: NodeSlot | undefined, key: string): any {
        if (!slot) return undefined;
        if (key === 'transpose' || key === 'pitch_shift') {
            return slot.transpose ?? slot.pitch_shift ?? 0;
        }
        if (key === 'stretch_factor' || key === 'time_stretch') {
            return slot.stretch_factor ?? slot.time_stretch ?? 1;
        }
        if (key === 'crop_start' || key === 'sample_start') {
            return slot.crop_start ?? slot.sample_start ?? 0;
        }
        if (key === 'crop_end' || key === 'sample_end') {
            return slot.crop_end ?? slot.sample_end ?? 1;
        }
        if (key === 'pool_query') {
            return String(slot.pool_query ?? '');
        }
        if (key === 'filepath') {
            return String(slot.filepath ?? '');
        }
        const fieldDef = SampleNode.fields.find(f => f.key === key);
        return slot[key] !== undefined ? slot[key] : fieldDef?.default;
    }

    private applyPropertyToSlot(slot: NodeSlot, key: string, value: any): void {
        if (!slot) return;
        slot[key] = value;
        if (key === 'transpose' || key === 'pitch_shift') {
            const num = Number(value ?? 0);
            slot.transpose = num;
            slot.pitch_shift = num;
        } else if (key === 'stretch_factor' || key === 'time_stretch') {
            const num = Number(value ?? 1);
            slot.stretch_factor = num;
            slot.time_stretch = num;
        } else if (key === 'crop_start' || key === 'sample_start') {
            const num = Number(value ?? 0);
            slot.crop_start = num;
            slot.sample_start = num;
        } else if (key === 'crop_end' || key === 'sample_end') {
            const num = Number(value ?? 1);
            slot.crop_end = num;
            slot.sample_end = num;
        }
    }

    public applyPropertyToSelectedSlots(key: string, value: any): void {
        const slots = this.getSlots();
        const selected = this.getSelectedSlotIndices();
        for (const idx of selected) {
            if (slots[idx]) {
                this.applyPropertyToSlot(slots[idx], key, value);
                if (key === 'filepath') {
                    this.slotBuffers.delete(idx);
                    this.slotLoadedPaths.delete(idx);
                }
            }
        }
    }

    override hasMixedSlotValues(key: string): boolean {
        const selected = this.getSelectedSlotIndices();
        if (selected.length <= 1) return false;
        const slots = this.getSlots();
        const firstVal = this.getSlotPropertyValue(slots[selected[0]], key);
        for (let i = 1; i < selected.length; i++) {
            const otherVal = this.getSlotPropertyValue(slots[selected[i]], key);
            if (!Object.is(firstVal, otherVal) && String(firstVal ?? '') !== String(otherVal ?? '')) {
                return true;
            }
        }
        return false;
    }

    public getSlots(): NodeSlot[] {
        if (!this.properties) this.properties = {};
        if (!Array.isArray(this.properties.slots) || this.properties.slots.length === 0) {
            this.properties.slots = [this.buildSlotSnapshotFromProperties(0)];
        } else if (
            this.properties.slots.length === 1 &&
            !this.properties.slots[0]?.filepath &&
            this.properties.filepath
        ) {
            this.properties.slots[0] = this.buildSlotSnapshotFromProperties(0, this.properties.slots[0]);
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
        this.properties.filepath = String(slot.filepath || '');
        if (slot.library_item_id !== undefined) this.properties.library_item_id = slot.library_item_id;
        if (slot.duration_seconds !== undefined) this.properties.duration_seconds = slot.duration_seconds;
        if (slot.sample_type !== undefined) this.properties.sample_type = slot.sample_type;
        if (slot.start_beat !== undefined) this.properties.start_beat = Number(slot.start_beat);
        if (slot.original_bpm !== undefined) this.properties.original_bpm = slot.original_bpm;
        if (slot.target_bpm !== undefined) this.properties.target_bpm = slot.target_bpm;
        if (slot.key !== undefined) this.properties.key = slot.key;
        if (slot.key_match_mode !== undefined) this.properties.key_match_mode = slot.key_match_mode;
        if (slot.key_match_algorithm !== undefined) this.properties.key_match_algorithm = slot.key_match_algorithm;
        if (slot.cents !== undefined) this.properties.cents = Number(slot.cents);
        if (slot.stretch_mode !== undefined) this.properties.stretch_mode = slot.stretch_mode;
        if (slot.stretch_algorithm !== undefined) this.properties.stretch_algorithm = slot.stretch_algorithm;
        const cropStart = slot.crop_start ?? slot.sample_start;
        const cropEnd = slot.crop_end ?? slot.sample_end;
        if (cropStart !== undefined) this.properties.crop_start = Number(cropStart);
        if (cropEnd !== undefined) this.properties.crop_end = Number(cropEnd);
        const transpose = slot.transpose ?? slot.pitch_shift;
        const stretchFactor = slot.stretch_factor ?? slot.time_stretch;
        if (transpose !== undefined) this.properties.transpose = Number(transpose);
        if (stretchFactor !== undefined) this.properties.stretch_factor = Number(stretchFactor);
        this.properties.field_operators = slot.field_operators && typeof slot.field_operators === 'object'
            ? { ...slot.field_operators }
            : {};

        delete (this as any).manifestStemBuffer;
        (this as any)._lastRenderedBuffer = null;
        this.resetPropertySnapshots();
        const trackData = (typeof window !== 'undefined') ? (window as any).trackNodes?.get?.(this.id) : null;
        if (trackData) {
            trackData.filepath = this.properties.filepath;
            if (this.properties.original_bpm !== undefined) trackData.original_bpm = this.properties.original_bpm;
            if (this.properties.key !== undefined) trackData.key = this.properties.key;
            trackData.crop_start = this.properties.crop_start;
            trackData.crop_end = this.properties.crop_end;
            trackData.active_slot = this.activeSlotIndex;
        }

        const cachedBuf = this.slotBuffers.get(this.activeSlotIndex);
        const cachedPath = this.slotLoadedPaths.get(this.activeSlotIndex);
        if (cachedBuf && this.properties.filepath && cachedPath === this.properties.filepath) {
            this.audioBuffer = cachedBuf;
            this.loadedFilepath = this.properties.filepath;
        } else {
            void this.ensureAudioLoaded();
        }
        this.setDirtyCanvas(true, true);
    }

    public copySlot(index?: number): NodeSlot | null {
        this.syncActiveSlotFromProperties();
        const slots = this.getSlots();
        const targetIdx = Math.min(Math.max(0, index ?? this.activeSlotIndex), slots.length - 1);
        const slot = slots[targetIdx];
        if (!slot) return null;
        return copyNodeSlotToClipboard('sample', slot);
    }

    public pasteSlot(index?: number, customSlot?: NodeSlot): boolean {
        this.syncActiveSlotFromProperties();
        const sourceSlot = customSlot
            ? JSON.parse(JSON.stringify(customSlot))
            : getCopiedNodeSlotFromClipboard('sample')?.slot;
        if (!sourceSlot) return false;
        const slots = this.getSlots();
        const targets = index !== undefined
            ? [Math.min(Math.max(0, index), slots.length - 1)]
            : this.getSelectedSlotIndices();
        for (const targetIdx of targets) {
            slots[targetIdx] = {
                ...JSON.parse(JSON.stringify(sourceSlot)),
                slot: targetIdx,
                index: targetIdx
            };
            this.slotBuffers.delete(targetIdx);
            this.slotLoadedPaths.delete(targetIdx);
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
        void this.preloadAllSlotBuffers();
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
                        this.applyPropertyToSlot(slot, key, resolved);
                        if (idx === this.activeSlotIndex && this.properties) {
                            this.properties[key] = resolved;
                        }
                    }
                }
            }
        }
        const activeQuery = String(slots[this.activeSlotIndex]?.pool_query ?? this.properties?.pool_query ?? '').trim();
        if (isFieldOperatorExpression(activeQuery)) {
            this.applyPoolQuery(activeQuery, false);
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
                name: it?.name || fp.split(/[\\/]/).pop() || 'Sample',
                type: it?.itemType || it?.type || 'audio',
                bpm: it?.bpm ?? null,
                key: it?.key ?? null,
                duration_seconds: it?.duration_seconds ?? null,
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

        const assignedPool = this.getAttachedPoolNode();
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
                });
            }
            const filepath = String(item.filepath || item.absolute_path || '');
            const bpm = Number.isFinite(Number(item.bpm)) ? Number(item.bpm) : parseBpmFromFilename(filepath);
            slots[slotIdx] = {
                ...(slots[slotIdx] || {}),
                slot: slotIdx,
                index: slotIdx,
                pool_query: '',
                filepath,
                library_item_id: item.id ?? slots[slotIdx]?.library_item_id,
                sample_type: item.itemType === 'one_shot' ? 'one_shot' : 'loop',
                original_bpm: bpm ?? slots[slotIdx]?.original_bpm ?? 120,
                key: item.key ? String(item.key) : (slots[slotIdx]?.key || ''),
                ...(Number.isFinite(Number(item.duration_seconds)) && Number(item.duration_seconds) > 0
                    ? { duration_seconds: Number(item.duration_seconds) }
                    : {}),
            };
            this.slotBuffers.delete(slotIdx);
            this.slotLoadedPaths.delete(slotIdx);
        }

        this.activeSlotIndex = baseIdx;
        this.selectedSlotIndices = targetIndices;
        this.properties.active_slot = this.activeSlotIndex;
        this.applySlotToProperties(slots[this.activeSlotIndex]);
        SampleNode.propagateKeyMatch(this.graph);

        if (items[0]?.name && !assignedPool) {
            this.updateProperty('node_name', items[0].name);
        }
        if (assignedPool?.properties) {
            assignedPool.properties.output_value = this.properties.filepath;
            if (items[0]?.id != null) assignedPool.properties.output_item_id = items[0].id;
        }
        void this.preloadAllSlotBuffers();
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

        // Multiple items dropped onto a slot pill, waveform, or title field -> write a cycling text list operator
        if (items.length > 1) {
            this.syncActiveSlotFromProperties();
            this.ensureItemsInPool(items);
            if (!this.properties) this.properties = {};
            this.properties.trigger_count = 0;
            if (startSlotIndex !== undefined) {
                this.selectSlot(startSlotIndex);
            }
            const listExpr = formatPoolListExpression(items);
            this.applyPoolQuery(listExpr, false);
            return;
        }

        // Single item dropped onto a slot pill, waveform, or title field -> fixed asset on target slot(s)
        this.syncActiveSlotFromProperties();
        const slots = this.getSlots();
        const baseIdx = startSlotIndex !== undefined
            ? Math.max(0, startSlotIndex)
            : Math.min(Math.max(0, this.activeSlotIndex), slots.length - 1);

        const targetIndices: number[] = startSlotIndex === undefined && this.getSelectedSlotIndices().length > 1
            ? [...this.getSelectedSlotIndices()]
            : [baseIdx];

        const assignedPool = this.getAttachedPoolNode();
        const item = items[0];

        for (const slotIdx of targetIndices) {
            while (slots.length <= slotIdx) {
                const template = slots[slots.length - 1] || slots[0] || {};
                const nextIdx = slots.length;
                slots.push({
                    ...template,
                    slot: nextIdx,
                    index: nextIdx,
                });
            }
            const filepath = String(item.filepath || item.absolute_path || '');
            const bpm = Number.isFinite(Number(item.bpm)) ? Number(item.bpm) : parseBpmFromFilename(filepath);
            slots[slotIdx] = {
                ...(slots[slotIdx] || {}),
                slot: slotIdx,
                index: slotIdx,
                pool_query: '',
                filepath,
                library_item_id: item.id ?? slots[slotIdx]?.library_item_id,
                sample_type: item.itemType === 'one_shot' ? 'one_shot' : 'loop',
                original_bpm: bpm ?? slots[slotIdx]?.original_bpm ?? 120,
                key: item.key ? String(item.key) : (slots[slotIdx]?.key || ''),
                ...(Number.isFinite(Number(item.duration_seconds)) && Number(item.duration_seconds) > 0
                    ? { duration_seconds: Number(item.duration_seconds) }
                    : {}),
            };
            this.slotBuffers.delete(slotIdx);
            this.slotLoadedPaths.delete(slotIdx);
        }

        this.activeSlotIndex = baseIdx;
        this.selectedSlotIndices = startSlotIndex !== undefined ? [baseIdx] : this.getSelectedSlotIndices();
        this.properties.active_slot = this.activeSlotIndex;
        this.applySlotToProperties(slots[this.activeSlotIndex]);
        SampleNode.propagateKeyMatch(this.graph);

        if (item?.name && !assignedPool) {
            this.updateProperty('node_name', item.name);
        }
        if (assignedPool?.properties) {
            assignedPool.properties.output_value = this.properties.filepath;
            if (item?.id != null) assignedPool.properties.output_item_id = item.id;
        }
        void this.preloadAllSlotBuffers();
    }

    public applyPoolQuery(rawQuery: string, advanceSaltOnRand: boolean = true): boolean {
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
            const bpm = chosen.bpm ?? chosen.original_bpm ?? parseBpmFromFilename(filepath);
            const key = chosen.key != null ? String(chosen.key).trim() : undefined;

            slots[idx] = {
                ...(slots[idx] || {}),
                slot: idx,
                index: idx,
                pool_query: query,
                filepath,
                library_item_id: chosen.id,
                original_bpm: bpm ?? slots[idx]?.original_bpm,
                key: key || slots[idx]?.key || 'C',
                ...(Number.isFinite(Number(chosen.duration_seconds)) && Number(chosen.duration_seconds) > 0
                    ? { duration_seconds: Number(chosen.duration_seconds) }
                    : {}),
            };
            this.slotBuffers.delete(idx);
            this.slotLoadedPaths.delete(idx);
        }

        if (!anyMatched) return false;
        const activeSlot = slots[this.activeSlotIndex] || slots[0];
        this.applySlotToProperties(activeSlot);
        if (modNode?.properties) {
            modNode.properties.output_value = activeSlot.filepath;
            if (activeSlot.library_item_id != null) modNode.properties.output_item_id = activeSlot.library_item_id;
        }
        void this.preloadAllSlotBuffers();
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
        this._liveTriggeredFilepath = null;
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
            index: newIdx
        });

        const graph = this.graph || (typeof window !== 'undefined' ? (window as any).editorGraph : null);
        const modId = this.properties?.asset_modifier_id;
        const modNode = modId != null && graph ? graph.getNodeById?.(modId) : null;
        if (modNode) {
            populateOwnerSlotsFromPool(modNode, this);
        }

        this.activeSlotIndex = newIdx;
        this.selectedSlotIndices = [newIdx];
        this.applySlotToProperties(slots[newIdx]);
        this.updateProperty('active_slot', newIdx);
        void this.preloadAllSlotBuffers();
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
        this.slotBuffers.clear();
        this.slotLoadedPaths.clear();
        this.activeSlotIndex = Math.min(this.activeSlotIndex, slots.length - 1);
        this.selectedSlotIndices = [this.activeSlotIndex];
        this.applySlotToProperties(slots[this.activeSlotIndex]);
        this.updateProperty('active_slot', this.activeSlotIndex);
        if (typeof window !== 'undefined' && this.id != null) {
            window.dispatchEvent(new CustomEvent('node-property-changed', {
                detail: { nodeId: this.id, key: 'slots', value: slots.map(s => ({ ...s })) }
            }));
        }
        void this.preloadAllSlotBuffers();
    }

    public async preloadAllSlotBuffers(): Promise<void> {
        const slots = this.getSlots();
        await Promise.all(slots.map(async (s, idx) => {
            const fp = String(s?.filepath || '');
            if (!fp) {
                this.slotBuffers.delete(idx);
                this.slotLoadedPaths.delete(idx);
                return;
            }
            if (this.slotBuffers.has(idx) && this.slotLoadedPaths.get(idx) === fp) {
                return;
            }
            try {
                const buf = await fetchAudioBuffer(fp);
                if (buf) {
                    this.slotBuffers.set(idx, buf);
                    this.slotLoadedPaths.set(idx, fp);
                    if (idx === this.activeSlotIndex) {
                        this.audioBuffer = buf;
                        this.loadedFilepath = fp;
                    }
                }
            } catch {
                // Ignore individual slot load error
            }
        }));
        const hasCyclingPoolQuery = slots.some(s => isFieldOperatorExpression(s?.pool_query))
            || isFieldOperatorExpression(this.properties?.pool_query);
        if (hasCyclingPoolQuery) {
            const modNode = this.getAttachedPoolNode();
            const rawItems = Array.isArray(modNode?.properties?.selected_items)
                ? modNode.properties.selected_items
                : (Array.isArray(this.properties?.selected_items) ? this.properties.selected_items : []);
            const poolPaths = rawItems
                .map((item: any) => String(item?.absolute_path || item?.filepath || ''))
                .filter(Boolean);
            await Promise.all(poolPaths.map((fp: string) => fetchAudioBuffer(fp).catch(() => null)));
        }
        this.setDirtyCanvas(true, true);
    }

    private _cachedGainedBuffer: AudioBuffer | null = null;
    private _lastRawBufferRef: AudioBuffer | null = null;
    private _lastNodeGain: number = 1.0;

    private applySampleNodeGain(rawBuf: AudioBuffer | null): AudioBuffer | null {
        if (!rawBuf) return null;
        const nodeGain = getNodeGainMultiplier(this);
        if (Math.abs(nodeGain - 1.0) < 1e-4) return rawBuf;
        if (this._cachedGainedBuffer && this._lastRawBufferRef === rawBuf && Math.abs(this._lastNodeGain - nodeGain) < 1e-4) {
            return this._cachedGainedBuffer;
        }
        const gained = applyGainToBuffer(rawBuf, nodeGain);
        this._cachedGainedBuffer = gained;
        this._lastRawBufferRef = rawBuf;
        this._lastNodeGain = nodeGain;
        return gained;
    }

    public getSlotBuffersMap(): Map<number, AudioBuffer> {
        if (this.audioBuffer && this.loadedFilepath) {
            this.slotBuffers.set(this.activeSlotIndex, this.audioBuffer);
            this.slotLoadedPaths.set(this.activeSlotIndex, this.loadedFilepath);
        }
        const nodeGain = getNodeGainMultiplier(this);
        if (Math.abs(nodeGain - 1.0) < 1e-4) {
            return this.slotBuffers;
        }
        const gainedMap = new Map<number, AudioBuffer>();
        for (const [idx, buf] of this.slotBuffers.entries()) {
            gainedMap.set(idx, idx === this.activeSlotIndex ? (this.applySampleNodeGain(buf) || buf) : applyGainToBuffer(buf, nodeGain));
        }
        return gainedMap;
    }

    public async ensureAudioLoaded(): Promise<AudioBuffer | null> {
        const filepath = String(this.properties?.filepath || '');
        if (!filepath) {
            this.audioBuffer = null;
            this.loadedFilepath = '';
            this.sharedWaveformRenderer.setSignal(null);
            return null;
        }
        if (this.audioBuffer && this.loadedFilepath === filepath) {
            if (this.getSlots().length > 1) {
                void this.preloadAllSlotBuffers();
            }
            return this.audioBuffer;
        }
        if (this.loadingAudioPromise && this.loadedFilepath === filepath) {
            return this.loadingAudioPromise;
        }
        this.isLoadingAudio = true;
        this.loadedFilepath = filepath;
        this.loadingAudioPromise = (async () => {
            try {
                const buffer = await fetchAudioBuffer(filepath);
                this.audioBuffer = buffer;
                if (buffer) {
                    this.slotBuffers.set(this.activeSlotIndex, buffer);
                    this.slotLoadedPaths.set(this.activeSlotIndex, filepath);
                    if (buffer.duration) {
                        this.properties.duration_seconds = buffer.duration;
                    }
                }
                if (this.getSlots().length > 1) {
                    void this.preloadAllSlotBuffers();
                }
                this.failedAudioFilepath = null;
                this.setDirtyCanvas(true, true);
                return buffer;
            } catch (err) {
                this.failedAudioFilepath = filepath;
                console.warn(`Failed to preload audio for SampleNode #${this.id}:`, err);
                return null;
            } finally {
                this.isLoadingAudio = false;
                this.loadingAudioPromise = null;
            }
        })();
        return this.loadingAudioPromise;
    }

    static panelSchema: NodePanelSchema = {
        tabs: [
            {
                id: 'SAMPLE',
                label: 'Sample',
                sections: [
                    { type: 'waveform_crop', filepathKey: 'filepath', cropStartKey: 'crop_start', cropEndKey: 'crop_end' },
                    { type: 'fields', layout: 'inline', fields: ['crop_start', 'crop_end'] },
                    { type: 'fields', fields: ['sample_type'] },
                    { type: 'fields', fields: ['start_beat', 'original_bpm', 'target_bpm'] },
                    { type: 'fields', fields: ['key', 'key_match_mode', 'key_match_algorithm', 'transpose', 'cents'] },
                    { type: 'fields', fields: ['stretch_mode', 'stretch_algorithm'] }
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
                    { type: 'info_table' },
                    { type: 'fields', fields: ['scope_mode', 'scope_window', 'scope_gain'] }
                ]
            }
        ]
    };

    static fields: FieldSchema[] = [
        { key: 'node_name', label: 'Name', type: 'string', default: 'New Sample', tab: 'COMMON' },
        { key: 'filepath', label: 'Asset File', type: 'filepath', default: '', tab: 'SAMPLE' },
        { key: 'sample_type', label: 'Type', type: 'radio', default: 'loop', options: [{ value: 'loop', label: 'Loop' }, { value: 'one_shot', label: 'One Shot' }], tab: 'SAMPLE' },
        { key: 'start_beat', label: 'Start Beat', type: 'float', default: 0, min: 0, tab: 'SAMPLE' },
        {
            key: 'original_bpm',
            label: 'Source BPM',
            type: 'float',
            default: 120,
            min: 20,
            max: 300,
            unit: 'BPM',
            tab: 'SAMPLE',
            description: 'Used locally now and staged as a proposal for GAIA to review before changing the library asset.'
        },
        { key: 'target_bpm', label: 'Target BPM', type: 'global_float', default: 'global', min: 20, max: 300, unit: 'BPM', tab: 'SAMPLE' },
        {
            key: 'key',
            label: 'Key',
            type: 'string',
            default: '',
            tab: 'SAMPLE',
            description: 'Used locally now and staged as a proposal for GAIA to review before changing the library asset.'
        },
        {
            key: 'key_match_mode',
            label: 'Key Matching',
            type: 'radio',
            default: 'off',
            options: [
                { value: 'off', label: 'Off' },
                { value: 'follow', label: 'Follow' },
                { value: 'lead', label: 'Lead' }
            ],
            tab: 'SAMPLE',
            description: 'Follow matches the global key; Lead makes this sample control the global key.'
        },
        {
            key: 'key_match_algorithm',
            label: 'Matching Algorithm',
            type: 'radio',
            default: 'nearest',
            options: [
                { value: 'nearest', label: 'Shift Nearest' },
                { value: 'higher', label: 'Shift Higher' },
                { value: 'lower', label: 'Shift Lower' }
            ],
            tab: 'SAMPLE',
            description: 'Choose whether Follow shifts to the closest compatible key, only upward, or only downward.'
        },
        { key: 'transpose', label: 'Transpose', type: 'int', default: 0, min: -24, max: 24, step: 1, unit: 'st', tab: 'SAMPLE' },
        { key: 'cents', label: 'Fine Tune', type: 'int', default: 0, min: -100, max: 100, step: 1, unit: 'ct', tab: 'SAMPLE' },
        {
            key: 'stretch_mode',
            label: 'Stretch Mode',
            type: 'radio',
            default: 'time_stretch',
            options: [
                { value: 'time_stretch', label: 'Time Stretch (Independent Pitch)' },
                { value: 'pitch_shift', label: 'Repitch (Speed + Pitch)' }
            ],
            tab: 'SAMPLE',
            description: 'Time Stretch keeps key shifts independent from timing. Repitch links the key shift to playback speed, like tape or vinyl.'
        },
        {
            key: 'stretch_algorithm',
            label: 'Stretch Algorithm',
            type: 'radio',
            default: 'rubberband',
            options: [
                { value: 'rubberband', label: 'General / Tonal — R3 Finer' },
                { value: 'rubberband_vocal', label: 'Vocals / Speech — R3 Formant' },
                { value: 'rubberband_percussive', label: 'Drums / Percussion — R2 Crisp' }
            ],
            tab: 'SAMPLE',
            description: 'General is best for most musical samples and manual pitch-down. Vocals preserves formants. Percussion favours drum transients. Repitch always uses tape-style resampling.'
        },
        { key: 'crop_start', label: 'Start Point', type: 'float', default: 0.0, min: 0, max: 1, step: 0.1, tab: 'SAMPLE' },
        { key: 'crop_end', label: 'End Point', type: 'float', default: 1.0, min: 0, max: 1, step: 0.1, tab: 'SAMPLE' }
    ];

    static defaultColor = "#10b981";
    static defaultIcon = "sample";
    static badgeLabel = "SMPL";
    static nodeType = "sample";
    static defaultTab = "SAMPLE";
    static tabs = ["SAMPLE", "CHAIN", "COMMON"];
    static override defaultVisualizationType: VisualizationTypeId = 'sample';
    static override supportedVisualizationTypes: readonly VisualizationTypeId[] = ['sample', 'realtime', 'spectrum'];

    constructor() {
        super();
        this.title = "Sample";
        this.size = this.computeSize();

        // Leaf node visual style (Emerald)
        this.color = "#10b981";
        this.bgcolor = "#10b981";
        this.boxcolor = "#059669";

        this.properties = {
            ...this.properties,
            node_name: "New Sample",
            filepath: "",
            sample_type: "loop",
            start_beat: 0,
            original_bpm: 120,
            target_bpm: "global",
            bpm: "global",
            key: "",
            key_match_mode: "off",
            key_match_algorithm: "nearest",
            key_match_transpose: 0,
            crop_start: 0.0,
            crop_end: 1.0,
            transpose: 0.0,
            cents: 0.0,
            stretch_mode: "time_stretch",
            stretch_factor: 1.0,
            stretch_algorithm: "rubberband",
            chain: getDefaultFxChain(DEFAULT_SAMPLE_INPUT_GAIN_DB),
            scope_mode: "full",
            scope_window: 0.0,
            scope_gain: 1.0,
            color: "#10b981",
            icon: "sample"
        };

        this.addOutput("Audio", "audio");
    }

    protected override onBeforePropertyChanged(key: string): void {
        if ((SampleNode.slotPropertyKeys as readonly string[]).includes(key)) {
            this.syncActiveSlotFromProperties();
        }
    }

    override updateProperty(key: string, value: any): void {
        super.updateProperty(key, value);
        if ((SampleNode.slotPropertyKeys as readonly string[]).includes(key)) {
            this.syncActiveSlotFromProperties();
            this.applyPropertyToSelectedSlots(key, value);
        }
        if (key === 'filepath') {
            const pathStr = String(value || '');
            if (pathStr !== this.loadedFilepath || !this.audioBuffer) {
                this.loadedFilepath = pathStr;
                this.audioBuffer = null;
                delete (this as any).manifestStemBuffer;
                this.sharedWaveformRenderer.setSignal(null);
                if (pathStr) {
                    void this.ensureAudioLoaded();
                }
            }
        }
        if (!this.graph) return;
        if (key === 'key_match_mode' || key === 'key_match_algorithm' || key === 'key') {
            SampleNode.propagateKeyMatch(
                this.graph,
                key === 'key_match_mode' && value === 'lead' ? this : undefined
            );
        }
    }

    override onConfigure(data: any): void {
        super.onConfigure?.(data);
        if (this.properties && (this.properties.target_bpm === undefined || this.properties.target_bpm === null)) {
            this.properties.target_bpm = 'global';
        }
        if (this.properties && Array.isArray(this.properties.slots)) {
            this.properties.slots = this.properties.slots.map((s: any, idx: number) => ({
                ...(s || {}),
                slot: idx,
                index: idx,
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

    override getAudioBuffer(_visited?: Set<number>): AudioBuffer | null {
        if ((this as any).manifestStemBuffer) return (this as any).manifestStemBuffer;
        if ((this as any)._lastRenderedBuffer) return (this as any)._lastRenderedBuffer;
        const rawBuf = this.slotBuffers.get(this.activeSlotIndex) || this.audioBuffer || null;
        return this.applySampleNodeGain(rawBuf);
    }

    override preparePropertyEdit(key: string, value: any, previousValue: any): boolean {
        if (key !== 'key' && key !== 'original_bpm') return true;
        if (Object.is(value, previousValue)) return true;

        const overrideKey = key === 'key' ? 'key_is_local_override' : 'original_bpm_is_local_override';
        if (this.properties?.[overrideKey]) return true;

        const label = key === 'key' ? 'key' : 'source BPM';
        const accepted = typeof window === 'undefined' || typeof window.confirm !== 'function'
            ? true
            : window.confirm(
                `Use a node-local ${label} override?\n\n`
                + 'SIN will use this value now and stage it for GAIA review. Only GAIA can apply it to the library asset.'
            );
        if (accepted) this.updateProperty(overrideKey, true);
        return accepted;
    }

    public ensurePoolSlotsPopulated(): void {
        const modId = this.properties?.asset_modifier_id;
        if (modId == null) return;
        const slots = this.getSlots();
        const needsFill = !this.properties?.filepath || slots.some((s: any) => !s?.filepath);
        if (!needsFill) return;
        const graph = this.graph || (typeof window !== 'undefined' ? (window as any).editorGraph : null);
        const modNode = graph?.getNodeById?.(modId);
        if (modNode && Array.isArray(modNode.properties?.selected_items) && modNode.properties.selected_items.length > 0) {
            populateOwnerSlotsFromPool(modNode, this);
        }
    }

    async syncMetadataFromLibrary(files?: LibraryFile[], preferredId?: number | string | null): Promise<LibraryFile | null> {
        this.ensurePoolSlotsPopulated();
        const filepath = String(this.properties?.filepath || '');
        if (!filepath) return null;
        const libraryFiles = files || await resolveLibraryAssets([{
            id: preferredId ?? this.properties?.library_item_id,
            absolute_path: filepath
        }]);
        // Presets store both a path and an ID. Collection-content IDs contain a
        // manifest index that may point at another file after a GAIA rescan, so
        // never let that stale index override the exact saved asset path.
        const libraryFile = findLibraryFileForSnapshot(
            libraryFiles,
            filepath,
            preferredId ?? this.properties?.library_item_id
        );
        if (!libraryFile) return null;

        const isExplicitOneShot = libraryFile.is_loop === false
            || libraryFile.sample_type === 'one_shot'
            || (Array.isArray(libraryFile.tags) && libraryFile.tags.includes('One shot'));
        const isExplicitLoop = libraryFile.is_loop === true
            || libraryFile.sample_type === 'loop'
            || (Array.isArray(libraryFile.tags) && libraryFile.tags.includes('Loop'));

        if (isExplicitOneShot) {
            if (this.properties.sample_type !== 'one_shot') {
                this.updateProperty('sample_type', 'one_shot');
            }
        } else if (isExplicitLoop) {
            if (this.properties.sample_type !== 'loop') {
                this.updateProperty('sample_type', 'loop');
            }
        }

        const bpm = Number(libraryFile?.bpm);
        if (libraryFile?.id != null && this.properties.library_item_id !== libraryFile.id) {
            this.updateProperty('library_item_id', libraryFile.id);
        }
        if (libraryFile.absolute_path && libraryFile.absolute_path !== filepath) {
            this.updateProperty('filepath', libraryFile.absolute_path);
        }
        if (!this.properties?.original_bpm_is_local_override) {
            if (Number.isFinite(bpm) && bpm >= 20 && bpm <= 400) {
                if (this.properties.original_bpm !== bpm) {
                    this.updateProperty('original_bpm', bpm);
                }
            } else if (isExplicitOneShot) {
                // One shots do not have any bpm signature unless user specified from the library
                if (this.properties.original_bpm !== null) {
                    this.updateProperty('original_bpm', null);
                }
            }
        }

        const duration = Number(libraryFile.duration_seconds);
        const currentDuration = Number(this.properties.duration_seconds);
        if (
            Number.isFinite(duration) &&
            duration > 0 &&
            (!Number.isFinite(currentDuration) || currentDuration <= 0 || Math.abs(currentDuration - duration) > 0.05)
        ) {
            this.updateProperty('duration_seconds', duration);
        }

        const libraryKey = String(libraryFile.key || '').trim();
        if (!this.properties?.key_is_local_override && String(this.properties.key || '') !== libraryKey) {
            this.updateProperty('key', libraryKey);
        }
        SampleNode.propagateKeyMatch(this.graph);
        return libraryFile;
    }

    async syncOriginalBpmFromLibrary(files?: LibraryFile[], preferredId?: number | string | null): Promise<boolean> {
        const libraryFile = await this.syncMetadataFromLibrary(files, preferredId);
        const bpm = Number(libraryFile?.bpm);
        return Number.isFinite(bpm) && bpm >= 20 && bpm <= 400;
    }

    async onPropertyEdited(key: string, value: any, previousValue: any): Promise<void> {
        if (key === 'target_bpm') {
            this.updateProperty('bpm', value);
            return;
        }
        if (key === 'key' || key === 'original_bpm') {
            const field = key === 'key' ? 'key' : 'bpm';
            const proposalKey = key === 'key' ? 'key_proposal' : 'original_bpm_proposal';
            const stagedProposal = {
                field,
                value,
                previousValue,
                status: 'staging',
                updatedAt: new Date().toISOString(),
            };
            this.updateProperty(proposalKey, stagedProposal);
            try {
                const proposal = await submitLibraryMetadataProposal({
                    filepath: String(this.properties?.filepath || ''),
                    fileId: this.properties?.library_item_id,
                    field,
                    value: field === 'bpm' ? Number(value) : String(value),
                    previousValue: field === 'bpm' ? Number(previousValue) : String(previousValue ?? ''),
                    sourceNodeId: this.id ?? null,
                });
                this.updateProperty(proposalKey, {
                    ...stagedProposal,
                    id: proposal.id,
                    value: proposal.proposed_value,
                    status: proposal.status,
                    updatedAt: proposal.updated_at,
                });
            } catch (error) {
                // Keep the useful node-local edit. A later metadata edit will
                // retry staging it when GAIA becomes available.
                this.updateProperty(proposalKey, {
                    ...stagedProposal,
                    status: 'pending_sync',
                    error: error instanceof Error ? error.message : 'GAIA proposal queue is unavailable',
                });
                console.warn('Could not stage GAIA metadata proposal', error);
            }
            return;
        }
        if (key === 'filepath') {
            this.updateProperty('library_item_id', null);
            this.updateProperty('key_is_local_override', false);
            this.updateProperty('original_bpm_is_local_override', false);
            await this.syncMetadataFromLibrary();
            return;
        }
    }

    override onGlobalParametersChanged(parameters: Record<string, any>): void {
        SampleNode.propagateKeyMatch(this.graph, undefined, String(parameters.key || ''));
    }

    override prepareSerializedModel(model: any): any {
        SampleNode.propagateKeyMatch(this.graph);
        this.syncActiveSlotFromProperties();
        const matchTranspose = this.properties?.key_match_mode === 'follow'
            ? Number(this.properties?.key_match_transpose) || 0
            : 0;

        const isOneShot = (this.properties?.sample_type || model.sample_type) === 'one_shot';
        return {
            ...model,
            active_slot: this.activeSlotIndex,
            slots: Array.isArray(model.slots) && model.slots.length > 0
                ? model.slots
                : this.getSlots().map((s, idx) => ({
                    ...s,
                    slot: idx,
                    crop_start: s.crop_start ?? s.sample_start ?? 0,
                    crop_end: s.crop_end ?? s.sample_end ?? 1,
                })),
            sample_type: isOneShot ? 'one_shot' : (model.sample_type || 'loop'),
            original_bpm: isOneShot && !this.properties?.original_bpm_is_local_override && !model.original_bpm_is_local_override && (model.original_bpm === 120 || !model.original_bpm)
                ? null
                : model.original_bpm,
            key: matchTranspose !== 0 ? (this.properties?.key_match_target || model.key) : model.key,
            transpose: (Number(model.transpose) || 0) + matchTranspose,
            key_match_mode: this.properties?.key_match_mode || 'off',
            key_match_algorithm: this.properties?.key_match_algorithm || 'nearest',
            stretch_algorithm: this.properties?.stretch_algorithm || 'rubberband'
        };
    }

    static calculateKeyMatch(
        sourceKey: string,
        leadKey: string,
        algorithm: KeyMatchAlgorithm = 'nearest'
    ): { transpose: number; targetKey: string } | null {
        const source = this.parseKey(sourceKey);
        const lead = this.parseKey(leadKey);
        if (!source || !lead) return null;

        let targetPitchClass = lead.pitchClass;
        if (source.mode && lead.mode && source.mode !== lead.mode) {
            // Transposition preserves mode, so match the relative major/minor in the lead scale.
            targetPitchClass = lead.mode === 'minor'
                ? (lead.pitchClass + 3) % 12
                : (lead.pitchClass + 9) % 12;
        }

        const upward = (targetPitchClass - source.pitchClass + 12) % 12;
        let transpose: number;
        switch (algorithm) {
            case 'higher':
                transpose = upward;
                break;
            case 'lower':
                transpose = upward === 0 ? 0 : upward - 12;
                break;
            default:
                transpose = upward > 6 ? upward - 12 : upward;
                break;
        }
        return { transpose, targetKey: this.formatKey(targetPitchClass, source.mode) };
    }

    private static coordinatingGraphs = new WeakSet<object>();

    private static propagateKeyMatch(graph: any, preferredLead?: SampleNode, globalKeyOverride?: string): void {
        if (!graph) return;
        if (this.coordinatingGraphs.has(graph)) return;
        this.coordinatingGraphs.add(graph);

        try {
            const samples = (((graph as any)._nodes || []) as any[])
                .filter((node: any): node is SampleNode =>
                    node instanceof SampleNode || node?.nodeType === SampleNode.nodeType
                );
            const lead = preferredLead?.properties?.key_match_mode === 'lead'
                ? preferredLead
                : samples.find(sample => sample.properties?.key_match_mode === 'lead');

            for (const sample of samples) {
                if (sample !== lead && sample.properties?.key_match_mode === 'lead') {
                    sample.updateProperty('key_match_mode', 'off');
                }
            }

            const leadKey = String(lead?.properties?.key || '');
            const savedGlobalKey = String(
                globalKeyOverride
                ?? graph?.extra?.global_parameters?.key
                ?? (typeof window !== 'undefined' ? (window as any).getGlobalParameter?.('key') : '')
                ?? ''
            ).trim();
            const targetKey = leadKey.trim() || savedGlobalKey;

            if (leadKey.trim() && leadKey.trim() !== savedGlobalKey) {
                const setGlobalParameters = typeof window !== 'undefined'
                    ? (window as any).setGlobalParameters
                    : undefined;
                if (typeof setGlobalParameters === 'function') {
                    setGlobalParameters({ key: leadKey.trim() }, graph);
                } else {
                    if (!graph.extra) graph.extra = {};
                    graph.extra.global_parameters = {
                        ...(graph.extra.global_parameters || {}),
                        key: leadKey.trim()
                    };
                }
            }

            for (const sample of samples) {
                const match = sample.properties?.key_match_mode === 'follow'
                    ? this.calculateKeyMatch(
                        String(sample.properties?.key || ''),
                        targetKey,
                        this.normalizeKeyMatchAlgorithm(sample.properties?.key_match_algorithm)
                    )
                    : null;
                sample.properties.key_match_transpose = match?.transpose ?? 0;
                sample.properties.key_match_target = match?.targetKey ?? '';
                sample.setDirtyCanvas?.(true, true);
            }
        } finally {
            this.coordinatingGraphs.delete(graph);
        }
    }

    private static normalizeKeyMatchAlgorithm(value: unknown): KeyMatchAlgorithm {
        return value === 'higher' || value === 'lower' ? value : 'nearest';
    }

    private static parseKey(value: string): ParsedKey | null {
        const match = String(value || '').trim().replace(/♯/g, '#').replace(/♭/g, 'b')
            .match(/^([A-Ga-g])([#b]?)(?:[\s_-]*(maj(?:or)?|min(?:or)?|m))?$/i);
        if (!match) return null;

        const naturalPitchClasses: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
        const accidental = match[2] === '#' ? 1 : match[2] === 'b' ? -1 : 0;
        const suffix = (match[3] || '').toLowerCase();
        const mode: MusicalMode = suffix === 'm' || suffix.startsWith('min')
            ? 'minor'
            : suffix.startsWith('maj') ? 'major' : null;
        return {
            pitchClass: (naturalPitchClasses[match[1].toUpperCase()] + accidental + 12) % 12,
            mode
        };
    }

    private static formatKey(pitchClass: number, mode: MusicalMode): string {
        const pitchNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        const suffix = mode === 'major' ? 'maj' : mode === 'minor' ? 'min' : '';
        return `${pitchNames[pitchClass]}${suffix}`;
    }

    override resolveVisualizationSignal(telemetry?: SignalTelemetry): WaveformSignal {
        const filepath = String(this.properties?.filepath || '');
        if (filepath !== this.loadedFilepath) {
            this.loadedFilepath = filepath;
            this.failedAudioFilepath = null;
            this.audioBuffer = null;
            delete (this as any).manifestStemBuffer;
            this.sharedWaveformRenderer.setSignal(null);
        }

        if (filepath && !this.audioBuffer && !this.isLoadingAudio && this.failedAudioFilepath !== filepath) {
            void this.ensureAudioLoaded();
        }

        const win = (typeof window !== 'undefined') ? (window as any) : undefined;
        const isPlaying = Boolean(telemetry?.isPlaying);
        const isPreviewTarget = this.id === win?.activeRamPreviewNodeId;
        const schedulerBuf = isPreviewTarget ? globalAudioScheduler.getFullAudioBuffer() : undefined;
        let baseBuffer = this.audioBuffer;
        if (!isPlaying && (this._liveTriggerIteration !== null || this._liveTriggeredFilepath !== null)) {
            this._liveTriggerIteration = null;
            this._liveTriggeredFilepath = null;
            if (typeof window !== 'undefined' && this.id != null) {
                window.dispatchEvent(new CustomEvent('node-properties-refreshed', {
                    detail: { nodeId: this.id, liveTelemetry: true }
                }));
            }
        }
        let displayBuffer = this.applySampleNodeGain(baseBuffer) || schedulerBuf;

        const sampleDur = displayBuffer?.duration || Number(this.properties?.duration_seconds) || 0;
        const cropStart = Number(this.properties?.crop_start ?? 0);
        const cropEnd = Number(this.properties?.crop_end ?? 1);
        const activeSpan = Math.max(0.01, cropEnd - cropStart);
        const sampleActiveDuration = sampleDur > 0 ? sampleDur * activeSpan : 2.0;

        const stretchMode = String(this.properties?.stretch_mode || 'time_stretch');
        const pitchMultiplier = Math.pow(2, Number(this.properties?.transpose || 0) / 12);
        const rawTargetBpm = Number(this.properties?.target_bpm);
        const targetBpm = (Number.isFinite(rawTargetBpm) && rawTargetBpm > 0)
            ? rawTargetBpm
            : (Number(win?.activeWorkspaceManifest?.bpm || win?.getGlobalParameter?.('bpm')) || 120);
        const originalBpm = Number(this.properties?.original_bpm || 0);
        const stretchFactor = Number(this.properties?.stretch_factor || 1.0) || 1.0;
        let effectivePitchRate = 1.0;
        if (stretchMode === 'repitch' || stretchMode === 'varispeed') {
            effectivePitchRate = pitchMultiplier > 0 ? pitchMultiplier : 1.0;
        } else if (stretchMode !== 'off' && stretchMode !== 'none') {
            const bpmRatio = (originalBpm > 0 && targetBpm > 0) ? (targetBpm / originalBpm) : 1.0;
            effectivePitchRate = (bpmRatio / Math.max(0.05, stretchFactor));
            if (!(effectivePitchRate > 0)) effectivePitchRate = 1.0;
        }

        let playbackProgress: number | undefined;
        let isTriggered: boolean | undefined;
        const slots = this.getSlots();
        const slotCount = Math.max(1, slots.length);
        let irideActiveSlot = this.activeSlotIndex;

        if (isPlaying && telemetry) {
            if (isPreviewTarget) {
                const dur = telemetry.duration > 0 ? telemetry.duration : sampleActiveDuration;
                const curTime = dur > 0 ? ((telemetry.time % dur) + dur) % dur : 0;
                const sampleTime = curTime * effectivePitchRate;
                const progress = sampleActiveDuration > 0 ? Math.max(0, Math.min(1, sampleTime / sampleActiveDuration)) : 0;
                playbackProgress = cropStart + progress * activeSpan;
                isTriggered = true;
            } else {
                const manifestEvents = ((this as any).manifestEvents as Array<{ time: number; duration: number; slot?: number; filepath?: string; iteration?: number }> | undefined)
                    || (win?.activeWorkspaceManifest?.nodes?.[String(this.id)]?.events as Array<{ time: number; duration: number; slot?: number; filepath?: string; iteration?: number }> | undefined);
                const totalTrackDur = telemetry.duration > 0
                    ? telemetry.duration
                    : (Number(win?.activeWorkspaceManifest?.total_duration) || (manifestEvents?.length ? manifestEvents[manifestEvents.length - 1].time + manifestEvents[manifestEvents.length - 1].duration : sampleActiveDuration));
                const curTime = totalTrackDur > 0 ? ((telemetry.time % totalTrackDur) + totalTrackDur) % totalTrackDur : telemetry.time;

                if (manifestEvents && manifestEvents.length > 0) {
                    let activeEvent = manifestEvents.find(e => curTime >= e.time && curTime < (e.time + Math.max(0.02, e.duration)));
                    let triggerTime = curTime;
                    if (!activeEvent && totalTrackDur > 0) {
                        let lastEventEnd = (manifestEvents as any).__maxEnd as number | undefined;
                        if (lastEventEnd === undefined) {
                            lastEventEnd = 0;
                            for (let i = 0; i < manifestEvents.length; i++) {
                                const end = manifestEvents[i].time + Math.max(0.02, manifestEvents[i].duration);
                                if (end > lastEventEnd) lastEventEnd = end;
                            }
                            (manifestEvents as any).__maxEnd = lastEventEnd;
                        }
                        if (lastEventEnd > 0 && lastEventEnd < totalTrackDur * 0.85) {
                            const barSec = 4 * (60 / targetBpm);
                            const patternBars = Math.max(1, Math.round(lastEventEnd / barSec));
                            const patternDur = Math.max(0.05, patternBars * barSec);
                            const timeInPattern = ((curTime % patternDur) + patternDur) % patternDur;
                            const loopedEvent = manifestEvents.find(e => timeInPattern >= e.time && timeInPattern < (e.time + Math.max(0.02, e.duration)));
                            if (loopedEvent) {
                                activeEvent = loopedEvent;
                                triggerTime = timeInPattern;
                            }
                        }
                    }

                    let recentEvent = activeEvent;
                    if (!recentEvent) {
                        for (let i = manifestEvents.length - 1; i >= 0; i--) {
                            if (manifestEvents[i].time <= triggerTime) {
                                recentEvent = manifestEvents[i];
                                break;
                            }
                        }
                    }

                    // 1. IRIDE canvas reactivity: follow the playing event across all slots
                    if (recentEvent) {
                        if (typeof (recentEvent as any).slot === 'number') {
                            irideActiveSlot = ((Math.trunc((recentEvent as any).slot) % slotCount) + slotCount) % slotCount;
                        }
                        const evtFp = typeof (recentEvent as any).filepath === 'string'
                            ? (recentEvent as any).filepath
                            : (slots[irideActiveSlot]?.filepath ? String(slots[irideActiveSlot].filepath) : null);
                        if (evtFp) {
                            const slotBuf = this.slotBuffers.get(irideActiveSlot);
                            const cachedEvtBuf = (slotBuf && this.slotLoadedPaths.get(irideActiveSlot) === evtFp)
                                ? slotBuf
                                : getCachedAudioBufferSync(evtFp);
                            if (cachedEvtBuf) {
                                displayBuffer = this.applySampleNodeGain(cachedEvtBuf) || displayBuffer;
                            } else {
                                void fetchAudioBuffer(evtFp);
                            }
                        }
                    }

                    // 2. Inspector live telemetry: NEVER switch slots; only update when the active slot itself has a Field Operator
                    const inspectorSlot = Math.min(Math.max(0, this.activeSlotIndex), slotCount - 1);
                    const activeSlotQuery = String(slots[inspectorSlot]?.pool_query ?? this.properties?.pool_query ?? '').trim();
                    const hasActiveSlotPoolOp = isFieldOperatorExpression(activeSlotQuery);
                    const activeSlotOps = slots[inspectorSlot]?.field_operators || this.properties?.field_operators;
                    const hasActiveSlotFieldOp = hasActiveSlotPoolOp || Boolean(activeSlotOps && Object.keys(activeSlotOps).length > 0);

                    if (hasActiveSlotFieldOp) {
                        const matchesInspectorSlot = (e: any): boolean => {
                            if (typeof e?.slot !== 'number') return true;
                            const s = ((Math.trunc(e.slot) % slotCount) + slotCount) % slotCount;
                            return s === inspectorSlot;
                        };
                        let inspectorEvent = (activeEvent && matchesInspectorSlot(activeEvent)) ? activeEvent : undefined;
                        if (!inspectorEvent) {
                            for (let i = manifestEvents.length - 1; i >= 0; i--) {
                                if (manifestEvents[i].time <= triggerTime && matchesInspectorSlot(manifestEvents[i])) {
                                    inspectorEvent = manifestEvents[i];
                                    break;
                                }
                            }
                        }
                        if (inspectorEvent) {
                            const evtIter = typeof (inspectorEvent as any).iteration === 'number' ? (inspectorEvent as any).iteration : null;
                            const evtFp = (hasActiveSlotPoolOp && typeof (inspectorEvent as any).filepath === 'string')
                                ? (inspectorEvent as any).filepath
                                : null;
                            if (evtIter !== null && (this._liveTriggerIteration !== evtIter || this._liveTriggeredFilepath !== evtFp)) {
                                this._liveTriggerIteration = evtIter;
                                this._liveTriggeredFilepath = evtFp;
                                if (typeof window !== 'undefined' && this.id != null) {
                                    window.dispatchEvent(new CustomEvent('node-properties-refreshed', {
                                        detail: { nodeId: this.id, liveTelemetry: true }
                                    }));
                                }
                            }
                        }
                    } else if (this._liveTriggerIteration !== null || this._liveTriggeredFilepath !== null) {
                        this._liveTriggerIteration = null;
                        this._liveTriggeredFilepath = null;
                    }

                    if (activeEvent) {
                        const elapsedInEvent = triggerTime - activeEvent.time;
                        const sampleTime = elapsedInEvent * effectivePitchRate;
                        const sampleProgress = sampleActiveDuration > 0 ? (sampleTime / sampleActiveDuration) : 0;
                        const eventStartNorm = typeof (activeEvent as any).sample_start === 'number' ? (activeEvent as any).sample_start : 0;
                        const isEventLoop = (activeEvent as any).loop !== undefined
                            ? Boolean((activeEvent as any).loop)
                            : (this.properties?.sample_type === 'loop');
                        const progressInCrop = isEventLoop
                            ? ((eventStartNorm + sampleProgress) % 1.0)
                            : Math.max(0, Math.min(1, eventStartNorm + sampleProgress));
                        playbackProgress = cropStart + progressInCrop * activeSpan;
                        isTriggered = true;
                    } else {
                        isTriggered = false;
                    }
                } else {
                    const startBeat = Number(this.properties?.start_beat ?? 0);
                    const startSec = startBeat * (60 / targetBpm);
                    const isLoop = this.properties?.sample_type === 'loop';

                    if (isLoop && sampleActiveDuration > 0) {
                        const offsetFromStart = curTime - startSec;
                        if (offsetFromStart >= 0) {
                            const loopCycle = (offsetFromStart * effectivePitchRate) % sampleActiveDuration;
                            const progress = Math.max(0, Math.min(1, loopCycle / sampleActiveDuration));
                            playbackProgress = cropStart + progress * activeSpan;
                            isTriggered = true;
                        } else {
                            isTriggered = false;
                        }
                    } else {
                        const endSec = startSec + (sampleActiveDuration / effectivePitchRate);
                        if (curTime >= startSec && curTime <= endSec) {
                            const elapsed = curTime - startSec;
                            const progress = Math.max(0, Math.min(1, (elapsed * effectivePitchRate) / sampleActiveDuration));
                            playbackProgress = cropStart + progress * activeSpan;
                            isTriggered = true;
                        } else {
                            isTriggered = false;
                        }
                    }
                }
            }
        }

        return {
            buffer: displayBuffer,
            duration: sampleActiveDuration,
            cropStart,
            cropEnd,
            accentColor: this.nodeColor,
            playbackProgress,
            isTriggered,
            bufferedProgress: 1.0,
            isInvalidated: false,
            slotCount: slots.length,
            activeSlot: irideActiveSlot
        };
    }

    override getLiveActivityState(telemetry?: SignalTelemetry): { isTriggered: boolean; progress?: number } {
        if (!telemetry?.isPlaying) return { isTriggered: false };
        const isPreviewTarget = typeof window !== 'undefined' && this.id === (window as any).activeRamPreviewNodeId;
        const sampleDur = this.audioBuffer?.duration || Number(this.properties?.duration_seconds) || 2.0;
        const cropStart = Number(this.properties?.crop_start ?? 0);
        const cropEnd = Number(this.properties?.crop_end ?? 1);
        const activeSpan = Math.max(0.01, cropEnd - cropStart);
        const sampleActiveDuration = sampleDur > 0 ? sampleDur * activeSpan : 2.0;
        const dur = telemetry.duration > 0 ? telemetry.duration : sampleActiveDuration;
        const curTime = dur > 0 ? ((telemetry.time % dur) + dur) % dur : 0;

        if (isPreviewTarget) {
            return {
                isTriggered: true,
                progress: sampleActiveDuration > 0 ? Math.max(0, Math.min(1, (curTime % sampleActiveDuration) / sampleActiveDuration)) : 0
            };
        }

        const isLoop = this.properties?.sample_type === 'loop';
        if (isLoop && sampleActiveDuration > 0) {
            return {
                isTriggered: true,
                progress: Math.max(0, Math.min(1, (curTime % sampleActiveDuration) / sampleActiveDuration))
            };
        }

        const progress = dur > 0 ? Math.max(0, Math.min(1, curTime / dur)) : 0;
        return { isTriggered: true, progress };
    }

    override onVisualizationToggled(enabled: boolean): void {
        if (enabled) {
            const filepath = String(this.properties?.filepath || '');
            if (filepath && !this.audioBuffer && !this.isLoadingAudio) {
                void this.ensureAudioLoaded();
            }
        }
    }
}

(SampleNode as any).title = "Sample";
LiteGraph.registerNodeType("Audio/Sample", SampleNode);
