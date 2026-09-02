from __future__ import annotations
import hashlib
from pathlib import Path
from typing import List, Tuple, Optional, Union, Any, TYPE_CHECKING
import numpy as np
from core.base_object import BaseObject
from core.analyzers import BPMAnalyzer
from core.dsp import stretch_audio, load_sample, process_sample_transform
from core.runtime_trace import get_runtime_cache, set_runtime_cache, trace_runtime

if TYPE_CHECKING:
    from core.system import System


class AudioObject(BaseObject):
    """
    Composite AudioObject node representing a sample (leaf) or a composite graph node
    (track, pattern, or master mix).
    """

    def __init__(
        self,
        name: str = "AudioObject",
        audio_data: Optional[np.ndarray] = None,
        length_in_beats: float = 0.0,
        groove_amount: float = 0.0,
        volume: float = 1.0,
        pan: float = 0.0,
        mix_mode: str = "sum",
        original_bpm: Optional[float] = None,
        filepath: Optional[Union[str, Path]] = None,
        chain: Optional[List[Dict[str, Any]]] = None,
        data: Optional[Any] = None,
        crop_start: float = 0.0,
        crop_end: float = 1.0,
        sample_type: str = "loop",
        total_bars: Optional[float] = None,
        transpose: float = 0.0,
        cents: float = 0.0,
        stretch_mode: str = "time_stretch",
        stretch_factor: float = 1.0,
        stretch_algorithm: str = "rubberband"
    ) -> None:
        super().__init__(name=name, data=data)
        self.audio_data = audio_data if audio_data is not None else None
        self.length_in_beats = float(length_in_beats)
        self.groove_amount = float(groove_amount)
        self._volume = float(volume)
        self._pan = float(pan)
        self.mix_mode = mix_mode
        self.filepath = str(filepath) if filepath is not None else None
        self._original_bpm = float(original_bpm) if original_bpm is not None else None
        self.chain: List[Dict[str, Any]] = chain if chain is not None else []
        self.is_dynamic = False
        self.crop_start: float = max(0.0, min(1.0, float(crop_start)))
        self.crop_end: float = max(0.0, min(1.0, float(crop_end)))
        self.sample_type: str = str(sample_type)
        self.total_bars: Optional[float] = (
            max(0.0, float(total_bars)) if total_bars is not None else None
        )
        self.transpose: float = float(transpose or 0.0)
        self.cents: float = float(cents or 0.0)
        self.stretch_mode: str = str(stretch_mode or "time_stretch")
        self.stretch_factor: float = float(stretch_factor or 1.0)
        self.stretch_algorithm: str = str(stretch_algorithm or "rubberband")

        # Children stored as list of (start_beat: float, child_object: AudioObject) tuples
        self.children: List[Tuple[float, AudioObject]] = []

    def apply_chain(self, buffer: np.ndarray, system: Optional[System] = None) -> np.ndarray:
        if buffer.shape[-1] == 0:
            return buffer
        sr = system.sample_rate if system is not None else 44100
        if self.chain:
            from core.fx import process_chain
            buffer = process_chain(buffer, self.chain, sample_rate=sr)
        if self.volume == 1.0:
            return buffer.astype(np.float32, copy=False)
        return (buffer * self.volume).astype(np.float32, copy=False)

        # Calculate original_bpm if not explicitly provided
        if self._original_bpm is None:
            self.detect_and_set_bpm()

    @property
    def original_bpm(self) -> Optional[float]:
        return self._original_bpm

    @original_bpm.setter
    def original_bpm(self, value: Optional[float]) -> None:
        self._original_bpm = float(value) if value is not None else None

    @property
    def volume(self) -> float:
        return self._volume

    @volume.setter
    def volume(self, value: float) -> None:
        self._volume = float(value)

    @property
    def pan(self) -> float:
        return self._pan

    @pan.setter
    def pan(self, value: float) -> None:
        self._pan = float(value)

    def detect_and_set_bpm(self, sample_rate: int = 44100) -> Optional[float]:
        """
        Attempts to calculate original_bpm:
        1. First try BPMAnalyzer.from_filename(filepath).
        2. If None, get duration from audio_data and use BPMAnalyzer.from_duration(duration_seconds).
        """
        if self.filepath:
            bpm = BPMAnalyzer.from_filename(self.filepath)
            if bpm is not None:
                self._original_bpm = bpm
                return bpm

        if self.audio_data is not None and self.audio_data.shape[-1] > 0:
            duration_seconds = float(self.audio_data.shape[-1]) / float(sample_rate)
            bpm = BPMAnalyzer.from_duration(duration_seconds)
            self._original_bpm = bpm
            return bpm

        return None

    def add_child(self, child: AudioObject, start_beat: float) -> None:
        """
        Adds a child AudioObject node to the graph at a specified start_beat offset.
        """
        self.children.append((float(start_beat), child))

    def render(self, system: Optional[System] = None, **kwargs: Any) -> np.ndarray:
        """
        Recursive DSP render method:
        - If self.audio_data exists (leaf/sample), returns audio array scaled by volume
          (time-stretched if original_bpm != system.bpm).
        - If children exist, recursively renders each child, pads with leading zeros based on start_beat,
          and SUMs them into a parent master numpy array.
        """
        # Leaf node case: Raw sample data exists and no children
        if self.audio_data is not None and len(self.children) == 0:
            sr = system.sample_rate if system is not None else 44100
            if self._original_bpm is None:
                self.detect_and_set_bpm(sample_rate=sr)

            target_bpm = system.bpm if system is not None else 120.0
            data_to_render = process_sample_transform(
                audio_data=self.audio_data,
                sr=sr,
                original_bpm=self._original_bpm,
                target_bpm=target_bpm,
                transpose=self.transpose,
                cents=self.cents,
                stretch_mode=self.stretch_mode,
                stretch_factor=self.stretch_factor,
                stretch_algorithm=self.stretch_algorithm,
                sample_type=self.sample_type,
                fast_preview=system is not None and system.render_mode == "preview",
            )

            return self.apply_chain(data_to_render, system)

        if system is None:
            raise ValueError("System instance must be provided to render a composite AudioObject graph.")

        # Render all child nodes recursively and record (start_sample, child_rendered_array)
        rendered_children: List[Tuple[int, np.ndarray]] = []
        max_end_sample = 0

        for start_beat, child in self.children:
            child_audio = child.render(system, **kwargs)
            start_sample = system.beat_to_samples(start_beat)
            end_sample = start_sample + child_audio.shape[-1]

            if end_sample > max_end_sample:
                max_end_sample = end_sample

            rendered_children.append((start_sample, child_audio))

        # If base audio_data exists on composite node, include its length in max_end_sample
        if self.audio_data is not None:
            max_end_sample = max(max_end_sample, self.audio_data.shape[-1])

        timeline_samples = (
            system.beat_to_samples(self.total_bars * 4.0)
            if self.total_bars is not None and self.total_bars > 0
            else None
        )

        if max_end_sample == 0 and timeline_samples is None:
            return np.zeros(0, dtype=np.float32)

        source_buffers = [child_arr for _, child_arr in rendered_children]
        if self.audio_data is not None:
            source_buffers.append(self.audio_data)
        channel_shape = (
            np.broadcast_shapes(*(buffer.shape[:-1] for buffer in source_buffers))
            if source_buffers
            else ()
        )

        # Instantiate parent master numpy array based on mix_mode
        if self.mix_mode == "chained":
            # Chained mode: sequence all child arrays horizontally ignoring start_beat
            if len(rendered_children) > 0:
                master_buffer = np.concatenate([
                    np.broadcast_to(child_arr, (*channel_shape, child_arr.shape[-1]))
                    for _, child_arr in rendered_children
                ], axis=-1)
            else:
                master_buffer = np.zeros((*channel_shape, 0), dtype=np.float32)

            if self.audio_data is not None:
                # Prepend the composite's own data to the chain
                own_audio = np.broadcast_to(
                    self.audio_data,
                    (*channel_shape, self.audio_data.shape[-1]),
                )
                master_buffer = np.concatenate([own_audio, master_buffer], axis=-1)

        else:
            # Sum mode (default): layer child arrays vertically at their start_beat offsets
            master_buffer = np.zeros((*channel_shape, max_end_sample), dtype=np.float32)

            # If composite node has its own base audio_data, add it
            if self.audio_data is not None:
                own_samples = self.audio_data.shape[-1]
                master_buffer[..., :own_samples] += self.audio_data

            # SUM child audio arrays into parent buffer at their start_sample offsets
            for start_sample, child_audio in rendered_children:
                end_sample = start_sample + child_audio.shape[-1]
                master_buffer[..., start_sample:end_sample] += child_audio

        # A track with an explicit musical length is the timeline authority. Pad
        # short children and clip long children so every consumer sees exactly
        # the same duration.
        if timeline_samples is not None:
            fitted_buffer = np.zeros((*master_buffer.shape[:-1], timeline_samples), dtype=np.float32)
            copy_samples = min(timeline_samples, master_buffer.shape[-1])
            if copy_samples > 0:
                fitted_buffer[..., :copy_samples] = master_buffer[..., :copy_samples]
            master_buffer = fitted_buffer

        # Apply parent node volume scaling
        return self.apply_chain(master_buffer, system)


