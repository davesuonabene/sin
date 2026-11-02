import test from 'node:test';
import assert from 'node:assert/strict';
import { applySignalFlowColors, SIGNAL_STEM_PALETTE } from '../src/graphColorEngine.ts';

test('applySignalFlowColors propagates sample stem tone along cables and intermediate nodes', () => {
    const graphData: any = {
        nodes: [
            { id: 1, type: 'Audio/Sample', properties: { node_name: 'Kick' }, pos: [100, 100] },
            { id: 2, type: 'Audio/Sequence', properties: {}, pos: [300, 100] },
            { id: 3, type: 'Audio/AssetFilter', properties: { parentId: 2 }, pos: [300, 160] },
            { id: 4, type: 'Audio/Track', properties: { role: 'master' }, pos: [600, 100] }
        ],
        links: [
            [10, 1, 0, 2, 0, 'audio', null],
            [11, 2, 0, 4, 0, 'audio', null]
        ]
    };

    applySignalFlowColors(graphData);

    const kickColor = SIGNAL_STEM_PALETTE[0];
    const sampleNode = graphData.nodes.find((n: any) => n.id === 1);
    const seqNode = graphData.nodes.find((n: any) => n.id === 2);
    const modNode = graphData.nodes.find((n: any) => n.id === 3);
    const masterNode = graphData.nodes.find((n: any) => n.id === 4);

    assert.equal(sampleNode.color, kickColor);
    assert.equal(seqNode.color, kickColor);
    assert.equal(modNode.color, kickColor);

    // Cable from Sample to Sequence
    assert.equal(graphData.links[0][6], kickColor);
    // Cable from Sequence to Master
    assert.equal(graphData.links[1][6], kickColor);

    // Master node styling: obsidian chassis with radiant gold border
    assert.equal(masterNode.color, '#0f172a');
    assert.equal(masterNode.boxcolor, '#f59e0b');
});

test('applySignalFlowColors assigns distinct tones to multiple samples and routes to summing bus', () => {
    const graphData: any = {
        nodes: [
            { id: 1, type: 'Audio/Sample', properties: { node_name: 'Kick' }, pos: [100, 50] },
            { id: 2, type: 'Audio/Sample', properties: { node_name: 'Snare' }, pos: [100, 200] },
            { id: 3, type: 'Audio/Track', properties: { node_name: 'Drum Bus' }, pos: [400, 100] },
            { id: 4, type: 'Audio/Track', properties: { role: 'master' }, pos: [700, 100] }
        ],
        links: [
            [10, 1, 0, 3, 0, 'audio', null],
            [11, 2, 0, 3, 1, 'audio', null],
            [12, 3, 0, 4, 0, 'audio', null]
        ]
    };

    applySignalFlowColors(graphData);

    const kickNode = graphData.nodes.find((n: any) => n.id === 1);
    const snareNode = graphData.nodes.find((n: any) => n.id === 2);
    const busNode = graphData.nodes.find((n: any) => n.id === 3);
    const masterNode = graphData.nodes.find((n: any) => n.id === 4);

    // Two distinct stem tones
    assert.equal(kickNode.color, SIGNAL_STEM_PALETTE[0]);
    assert.equal(snareNode.color, SIGNAL_STEM_PALETTE[1]);
    assert.notEqual(kickNode.color, snareNode.color);

    // Cables entering the bus carry their respective stem tones
    assert.equal(graphData.links[0][6], SIGNAL_STEM_PALETTE[0]);
    assert.equal(graphData.links[1][6], SIGNAL_STEM_PALETTE[1]);

    // Intermediate bus tone
    assert.equal(busNode.color, '#4f46e5');
    // Cable from bus to master
    assert.equal(graphData.links[2][6], '#4f46e5');

    // Master node
    assert.equal(masterNode.color, '#0f172a');
    assert.equal(masterNode.boxcolor, '#f59e0b');
});

test('applySignalFlowColors preserves user-assigned colors on sample nodes after bulk color change', () => {
    const customUserColor = '#ea580c'; // Coral
    const graphData: any = {
        nodes: [
            {
                id: 1,
                type: 'Audio/Sample',
                properties: { node_name: 'Kick', color: customUserColor, user_color: true },
                pos: [100, 100],
                color: customUserColor
            },
            {
                id: 2,
                type: 'Audio/Sequence',
                properties: { node_name: 'Kick Seq' },
                pos: [300, 100]
            },
            {
                id: 3,
                type: 'Audio/Track',
                properties: { role: 'master' },
                pos: [600, 100]
            }
        ],
        links: [
            [10, 1, 0, 2, 0, 'audio', null],
            [11, 2, 0, 3, 0, 'audio', null]
        ]
    };

    applySignalFlowColors(graphData);

    const sampleNode = graphData.nodes.find((n: any) => n.id === 1);
    const seqNode = graphData.nodes.find((n: any) => n.id === 2);
    const masterNode = graphData.nodes.find((n: any) => n.id === 3);

    // User-assigned color is preserved, NOT reverted to default palette
    assert.equal(sampleNode.color, customUserColor);
    assert.equal(sampleNode.properties.color, customUserColor);

    // Propagated to downstream sequence processor and cables
    assert.equal(seqNode.color, customUserColor);
    assert.equal(graphData.links[0][6], customUserColor);
    assert.equal(graphData.links[1][6], customUserColor);

    // Master node retains obsidian chassis with radiant gold border
    assert.equal(masterNode.color, '#0f172a');
    assert.equal(masterNode.boxcolor, '#f59e0b');
});

test('applySignalFlowColors preserves user-assigned custom color on track nodes', () => {
    const customTrackColor = '#db2777'; // Rose Pink
    const graphData: any = {
        nodes: [
            {
                id: 1,
                type: 'Audio/Track',
                properties: { node_name: 'Custom Bus', color: customTrackColor, user_color: true },
                pos: [300, 100]
            },
            {
                id: 2,
                type: 'Audio/Track',
                properties: { role: 'master' },
                pos: [600, 100]
            }
        ],
        links: [
            [10, 1, 0, 2, 0, 'audio', null]
        ]
    };

    applySignalFlowColors(graphData);

    const busNode = graphData.nodes.find((n: any) => n.id === 1);
    assert.equal(busNode.color, customTrackColor);
    assert.equal(graphData.links[0][6], customTrackColor);
});

