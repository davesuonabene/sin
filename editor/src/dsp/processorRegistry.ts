/**
 * Minimal single-source-of-truth registry for In -> Out DSP chain processors.
 * Only `gain` ships today; future real processors register here with typed params
 * and automatically render in the inspector + dispatch to C++ SinChainStageDesc.
 */

export interface ProcessorParamDef {
    key: string;
    label: string;
    unit: string;
    min: number;
    max: number;
    step: number;
    defaultValue: number;
    paramIndex: number;
    kind?: 'db' | 'float';
}

export interface ChainModuleInstance {
    id: string;
    type: string;
    name: string;
    enabled: boolean;
    fixed?: boolean;
    params: Record<string, number>;
}

export interface DspProcessorDef {
    type: string;
    label: string;
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

const GAIN_DEF: DspProcessorDef = {
    type: 'gain',
    label: 'Gain',
    params: [
        {
            key: 'gain_db',
            label: 'Gain',
            unit: 'dB',
            min: -36,
            max: 12,
            step: 0.1,
            defaultValue: 0,
            paramIndex: 0,
            kind: 'db',
        },
    ],
    defaultParams(): Record<string, number> {
        return { gain: 1.0, gain_db: 0.0 };
    },
    createModule(id: string, name?: string, overrides?: Partial<ChainModuleInstance>): ChainModuleInstance {
        const baseParams = this.defaultParams();
        return {
            id,
            type: 'gain',
            name: name || 'Gain',
            enabled: true,
            ...overrides,
            params: { ...baseParams, ...(overrides?.params || {}) },
        };
    },
};

export const PROCESSOR_REGISTRY: Record<string, DspProcessorDef> = {
    gain: GAIN_DEF,
};

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
