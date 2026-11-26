import test from 'node:test';
import assert from 'node:assert/strict';

import {
    getChainStructureSignature,
    getPrePostGainDb,
    getUserFxStages,
    listAddableProcessors,
    paramDefToFieldSchema,
} from '../src/dsp/processorRegistry.ts';
import {
    EQ_CURVE_OPTIONS,
    computeEqBandMagDb,
    createFxVisualWidget,
    qToSlopeDbPerOct,
} from '../src/ui/components/fx/FxVisualWidgets.ts';
import { defaultTransportClock } from '../../packages/iride/src/telemetry/TransportClock.ts';
import { getDefaultFxChain } from '../src/nodes/BaseNode.ts';
import { NullNode } from '../src/nodes/NullNode.ts';
import { SampleNode } from '../src/nodes/SampleNode.ts';
import { validateGraphDocument } from '../../ermes/ts/graphSchema.ts';
import { applyRandomModulation, isFieldMappableToRandom, restoreBaseValues } from '../../ermes/ts/randomResolver.ts';

test('processorRegistry loads manifest.json and separates Pre/Post trim endpoints from serial FX stages', () => {
    const addable = listAddableProcessors().map(p => p.type);
    assert.deepEqual(addable, ['param_eq', 'comp', 'clipper', 'limiter']);

    const eqDef = listAddableProcessors().find(p => p.type === 'param_eq')!;
    assert.equal(eqDef.params.length, 20);

    const chain = [
        ...getDefaultFxChain(-3),
    ];
    const eqMod = eqDef.createModule('eq_1');
    chain.splice(1, 0, eqMod);

    const stages = getUserFxStages(chain);
    assert.equal(stages.length, 1);
    assert.equal(stages[0].stageIndex, 0);
    assert.equal(stages[0].module.id, 'eq_1');

    const { preDb, postDb } = getPrePostGainDb(chain);
    assert.equal(Math.round(preDb), -3);
    assert.equal(postDb, 0);

    const sig = getChainStructureSignature(chain);
    assert.equal(sig, '0:param_eq:eq_1');
});

test('NullNode enforces single-cable input, CHAIN default tab, and EXPORT tab', () => {
    const nullNode = new NullNode();
    assert.equal(nullNode.nodeType, 'null');
    assert.equal(nullNode.badgeLabel, 'NULL');
    assert.equal(nullNode.defaultPropertiesTab, 'CHAIN');
    assert.deepEqual(nullNode.propertiesTabs, ['CHAIN', 'EXPORT', 'COMMON']);

    const removedLinks: number[] = [];
    nullNode.graph = {
        removeLink(id: number) {
            removedLinks.push(id);
        },
    } as any;
    nullNode.inputs[0].link = 77;
    const allowed = nullNode.onConnectInput(0, 'audio', {}, {}, 0);
    assert.equal(allowed, true);
    assert.deepEqual(removedLinks, [77]);
    assert.equal(nullNode.onConnectInput(1, 'audio', {}, {}, 0), false);

    const validation = validateGraphDocument({
        format: 'sin-graph',
        version: 1,
        settings: { bpm: 120, total_bars: 4, key: 'C' },
        output: 'm',
        nodes: [
            { id: 's1', type: 'sample' },
            { id: 's2', type: 'sample' },
            { id: 'n1', type: 'null' },
            { id: 'm', type: 'track', role: 'master' },
        ],
        connections: [
            { from: 's1', to: 'n1', type: 'audio' },
            { from: 's2', to: 'n1', type: 'audio' },
            { from: 'n1', to: 'm', type: 'audio' },
        ],
    });
    assert.equal(validation.valid, false);
    assert.ok(validation.errors.some(e => e.includes('at most 1 incoming')));
});

test('chain.<moduleId>.<paramKey> integrates with Random modifier and Field Operators', () => {
    const compDef = listAddableProcessors().find(p => p.type === 'comp')!;
    const compMod = compDef.createModule('comp_a', 'Compressor', {
        params: { ...compDef.defaultParams(), threshold_db: -20 },
    });
    const nullNode = new NullNode();
    nullNode.id = 42;
    nullNode.properties.chain = [getDefaultFxChain()[0], compMod, getDefaultFxChain()[1]];

    const compoundKey = 'chain.comp_a.threshold_db';
    assert.equal(isFieldMappableToRandom(nullNode, compoundKey), true);
    assert.equal(isFieldMappableToRandom(nullNode, 'chain.comp_a.mode'), false);

    const fieldSchema = paramDefToFieldSchema('comp_a', compDef.params[0]);
    assert.equal(fieldSchema.key, compoundKey);
    assert.equal(fieldSchema.type, 'db');

    const rndMod: any = {
        id: 43,
        properties: {
            seed: 99,
            destinations: [
                {
                    id: 'd1',
                    paramKey: compoundKey,
                    paramLabel: 'Threshold',
                    minPercent: -50,
                    maxPercent: 50,
                    baseValue: -20,
                    enabled: true,
                },
            ],
        },
    };
    applyRandomModulation(rndMod, nullNode, { randomFactorGenerator: () => 1.0 });
    assert.notEqual(nullNode.properties.chain[1].params.threshold_db, -20);

    restoreBaseValues(rndMod, nullNode);
    assert.equal(nullNode.properties.chain[1].params.threshold_db, -20);

    // Field Operator evaluation on chain parameter
    nullNode.applyFieldOperator(compoundKey, '-24..-12');
    const evaluatedThresh = Number(nullNode.properties.chain[1].params.threshold_db);
    assert.ok(evaluatedThresh >= -24 && evaluatedThresh <= -12);
});

