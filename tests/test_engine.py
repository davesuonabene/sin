from pathlib import Path
import numpy as np
import soundfile as sf

from core.system import System
from core.audio_object import AudioObject
from core.dsp import load_sample


def test_graph_render_engine():
    # Assets path
    assets_dir = Path(__file__).parent.parent / "assets"
    drum_file = assets_dir / "KULTURE_LIQDNB1_DRUM_LOOP_25_171.wav"
    melody_file = assets_dir / "KULTURE_LIQDNB1_PIANO_11_GMAJ_174.wav"

    if not drum_file.exists() or not melody_file.exists():
        raise FileNotFoundError("Required audio assets missing in assets/ directory.")

    # 1. Instantiate System at 170 BPM
    system = System(bpm=170.0, sample_rate=44100)

    # 2. Load assets into leaf AudioObjects (load_sample returns (audio_data, duration))
    drum_audio, _ = load_sample(drum_file, target_sr=system.sample_rate)
    melody_audio, _ = load_sample(melody_file, target_sr=system.sample_rate)

    drum_leaf = AudioObject(name="Drum Loop Sample", audio_data=drum_audio, filepath=drum_file)
    melody_leaf = AudioObject(name="Melody Piano Sample", audio_data=melody_audio, filepath=melody_file)

    # 3. Create "Drum Track" AudioObject and place drum leaf at beat 0.0 and beat 4.0
    drum_track = AudioObject(name="Drum Track")
    drum_track.add_child(drum_leaf, start_beat=0.0)
    drum_track.add_child(drum_leaf, start_beat=4.0)

    # 4. Create "Melody Track" AudioObject and place melody leaf at beat 0.0
    melody_track = AudioObject(name="Melody Track")
    melody_track.add_child(melody_leaf, start_beat=0.0)

    # 5. Create "Master" AudioObject (root), add both tracks
    master_root = AudioObject(name="Master Root Node")
    master_root.add_child(drum_track, start_beat=0.0)
    master_root.add_child(melody_track, start_beat=0.0)

    # Assign to System
    system.root_object = master_root

    # 6. Call system.render()
    output_audio = system.render()

    # Structural & DSP verification
    assert isinstance(output_audio, np.ndarray)
    assert output_audio.dtype == np.float32
    assert len(output_audio) > 0

    # 7. Use soundfile.write to export resulting numpy array to output.wav
    output_filepath = Path("output.wav")
    sf.write(str(output_filepath), output_audio, system.sample_rate)

    print(f"Engine test PASSED!")
    print(f"Drum leaf detected original BPM: {drum_leaf.original_bpm}")
    print(f"Melody leaf detected original BPM: {melody_leaf.original_bpm}")
    print(f"Rendered audio length: {len(output_audio)} samples ({len(output_audio)/system.sample_rate:.2f}s)")
    print(f"Output saved to: {output_filepath.resolve()}")


if __name__ == "__main__":
    test_graph_render_engine()
