/**
 * Single-source-of-truth registry for In -> Out DSP chain processors.
 * Loads processor definitions and parameter metadata from `dsp_modules/manifest.json`
 * so C++, Python, and TypeScript share exact param indices, ranges, and defaults.
 */

import manifest from '../../../dsp_modules/manifest.json' with { type: 'json' };
import { type FieldSchema } from '../fields/FieldSchema.ts';

export type ProcessorParamKind = 'db' | 'hz' | 'ms' | 'ratio' | 'percent' | 'bool' | 'enum' | 'float';
export type ProcessorParamScale = 'linear' | 'log';

export interface ProcessorParamOption {
    value: number;
    label: string;
}

export interface ProcessorParamDef {
    key: string;
    label: string;
    unit: string;
    min: number;
    max: number;
    step: number;
    defaultValue: number;
    paramIndex: number;
    kind: ProcessorParamKind;
    scale: ProcessorParamScale;
    options?: ProcessorParamOption[];
    group?: string;
}

export interface ChainModuleInstance {
    id: string;
    type: string;
    name: string;
    enabled: boolean;
    fixed?: boolean;
    expanded?: boolean;
    viewMode?: 'visual' | 'numeric';
    params: Record<string, number>;
}

export interface DspProcessorDef {
    type: string;
    engineId: number;
    label: string;
    addable: boolean;
    meterKind: 'none' | 'peak' | 'gr_db';
    params: ProcessorParamDef[];
    defaultParams(): Record<string, number>;
    createModule(id: string, name?: string, overrides?: Partial<ChainModuleInstance>): ChainModuleInstance;
}

export function linearToDb(gain: number): number {
    if (gain <= 0.0001) return -36;
    return Math.max(-36, Math.min(12, 20 * Math.log10(gain)));
}

export function dbToLinear(db: number): number {
    return db <= -35.9 ? 0 : Math.pow(10, db / 20);
}

export function formatDb(db: number): string {
    if (db <= -35.9) return '-inf dB';
    if (Math.abs(db) < 0.05) return '0.0 dB';
    return `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`;
}

function buildProcessorDef(raw: any): DspProcessorDef {
    const type = String(raw.type).trim().toLowerCase();
    const label = String(raw.label || type);
    const params: ProcessorParamDef[] = (Array.isArray(raw.params) ? raw.params : []).map((p: any) => ({
        key: String(p.key),
        label: String(p.label || p.key),
        unit: String(p.unit || ''),
        min: Number(p.min ?? 0),
        max: Number(p.max ?? 1),
        step: Number(p.step ?? 0.1),
        defaultValue: Number(p.defaultValue ?? 0),
        paramIndex: Number(p.paramIndex ?? 0),
        kind: (p.kind || 'float') as ProcessorParamKind,
        scale: (p.scale || 'linear') as ProcessorParamScale,
        options: Array.isArray(p.options) ? p.options.map((o: any) => ({ value: Number(o.value), label: String(o.label) })) : undefined,
        group: p.group ? String(p.group) : undefined,
    }));

    return {
        type,
        engineId: Number(raw.engineId ?? 0),
        label,
        addable: Boolean(raw.addable),
        meterKind: (raw.meterKind || 'none') as 'none' | 'peak' | 'gr_db',
        params,
        defaultParams(): Record<string, number> {
            const out: Record<string, number> = {};
            if (type === 'gain') {
                out.gain = 1.0;
                out.gain_db = 0.0;
                return out;
            }
            for (const p of params) {
                out[p.key] = p.defaultValue;
            }
            return out;
        },
        createModule(id: string, name?: string, overrides?: Partial<ChainModuleInstance>): ChainModuleInstance {
            const baseParams = this.defaultParams();
            return {
                id,
                type,
                name: name || label,
                enabled: true,
                expanded: overrides?.expanded ?? false,
                viewMode: overrides?.viewMode ?? 'visual',
                ...overrides,
                params: { ...baseParams, ...(overrides?.params || {}) },
            };
        },
    };
}

