import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildTimelineHierarchy,
    canSwapGraphNodes,
    computeNodeAncestorPath,
    computeScopedAncestorPath,
    computeRulerTicks,
    layoutSignalChainRows,
    moveOrCopyFxBetweenChains,
    pasteFxIntoChain,
    reorderFxInChain,
    resolveTimelineTimebase,
    snapTimeToGrid,
    swapGraphNodes,
    TIER_COMPLEX_ML,
    TIER_FAST_DSP,
    TIER_RAW,
    TIER_STALE,
    TimelineTileOverlayStore,
} from '../src/timeline/timelineModel.ts';
import { samplePeaksForColumns, TimelineWaveformCache } from '../src/timeline/TimelineWaveformCache.ts';
import { clearAudioBufferCache } from '../src/audioBufferCache.ts';

function makeGraph(nodes: any[], links: Array<[number, number, number, number, number, string, string?]>) {
    const map = new Map<number, any>();
    for (const n of nodes) map.set(n.id, n);
    return {
        _nodes: nodes,
        links,
        extra: { global_parameters: { bpm: 120, total_bars: 4, key: 'C' } },
        getNodeById(id: number) {
            return map.get(id) ?? null;
        },
    };
}

test('buildTimelineHierarchy creates strict Track-only lanes anchored by top-level Master folders and ignores loose non-Track nodes', () => {
    const graph = makeGraph(
        [
            { id: 1, type: 'Audio/Sample', pos: [0, 0], properties: { node_name: 'Kick', filepath: 'kick.wav', duration_seconds: 1.0, sample_type: 'loop' } },
            { id: 2, type: 'Audio/Sequence', pos: [120, 0], properties: { node_name: 'Kick Seq', sequence: [1, 0, 0, 0, 1, 0, 0, 0], step_length: 0.5 } },
            { id: 3, type: 'Audio/Track', pos: [260, 0], properties: { node_name: 'Drums' } },
            { id: 4, type: 'Audio/Sample', pos: [0, 120], properties: { node_name: 'Vox Raw', filepath: 'vox.wav', duration_seconds: 120.0, sample_type: 'one_shot' } },
            { id: 5, type: 'Audio/PreampDenoise', pos: [120, 120], properties: { node_name: 'Preamp' }, isAudioProcessor: true },
            { id: 6, type: 'Audio/Track', pos: [260, 120], properties: { node_name: 'Vocals' } },
            { id: 7, type: 'Audio/Track', pos: [460, 60], properties: { node_name: 'Master Output', role: 'master' } },
            // Second unlinked top-level Track (should render as its own collapsible Master folder)
            { id: 8, type: 'Audio/Track', pos: [460, 240], properties: { node_name: 'Alt Idea' } },
            // Loose unconnected Sample & Sequence (must be ignored!)
            { id: 9, type: 'Audio/Sample', pos: [0, 320], properties: { node_name: 'Stray Sample' } },
            { id: 10, type: 'Audio/Sequence', pos: [120, 320], properties: { node_name: 'Stray Seq' } },
        ],
        [
            [101, 1, 0, 2, 0, 'audio'],
            [102, 2, 0, 3, 0, 'audio'],
            [103, 4, 0, 5, 0, 'audio'],
            [104, 5, 0, 6, 0, 'audio'],
            [105, 3, 0, 7, 0, 'audio'],
            [106, 6, 0, 7, 0, 'audio'],
            [107, 9, 0, 10, 0, 'audio'],
        ]
    );

    const res = buildTimelineHierarchy(graph, { mainPreviewNodeId: 7 });

    // Exactly 4 Track lanes: Master Output (depth 0), Drums (depth 1), Vocals (depth 1), Alt Idea (depth 0)
    assert.deepEqual(
        res.allLanes.map(l => ({ id: l.trackNodeId, depth: l.depth, master: l.isMasterRoot, main: l.isMainPreview })),
        [
            { id: 7, depth: 0, master: true, main: true },
            { id: 3, depth: 1, master: false, main: false },
            { id: 6, depth: 1, master: false, main: false },
            { id: 8, depth: 0, master: true, main: false },
        ]
    );

    // Master Output's direct subgraph stops at child Track boundaries (Drums & Vocals appear as bus_stub)
    const masterLane = res.laneByTrackId.get(7)!;
    const masterNodeKinds = new Map(masterLane.directSubgraph.nodes.map(n => [n.id, n.kind]));
    assert.equal(masterNodeKinds.get(7), 'track_target');
    assert.equal(masterNodeKinds.get(3), 'bus_stub');
    assert.equal(masterNodeKinds.get(6), 'bus_stub');
    assert.equal(masterNodeKinds.has(1), false);
    assert.equal(masterNodeKinds.has(5), false);

    // Master's upstreamNodeIds still tracks full descendant ownership (for tiled scope)
    assert.equal(masterLane.upstreamNodeIds.has('5'), true);
    assert.equal(masterLane.upstreamNodeIds.has('4'), true);

    // Vocals direct subgraph contains Sample (4) -> Preamp (5) -> Track (6), with editable direct clip
    const vocalsLane = res.laneByTrackId.get(6)!;
    assert.deepEqual(vocalsLane.directSubgraph.processorNodeIds, [5]);
    assert.equal(vocalsLane.clips.length, 1);
    assert.equal(vocalsLane.clips[0].sampleNodeId, 4);
    assert.equal(vocalsLane.clips[0].editableCrop, true);
    assert.equal(vocalsLane.clips[0].editableStartBeat, true);

    // Drums direct subgraph contains Sequence markers and non-directly-editable sample clip
    const drumsLane = res.laneByTrackId.get(3)!;
    assert.ok(drumsLane.sequenceMarkers.length > 0);
    assert.equal(drumsLane.clips[0].editableStartBeat, false);
});

