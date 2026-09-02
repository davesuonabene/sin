import numpy as np
from typing import List, Dict, Any


def apply_gain(audio: np.ndarray, params: Dict[str, Any]) -> np.ndarray:
    gain = float(params.get("gain", 1.0))
    if gain == 1.0:
        return audio
    return (audio * gain).astype(np.float32, copy=False)


def apply_eq(audio: np.ndarray, params: Dict[str, Any], sr: int = 44100) -> np.ndarray:
    low_gain = float(params.get("low_gain", 1.0))
    mid_gain = float(params.get("mid_gain", 1.0))
    high_gain = float(params.get("high_gain", 1.0))

    if audio.shape[-1] == 0:
        return audio

    if low_gain == 1.0 and mid_gain == 1.0 and high_gain == 1.0:
        return audio

    fft_vals = np.fft.rfft(audio, axis=-1)
    freqs = np.fft.rfftfreq(audio.shape[-1], d=1.0 / sr)

    low_mask = freqs < 250.0
    mid_mask = (freqs >= 250.0) & (freqs <= 4000.0)
    high_mask = freqs > 4000.0

    gain_curve = np.ones_like(freqs, dtype=np.float32)
    gain_curve[low_mask] *= low_gain
    gain_curve[mid_mask] *= mid_gain
    gain_curve[high_mask] *= high_gain

    filtered_fft = fft_vals * gain_curve
    filtered_audio = np.fft.irfft(filtered_fft, n=audio.shape[-1], axis=-1)
    return filtered_audio.astype(np.float32)


def apply_compressor(audio: np.ndarray, params: Dict[str, Any], sr: int = 44100) -> np.ndarray:
    threshold_db = float(params.get("threshold", -12.0))
    ratio = float(params.get("ratio", 4.0))
    attack_ms = float(params.get("attack", 10.0))
    release_ms = float(params.get("release", 100.0))

    if audio.shape[-1] == 0 or ratio <= 1.0:
        return audio

    threshold_lin = 10 ** (threshold_db / 20.0)
    attack_coeff = np.exp(-1.0 / (sr * (attack_ms / 1000.0)))
    release_coeff = np.exp(-1.0 / (sr * (release_ms / 1000.0)))

    envelope = np.zeros(audio.shape[:-1], dtype=np.float32)
    output = np.zeros_like(audio, dtype=np.float32)
    abs_audio = np.abs(audio)

    for i in range(audio.shape[-1]):
        x = abs_audio[..., i]
        envelope = np.where(
            x > envelope,
            attack_coeff * envelope + (1.0 - attack_coeff) * x,
            release_coeff * envelope + (1.0 - release_coeff) * x,
        )

        active = (envelope > threshold_lin) & (envelope > 1e-6)
        safe_envelope = np.maximum(envelope, 1e-6)
        envelope_db = 20.0 * np.log10(safe_envelope)
        gr_db = (threshold_db - envelope_db) * (1.0 - 1.0 / ratio)
        gain_reduction = np.where(active, 10 ** (gr_db / 20.0), 1.0)

        output[..., i] = audio[..., i] * gain_reduction

    return output.astype(np.float32)


def apply_delay(audio: np.ndarray, params: Dict[str, Any], sr: int = 44100) -> np.ndarray:
    delay_time = float(params.get("delay_time", 0.25))
    feedback = float(params.get("feedback", 0.4))
    mix = float(params.get("mix", 0.3))

    if audio.shape[-1] == 0 or mix <= 0.0:
        return audio

    delay_samples = int(delay_time * sr)
    if delay_samples <= 0:
        return audio

    output = np.copy(audio)
    for i in range(delay_samples, audio.shape[-1]):
        delayed = output[..., i - delay_samples] * feedback
        output[..., i] += delayed

    dry_wet = (1.0 - mix) * audio + mix * output
    return dry_wet.astype(np.float32)


def apply_reverb(audio: np.ndarray, params: Dict[str, Any], sr: int = 44100) -> np.ndarray:
    room_size = float(params.get("room_size", 0.5))
    mix = float(params.get("mix", 0.3))

    if audio.shape[-1] == 0 or mix <= 0.0:
        return audio

    delays_ms = [29.7, 37.1, 41.1, 43.7]
    delays_samples = [int((d / 1000.0) * sr) for d in delays_ms]

    wet_signal = np.zeros_like(audio)
    fb = room_size * 0.7

    for d_samp in delays_samples:
        if d_samp >= audio.shape[-1]:
            continue
        temp = np.zeros_like(audio)
        for i in range(d_samp, audio.shape[-1]):
            temp[..., i] = audio[..., i - d_samp] + temp[..., i - d_samp] * fb
        wet_signal += temp

    wet_signal /= len(delays_samples)
    output = (1.0 - mix) * audio + mix * wet_signal
    return output.astype(np.float32)