test('SampleNode displays post-FX realtimePeaks in IRIDE when FX stages are present', () => {
    const sample = new SampleNode();
    const clipperDef = listAddableProcessors().find(p => p.type === 'clipper')!;
    const clipMod = clipperDef.createModule('clip_1');

    const prevWin = (globalThis as any).window;
    (globalThis as any).window = { __sinRealtimeLoaded: true };
    try {
        sample.properties.chain = [...getDefaultFxChain(), clipMod];
        (sample as any).realtimePeaks = new Float32Array([-0.25, 0.25, -0.25, 0.25]);
        const sig = (sample as any).resolveVisualizationSignal();
        assert.equal(sig.buffer, undefined);
        assert.ok(sig.peaks instanceof Float32Array);
        assert.equal(sig.peaks.length, 4);

        // Without user FX stages, keeps standard dry/gain buffer behavior
        sample.properties.chain = getDefaultFxChain();
        const drySig = (sample as any).resolveVisualizationSignal();
        assert.equal(drySig.peaks, undefined);
    } finally {
        (globalThis as any).window = prevWin;
    }
});

test('Param EQ supports 6 filter curves with Q-controlled cutoff slope (6..48 dB/oct)', () => {
    assert.equal(EQ_CURVE_OPTIONS.length, 6);
    assert.equal(qToSlopeDbPerOct(0.2), 6);
    assert.equal(qToSlopeDbPerOct(12.0), 48);
    assert.ok(qToSlopeDbPerOct(2.0) > qToSlopeDbPerOct(0.5));

    // Low Cut at 1kHz evaluated at 250Hz (-2 octaves): 48 dB/oct attenuates dramatically more than 6 dB/oct
    const gentleLowCut = computeEqBandMagDb(0, 1000, 0, 0.2, 250);
    const steepLowCut = computeEqBandMagDb(0, 1000, 0, 12.0, 250);
    assert.ok(gentleLowCut < -10 && gentleLowCut > -16, `expected ~-12 dB, got ${gentleLowCut}`);
    assert.ok(steepLowCut < -60, `expected steep attenuation < -60 dB, got ${steepLowCut}`);

    // High Cut at 1kHz evaluated at 4kHz (+2 octaves)
    const steepHighCut = computeEqBandMagDb(5, 1000, 0, 12.0, 4000);
    assert.ok(steepHighCut < -60, `expected steep high-cut attenuation, got ${steepHighCut}`);

    // Notch at 1kHz attenuates strongly at 1kHz even with 0 dB gain
    const notchDip = computeEqBandMagDb(3, 1000, 0, 2.0, 1000);
    assert.ok(notchDip < -40, `expected deep notch dip, got ${notchDip}`);
});