class SampleObject(AudioObject):
    """
    Leaf node that strictly loads a specific audio file and renders it.
    Does not process timeline children.
    """
    def __init__(
        self,
        name: str = "SampleObject",
        filepath: Optional[Union[str, Path]] = None,
        volume: float = 1.0,
        pan: float = 0.0,
        original_bpm: Optional[float] = None,
        chain: Optional[List[Dict[str, Any]]] = None,
        data: Optional[Any] = None,
        crop_start: float = 0.0,
        crop_end: float = 1.0,
        sample_type: str = "loop",
        transpose: float = 0.0,
        cents: float = 0.0,
        stretch_mode: str = "time_stretch",
        stretch_factor: float = 1.0,
        stretch_algorithm: str = "rubberband"
    ) -> None:
        super().__init__(
            name=name,
            filepath=filepath,
            volume=volume,
            pan=pan,
            original_bpm=original_bpm,
            chain=chain,
            data=data,
            crop_start=crop_start,
            crop_end=crop_end,
            sample_type=sample_type,
            transpose=transpose,
            cents=cents,
            stretch_mode=stretch_mode,
            stretch_factor=stretch_factor,
            stretch_algorithm=stretch_algorithm
        )

    def render(self, system: Optional[System] = None, **kwargs: Any) -> np.ndarray:
        if not self.filepath:
            return np.zeros(0, dtype=np.float32)

        sr = system.sample_rate if system is not None else 44100
        try:
            audio_array, _ = load_sample(self.filepath, target_sr=sr)
        except Exception as e:
            import logging
            logging.getLogger("beat_generator.core").warning(f"Failed to load sample '{self.filepath}': {e}")
            return np.zeros(0, dtype=np.float32)

        if audio_array.shape[-1] == 0:
            return np.zeros(0, dtype=np.float32)

        # Apply crop range
        if self.crop_start > 0.0 or self.crop_end < 1.0:
            total_samples = audio_array.shape[-1]
            s_idx = int(max(0.0, min(1.0, self.crop_start)) * total_samples)
            e_idx = int(max(0.0, min(1.0, self.crop_end)) * total_samples)
            if s_idx < e_idx:
                audio_array = audio_array[..., s_idx:e_idx]
            else:
                audio_array = np.zeros((*audio_array.shape[:-1], 0), dtype=np.float32)

        if audio_array.shape[-1] == 0:
            return np.zeros(0, dtype=np.float32)

        if self._original_bpm is None:
            self.detect_and_set_bpm(sample_rate=sr)

        target_bpm = system.bpm if system is not None else 120.0
        try:
            data_to_render = process_sample_transform(
                audio_data=audio_array,
                sr=sr,
                original_bpm=self._original_bpm,
                target_bpm=target_bpm,
                transpose=self.transpose,
                cents=self.cents,
                stretch_mode=self.stretch_mode,
                stretch_factor=self.stretch_factor,
                stretch_algorithm=self.stretch_algorithm,
                sample_type=self.sample_type,
                fast_preview=system is not None and system.render_mode == "preview",
            )
        except Exception as e:
            import logging
            logging.getLogger("beat_generator.core").error(f"Error transforming sample '{self.filepath}': {e}")
            return np.zeros(0, dtype=np.float32)

        return self.apply_chain(data_to_render, system)