export const PROCESSOR_REGISTRY: Record<string, DspProcessorDef> = {};
for (const rawProc of (manifest as any).processors || []) {
    const def = buildProcessorDef(rawProc);
    if (def.type) {
        PROCESSOR_REGISTRY[def.type] = def;
    }
}

export function getProcessorDef(type: string | undefined | null): DspProcessorDef | undefined {
    const key = String(type || '').trim().toLowerCase();
    return PROCESSOR_REGISTRY[key];
}

export function isRegisteredProcessor(type: string | undefined | null): boolean {
    return getProcessorDef(type) !== undefined;
}

export function listProcessors(): DspProcessorDef[] {
    return Object.values(PROCESSOR_REGISTRY);
}

export function listAddableProcessors(): DspProcessorDef[] {
    return Object.values(PROCESSOR_REGISTRY).filter(def => def.addable);
}

export function isFixedPreGain(mod: any): boolean {
    if (!mod || typeof mod !== 'object') return false;
    const id = String(mod.id || '').trim().toLowerCase();
    const name = String(mod.name || '').trim().toLowerCase();
    const type = String(mod.type || '').trim().toLowerCase();
    return type === 'gain' && (id === 'pre' || id.startsWith('pre_gain') || (Boolean(mod.fixed) && name === 'pre gain'));
}

export function isFixedPostGain(mod: any): boolean {
    if (!mod || typeof mod !== 'object') return false;
    const id = String(mod.id || '').trim().toLowerCase();
    const name = String(mod.name || '').trim().toLowerCase();
    const type = String(mod.type || '').trim().toLowerCase();
    return type === 'gain' && (id === 'post' || id.startsWith('post_gain') || (Boolean(mod.fixed) && name === 'post gain'));
}

export function isFixedGainEndpoint(mod: any): boolean {
    return isFixedPreGain(mod) || isFixedPostGain(mod);
}

export interface UserFxStageEntry {
    module: ChainModuleInstance;
    def: DspProcessorDef;
    stageIndex: number;
    chainIndex: number;
}

/**
 * Returns user FX stages in exact serial execution order, assigning `stageIndex = 0..K-1`
 * matching `core/plan_packer.py:_pack_chain_stages`.
 */
export function getUserFxStages(chain: unknown): UserFxStageEntry[] {
    if (!Array.isArray(chain)) return [];
    const out: UserFxStageEntry[] = [];
    let stageIndex = 0;
    for (let i = 0; i < chain.length; i++) {
        const mod = chain[i];
        if (!mod || typeof mod !== 'object') continue;
        const modId = String(mod.id || '').trim().toLowerCase();
        const modType = String(mod.type || '').trim().toLowerCase();
        if (modId === 'mute' || modId === 'fader') continue;
        if (modType === 'gain' && (isFixedGainEndpoint(mod) || Boolean(mod.fixed))) continue;
        const def = getProcessorDef(modType);
        if (!def) continue;
        out.push({ module: mod as ChainModuleInstance, def, stageIndex, chainIndex: i });
        stageIndex++;
    }
    return out;
}

export function getChainStructureSignature(chain: unknown): string {
    return getUserFxStages(chain)
        .map(entry => `${entry.stageIndex}:${entry.def.type}:${entry.module.id}`)
        .join('|');
}

export function getModuleEndpointGainDb(mod: any): number {
    const p = mod?.params || {};
    if (typeof p.gain_db === 'number' && Number.isFinite(p.gain_db)) return p.gain_db;
    if (typeof p.gain === 'number' && Number.isFinite(p.gain)) return linearToDb(p.gain);
    return 0;
}

export function getPrePostGainDb(chain: unknown): { preDb: number; postDb: number } {
    let preDb = 0;
    let postDb = 0;
    if (!Array.isArray(chain)) return { preDb, postDb };
    for (const mod of chain) {
        if (!mod || mod.enabled === false) continue;
        if (isFixedPreGain(mod)) preDb += getModuleEndpointGainDb(mod);
        else if (isFixedPostGain(mod)) postDb += getModuleEndpointGainDb(mod);
    }
    return { preDb, postDb };
}

