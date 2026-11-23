import test from 'node:test';
import assert from 'node:assert/strict';
import { TrackNode } from '../src/nodes/TrackNode.ts';
import { SampleNode } from '../src/nodes/SampleNode.ts';
import { SequenceNode } from '../src/nodes/SequenceNode.ts';
import { ArrangementNode } from '../src/nodes/ArrangementNode.ts';
import {
    collectNodesInSelectionRect,
    computeResizedNodeRect,
    detectNodeResizeEdge,
    getResizeCursor,
    syncNodesDistanceStage
} from '../src/canvas/canvasGeometry.ts';
import { ModulatorNode } from '../src/nodes/ModulatorNode.ts';
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

    // Intermediate zoom (scale = 0.55) remains in Stage 1 for shrunk 150x60 node (collapseScale ~= 0.545)
    sample.syncDistanceStage(0.55);
    assert.equal(sample.currentDistanceStage, 1);
    assert.equal(sample.isVisualizationActive, true, 'Viewer remains active above collapse threshold');
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

    // Scale 0.55 stays in Stage 3 due to hysteresis for the 150x60 node (expandScale ~= 0.600)
    sample.syncDistanceStage(0.55);
    assert.equal(sample.currentDistanceStage, 3, 'Hysteresis keeps shrunk 150x60 node collapsed inside deadband');

    // Returning above expandScale (~0.600) restores the viewer and custom size automatically
    sample.syncDistanceStage(0.62);
    assert.equal(sample.currentDistanceStage, 1);
    assert.equal(sample.isVisualizationActive, true);
    assert.equal(sample.size[0], 150);
    assert.equal(sample.size[1], 60);

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
    const { defaultTransportClock, deriveMatteNodePalette, CLIP_FILL_COLOR, CLIP_MARKER_COLOR } = await import('../../packages/iride/src/index.ts');

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

        // 1. SequenceNode: no moving perimeter bar (no setLineDash), flat active step & dimmed inactive steps
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
        assert.ok(seqRecActive.fills.includes(deriveMatteNodePalette(seq.nodeColor).iconBg), 'Active step should render flat native matte tone without internal lighting');
        assert.ok(!seqRecActive.fills.includes('rgba(255, 255, 255, 0.16)'), 'Flat matte icon must not apply internal white lighting sheen');

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

        // 4. Master TrackNode: flat matte transparent base color, monochrome RMS meter fill, turns red on clip, latches red marker until Parameters opened
        const master = new TrackNode();
        master.id = 304;
        master.properties.node_name = 'Master Output';
        master.properties.role = 'master';
        master.properties.color = '#0f172a';
        master.color = '#0f172a';
        master.properties.visualization_enabled = false;
        const masterExpectedMatte = deriveMatteNodePalette('#0f172a');

        // Silence -> flat matte base color (matching expanded panel background)
        defaultTransportClock.setMasterLevels(0, 0);
        defaultTransportClock.update(0.0, 4.0, false);
        const masterIdleRec = createRecordingCanvasCtx();
        master.drawCanvas(masterIdleRec.ctx, { ds: { scale: 1.0 } });
        assert.ok(masterIdleRec.fills.includes(masterExpectedMatte.iconBg));
        assert.equal(master.hasClipWarning, false);

        // Mid RMS -> flat base color + monochrome RMS meter overlay, not red, no clip latch
        defaultTransportClock.setMasterLevels(0.35, 0.55);
        defaultTransportClock.update(0.5, 4.0, true);
        const masterRmsRec = createRecordingCanvasCtx();
        master.drawCanvas(masterRmsRec.ctx, { ds: { scale: 1.0 } });
        assert.ok(masterRmsRec.fills.includes(masterExpectedMatte.iconBg), 'Master icon keeps flat unlighted base color');
        assert.ok(masterRmsRec.fillRects.some(r => r.fillStyle === '#111111' || r.fillStyle.startsWith('rgba(0, 0, 0,')), 'Master icon renders monochrome RMS meter overlay');
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

        // 5. Clipping while Parameters panel IS open still turns node red during clipping, without latching after stop
        winObj.activeParamNodeId = master.id;
        defaultTransportClock.setMasterLevels(0.95, 1.25);
        defaultTransportClock.update(0.7, 4.0, true);
        const masterOpenParamClipRec = createRecordingCanvasCtx();
        master.drawCanvas(masterOpenParamClipRec.ctx, { ds: { scale: 1.0 } });
        assert.ok(
            masterOpenParamClipRec.fillRects.some(r => r.fillStyle === CLIP_FILL_COLOR),
            'Clipping while parameter panel is open must still light header vivid red'
        );
        assert.ok(
            masterOpenParamClipRec.strokes.some(s => s.strokeStyle === CLIP_MARKER_COLOR && s.lineWidth >= 2),
            'Clipping while parameter panel is open must still show red alert border'
        );
        assert.equal(master.hasClipWarning, false, 'Clip border should not latch permanently while parameter panel is already open');

        // 6. Intermediate (non-master) Bus TrackNode follows per-bus RMS/peak telemetry in icon and view mode
        winObj.activeParamNodeId = null;
        const subBus = new TrackNode();
        subBus.id = 305;
        subBus.properties.node_name = 'Drum Bus';
        subBus.properties.color = '#4f46e5';
        subBus.color = '#4f46e5';
        subBus.properties.visualization_enabled = false;

        defaultTransportClock.setMasterLevels(0.8, 1.1);
        defaultTransportClock.setBusLevels({ '305': 0.32, '304': 0.8 }, { '305': 0.48, '304': 1.1 });
        defaultTransportClock.update(0.8, 4.0, true);
        const busIconRec = createRecordingCanvasCtx();
        subBus.drawCanvas(busIconRec.ctx, { ds: { scale: 1.0 } });
        assert.ok(busIconRec.fills.some(f => f.startsWith('rgb(')), 'Non-master Bus should modulate its color from its own busLevels');
        assert.ok(busIconRec.fillRects.length >= 2, 'Non-master Bus closed icon should render RMS level fill curve');
        assert.ok(!busIconRec.fills.includes(CLIP_FILL_COLOR), 'Non-master Bus at 0.48 peak must not clip even when Master clips');

        subBus.properties.visualization_enabled = true;
        subBus.size = subBus.computeSize();
        const busOpenRec = createRecordingCanvasCtx();
        subBus.drawCanvas(busOpenRec.ctx, { ds: { scale: 1.0 } });
        assert.ok(
            busOpenRec.fillRects.some(r => r.h === 2.5 && r.y === 19.5),
            'Non-master Bus in view mode should render header RMS curve ribbon'
        );
    } finally {
        defaultTransportClock.setBusLevels(null, null);
        defaultTransportClock.setMasterLevels(0, 0);
        defaultTransportClock.update(0, 0, false);
        (globalThis as any).window = prevWindow;
    }
});