class SequenceObject(AudioObject):
    """
    Rhythmic step sequencer node that takes a single child audio object (sample)
    and outputs a rhythmically sequenced audio array based on an internal step array.
    """
    def __init__(
        self,
        name: str = "SequenceObject",
        sequence: Optional[List[int]] = None,
        step_parameters: Optional[List[Dict[str, Any]]] = None,
        step_length: float = 0.25,
        play_mode: str = "gate",
        fade_ms: float = 0.0,
        seed: Optional[Union[float, int]] = None,
        seed_mode: str = "moving",
        volume: float = 1.0,
        pan: float = 0.0,
        original_bpm: Optional[float] = None,
        filepath: Optional[Union[str, Path]] = None,
        chain: Optional[List[Dict[str, Any]]] = None,
        data: Optional[Any] = None,
        sample_type: str = "loop",
        crop_start: float = 0.0,
        crop_end: float = 1.0,
        transpose: float = 0.0,
        cents: float = 0.0,
        stretch_mode: str = "time_stretch",
        stretch_factor: float = 1.0,
        stretch_algorithm: str = "rubberband"
    ) -> None:
        super().__init__(
            name=name,
            filepath=filepath,
            volume=volume,
            pan=pan,
            original_bpm=original_bpm,
            chain=chain,
            data=data,
            sample_type=sample_type,
            crop_start=crop_start,
            crop_end=crop_end,
            transpose=transpose,
            cents=cents,
            stretch_mode=stretch_mode,
            stretch_factor=stretch_factor,
            stretch_algorithm=stretch_algorithm
        )
        self.sequence: List[int] = sequence if sequence is not None else [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]
        self.step_length: float = float(step_length)
        self.step_parameters: List[Dict[str, Any]] = step_parameters or []
        self.play_mode: str = str(play_mode).lower() if play_mode else "gate"
        try:
            parsed_fade_ms = float(fade_ms)
        except (TypeError, ValueError):
            parsed_fade_ms = 0.0
        self.fade_ms: float = max(0.0, min(5.0, parsed_fade_ms if np.isfinite(parsed_fade_ms) else 0.0))
        self.seed: Union[float, int] = seed if seed is not None else 42
        self.seed_mode: str = str(seed_mode).lower() if seed_mode else "moving"
        self.is_dynamic: bool = (self.seed_mode == "moving")

    def _apply_step_fade(self, audio: np.ndarray, sample_rate: int) -> np.ndarray:
        """Apply symmetrical linear edge fades to one rendered step trigger."""
        fade_samples = int(round(sample_rate * self.fade_ms / 1000.0))
        sample_count = audio.shape[-1]
        if fade_samples <= 0 or sample_count == 0:
            return audio

        positions = np.arange(sample_count, dtype=np.float32)
        envelope = np.minimum(positions, positions[::-1]) / float(fade_samples)
        envelope = np.minimum(envelope, 1.0).astype(np.float32, copy=False)
        return audio * envelope

    def _step_parameters(self, index: int) -> Dict[str, Any]:
        """Return a sanitized step configuration, including legacy defaults."""
        raw = self.step_parameters[index] if index < len(self.step_parameters) else {}
        if hasattr(raw, "model_dump"):
            raw = raw.model_dump()
        elif not isinstance(raw, dict):
            raw = {}

        def _safe_float(val: Any, default: float) -> float:
            if val is None:
                return default
            try:
                f = float(val)
                return f if np.isfinite(f) else default
            except (ValueError, TypeError):
                return default

        def _safe_int(val: Any, default: int) -> int:
            if val is None:
                return default
            try:
                return int(val)
            except (ValueError, TypeError):
                return default

        raw_enabled = raw.get("subdivision_enabled")
        raw_subs = raw.get("subdivisions")

        subdivisions = max(1, min(16, _safe_int(raw_subs, 1)))

        if subdivisions > 1:
            enabled = True
        elif raw_enabled is not None and bool(raw_enabled):
            enabled = True
            subdivisions = max(2, subdivisions)
        else:
            enabled = False
            subdivisions = 1

        return {
            "offset": max(-1.0, min(1.0, _safe_float(raw.get("offset"), 0.0))),
            "velocity": max(0.0, min(1.0, _safe_float(raw.get("velocity"), 1.0))),
            "probability": max(0.0, min(100.0, _safe_float(raw.get("probability"), 100.0))),
            "subdivision_enabled": subdivisions > 1,
            "subdivisions": subdivisions,
        }

    def render(self, system: Optional[System] = None, iteration: int = 0, **kwargs: Any) -> np.ndarray:
        if system is None:
            raise ValueError("System instance must be provided to render a SequenceObject.")

        if not self.children:
            return np.zeros(0, dtype=np.float32)

        # Render the first child (the sample)
        _, first_child = self.children[0]
        is_dynamic = getattr(first_child, "is_dynamic", False)

        cached_child_audio = None
        if not is_dynamic:
            cached_child_audio = first_child.render(system, **kwargs)
            if cached_child_audio.shape[-1] == 0 or len(self.sequence) == 0:
                return np.zeros(0, dtype=np.float32)

        if len(self.sequence) == 0:
            return np.zeros(0, dtype=np.float32)

        # Calculate total pattern duration in beats & samples
        pattern_duration_beats = len(self.sequence) * self.step_length
        pattern_samples = system.beat_to_samples(pattern_duration_beats)

        rendered_steps = []
        max_end_sample = pattern_samples

        if self.seed_mode == "moving":
            seed_str = f"{self.seed}_{iteration}"
        else:
            seed_str = str(self.seed)
        eff_seed = int(hashlib.md5(seed_str.encode()).hexdigest(), 16) & 0xFFFFFFFF
        rng = np.random.default_rng(eff_seed)
        for step_idx, step_val in enumerate(self.sequence):
            if step_val == 1:
                params = self._step_parameters(step_idx)
                if rng.random() * 100.0 >= params["probability"]:
                    continue

                repeats = params["subdivisions"]
                base_beat = (step_idx + params["offset"]) * self.step_length
                # Quantize once at the parent step boundaries, then partition that
                # exact integer sample range. Converting every fractional beat and
                # slot independently can round them differently and drift triggers
                # away from equal positions inside the step.
                step_start_sample = system.beat_to_samples(base_beat)
                step_end_sample = system.beat_to_samples(base_beat + self.step_length)
                step_samples = max(repeats, step_end_sample - step_start_sample)
                subdivision_boundaries = [
                    step_start_sample + round(step_samples * idx / repeats)
                    for idx in range(repeats + 1)
                ]
                for subdivision_idx in range(repeats):
                    start_sample = subdivision_boundaries[subdivision_idx]
                    slot_end_sample = subdivision_boundaries[subdivision_idx + 1]
                    slot_samples = max(1, slot_end_sample - start_sample)
                    audio = first_child.render(system, **kwargs) if is_dynamic else cached_child_audio
                    audio = audio * params["velocity"]

                    if start_sample < 0:
                        skipped_samples = -start_sample
                        audio = audio[..., skipped_samples:]
                        start_sample = 0

                    if self.play_mode == "gate":
                        audio = audio[..., :slot_samples]

                    if audio.shape[-1] == 0:
                        continue

                    rendered_steps.append((start_sample, audio))

        # Monophonic voice cutting: a subsequent trigger truncates any playing sample tail
        voice_cut_steps = []
        for i in range(len(rendered_steps)):
            start_i, audio_i = rendered_steps[i]

            next_start = None
            for j in range(i + 1, len(rendered_steps)):
                s_j, _ = rendered_steps[j]
                if s_j > start_i:
                    next_start = s_j
                    break
                elif s_j == start_i:
                    next_start = start_i
                    break

            if next_start is not None:
                max_len = max(0, next_start - start_i)
                audio_i = audio_i[..., :max_len]

            if audio_i.shape[-1] > 0:
                audio_i = self._apply_step_fade(audio_i, system.sample_rate)
                voice_cut_steps.append((start_i, audio_i))
                end_sample = start_i + audio_i.shape[-1]
                if end_sample > max_end_sample:
                    max_end_sample = end_sample

        channel_sources = [audio for _, audio in voice_cut_steps]
        if cached_child_audio is not None:
            channel_sources.append(cached_child_audio)
        channel_shape = (
            np.broadcast_shapes(*(audio.shape[:-1] for audio in channel_sources))
            if channel_sources
            else ()
        )
        master_buffer = np.zeros((*channel_shape, max_end_sample), dtype=np.float32)

        for start_sample, audio in voice_cut_steps:
            end_sample = start_sample + audio.shape[-1]
            master_buffer[..., start_sample:end_sample] += audio

        return self.apply_chain(master_buffer, system)