test('buildTimelineHierarchy respects collapsed parent buses, nested sub-buses, and Solo/Mute propagation', () => {
    const graph = makeGraph(
        [
            { id: 10, type: 'Audio/Track', pos: [400, 0], properties: { node_name: 'Master', role: 'master' } },
            { id: 11, type: 'Audio/Track', pos: [250, 0], properties: { node_name: 'Drum Bus' } },
            { id: 12, type: 'Audio/Track', pos: [100, 0], properties: { node_name: 'Kick', solo: true } },
            { id: 13, type: 'Audio/Track', pos: [100, 80], properties: { node_name: 'Snare' } },
            { id: 14, type: 'Audio/Track', pos: [250, 140], properties: { node_name: 'Bass', muted: true } },
        ],
        [
            [1, 12, 0, 11, 0, 'audio'],
            [2, 13, 0, 11, 0, 'audio'],
            [3, 11, 0, 10, 0, 'audio'],
            [4, 14, 0, 10, 0, 'audio'],
        ]
    );

    const collapsedRes = buildTimelineHierarchy(graph, {
        mainPreviewNodeId: 10,
        collapsedTrackIds: new Set([11]),
    });

    // Drum Bus collapsed -> Kick and Snare hidden from visibleLanes
    assert.deepEqual(collapsedRes.visibleLanes.map(l => l.trackNodeId), [10, 11, 14]);
    assert.equal(collapsedRes.anySoloActive, true);
    // Solo on Kick keeps Kick, Drum Bus (ancestor), and Master (ancestor) unmuted; Snare & Bass dimmed
    assert.equal(collapsedRes.laneByTrackId.get(12)!.effectivelyMuted, false);
    assert.equal(collapsedRes.laneByTrackId.get(11)!.effectivelyMuted, false);
    assert.equal(collapsedRes.laneByTrackId.get(10)!.effectivelyMuted, false);
    assert.equal(collapsedRes.laneByTrackId.get(13)!.effectivelyMuted, true);
    assert.equal(collapsedRes.laneByTrackId.get(14)!.effectivelyMuted, true);
});

