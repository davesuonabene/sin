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

test('node buttons include Play, Render toggle, Freeze toggle, Iride toggle, Pool, Random, and Delete', () => {
    const node = new SampleNode();

    assert.ok(node.previewBtn, 'Has preview button');
    assert.ok(node.renderToggleBtn, 'Has render toggle button');
    assert.ok(node.freezeToggleBtn, 'Has freeze toggle button');
    assert.ok(node.eyeBtn, 'Has eye (iride) button');
    assert.ok(node.poolBtn, 'Has pool button');
    assert.ok(node.randomBtn, 'Has random button');
    assert.ok(node.removeBtn, 'Has remove button');
    assert.equal(node.buttons.length, 7);

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

test('Distance model, bidirectional node resizing, and top-right Pool / Random modifier badges', () => {
    const sample = new SampleNode();
    sample.id = 101;

    // Stage 1: Close distance (scale = 1.0)
    assert.equal(sample.currentDistanceStage, 1);
    assert.equal(sample.isViewerCookEnabled, true);
    assert.equal(sample.isVisualizationActive, true);
    assert.equal(sample.isMinifiedStage, false);

    // Unconfigured node with nothing activated has 0 visible canvas buttons even when touched/selected
    assert.equal(sample.getVisibleCanvasButtons(true).length, 0, 'No badges shown on unattached node when selected');

    // When activated/definitely created, modifier badges appear in top-right
    sample.isPoolDefinitelyCreated = () => true;
    sample.isRandomModDefinitelyCreated = () => true;
    assert.equal(sample.getVisibleCanvasButtons(true).length, 2, 'Pool and Random modifier badges are visible in top-right when activated');
    assert.equal(sample.poolBtn.label, 'POOL');
    assert.equal(sample.randomBtn.label, 'RND');
    assert.equal(sample.poolBtn.x, -63);
    assert.equal(sample.poolBtn.y, 4);
    assert.equal(sample.randomBtn.x, -32);
    assert.equal(sample.randomBtn.y, 4);

    // Bidirectional resizing: expand and then shrink back down
    sample.onResize([360, 140]);
    assert.equal(sample.size[0], 360);
    assert.equal(sample.size[1], 140);
    assert.equal(sample.properties.visual_width, 360);
    assert.equal(sample.properties.visual_height, 140);

    sample.onResize([150, 60]);
    assert.equal(sample.size[0], 150, 'Node shrinks horizontally when dragged inward');
    assert.equal(sample.size[1], 60, 'Node shrinks vertically when dragged inward');
    assert.equal(sample.properties.visual_width, 150);
    assert.equal(sample.properties.visual_height, 60);

    // Intermediate zoom (scale = 0.55) remains in Stage 1
    sample.syncDistanceStage(0.55);
    assert.equal(sample.currentDistanceStage, 1);
    assert.equal(sample.isVisualizationActive, true, 'Viewer remains active above 0.40');
    assert.equal(sample.isMinifiedStage, false);

    // Stage 3: Far / Maximum distance (scale = 0.30) -> Viewer force-shut and not toggleable back
    sample.syncDistanceStage(0.30);
    assert.equal(sample.currentDistanceStage, 3);
    assert.equal(sample.isVisualizationActive, false, 'Viewer is force-shut at Stage 3');
    assert.equal(sample.size[0], 44);
    assert.equal(sample.size[1], 44);
    assert.equal(sample.getVisibleCanvasButtons().length, 0, 'No buttons (including Play) are shown at Stage 3');

    // Attempting to toggle visualization at Stage 3 is locked out
    sample.toggleVisualization();
    assert.equal(sample.isVisualizationActive, false, 'Viewer cannot be toggled back on at Stage 3');
    assert.equal(sample.properties.visualization_enabled, true, 'Underlying Viewer Cook preference is preserved');

    // Returning above 0.44 restores the viewer and custom size automatically
    sample.syncDistanceStage(0.55);
    assert.equal(sample.currentDistanceStage, 1);
    assert.equal(sample.isVisualizationActive, true);
    assert.equal(sample.size[0], 150);

    // Eye button acts as per-node "Viewer Cook" shutoff in Stage 1
    sample.eyeBtn.onClick();
    assert.equal(sample.isViewerCookEnabled, false, 'Eye button shuts off Viewer Cook for this node');
    assert.equal(sample.isVisualizationActive, false);
    assert.equal(sample.size[0], 44);
    assert.equal(sample.poolBtn.label, 'P');
    assert.equal(sample.randomBtn.label, 'R');
    assert.equal(sample.poolBtn.x, -30);
    assert.equal(sample.poolBtn.y, 2);
    assert.equal(sample.randomBtn.x, -15);
    assert.equal(sample.randomBtn.y, 2);
});

test('Pool and RND visualizer lifecycle: panel open border highlight, selected-for-deletion full highlight, no double-click deletion, and resetModifier', () => {
    const sample = new SampleNode();
    sample.id = 202;

    // 1. Initially nothing activated -> 0 buttons
    assert.equal(sample.isPoolDefinitelyCreated(), false);
    assert.equal(sample.isRandomModDefinitelyCreated(), false);
    assert.equal(sample.getVisibleCanvasButtons(true).length, 0);

    // 2. Opening but not editing: panel is open -> badge is visible with panelOpen state
    let mockPoolPanelOpen = true;
    Object.defineProperty(sample, 'isPoolPanelOpen', { get: () => mockPoolPanelOpen, configurable: true });
    assert.equal(sample.getVisibleCanvasButtons(true).length, 1, 'Badge visible when panel is open');
    assert.equal(sample.poolBtn.isPanelOpen?.(sample), true, 'Border highlight enabled when panel open');
    assert.equal(sample.poolBtn.isSelectedForDeletion?.(sample), false);

    // When panel closes without editing -> badge does NOT stick to visualizer
    mockPoolPanelOpen = false;
    assert.equal(sample.getVisibleCanvasButtons(true).length, 0, 'Badge does not stick when panel closes without editing');

    // 3. Definitely created with content -> badge persists
    sample.isPoolDefinitelyCreated = () => true;
    assert.equal(sample.getVisibleCanvasButtons(true).length, 1);

    // 4. Selecting and double-clicking badge on visualizer -> selects ("highlight of all") and NEVER deletes on second click
    sample.poolBtn.onClick();
    assert.equal(sample.selectedModifierBadge, 'pool');
    assert.equal(sample.poolBtn.isSelectedForDeletion?.(sample), true, 'Highlight of all enabled when selected for deletion');
    sample.poolBtn.onClick(); // second click / double-click
    assert.equal(sample.selectedModifierBadge, 'pool', 'Double-clicking badge keeps it selected and does NOT trigger deletion');
    assert.equal(sample.getVisibleCanvasButtons(true).length, 1, 'Badge remains present after double-click');

    // 5. Right-click hit testing identifies badge for context menu Delete
    const badgeX = sample.size[0] + sample.poolBtn.x + 2;
    const badgeY = sample.poolBtn.y + 2;
    assert.equal(sample.getModifierBadgeAtPos(badgeX, badgeY), 'pool');
    assert.equal(sample.getModifierBadgeAtPos(10, 10), null);

    // 6. Resetting modifier (via Backspace/Delete or right-click Delete) -> deletes badge
    sample.resetModifier('pool');
    sample.isPoolDefinitelyCreated = () => false;
    assert.equal(sample.selectedModifierBadge, null);
    assert.equal(sample.getVisibleCanvasButtons(true).length, 0, 'Badge deleted after reset');
});

test('Audio nodes report live activity state for minimal perimeter border accents', async () => {
    const { SequenceNode } = await import('../src/nodes/SequenceNode.ts');
    const { ArrangementNode } = await import('../src/nodes/ArrangementNode.ts');

    const seq = new SequenceNode();
    seq.properties.sequence = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
    seq.properties.step_length = 0.25;

    const activeTelemetry = {
        time: 0.0,
        duration: 8.0,
        beat: 0.0, // Step 0 (gate = 1)
        bar: 0.0,
        step: 0,
        isPlaying: true
    };
    const seqStateStep0 = seq.getLiveActivityState(activeTelemetry);
    assert.equal(seqStateStep0.isTriggered, true);
    assert.equal(seqStateStep0.progress, 1 / 16);

    const seqStateStep1 = seq.getLiveActivityState({ ...activeTelemetry, beat: 0.25, step: 1 });
    assert.equal(seqStateStep1.isTriggered, false);

    const arr = new ArrangementNode();
    arr.properties.total_bars = 4;
    const arrState = arr.getLiveActivityState({ ...activeTelemetry, bar: 2.0 });
    assert.equal(arrState.isTriggered, true);
    assert.equal(arrState.progress, 0.5);
});

test('resolveAssignedAssetFilters hydrates staged save pool locators via resolveLibraryAssets fallback when libraryFiles is incomplete', async () => {
    const prevWindow = (globalThis as any).window;
    const prevFetch = globalThis.fetch;
    try {
        (globalThis as any).window = {
            resolveLibraryAssets: async (refs: any[]) => {
                assert.equal(refs.length, 1);
                assert.equal(refs[0].id, 13756);
                return [{
                    id: 13756,
                    name: 'Kick_13756.wav',
                    type: 'audio',
                    absolute_path: '/vault/Kick_13756.wav',
                    bpm: 128,
                    key: 'Cm'
                }];
            },
            findLibraryFileForPoolLocator: (files: any[], item: any) =>
                files.find((f: any) => String(f.id) === String(item.id)) || null,
            findLibraryFile: (files: any[], path: string) =>
                files.find((f: any) => f.absolute_path === path) || null,
            findLibraryFileById: (files: any[], id: any) =>
                files.find((f: any) => String(f.id) === String(id)) || null,
            dispatchEvent: () => true
        };
        globalThis.fetch = (async () => ({
            ok: true,
            status: 200,
            json: async () => ({
                sample: '/vault/Kick_13756.wav',
                item: { id: 13756 },
                bpm: 128,
                key: 'Cm'
            })
        })) as any;

        const sample: any = {
            id: 1,
            type: 'Audio/Sample',
            properties: {
                node_name: 'Sample',
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
                output_type: 'asset_path',
                refresh_mode: 'global',
                // Staged save stripped selected_items down to { id } and removed output_value
                selected_items: [{ id: 13756 }],
                seed: 42
            }
        };

        const mockGraph = {
            getNodeById: (id: number) => (id === 1 ? sample : id === 2 ? pool : null),
            _nodes: [sample, pool]
        };

        await resolveAssignedAssetFilters(mockGraph, 1, {
            kind: 'preview',
            globalPreview: false,
            globalFreeze: true,
            libraryFiles: [] // Simulates incomplete libraryFiles array
        });

        assert.equal(pool.properties.output_value, '/vault/Kick_13756.wav');
        assert.equal(sample.properties.filepath, '/vault/Kick_13756.wav');
        assert.equal(sample.properties.library_item_id, 13756);
    } finally {
        (globalThis as any).window = prevWindow;
        globalThis.fetch = prevFetch;
    }
});

function createRecordingCanvasCtx() {
    const arcs: Array<{ cx: number; cy: number; r: number; sa: number; ea: number; fillStyle: string; strokeStyle: string }> = [];
    const texts: Array<{ text: string; x: number; y: number; font: string; fillStyle: string }> = [];
    const fills: string[] = [];
    const strokes: Array<{ strokeStyle: string; lineWidth: number }> = [];
    const fillRects: Array<{ x: number; y: number; w: number; h: number; fillStyle: string }> = [];
    const lineDashes: number[][] = [];
    const alphas: number[] = [];

    const ctx: any = {
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1,
        font: '11px sans-serif',
        textAlign: 'left',
        textBaseline: 'alphabetic',
        globalAlpha: 1,
        save: () => { alphas.push(ctx.globalAlpha); },
        restore: () => { ctx.globalAlpha = 1; },
        clip: () => { },
        beginPath: () => { },
        closePath: () => { },
        moveTo: () => { },
        lineTo: () => { },
        arcTo: () => { },
        quadraticCurveTo: () => { },
        bezierCurveTo: () => { },
        ellipse: () => { },
        rect: () => { },
        roundRect: () => { },
        arc: (cx: number, cy: number, r: number, sa: number, ea: number) => {
            arcs.push({ cx, cy, r, sa, ea, fillStyle: String(ctx.fillStyle), strokeStyle: String(ctx.strokeStyle) });
        },
        fill: () => {
            fills.push(String(ctx.fillStyle));
            if (ctx.globalAlpha < 1) alphas.push(ctx.globalAlpha);
        },
        stroke: () => {
            strokes.push({ strokeStyle: String(ctx.strokeStyle), lineWidth: Number(ctx.lineWidth) });
        },
        fillRect: (x: number, y: number, w: number, h: number) => {
            fillRects.push({ x, y, w, h, fillStyle: String(ctx.fillStyle) });
        },
        fillText: (text: string, x: number, y: number) => {
            texts.push({ text: String(text), x, y, font: String(ctx.font), fillStyle: String(ctx.fillStyle) });
        },
        measureText: (text: string) => ({ width: String(text).length * 6.5 }),
        setLineDash: (segments: number[]) => {
            lineDashes.push([...segments]);
        },
    };
    return { ctx, arcs, texts, fills, strokes, fillRects, lineDashes, alphas };
}

test('Closed, distant, and opened IRIDE visualizations render radial Arrangement, Sample slot index, Sequence step lighting, Master RMS/clip, and distant name badges without moving perimeter bars', async () => {
    const { ArrangementNode } = await import('../src/nodes/ArrangementNode.ts');
    const { SequenceNode } = await import('../src/nodes/SequenceNode.ts');
    const { defaultTransportClock, CLIP_FILL_COLOR, CLIP_MARKER_COLOR } = await import('../../packages/iride/src/index.ts');

    const prevWindow = (globalThis as any).window;
    const winObj: any = {
        ...(prevWindow || {}),
        dispatchEvent: () => true,
        addEventListener: () => { },
        removeEventListener: () => { },
    };
    (globalThis as any).window = winObj;

    try {
        defaultTransportClock.setBpm(120);

        // 1. SequenceNode: no moving perimeter bar (no setLineDash), step lighting dims inactive steps & lights active steps
        const seq = new SequenceNode();
        seq.id = 301;
        seq.properties.node_name = 'Kick Seq';
        seq.properties.sequence = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
        seq.properties.step_length = 0.25;
        seq.properties.visualization_enabled = false;

        defaultTransportClock.update(0.0, 4.0, true); // beat 0 -> step 0 (active)
        const seqRecActive = createRecordingCanvasCtx();
        seq.drawCanvas(seqRecActive.ctx, { ds: { scale: 1.0 } });
        assert.equal(seqRecActive.lineDashes.length, 0, 'Closed SequenceNode must not draw moving dashed perimeter bar');
        assert.ok(seqRecActive.fills.includes('rgba(255, 255, 255, 0.16)'), 'Active step should apply step-lighting sheen');

        defaultTransportClock.update(0.125, 4.0, true); // beat 0.25 -> step 1 (inactive)
        const seqRecInactive = createRecordingCanvasCtx();
        seq.drawCanvas(seqRecInactive.ctx, { ds: { scale: 1.0 } });
        assert.ok(seqRecInactive.alphas.includes(0.65), 'Inactive step should dim closed node body');

        // Opened SequenceNode shows subtle header wash on active step without obstructing viewport
        seq.properties.visualization_enabled = true;
        seq.size = seq.computeSize();
        defaultTransportClock.update(0.0, 4.0, true);
        const seqOpenRec = createRecordingCanvasCtx();
        seq.drawCanvas(seqOpenRec.ctx, { ds: { scale: 1.0 } });
        assert.ok(
            seqOpenRec.fillRects.some(r => r.y === 0 && r.h === 22 && r.fillStyle.startsWith('rgba(')),
            'Opened SequenceNode should pulse its 22px header strip on active step'
        );

        // 2. ArrangementNode: centered circular radial loop progress in closed, distant, and opened header
        const arr = new ArrangementNode();
        arr.id = 302;
        arr.properties.node_name = 'Song Form';
        arr.properties.total_bars = 4;
        arr.properties.section_points = [2];
        arr.properties.section_probability = [1, 1];
        arr.properties.visualization_enabled = false;

        defaultTransportClock.update(2.0, 8.0, true); // 1 bar = 2s at 120 BPM -> bar 1 / 4 = 0.25 progress
        const arrClosedRec = createRecordingCanvasCtx();
        arr.drawCanvas(arrClosedRec.ctx, { ds: { scale: 1.0 } });
        assert.equal(arrClosedRec.lineDashes.length, 0, 'Closed ArrangementNode must not draw moving dashed perimeter bar');
        assert.ok(
            arrClosedRec.arcs.some(a => a.cx === 22 && a.cy === 22 && a.r === 14),
            'Closed ArrangementNode must render centered radial track circle (cx=22, cy=22, r=14)'
        );
        assert.ok(
            arrClosedRec.arcs.some(a => a.cx === 22 && a.cy === 22 && a.r > 12 && Math.abs(a.ea - 0) < 1e-4),
            'Closed ArrangementNode radial wedge should sweep 25% clockwise to 3 o-clock (angle 0)'
        );

        // Distant Stage 3 ArrangementNode keeps radial progress and always shows small grey name label on top without background
        const arrDistantRec = createRecordingCanvasCtx();
        arr.drawCanvas(arrDistantRec.ctx, { ds: { scale: 0.30 } });
        assert.equal(arr.currentDistanceStage, 3);
        assert.ok(arrDistantRec.arcs.some(a => a.cx === 22 && a.cy === 22 && a.r === 14));
        const arrDistantLabel = arrDistantRec.texts.find(t => t.text === 'Song Form');
        assert.ok(arrDistantLabel, 'Distant Stage 3 node must display its name on top');
        assert.equal(arrDistantLabel.fillStyle, '#64748b', 'Icon name label must use grey text');
        assert.ok(!arrDistantRec.fills.includes('rgba(15, 23, 42, 0.84)') && !arrDistantRec.fills.includes('rgba(7, 17, 31, 0.95)'), 'Icon name label must have no background fill');
        const labelFontSize = Number(arrDistantLabel.font.match(/\s([\d.]+)px/)?.[1] || 0);
        assert.ok(labelFontSize > 0 && labelFontSize <= 20, `Expected distant label fontSize <= 20, got ${labelFontSize}`);

        // Opened ArrangementNode displays mini radial dial inside 22px header
        arr.properties.visualization_enabled = true;
        arr.size = arr.computeSize();
        const arrOpenRec = createRecordingCanvasCtx();
        arr.drawCanvas(arrOpenRec.ctx, { ds: { scale: 1.0 } });
        assert.ok(
            arrOpenRec.arcs.some(a => a.cy === 11 && a.r === 5.5),
            'Opened ArrangementNode must render compact r=5.5 radial indicator in header'
        );

        // 3. SampleNode: shows current slot index in closed, distant, and opened header, following live manifestEvents
        const sample = new SampleNode();
        sample.id = 303;
        sample.properties.node_name = 'Bass Loop';
        sample.properties.slots = [
            { slot: 0, filepath: '/a.wav' },
            { slot: 1, filepath: '/b.wav' },
            { slot: 2, filepath: '/c.wav' }
        ];
        sample.activeSlotIndex = 1;
        sample.properties.visualization_enabled = false;

        defaultTransportClock.update(0.0, 4.0, false);
        const sampleIdleRec = createRecordingCanvasCtx();
        sample.drawCanvas(sampleIdleRec.ctx, { ds: { scale: 1.0 } });
        assert.ok(
            sampleIdleRec.texts.some(t => t.text === '1' && t.x === 22),
            'Closed SampleNode should display centered active slot index 1'
        );

        // Live manifest event overrides displayed slot to 2 during playback
        (sample as any).manifestEvents = [{ time: 0.0, duration: 1.0, slot: 2 }];
        defaultTransportClock.update(0.5, 4.0, true);
        const sampleLiveDistantRec = createRecordingCanvasCtx();
        sample.drawCanvas(sampleLiveDistantRec.ctx, { ds: { scale: 0.28 } });
        assert.ok(sampleLiveDistantRec.texts.some(t => t.text === '2' && t.x === 22), 'Distant SampleNode should display live playing slot index 2');
        assert.ok(sampleLiveDistantRec.texts.some(t => t.text === 'Bass Loop'), 'Distant SampleNode must display its name on top');

        sample.properties.visualization_enabled = true;
        sample.size = sample.computeSize();
        const sampleOpenRec = createRecordingCanvasCtx();
        sample.drawCanvas(sampleOpenRec.ctx, { ds: { scale: 1.0 } });
        assert.ok(sampleOpenRec.texts.some(t => t.text === '2' && t.y <= 22), 'Opened SampleNode should display live slot index pill in header');

        // 4. Master TrackNode: RMS modulates own color, turns red on clip, latches red marker until Parameters opened
        const master = new TrackNode();
        master.id = 304;
        master.properties.node_name = 'Master Output';
        master.properties.role = 'master';
        master.properties.color = '#0f172a';
        master.color = '#0f172a';
        master.properties.visualization_enabled = false;

        // Silence -> base color
        defaultTransportClock.setMasterLevels(0, 0);
        defaultTransportClock.update(0.0, 4.0, false);
        const masterIdleRec = createRecordingCanvasCtx();
        master.drawCanvas(masterIdleRec.ctx, { ds: { scale: 1.0 } });
        assert.ok(masterIdleRec.fills.includes('#0f172a'));
        assert.equal(master.hasClipWarning, false);

        // Mid RMS -> own hue brightened, not red, no clip latch
        defaultTransportClock.setMasterLevels(0.35, 0.55);
        defaultTransportClock.update(0.5, 4.0, true);
        const masterRmsRec = createRecordingCanvasCtx();
        master.drawCanvas(masterRmsRec.ctx, { ds: { scale: 1.0 } });
        assert.ok(masterRmsRec.fills.some(f => f.startsWith('rgb(')), 'Master should modulate its own color by RMS');
        assert.ok(!masterRmsRec.fills.includes(CLIP_FILL_COLOR));
        assert.equal(master.hasClipWarning, false);

        // Clipping -> vivid red fill and latched hasClipWarning = true
        defaultTransportClock.setMasterLevels(0.9, 1.15);
        defaultTransportClock.update(0.6, 4.0, true);
        const masterClipRec = createRecordingCanvasCtx();
        master.drawCanvas(masterClipRec.ctx, { ds: { scale: 1.0 } });
        assert.ok(masterClipRec.fills.includes(CLIP_FILL_COLOR), 'Clipping Master must turn vivid red');
        assert.equal(master.hasClipWarning, true);
        assert.ok(masterClipRec.strokes.some(s => s.strokeStyle === CLIP_MARKER_COLOR && s.lineWidth >= 2));

        // After stopping and toggling visualization open, red clip marker remains latched
        defaultTransportClock.update(0.6, 4.0, false);
        master.toggleVisualization();
        assert.equal(master.hasClipWarning, true, 'Expanding/opening canvas visualization must NOT clear clip marker');
        const masterStoppedOpenRec = createRecordingCanvasCtx();
        master.drawCanvas(masterStoppedOpenRec.ctx, { ds: { scale: 1.0 } });
        assert.ok(
            masterStoppedOpenRec.strokes.some(s => s.strokeStyle === CLIP_MARKER_COLOR && s.lineWidth >= 2),
            'Opened Master must retain red clip marker border until Parameters panel opens'
        );

        // Opening Parameters panel clears the latched clip marker
        master.onParametersOpened();
        assert.equal(master.hasClipWarning, false, 'Opening Master Parameters panel must clear clip marker');
        const masterClearedRec = createRecordingCanvasCtx();
        master.drawCanvas(masterClearedRec.ctx, { ds: { scale: 1.0 } });
        assert.ok(!masterClearedRec.strokes.some(s => s.strokeStyle === CLIP_MARKER_COLOR));
    } finally {
        defaultTransportClock.setMasterLevels(0, 0);
        defaultTransportClock.update(0, 0, false);
        (globalThis as any).window = prevWindow;
    }
});




