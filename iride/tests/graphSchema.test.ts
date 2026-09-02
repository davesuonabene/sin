import assert from 'node:assert/strict';
import test from 'node:test';
import {
    graphDocumentToWorkspacePreset,
    validateGraphDocument,
    type GraphDocument
} from '../../ermes/ts/graphSchema.ts';

const sampleLoopGraph: GraphDocument = {
    format: 'sin-graph',
    version: 1,
    nodes: [
        {
            id: 'sample-loop',
            type: 'sample',
            name: 'Sample Loop',
            position: [80, 180],
            properties: {
                sample_type: 'loop',
                asset: {
                    id: 117,
                    path: 'C:/assets/loop.wav'
                }
            }
        },
        {
            id: 'arrangement',
            type: 'arrangement',
            name: 'Arrangement',
            position: [340, 180]
        },
        {
            id: 'master',
            type: 'track',
            name: 'Master Track',
            role: 'master',
            position: [600, 180]
        }
    ],
    connections: [
        { from: 'sample-loop', to: 'arrangement', type: 'audio' },
        { from: 'arrangement', to: 'master', type: 'audio' }
    ],
    settings: {
        bpm: 102,
        total_bars: 4,
        key: 'Fmin'
    },
    output: 'master'
};

test('validates a canonical sample loop to master graph', () => {
    const result = validateGraphDocument(sampleLoopGraph);
    assert.deepEqual(result, { valid: true, errors: [] });
});

test('rejects invalid output and audio cycles', () => {
    const invalid = {
        ...sampleLoopGraph,
        output: 'arrangement',
        connections: [
            ...sampleLoopGraph.connections,
            { from: 'master', to: 'sample-loop', type: 'audio' }
        ]
    };
    const result = validateGraphDocument(invalid);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(error => error.includes('cycle')));
    assert.ok(result.errors.some(error => error.includes('must be a track with role')));
});

test('converts canonical nodes and connections to LiteGraph workspace data', () => {
    const preset = graphDocumentToWorkspacePreset(sampleLoopGraph, '2026-08-29T00:00:00.000Z');
    assert.equal(preset.version, 2);
    assert.deepEqual(preset.graph.links, [
        [1, 1, 0, 2, 0, 'audio'],
        [2, 2, 0, 3, 0, 'audio']
    ]);
    assert.equal(preset.graph.nodes[0].type, 'Audio/Sample');
    assert.equal((preset.graph.nodes[0].properties as Record<string, unknown>).filepath, 'C:/assets/loop.wav');
    assert.equal((preset.graph.nodes[0].properties as Record<string, unknown>).library_item_id, 117);
    assert.equal(preset.graph.extra.main_preview.node_id, 3);
});

test('accepts exact asset keys and ownership attachments', () => {
    const graph: GraphDocument = {
        format: 'sin-graph',
        version: 1,
        nodes: [
            {
                id: 'kick',
                type: 'sample',
                name: 'Kick One-shot',
                properties: {
                    sample_type: 'one_shot',
                    asset_pool: {
                        selected_items: [
                            { id: 352 },
                            { id: 353 }
                        ],
                        playbackMode: 'Random',
                        refresh_mode: 'local',
                        seed: 42
                    }
                }
            },
            {
                id: 'kick-pool',
                type: 'asset_filter',
                name: 'Kick Pool',
                properties: {
                    selected_items: [
                        { id: 352 }
                    ],
                    refresh_mode: 'parent',
                    playbackMode: 'Sequential'
                }
            },
            {
                id: 'master',
                type: 'track',
                name: 'Master Track',
                role: 'master'
            }
        ],
        connections: [
            { from: 'kick', to: 'master', type: 'audio' }
        ],
        attachments: [
            { owner: 'kick', modifier: 'kick-pool', type: 'asset_pool' }
        ],
        settings: { bpm: 120, total_bars: 8, key: 'C' },
        output: 'master'
    };

    const validation = validateGraphDocument(graph);
    assert.deepEqual(validation, { valid: true, errors: [] });

    const preset = graphDocumentToWorkspacePreset(graph);
    const sampleProperties = preset.graph.nodes[0].properties as Record<string, unknown>;
    const poolProperties = preset.graph.nodes[1].properties as Record<string, unknown>;
    assert.equal(sampleProperties.asset_modifier_id, 2);
    assert.equal(poolProperties.parentId, 1);
    assert.equal(preset.graph.nodes[1].type, 'Audio/AssetFilter');
    assert.deepEqual(poolProperties.selected_items, [{ id: 352 }]);
    assert.deepEqual(preset.graph.nodes[1].outputs, []);
});