def apply_filter(audio: np.ndarray, params: Dict[str, Any], sr: int = 44100) -> np.ndarray:
    mode = str(params.get("mode", "lowpass")).lower()
    cutoff = float(params.get("cutoff", 1000.0))

    if audio.shape[-1] == 0:
        return audio

    fft_vals = np.fft.rfft(audio, axis=-1)
    freqs = np.fft.rfftfreq(audio.shape[-1], d=1.0 / sr)

    if mode == "lowpass":
        mask = freqs <= cutoff
    elif mode == "highpass":
        mask = freqs >= cutoff
    else:
        mask = np.ones_like(freqs, dtype=bool)

    gain_curve = np.zeros_like(freqs, dtype=np.float32)
    gain_curve[mask] = 1.0

    filtered_fft = fft_vals * gain_curve
    filtered_audio = np.fft.irfft(filtered_fft, n=audio.shape[-1], axis=-1)
    return filtered_audio.astype(np.float32)


def apply_distortion(audio: np.ndarray, params: Dict[str, Any]) -> np.ndarray:
    drive = float(params.get("drive", 3.0))
    mix = float(params.get("mix", 0.5))

    if audio.shape[-1] == 0 or drive <= 1.0:
        return audio

    distorted = np.tanh(audio * drive)
    output = (1.0 - mix) * audio + mix * distorted
    return output.astype(np.float32)


def apply_chorus(audio: np.ndarray, params: Dict[str, Any], sr: int = 44100) -> np.ndarray:
    rate = float(params.get("rate", 1.5))
    depth = float(params.get("depth", 0.005))
    mix = float(params.get("mix", 0.4))

    if audio.shape[-1] == 0 or mix <= 0.0:
        return audio

    n_samples = audio.shape[-1]
    t = np.arange(n_samples) / float(sr)
    lfo = (np.sin(2 * np.pi * rate * t) + 1.0) * 0.5 * (depth * sr)

    wet = np.zeros_like(audio)
    base_delay = int(0.01 * sr)

    for i in range(n_samples):
        d = base_delay + int(lfo[i])
        if i >= d:
            wet[..., i] = audio[..., i - d]

    output = (1.0 - mix) * audio + mix * wet
    return output.astype(np.float32)


def apply_limiter(audio: np.ndarray, params: Dict[str, Any]) -> np.ndarray:
    threshold_db = float(params.get("threshold", -0.1))
    threshold_lin = 10 ** (threshold_db / 20.0)

    clipped = np.clip(audio, -threshold_lin, threshold_lin)
    return clipped.astype(np.float32)


FX_PROCESSORS = {
    "gain": apply_gain,
    "eq": apply_eq,
    "compressor": apply_compressor,
    "delay": apply_delay,
    "reverb": apply_reverb,
    "filter": apply_filter,
    "distortion": apply_distortion,
    "chorus": apply_chorus,
    "limiter": apply_limiter
}


def process_chain(audio_data: np.ndarray, chain_config: List[Dict[str, Any]], sample_rate: int = 44100) -> np.ndarray:
    """
    Executes a list of FX module configs sequentially on the given audio_data buffer.
    """
    if audio_data.shape[-1] == 0 or not chain_config:
        return audio_data

    # Processors allocate their outputs when they change audio. Starting with
    # an unconditional copy made even a disabled/unity chain traverse the full
    # buffer for no audible effect.
    buffer = np.asarray(audio_data, dtype=np.float32)

    for module in chain_config:
        if not module.get("enabled", True):
            continue

        mod_type = str(module.get("type", "")).lower()
        params = module.get("params", {})

        processor = FX_PROCESSORS.get(mod_type)
        if processor:
            try:
                if mod_type in ["eq", "compressor", "delay", "reverb", "filter", "chorus"]:
                    buffer = processor(buffer, params, sr=sample_rate)
                else:
                    buffer = processor(buffer, params)
            except Exception as e:
                import logging
                logging.getLogger("beat_generator.dsp").error(f"Error processing FX module {mod_type}: {e}")

    return buffer.astype(np.float32, copy=False)