test('resolveTimelineTimebase, computeRulerTicks, and snapTimeToGrid adapt cleanly between Bars and Free modes', () => {
    const barTb = resolveTimelineTimebase(120, 4, [], 8.0, 'auto');
    assert.equal(barTb.isFreeMode, false);
    assert.equal(barTb.resolvedRulerMode, 'bars');
    assert.equal(barTb.durationSec, 8.0);

    const freeTb = resolveTimelineTimebase(120, -1, [], 1800, 'auto');
    assert.equal(freeTb.isFreeMode, true);
    assert.equal(freeTb.resolvedRulerMode, 'time');
    assert.equal(freeTb.durationSec, 1800);

    const barTicks = computeRulerTicks(0, 8, 800, 'bars', 120);
    assert.ok(barTicks.some(t => t.major && t.label === '1'));
    assert.ok(barTicks.some(t => t.major && t.label === '2'));

    const timeTicks = computeRulerTicks(0, 600, 600, 'time', 120);
    assert.ok(timeTicks.some(t => t.major && t.label === '0:00'));
    assert.ok(timeTicks.some(t => t.major && t.label.includes(':')));

    // Snapping ON in Bars mode snaps 0.48s (at 120 BPM, 1 beat = 0.5s) to 0.5s
    const snapped = snapTimeToGrid(0.48, 120, 8, 800, true, 'bars');
    assert.ok(Math.abs(snapped - 0.5) < 1e-6);
    // Snapping OFF returns exact raw value
    const unsnapped = snapTimeToGrid(0.48, 120, 8, 800, false, 'bars');
    assert.equal(unsnapped, 0.48);
});

test('TimelineTileOverlayStore scopes 4-tier dual-color baked/unbaked states strictly to tiled buses + ancestors', () => {
    const graph = makeGraph(
        [
            { id: 1, type: 'Audio/Sample', properties: { node_name: 'Long Vox', filepath: 'vox.wav', duration_seconds: 120 } },
            { id: 2, type: 'Audio/VoiceIsolator', properties: { node_name: 'Voice Iso' }, isAudioProcessor: true },
            { id: 3, type: 'Audio/Track', properties: { node_name: 'Vocals' } },
            { id: 4, type: 'Audio/Track', properties: { node_name: 'Drums' } },
            { id: 5, type: 'Audio/Track', properties: { node_name: 'Master', role: 'master' } },
        ],
        [
            [1, 1, 0, 2, 0, 'audio'],
            [2, 2, 0, 3, 0, 'audio'],
            [3, 3, 0, 5, 0, 'audio'],
            [4, 4, 0, 5, 0, 'audio'],
        ]
    );
    const hierarchy = buildTimelineHierarchy(graph, { mainPreviewNodeId: 5 });
    const store = new TimelineTileOverlayStore();

    // Tiled session covers VoiceIso (2), Vocals (3), Master (5) — NOT Drums (4)
    store.setSessionScope(['2', '3', '5'], ['2'], 120);
    store.applyPeaks({
        busNodeIds: ['2', '3', '5'],
        stageNodeIds: ['2'],
        peaks: new Array(120 * 2).fill(0.5),
        tiers: new Array(120).fill(TIER_RAW),
        durationSec: 120,
    });

    assert.equal(store.isLaneTiled(hierarchy.laneByTrackId.get(3)!), true);
    assert.equal(store.isLaneTiled(hierarchy.laneByTrackId.get(5)!), true);
    assert.equal(store.isLaneTiled(hierarchy.laneByTrackId.get(4)!), false);

    // Tile [0..16s] cooked at FAST_DSP, [16..32s] cooked at COMPLEX_ML
    store.applyTileDelta({
        bus_node_ids: ['2', '3', '5'],
        start_sec: 0,
        end_sec: 16,
        duration_sec: 120,
        tier: TIER_FAST_DSP,
        peaks: [0.1, 0.4, -0.2, 0.3],
    });
    store.applyTileDelta({
        bus_node_ids: ['2', '3', '5'],
        start_sec: 16,
        end_sec: 32,
        duration_sec: 120,
        tier: TIER_COMPLEX_ML,
        peaks: [-0.1, 0.2, -0.1, 0.2],
    });

    const entry = store.getEntryForLane(hierarchy.laneByTrackId.get(3)!)!;
    const cols = store.resolveColumnTiers(entry, 0, 120, 120)!;
    assert.equal(cols[4], TIER_FAST_DSP);
    assert.equal(cols[20], TIER_COMPLEX_ML);
    assert.equal(cols[80], TIER_RAW);

    // Stale hold marks previously cooked tiles amber while raw tiles stay raw
    store.applyTileDelta({ bus_node_ids: ['2', '3', '5'], stale_all: true });
    const staleCols = store.resolveColumnTiers(entry, 0, 120, 120)!;
    assert.equal(staleCols[4], TIER_STALE);
    assert.equal(staleCols[20], TIER_STALE);
    assert.equal(staleCols[80], TIER_RAW);
});