import random
import os

class ItemPoolObject(AudioObject):
    def __init__(
        self,
        name: str = "ItemPoolObject",
        selected_items: Optional[List[Dict[str, Any]]] = None,
        playback_mode: str = "Random",
        seed: Optional[float] = None,
        refresh_mode: str = "manual",
        volume: float = 1.0,
        pan: float = 0.0,
        original_bpm: Optional[float] = None,
        chain: Optional[List[Dict[str, Any]]] = None,
        data: Optional[Any] = None,
        sample_type: str = "loop",
        crop_start: float = 0.0,
        crop_end: float = 1.0,
        transpose: float = 0.0,
        cents: float = 0.0,
        stretch_mode: str = "time_stretch",
        stretch_factor: float = 1.0,
        stretch_algorithm: str = "rubberband"
    ) -> None:
        super().__init__(
            name=name,
            volume=volume,
            pan=pan,
            original_bpm=original_bpm,
            chain=chain,
            data=data,
            sample_type=sample_type,
            crop_start=crop_start,
            crop_end=crop_end,
            transpose=transpose,
            cents=cents,
            stretch_mode=stretch_mode,
            stretch_factor=stretch_factor,
            stretch_algorithm=stretch_algorithm
        )
        self.selected_items = selected_items or []
        self.playback_mode = playback_mode or "Random"
        self.seed = seed if seed is not None else random.random()
        self.refresh_mode = str(refresh_mode or "off").strip().casefold()
        self.is_dynamic = self.refresh_mode in {"local", "local_refresh", "self_render"}
        self.current_pool = []
        self.last_played_index = -1
        self._render_count = 0
        self.updatePool()
        
    def updatePool(self):
        """Build the runtime pool from the explicit, already-resolved keys.

        Library filtering happens before an item is added in the SIN library
        panel. This layer must only choose among those exact references.
        """
        self.current_pool = []
        for index, item in enumerate(self.selected_items):
            if not isinstance(item, dict):
                raise ValueError(f"Asset Pool item {index} is not an asset reference")
            if item.get("id") is None:
                raise ValueError(f"Asset Pool item {index} is missing its GAIA id")
            filepath = item.get("absolute_path") or item.get("filepath") or item.get("path")
            if not filepath:
                raise ValueError(f"Asset Pool item {index} has no resolved asset path")
            self.current_pool.append({
                **item,
                "absolute_path": filepath,
                "type": item.get("type", "asset"),
                "bpm": item.get("bpm") or item.get("original_bpm"),
            })

    def getNextSample(self, advance: bool = False) -> Optional[str]:
        if not self.current_pool:
            return None
            
        pool_size = len(self.current_pool)
        if pool_size == 1:
            self.last_played_index = 0
            if advance:
                self._render_count += 1
            return self.current_pool[0]["absolute_path"]
            
        if str(self.playback_mode).strip().casefold() == "sequential":
            next_idx = (int(self.seed or 0) + self._render_count) % pool_size
            self.last_played_index = next_idx
            if advance:
                self._render_count += 1
            return self.current_pool[next_idx]["absolute_path"]

        import hashlib
        request_seed = str(self.seed) if self._render_count == 0 else f"{self.seed}_{self._render_count}"
        seed_hash = int(hashlib.md5(request_seed.encode()).hexdigest(), 16)
        next_idx = seed_hash % pool_size
        if advance and next_idx == self.last_played_index:
            next_idx = (next_idx + 1) % pool_size
                
        self.last_played_index = next_idx
        if advance:
            self._render_count += 1
        return self.current_pool[next_idx]["absolute_path"]
        
    def render(self, system: Optional[System] = None, **kwargs: Any) -> np.ndarray:
        filepath = self.getNextSample(advance=True)
        if not filepath:
            return np.zeros(0, dtype=np.float32)
            
        sr = system.sample_rate if system is not None else 44100
        
        if not os.path.exists(filepath):
            alt_path = os.path.join("assets", filepath)
            if os.path.exists(alt_path):
                filepath = alt_path
            else:
                raise FileNotFoundError(f"Asset Pool asset is unavailable: {filepath}")
        
        try:
            audio_array, _ = load_sample(filepath, target_sr=sr)
        except Exception as e:
            import logging
            logging.getLogger("beat_generator.core").error(f"Failed to load sample {filepath}: {e}")
            return np.zeros(0, dtype=np.float32)
        
        chosen_item = self.current_pool[self.last_played_index] if 0 <= self.last_played_index < len(self.current_pool) else None
        item_bpm = chosen_item.get("bpm") if chosen_item else None
        if item_bpm is None:
            item_bpm = BPMAnalyzer.from_filename(filepath)
            if item_bpm is None and audio_array.shape[-1] > 0:
                item_bpm = BPMAnalyzer.from_duration(float(audio_array.shape[-1]) / sr)
        
        original_bpm = item_bpm if item_bpm is not None else self._original_bpm
                
        if self.crop_start > 0.0 or self.crop_end < 1.0:
            total_samples = audio_array.shape[-1]
            start = int(max(0.0, min(1.0, self.crop_start)) * total_samples)
            end = int(max(0.0, min(1.0, self.crop_end)) * total_samples)
            audio_array = audio_array[..., start:end] if start < end else np.zeros(
                (*audio_array.shape[:-1], 0), dtype=np.float32
            )

        if audio_array.shape[-1] == 0:
            return np.zeros(0, dtype=np.float32)

        target_bpm = system.bpm if system is not None else 120.0
        # A dynamic pool can revisit the same asset many times during one
        # arrangement/sequence render. Decoding was cached per request, but the
        # expensive Rubber Band transform was repeated for every occurrence.
        transform_cache_key = (
            "pool_transform",
            os.path.normcase(os.path.abspath(filepath)),
            int(sr),
            float(original_bpm) if original_bpm is not None else None,
            float(target_bpm),
            float(self.crop_start),
            float(self.crop_end),
            float(self.transpose),
            float(self.cents),
            str(self.stretch_mode),
            float(self.stretch_factor),
            str(self.stretch_algorithm),
            str(self.sample_type),
            str(system.render_mode) if system is not None else "offline",
        )
        data_to_render = get_runtime_cache(transform_cache_key)
        if data_to_render is None:
            data_to_render = process_sample_transform(
                audio_data=audio_array,
                sr=sr,
                original_bpm=original_bpm,
                target_bpm=target_bpm,
                transpose=self.transpose,
                cents=self.cents,
                stretch_mode=self.stretch_mode,
                stretch_factor=self.stretch_factor,
                stretch_algorithm=self.stretch_algorithm,
                sample_type=self.sample_type,
                fast_preview=system is not None and system.render_mode == "preview",
            )
            set_runtime_cache(transform_cache_key, data_to_render)
        else:
            trace_marker = ("pool_transform_hit_logged", transform_cache_key)
            if get_runtime_cache(trace_marker) is None:
                trace_runtime(f"DSP transform cache hit: {os.path.basename(filepath)}")
                set_runtime_cache(trace_marker, True)
            
        return self.apply_chain(data_to_render, system)