test('Dimension-aware auto-icon collapsing orders small-to-big, locks equal dimensions across types, enforces hysteresis and aspect floors', () => {
    const small = new SampleNode();
    small.onResize([140, 56]);
    const def = new SampleNode();
    const wide = new SequenceNode();
    wide.onResize([440, 76]);
    const large = new TrackNode();
    large.onResize([440, 152]);
    const huge = new ArrangementNode();
    huge.onResize([660, 228]);

    const tSmall = small.getDistanceThresholds();
    const tDef = def.getDistanceThresholds();
    const tWide = wide.getDistanceThresholds();
    const tLarge = large.getDistanceThresholds();
    const tHuge = huge.getDistanceThresholds();

    // Default 220x76 matches calibrated reference thresholds
    assert.ok(Math.abs(tDef.collapseScale - 0.40) < 1e-6);
    assert.ok(Math.abs(tDef.expandScale - 0.44) < 1e-6);

    // Strict ordering: smaller collapse at higher zoom scale (earlier), bigger collapse at lower zoom scale (later)
    assert.ok(tSmall.collapseScale > tDef.collapseScale);
    assert.ok(tDef.collapseScale > tWide.collapseScale);
    assert.ok(tWide.collapseScale > tLarge.collapseScale);
    assert.ok(tLarge.collapseScale > tHuge.collapseScale);

    // Sweep zoom outward: 1.0 -> 0.50 -> 0.35 -> 0.25 -> 0.16 -> 0.10
    const allNodes = [small, def, wide, large, huge];
    const syncAll = (s: number) => allNodes.forEach(n => n.syncDistanceStage(s));

    syncAll(0.50);
    assert.deepEqual(allNodes.map(n => n.currentDistanceStage), [3, 1, 1, 1, 1], 'Only 140x56 collapses at 0.50');

    syncAll(0.35);
    assert.deepEqual(allNodes.map(n => n.currentDistanceStage), [3, 3, 1, 1, 1], 'Default 220x76 collapses at 0.35; wide/large/huge remain open');

    syncAll(0.25);
    assert.deepEqual(allNodes.map(n => n.currentDistanceStage), [3, 3, 3, 1, 1], '440x76 collapses by 0.25; 440x152 and 660x228 remain open');

    syncAll(0.16);
    assert.deepEqual(allNodes.map(n => n.currentDistanceStage), [3, 3, 3, 3, 1], '440x152 collapses by 0.16; huge 660x228 stands out');

    syncAll(0.10);
    assert.deepEqual(allNodes.map(n => n.currentDistanceStage), [3, 3, 3, 3, 3], 'Huge 660x228 collapses below ~0.133');

    // Hysteresis deadband check for every node size
    for (const node of allNodes) {
        const { collapseScale, expandScale } = node.getDistanceThresholds();
        const midDeadband = (collapseScale + expandScale) * 0.5;
        node.syncDistanceStage(midDeadband);
        assert.equal(node.currentDistanceStage, 3, 'Node stays collapsed inside its deadband');
        node.syncDistanceStage(expandScale + 0.005);
        assert.equal(node.currentDistanceStage, 1, 'Node expands once zoom reaches expandScale');
    }

    // Equal-dimension lockstep across distinct node subclasses
    const eqSample = new SampleNode();
    const eqSeq = new SequenceNode();
    const eqTrack = new TrackNode();
    const eqArr = new ArrangementNode();
    const eqNodes = [eqSample, eqSeq, eqTrack, eqArr];
    for (const n of eqNodes) n.onResize([320, 120]);
    const refThresh = eqSample.getDistanceThresholds();
    for (const n of eqNodes) {
        assert.deepEqual(n.getDistanceThresholds(), refThresh);
        n.syncDistanceStage(refThresh.collapseScale - 0.001);
        assert.equal(n.currentDistanceStage, 3);
    }

    // Extreme aspect ratios respect minimum screen width (48px) and height (18px) floors
    const ultraWide = new SampleNode();
    ultraWide.onResize([1200, 56]);
    const uwThresh = ultraWide.getDistanceThresholds();
    assert.ok(uwThresh.collapseScale >= 18 / 56 - 1e-6);

    const ultraTall = new SampleNode();
    ultraTall.onResize([140, 600]);
    const utThresh = ultraTall.getDistanceThresholds();
    assert.ok(utThresh.collapseScale >= 48 / 140 - 1e-6);
});