export function makeChainParamFieldKey(moduleId: string, paramKey: string): string {
    return `chain.${moduleId}.${paramKey}`;
}

export function parseChainParamFieldKey(key: string): { moduleId: string; paramKey: string } | null {
    const m = String(key || '').match(/^chain\.([^.]+)\.(.+)$/);
    if (!m) return null;
    return { moduleId: m[1], paramKey: m[2] };
}

export function paramDefToFieldSchema(moduleId: string, param: ProcessorParamDef): FieldSchema {
    const fullKey = makeChainParamFieldKey(moduleId, param.key);
    if (param.kind === 'bool') {
        return {
            key: fullKey,
            label: param.label,
            type: 'boolean',
            default: param.defaultValue >= 0.5,
            min: 0,
            max: 1,
            step: 1,
            tab: 'CHAIN',
        };
    }
    if (param.kind === 'enum' && param.options?.length) {
        return {
            key: fullKey,
            label: param.label,
            type: 'select',
            default: param.defaultValue,
            options: param.options.map(o => ({ value: o.value, label: o.label })),
            min: param.min,
            max: param.max,
            step: 1,
            tab: 'CHAIN',
        };
    }
    return {
        key: fullKey,
        label: param.label,
        type: param.kind === 'db' ? 'db' : 'float',
        default: param.defaultValue,
        min: param.min,
        max: param.max,
        step: param.step,
        unit: param.unit || undefined,
        tab: 'CHAIN',
    };
}

export function findChainModuleParam(
    node: any,
    compoundKey: string
): { module: ChainModuleInstance; def: DspProcessorDef; param: ProcessorParamDef; stageIndex: number; schema: FieldSchema } | null {
    const parsed = parseChainParamFieldKey(compoundKey);
    if (!parsed) return null;
    const stages = getUserFxStages(node?.properties?.chain);
    const match = stages.find(s => String(s.module.id) === parsed.moduleId);
    if (!match) return null;
    const param = match.def.params.find(p => p.key === parsed.paramKey);
    if (!param) return null;
    return {
        module: match.module,
        def: match.def,
        param,
        stageIndex: match.stageIndex,
        schema: paramDefToFieldSchema(match.module.id, param),
    };
}

export function readChainParamValue(module: any, param: ProcessorParamDef): number {
    const p = module?.params || {};
    if (param.kind === 'db' && module?.type === 'gain') {
        if (p[param.key] !== undefined) return Number(p[param.key]);
        if (p.gain !== undefined) return linearToDb(Number(p.gain));
        return param.defaultValue;
    }
    const raw = p[param.key];
    if (raw === undefined || raw === null) return param.defaultValue;
    if (typeof raw === 'boolean') return raw ? 1 : 0;
    const num = Number(raw);
    return Number.isFinite(num) ? num : param.defaultValue;
}

export function computeGainMultiplier(node: any): number {
    const props = node?.properties || {};
    const chain = Array.isArray(props.chain) ? props.chain : null;
    if (chain && chain.length > 0) {
        let total = 1.0;
        for (const mod of chain) {
            if (!mod || mod.enabled === false) continue;
            if (String(mod.type || 'gain').trim().toLowerCase() !== 'gain') continue;
            const p = mod.params || {};
            if (typeof p.gain === 'number' && Number.isFinite(p.gain)) {
                total *= Math.max(0, p.gain);
            } else if (typeof p.gain_db === 'number' && Number.isFinite(p.gain_db)) {
                total *= dbToLinear(p.gain_db);
            }
        }
        return total;
    }
    const rawGainDb = Number(props.gain ?? 0);
    return Number.isFinite(rawGainDb) ? dbToLinear(rawGainDb) : 1.0;
}