test('TimelineWaveformCache fetches overview once at 1x zoom and only refetches when zoomed in', async () => {
    clearAudioBufferCache();
    const calls: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any) => {
        const u = String(url);
        calls.push(u);
        const parsed = new URL(u, 'http://localhost');
        const s = Number(parsed.searchParams.get('start_sec') || 0);
        const e = Number(parsed.searchParams.get('end_sec') || 0);
        return {
            ok: true,
            json: async () => ({
                peaks: [-0.4, 0.4, -0.8, 0.8],
                duration_seconds: 2400,
                start_sec: s,
                end_sec: e > s ? e : 2400,
            }),
        } as any;
    }) as any;

    try {
        const graph = makeGraph([
            {
                id: 1,
                type: 'Audio/Sample',
                pos: [0, 0],
                properties: {
                    node_name: 'Long Live Rec',
                    filepath: 'C:/audio/live_40min.wav',
                    duration_seconds: 2400,
                    sample_type: 'one_shot',
                },
            },
            {
                id: 3,
                type: 'Audio/Track',
                pos: [240, 0],
                properties: {
                    node_name: 'Master',
                    total_bars: -1,
                },
            },
        ], [[1, 1, 0, 3, 0, 'audio']]);

        const hierarchy = buildTimelineHierarchy(graph, { bpm: 121, globalTotalBars: -1 });
        const store = new TimelineTileOverlayStore();
        let durationChanges = 0;
        const cache = new TimelineWaveformCache((durChanged) => {
            if (durChanged) durationChanges += 1;
        });

        // 1x overview with changing viewport duration estimates must only trigger ONE fetch
        cache.fetchMissingSamplePeaks(hierarchy.visibleLanes, store, 0, 8, 512, 1);
        await new Promise(r => setTimeout(r, 10));
        cache.fetchMissingSamplePeaks(hierarchy.visibleLanes, store, 0, 2340, 512, 1);
        cache.fetchMissingSamplePeaks(hierarchy.visibleLanes, store, 0, 2400, 512, 1);
        await new Promise(r => setTimeout(r, 10));

        assert.equal(calls.length, 1);
        assert.match(calls[0], /start_sec=0&end_sec=0/);
        assert.equal(durationChanges, 1);

        // Zooming in > 1.05x on a sub-window of a >30s file triggers a dedicated zoomed slice fetch
        cache.fetchMissingSamplePeaks(hierarchy.visibleLanes, store, 100, 400, 512, 8);
        await new Promise(r => setTimeout(r, 10));
        assert.equal(calls.length, 2);
        assert.match(calls[1], /start_sec=100&end_sec=400/);

        // Resolving zoomed region returns the zoomed slice while overview stays intact
        const zoomed = cache.resolveTrackPeaks(hierarchy.visibleLanes[0], null, store, 2400, 100, 400, 512);
        assert.ok(zoomed);
        assert.equal(zoomed!.startSec, 100);
        assert.equal(zoomed!.endSec, 400);

        const overview = cache.resolveTrackPeaks(hierarchy.visibleLanes[0], null, store, 2400, 0, 2400, 512);
        assert.ok(overview);
        assert.equal(overview!.startSec, 0);
        assert.equal(overview!.endSec, 2400);
    } finally {
        globalThis.fetch = origFetch;
        clearAudioBufferCache();
    }
});

