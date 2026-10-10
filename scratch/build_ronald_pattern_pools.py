import json
import os

def create_compact_system_with_pattern_pools(
    filename,
    name,
    bpm,
    key,
    total_bars,
    sample_pools_data,
    pattern_pools_data,
    seqs_data,
    track_gains,
    key_match_algorithm="nearest"
):
    nodes = []
    connections = []
    attachments = []

    # 1. Melodic Sample Channel (Alone)
    nodes.append({
        "id": "melody-pool",
        "type": "asset_filter",
        "position": [80, 100],
        "properties": {
            "node_name": f"{name} Melodic Pool",
            "selected_items": [{"id": item_id} for item_id in sample_pools_data["melody"]],
            "playbackMode": "Random",
            "refresh_mode": "global",
            "seed": 101,
            "output_type": "asset_path"
        }
    })
    nodes.append({
        "id": "melody-src",
        "type": "sample",
        "position": [320, 100],
        "properties": {
            "node_name": "Melody Atmosphere",
            "sample_type": "loop",
            "total_bars": total_bars,
            "stretch_mode": "RubberBand",
            "key_match_mode": "follow",
            "key_match_algorithm": key_match_algorithm,
            "gain": track_gains.get("melody", -3),
            "fade_in": 0.05,
            "fade_out": 0.05
        }
    })
    nodes.append({
        "id": "track-atmosphere",
        "type": "track",
        "position": [1040, 100],
        "properties": {
            "node_name": "Atmosphere Submix",
            "gain": track_gains.get("melody", -3),
            "fx_modules": [
                {"type": "space_reverb", "decay": 3.0, "mix": 0.25}
            ]
        }
    })
    connections.append({"from": "melody-src", "to": "track-atmosphere", "type": "audio"})
    attachments.append({"owner": "melody-src", "modifier": "melody-pool", "type": "asset_pool"})

    # 2. Compacted Drums & 808
    # 2a. 808 Sub
    nodes.append({
        "id": "sub-808-pool",
        "type": "asset_filter",
        "position": [80, 260],
        "properties": {
            "node_name": "808 Sub Sample Pool",
            "selected_items": [{"id": item_id} for item_id in sample_pools_data["sub_808"]],
            "playbackMode": "Sequential",
            "refresh_mode": "global",
            "seed": 202,
            "output_type": "asset_path"
        }
    })
    nodes.append({
        "id": "sub-808-src",
        "type": "sample",
        "position": [320, 260],
        "properties": {
            "node_name": "808 Sub",
            "sample_type": "one_shot",
            "gain": 0
        }
    })
    nodes.append({
        "id": "sub-808-seq",
        "type": "sequence",
        "position": [580, 260],
        "properties": {
            "node_name": "808 Sequence",
            "step_length": 0.25,
            "play_mode": "trigger",
            "total_bars": total_bars,
            "sequence": seqs_data["sub_808"]["on"],
            "step_parameters": seqs_data["sub_808"]["params"],
            "seed": 202,
            "seed_mode": "moving"
        }
    })
    nodes.append({
        "id": "sub-808-pattern-pool",
        "type": "asset_filter",
        "position": [800, 260],
        "properties": {
            "node_name": "808 Pattern Pool",
            "selected_items": [{"id": item_id} for item_id in pattern_pools_data["sub_808"]],
            "playbackMode": "Random",
            "refresh_mode": "global",
            "seed": 222,
            "output_type": "asset_path",
            "accepted_asset_type": "sequence_source"
        }
    })
    connections.append({"from": "sub-808-src", "to": "sub-808-seq", "type": "audio"})
    attachments.append({"owner": "sub-808-src", "modifier": "sub-808-pool", "type": "asset_pool"})
    attachments.append({"owner": "sub-808-seq", "modifier": "sub-808-pattern-pool", "type": "asset_pool"})

    # 2b. Kick
    nodes.append({
        "id": "kick-pool",
        "type": "asset_filter",
        "position": [80, 400],
        "properties": {
            "node_name": "Kick Sample Pool",
            "selected_items": [{"id": item_id} for item_id in sample_pools_data["kick"]],
            "playbackMode": "Random",
            "refresh_mode": "global",
            "seed": 303,
            "output_type": "asset_path"
        }
    })
    nodes.append({
        "id": "kick-src",
        "type": "sample",
        "position": [320, 400],
        "properties": {
            "node_name": "Kick Drum",
            "sample_type": "one_shot",
            "gain": 0
        }
    })
    nodes.append({
        "id": "kick-seq",
        "type": "sequence",
        "position": [580, 400],
        "properties": {
            "node_name": "Kick Pattern",
            "step_length": 0.25,
            "play_mode": "trigger",
            "total_bars": total_bars,
            "sequence": seqs_data["kick"]["on"],
            "step_parameters": seqs_data["kick"]["params"],
            "seed": 303,
            "seed_mode": "moving"
        }
    })
    nodes.append({
        "id": "kick-pattern-pool",
        "type": "asset_filter",
        "position": [800, 400],
        "properties": {
            "node_name": "Kick Pattern Pool",
            "selected_items": [{"id": item_id} for item_id in pattern_pools_data["kick"]],
            "playbackMode": "Random",
            "refresh_mode": "global",
            "seed": 333,
            "output_type": "asset_path",
            "accepted_asset_type": "sequence_source"
        }
    })
    connections.append({"from": "kick-src", "to": "kick-seq", "type": "audio"})
    attachments.append({"owner": "kick-src", "modifier": "kick-pool", "type": "asset_pool"})
    attachments.append({"owner": "kick-seq", "modifier": "kick-pattern-pool", "type": "asset_pool"})

    # 2c. Snare / Clap
    nodes.append({
        "id": "snare-pool",
        "type": "asset_filter",
        "position": [80, 560],
        "properties": {
            "node_name": "Snare/Clap Sample Pool",
            "selected_items": [{"id": item_id} for item_id in sample_pools_data["snare"]],
            "playbackMode": "Random",
            "refresh_mode": "global",
            "seed": 404,
            "output_type": "asset_path"
        }
    })
    nodes.append({
        "id": "snare-src",
        "type": "sample",
        "position": [320, 560],
        "properties": {
            "node_name": "Snare Drum",
            "sample_type": "one_shot",
            "gain": 0
        }
    })
    nodes.append({
        "id": "snare-seq",
        "type": "sequence",
        "position": [580, 560],
        "properties": {
            "node_name": "Snare Pattern",
            "step_length": 0.25,
            "play_mode": "trigger",
            "total_bars": total_bars,
            "sequence": seqs_data["snare"]["on"],
            "step_parameters": seqs_data["snare"]["params"],
            "seed": 404,
            "seed_mode": "moving"
        }
    })
    nodes.append({
        "id": "snare-pattern-pool",
        "type": "asset_filter",
        "position": [800, 560],
        "properties": {
            "node_name": "Snare Pattern Pool",
            "selected_items": [{"id": item_id} for item_id in pattern_pools_data["snare"]],
            "playbackMode": "Random",
            "refresh_mode": "global",
            "seed": 444,
            "output_type": "asset_path",
            "accepted_asset_type": "sequence_source"
        }
    })
    nodes.append({
        "id": "snare-rnd",
        "type": "random",
        "position": [580, 640],
        "properties": {
            "node_name": "Snare Humanizer",
            "refresh_mode": "global",
            "seed": 444,
            "destinations": [
                {
                    "id": "dest-snare-vel",
                    "paramKey": "velocity",
                    "paramLabel": "Velocity",
                    "minPercent": -10,
                    "maxPercent": 10,
                    "baseValue": 1.0,
                    "enabled": True
                },
                {
                    "id": "dest-snare-offset",
                    "paramKey": "offset",
                    "paramLabel": "Offset",
                    "minPercent": -8,
                    "maxPercent": 8,
                    "baseValue": 0.0,
                    "enabled": True
                }
            ]
        }
    })
    connections.append({"from": "snare-src", "to": "snare-seq", "type": "audio"})
    attachments.append({"owner": "snare-src", "modifier": "snare-pool", "type": "asset_pool"})
    attachments.append({"owner": "snare-seq", "modifier": "snare-pattern-pool", "type": "asset_pool"})
    attachments.append({"owner": "snare-seq", "modifier": "snare-rnd", "type": "random"})

    # 2d. Hi-Hat
    nodes.append({
        "id": "hat-pool",
        "type": "asset_filter",
        "position": [80, 740],
        "properties": {
            "node_name": "Hi-Hat Sample Pool",
            "selected_items": [{"id": item_id} for item_id in sample_pools_data["hat"]],
            "playbackMode": "Random",
            "refresh_mode": "global",
            "seed": 505,
            "output_type": "asset_path"
        }
    })
    nodes.append({
        "id": "hat-src",
        "type": "sample",
        "position": [320, 740],
        "properties": {
            "node_name": "Hi-Hat",
            "sample_type": "one_shot",
            "gain": 0
        }
    })
    nodes.append({
        "id": "hat-seq",
        "type": "sequence",
        "position": [580, 740],
        "properties": {
            "node_name": "Hi-Hat Pattern",
            "step_length": 0.25,
            "play_mode": "gate",
            "total_bars": total_bars,
            "sequence": seqs_data["hat"]["on"],
            "step_parameters": seqs_data["hat"]["params"],
            "seed": 505,
            "seed_mode": "moving"
        }
    })
    nodes.append({
        "id": "hat-pattern-pool",
        "type": "asset_filter",
        "position": [800, 740],
        "properties": {
            "node_name": "Hi-Hat Pattern Pool",
            "selected_items": [{"id": item_id} for item_id in pattern_pools_data["hat"]],
            "playbackMode": "Random",
            "refresh_mode": "global",
            "seed": 555,
            "output_type": "asset_path",
            "accepted_asset_type": "sequence_source"
        }
    })
    nodes.append({
        "id": "hat-rnd",
        "type": "random",
        "position": [580, 820],
        "properties": {
            "node_name": "Hi-Hat Humanizer",
            "refresh_mode": "global",
            "seed": 555,
            "destinations": [
                {
                    "id": "dest-hihat-vel",
                    "paramKey": "velocity",
                    "paramLabel": "Velocity",
                    "minPercent": -18,
                    "maxPercent": 18,
                    "baseValue": 1.0,
                    "enabled": True
                },
                {
                    "id": "dest-hihat-offset",
                    "paramKey": "offset",
                    "paramLabel": "Offset",
                    "minPercent": -12,
                    "maxPercent": 12,
                    "baseValue": 0.0,
                    "enabled": True
                }
            ]
        }
    })
    connections.append({"from": "hat-src", "to": "hat-seq", "type": "audio"})
    attachments.append({"owner": "hat-src", "modifier": "hat-pool", "type": "asset_pool"})
    attachments.append({"owner": "hat-seq", "modifier": "hat-pattern-pool", "type": "asset_pool"})
    attachments.append({"owner": "hat-seq", "modifier": "hat-rnd", "type": "random"})

    # 2e. Compacted Drum & 808 Submix Track
    nodes.append({
        "id": "drum-submix",
        "type": "track",
        "position": [1040, 500],
        "properties": {
            "node_name": "Drum & 808 Submix",
            "gain": track_gains.get("drum_bus", 0),
            "fx_modules": [
                {"type": "compressor", "threshold_db": -12, "ratio": 4, "attack_ms": 15, "release_ms": 120}
            ]
        }
    })

    connections.append({"from": "sub-808-seq", "to": "drum-submix", "type": "audio"})
    connections.append({"from": "kick-seq", "to": "drum-submix", "type": "audio"})
    connections.append({"from": "snare-seq", "to": "drum-submix", "type": "audio"})
    connections.append({"from": "hat-seq", "to": "drum-submix", "type": "audio"})

    # 3. Master Output Track
    nodes.append({
        "id": "master",
        "type": "track",
        "role": "master",
        "position": [1320, 300],
        "properties": {
            "node_name": "Master Output",
            "gain": 0
        }
    })

    connections.append({"from": "track-atmosphere", "to": "master", "type": "audio"})
    connections.append({"from": "drum-submix", "to": "master", "type": "audio"})

    doc = {
        "format": "sin-graph",
        "version": 1,
        "settings": {
            "bpm": bpm,
            "total_bars": total_bars,
            "key": key
        },
        "output": "master",
        "nodes": nodes,
        "connections": connections,
        "attachments": attachments
    }

    os.makedirs(os.path.dirname(filename), exist_ok=True)
    with open(filename, 'w', encoding='utf-8') as f:
        json.dump(doc, f, indent=2)
    print(f"Generated {filename}")

