import numpy as np
from core.fx import process_chain, apply_gain, apply_distortion, apply_filter, apply_eq, apply_compressor
from core.audio_object import AudioObject, SampleObject
from core.system import System


def test_apply_gain():
    audio = np.array([0.5, -0.5, 0.25], dtype=np.float32)
    processed = apply_gain(audio, {"gain": 2.0})
    np.testing.assert_allclose(processed, [1.0, -1.0, 0.5])


def test_apply_distortion():
    audio = np.array([0.1, 0.5, 1.0], dtype=np.float32)
    processed = apply_distortion(audio, {"drive": 5.0, "mix": 1.0})
    assert np.all(processed <= 1.0)
    assert np.all(processed >= -1.0)


def test_process_chain_execution():
    audio = np.ones(100, dtype=np.float32) * 0.5
    chain = [
        {"id": "pre", "type": "gain", "name": "Pre Gain", "enabled": True, "params": {"gain": 1.5}},
        {"id": "dist", "type": "distortion", "name": "Drive", "enabled": True, "params": {"drive": 2.0, "mix": 0.5}},
        {"id": "post", "type": "gain", "name": "Post Gain", "enabled": True, "params": {"gain": 0.5}}
    ]

    out = process_chain(audio, chain, sample_rate=44100)
    assert len(out) == 100
    assert not np.array_equal(audio, out)


def test_process_chain_bypass():
    audio = np.ones(100, dtype=np.float32) * 0.5
    chain = [
        {"id": "pre", "type": "gain", "name": "Pre Gain", "enabled": True, "params": {"gain": 2.0}},
        {"id": "dist", "type": "distortion", "name": "Drive", "enabled": False, "params": {"drive": 10.0, "mix": 1.0}},
        {"id": "post", "type": "gain", "name": "Post Gain", "enabled": True, "params": {"gain": 0.5}}
    ]

    out = process_chain(audio, chain, sample_rate=44100)
    # Pre gain *2.0 (1.0), Post gain *0.5 (0.5), Distortion bypassed
    np.testing.assert_allclose(out, audio, rtol=1e-4)


def test_audio_object_render_with_chain():
    sys = System(bpm=120.0, sample_rate=44100)
    raw_data = np.ones(1000, dtype=np.float32) * 0.4
    chain = [
        {"id": "pre", "type": "gain", "name": "Pre Gain", "enabled": True, "params": {"gain": 1.5}},
        {"id": "post", "type": "gain", "name": "Post Gain", "enabled": True, "params": {"gain": 0.5}}
    ]
    obj = AudioObject(name="TestObject", audio_data=raw_data, volume=1.0, chain=chain)
    rendered = obj.render(system=sys)

    assert len(rendered) == 1000
    expected = raw_data * 1.5 * 0.5
    np.testing.assert_allclose(rendered, expected, rtol=1e-4)
