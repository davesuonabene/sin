import test from 'node:test';
import assert from 'node:assert/strict';
import { TrackNode } from '../src/nodes/TrackNode.ts';
import { SampleNode } from '../src/nodes/SampleNode.ts';
import { resolveAssignedAssetFilters } from '../../ermes/ts/assetResolver.ts';
import { resolveAssignedRandomModifiers } from '../../ermes/ts/randomResolver.ts';
import { serializeNodeSubtree } from '../../ermes/ts/serializer.ts';

test('renderable nodes default to opened visualizer and flagged freeze & render', () => {
    const sample = new SampleNode();
    const track = new TrackNode();

    for (const node of [sample, track]) {
        assert.equal(node.properties.visualization_enabled, true);
        assert.equal(node.properties.freeze_refresh, true);
        assert.equal(node.properties.render_enabled, true);
        assert.equal(node.isVisualizationActive, true);
        assert.equal(node.resizable, true);

        // Size initialized to expanded visual panel
        assert.equal(node.size[0], node.visualPanelWidth);
        assert.equal(node.size[1], node.visualPanelHeight);
    }
});

test('node buttons include Play, Render toggle, Freeze toggle, Iride toggle, and Delete', () => {
    const node = new SampleNode();

    assert.ok(node.previewBtn, 'Has preview button');
    assert.ok(node.renderToggleBtn, 'Has render toggle button');
    assert.ok(node.freezeToggleBtn, 'Has freeze toggle button');
    assert.ok(node.eyeBtn, 'Has eye (iride) button');
    assert.ok(node.removeBtn, 'Has remove button');
    assert.equal(node.buttons.length, 5);

    // Initial button toggle states
    assert.equal(node.renderToggleBtn.isToggled?.(node), true);
    assert.equal(node.freezeToggleBtn.isToggled?.(node), true);

    // Clicking renderToggleBtn toggles render_enabled
    node.renderToggleBtn.onClick();
    assert.equal(node.properties.render_enabled, false);
    assert.equal(node.renderToggleBtn.isToggled?.(node), false);

    node.renderToggleBtn.onClick();
    assert.equal(node.properties.render_enabled, true);
    assert.equal(node.renderToggleBtn.isToggled?.(node), true);

    // Clicking freezeToggleBtn toggles freeze_refresh
    node.freezeToggleBtn.onClick();
    assert.equal(node.properties.freeze_refresh, false);
    assert.equal(node.freezeToggleBtn.isToggled?.(node), false);

    node.freezeToggleBtn.onClick();
    assert.equal(node.properties.freeze_refresh, true);
    assert.equal(node.freezeToggleBtn.isToggled?.(node), true);

    // Clicking eyeBtn toggles visualization panel
    node.eyeBtn.onClick();
    assert.equal(node.isVisualizationActive, false);
    assert.equal(node.size[0], 44);
    assert.equal(node.size[1], 44);

    node.eyeBtn.onClick();
    assert.equal(node.isVisualizationActive, true);
    assert.equal(node.size[0], node.visualPanelWidth);
});

