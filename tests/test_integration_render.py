from pathlib import Path
import numpy as np
from api import AudioNodeModel, render_graph


def test_full_sequence_render():
    assets_dir = Path(__file__).parent.parent / "assets"
    kick_file = assets_dir / "KULTURE_LIQDNB1_DRUM_LOOP_25_171.wav"
    assert kick_file.exists(), f"Asset file missing: {kick_file}"

    # Build payload structure: TrackNode -> SequenceNode -> SampleNode
    payload = AudioNodeModel(
        node_name="Master Track",
        node_type="track",
        bpm=120.0,
        filename="four_on_the_floor_test",
        children=[
            AudioNodeModel(
                node_name="Kick Sequence",
                node_type="sequence",
                sequence=[1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
                step_length=0.25,
                children=[
                    AudioNodeModel(
                        node_name="Kick Sample",
                        node_type="sample",
                        filepath="KULTURE_LIQDNB1_DRUM_LOOP_25_171.wav"
                    )
                ]
            )
        ]
    )

    res = render_graph(payload)
    print("Render endpoint response:", res)
    assert res["status"] == "success"
    
    out_file = Path(res["file_url"].lstrip("/"))
    assert out_file.exists(), f"Rendered output audio file not found: {out_file}"
    print(f"Rendered audio successfully saved to {out_file} (size: {out_file.stat().st_size} bytes)")


if __name__ == "__main__":
    test_full_sequence_render()
