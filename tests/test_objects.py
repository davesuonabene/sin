from pathlib import Path
from core.base_object import BaseObject
from core.audio_object import AudioObject


def test_audio_object_matrix_rendering():
    # 1. Instantiate parent AudioObject (Track / Sequence)
    parent_track = AudioObject(name="Master Beat Track", duration=5.0)

    # 2. Instantiate child AudioObjects (Leaf samples)
    kick_sample = AudioObject(
        name="Kick 808",
        filepath=Path("samples/kick.wav"),
        duration=0.5,
        volume=0.9,
        pan=0.0
    )
    snare_sample = AudioObject(
        name="Snare Trap",
        filepath=Path("samples/snare.wav"),
        duration=0.4,
        volume=0.8,
        pan=0.1
    )

    # Verify BaseObject inheritance and typing
    assert isinstance(parent_track, BaseObject)
    assert isinstance(kick_sample, BaseObject)

    # Verify leaf node property
    assert kick_sample.is_leaf is True
    assert parent_track.is_leaf is True  # initially empty matrix

    # 3. Place children into the parent's matrix at specific time intervals (0.0 and 1.5 seconds)
    # Track 0: Kick at 0.0s, Kick at 1.5s
    # Track 1: Snare at 1.5s
    parent_track.add_to_matrix(time_sec=0.0, track_idx=0, audio_obj=kick_sample)
    parent_track.add_to_matrix(time_sec=1.5, track_idx=0, audio_obj=kick_sample)
    parent_track.add_to_matrix(time_sec=1.5, track_idx=1, audio_obj=snare_sample)

    assert parent_track.is_leaf is False

    # Verify musical time translation stub
    calc_time = parent_track._translate_musical_time(bar=1, beat=3, bpm=120.0)
    assert calc_time == 1.0  # 120 bpm = 0.5s per beat, bar 1 beat 3 = beat offset 2 = 1.0s

    # 4. Call render() and verify output structure
    render_result = parent_track.render()

    print("Render Result Summary:")
    print(f"Track Name: {render_result['name']}")
    print(f"Timeline Slices Count: {len(render_result['timeline'])}")
    for slice_data in render_result["timeline"]:
        print(f"  Timestamp: {slice_data['timestamp']}s")
        for track_idx, child in slice_data["mixed_tracks"]:
            print(f"    - Track {track_idx}: {child['name']} (Vol: {child['volume']})")

    assert render_result["name"] == "Master Beat Track"
    assert len(render_result["timeline"]) == 2
    assert render_result["timeline"][0]["timestamp"] == 0.0
    assert render_result["timeline"][1]["timestamp"] == 1.5

    print("\nSUCCESS: AudioObject matrix architecture and render pipeline verified!")


if __name__ == "__main__":
    test_audio_object_matrix_rendering()
