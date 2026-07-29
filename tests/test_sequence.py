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
    print("test_build_audio_object_sequence PASSED!")


if __name__ == "__main__":
    test_sequence_object_render()
    print("test_sequence_object_render PASSED!")
    test_build_audio_object_sequence()