function createMinimalMockDocument() {
    class MockClassList {
        private set = new Set<string>();
        add(...cls: string[]) { cls.forEach(c => this.set.add(c)); }
        remove(...cls: string[]) { cls.forEach(c => this.set.delete(c)); }
        toggle(c: string, force?: boolean) {
            if (force === undefined) {
                if (this.set.has(c)) { this.set.delete(c); return false; }
                this.set.add(c); return true;
            }
            if (force) this.set.add(c); else this.set.delete(c);
            return force;
        }
        contains(c: string) { return this.set.has(c); }
    }
    class MockElement {
        tagName: string;
        className = '';
        classList = new MockClassList();
        style: Record<string, string> = {};
        dataset: Record<string, string> = {};
        children: MockElement[] = [];
        hidden = false;
        disabled = false;
        title = '';
        type = '';
        textContent = '';
        private _innerHTML = '';
        listeners = new Map<string, Array<(e: any) => void>>();
        width = 320;
        height = 120;
        clientWidth = 320;
        constructor(tag: string) { this.tagName = tag.toUpperCase(); }
        get innerHTML() { return this._innerHTML; }
        set innerHTML(v: string) { this._innerHTML = v; }
        appendChild(child: MockElement) { this.children.push(child); return child; }
        append(...els: MockElement[]) { els.forEach(e => this.children.push(e)); }
        replaceChildren(...els: MockElement[]) { this.children = [...els]; }
        addEventListener(evt: string, fn: (e: any) => void) {
            const list = this.listeners.get(evt) || [];
            list.push(fn);
            this.listeners.set(evt, list);
        }
        click() {
            const list = this.listeners.get('click') || [];
            list.forEach(fn => fn({ stopPropagation() {}, preventDefault() {}, button: 0 }));
        }
        querySelector(sel: string): MockElement | null {
            const cls = sel.startsWith('.') ? sel.slice(1) : null;
            for (const c of this.children) {
                if (cls && (c.className.split(/\s+/).includes(cls) || c.classList.contains(cls))) return c;
                const found = c.querySelector(sel);
                if (found) return found;
            }
            return null;
        }
        querySelectorAll(sel: string): MockElement[] {
            const cls = sel.startsWith('.') ? sel.slice(1) : null;
            const out: MockElement[] = [];
            const walk = (el: MockElement) => {
                for (const c of el.children) {
                    if (cls && (c.className.split(/\s+/).includes(cls) || c.classList.contains(cls))) out.push(c);
                    walk(c);
                }
            };
            walk(this);
            return out;
        }
        getContext() { return null; }
        getBoundingClientRect() { return { left: 0, top: 0, width: 320, height: 120 }; }
    }
    return {
        createElement: (tag: string) => new MockElement(tag),
    };
}

test('Ableton EQ Eight band toggle & zero leaked TransportClock listeners on dynamics scope destroy', () => {
    const prevDoc = (globalThis as any).document;
    (globalThis as any).document = createMinimalMockDocument();
    try {
        const eqDef = listAddableProcessors().find(p => p.type === 'param_eq')!;
        const eqMod = eqDef.createModule('eq_ui');
        const eqHandle = createFxVisualWidget({
            module: eqMod,
            def: eqDef,
            onParamChange: (k, v) => { eqMod.params[k] = v; },
        })!;

        const root: any = eqHandle.element;
        const paramsStrip = root.querySelector('.fx-eq8-band-params');
        assert.equal(paramsStrip.hidden, true, 'Band params strip starts hidden until a band is selected');

        const bandPills = root.querySelectorAll('.fx-eq8-band-pill');
        assert.equal(bandPills.length, 4);
        bandPills[0].click();
        assert.equal(paramsStrip.hidden, false, 'Clicking band 1 reveals Freq / Gain / Q params');

        // Select Low Cut curve (value 0) -> Gain pill hides, Q pill becomes Slope (dB/oct)
        const curveBtns = root.querySelectorAll('.fx-eq8-curve-btn');
        assert.equal(curveBtns.length, 6);
        curveBtns[0].click();
        assert.equal(eqMod.params.b1_type, 0);
        const pills = paramsStrip.querySelectorAll('.fx-vis-param-pill');
        assert.equal(pills[1].hidden, true, 'Gain pill hides on Low Cut curve');
        assert.equal(pills[2].children[1].textContent, 'Slope');
        assert.ok(String(pills[2].children[2].textContent).includes('dB/oct'));

        // Clicking selected band pill again hides bottom params
        bandPills[0].click();
        assert.equal(paramsStrip.hidden, true, 'Clicking active band hides bottom params');
        eqHandle.destroy();

        // All 4 visual widgets (EQ RTA + Clipper/Compressor/Limiter scopes) must unsubscribe cleanly from TransportClock on destroy()
        const baselineListeners = ((defaultTransportClock as any).listeners as Set<unknown>).size;
        for (const procType of ['param_eq', 'clipper', 'comp', 'limiter'] as const) {
            const def = listAddableProcessors().find(p => p.type === procType)!;
            const mod = def.createModule(`${procType}_ui`);
            const handle = createFxVisualWidget({
                module: mod,
                def,
                onParamChange: (k, v) => { mod.params[k] = v; },
            })!;
            assert.equal(
                ((defaultTransportClock as any).listeners as Set<unknown>).size,
                baselineListeners + 1,
                `${procType} visual subscribes to TransportClock while mounted`
            );
            handle.destroy();
            assert.equal(
                ((defaultTransportClock as any).listeners as Set<unknown>).size,
                baselineListeners,
                `${procType} visual leaks zero listeners after destroy()`
            );
        }
    } finally {
        (globalThis as any).document = prevDoc;
    }
});
