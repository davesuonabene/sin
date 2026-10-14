import test from 'node:test';
import assert from 'node:assert/strict';
import { TrackNode } from '../src/nodes/TrackNode.ts';
import { SampleNode } from '../src/nodes/SampleNode.ts';
import { SequenceNode } from '../src/nodes/SequenceNode.ts';
import { ArrangementNode } from '../src/nodes/ArrangementNode.ts';
import { serializeNodeSubtree } from '../../ermes/ts/serializer.ts';

test('renderable nodes inherit export properties and defaults', () => {
    const nodes = [new TrackNode(), new SampleNode(), new SequenceNode(), new ArrangementNode()];

    for (const node of nodes) {
        assert.equal(node.properties.export_directory, 'exports');
        assert.equal(node.properties.export_pattern, '{project}_{name}_{idx}');
        assert.equal(node.properties.export_overwrite_mode, 'incremental');
        assert.equal(node.isRenderable, true);

        const tabs = node.propertiesTabs;
        assert.ok(tabs.includes('EXPORT'), `Node ${node.constructor.name} should include EXPORT tab`);

        const panelSchema = node.getPanelSchema();
        const exportTab = panelSchema.tabs.find(t => t.id === 'EXPORT');
        assert.ok(exportTab, `Node ${node.constructor.name} panelSchema should have EXPORT tab`);
        assert.ok(exportTab.sections.some(s => s.type === 'export_panel'));

        const exportFields = node.getFields('EXPORT');
        assert.ok(exportFields.some(f => f.key === 'export_directory'));
        assert.ok(exportFields.some(f => f.key === 'export_pattern'));
        assert.ok(exportFields.some(f => f.key === 'export_overwrite_mode'));
    }
});

test('serializeNodeSubtree includes export parameters in root model', () => {
    const track = new TrackNode();
    track.id = 101;
    track.title = 'Main Synth';
    track.properties.node_name = 'Main Synth';
    track.properties.export_directory = 'exports/stems';
    track.properties.export_pattern = '{name}_{bpm}bpm_{idx}';
    track.properties.export_overwrite_mode = 'overwrite';

    const mockGraph = {
        getNodeById: (id: number) => (id === 101 ? track : null),
        extra: { global_parameters: { bpm: 128, total_bars: 8, key: 'Dmin' } }
    };

    const model = serializeNodeSubtree(mockGraph, 101);
    assert.ok(model);
    assert.equal(model.export_directory, 'exports/stems');
    assert.equal(model.export_pattern, '{name}_{bpm}bpm_{idx}');
    assert.equal(model.export_overwrite_mode, 'overwrite');
});