test('Center-anchored collapse/expand, drag while collapsed, lossless serialize(), active resize guard, and onConfigure reset', () => {
    const big = new SampleNode();
    big.id = 901;
    big.pos = [100, 200];
    big.onResize([600, 240]);
    // Center is (100 + 300, 200 + 120) = (400, 320)

    const { collapseScale, expandScale } = big.getDistanceThresholds();
    big.syncDistanceStage(collapseScale - 0.02);
    assert.equal(big.currentDistanceStage, 3);
    assert.deepEqual([big.size[0], big.size[1]], [44, 44]);
    assert.deepEqual([big.pos[0], big.pos[1]], [378, 298], 'Collapsed icon must be centered on (400, 320)');

    // serialize() must emit canonical expanded pos & size without mutating live collapsed state
    const serialized = big.serialize();
    assert.deepEqual([serialized.pos[0], serialized.pos[1]], [100, 200]);
    assert.deepEqual([serialized.size[0], serialized.size[1]], [600, 240]);
    assert.deepEqual([big.pos[0], big.pos[1]], [378, 298], 'Live collapsed pos must not be mutated by serialize()');
    assert.deepEqual([big.size[0], big.size[1]], [44, 44], 'Live collapsed size must not be mutated by serialize()');

    // Dragging while collapsed preserves center delta upon re-expansion
    big.pos[0] += 50;
    big.pos[1] -= 30;
    big.syncDistanceStage(expandScale + 0.02);
    assert.equal(big.currentDistanceStage, 1);
    assert.deepEqual([big.size[0], big.size[1]], [600, 240]);
    assert.deepEqual([big.pos[0], big.pos[1]], [150, 170], 'Expanded pos reflects [+50, -30] move while collapsed');

    // Active resize guard via syncNodesDistanceStage
    const resizingNode = new SequenceNode();
    resizingNode.id = 902;
    resizingNode.onResize([140, 56]);
    const peerNode = new SequenceNode();
    peerNode.id = 903;
    peerNode.onResize([140, 56]);
    const mockGraph = { _nodes: [resizingNode, peerNode] };

    syncNodesDistanceStage(mockGraph, 0.45, resizingNode);
    assert.equal(resizingNode.currentDistanceStage, 1, 'Actively resized node must not collapse mid-drag');
    assert.equal(peerNode.currentDistanceStage, 3, 'Identical peer node not being resized collapses normally');

    syncNodesDistanceStage(mockGraph, 0.45);
    assert.equal(resizingNode.currentDistanceStage, 3, 'Releasing resize allows node to collapse cleanly');

    // configure() / onConfigure() resets distance stage and collapse offset cleanly
    resizingNode.configure({
        properties: { ...resizingNode.properties, visual_width: 300, visual_height: 120 }
    });
    assert.equal(resizingNode.currentDistanceStage, 1);
    assert.deepEqual([resizingNode.size[0], resizingNode.size[1]], [300, 120]);
});