def build_channel(on, vel=None, off=None, sub=None, prob=None):
    if vel is None: vel = [1.0 if x else 0.0 for x in on]
    if off is None: off = [0.0] * len(on)
    if sub is None: sub = [1] * len(on)
    if prob is None: prob = [100] * len(on)
    params = []
    for i in range(len(on)):
        params.append({
            "velocity": float(vel[i]),
            "offset": float(off[i]),
            "subdivisions": int(sub[i]),
            "subdivision_enabled": int(sub[i]) > 1,
            "probability": int(prob[i])
        })
    return {"on": on, "params": params}

# Shared curated Pattern Pools from Default Vault
pattern_pools = {
    "kick": [7354, 7355, 7356, 7364, 7267, 7272],
    "snare": [7357, 7358, 7359, 7365, 7268, 7270, 7283],
    "hat": [7360, 7361, 7362, 7366, 7269, 7281, 7282, 7285],
    "sub_808": [7354, 7356, 7274, 7276, 7279]
}

# --- SYSTEM 1: CLOUD DRIFT ---
sys1_pools = {
    "melody": [1700, 1701, 2273, 1684, 857, 664, 628, 626, 630, 633, 648, 649, 655, 658],
    "sub_808": [3007, 3056, 3047, 3050, 3018, 3021, 3024, 3030, 3035, 3040, 3048, 3051, 3059, 7288],
    "kick": [352, 353, 354, 355, 356, 357, 358, 359, 360, 371, 376, 475, 3615],
    "snare": [1083, 1084, 1085, 1086, 1087, 1088, 1091, 1094, 127, 128, 129, 131, 135, 1173, 1174, 1179, 3157],
    "hat": [260, 261, 262, 263, 264, 265, 267, 268, 270, 271, 274, 278, 279, 280, 323, 188, 3711, 3712]
}