# Backward-compatible import for saved projects and external integrations.
SamplePoolObject = ItemPoolObject

class ArrangementObject(AudioObject):
    """
    Arrangement node that takes one or more child audio objects (loops) with a predefined length
    and repeats them to fill a user defined time length (`total_bars`).
    Each section owns its playback probability, source offset, quantization and anchor.
    If multiple children are provided, one is picked at random for each active iteration.
    """
    def __init__(
        self,
        name: str = "ArrangementObject",
        total_bars: float = 4.0,
        probability: float = 1.0,
        seed: Optional[float] = None,
        volume: float = 1.0,
        pan: float = 0.0,
        original_bpm: Optional[float] = None,
        chain: Optional[List[Dict[str, Any]]] = None,
        data: Optional[Any] = None,
        sample_type: str = "loop",
        section_points: Optional[List[float]] = None,
        section_enabled: Optional[List[bool]] = None,
        section_probability: Optional[List[float]] = None,
        section_sample_start: Optional[List[float]] = None,
        section_quant: Optional[List[str]] = None,
        section_quant_anchor: Optional[List[str]] = None,
        quant: Optional[Union[str, float]] = "none",
        quant_anchor: str = "start"
    ) -> None:
        super().__init__(
            name=name,
            volume=volume,
            pan=pan,
            original_bpm=original_bpm,
            chain=chain,
            data=data,
            sample_type=sample_type
        )
        self.total_bars = float(total_bars)
        self.seed = seed if seed is not None else random.random()
        self.section_points = sorted({
            float(point) for point in (section_points or [])
            if 0.0 < float(point) < self.total_bars
        })
        num_sections = len(self.section_points) + 1
        raw_section_enabled = section_enabled or []
        # Retired arrangement controls are accepted only at this boundary so
        # old work remains audible. They are folded into local arrays: a legacy
        # disabled section becomes a zero-probability section.
        try:
            legacy_probability = max(0.0, min(1.0, float(probability)))
        except (TypeError, ValueError):
            legacy_probability = 1.0
        legacy_quant = "none" if quant is None else str(quant).lower()
        if legacy_quant in ("", "global", "inherit"):
            legacy_quant = "none"
        legacy_anchor = "end" if quant_anchor == "end" else "start"

        raw_probability = list(section_probability) if section_probability is not None else []
        raw_sample_start = list(section_sample_start) if section_sample_start is not None else []
        raw_quant = list(section_quant) if section_quant is not None else []
        raw_anchor = list(section_quant_anchor) if section_quant_anchor is not None else []
        self.section_probability = [
            0.0 if index < len(raw_section_enabled) and raw_section_enabled[index] is False else
            self._valid_probability(raw_probability[index], legacy_probability)
            if index < len(raw_probability) else legacy_probability
            for index in range(num_sections)
        ]
        self.section_sample_start = [
            self._valid_sample_start(raw_sample_start[index]) if index < len(raw_sample_start) else 0.0
            for index in range(num_sections)
        ]
        self.section_quant = [
            self._valid_quant(raw_quant[index], legacy_quant) if index < len(raw_quant) else legacy_quant
            for index in range(num_sections)
        ]
        self.section_quant_anchor = [
            "end" if index < len(raw_anchor) and raw_anchor[index] == "end" else
            "start" if index < len(raw_anchor) and raw_anchor[index] == "start" else
            legacy_anchor
            for index in range(num_sections)
        ]

    @staticmethod
    def _valid_probability(value: Any, fallback: float) -> float:
        try:
            return max(0.0, min(1.0, float(value)))
        except (TypeError, ValueError):
            return fallback

    @staticmethod
    def _valid_sample_start(value: Any) -> float:
        try:
            return max(0.0, min(1.0, float(value)))
        except (TypeError, ValueError):
            return 0.0

    @staticmethod
    def _valid_quant(value: Any, fallback: str) -> str:
        normalized = str(value or "").lower()
        return fallback if normalized in ("", "global", "inherit") else normalized

    def get_section_boundaries(self) -> List[float]:
        """Return validated section boundaries including the timeline edges."""
        points = [
            point for point in self.section_points
            if 0.0 < point < self.total_bars
        ]
        return [0.0, *sorted(set(points)), self.total_bars]

    def get_section_probability(self, section_index: int) -> float:
        if 0 <= section_index < len(self.section_probability):
            return self._valid_probability(self.section_probability[section_index], 1.0)
        return 1.0

    def get_section_quant(self, section_index: int) -> str:
        if 0 <= section_index < len(self.section_quant):
            return self._valid_quant(self.section_quant[section_index], "none")
        return "none"

    def get_section_sample_start(self, section_index: int) -> float:
        """Return the section's normalized source offset, clamped to 0..1."""
        if 0 <= section_index < len(self.section_sample_start):
            return self._valid_sample_start(self.section_sample_start[section_index])
        return 0.0

    def get_section_quant_anchor(self, section_index: int) -> str:
        if 0 <= section_index < len(self.section_quant_anchor):
            val = self.section_quant_anchor[section_index]
            if val in ("start", "end"):
                return str(val)
        return "start"

    def get_section_quant_samples(self, section_index: int, child: AudioObject, audio: np.ndarray, system: System) -> Optional[int]:
        s_quant = self.get_section_quant(section_index)
        if s_quant in ("", "none", "off"):
            return None
        if s_quant == "auto":
            return self.get_child_loop_samples(child, audio, system)
        if s_quant == "bar":
            s_quant = "1.0"
        elif s_quant == "beat":
            s_quant = "0.25"
        try:
            quant_bars = float(s_quant)
        except (TypeError, ValueError):
            return None
        if quant_bars <= 0:
            return None
        return system.beat_to_samples(quant_bars * 4.0)

    def get_quant_samples(self, child: AudioObject, audio: np.ndarray, system: System) -> Optional[int]:
        """Compatibility helper for callers without a section index."""
        return self.get_section_quant_samples(-1, child, audio, system)

    def get_child_loop_samples(self, child: AudioObject, audio: np.ndarray, system: System) -> int:
        if hasattr(child, "sequence") and getattr(child, "sequence") is not None and hasattr(child, "step_length"):
            seq = getattr(child, "sequence") or []
            step_len = getattr(child, "step_length", 0.25) or 0.25
            beats = len(seq) * step_len
            if beats > 0:
                return system.beat_to_samples(beats)

        child_total_bars = getattr(child, "total_bars", None)
        if child_total_bars is not None and child_total_bars > 0:
            return system.beat_to_samples(child_total_bars * 4.0)

        child_beats = getattr(child, "length_in_beats", None)
        if child_beats is not None and child_beats > 0:
            return system.beat_to_samples(child_beats)

        if audio.shape[-1] > 0:
            samples_per_beat = system.beat_to_samples(1.0)
            if samples_per_beat > 0:
                beats = audio.shape[-1] / float(samples_per_beat)
                nearest_beat = round(beats)
                if abs(beats - nearest_beat) < 0.15 and nearest_beat > 0:
                    return system.beat_to_samples(float(nearest_beat))
            return audio.shape[-1]

        return system.beat_to_samples(4.0)

    def render(self, system: Optional[System] = None, **kwargs: Any) -> np.ndarray:
        if system is None:
            raise ValueError("System instance must be provided to render.")
            
        if self.total_bars <= 0:
            return np.zeros(0, dtype=np.float32)

        total_samples_to_fill = system.beat_to_samples(self.total_bars * 4.0)
        if not self.children:
            return np.zeros(total_samples_to_fill, dtype=np.float32)

        import hashlib
        import random
        
        # Pre-render or identify dynamic children
        cached_audios = []
        for _, child in self.children:
            if getattr(child, "is_dynamic", False):
                cached_audios.append(None)
            else:
                audio = child.render(system, **kwargs)
                cached_audios.append(audio)

        observed_channel_shapes = [
            audio.shape[:-1]
            for audio in cached_audios
            if audio is not None
        ]
        rendered_events: List[Tuple[int, np.ndarray]] = []
        
        # Use a reproducible random generator based on the seed
        seed_hash = int(hashlib.md5(str(self.seed).encode()).hexdigest(), 16)
        rng = random.Random(seed_hash)
        
        iteration_count = 0
        boundaries = self.get_section_boundaries()
        for section_index in range(len(boundaries) - 1):
            section_start = system.beat_to_samples(boundaries[section_index] * 4.0)
            section_end = system.beat_to_samples(boundaries[section_index + 1] * 4.0)
            cell_start = section_start

            sec_prob = self.get_section_probability(section_index)
            sec_sample_start = self.get_section_sample_start(section_index)
            sec_anchor = self.get_section_quant_anchor(section_index)

            while cell_start < section_end:
                child_idx = rng.randint(0, len(self.children) - 1)
                audio = cached_audios[child_idx]
                _, child = self.children[child_idx]

                if audio is None:
                    audio = child.render(system, iteration=iteration_count, **kwargs)
                    observed_channel_shapes.append(audio.shape[:-1])
                iteration_count += 1
                if audio.shape[-1] == 0:
                    break

                quant_samples = self.get_section_quant_samples(section_index, child, audio, system)
                sample_count = audio.shape[-1]
                sample_offset = min(sample_count, int(sample_count * sec_sample_start))
                playable_audio = audio[..., sample_offset:]
                if playable_audio.shape[-1] == 0:
                    if quant_samples is None:
                        break
                    cell_start += quant_samples
                    continue

                cell_end = section_end if quant_samples is None else min(section_end, cell_start + quant_samples)
                playable_samples = playable_audio.shape[-1]
                event_start = cell_start if sec_anchor == "start" else cell_end - playable_samples
                event_end = event_start + playable_samples

                # Gate every trigger to its quant cell. This keeps arrangement
                # playback monophonic: a long source cannot overlap the next
                # trigger, regardless of whether it is start- or end-anchored.
                write_start = max(section_start, cell_start, event_start)
                write_end = min(section_end, cell_end, event_end)
                if write_start < write_end and rng.random() < sec_prob:
                    source_start = write_start - event_start
                    source_end = source_start + (write_end - write_start)
                    rendered_events.append((
                        write_start,
                        playable_audio[..., source_start:source_end],
                    ))

                if quant_samples is None or quant_samples <= 0:
                    break
                cell_start += quant_samples

        channel_shape = (
            np.broadcast_shapes(*observed_channel_shapes)
            if observed_channel_shapes
            else ()
        )
        master_buffer = np.zeros((*channel_shape, total_samples_to_fill), dtype=np.float32)
        for write_start, event_audio in rendered_events:
            write_end = write_start + event_audio.shape[-1]
            master_buffer[..., write_start:write_end] += event_audio

        return self.apply_chain(master_buffer, system)