test('Flat transparent matte node palette, icon/panel color parity, native-tone borders, and live drag-selection highlighting', async () => {
    const { deriveMatteNodePalette } = await import('../../packages/iride/src/index.ts');

    const node = new SampleNode();
    node.id = 950;
    node.properties.color = '#10b981';
    node.color = '#10b981';
    const palette = deriveMatteNodePalette('#10b981');

    // Icon and expanded panel share identical flat transparent tint; selected border matches native RGB
    assert.equal(palette.panelBg, palette.iconBg);
    assert.equal(palette.borderSelected, 'rgb(16, 185, 129)');

    // Expanded deselected panel: fill and border are identical matte color; no blue ring
    const expandedDeselected = createRecordingCanvasCtx();
    node.drawCanvas(expandedDeselected.ctx, { ds: { scale: 1.0 }, selected_nodes: {} });
    assert.ok(expandedDeselected.fills.includes(palette.panelBg));
    assert.ok(expandedDeselected.strokes.some(s => s.strokeStyle === palette.panelBg), 'Deselected border must match panel background');
    assert.ok(!expandedDeselected.strokes.some(s => s.strokeStyle === '#38bdf8'), 'Blue selection ring must not be drawn');

    // Expanded selected panel: border highlights in native tone
    const expandedSelected = createRecordingCanvasCtx();
    node.drawCanvas(expandedSelected.ctx, { ds: { scale: 1.0 }, selected_nodes: { 950: node } });
    assert.ok(expandedSelected.strokes.some(s => s.strokeStyle === palette.borderSelected), 'Selected panel border must highlight in native tone');
    assert.ok(!expandedSelected.strokes.some(s => s.strokeStyle === '#38bdf8'));

    // Live drag-selection preview highlights included node and unhighlights excluded node (replace mode)
    const previewIncluded = createRecordingCanvasCtx();
    node.drawCanvas(previewIncluded.ctx, {
        ds: { scale: 1.0 },
        selected_nodes: {},
        __sinDragSelectPreview: { ids: new Set([950]), additive: false }
    });
    assert.ok(previewIncluded.strokes.some(s => s.strokeStyle === palette.borderSelected), 'Node inside drag-selection box must highlight live');

    const previewExcluded = createRecordingCanvasCtx();
    node.drawCanvas(previewExcluded.ctx, {
        ds: { scale: 1.0 },
        selected_nodes: { 950: node },
        __sinDragSelectPreview: { ids: new Set([999]), additive: false }
    });
    assert.ok(previewExcluded.strokes.some(s => s.strokeStyle === palette.panelBg), 'Node outside non-additive drag-selection box must drop highlight');

    // Collapsed icon shares exact same flat tone and native-tone border behavior
    node.properties.visualization_enabled = false;
    node.size = node.computeSize();
    const iconDeselected = createRecordingCanvasCtx();
    node.drawCanvas(iconDeselected.ctx, { ds: { scale: 1.0 }, selected_nodes: {} });
    assert.ok(iconDeselected.fills.includes(palette.iconBg));
    assert.ok(iconDeselected.strokes.some(s => s.strokeStyle === palette.iconBg));

    const iconSelected = createRecordingCanvasCtx();
    node.drawCanvas(iconSelected.ctx, { ds: { scale: 1.0 }, selected_nodes: { 950: node } });
    assert.ok(iconSelected.strokes.some(s => s.strokeStyle === palette.borderSelected));
});

