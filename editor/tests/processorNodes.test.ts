import test from 'node:test';
import assert from 'node:assert/strict';
import { LGraph, LiteGraph } from 'litegraph.js';
import { AudioProcessorNode } from '../src/nodes/AudioProcessorNode.ts';
import { PreampDenoiseNode } from '../src/nodes/PreampDenoiseNode.ts';
import { VoiceIsolatorNode } from '../src/nodes/VoiceIsolatorNode.ts';
import { SampleNode } from '../src/nodes/SampleNode.ts';
import { TrackNode } from '../src/nodes/TrackNode.ts';
import { serializeNodeSubtree } from '../../ermes/ts/serializer.ts';
import { validateGraphDocument, graphDocumentToWorkspacePreset } from '../../ermes/ts/graphSchema.ts';

test('PreampDenoiseNode and VoiceIsolatorNode register via LiteGraph and inherit AudioProcessorNode + BaseNode', () => {
    const preamp = LiteGraph.createNode('Audio/PreampDenoise') as PreampDenoiseNode;
    const voice = LiteGraph.createNode('Audio/VoiceIsolator') as VoiceIsolatorNode;

    assert.ok(preamp instanceof PreampDenoiseNode);
    assert.ok(preamp instanceof AudioProcessorNode);
    assert.ok(voice instanceof VoiceIsolatorNode);
    assert.ok(voice instanceof AudioProcessorNode);

    assert.equal(preamp.nodeType, 'preamp_denoise');
    assert.equal(preamp.badgeLabel, 'PREAMP');
    assert.equal(preamp.nodeShape, 'through');
    assert.equal(voice.nodeType, 'voice_isolator');
    assert.equal(voice.badgeLabel, 'VOICE');
    assert.equal(voice.nodeShape, 'through');

    // Existing BaseNode freeze_refresh and render_enabled flags stay intact & orthogonal to bypass/cook_mode
    assert.equal(preamp.properties.freeze_refresh, true);
    assert.equal(preamp.properties.render_enabled, true);
    assert.equal(preamp.properties.bypass, false);
    assert.equal(preamp.properties.cook_mode, 'auto');

    // Both nodes declare custom UX section + normal fields section in their primary panel tab
    const preampTab = PreampDenoiseNode.panelSchema.tabs[0];
    assert.equal(preampTab.sections[0].type, 'preamp_denoise_panel');
    assert.equal(preampTab.sections[1].type, 'fields');

    const voiceTab = VoiceIsolatorNode.panelSchema.tabs[0];
    assert.equal(voiceTab.sections[0].type, 'voice_isolator_panel');
    assert.equal(voiceTab.sections[1].type, 'fields');
});

test('PreampDenoiseNode auto-switches input_topology when changing device profile', () => {
    const preamp = new PreampDenoiseNode();
    assert.equal(preamp.properties.profile_id, 'generic_adc');
    assert.equal(preamp.properties.input_topology, 'mono_or_dual_mono');

    preamp.updateProperty('profile_id', 'zoom_h4n_pro');
    assert.equal(preamp.properties.input_topology, 'coincident_xy_stereo');

    preamp.updateProperty('profile_id', 'usb_interface');
    assert.equal(preamp.properties.input_topology, 'mono_or_dual_mono');
});

test('ERMES serializer attaches processor_params polymorphically via AudioProcessorNode.prepareSerializedModel', () => {
    const graph = new LGraph();
    const sample = new SampleNode();
    sample.properties.filepath = 'assets/test.wav';
    const voice = new VoiceIsolatorNode();
    voice.updateProperty('voice_db', 2.5);
    voice.updateProperty('reverb_db', -12.0);
    voice.updateProperty('ambience_db', -60.0);
    voice.updateProperty('backend', 'dsp_lite');
    const master = new TrackNode();

    graph.add(sample);
    graph.add(voice);
    graph.add(master);
    sample.connect(0, voice, 0);
    voice.connect(0, master, 0);

    const trackNodes = new Map<number, any>([
        [sample.id, { id: sample.id, type: 'sample', name: 'Sample', parentId: voice.id, children: [] }],
        [voice.id, { id: voice.id, type: 'voice_isolator', name: 'Voice Isolator', parentId: master.id, children: [sample.id] }],
        [master.id, { id: master.id, type: 'track', name: 'Master', parentId: null, children: [voice.id] }],
    ]);

    const serialized = serializeNodeSubtree(graph, master.id, trackNodes);
    assert.equal(serialized.children.length, 1);
    const procModel = serialized.children[0];
    assert.equal(procModel.node_type, 'voice_isolator');
    assert.equal(procModel.processor_params.voice_db, 2.5);
    assert.equal(procModel.processor_params.reverb_db, -12.0);
    assert.equal(procModel.processor_params.ambience_db, -60.0);
    assert.equal(procModel.processor_params.backend, 'dsp_lite');
});

test('ERMES canonical graphSchema validates and converts preamp_denoise and voice_isolator graphs', () => {
    const doc = {
        format: 'sin-graph' as const,
        version: 1 as const,
        settings: { bpm: 120, total_bars: 4, key: 'C' },
        output: 'master',
        nodes: [
            { id: 'src', type: 'sample' as const, properties: { filepath: 'assets/field.wav', sample_type: 'loop' } },
            { id: 'preamp', type: 'preamp_denoise' as const, properties: { profile_id: 'zoom_h4n_pro', reduction_db: 14 } },
            { id: 'voice', type: 'voice_isolator' as const, properties: { voice_db: 1, ambience_db: -60 } },
            { id: 'master', type: 'track' as const, role: 'master' as const },
        ],
        connections: [
            { from: 'src', to: 'preamp', type: 'audio' as const },
            { from: 'preamp', to: 'voice', type: 'audio' as const },
            { from: 'voice', to: 'master', type: 'audio' as const },
        ],
    };

    const validation = validateGraphDocument(doc);
    assert.equal(validation.valid, true, `Expected valid graph, errors: ${validation.errors.join(', ')}`);

    const ws = graphDocumentToWorkspacePreset(doc);
    const types = ws.graph.nodes.map((n: any) => n.type);
    assert.ok(types.includes('Audio/PreampDenoise'));
    assert.ok(types.includes('Audio/VoiceIsolator'));
});