test('resolveAssignedAssetFilters respects globalFreeze and node freeze_refresh flag', async () => {
    const sample: any = {
        id: 1,
        type: 'Audio/Sample',
        properties: {
            node_name: 'Sample',
            freeze_refresh: true,
            asset_modifier_id: 2
        },
        updateProperty(key: string, val: any) {
            this.properties[key] = val;
        }
    };

    const pool: any = {
        id: 2,
        type: 'Audio/AssetFilter',
        properties: {
            parentId: 1,
            refresh_mode: 'global',
            selected_items: [
                { id: 101, filepath: 'item1.wav' },
                { id: 102, filepath: 'item2.wav' }
            ],
            output_value: 'item1.wav',
            output_item_id: 101,
            seed: 0.123
        }
    };

    const mockGraph = {
        getNodeById: (id: number) => {
            if (id === 1) return sample;
            if (id === 2) return pool;
            return null;
        },
        _nodes: [sample, pool]
    };

    const initialSeed = pool.properties.seed;

    // 1. When globalFreeze is true and sample has freeze_refresh = true (default)
    sample.properties.freeze_refresh = true;
    await resolveAssignedAssetFilters(mockGraph, 1, {
        kind: 'preview',
        globalPreview: true,
        globalFreeze: true
    });
    assert.equal(pool.properties.seed, initialSeed, 'Seed should NOT advance when global freeze is active and node is freeze-flagged');

    // 2. When globalFreeze is true but sample has freeze_refresh = false (user toggled off freeze)
    sample.properties.freeze_refresh = false;
    await resolveAssignedAssetFilters(mockGraph, 1, {
        kind: 'preview',
        globalPreview: true,
        globalFreeze: true
    });
    assert.notEqual(pool.properties.seed, initialSeed, 'Seed SHOULD advance when node has freeze_refresh = false even during global freeze');

    // 3. When globalFreeze is false, seed advances normally
    const seedAfterUnfrozen = pool.properties.seed;
    sample.properties.freeze_refresh = true;
    await resolveAssignedAssetFilters(mockGraph, 1, {
        kind: 'preview',
        globalPreview: true,
        globalFreeze: false
    });
    assert.notEqual(pool.properties.seed, seedAfterUnfrozen, 'Seed advances when global freeze is inactive');
});

test('resolveAssignedRandomModifiers respects globalFreeze and node freeze_refresh flag', async () => {
    const track: any = {
        id: 10,
        type: 'Audio/Track',
        properties: {
            gain: 0,
            freeze_refresh: true
        },
        getFields: () => [
            { key: 'gain', label: 'Gain', type: 'slider', min: -24, max: 12, step: 0.1, default: 0 }
        ],
        updateProperty(key: string, val: any) {
            this.properties[key] = val;
        }
    };

    const random: any = {
        id: 11,
        type: 'Audio/Random',
        properties: {
            parentId: 10,
            refresh_mode: 'global',
            seed: 0.5,
            destinations: [
                {
                    id: 'dest-1',
                    paramKey: 'gain',
                    paramLabel: 'Gain',
                    minPercent: -20,
                    maxPercent: 20,
                    baseValue: 1.0,
                    enabled: true,
                    currentValue: 1.0
                }
            ]
        }
    };

    const mockGraph = {
        getNodeById: (id: number) => {
            if (id === 10) return track;
            if (id === 11) return random;
            return null;
        },
        _nodes: [track, random]
    };

    const initialSeed = random.properties.seed;

    // 1. When globalFreeze is true and track has freeze_refresh = true (default)
    track.properties.freeze_refresh = true;
    await resolveAssignedRandomModifiers(mockGraph, 10, {
        kind: 'preview',
        globalPreview: true,
        globalFreeze: true
    });
    assert.equal(random.properties.seed, initialSeed, 'Random seed should NOT advance when global freeze is active');

    // 2. When globalFreeze is true but track has freeze_refresh = false
    track.properties.freeze_refresh = false;
    await resolveAssignedRandomModifiers(mockGraph, 10, {
        kind: 'preview',
        globalPreview: true,
        globalFreeze: true
    });
    assert.notEqual(random.properties.seed, initialSeed, 'Random seed SHOULD advance when node has freeze_refresh = false');
});

