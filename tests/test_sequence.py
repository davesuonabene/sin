from pathlib import Path
import numpy as np
from core.system import System
from core.audio_object import AudioObject, SampleObject, SequenceObject
from api import AudioNodeModel, build_audio_object


def test_sequence_object_render():
    assets_dir = Path(__file__).parent.parent / "assets"
    valid_files = list(assets_dir.glob("*.wav"))
    if not valid_files:
        print("No sample files in assets/ directory to test.")
        return

    
    sample_path = valid_files[0]
    system = System(bpm=120.0, sample_rate=44100)
    
    sample_child = SampleObject(name="Kick Sample", filepath=sample_path)
    seq_obj = SequenceObject(
        name="Kick Sequence",
        sequence=[1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
        step_length=0.25
    )
    seq_obj.add_child(sample_child, start_beat=0.0)
    
    output = seq_obj.render(system)
    assert isinstance(output, np.ndarray)
    assert output.dtype == np.float32
    assert len(output) > 0


def test_build_audio_object_sequence():
    node_data = AudioNodeModel(
        node_name="Master Track",
        node_type="track",
        bpm=120.0,
        children=[
            AudioNodeModel(
                node_name="Sequence Node",
                node_type="sequence",
                sequence=[1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
                step_parameters=[{
                    "offset": 0.25,
                    "velocity": 0.5,
                    "probability": 75,
                    "subdivision_enabled": True,
                    "subdivisions": 3,
                }],
                step_length=0.25,
                children=[
                    AudioNodeModel(
                        node_name="Sample Node",
                        node_type="sample",
                        filepath="test.wav"
                    )
                ]
            )
        ]
    )
    root = build_audio_object(node_data)
    assert isinstance(root, AudioObject)
    assert len(root.children) == 1
    seq_child = root.children[0][1]
    assert isinstance(seq_child, SequenceObject)
    assert seq_child.sequence == [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]
    assert seq_child.step_length == 0.25
    assert seq_child.step_parameters[0]["subdivisions"] == 3
    print("test_build_audio_object_sequence PASSED!")


def test_sequence_step_parameters_render():
    system = System(bpm=60.0, sample_rate=100)
    sample = AudioObject(
        name="Impulse",
        audio_data=np.ones(1, dtype=np.float32),
        original_bpm=60,
        sample_type="one_shot",
    )
    sequence = SequenceObject(
        sequence=[1, 1, 1],
        step_length=1.0,
        step_parameters=[
            {"offset": 0.5, "velocity": 0.5, "probability": 100},
            {"velocity": 1.0, "probability": 100, "subdivision_enabled": True, "subdivisions": 2},
            {"probability": 0},
        ],
    )
    sequence.add_child(sample, start_beat=0)

    output = sequence.render(system)
    assert output[50] == np.float32(0.5)
    assert output[100] == np.float32(1.0)
    assert output[150] == np.float32(1.0)
    assert output[200] == np.float32(0.0)


def test_sequence_rolls_cut_long_samples_into_monophonic_slots():
    system = System(bpm=60.0, sample_rate=100)
    sample = AudioObject(
        name="Long sample",
        audio_data=np.arange(100, dtype=np.float32),
        sample_type="one_shot",
    )
    sequence = SequenceObject(
        sequence=[1],
        step_length=1.0,
        step_parameters=[{"subdivision_enabled": True, "subdivisions": 2}],
    )
    sequence.add_child(sample, start_beat=0)

    rendered = sequence.render(system)

    assert len(rendered) == 100
    # The second roll restarts at sample 50 instead of summing with the first.
    assert rendered[49] == np.float32(49.0)
    assert rendered[50] == np.float32(0.0)
    assert rendered[75] == np.float32(25.0)


def test_sequence_subdivision_count_is_authoritative():
    """A valid xN count must render even if the legacy enable flag is stale."""
    system = System(bpm=60.0, sample_rate=100)
    sample = AudioObject(
        name="Impulse",
        audio_data=np.ones(1, dtype=np.float32),
        sample_type="one_shot",
    )
    sequence = SequenceObject(
        sequence=[1],
        step_length=1.0,
        step_parameters=[{"subdivision_enabled": False, "subdivisions": 4}],
    )
    sequence.add_child(sample, start_beat=0)

    rendered = sequence.render(system)

    np.testing.assert_array_equal(rendered[[0, 25, 50, 75]], np.ones(4, dtype=np.float32))


def test_sequence_subdivisions_partition_exact_step_sample_range():
    """Subdivision triggers stay evenly quantized inside one integer sample step."""
    system = System(bpm=137.0, sample_rate=44100)
    sample = AudioObject(
        name="Impulse",
        audio_data=np.ones(1, dtype=np.float32),
        sample_type="one_shot",
    )
    sequence = SequenceObject(
        sequence=[1],
        step_length=0.25,
        step_parameters=[{"subdivisions": 7}],
    )
    sequence.add_child(sample, start_beat=0)

    rendered = sequence.render(system)
    step_samples = system.beat_to_samples(0.25)
    expected_starts = [round(step_samples * index / 7) for index in range(7)]

    assert np.flatnonzero(rendered).tolist() == expected_starts
    assert all(0 <= start < step_samples for start in expected_starts)


def test_sequence_play_mode_trigger_mode_and_mono_cut():
    system = System(bpm=60.0, sample_rate=100)
    # Long sample duration of 100 samples (1.0 beat)
    sample = AudioObject(
        name="Bass Tail Sample",
        audio_data=np.ones(100, dtype=np.float32),
        sample_type="one_shot",
    )

    # In Gate mode (default): step 0 (beat 0..0.25 = 25 samples) cuts off at sample 25
    seq_gate = SequenceObject(
        sequence=[1, 0, 0, 0],  # trigger on beat 0, silent on beats 0.25, 0.5, 0.75
        step_length=0.25,
        play_mode="gate"
    )
    seq_gate.add_child(sample, start_beat=0)
    out_gate = seq_gate.render(system)
    assert len(out_gate) >= 25
    assert np.all(out_gate[:25] == 1.0)
    assert np.all(out_gate[25:50] == 0.0)

    # In Trigger mode: step 0 plays full sample (100 samples) across silent steps
    seq_trig = SequenceObject(
        sequence=[1, 0, 0, 0],
        step_length=0.25,
        play_mode="trigger"
    )
    seq_trig.add_child(sample, start_beat=0)
    out_trig = seq_trig.render(system)
    assert len(out_trig) == 100
    assert np.all(out_trig[:100] == 1.0)

    # Trigger mode with Mono Cutting: step 0 (sample 0) triggers long sample, step 2 (sample 50) cuts step 0
    seq_mono = SequenceObject(
        sequence=[1, 0, 1, 0], # trigger at beat 0 (sample 0) and beat 0.5 (sample 50)
        step_length=0.25,
        play_mode="trigger"
    )
    seq_mono.add_child(sample, start_beat=0)
    out_mono = seq_mono.render(system)
    # Step 0 plays from 0 to 50, then step 2 triggers at 50 and plays from 50 to 150
    assert len(out_mono) == 150
    assert np.all(out_mono[:150] == 1.0)


def test_sequence_seed_fixed_vs_moving():
    system = System(bpm=60.0, sample_rate=100)
    sample = AudioObject(
        name="Impulse",
        audio_data=np.ones(1, dtype=np.float32),
        original_bpm=60,
        sample_type="one_shot",
    )
    step_params = [{"probability": 50.0} for _ in range(16)]

    seq_fixed = SequenceObject(
        sequence=[1] * 16,
        step_length=0.25,
        step_parameters=step_params,
        seed=12345,
        seed_mode="fixed"
    )
    seq_fixed.add_child(sample, start_beat=0)

    out_fixed_0 = seq_fixed.render(system, iteration=0)
    out_fixed_1 = seq_fixed.render(system, iteration=1)
    np.testing.assert_array_equal(out_fixed_0, out_fixed_1)

    seq_moving = SequenceObject(
        sequence=[1] * 16,
        step_length=0.25,
        step_parameters=step_params,
        seed=12345,
        seed_mode="moving"
    )
    seq_moving.add_child(sample, start_beat=0)

    out_moving_0 = seq_moving.render(system, iteration=0)
    out_moving_1 = seq_moving.render(system, iteration=1)
    assert not np.array_equal(out_moving_0, out_moving_1)


if __name__ == "__main__":
    test_sequence_object_render()
    print("test_sequence_object_render PASSED!")
    test_build_audio_object_sequence()
    test_sequence_play_mode_trigger_mode_and_mono_cut()
    print("test_sequence_play_mode_trigger_mode_and_mono_cut PASSED!")
    test_sequence_seed_fixed_vs_moving()
    print("test_sequence_seed_fixed_vs_moving PASSED!")