test('Expanding a Sub-Bus inline reveals its signal-chain lanes while keeping parent & siblings visible', () => {
    const graph = makeGraph(
        [
            { id: 1, type: 'Audio/Sample', pos: [0, 0], properties: { node_name: 'Kick' } },
            { id: 2, type: 'Audio/Sequence', pos: [120, 0], properties: { node_name: 'Kick Seq', sequence: [1, 0, 0, 0] } },
            { id: 3, type: 'Audio/Sample', pos: [0, 120], properties: { node_name: 'Snare' } },
            { id: 20, type: 'Audio/Track', pos: [260, 60], properties: { node_name: 'Drums Bus' } },
            { id: 21, type: 'Audio/Track', pos: [260, 160], properties: { node_name: 'Bass Bus' } },
            { id: 10, type: 'Audio/Track', pos: [460, 60], properties: { node_name: 'Master', role: 'master' } },
        ],
        [
            [1, 1, 0, 2, 0, 'audio'],
            [2, 2, 0, 20, 0, 'audio'],
            [3, 3, 0, 20, 0, 'audio'],
            [4, 20, 0, 10, 0, 'audio'],
            [5, 21, 0, 10, 0, 'audio'],
        ]
    );

    const inlineRes = buildTimelineHierarchy(graph, { expandedSignalChainTrackIds: new Set([20]) });
    assert.deepEqual(
        inlineRes.visibleLanes.map(l => ({ id: l.trackNodeId, kind: l.laneKind, depth: l.depth, owner: l.ownerTrackId })),
        [
            { id: 10, kind: 'track', depth: 0, owner: 10 },
            { id: 20, kind: 'track', depth: 1, owner: 20 },
            { id: 2, kind: 'chain', depth: 2, owner: 20 },
            { id: 3, kind: 'chain', depth: 2, owner: 20 },
            { id: 21, kind: 'track', depth: 1, owner: 21 },
        ]
    );

    // Leaf chain lane (Snare #3) docks directly into Mixer target with 0 upstream rows
    const snareLane = inlineRes.visibleLanes.find(l => l.trackNodeId === 3)!;
    const leafRows = layoutSignalChainRows(snareLane.directSubgraph);
    assert.equal(leafRows.isLeafOnly, true);
    assert.equal(leafRows.targetNode?.id, 3);
    assert.equal(leafRows.rows.length, 0);
});

test('samplePeaksForColumns smoothly interpolates upsampled peaks instead of repeating flat blocks', () => {
    const peaks = new Float32Array([-0.2, 0.2, -1.0, 1.0]);
    const outMin = new Float32Array(5);
    const outMax = new Float32Array(5);
    samplePeaksForColumns(peaks, 0, 10, 0, 10, 5, outMin, outMax);

    assert.ok(outMax[0] > 0.2 && outMax[0] < 0.45);
    assert.ok(outMax[2] > 0.5 && outMax[2] < 0.7);
    assert.ok(outMax[4] > 0.8 && outMax[4] <= 1.0);
    // Strictly monotonic ramp (no flat block steps!)
    assert.ok(outMax[0] < outMax[1] && outMax[1] < outMax[2] && outMax[2] < outMax[3] && outMax[3] < outMax[4]);
});