test('frozen nodes preserve manual BPM edits and serializer prioritizes node settings', async () => {
    const sample: any = {
        id: 20,
        type: 'Audio/Sample',
        properties: {
            node_type: 'sample',
            asset_modifier_id: 21,
            filepath: '/assets/sample_a.wav',
            original_bpm: 145, // user edited original_bpm from 120 to 145
            target_bpm: 145,
            key: 'F#m',
            freeze_refresh: true
        },
        updateProperty(key: string, val: any) {
            this.properties[key] = val;
        }
    };

    const pool: any = {
        id: 21,
        type: 'Audio/AssetFilter',
        properties: {
            refresh_mode: 'global',
            output_value: '/assets/sample_a.wav',
            output_bpm: 120, // initial resolved output_bpm
            output_key: 'Am',
            selected_items: [
                { id: 1, filepath: '/assets/sample_a.wav', bpm: 120, original_bpm: 120, key: 'Am' }
            ]
        }
    };

    const mockGraph = {
        getNodeById: (id: number) => {
            if (id === 20) return sample;
            if (id === 21) return pool;
            return null;
        },
        _nodes: [sample, pool]
    };

    // When global freeze is active, resolving asset filters MUST NOT overwrite sample's edited original_bpm (145)
    await resolveAssignedAssetFilters(mockGraph, 20, {
        kind: 'preview',
        globalPreview: true,
        globalFreeze: true
    });

    assert.equal(sample.properties.original_bpm, 145, 'Sample original_bpm must NOT be clobbered by pool output_bpm when frozen');
    assert.equal(sample.properties.key, 'F#m', 'Sample key must NOT be clobbered when frozen');
    assert.equal(pool.properties.output_bpm, 145, 'Pool output_bpm should sync to node edited BPM');

    // Serialization should serialize node's edited original_bpm (145), not fallback or pool default
    const serialized = serializeNodeSubtree(mockGraph, 20);
    assert.equal(serialized.original_bpm, 145, 'Serialized model must have node original_bpm (145)');
    assert.equal(serialized.key, 'F#m', 'Serialized model must have node key (F#m)');
});

test('SampleNode target_bpm defaults to global and decouples to custom stretch BPM', () => {
    const sample = new SampleNode();
    assert.equal(sample.properties.target_bpm, 'global', 'target_bpm must default to "global"');

    const targetBpmField = SampleNode.fields.find(f => f.key === 'target_bpm');
    assert.ok(targetBpmField, 'target_bpm field schema exists');
    assert.equal(targetBpmField?.type, 'global_float', 'target_bpm field type is global_float');
    assert.equal(targetBpmField?.default, 'global', 'target_bpm field default is "global"');

    // Test serialization when target_bpm is "global"
    const sampleNodeObj: any = {
        id: 30,
        type: 'Audio/Sample',
        properties: {
            node_type: 'sample',
            filepath: '/assets/sample_loop.wav',
            original_bpm: 120,
            target_bpm: 'global',
            bpm: 'global'
        }
    };
    const mockGraph = {
        getNodeById: (id: number) => (id === 30 ? sampleNodeObj : null),
        _nodes: [sampleNodeObj]
    };

    const serializedGlobal = serializeNodeSubtree(mockGraph, 30);
    assert.equal(serializedGlobal.target_bpm, undefined, 'When global, target_bpm is undefined so system.bpm is used');
    assert.equal(serializedGlobal.bpm, 120, 'Inherited bpm is 120');

    // Test serialization when decoupled to a custom local BPM
    sampleNodeObj.properties.target_bpm = 140;
    sampleNodeObj.properties.bpm = 140;
    const serializedLocal = serializeNodeSubtree(mockGraph, 30);
    assert.equal(serializedLocal.target_bpm, 140, 'When unlinked, target_bpm is 140 for individual stretching');
    assert.equal(serializedLocal.bpm, 140, 'Bpm is 140');
});