sys1_kick = build_channel(
    [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0],
    [1.0, 0, 0, 0, 0, 0, 0.85, 0, 0, 0, 0.95, 0, 0, 0, 0, 0],
    [0.0, 0, 0, 0, 0, 0, -0.012, 0, 0, 0, 0.008, 0, 0, 0, 0, 0]
)

sys1_snare = build_channel(
    [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1],
    [0, 0, 0, 0, 1.0, 0, 0, 0, 0, 0, 0, 0, 0.98, 0, 0, 0.42],
    [0, 0, 0, 0, 0.015, 0, 0, 0, 0, 0, 0, 0, 0.018, 0, 0, -0.010],
    [1] * 16,
    [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 80]
)

sys1_hat_sub = [1] * 16
sys1_hat_sub[11] = 2
sys1_hat_sub[15] = 3
sys1_hat = build_channel(
    [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    [0.92, 0.40, 0.78, 0.38, 0.95, 0.45, 0.82, 0.40, 0.90, 0.42, 0.80, 0.55, 0.92, 0.45, 0.85, 0.65],
    [0.0, 0.015, 0.0, 0.020, 0.0, 0.015, 0.0, 0.022, 0.0, 0.015, 0.0, 0.025, 0.0, 0.018, 0.0, 0.012],
    sys1_hat_sub
)

sys1_808 = build_channel(
    [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [1.0, 0, 0, 0, 0, 0, 0.90, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0.0, 0, 0, 0, 0, 0, -0.012, 0, 0, 0, 0, 0, 0, 0, 0, 0]
)

sys1_seqs = {
    "kick": sys1_kick,
    "snare": sys1_snare,
    "hat": sys1_hat,
    "sub_808": sys1_808
}

create_compact_system_with_pattern_pools(
    "demo/ronald/system_1_cloud_drift.json",
    "Cloud Drift",
    76,
    "Fm",
    16,
    sys1_pools,
    pattern_pools,
    sys1_seqs,
    {"melody": -3, "drum_bus": 0},
    key_match_algorithm="lower"
)

# --- SYSTEM 2: TAPE HAZE ---
sys2_pools = {
    "melody": [628, 634, 651, 661, 669, 670, 677, 684, 691, 1658, 1700, 1701, 2273, 1684],
    "sub_808": [3007, 3056, 3047, 3050, 3018, 3019, 3030, 3035, 3043, 3048, 3059, 7288],
    "kick": [352, 353, 354, 355, 356, 357, 358, 359, 360, 371, 376, 475, 3615],
    "snare": [1083, 1084, 1085, 1086, 1087, 1088, 1091, 1094, 127, 128, 129, 131, 135, 1173, 1174, 1179, 3157],
    "hat": [260, 261, 262, 263, 264, 265, 267, 268, 270, 271, 274, 278, 279, 280, 323, 188, 3711, 3712]
}

sys2_kick = build_channel(
    [1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0],
    [1.0, 0, 0, 0, 0, 0, 0, 0.78, 0, 0, 0.92, 0, 0, 0, 0, 0],
    [0.0, 0, 0, 0, 0, 0, 0, 0.035, 0, 0, -0.010, 0, 0, 0, 0, 0]
)

sys2_snare = build_channel(
    [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0],
    [0, 0, 0, 0, 1.0, 0, 0, 0, 0, 0, 0, 0, 0.95, 0, 0.50, 0],
    [0, 0, 0, 0, 0.022, 0, 0, 0, 0, 0, 0, 0, 0.024, 0, 0.015, 0],
    [1] * 16,
    [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 75, 100]
)

sys2_hat = build_channel(
    [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0],
    [0.95, 0, 0.70, 0, 0.90, 0, 0.72, 0, 0.98, 0, 0.68, 0, 0.92, 0, 0.75, 0],
    [0.0, 0, 0.045, 0, 0.0, 0, 0.042, 0, 0.0, 0, 0.048, 0, 0.0, 0, 0.040, 0]
)

sys2_808 = build_channel(
    [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
    [1.0, 0, 0, 0, 0, 0, 0, 0, 0.92, 0, 0, 0, 0, 0, 0, 0],
    [0.0, 0, 0, 0, 0, 0, 0, 0, -0.010, 0, 0, 0, 0, 0, 0, 0]
)

sys2_seqs = {
    "kick": sys2_kick,
    "snare": sys2_snare,
    "hat": sys2_hat,
    "sub_808": sys2_808
}

create_compact_system_with_pattern_pools(
    "demo/ronald/system_2_tape_haze.json",
    "Tape Haze",
    82,
    "Abm",
    16,
    sys2_pools,
    pattern_pools,
    sys2_seqs,
    {"melody": -2, "drum_bus": 0},
    key_match_algorithm="lower"
)

# --- SYSTEM 3: CELESTIAL DRIP ---
sys3_pools = {
    "melody": [857, 664, 666, 678, 680, 682, 686, 1658, 2273, 1700, 1701, 1684, 626, 628],
    "sub_808": [3007, 3056, 3047, 3050, 3018, 3019, 3021, 3024, 3030, 3035, 3040, 3043, 3048, 3051, 3059, 7288],
    "kick": [352, 353, 354, 355, 356, 357, 358, 359, 360, 371, 376, 475, 3615],
    "snare": [1083, 1084, 1085, 1086, 1087, 1088, 1091, 1094, 127, 128, 129, 131, 135, 1173, 1174, 1179, 3157],
    "hat": [260, 261, 262, 263, 264, 265, 267, 268, 270, 271, 274, 278, 279, 280, 323, 188, 3711, 3712]
}

sys3_kick = build_channel(
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0],
    [1.0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.88, 0, 0, 0, 0, 0],
    [0.0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -0.015, 0, 0, 0, 0, 0]
)

sys3_snare = build_channel(
    [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0],
    [0, 0, 0, 0, 1.0, 0, 0, 0, 0, 0, 0, 0.35, 0.98, 0, 0, 0],
    [0, 0, 0, 0, 0.018, 0, 0, 0, 0, 0, 0, 0.025, 0.020, 0, 0, 0],
    [1] * 16,
    [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 85, 100, 100, 100, 100]
)

sys3_hat_sub = [1] * 16
sys3_hat_sub[6] = 2
sys3_hat_sub[14] = 3
sys3_hat = build_channel(
    [1] * 16,
    [0.90, 0.45, 0.85, 0.40, 0.92, 0.50, 0.75, 0.45, 0.95, 0.45, 0.82, 0.40, 0.88, 0.45, 0.70, 0.55],
    [0.0, 0.022, 0.0, 0.025, 0.0, 0.022, 0.0, 0.028, 0.0, 0.022, 0.0, 0.025, 0.0, 0.022, 0.0, 0.020],
    sys3_hat_sub
)

sys3_808 = build_channel(
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0],
    [1.0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.95, 0, 0, 0, 0, 0],
    [0.0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -0.012, 0, 0, 0, 0, 0]
)

sys3_seqs = {
    "kick": sys3_kick,
    "snare": sys3_snare,
    "hat": sys3_hat,
    "sub_808": sys3_808
}

create_compact_system_with_pattern_pools(
    "demo/ronald/system_3_celestial_drip.json",
    "Celestial Drip",
    72,
    "Em",
    16,
    sys3_pools,
    pattern_pools,
    sys3_seqs,
    {"melody": -2.5, "drum_bus": 0},
    key_match_algorithm="lower"
)