test('layoutSignalChainRows separates target into Mixer dock and subdivides parallel upstream chains cleanly', () => {
    const graph = makeGraph(
        [
            { id: 1, type: 'Audio/Sample', pos: [0, 0], properties: { node_name: 'Kick' } },
            { id: 2, type: 'Audio/Sample', pos: [0, 120], properties: { node_name: 'Vox' } },
            { id: 3, type: 'Audio/PreampDenoise', pos: [140, 120], properties: { node_name: 'Preamp' }, isAudioProcessor: true },
            { id: 4, type: 'Audio/VoiceIsolator', pos: [280, 120], properties: { node_name: 'Voice' }, isAudioProcessor: true },
            { id: 5, type: 'Audio/Track', pos: [440, 60], properties: { node_name: 'Master' } },
        ],
        [
            [1, 1, 0, 5, 0, 'audio'],
            [2, 2, 0, 3, 0, 'audio'],
            [3, 3, 0, 4, 0, 'audio'],
            [4, 4, 0, 5, 0, 'audio'],
        ]
    );

    const res = buildTimelineHierarchy(graph);
    const masterLane = res.laneByTrackId.get(5)!;
    const layout = layoutSignalChainRows(masterLane.directSubgraph);

    assert.equal(layout.isLeafOnly, false);
    assert.equal(layout.targetNode?.id, 5);
    assert.equal(layout.numCols, 3);
    assert.equal(layout.rows.length, 2);

    // Row 0: short chain (Kick at col 0; cols 1 & 2 left blank) feeding Master Mixer
    assert.deepEqual(layout.rows[0].slots.map(s => ({ id: s.node.id, col: s.col })), [{ id: 1, col: 0 }]);
    assert.equal(layout.rows[0].feedsTarget, true);

    // Row 1: long chain (Vox col 0 -> Preamp col 1 -> Voice col 2) feeding Master Mixer
    assert.deepEqual(
        layout.rows[1].slots.map(s => ({ id: s.node.id, col: s.col })),
        [{ id: 2, col: 0 }, { id: 3, col: 1 }, { id: 4, col: 2 }]
    );
    assert.equal(layout.rows[1].feedsTarget, true);
});

test('Bar-locked timeline strictly enforces globalTotalBars and never emits a phantom 5th bar tick', () => {
    // Even if realtimeDurationSec reports a reverb tail / prior duration (e.g. 9.2s),
    // a 4-bar timeline at 120 BPM must stay locked strictly to 8.0s.
    const tb = resolveTimelineTimebase(120, 4, [], 9.2, 'auto');
    assert.equal(tb.isFreeMode, false);
    assert.equal(tb.resolvedRulerMode, 'bars');
    assert.equal(tb.durationSec, 8.0);

    // At wide widths (sub-beat / beat labels), ticks must stop before bar 5 (sec = 8.0)
    const ticksWide = computeRulerTicks(0, tb.durationSec, 1200, 'bars', tb.bpm, tb.durationSec);
    const barLabelsWide = ticksWide.filter(t => t.major && t.label).map(t => t.label);
    assert.ok(barLabelsWide.includes('1'));
    assert.ok(barLabelsWide.includes('4'));
    assert.ok(barLabelsWide.includes('4.4'));
    assert.equal(barLabelsWide.some(l => l === '5' || l.startsWith('5.')), false);

    // At compact bar-only widths, bar labels are strictly 1..4 (never 5)
    const ticksCompact = computeRulerTicks(0, tb.durationSec, 600, 'bars', tb.bpm, tb.durationSec);
    const barLabelsCompact = ticksCompact.filter(t => t.major && t.label).map(t => t.label);
    assert.deepEqual(barLabelsCompact, ['1', '2', '3', '4']);
});

