import { LiteGraph } from 'litegraph.js';
import { BaseNode, DEFAULT_SAMPLE_INPUT_GAIN_DB, getDefaultFxChain, type NodeToolbarControl } from './BaseNode.ts';
import { type FieldSchema } from '../fields/FieldSchema.ts';
import { type NodePanelSchema } from '../fields/NodePanelSchema.ts';
import { findLibraryFileForSnapshot, resolveLibraryAssets, submitLibraryMetadataProposal, type LibraryFile } from '../api.ts';
import {
    drawClosedSlotIndex,
    drawHeaderSlotPill,
    type SignalTelemetry,
    type WaveformSignal,
    type VisualizationTypeId
} from '../../../packages/iride/src/index.ts';
import { fetchAudioBuffer, fetchAudioPeaks, getCachedAudioBufferSync } from '../audioBufferCache.ts';
import { AUDIO_POSITION_UNITS } from '../fields/UnitConverter.ts';
import { getNodeGainMultiplier, applyGainToBuffer } from '../audioCompositor.ts';
import { getUserFxStages } from '../dsp/processorRegistry.ts';
import { globalAudioScheduler } from '../audioScheduler.ts';
import {
    type NodeSlot,
    copyNodeSlotToClipboard,
    deduplicatePoolItemName,
    formatPoolListExpression,
    getCopiedNodeSlotFromClipboard,
    getPoolItemCallName,
    getPoolItemIdentityKey,
    isCalculatedPoolQuery,
    isExternalPoolItem,
    isFieldOperatorExpression,
    resolveModifierSlotSeeds
} from '../../../ermes/ts/slotLanguage.ts';
import { populateOwnerSlotsFromPool, resolveEffectivePoolSeed, resolvePoolItemByQuery, parseBpmFromFilename } from '../../../ermes/ts/assetResolver.ts';

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
        'is_external',
        'duration_seconds',
        'repeat',
        'warp',
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
        'field_units',
    ] as const;

    public audioBuffer: AudioBuffer | null = null;
    public slotBuffers: Map<number, AudioBuffer> = new Map();
    private slotLoadedPaths: Map<number, string> = new Map();
    public audioPeaks: Float32Array | null = null;
    public slotPeaks: Map<number, Float32Array> = new Map();
    private slotPeakPaths: Map<number, string> = new Map();
    private slotPeakDurations: Map<number, number> = new Map();
    public activeSlotIndex = 0;
    public selectedSlotIndices: number[] = [0];
    public loadedFilepath = '';
    public loadedPeaksFilepath = '';
    public isLoadingAudio = false;
    public isLoadingPeaks = false;
    private loadingAudioPromise: Promise<AudioBuffer | null> | null = null;
    private loadingPeaksPromise: Promise<Float32Array | null> | null = null;
    private failedAudioFilepath: string | null = null;
    private failedPeaksFilepath: string | null = null;

    public getActivePeakDuration(): number {
        return this.slotPeakDurations.get(this.activeSlotIndex) || 0;
    }

    public static inferLoadDefaults(item: {
        is_loop?: boolean | null;
        itemType?: string;
        sample_type?: string;
        tags?: string[];
        bpm?: number | null;
        duration_seconds?: number | null;
        filepath?: string;
    }): { repeat: boolean; warp: boolean; sample_type: 'loop' | 'one_shot'; stretch_mode: 'time_stretch' | 'pitch_shift' } {
        const tags = Array.isArray(item.tags) ? item.tags : [];
        const isExplicitLoop = item.is_loop === true
            || item.itemType === 'loop'
            || item.sample_type === 'loop'
            || tags.includes('Loop');
        if (isExplicitLoop) {
            return { repeat: true, warp: true, sample_type: 'loop', stretch_mode: 'time_stretch' };
        }
        const isExplicitOneShot = item.is_loop === false
            || item.itemType === 'one_shot'
            || item.sample_type === 'one_shot'
            || tags.includes('One shot');
        const durSec = Number(item.duration_seconds ?? 0);
        if (isExplicitOneShot || (Number.isFinite(durSec) && durSec > 30)) {
            return { repeat: false, warp: false, sample_type: 'one_shot', stretch_mode: 'pitch_shift' };
        }
        const rawBpm = Number(item.bpm);
        const hasBpm = (Number.isFinite(rawBpm) && rawBpm >= 20 && rawBpm <= 400)
            || Boolean(item.filepath && parseBpmFromFilename(item.filepath) != null);
        if (hasBpm && (!Number.isFinite(durSec) || durSec <= 30)) {
            return { repeat: false, warp: true, sample_type: 'one_shot', stretch_mode: 'time_stretch' };
        }
        return { repeat: false, warp: false, sample_type: 'one_shot', stretch_mode: 'pitch_shift' };
    }

    public isRepeatEnabled(slot?: NodeSlot): boolean {
        if (slot && slot.repeat !== undefined) return Boolean(slot.repeat);
        if (this.properties && this.properties.repeat !== undefined) return Boolean(this.properties.repeat);
        const st = String(slot?.sample_type ?? this.properties?.sample_type ?? 'one_shot').toLowerCase();
        return st === 'loop';
    }

    public isWarpEnabled(slot?: NodeSlot): boolean {
        if (slot && slot.warp !== undefined) return Boolean(slot.warp);
        if (this.properties && this.properties.warp !== undefined) return Boolean(this.properties.warp);
        const mode = String(slot?.stretch_mode ?? this.properties?.stretch_mode ?? '').toLowerCase();
        if (mode === 'pitch_shift' || mode === 'repitch' || mode === 'varispeed' || mode === 'off') {
            return false;
        }
        const st = String(slot?.sample_type ?? this.properties?.sample_type ?? 'one_shot').toLowerCase();
        return st !== 'one_shot' && st !== 'oneshot';
    }

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
        const repeat = this.properties?.repeat !== undefined
            ? Boolean(this.properties.repeat)
            : (base?.repeat !== undefined ? Boolean(base.repeat) : (String(this.properties?.sample_type ?? base?.sample_type ?? 'one_shot').toLowerCase() === 'loop'));
        const warp = this.properties?.warp !== undefined
            ? Boolean(this.properties.warp)
            : (base?.warp !== undefined ? Boolean(base.warp) : this.isWarpEnabled(base));
        return {
            ...(base || {}),
            slot: slotIndex,
            index: slotIndex,
            pool_query: this.properties?.pool_query !== undefined ? String(this.properties.pool_query) : base?.pool_query,
            filepath: String(this.properties?.filepath ?? base?.filepath ?? ''),
            library_item_id: this.properties?.library_item_id ?? base?.library_item_id,
            is_external: this.properties?.is_external !== undefined
                ? Boolean(this.properties.is_external)
                : Boolean(base?.is_external || String(this.properties?.library_item_id ?? base?.library_item_id ?? '').startsWith('ext:')),
            duration_seconds: this.properties?.duration_seconds ?? base?.duration_seconds,
            repeat,
            warp,
            sample_type: repeat ? 'loop' : 'one_shot',
            start_beat: Number(this.properties?.start_beat ?? base?.start_beat ?? 0),
            original_bpm: this.properties?.original_bpm ?? base?.original_bpm ?? null,
            target_bpm: this.properties?.target_bpm ?? base?.target_bpm ?? 'global',
            key: String(this.properties?.key ?? base?.key ?? ''),
            key_match_mode: this.properties?.key_match_mode ?? base?.key_match_mode ?? 'off',
            key_match_algorithm: this.properties?.key_match_algorithm ?? base?.key_match_algorithm ?? 'nearest',
            transpose,
            pitch_shift: transpose,
            cents: Number(this.properties?.cents ?? base?.cents ?? 0),
            stretch_mode: warp ? 'time_stretch' : 'pitch_shift',
            stretch_algorithm: this.properties?.stretch_algorithm ?? base?.stretch_algorithm ?? 'rubberband',
            stretch_factor: stretchFactor,
            time_stretch: stretchFactor,
            crop_start: cropStart,
            crop_end: cropEnd,
            sample_start: cropStart,
            sample_end: cropEnd,
            field_units: this.properties?.field_units && typeof this.properties.field_units === 'object'
                ? { ...this.properties.field_units }
                : (base?.field_units ? { ...base.field_units } : {}),
            field_operators: this.properties?.field_operators && typeof this.properties.field_operators === 'object'
                ? { ...this.properties.field_operators }
                : (base?.field_operators ? { ...base.field_operators } : {}),
            field_static_values: this.properties?.field_static_values && typeof this.properties.field_static_values === 'object'
                ? { ...this.properties.field_static_values }
                : (base?.field_static_values ? { ...base.field_static_values } : {}),
            field_dynamic_expressions: this.properties?.field_dynamic_expressions && typeof this.properties.field_dynamic_expressions === 'object'
                ? { ...this.properties.field_dynamic_expressions }
                : (base?.field_dynamic_expressions ? { ...base.field_dynamic_expressions } : {}),
            field_dynamic_enabled: this.properties?.field_dynamic_enabled && typeof this.properties.field_dynamic_enabled === 'object'
                ? { ...this.properties.field_dynamic_enabled }
                : (base?.field_dynamic_enabled ? { ...base.field_dynamic_enabled } : {}),
        };
    }

    private getSlotPropertyValue(slot: NodeSlot | undefined, key: string): any {
        if (!slot) return undefined;
        if (key === 'repeat') {
            return slot.repeat !== undefined ? Boolean(slot.repeat) : (String(slot.sample_type ?? 'one_shot').toLowerCase() === 'loop');
        }
        if (key === 'warp') {
            return this.isWarpEnabled(slot);
        }
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
        if (key === 'repeat') {
            const b = Boolean(value);
            slot.repeat = b;
            slot.sample_type = b ? 'loop' : 'one_shot';
        } else if (key === 'sample_type') {
            const b = String(value).toLowerCase() === 'loop';
            slot.sample_type = b ? 'loop' : 'one_shot';
            slot.repeat = b;
        } else if (key === 'warp') {
            const b = Boolean(value);
            slot.warp = b;
            slot.stretch_mode = b ? 'time_stretch' : 'pitch_shift';
        } else if (key === 'stretch_mode') {
            const s = String(value || '').toLowerCase();
            slot.stretch_mode = s;
            slot.warp = s === 'time_stretch';
        } else if (key === 'transpose' || key === 'pitch_shift') {
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
                    this.slotPeaks.delete(idx);
                    this.slotPeakPaths.delete(idx);
                    this.slotPeakDurations.delete(idx);
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
        this.properties.is_external = Boolean(slot.is_external || String(slot.library_item_id ?? '').startsWith('ext:'));
        if (slot.duration_seconds !== undefined) this.properties.duration_seconds = slot.duration_seconds;
        const repeat = slot.repeat !== undefined
            ? Boolean(slot.repeat)
            : (slot.sample_type !== undefined ? String(slot.sample_type).toLowerCase() === 'loop' : this.isRepeatEnabled());
        const warp = slot.warp !== undefined
            ? Boolean(slot.warp)
            : this.isWarpEnabled(slot);
        this.properties.repeat = repeat;
        this.properties.warp = warp;
        this.properties.sample_type = repeat ? 'loop' : 'one_shot';
        this.properties.stretch_mode = warp ? 'time_stretch' : 'pitch_shift';
        if (slot.start_beat !== undefined) this.properties.start_beat = Number(slot.start_beat);
        if (slot.original_bpm !== undefined) this.properties.original_bpm = slot.original_bpm;
        if (slot.target_bpm !== undefined) this.properties.target_bpm = slot.target_bpm;
        if (slot.key !== undefined) this.properties.key = slot.key;
        if (slot.key_match_mode !== undefined) this.properties.key_match_mode = slot.key_match_mode;
        if (slot.key_match_algorithm !== undefined) this.properties.key_match_algorithm = slot.key_match_algorithm;
        if (slot.cents !== undefined) this.properties.cents = Number(slot.cents);
        if (slot.stretch_algorithm !== undefined) this.properties.stretch_algorithm = slot.stretch_algorithm;
        const cropStart = slot.crop_start ?? slot.sample_start;
        const cropEnd = slot.crop_end ?? slot.sample_end;
        if (cropStart !== undefined) this.properties.crop_start = Number(cropStart);
        if (cropEnd !== undefined) this.properties.crop_end = Number(cropEnd);
        const transpose = slot.transpose ?? slot.pitch_shift;
        const stretchFactor = slot.stretch_factor ?? slot.time_stretch;
        if (transpose !== undefined) this.properties.transpose = Number(transpose);
        if (stretchFactor !== undefined) this.properties.stretch_factor = Number(stretchFactor);
        if (slot.field_units && typeof slot.field_units === 'object') {
            this.properties.field_units = { ...slot.field_units };
        }
        this.properties.field_operators = slot.field_operators && typeof slot.field_operators === 'object'
            ? { ...slot.field_operators }
            : {};
        this.properties.field_static_values = slot.field_static_values && typeof slot.field_static_values === 'object'
            ? { ...slot.field_static_values }
            : {};
        this.properties.field_dynamic_expressions = slot.field_dynamic_expressions && typeof slot.field_dynamic_expressions === 'object'
            ? { ...slot.field_dynamic_expressions }
            : {};
        this.properties.field_dynamic_enabled = slot.field_dynamic_enabled && typeof slot.field_dynamic_enabled === 'object'
            ? { ...slot.field_dynamic_enabled }
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
            trackData.repeat = this.properties.repeat;
            trackData.warp = this.properties.warp;
            trackData.sample_type = this.properties.sample_type;
            trackData.stretch_mode = this.properties.stretch_mode;
            trackData.active_slot = this.activeSlotIndex;
        }

        const cachedBuf = this.slotBuffers.get(this.activeSlotIndex);
        const cachedPath = this.slotLoadedPaths.get(this.activeSlotIndex);
        const cachedPeaks = this.slotPeaks.get(this.activeSlotIndex);
        const cachedPeakPath = this.slotPeakPaths.get(this.activeSlotIndex);
        if (cachedPeaks && this.properties.filepath && cachedPeakPath === this.properties.filepath) {
            this.audioPeaks = cachedPeaks;
            this.loadedPeaksFilepath = this.properties.filepath;
        } else {
            this.audioPeaks = null;
            this.loadedPeaksFilepath = '';
        }
        if (cachedBuf && this.properties.filepath && cachedPath === this.properties.filepath) {
            this.audioBuffer = cachedBuf;
            this.loadedFilepath = this.properties.filepath;
        } else {
            this.audioBuffer = null;
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

    override setStaticFieldValue(key: string, value: any): void {
        super.setStaticFieldValue(key, value);
        const slots = this.getSlots();
        const selected = this.getSelectedSlotIndices();
        for (const idx of selected) {
            const slot = slots[idx];
            if (!slot) continue;
            if (!slot.field_static_values || typeof slot.field_static_values !== 'object') {
                slot.field_static_values = {};
            }
            if (value === undefined) delete slot.field_static_values[key];
            else slot.field_static_values[key] = value;
        }
    }

    override setSavedDynamicExpression(key: string, expr: string): void {
        super.setSavedDynamicExpression(key, expr);
        const slots = this.getSlots();
        const selected = this.getSelectedSlotIndices();
        const trimmed = String(expr ?? '').trim();
        for (const idx of selected) {
            const slot = slots[idx];
            if (!slot) continue;
            if (!slot.field_dynamic_expressions || typeof slot.field_dynamic_expressions !== 'object') {
                slot.field_dynamic_expressions = {};
            }
            if (trimmed) slot.field_dynamic_expressions[key] = trimmed;
            else delete slot.field_dynamic_expressions[key];
        }
    }

    override setFieldDynamicActive(key: string, active: boolean): void {
        super.setFieldDynamicActive(key, active);
        const slots = this.getSlots();
        const selected = this.getSelectedSlotIndices();
        for (const idx of selected) {
            const slot = slots[idx];
            if (!slot) continue;
            if (!slot.field_dynamic_enabled || typeof slot.field_dynamic_enabled !== 'object') {
                slot.field_dynamic_enabled = {};
            }
            slot.field_dynamic_enabled[key] = Boolean(active);
        }
    }

    override setFieldOperator(key: string, expr: string): void {
        super.setFieldOperator(key, expr);
        const slots = this.getSlots();
        const selected = this.getSelectedSlotIndices();
        const trimmed = String(expr ?? '').trim();
        const isOp = key === 'pool_query'
            ? isCalculatedPoolQuery(trimmed, this.getPoolItems())
            : isFieldOperatorExpression(trimmed);
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

    public isActiveAssetExternal(): boolean {
        const slots = this.getSlots();
        const activeSlot = slots[this.activeSlotIndex];
        return Boolean(
            this.properties?.is_external
            || activeSlot?.is_external
            || String(this.properties?.library_item_id ?? activeSlot?.library_item_id ?? '').startsWith('ext:')
        );
    }

    override evaluateAllFieldOperators(triggerOverride?: number): void {
        const triggerCount = triggerOverride !== undefined ? triggerOverride : this.getTriggerCount();
        const slots = this.getSlots();
        const poolItems = this.getPoolItems();
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
        const savedActive = this.activeSlotIndex;
        const savedSelected = [...this.getSelectedSlotIndices()];
        let anyPoolResolved = false;
        for (let idx = 0; idx < slots.length; idx++) {
            const slotQuery = String(slots[idx]?.pool_query ?? (idx === savedActive ? this.properties?.pool_query : '') ?? '').trim();
            if (isCalculatedPoolQuery(slotQuery, poolItems)) {
                this.activeSlotIndex = idx;
                this.selectedSlotIndices = [idx];
                if (this.applyPoolQuery(slotQuery, false)) {
                    anyPoolResolved = true;
                }
            }
        }
        this.activeSlotIndex = savedActive;
        this.selectedSlotIndices = savedSelected;
        this.properties.active_slot = savedActive;
        if (slots[this.activeSlotIndex]) {
            this.applySlotToProperties(slots[this.activeSlotIndex]);
        }
        if (anyPoolResolved) {
            this.invalidateDownstreamVisualCaches();
        }
    }

    public ensureItemsInPool(items: any[]): any[] {
        if (!Array.isArray(items) || items.length === 0) return [];
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
            : (Array.isArray(this.properties.selected_items) ? [...this.properties.selected_items] : []);
        const byKey = new Map<string, any>();
        for (const it of existing) {
            const k = getPoolItemIdentityKey(it);
            if (k) byKey.set(k, it);
        }
        const registered: any[] = [];
        for (const it of items) {
            const fp = String(it?.filepath || it?.absolute_path || '').trim();
            if (!fp) continue;
            const isExt = isExternalPoolItem(it) || (!it?.id && !String(it?.id ?? '').trim());
            const candidateKey = getPoolItemIdentityKey({ ...it, filepath: fp, absolute_path: fp });
            const existingEntry = candidateKey ? byKey.get(candidateKey) : undefined;
            if (existingEntry) {
                if (it?.bpm != null && existingEntry.bpm == null) existingEntry.bpm = it.bpm;
                if (it?.key != null && !existingEntry.key) existingEntry.key = it.key;
                if (it?.duration_seconds != null && existingEntry.duration_seconds == null) {
                    existingEntry.duration_seconds = it.duration_seconds;
                }
                if (isExt && !existingEntry.is_external) {
                    existingEntry.is_external = true;
                    existingEntry.source = 'external';
                }
                registered.push(existingEntry);
                continue;
            }
            const currentValues = [...byKey.values()];
            const rawBaseName = getPoolItemCallName({ ...it, filepath: fp, absolute_path: fp }, false);
            const uniqueName = deduplicatePoolItemName(rawBaseName, currentValues);
            const poolItem = {
                id: it?.id != null && String(it.id).trim() ? it.id : `ext:${fp}`,
                filepath: fp,
                absolute_path: fp,
                name: uniqueName,
                type: it?.itemType || it?.type || 'audio',
                is_external: isExt,
                source: isExt ? 'external' : 'gaia',
                bpm: it?.bpm ?? null,
                key: it?.key ?? null,
                duration_seconds: it?.duration_seconds ?? null,
            };
            const k = getPoolItemIdentityKey(poolItem);
            if (k) byKey.set(k, poolItem);
            registered.push(poolItem);
        }
        const merged = [...byKey.values()];
        targetContainer.selected_items = merged;
        if (this.properties !== targetContainer) {
            this.properties.selected_items = merged;
        }
        if (modNode?.properties && modNode.properties !== targetContainer) {
            modNode.properties.selected_items = merged;
        }
        return registered;
    }

    public renamePoolItem(itemKeyOrId: string, nextName: string): boolean {
        const clean = String(nextName || '').trim();
        if (!clean) return false;
        const modNode = this.getAttachedPoolNode();
        const items = [...this.getPoolItems()];
        const idx = items.findIndex(it =>
            getPoolItemIdentityKey(it) === itemKeyOrId
            || (it?.id != null && String(it.id) === itemKeyOrId)
        );
        if (idx === -1) return false;
        const target = items[idx];
        const prevName = String(target.name || '');
        const uniqueName = deduplicatePoolItemName(clean, items, getPoolItemIdentityKey(target));
        if (uniqueName === prevName) return false;
        target.name = uniqueName;
        if (modNode?.properties) modNode.properties.selected_items = items;
        if (this.properties) this.properties.selected_items = items;

        const slots = this.getSlots();
        const prevLower = prevName.trim().toLowerCase();
        for (const slot of slots) {
            if (String(slot?.pool_query || '').trim().toLowerCase() === prevLower) {
                slot.pool_query = uniqueName;
            }
        }
        if (String(this.properties?.pool_query || '').trim().toLowerCase() === prevLower) {
            this.properties.pool_query = uniqueName;
        }
        if (typeof window !== 'undefined' && this.id != null) {
            window.dispatchEvent(new CustomEvent('node-properties-refreshed', { detail: { nodeId: this.id } }));
        }
        return true;
    }

    public async createSlotsFromDroppedItems(items: any[], startSlotIndex?: number): Promise<void> {
        if (!Array.isArray(items) || items.length === 0) return;
        this.syncActiveSlotFromProperties();
        const registeredItems = this.ensureItemsInPool(items);
        if (registeredItems.length === 0) return;

        const slots = this.getSlots();
        const isSingleEmptySlot = slots.length === 1 && !slots[0]?.filepath;
        const baseIdx = startSlotIndex !== undefined
            ? Math.max(0, startSlotIndex)
            : (isSingleEmptySlot ? 0 : slots.length);

        const targetIndices: number[] = [];
        for (let i = 0; i < registeredItems.length; i++) {
            targetIndices.push(baseIdx + i);
        }

        const assignedPool = this.getAttachedPoolNode();
        for (let i = 0; i < targetIndices.length; i++) {
            const slotIdx = targetIndices[i];
            const rawItem = items[i] || registeredItems[i];
            const regItem = registeredItems[i];
            while (slots.length <= slotIdx) {
                const template = slots[slots.length - 1] || slots[0] || {};
                const nextIdx = slots.length;
                slots.push({
                    ...template,
                    slot: nextIdx,
                    index: nextIdx,
                });
            }
            const filepath = String(regItem.filepath || regItem.absolute_path || '');
            const callName = getPoolItemCallName(regItem, false);
            const bpm = Number.isFinite(Number(regItem.bpm ?? rawItem.bpm))
                ? Number(regItem.bpm ?? rawItem.bpm)
                : parseBpmFromFilename(filepath);
            const durSec = Number(regItem.duration_seconds ?? rawItem.duration_seconds ?? 0);
            const inferred = SampleNode.inferLoadDefaults({
                is_loop: regItem.is_loop ?? rawItem.is_loop,
                itemType: rawItem.itemType,
                sample_type: regItem.sample_type ?? rawItem.sample_type,
                tags: regItem.tags ?? rawItem.tags,
                bpm,
                duration_seconds: durSec > 0 ? durSec : null,
                filepath,
            });
            const prevSlotStatic = (slots[slotIdx]?.field_static_values && typeof slots[slotIdx].field_static_values === 'object')
                ? { ...slots[slotIdx].field_static_values }
                : {};
            prevSlotStatic.pool_query = callName;
            const prevSlotDynEnabled = (slots[slotIdx]?.field_dynamic_enabled && typeof slots[slotIdx].field_dynamic_enabled === 'object')
                ? { ...slots[slotIdx].field_dynamic_enabled }
                : {};
            prevSlotDynEnabled.pool_query = false;
            slots[slotIdx] = {
                ...(slots[slotIdx] || {}),
                slot: slotIdx,
                index: slotIdx,
                pool_query: callName,
                field_static_values: prevSlotStatic,
                field_dynamic_enabled: prevSlotDynEnabled,
                filepath,
                library_item_id: regItem.id ?? slots[slotIdx]?.library_item_id,
                is_external: isExternalPoolItem(regItem),
                source: isExternalPoolItem(regItem) ? 'external' : 'gaia',
                repeat: inferred.repeat,
                warp: inferred.warp,
                sample_type: inferred.sample_type,
                stretch_mode: inferred.stretch_mode,
                original_bpm: bpm ?? null,
                key: regItem.key ? String(regItem.key) : '',
                ...(Number.isFinite(Number(regItem.duration_seconds)) && Number(regItem.duration_seconds) > 0
                    ? { duration_seconds: Number(regItem.duration_seconds) }
                    : {}),
            };
            this.slotBuffers.delete(slotIdx);
            this.slotLoadedPaths.delete(slotIdx);
            this.slotPeaks.delete(slotIdx);
            this.slotPeakPaths.delete(slotIdx);
            this.slotPeakDurations.delete(slotIdx);
        }

        this.activeSlotIndex = baseIdx;
        this.selectedSlotIndices = targetIndices;
        this.properties.active_slot = this.activeSlotIndex;
        this.applySlotToProperties(slots[this.activeSlotIndex]);
        SampleNode.propagateKeyMatch(this.graph);
        this.invalidateDownstreamVisualCaches();

        if (registeredItems[0]?.name && (!this.properties?.node_name || this.properties.node_name === 'New Sample' || this.properties.node_name === 'Sample')) {
            this.updateProperty('node_name', registeredItems[0].name);
        }
        if (assignedPool?.properties) {
            assignedPool.properties.output_value = this.properties.filepath;
            if (registeredItems[0]?.id != null) assignedPool.properties.output_item_id = registeredItems[0].id;
        }
        if (typeof window !== 'undefined' && this.id != null) {
            window.dispatchEvent(new CustomEvent('arrangement-source-changed', { detail: { nodeId: this.id } }));
            window.dispatchEvent(new CustomEvent('node-properties-refreshed', { detail: { nodeId: this.id } }));
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

        // Multiple items dropped onto a slot pill, waveform, or title field -> add to pool and write name list operator
        if (items.length > 1) {
            this.syncActiveSlotFromProperties();
            const registered = this.ensureItemsInPool(items);
            if (registered.length === 0) return;
            if (!this.properties) this.properties = {};
            this.properties.trigger_count = 0;
            if (startSlotIndex !== undefined) {
                this.selectSlot(startSlotIndex);
            }
            const listExpr = formatPoolListExpression(registered, 'plain', false);
            this.applyPoolQuery(listExpr, false);
            return;
        }

        // Single item dropped onto a slot pill, waveform, or title field -> ensure in pool and call directly by string name
        this.syncActiveSlotFromProperties();
        const registered = this.ensureItemsInPool([items[0]]);
        const regItem = registered[0];
        if (!regItem) return;

        const slots = this.getSlots();
        const baseIdx = startSlotIndex !== undefined
            ? Math.max(0, startSlotIndex)
            : Math.min(Math.max(0, this.activeSlotIndex), slots.length - 1);

        const targetIndices: number[] = startSlotIndex === undefined && this.getSelectedSlotIndices().length > 1
            ? [...this.getSelectedSlotIndices()]
            : [baseIdx];

        const assignedPool = this.getAttachedPoolNode();
        const rawItem = items[0];
        const callName = getPoolItemCallName(regItem, false);

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
            const filepath = String(regItem.filepath || regItem.absolute_path || '');
            const bpm = Number.isFinite(Number(regItem.bpm ?? rawItem.bpm))
                ? Number(regItem.bpm ?? rawItem.bpm)
                : parseBpmFromFilename(filepath);
            const durSec = Number(regItem.duration_seconds ?? rawItem.duration_seconds ?? 0);
            const inferred = SampleNode.inferLoadDefaults({
                is_loop: regItem.is_loop ?? rawItem.is_loop,
                itemType: rawItem.itemType,
                sample_type: regItem.sample_type ?? rawItem.sample_type,
                tags: regItem.tags ?? rawItem.tags,
                bpm,
                duration_seconds: durSec > 0 ? durSec : null,
                filepath,
            });
            const prevSlotStatic = (slots[slotIdx]?.field_static_values && typeof slots[slotIdx].field_static_values === 'object')
                ? { ...slots[slotIdx].field_static_values }
                : {};
            prevSlotStatic.pool_query = callName;
            const prevSlotDynEnabled = (slots[slotIdx]?.field_dynamic_enabled && typeof slots[slotIdx].field_dynamic_enabled === 'object')
                ? { ...slots[slotIdx].field_dynamic_enabled }
                : {};
            prevSlotDynEnabled.pool_query = false;
            slots[slotIdx] = {
                ...(slots[slotIdx] || {}),
                slot: slotIdx,
                index: slotIdx,
                pool_query: callName,
                field_static_values: prevSlotStatic,
                field_dynamic_enabled: prevSlotDynEnabled,
                filepath,
                library_item_id: regItem.id ?? slots[slotIdx]?.library_item_id,
                is_external: isExternalPoolItem(regItem),
                source: isExternalPoolItem(regItem) ? 'external' : 'gaia',
                repeat: inferred.repeat,
                warp: inferred.warp,
                sample_type: inferred.sample_type,
                stretch_mode: inferred.stretch_mode,
                original_bpm: bpm ?? null,
                key: regItem.key ? String(regItem.key) : '',
                ...(Number.isFinite(Number(regItem.duration_seconds)) && Number(regItem.duration_seconds) > 0
                    ? { duration_seconds: Number(regItem.duration_seconds) }
                    : {}),
            };
            this.slotBuffers.delete(slotIdx);
            this.slotLoadedPaths.delete(slotIdx);
            this.slotPeaks.delete(slotIdx);
            this.slotPeakPaths.delete(slotIdx);
            this.slotPeakDurations.delete(slotIdx);
        }

        this.activeSlotIndex = baseIdx;
        this.selectedSlotIndices = startSlotIndex !== undefined ? [baseIdx] : this.getSelectedSlotIndices();
        this.properties.active_slot = this.activeSlotIndex;
        this.applySlotToProperties(slots[this.activeSlotIndex]);
        SampleNode.propagateKeyMatch(this.graph);
        this.invalidateDownstreamVisualCaches();

        if (regItem?.name && (!this.properties?.node_name || this.properties.node_name === 'New Sample' || this.properties.node_name === 'Sample')) {
            this.updateProperty('node_name', regItem.name);
        }
        if (assignedPool?.properties) {
            assignedPool.properties.output_value = this.properties.filepath;
            if (regItem?.id != null) assignedPool.properties.output_item_id = regItem.id;
        }
        if (typeof window !== 'undefined' && this.id != null) {
            window.dispatchEvent(new CustomEvent('arrangement-source-changed', { detail: { nodeId: this.id } }));
            window.dispatchEvent(new CustomEvent('node-properties-refreshed', { detail: { nodeId: this.id } }));
        }
        void this.preloadAllSlotBuffers();
    }

    public applyPoolQuery(
        rawQuery: string,
        advanceSaltOnRand: boolean = true,
        options?: { forceStatic?: boolean; forceDynamic?: boolean }
    ): boolean {
        const query = String(rawQuery ?? '').trim();
        const rawItems = this.getPoolItems();
        const prevQuery = String(this.properties?.pool_query ?? '').trim();
        const curFp = String(this.properties?.filepath ?? '').trim();
        const curBase = (curFp.split(/[\\/]/).pop() || '').toLowerCase();
        const curBaseStem = curBase.replace(/\.[^.]+$/, '');
        const matchesCurrentFile = Boolean(
            query && curFp && (
                query.toLowerCase() === curBase
                || query.toLowerCase() === curBaseStem
                || query.toLowerCase() === curFp.toLowerCase()
            )
        );
        const nextIsCalc = options?.forceStatic
            ? false
            : (options?.forceDynamic ? true : (!matchesCurrentFile && isCalculatedPoolQuery(query, rawItems)));
        const prevIsCalc = this.isFieldDynamicActive('pool_query');
        if (nextIsCalc) {
            if (!prevIsCalc && prevQuery) {
                this.setStaticFieldValue('pool_query', prevQuery);
            }
            this.setSavedDynamicExpression('pool_query', query);
            this.setFieldDynamicActive('pool_query', true);
        } else {
            this.setStaticFieldValue('pool_query', query);
            this.setFieldDynamicActive('pool_query', false);
        }
        this.updateProperty('pool_query', query);
        const modNode = this.getAttachedPoolNode();
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
        const poolSeed = resolveEffectivePoolSeed(modNode, this);
        const poolNodeId = this.getPoolSalt();
        const fieldSeed = this.getEffectiveSeed();
        const isDynamicOp = isFieldOperatorExpression(query, items);

        let anyMatched = false;
        for (const idx of targets) {
            slots[idx] = {
                ...(slots[idx] || {}),
                pool_query: query
            };
            const evalSeed = isDynamicOp ? fieldSeed : (isSequential ? slotSeeds[0] : slotSeeds[idx]);
            const chosen = resolvePoolItemByQuery(
                items,
                query,
                idx,
                evalSeed,
                isSequential,
                triggerCount,
                { seed: evalSeed, poolSeed, nodeId: poolNodeId, triggerCount }
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
                is_external: isExternalPoolItem(chosen),
                source: isExternalPoolItem(chosen) ? 'external' : 'gaia',
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
        SampleNode.propagateKeyMatch(this.graph);
        this.invalidateDownstreamVisualCaches();
        if (modNode?.properties) {
            modNode.properties.output_value = activeSlot.filepath;
            if (activeSlot.library_item_id != null) modNode.properties.output_item_id = activeSlot.library_item_id;
        }
        if (typeof window !== 'undefined' && this.id != null) {
            window.dispatchEvent(new CustomEvent('arrangement-source-changed', { detail: { nodeId: this.id } }));
            window.dispatchEvent(new CustomEvent('node-properties-refreshed', { detail: { nodeId: this.id } }));
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
        this.slotPeaks.clear();
        this.slotPeakPaths.clear();
        this.slotPeakDurations.clear();
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

    public async ensurePeaksLoaded(filepathOverride?: string, slotIdx?: number): Promise<Float32Array | null> {
        const filepath = String(filepathOverride ?? this.properties?.filepath ?? '');
        const targetSlot = slotIdx !== undefined ? slotIdx : this.activeSlotIndex;
        if (!filepath) {
            if (targetSlot === this.activeSlotIndex) {
                this.audioPeaks = null;
                this.loadedPeaksFilepath = '';
            }
            return null;
        }
        const cachedSlotPeaks = this.slotPeaks.get(targetSlot);
        if (cachedSlotPeaks && this.slotPeakPaths.get(targetSlot) === filepath) {
            if (targetSlot === this.activeSlotIndex) {
                this.audioPeaks = cachedSlotPeaks;
                this.loadedPeaksFilepath = filepath;
            }
            return cachedSlotPeaks;
        }
        if (targetSlot === this.activeSlotIndex && this.loadingPeaksPromise && this.loadedPeaksFilepath === filepath) {
            return this.loadingPeaksPromise;
        }

        const isActive = targetSlot === this.activeSlotIndex;
        if (isActive) {
            this.isLoadingPeaks = true;
            this.loadedPeaksFilepath = filepath;
        }
        const promise = (async () => {
            try {
                const res = await fetchAudioPeaks(filepath, { columns: 512 });
                if (res && res.peaks.length >= 2) {
                    this.slotPeaks.set(targetSlot, res.peaks);
                    this.slotPeakPaths.set(targetSlot, filepath);
                    if (res.durationSeconds > 0) {
                        this.slotPeakDurations.set(targetSlot, res.durationSeconds);
                        const slots = this.getSlots();
                        if (slots[targetSlot]) {
                            const prevSlotDur = Number(slots[targetSlot].duration_seconds || 0);
                            if (!Number.isFinite(prevSlotDur) || prevSlotDur <= 0 || Math.abs(prevSlotDur - res.durationSeconds) > 0.05) {
                                slots[targetSlot].duration_seconds = res.durationSeconds;
                            }
                        }
                    }
                    if (targetSlot === this.activeSlotIndex && String(this.properties?.filepath || '') === filepath) {
                        this.audioPeaks = res.peaks;
                        this.loadedPeaksFilepath = filepath;
                        this.failedPeaksFilepath = null;
                        const curDur = Number(this.properties?.duration_seconds || 0);
                        let durationUpdated = false;
                        if (res.durationSeconds > 0 && (!Number.isFinite(curDur) || curDur <= 0 || Math.abs(curDur - res.durationSeconds) > 0.05)) {
                            this.properties.duration_seconds = res.durationSeconds;
                            durationUpdated = true;
                        }
                        this.setDirtyCanvas(true, true);
                        if (typeof window !== 'undefined') {
                            (window as any).editorCanvas?.setDirty?.(true, false);
                            if (durationUpdated && this.id != null) {
                                window.dispatchEvent(new CustomEvent('node-properties-refreshed', { detail: { nodeId: this.id } }));
                            }
                        }
                    }
                    return res.peaks;
                }
                if (isActive) this.failedPeaksFilepath = filepath;
                return null;
            } catch (err) {
                if (isActive) this.failedPeaksFilepath = filepath;
                console.warn(`Failed to preload waveform peaks for SampleNode #${this.id}:`, err);
                return null;
            } finally {
                if (isActive) {
                    this.isLoadingPeaks = false;
                    this.loadingPeaksPromise = null;
                    this.setDirtyCanvas(true, true);
                }
            }
        })();
        if (isActive) {
            this.loadingPeaksPromise = promise;
        }
        return promise;
    }

    public async preloadAllSlotBuffers(): Promise<void> {
        const slots = this.getSlots();
        await Promise.all(slots.map(async (s, idx) => {
            const fp = String(s?.filepath || '');
            if (!fp) {
                this.slotBuffers.delete(idx);
                this.slotLoadedPaths.delete(idx);
                this.slotPeaks.delete(idx);
                this.slotPeakPaths.delete(idx);
                this.slotPeakDurations.delete(idx);
                return;
            }
            const slotDur = Number(s?.duration_seconds ?? 0);
            if (Number.isFinite(slotDur) && slotDur > 45) {
                await this.ensurePeaksLoaded(fp, idx);
                return;
            }
            if (this.slotBuffers.has(idx) && this.slotLoadedPaths.get(idx) === fp) {
                return;
            }
            if (typeof window === 'undefined') {
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
                } else {
                    await this.ensurePeaksLoaded(fp, idx);
                }
            } catch {
                await this.ensurePeaksLoaded(fp, idx);
            }
        }));
        const poolItems = this.getPoolItems();
        const hasCyclingPoolQuery = slots.some(s => isFieldOperatorExpression(s?.pool_query, poolItems))
            || isFieldOperatorExpression(this.properties?.pool_query, poolItems);
        if (hasCyclingPoolQuery) {
            const poolPaths = poolItems
                .map((item: any) => String(item?.absolute_path || item?.filepath || ''))
                .filter(Boolean);
            await Promise.all(poolPaths.map((fp: string) => fetchAudioBuffer(fp).catch(() => null)));
        }
        this.setDirtyCanvas(true, true);
    }

    private _cachedGainedBuffer: AudioBuffer | null = null;
    private _lastRawBufferRef: AudioBuffer | null = null;
    private _lastNodeGain: number = 1.0;
    private _cachedSlotBuffersMap: Map<number, AudioBuffer> | null = null;
    private _lastSlotMapGain: number = 1.0;
    private _lastSlotMapKey: string = '';

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
        let mapKey = `${this.slotBuffers.size}_${this.activeSlotIndex}`;
        for (const [idx, buf] of this.slotBuffers.entries()) {
            mapKey += `|${idx}:${buf.length}`;
        }
        if (this._cachedSlotBuffersMap && this._lastSlotMapKey === mapKey && Math.abs(this._lastSlotMapGain - nodeGain) < 1e-4) {
            return this._cachedSlotBuffersMap;
        }
        const gainedMap = new Map<number, AudioBuffer>();
        for (const [idx, buf] of this.slotBuffers.entries()) {
            gainedMap.set(idx, idx === this.activeSlotIndex ? (this.applySampleNodeGain(buf) || buf) : applyGainToBuffer(buf, nodeGain));
        }
        this._cachedSlotBuffersMap = gainedMap;
        this._lastSlotMapKey = mapKey;
        this._lastSlotMapGain = nodeGain;
        return gainedMap;
    }

    public async ensureAudioLoaded(): Promise<AudioBuffer | null> {
        const filepath = String(this.properties?.filepath || '');
        if (!filepath) {
            this.audioBuffer = null;
            this.audioPeaks = null;
            this.loadedFilepath = '';
            this.loadedPeaksFilepath = '';
            this.sharedWaveformRenderer.setSignal(null);
            return null;
        }
        const knownDur = Number(this.properties?.duration_seconds ?? 0);
        if (Number.isFinite(knownDur) && knownDur > 45) {
            // Long recordings (> 45s) stream natively in libsin_dsp & use zero-RAM server-side peak pyramids.
            this.audioBuffer = null;
            this.loadedFilepath = filepath;
            void this.ensurePeaksLoaded(filepath, this.activeSlotIndex);
            if (this.getSlots().length > 1) {
                void this.preloadAllSlotBuffers();
            }
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
                    this.failedAudioFilepath = null;
                } else {
                    // File exceeded client decode budget (>12 MB WAV) or could not decode in browser:
                    // fall back cleanly to zero-RAM server-side peak overview when running in a browser runtime!
                    this.failedAudioFilepath = filepath;
                    if (typeof window !== 'undefined' && (window.AudioContext || (window as any).webkitAudioContext)) {
                        void this.ensurePeaksLoaded(filepath, this.activeSlotIndex);
                    }
                }
                if (this.getSlots().length > 1) {
                    void this.preloadAllSlotBuffers();
                }
                this.setDirtyCanvas(true, true);
                return buffer;
            } catch (err) {
                this.failedAudioFilepath = filepath;
                void this.ensurePeaksLoaded(filepath, this.activeSlotIndex);
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
                    { type: 'fields', fields: ['pool_query', 'crop', 'repeat', 'warp'] },
                    { type: 'fields', fields: ['transpose', 'cents'] },
                    { type: 'fields', fields: ['key_match_mode', 'key_match_algorithm'] },
                    { type: 'fields', fields: ['target_bpm', 'stretch_algorithm'] }
                ]
            },
            {
                id: 'POOL',
                label: 'Pool',
                sections: [
                    { type: 'pool_editor' }
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
        {
            key: 'pool_query',
            label: 'Asset',
            type: 'asset_call',
            default: '',
            tab: 'SAMPLE',
            placeholder: 'Drop sample or select from Pool',
            description: 'Asset call (name, pool run index, or dynamic pseudolang expression). Drop audio here to load.'
        },
        {
            key: 'crop',
            label: 'Crop',
            type: 'tuple',
            default: null,
            tab: 'SAMPLE',
            subFields: ['crop_start', 'crop_end'],
            unitConfig: {
                family: 'audio_position',
                canonical: 'fraction',
                units: AUDIO_POSITION_UNITS,
                unitGroup: 'crop',
            },
            description: 'Trim Start and End points inside the source audio.'
        },
        {
            key: 'repeat',
            label: 'Repeat',
            type: 'radio',
            default: false,
            options: [
                { value: false, label: 'Once' },
                { value: true, label: 'Repeat' }
            ],
            tab: 'SAMPLE',
            description: 'Once plays the cropped span a single time. Repeat tiles the sample across a parent Track or Arrangement (Transport Loop independently controls playback wrap).'
        },
        {
            key: 'warp',
            label: 'Warp',
            type: 'radio',
            default: false,
            options: [
                { value: false, label: 'Off (Tape)' },
                { value: true, label: 'On (Rubber Band)' }
            ],
            tab: 'SAMPLE',
            description: 'Off plays at native speed where Transpose/Key Match act as zero-RAM tape repitch. On enables Rubber Band time-stretching, BPM sync, and independent pitch.'
        },
        {
            key: 'original_bpm',
            label: 'Source BPM',
            type: 'float',
            default: null,
            min: 20,
            max: 300,
            unit: 'BPM',
            tab: 'SAMPLE',
            description: 'Derived from the asset. Editing overrides locally and stages a proposal for GAIA review.'
        },
        { key: 'target_bpm', label: 'Target BPM', type: 'global_float', default: 'global', min: 20, max: 300, unit: 'BPM', tab: 'SAMPLE' },
        {
            key: 'key',
            label: 'Key',
            type: 'string',
            default: '',
            tab: 'SAMPLE',
            description: 'Derived from the asset. Editing overrides locally and stages a proposal for GAIA review.'
        },
        {
            key: 'key_match_mode',
            label: 'Key Match',
            type: 'radio',
            default: 'off',
            options: [
                { value: 'off', label: 'Off' },
                { value: 'follow', label: 'Follow' },
                { value: 'lead', label: 'Lead' }
            ],
            tab: 'SAMPLE',
            description: 'Follow matches the global key (via Rubber Band when Warp is On, or tape repitch when Warp is Off); Lead makes this sample control the global key.'
        },
        {
            key: 'key_match_algorithm',
            label: 'Match Direction',
            type: 'radio',
            default: 'nearest',
            options: [
                { value: 'nearest', label: 'Nearest' },
                { value: 'higher', label: 'Higher' },
                { value: 'lower', label: 'Lower' }
            ],
            tab: 'SAMPLE',
            description: 'Choose whether Follow shifts to the closest compatible key, upward, or downward.'
        },
        { key: 'transpose', label: 'Transpose', type: 'int', default: 0, min: -24, max: 24, step: 1, unit: 'st', tab: 'SAMPLE' },
        { key: 'cents', label: 'Fine Tune', type: 'int', default: 0, min: -100, max: 100, step: 1, unit: 'ct', tab: 'SAMPLE' },
        {
            key: 'stretch_algorithm',
            label: 'Warp Algo',
            type: 'radio',
            default: 'rubberband',
            options: [
                { value: 'rubberband', label: 'General (R3)' },
                { value: 'rubberband_vocal', label: 'Vocal (Formant)' },
                { value: 'rubberband_percussive', label: 'Drums (Crisp)' }
            ],
            tab: 'SAMPLE',
            description: 'Rubber Band preset used when Warp is On. General suits tonal/polyphonic audio, Vocal preserves formants, Drums favors crisp transients.'
        },
        {
            key: 'crop_start',
            label: 'Start',
            type: 'unit_float',
            default: 0.0,
            min: 0,
            max: 1,
            step: 0.001,
            tab: 'SAMPLE',
            unitConfig: {
                family: 'audio_position',
                canonical: 'fraction',
                units: AUDIO_POSITION_UNITS,
                unitGroup: 'crop',
            },
            setValue: (node: any, val: number) => {
                const curEnd = Number(node.properties?.crop_end ?? 1.0);
                const clamped = Math.max(0, Math.min(Math.max(0, curEnd - 1e-4), Number(val) || 0));
                node.updateProperty('crop_start', clamped);
                return clamped;
            },
            description: 'Trim start point inside the source audio.'
        },
        {
            key: 'crop_end',
            label: 'End',
            type: 'unit_float',
            default: 1.0,
            min: 0,
            max: 1,
            step: 0.001,
            tab: 'SAMPLE',
            unitConfig: {
                family: 'audio_position',
                canonical: 'fraction',
                units: AUDIO_POSITION_UNITS,
                unitGroup: 'crop',
            },
            setValue: (node: any, val: number) => {
                const curStart = Number(node.properties?.crop_start ?? 0.0);
                const clamped = Math.max(Math.min(1, curStart + 1e-4), Math.min(1, Number(val)));
                node.updateProperty('crop_end', clamped);
                return clamped;
            },
            description: 'Trim end point inside the source audio.'
        }
    ];

    static defaultColor = "#10b981";
    static defaultIcon = "sample";
    static badgeLabel = "SMPL";
    static nodeType = "sample";
    static defaultTab = "SAMPLE";
    static tabs = ["SAMPLE", "POOL", "CHAIN", "COMMON"];
    static override defaultVisualizationType: VisualizationTypeId = 'sample';
    static override supportedVisualizationTypes: readonly VisualizationTypeId[] = ['sample', 'realtime', 'spectrum'];
    static override compactCardSpec = {
        visualizer: 'waveform_crop' as const,
        paramKeys: ['repeat', 'warp', 'original_bpm', 'transpose'] as const,
    };

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
            repeat: false,
            warp: false,
            sample_type: "one_shot",
            start_beat: 0,
            original_bpm: null,
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
            stretch_mode: "pitch_shift",
            stretch_factor: 1.0,
            stretch_algorithm: "rubberband",
            field_units: {},
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
        if (key === 'repeat') {
            const b = value === true || String(value).toLowerCase() === 'true';
            value = b;
            if (this.properties) {
                this.properties.sample_type = b ? 'loop' : 'one_shot';
            }
        } else if (key === 'sample_type') {
            const b = String(value || '').toLowerCase() === 'loop';
            if (this.properties) {
                this.properties.repeat = b;
            }
        } else if (key === 'warp') {
            const b = value === true || String(value).toLowerCase() === 'true';
            value = b;
            if (this.properties) {
                this.properties.stretch_mode = b ? 'time_stretch' : 'pitch_shift';
            }
        } else if (key === 'stretch_mode') {
            const s = String(value || '').toLowerCase();
            if (this.properties) {
                this.properties.warp = s === 'time_stretch';
            }
        }
        super.updateProperty(key, value);
        if ((SampleNode.slotPropertyKeys as readonly string[]).includes(key)) {
            this.syncActiveSlotFromProperties();
            this.applyPropertyToSelectedSlots(key, value);
        }
        if (key === 'filepath') {
            const pathStr = String(value || '');
            if (pathStr) {
                const alreadyInPool = this.getPoolItems().some(it =>
                    getPoolItemIdentityKey(it) === getPoolItemIdentityKey({ filepath: pathStr })
                );
                if (!alreadyInPool) {
                    const extFlag = this.isActiveAssetExternal();
                    this.ensureItemsInPool([{
                        id: this.properties?.library_item_id ?? (extFlag ? `ext:${pathStr}` : undefined),
                        filepath: pathStr,
                        absolute_path: pathStr,
                        name: pathStr.split(/[\\/]/).pop() || 'Sample',
                        is_external: extFlag,
                        source: extFlag ? 'external' : 'gaia',
                        bpm: this.properties?.original_bpm ?? null,
                        key: this.properties?.key || null,
                        duration_seconds: this.properties?.duration_seconds ?? null,
                    }]);
                }
            }
            if (pathStr !== this.loadedFilepath || (!this.audioBuffer && !this.audioPeaks)) {
                this.loadedFilepath = pathStr;
                this.loadedPeaksFilepath = '';
                this.audioBuffer = null;
                this.audioPeaks = null;
                this.failedAudioFilepath = null;
                this.failedPeaksFilepath = null;
                delete (this as any).manifestStemBuffer;
                this.sharedWaveformRenderer.setSignal(null);
                if (pathStr) {
                    void this.ensureAudioLoaded();
                }
            }
        }
        if (key === 'library_item_id' && value != null && this.properties?.filepath) {
            const targetKey = getPoolItemIdentityKey({ filepath: String(this.properties.filepath) });
            const match = this.getPoolItems().find(it => getPoolItemIdentityKey(it) === targetKey);
            if (match) {
                match.id = value;
                const isExt = String(value).startsWith('ext:');
                match.is_external = isExt;
                match.source = isExt ? 'external' : 'gaia';
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
        // Backward-compatible migration of legacy sample_type / stretch_mode into orthogonal repeat / warp
        if (this.properties) {
            const savedProps = (data && typeof data === 'object' && data.properties && typeof data.properties === 'object')
                ? data.properties
                : {};
            if (savedProps.repeat === undefined && savedProps.sample_type !== undefined) {
                this.properties.repeat = String(savedProps.sample_type).toLowerCase() === 'loop';
            } else if (this.properties.repeat === undefined) {
                this.properties.repeat = String(this.properties.sample_type ?? 'one_shot').toLowerCase() === 'loop';
            }
            if (savedProps.warp === undefined && (savedProps.stretch_mode !== undefined || savedProps.sample_type !== undefined)) {
                const legacyMode = String(savedProps.stretch_mode ?? this.properties.stretch_mode ?? '').toLowerCase();
                if (legacyMode === 'pitch_shift' || legacyMode === 'repitch' || legacyMode === 'varispeed' || legacyMode === 'off') {
                    this.properties.warp = false;
                } else {
                    const legacySt = String(savedProps.sample_type ?? this.properties.sample_type ?? 'one_shot').toLowerCase();
                    this.properties.warp = legacySt !== 'one_shot' && legacySt !== 'oneshot';
                }
            } else if (this.properties.warp === undefined) {
                this.properties.warp = false;
            }
            this.properties.sample_type = this.properties.repeat ? 'loop' : 'one_shot';
            this.properties.stretch_mode = this.properties.warp ? 'time_stretch' : 'pitch_shift';
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
        // Hydrate any legacy slots with filepaths into the node's pool so every loaded asset has an index
        const slotPoolCandidates = slots
            .filter(s => Boolean(s?.filepath))
            .map(s => ({
                id: s.library_item_id ?? undefined,
                filepath: String(s.filepath),
                absolute_path: String(s.filepath),
                name: String(s.filepath).split(/[\\/]/).pop() || 'Sample',
                is_external: Boolean(s.is_external || String(s.library_item_id ?? '').startsWith('ext:')),
                bpm: s.original_bpm ?? null,
                key: s.key || null,
                duration_seconds: s.duration_seconds ?? null,
            }));
        if (slotPoolCandidates.length > 0) {
            this.ensureItemsInPool(slotPoolCandidates);
        }
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
        if (this.isActiveAssetExternal()) return true;

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
        if (!filepath || this.isActiveAssetExternal()) return null;
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

        const inferred = SampleNode.inferLoadDefaults({
            is_loop: libraryFile.is_loop,
            sample_type: libraryFile.sample_type ?? undefined,
            tags: libraryFile.tags,
            bpm: Number.isFinite(Number(libraryFile.bpm)) ? Number(libraryFile.bpm) : null,
            duration_seconds: Number.isFinite(Number(libraryFile.duration_seconds)) ? Number(libraryFile.duration_seconds) : null,
            filepath: libraryFile.absolute_path || filepath,
        });
        const isExplicitOneShot = libraryFile.is_loop === false
            || libraryFile.sample_type === 'one_shot'
            || (Array.isArray(libraryFile.tags) && libraryFile.tags.includes('One shot'));

        if (this.properties.repeat !== inferred.repeat) {
            this.updateProperty('repeat', inferred.repeat);
            if (this.properties.warp !== inferred.warp) {
                this.updateProperty('warp', inferred.warp);
            }
        } else if (this.properties.warp === undefined) {
            this.updateProperty('warp', inferred.warp);
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
            if (this.isActiveAssetExternal()) {
                return;
            }
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
            this.updateProperty('is_external', false);
            this.updateProperty('key_is_local_override', false);
            this.updateProperty('original_bpm_is_local_override', false);
            const libFile = await this.syncMetadataFromLibrary();
            const fp = String(this.properties?.filepath || value || '');
            if (fp) {
                const registered = this.ensureItemsInPool([{
                    id: libFile?.id ?? this.properties?.library_item_id ?? undefined,
                    filepath: fp,
                    absolute_path: fp,
                    name: libFile?.name || fp.split(/[\\/]/).pop() || 'Sample',
                    is_external: !libFile,
                    bpm: libFile?.bpm ?? this.properties?.original_bpm ?? null,
                    key: libFile?.key ?? this.properties?.key ?? null,
                    duration_seconds: libFile?.duration_seconds ?? this.properties?.duration_seconds ?? null,
                }]);
                if (registered[0]) {
                    this.updateProperty('is_external', isExternalPoolItem(registered[0]));
                    this.updateProperty('pool_query', getPoolItemCallName(registered[0], false));
                }
            }
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

        const isRepeat = this.isRepeatEnabled();
        const isWarp = this.isWarpEnabled();
        const rawOrigBpm = model.original_bpm ?? this.properties?.original_bpm;
        const resolvedOrigBpm = (
            !isWarp
            && !this.properties?.original_bpm_is_local_override
            && !model.original_bpm_is_local_override
            && (rawOrigBpm === 120 || !rawOrigBpm)
        ) ? null : rawOrigBpm;

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
            repeat: isRepeat,
            warp: isWarp,
            sample_type: isRepeat ? 'loop' : 'one_shot',
            stretch_mode: isWarp ? 'time_stretch' : 'pitch_shift',
            original_bpm: resolvedOrigBpm,
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

    public getEffectivePlaybackRate(): number {
        const win = (typeof window !== 'undefined') ? (window as any) : undefined;
        const isWarp = this.isWarpEnabled();
        const stretchFactor = Math.max(0.05, Number(this.properties?.stretch_factor || 1.0) || 1.0);
        if (!isWarp) {
            const matchTranspose = this.properties?.key_match_mode === 'follow'
                ? (Number(this.properties?.key_match_transpose) || 0)
                : 0;
            const totalSemis = (Number(this.properties?.transpose || 0) + matchTranspose)
                + (Number(this.properties?.cents || 0) / 100);
            const pitchRate = Math.pow(2, totalSemis / 12);
            return Math.max(0.05, pitchRate * stretchFactor);
        }
        const rawTargetBpm = Number(this.properties?.target_bpm);
        const targetBpm = (Number.isFinite(rawTargetBpm) && rawTargetBpm > 0)
            ? rawTargetBpm
            : (Number(win?.activeWorkspaceManifest?.bpm || win?.getGlobalParameter?.('bpm')) || 120);
        const originalBpm = Number(this.properties?.original_bpm || 0);
        const bpmRatio = (originalBpm > 0 && targetBpm > 0) ? (targetBpm / originalBpm) : 1.0;
        const rate = bpmRatio * stretchFactor;
        return Number.isFinite(rate) && rate > 0.05 ? rate : 1.0;
    }

    public getPlayheadNorm(telemetry?: SignalTelemetry): { progress: number | null; isTriggered: boolean } {
        const sig = this.resolveVisualizationSignal(telemetry);
        return {
            progress: typeof sig.playbackProgress === 'number' ? sig.playbackProgress : null,
            isTriggered: Boolean(sig.isTriggered),
        };
    }

    override resolveVisualizationSignal(telemetry?: SignalTelemetry): WaveformSignal {
        const filepath = String(this.properties?.filepath || '');
        if (filepath !== this.loadedFilepath) {
            this.loadedFilepath = filepath;
            this.loadedPeaksFilepath = '';
            this.failedAudioFilepath = null;
            this.failedPeaksFilepath = null;
            this.audioBuffer = null;
            this.audioPeaks = null;
            delete (this as any).manifestStemBuffer;
            this.sharedWaveformRenderer.setSignal(null);
        }

        if (filepath && !this.audioBuffer && !this.isLoadingAudio && this.failedAudioFilepath !== filepath) {
            void this.ensureAudioLoaded();
        } else if (filepath && !this.audioBuffer && !this.audioPeaks && !this.isLoadingPeaks && this.failedPeaksFilepath !== filepath) {
            void this.ensurePeaksLoaded(filepath, this.activeSlotIndex);
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
        const cachedSlotPeaks = (this.slotPeakPaths.get(this.activeSlotIndex) === filepath)
            ? this.slotPeaks.get(this.activeSlotIndex)
            : undefined;
        let displayPeaks: Float32Array | undefined = (this.audioPeaks && this.loadedPeaksFilepath === filepath)
            ? this.audioPeaks
            : cachedSlotPeaks;

        const peakDur = this.getActivePeakDuration();
        const sampleDur = displayBuffer?.duration || peakDur || Number(this.properties?.duration_seconds) || 0;
        const cropStart = Math.max(0, Math.min(1, Number(this.properties?.crop_start ?? 0)));
        const cropEnd = Math.max(cropStart + 1e-4, Math.min(1, this.properties?.crop_end != null ? Number(this.properties.crop_end) : 1));
        const activeSpan = Math.max(1e-4, cropEnd - cropStart);
        const sampleActiveDuration = sampleDur > 0 ? sampleDur * activeSpan : 2.0;

        const rawTargetBpm = Number(this.properties?.target_bpm);
        const targetBpm = (Number.isFinite(rawTargetBpm) && rawTargetBpm > 0)
            ? rawTargetBpm
            : (Number(win?.activeWorkspaceManifest?.bpm || win?.getGlobalParameter?.('bpm')) || 120);
        const effectivePitchRate = this.getEffectivePlaybackRate();
        const isRepeat = this.isRepeatEnabled();
        const timelineActiveDur = sampleActiveDuration / Math.max(0.05, effectivePitchRate);

        let playbackProgress: number | undefined;
        let isTriggered: boolean | undefined;
        const slots = this.getSlots();
        const slotCount = Math.max(1, slots.length);
        let irideActiveSlot = this.activeSlotIndex;

        if (isPlaying && telemetry) {
            if (isPreviewTarget) {
                const dur = telemetry.duration > 0 ? telemetry.duration : timelineActiveDur;
                const curTime = dur > 0 ? ((telemetry.time % dur) + dur) % dur : 0;
                const sampleTime = curTime * effectivePitchRate;
                const wrappedTime = (isRepeat && sampleActiveDuration > 0 && dur > timelineActiveDur + 0.05)
                    ? ((sampleTime % sampleActiveDuration) + sampleActiveDuration) % sampleActiveDuration
                    : sampleTime;
                const progress = sampleActiveDuration > 0 ? Math.max(0, Math.min(1, wrappedTime / sampleActiveDuration)) : 0;
                playbackProgress = cropStart + progress * activeSpan;
                isTriggered = true;
            } else {
                const manifestEvents = ((this as any).manifestEvents as Array<{ time: number; duration: number; slot?: number; filepath?: string; iteration?: number }> | undefined)
                    || (win?.activeWorkspaceManifest?.nodes?.[String(this.id)]?.events as Array<{ time: number; duration: number; slot?: number; filepath?: string; iteration?: number }> | undefined);
                const totalTrackDur = telemetry.duration > 0
                    ? telemetry.duration
                    : (Number(win?.activeWorkspaceManifest?.total_duration) || (manifestEvents?.length ? manifestEvents[manifestEvents.length - 1].time + manifestEvents[manifestEvents.length - 1].duration : timelineActiveDur));
                const curTime = totalTrackDur > 0 ? ((telemetry.time % totalTrackDur) + totalTrackDur) % totalTrackDur : telemetry.time;

                if (manifestEvents && manifestEvents.length > 0) {
                    let activeEvent = manifestEvents.find(e => {
                        const evtDur = e.duration > 0 ? Math.max(0.02, e.duration) : Math.max(0.02, timelineActiveDur);
                        return curTime >= e.time && curTime < (e.time + evtDur);
                    });
                    let triggerTime = curTime;
                    if (!activeEvent && totalTrackDur > 0) {
                        let lastEventEnd = (manifestEvents as any).__maxEnd as number | undefined;
                        if (lastEventEnd === undefined) {
                            lastEventEnd = 0;
                            for (let i = 0; i < manifestEvents.length; i++) {
                                const evtDur = manifestEvents[i].duration > 0 ? Math.max(0.02, manifestEvents[i].duration) : Math.max(0.02, timelineActiveDur);
                                const end = manifestEvents[i].time + evtDur;
                                if (end > lastEventEnd) lastEventEnd = end;
                            }
                            (manifestEvents as any).__maxEnd = lastEventEnd;
                        }
                        if (lastEventEnd > 0 && lastEventEnd < totalTrackDur * 0.85) {
                            const barSec = 4 * (60 / targetBpm);
                            const patternBars = Math.max(1, Math.round(lastEventEnd / barSec));
                            const patternDur = Math.max(0.05, patternBars * barSec);
                            const timeInPattern = ((curTime % patternDur) + patternDur) % patternDur;
                            const loopedEvent = manifestEvents.find(e => {
                                const evtDur = e.duration > 0 ? Math.max(0.02, e.duration) : Math.max(0.02, timelineActiveDur);
                                return timeInPattern >= e.time && timeInPattern < (e.time + evtDur);
                            });
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
                                const slotPk = this.slotPeaks.get(irideActiveSlot);
                                if (slotPk && this.slotPeakPaths.get(irideActiveSlot) === evtFp) {
                                    displayPeaks = slotPk;
                                } else {
                                    void this.ensurePeaksLoaded(evtFp, irideActiveSlot);
                                }
                            }
                        }
                    }

                    // 2. Inspector live telemetry: NEVER switch slots; only update when the active slot itself has a Field Operator
                    const inspectorSlot = Math.min(Math.max(0, this.activeSlotIndex), slotCount - 1);
                    const activeSlotQuery = String(slots[inspectorSlot]?.pool_query ?? this.properties?.pool_query ?? '').trim();
                    const hasActiveSlotPoolOp = isFieldOperatorExpression(activeSlotQuery, this.getPoolItems());
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
                            : isRepeat;
                        const progressInCrop = isEventLoop
                            ? (((eventStartNorm + sampleProgress) % 1.0) + 1.0) % 1.0
                            : Math.max(0, Math.min(1, eventStartNorm + sampleProgress));
                        playbackProgress = cropStart + progressInCrop * activeSpan;
                        isTriggered = true;
                    } else {
                        isTriggered = false;
                    }
                } else {
                    const startBeat = Number(this.properties?.start_beat ?? 0);
                    const startSec = startBeat * (60 / targetBpm);

                    if (isRepeat && sampleActiveDuration > 0) {
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
                        const endSec = startSec + timelineActiveDur;
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

        const hasUserFx = getUserFxStages(this.properties?.chain).length > 0;
        const nodeRealtimePeaks = (this as any).realtimePeaks as Float32Array | undefined;
        const usePostFxPeaks = Boolean(win?.__sinRealtimeLoaded && nodeRealtimePeaks && hasUserFx);
        const resolvedPeaks = usePostFxPeaks
            ? nodeRealtimePeaks
            : (!displayBuffer ? (displayPeaks || (filepath && sampleDur > 45 ? nodeRealtimePeaks : undefined)) : undefined);
        const isLoading = Boolean(
            filepath
            && !displayBuffer
            && !resolvedPeaks
            && (this.isLoadingAudio || this.isLoadingPeaks)
        );

        return {
            buffer: usePostFxPeaks ? undefined : displayBuffer,
            peaks: resolvedPeaks,
            duration: sampleActiveDuration,
            cropStart,
            cropEnd,
            accentColor: this.nodeColor,
            playbackProgress,
            isTriggered,
            bufferedProgress: 1.0,
            isInvalidated: false,
            isLoading,
            loadingLabel: isLoading ? 'Loading…' : undefined,
            slotCount: slots.length,
            activeSlot: irideActiveSlot
        };
    }

    override get supportsStepLighting(): boolean {
        return true;
    }

    private resolveLiveSlotState(telemetry?: SignalTelemetry): { slotIndex: number; isTriggered: boolean; progress: number } {
        const rawSlots = this.properties?.slots;
        const slotCount = Array.isArray(rawSlots) && rawSlots.length > 0 ? rawSlots.length : 1;
        const rawActive = Number.isFinite(this.activeSlotIndex) ? Math.trunc(this.activeSlotIndex) : 0;
        const fallbackSlot = ((rawActive % slotCount) + slotCount) % slotCount;

        if (!telemetry?.isPlaying) {
            return { slotIndex: fallbackSlot, isTriggered: false, progress: 0 };
        }

        const win = (typeof window !== 'undefined') ? (window as any) : undefined;
        const isPreviewTarget = this.id != null && win && this.id === win.activeRamPreviewNodeId;

        const sampleDur = this.audioBuffer?.duration || Number(this.properties?.duration_seconds) || 2.0;
        const cropStart = Number(this.properties?.crop_start ?? 0);
        const cropEnd = Number(this.properties?.crop_end ?? 1);
        const activeSpan = Math.max(0.01, cropEnd - cropStart);
        const sampleActiveDuration = sampleDur > 0 ? sampleDur * activeSpan : 2.0;
        const dur = telemetry.duration > 0 ? telemetry.duration : sampleActiveDuration;
        const curTime = dur > 0 ? ((telemetry.time % dur) + dur) % dur : 0;

        if (isPreviewTarget) {
            const progress = sampleActiveDuration > 0 ? Math.max(0, Math.min(1, (curTime % sampleActiveDuration) / sampleActiveDuration)) : 0;
            return { slotIndex: fallbackSlot, isTriggered: true, progress };
        }

        const manifestEvents = ((this as any).manifestEvents as Array<{ time: number; duration: number; slot?: number }> | undefined)
            || (win?.activeWorkspaceManifest?.nodes?.[String(this.id)]?.events as Array<{ time: number; duration: number; slot?: number }> | undefined);

        if (manifestEvents && manifestEvents.length > 0) {
            const totalTrackDur = telemetry.duration > 0
                ? telemetry.duration
                : Number(win?.activeWorkspaceManifest?.total_duration || sampleActiveDuration);
            const wrappedTime = totalTrackDur > 0 ? ((telemetry.time % totalTrackDur) + totalTrackDur) % totalTrackDur : telemetry.time;

            let activeEvent: { time: number; duration: number; slot?: number } | undefined;
            let triggerTime = wrappedTime;
            for (let i = 0; i < manifestEvents.length; i++) {
                const e = manifestEvents[i];
                if (wrappedTime >= e.time && wrappedTime < (e.time + Math.max(0.02, e.duration))) {
                    activeEvent = e;
                    break;
                }
            }

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
                    const rawTargetBpm = Number(this.properties?.target_bpm);
                    const targetBpm = (Number.isFinite(rawTargetBpm) && rawTargetBpm > 0)
                        ? rawTargetBpm
                        : (Number(win?.activeWorkspaceManifest?.bpm || win?.getGlobalParameter?.('bpm')) || 120);
                    const barSec = 4 * (60 / targetBpm);
                    const patternBars = Math.max(1, Math.round(lastEventEnd / barSec));
                    const patternDur = Math.max(0.05, patternBars * barSec);
                    const timeInPattern = ((wrappedTime % patternDur) + patternDur) % patternDur;
                    for (let i = 0; i < manifestEvents.length; i++) {
                        const e = manifestEvents[i];
                        if (timeInPattern >= e.time && timeInPattern < (e.time + Math.max(0.02, e.duration))) {
                            activeEvent = e;
                            triggerTime = timeInPattern;
                            break;
                        }
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

            let liveSlot = fallbackSlot;
            if (recentEvent && typeof recentEvent.slot === 'number') {
                liveSlot = ((Math.trunc(recentEvent.slot) % slotCount) + slotCount) % slotCount;
            }

            const progress = activeEvent
                ? Math.max(0, Math.min(1, (triggerTime - activeEvent.time) / Math.max(0.02, activeEvent.duration)))
                : 0;
            return {
                slotIndex: liveSlot,
                isTriggered: Boolean(activeEvent),
                progress
            };
        }

        const isLoop = this.properties?.sample_type === 'loop';
        if (isLoop && sampleActiveDuration > 0) {
            return {
                slotIndex: fallbackSlot,
                isTriggered: true,
                progress: Math.max(0, Math.min(1, (curTime % sampleActiveDuration) / sampleActiveDuration))
            };
        }

        const progress = dur > 0 ? Math.max(0, Math.min(1, curTime / dur)) : 0;
        return { slotIndex: fallbackSlot, isTriggered: true, progress };
    }

    public getLiveDisplayedSlotIndex(telemetry?: SignalTelemetry): number {
        return this.resolveLiveSlotState(telemetry).slotIndex;
    }

    override getLiveActivityState(telemetry?: SignalTelemetry): { isTriggered: boolean; progress?: number } {
        const state = this.resolveLiveSlotState(telemetry);
        return { isTriggered: state.isTriggered, progress: state.progress };
    }

    protected override drawClosedIconOverlay(ctx: CanvasRenderingContext2D, telemetry?: SignalTelemetry): boolean {
        const center = BaseNode.visualSize * 0.5;
        drawClosedSlotIndex(ctx, center, center, this.getLiveDisplayedSlotIndex(telemetry));
        return true;
    }

    protected override drawPanelHeaderDecorations(
        ctx: CanvasRenderingContext2D,
        _width: number,
        headerHeight: number,
        titleX: number,
        telemetry?: SignalTelemetry
    ): void {
        const pillY = Math.round((headerHeight - 14) * 0.5);
        const pillW = drawHeaderSlotPill(ctx, titleX, pillY, 14, this.getLiveDisplayedSlotIndex(telemetry), this.nodeColor);
        this._headerDeco.titleOffsetX = pillW + 5;
    }

    override onVisualizationToggled(enabled: boolean): void {
        if (enabled) {
            const filepath = String(this.properties?.filepath || '');
            if (filepath && !this.audioBuffer && !this.isLoadingAudio) {
                void this.ensureAudioLoaded();
            }
        }
    }

    override getToolbarControls(): NodeToolbarControl[] {
        const slots = this.getSlots();
        const notifyRefresh = () => {
            this.setDirtyCanvas(true, true);
            if (typeof window !== 'undefined') {
                window.dispatchEvent(new CustomEvent('node-properties-refreshed', { detail: { nodeId: this.id } }));
            }
        };
        return [
            {
                kind: 'slot-strip',
                id: 'slots',
                count: slots.length,
                activeIndex: this.activeSlotIndex,
                selectedIndices: this.getSelectedSlotIndices(),
                onSelect: (idx) => {
                    this.selectSlot(idx);
                    notifyRefresh();
                },
                onAdd: () => {
                    const nextIdx = this.addSlot();
                    this.selectSlot(nextIdx);
                    notifyRefresh();
                },
                onRemove: slots.length > 1
                    ? () => {
                        this.removeSlot(this.activeSlotIndex);
                        notifyRefresh();
                    }
                    : undefined
            },
            {
                kind: 'toggle',
                id: 'repeat',
                label: 'Repeat',
                title: 'Repeat (tile) sample across parent Track / Arrangement',
                active: this.isRepeatEnabled(),
                tone: 'emerald',
                onToggle: () => {
                    this.updateProperty('repeat', !this.isRepeatEnabled());
                    notifyRefresh();
                }
            },
            {
                kind: 'toggle',
                id: 'warp',
                label: 'Warp',
                title: 'Warp (Rubber Band BPM sync & independent pitch; Off = Tape Repitch)',
                active: this.isWarpEnabled(),
                tone: 'amber',
                onToggle: () => {
                    this.updateProperty('warp', !this.isWarpEnabled());
                    notifyRefresh();
                }
            },
            {
                kind: 'toggle',
                id: 'pool',
                label: 'Pool',
                icon: 'layers',
                title: 'Toggle Asset Pool tab',
                active: Boolean(this.isPoolPanelOpen),
                tone: 'sky',
                onToggle: () => {
                    if (typeof window !== 'undefined') {
                        window.dispatchEvent(new CustomEvent('add-asset-filter-to-param', {
                            detail: { nodeId: this.id, targetTab: 'POOL' }
                        }));
                    }
                }
            }
        ];
    }
}

(SampleNode as any).title = "Sample";
LiteGraph.registerNodeType("Audio/Sample", SampleNode);