test('resolveAssignedAssetFilters resolves whole graph when rootNodeId is omitted', async () => {
    const sampleA: any = {
        id: 40,
        type: 'Audio/Sample',
        properties: { node_name: 'Sample A', asset_modifier_id: 41, freeze_refresh: true },
        updateProperty(k: string, v: any) { this.properties[k] = v; }
    };
    const poolA: any = {
        id: 41,
        type: 'Audio/AssetFilter',
        properties: {
            parentId: 40,
            refresh_mode: 'global',
            selected_items: [{ id: 1, filepath: 'kick1.wav' }, { id: 2, filepath: 'kick2.wav' }],
            output_value: 'kick1.wav',
            output_item_id: 1,
            seed: 10
        }
    };
    const sampleB: any = {
        id: 42,
        type: 'Audio/Sample',
        properties: { node_name: 'Sample B', asset_modifier_id: 43, freeze_refresh: true },
        updateProperty(k: string, v: any) { this.properties[k] = v; }
    };
    const poolB: any = {
        id: 43,
        type: 'Audio/AssetFilter',
        properties: {
            parentId: 42,
            refresh_mode: 'global',
            selected_items: [{ id: 3, filepath: 'snare1.wav' }, { id: 4, filepath: 'snare2.wav' }],
            output_value: 'snare1.wav',
            output_item_id: 3,
            seed: 20
        }
    };

    const mockGraph = {
        getNodeById: (id: number) => {
            if (id === 40) return sampleA;
            if (id === 41) return poolA;
            if (id === 42) return sampleB;
            if (id === 43) return poolB;
            return null;
        },
        _nodes: [sampleA, poolA, sampleB, poolB]
    };

    // When rootNodeId is undefined/null and not frozen, both pools in the graph advance
    await resolveAssignedAssetFilters(mockGraph, undefined as any, {
        kind: 'preview',
        globalPreview: true,
        globalFreeze: false
    });

    assert.notEqual(poolA.properties.seed, 10, 'Pool A seed should advance when resolving whole graph');
    assert.notEqual(poolB.properties.seed, 20, 'Pool B seed should advance when resolving whole graph');

    // When globalFreeze is true, neither advances
    const seedA = poolA.properties.seed;
    const seedB = poolB.properties.seed;
    await resolveAssignedAssetFilters(mockGraph, undefined as any, {
        kind: 'preview',
        globalPreview: true,
        globalFreeze: true
    });
    assert.equal(poolA.properties.seed, seedA, 'Pool A seed should NOT advance when whole graph is frozen');
    assert.equal(poolB.properties.seed, seedB, 'Pool B seed should NOT advance when whole graph is frozen');
});

test('resolveAssignedRandomModifiers resolves whole graph when rootNodeId is omitted', async () => {
    const trackA: any = {
        id: 50,
        type: 'Audio/Track',
        properties: { gain: 0, freeze_refresh: true },
        getFields: () => [{ key: 'gain', label: 'Gain', type: 'slider', default: 0 }],
        updateProperty(k: string, v: any) { this.properties[k] = v; }
    };
    const randomA: any = {
        id: 51,
        type: 'Audio/Random',
        properties: {
            parentId: 50,
            refresh_mode: 'global',
            seed: 100,
            destinations: [{ id: 'd1', paramKey: 'gain', baseValue: 0, minPercent: -10, maxPercent: 10, enabled: true }]
        }
    };
    const trackB: any = {
        id: 52,
        type: 'Audio/Track',
        properties: { gain: 0, freeze_refresh: true },
        getFields: () => [{ key: 'gain', label: 'Gain', type: 'slider', default: 0 }],
        updateProperty(k: string, v: any) { this.properties[k] = v; }
    };
    const randomB: any = {
        id: 53,
        type: 'Audio/Random',
        properties: {
            parentId: 52,
            refresh_mode: 'global',
            seed: 200,
            destinations: [{ id: 'd2', paramKey: 'gain', baseValue: 0, minPercent: -10, maxPercent: 10, enabled: true }]
        }
    };

    const mockGraph = {
        getNodeById: (id: number) => {
            if (id === 50) return trackA;
            if (id === 51) return randomA;
            if (id === 52) return trackB;
            if (id === 53) return randomB;
            return null;
        },
        _nodes: [trackA, randomA, trackB, randomB]
    };

    await resolveAssignedRandomModifiers(mockGraph, undefined as any, {
        kind: 'preview',
        globalPreview: true,
        globalFreeze: false
    });

    assert.notEqual(randomA.properties.seed, 100, 'Random A seed should advance');
    assert.notEqual(randomB.properties.seed, 200, 'Random B seed should advance');

    const seedA = randomA.properties.seed;
    const seedB = randomB.properties.seed;
    await resolveAssignedRandomModifiers(mockGraph, undefined as any, {
        kind: 'preview',
        globalPreview: true,
        globalFreeze: true
    });
    assert.equal(randomA.properties.seed, seedA, 'Random A seed should NOT advance when frozen');
    assert.equal(randomB.properties.seed, seedB, 'Random B seed should NOT advance when frozen');
});