test('8-way node border/corner resizing geometry and selection rectangle node collection', () => {
    const seq = new SequenceNode();
    seq.id = 960;
    seq.pos = [100, 100];
    seq.onResize([240, 100]);

    // Sides detect single-axis resize
    assert.equal(detectNodeResizeEdge(seq, 120, 1, 1.0), 'n');
    assert.equal(detectNodeResizeEdge(seq, 120, 99, 1.0), 's');
    assert.equal(detectNodeResizeEdge(seq, 1, 20, 1.0), 'w');
    assert.equal(detectNodeResizeEdge(seq, 239, 20, 1.0), 'e');

    // Corners detect free 2-axis resize
    assert.equal(detectNodeResizeEdge(seq, 2, 2, 1.0), 'nw');
    assert.equal(detectNodeResizeEdge(seq, 238, 2, 1.0), 'ne');
    assert.equal(detectNodeResizeEdge(seq, 2, 98, 1.0), 'sw');
    assert.equal(detectNodeResizeEdge(seq, 238, 98, 1.0), 'se');

    // Left/right connection port midpoints remain free for cable wiring
    assert.equal(detectNodeResizeEdge(seq, 0, 50, 1.0), null);
    assert.equal(detectNodeResizeEdge(seq, 240, 50, 1.0), null);

    // Cursors map cleanly
    assert.equal(getResizeCursor('n'), 'ns-resize');
    assert.equal(getResizeCursor('w'), 'ew-resize');
    assert.equal(getResizeCursor('nw'), 'nwse-resize');
    assert.equal(getResizeCursor('ne'), 'nesw-resize');

    // Dragging west/north anchors opposite edge and respects min dimensions
    const westResize = computeResizedNodeRect({ x: 100, y: 100, width: 240, height: 100 }, 'w', -40, 30);
    assert.deepEqual(westResize, { x: 60, y: 100, width: 280, height: 100 });

    const clampedNw = computeResizedNodeRect({ x: 100, y: 100, width: 240, height: 100 }, 'nw', 500, 500);
    assert.deepEqual(clampedNw, { x: 200, y: 144, width: 140, height: 56 });

    // Collapsed icons cannot be border-resized
    seq.properties.visualization_enabled = false;
    seq.size = seq.computeSize();
    assert.equal(detectNodeResizeEdge(seq, 2, 2, 1.0), null);

    // collectNodesInSelectionRect encloses overlapping visible nodes and skips hidden/modifier nodes
    const visibleA = new SampleNode();
    visibleA.id = 1;
    visibleA.pos = [50, 50];
    visibleA.onResize([220, 76]);

    const visibleOutside = new SampleNode();
    visibleOutside.id = 2;
    visibleOutside.pos = [500, 500];
    visibleOutside.onResize([220, 76]);

    const hiddenNode = new SampleNode();
    hiddenNode.id = 3;
    hiddenNode.pos = [60, 60];
    (hiddenNode.flags as any).hidden = true;

    const modifier = new ModulatorNode();
    modifier.id = 4;
    modifier.pos = [60, 60];

    const selectedIds = collectNodesInSelectionRect([visibleA, visibleOutside, hiddenNode, modifier], 40, 40, 100, 60);
    assert.deepEqual([...selectedIds], [1]);
});