function makeConnectableGraph(nodes: any[], rawLinks: Array<[number, number, number, number, number]>) {
    const map = new Map<number, any>();
    let nextLinkId = 100;
    const links: Record<number, any> = {};
    const graph: any = {
        _nodes: nodes,
        links,
        getNodeById(id: number) { return map.get(id) ?? null; },
        removeLink(id: number) {
            const l = links[id];
            if (!l) return;
            const tNode = map.get(l.target_id);
            if (tNode?.inputs?.[l.target_slot]?.link === id) {
                tNode.inputs[l.target_slot].link = null;
            }
            delete links[id];
        },
    };
    for (const n of nodes) {
        map.set(n.id, n);
        n.connect = function (outSlot: number, targetNode: any, inSlot: number) {
            const lid = ++nextLinkId;
            links[lid] = { id: lid, origin_id: n.id, origin_slot: outSlot, target_id: targetNode.id, target_slot: inSlot, type: 'audio' };
            if (targetNode.inputs?.[inSlot]) targetNode.inputs[inSlot].link = lid;
            return links[lid];
        };
        n.addInput = function (name: string, type: string) {
            if (!n.inputs) n.inputs = [];
            n.inputs.push({ name, type, link: null });
        };
    }
    for (const [id, oid, os, tid, ts] of rawLinks) {
        links[id] = { id, origin_id: oid, origin_slot: os, target_id: tid, target_slot: ts, type: 'audio' };
        const tNode = map.get(tid);
        if (tNode?.inputs?.[ts]) tNode.inputs[ts].link = id;
    }
    return graph;
}

test('computeNodeAncestorPath traces full path from outermost Master root down to selected leaf', () => {
    const graph = makeGraph(
        [
            { id: 1, type: 'Audio/Sample', pos: [0, 0], properties: { node_name: 'Kick' } },
            { id: 2, type: 'Audio/Sequence', pos: [120, 0], properties: { node_name: 'Kick Seq' } },
            { id: 20, type: 'Audio/Track', pos: [260, 0], properties: { node_name: 'Drums Bus' } },
            { id: 10, type: 'Audio/Track', pos: [440, 0], properties: { node_name: 'Master' } },
        ],
        [
            [1, 1, 0, 2, 0, 'audio'],
            [2, 2, 0, 20, 0, 'audio'],
            [3, 20, 0, 10, 0, 'audio'],
        ]
    );
    const path = computeNodeAncestorPath(graph, 1);
    assert.deepEqual(path.map(p => ({ id: p.nodeId, title: p.title })), [
        { id: 10, title: 'Master' },
        { id: 20, title: 'Drums Bus' },
        { id: 2, title: 'Kick Seq' },
        { id: 1, title: 'Kick' },
    ]);

    // Scoped path rooted at active preview ancestor:
    // 1. Previewing Master (10) while Kick (1) is selected -> full path starting at Master
    assert.deepEqual(
        computeScopedAncestorPath(graph, 1, 10).map(p => p.nodeId),
        [10, 20, 2, 1]
    );
    // 2. Solo-previewing Drums Bus (20) while Kick (1) is selected -> Drums Bus becomes main ancestor!
    assert.deepEqual(
        computeScopedAncestorPath(graph, 1, 20).map(p => p.nodeId),
        [20, 2, 1]
    );
    // 3. Solo-previewing Kick (1) while Master (10) or nothing is selected -> Kick is shown as sole main ancestor
    assert.deepEqual(
        computeScopedAncestorPath(graph, 10, 1).map(p => p.nodeId),
        [1]
    );
    assert.deepEqual(
        computeScopedAncestorPath(graph, null, 1).map(p => p.nodeId),
        [1]
    );
});

test('swapGraphNodes swaps serial signal-flow cables and node coordinates while rejecting incompatible 0-input swaps', () => {
    const graph = makeConnectableGraph(
        [
            { id: 1, type: 'Audio/Sample', pos: [0, 0], inputs: [], outputs: [{ name: 'Audio', type: 'audio' }], properties: { node_name: 'Vox' } },
            { id: 2, type: 'Audio/PreampDenoise', pos: [160, 0], inputs: [{ name: 'Input', type: 'audio', link: null }], outputs: [{ name: 'Audio', type: 'audio' }], properties: { node_name: 'Preamp' } },
            { id: 3, type: 'Audio/VoiceIsolator', pos: [320, 0], inputs: [{ name: 'Input', type: 'audio', link: null }], outputs: [{ name: 'Audio', type: 'audio' }], properties: { node_name: 'VoiceIso' } },
            { id: 4, type: 'Audio/Track', pos: [480, 0], inputs: [{ name: 'Input', type: 'audio', link: null }], outputs: [{ name: 'Audio', type: 'audio' }], properties: { node_name: 'Master' } },
        ],
        [
            [1, 1, 0, 2, 0],
            [2, 2, 0, 3, 0],
            [3, 3, 0, 4, 0],
        ]
    );

    // Sample (0 inputs) cannot swap into Preamp (1 input) position
    assert.equal(canSwapGraphNodes(graph, 1, 2), false);

    // Preamp (2) <-> VoiceIso (3): swaps order to 1 -> 3 -> 2 -> 4 AND swaps coordinates!
    assert.equal(canSwapGraphNodes(graph, 2, 3), true);
    assert.equal(swapGraphNodes(graph, 2, 3), true);

    assert.deepEqual(graph.getNodeById(2).pos, [320, 0]);
    assert.deepEqual(graph.getNodeById(3).pos, [160, 0]);

    const edges = Object.values(graph.links).map((l: any) => `${l.origin_id}->${l.target_id}`).sort();
    assert.deepEqual(edges, ['1->3', '2->4', '3->2']);
});

test('FX chain helpers reorder, move/copy across nodes, and paste with fresh unique IDs while preserving Pre/Post Gain', () => {
    const pre = { id: 'pre_gain_1', type: 'gain', name: 'Pre Gain', enabled: true, fixed: true, params: { gain: 1, gain_db: 0 } };
    const post = { id: 'post_gain_1', type: 'gain', name: 'Post Gain', enabled: true, fixed: true, params: { gain: 1, gain_db: 0 } };
    const eq = { id: 'eq_a', type: 'param_eq', name: 'Param EQ', enabled: true, params: { b1_gain: 3 } };
    const comp = { id: 'comp_a', type: 'comp', name: 'Compressor', enabled: true, params: { threshold_db: -18 } };
    const lim = { id: 'lim_a', type: 'limiter', name: 'Limiter', enabled: true, params: { ceiling_db: -1 } };

    // 1. Reorder within same chain
    const reordered = reorderFxInChain([pre, eq, comp, lim, post], 'lim_a', 0)!;
    assert.deepEqual(reordered.map(m => m.id), ['pre_gain_1', 'lim_a', 'eq_a', 'comp_a', 'post_gain_1']);

    // 2. Move across nodes (removes from source, inserts into target)
    const dstPre = { ...pre, id: 'pre_gain_2' };
    const dstPost = { ...post, id: 'post_gain_2' };
    const moved = moveOrCopyFxBetweenChains([pre, eq, comp, post], [dstPre, dstPost], 'eq_a', 0, false)!;
    assert.deepEqual(moved.nextSourceChain.map(m => m.id), ['pre_gain_1', 'comp_a', 'post_gain_1']);
    assert.deepEqual(moved.nextTargetChain.map(m => m.id), ['pre_gain_2', 'eq_a', 'post_gain_2']);

    // 3. Copy across nodes (keeps source intact, generates fresh ID in target)
    const copied = moveOrCopyFxBetweenChains([pre, eq, comp, post], [dstPre, eq, dstPost], 'eq_a', 1, true)!;
    assert.equal(copied.nextSourceChain.length, 4);
    assert.equal(copied.nextTargetChain.length, 4);
    assert.notEqual(copied.insertedModule.id, 'eq_a');
    assert.equal(copied.insertedModule.params.b1_gain, 3);

    // 4. Paste FX clone before Post Gain
    const pasted = pasteFxIntoChain([dstPre, dstPost], comp);
    assert.equal(pasted.nextChain.length, 3);
    assert.equal(pasted.nextChain[0].id, 'pre_gain_2');
    assert.equal(pasted.nextChain[2].id, 'post_gain_2');
    assert.notEqual(pasted.insertedModule.id, 'comp_a');
    assert.equal(pasted.insertedModule.params.threshold_db, -18);
});
