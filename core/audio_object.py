from __future__ import annotations
import hashlib
import os
import random
from pathlib import Path
from typing import List, Tuple, Optional, Union, Any, Dict, TYPE_CHECKING
import numpy as np
from core.base_object import BaseObject
from core.analyzers import BPMAnalyzer
from core.dsp import stretch_audio, load_sample, process_sample_transform
from core.runtime_trace import get_runtime_cache, set_runtime_cache, trace_runtime
from core.dag_cache import GLOBAL_DAG_CACHE
from ermes.py.slot_language import (
    hash_seed,
    mulberry32,
    normalize_numeric_seed,
    resolve_cycle_seeds,
    resolve_step_slots,
    wrap_slot_index,
)

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
        stretch_algorithm: str = "rubberband",
        key_match_mode: str = "off",
        key_match_algorithm: str = "nearest",
        target_bpm: Optional[float] = None,
        node_id: Optional[int] = None,
        node_type: str = "track"
    ) -> None:
        super().__init__(name=name, data=data)
        self.node_id = int(node_id) if node_id is not None else None
        self.node_type = str(node_type or "track")
        self.target_bpm: Optional[float] = (
            float(target_bpm) if target_bpm is not None else None
        )
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
        self.key_match_mode: str = str(key_match_mode or "off").lower().strip()
        self.key_match_algorithm: str = str(key_match_algorithm or "nearest").lower().strip()

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
        if self.sample_type in ("one_shot", "oneshot"):
            return None

        if self.filepath:
            bpm = BPMAnalyzer.from_filename(self.filepath)
            if bpm is not None:
                self._original_bpm = bpm
                return bpm

        if self.audio_data is not None and self.audio_data.shape[-1] > 0:
            duration_seconds = float(self.audio_data.shape[-1]) / float(sample_rate)
            bpm = BPMAnalyzer.from_duration(duration_seconds)
            if bpm is not None:
                self._original_bpm = bpm
                return bpm

        return None

    def add_child(self, child: AudioObject, start_beat: float) -> None:
        """
        Adds a child AudioObject node to the graph at a specified start_beat offset.
        """
        self.children.append((float(start_beat), child))

    def _cache_context(self, system: Optional[System] = None, iteration: int = 0, **kwargs: Any) -> tuple:
        render_mode = str(system.render_mode).lower() if system is not None else "offline"
        sr = int(system.sample_rate) if system is not None else 44100
        bpm = round(float(system.bpm), 4) if system is not None else 120.0
        loop_flag = bool(kwargs.get("loop", True))
        parent_bars = round(float(kwargs["parent_total_bars"]), 4) if kwargs.get("parent_total_bars") is not None else None
        eff_iter = int(iteration) if getattr(self, "seed_mode", None) == "moving" else 0
        return (render_mode, sr, bpm, loop_flag, parent_bars, eff_iter)

    def _try_get_cached_render(
        self,
        cache_ctx: tuple,
        system: Optional[System] = None,
        slot: int = 0,
        restore_natural_duration: bool = False,
    ) -> Optional[np.ndarray]:
        if self.node_id is None or not getattr(self, "fingerprint", None):
            return None
        cached = GLOBAL_DAG_CACHE.get(self.node_id, self.fingerprint, context=cache_ctx, slot=slot)
        if cached is None:
            return None
        if system is not None and system.render_mode == "preview":
            cached_extra = GLOBAL_DAG_CACHE.get_extra(self.node_id, self.fingerprint, context=cache_ctx, slot=slot)
            if cached_extra and "manifest_state" in cached_extra:
                system.restore_manifest_state(cached_extra["manifest_state"])
            if restore_natural_duration:
                if cached_extra and "natural_duration" in cached_extra:
                    self._natural_duration = cached_extra["natural_duration"]
                else:
                    self._natural_duration = float(cached.shape[-1]) / float(system.sample_rate)
        return cached

    def _store_cached_render(
        self,
        output_buffer: np.ndarray,
        cache_ctx: tuple,
        system: Optional[System] = None,
        slot: int = 0,
        extra: Optional[Dict[str, Any]] = None,
        capture_manifest: bool = True,
    ) -> None:
        if self.node_id is None or not getattr(self, "fingerprint", None):
            return
        payload_extra: Dict[str, Any] = dict(extra) if extra else {}
        if capture_manifest and system is not None:
            manifest_state = system.capture_manifest_state()
            if manifest_state:
                payload_extra["manifest_state"] = manifest_state
        GLOBAL_DAG_CACHE.store(
            self.node_id,
            self.fingerprint,
            output_buffer,
            extra=payload_extra or None,
            context=cache_ctx,
            slot=slot,
        )

    def _tile_loop_to_bars(self, data_to_render: np.ndarray, system: Optional[System] = None, **kwargs: Any) -> np.ndarray:
        loop_sample = kwargs.get("loop", True)
        eff_bars = self.total_bars if (self.total_bars is not None and self.total_bars > 0) else kwargs.get("parent_total_bars")
        if loop_sample and self.sample_type == "loop" and eff_bars is not None and eff_bars > 0 and system is not None:
            target_samples = system.beat_to_samples(eff_bars * 4.0)
            if data_to_render.shape[-1] > 0 and data_to_render.shape[-1] < target_samples:
                reps = int(np.ceil(target_samples / data_to_render.shape[-1]))
                tiled = np.tile(data_to_render, (1, reps) if data_to_render.ndim > 1 else (reps,))
                return tiled[..., :target_samples]
        return data_to_render

    def render(self, system: Optional[System] = None, **kwargs: Any) -> np.ndarray:
        """
        Recursive DSP render method:
        - If self.audio_data exists (leaf/sample), returns audio array scaled by volume
          (time-stretched if original_bpm != system.bpm).
        - If children exist, recursively renders each child, pads with leading zeros based on start_beat,
          and SUMs them into a parent master numpy array.
        """
        cache_ctx = self._cache_context(system, **kwargs)
        cached = self._try_get_cached_render(cache_ctx, system)
        if cached is not None:
            return cached

        # Leaf node case: Raw sample data exists and no children
        if self.audio_data is not None and len(self.children) == 0:
            sr = system.sample_rate if system is not None else 44100
            if self._original_bpm is None and self.sample_type not in ("one_shot", "oneshot"):
                self.detect_and_set_bpm(sample_rate=sr)

            target_bpm = self.target_bpm if self.target_bpm is not None else (system.bpm if system is not None else 120.0)
            data_to_render = process_sample_transform(
                audio_data=self.audio_data,
                sr=sr,
                original_bpm=self._original_bpm if self.sample_type not in ("one_shot", "oneshot") else None,
                target_bpm=target_bpm,
                transpose=self.transpose,
                cents=self.cents,
                stretch_mode=self.stretch_mode,
                stretch_factor=self.stretch_factor,
                stretch_algorithm=self.stretch_algorithm,
                sample_type=self.sample_type,
                fast_preview=system is not None and system.render_mode == "preview",
                key_match_mode=self.key_match_mode,
                key_match_algorithm=self.key_match_algorithm,
            )

            data_to_render = self._tile_loop_to_bars(data_to_render, system, **kwargs)
            leaf_out = self.apply_chain(data_to_render, system)
            self._store_cached_render(leaf_out, cache_ctx, system, capture_manifest=False)
            return leaf_out

        if system is None:
            raise ValueError("System instance must be provided to render a composite AudioObject graph.")

        # Render all child nodes recursively and record (start_sample, child_rendered_array)
        rendered_children: List[Tuple[int, np.ndarray]] = []
        max_end_sample = 0

        base_offset_sec = float(kwargs.get("timeline_offset_sec", 0.0))
        for start_beat, child in self.children:
            if self.node_id is not None and getattr(child, "node_id", None) is not None:
                GLOBAL_DAG_CACHE.register_edge(parent_id=self.node_id, child_id=child.node_id)
            start_sample = system.beat_to_samples(start_beat)
            start_sec = base_offset_sec + (float(start_sample) / float(system.sample_rate))
            child_kwargs = dict(kwargs)
            child_kwargs["timeline_offset_sec"] = start_sec
            if self.total_bars is not None and self.total_bars > 0:
                child_kwargs["parent_total_bars"] = self.total_bars
            child_audio = child.render(system, **child_kwargs)
            end_sample = start_sample + child_audio.shape[-1]

            if end_sample > max_end_sample:
                max_end_sample = end_sample

            rendered_children.append((start_sample, child_audio))

            if system is not None and getattr(child, "node_id", None) is not None:
                child_dur = float(child_audio.shape[-1]) / float(system.sample_rate)
                nat_dur = getattr(child, "_natural_duration", child_dur)
                if getattr(child, "sample_type", None) == "loop" and nat_dur > 0 and child_dur > nat_dur:
                    reps = max(1, int(round(child_dur / nat_dur)))
                    for r in range(reps):
                        system.record_node_event(child.node_id, {
                            "time": round(start_sec + r * nat_dur, 4),
                            "duration": round(nat_dur, 4),
                            "parent_id": self.node_id
                        })
                else:
                    system.record_node_event(child.node_id, {
                        "time": round(start_sec, 4),
                        "duration": round(child_dur, 4),
                        "parent_id": self.node_id
                    })

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
        output_buffer = self.apply_chain(master_buffer, system)
        if system is not None and self.node_id is not None:
            dur = float(output_buffer.shape[-1]) / float(system.sample_rate)
            system.record_node_stem(self.node_id, self.node_type, self.name, output_buffer, dur)
        self._store_cached_render(output_buffer, cache_ctx, system)
        return output_buffer

    def render_slot(self, slot: int = 0, system: Optional[System] = None, **kwargs: Any) -> np.ndarray:
        """Render a specific slot of this AudioObject (defaults to slot 0 / standard render)."""
        return self.render(system=system, **kwargs)


class SampleObject(AudioObject):
    """
    Leaf node that strictly loads a specific audio file (or multi-slot sample array) and renders it.
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
        stretch_algorithm: str = "rubberband",
        total_bars: Optional[float] = None,
        key_match_mode: str = "off",
        key_match_algorithm: str = "nearest",
        target_bpm: Optional[float] = None,
        node_id: Optional[int] = None,
        node_type: str = "sample",
        slots: Optional[List[Any]] = None,
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
            stretch_algorithm=stretch_algorithm,
            total_bars=total_bars,
            key_match_mode=key_match_mode,
            key_match_algorithm=key_match_algorithm,
            target_bpm=target_bpm,
            node_id=node_id,
            node_type=node_type
        )
        self.slots: List[Dict[str, Any]] = self._normalize_slots(slots)

    def _normalize_slots(self, raw_slots: Optional[List[Any]]) -> List[Dict[str, Any]]:
        normalized: List[Dict[str, Any]] = []
        if isinstance(raw_slots, list):
            for idx, item in enumerate(raw_slots):
                if hasattr(item, "model_dump"):
                    d = item.model_dump()
                elif hasattr(item, "dict"):
                    d = item.dict()
                elif isinstance(item, dict):
                    d = dict(item)
                else:
                    continue
                d.setdefault("slot", idx)
                normalized.append(d)
        if not normalized:
            normalized.append({
                "slot": 0,
                "filepath": self.filepath,
                "original_bpm": self._original_bpm,
                "crop_start": self.crop_start,
                "crop_end": self.crop_end,
            })
        return normalized

    def render_slot(self, slot: int = 0, system: Optional[System] = None, **kwargs: Any) -> np.ndarray:
        eff_slot = wrap_slot_index(slot, len(self.slots))
        cache_ctx = self._cache_context(system, **kwargs)
        cached = self._try_get_cached_render(cache_ctx, system, slot=eff_slot, restore_natural_duration=True)
        if cached is not None:
            return cached

        slot_cfg = self.slots[eff_slot] if eff_slot < len(self.slots) else {}
        slot_filepath = slot_cfg.get("filepath") or self.filepath
        if not slot_filepath:
            return np.zeros(0, dtype=np.float32)

        slot_filepath_str = str(slot_filepath)
        if not os.path.exists(slot_filepath_str):
            alt_path = os.path.join("assets", slot_filepath_str)
            if os.path.exists(alt_path):
                slot_filepath_str = alt_path

        sr = system.sample_rate if system is not None else 44100
        try:
            audio_array, _ = load_sample(slot_filepath_str, target_sr=sr)
        except Exception as e:
            import logging
            logging.getLogger("beat_generator.core").warning(f"Failed to load sample '{slot_filepath_str}': {e}")
            return np.zeros(0, dtype=np.float32)

        if audio_array.shape[-1] == 0:
            return np.zeros(0, dtype=np.float32)

        slot_crop_start = float(slot_cfg.get("crop_start") if slot_cfg.get("crop_start") is not None else self.crop_start)
        slot_crop_end = float(slot_cfg.get("crop_end") if slot_cfg.get("crop_end") is not None else self.crop_end)

        # Apply crop range
        if slot_crop_start > 0.0 or slot_crop_end < 1.0:
            total_samples = audio_array.shape[-1]
            s_idx = int(max(0.0, min(1.0, slot_crop_start)) * total_samples)
            e_idx = int(max(0.0, min(1.0, slot_crop_end)) * total_samples)
            if s_idx < e_idx:
                audio_array = audio_array[..., s_idx:e_idx]
            else:
                audio_array = np.zeros((*audio_array.shape[:-1], 0), dtype=np.float32)

        if audio_array.shape[-1] == 0:
            return np.zeros(0, dtype=np.float32)

        slot_bpm = slot_cfg.get("original_bpm") if slot_cfg.get("original_bpm") is not None else self._original_bpm
        if slot_bpm is None and self.sample_type not in ("one_shot", "oneshot"):
            slot_bpm = BPMAnalyzer.from_filename(slot_filepath_str)
            if slot_bpm is None and audio_array.shape[-1] > 0:
                slot_bpm = BPMAnalyzer.from_duration(float(audio_array.shape[-1]) / float(sr))
            if eff_slot == 0 and slot_bpm is not None:
                self._original_bpm = slot_bpm

        target_bpm = self.target_bpm if self.target_bpm is not None else (system.bpm if system is not None else 120.0)
        try:
            data_to_render = process_sample_transform(
                audio_data=audio_array,
                sr=sr,
                original_bpm=slot_bpm,
                target_bpm=target_bpm,
                transpose=self.transpose,
                cents=self.cents,
                stretch_mode=self.stretch_mode,
                stretch_factor=self.stretch_factor,
                stretch_algorithm=self.stretch_algorithm,
                sample_type=self.sample_type,
                fast_preview=system is not None and system.render_mode == "preview",
                key_match_mode=self.key_match_mode,
                key_match_algorithm=self.key_match_algorithm,
            )
        except Exception as e:
            import logging
            logging.getLogger("beat_generator.core").error(f"Error transforming sample '{slot_filepath_str}': {e}")
            return np.zeros(0, dtype=np.float32)

        sample_natural_dur = float(data_to_render.shape[-1]) / float(system.sample_rate) if system is not None and data_to_render.shape[-1] > 0 else 0.0
        self._natural_duration = sample_natural_dur

        data_to_render = self._tile_loop_to_bars(data_to_render, system, **kwargs)
        output_buffer = self.apply_chain(data_to_render, system)
        if system is not None and self.node_id is not None:
            slot_paths = [str(s.get("filepath")) for s in self.slots if s.get("filepath")]
            primary_path = slot_paths[0] if slot_paths else slot_filepath_str
            extra_meta: Dict[str, Any] = {"filepath": primary_path, "slot": eff_slot}
            if len(slot_paths) > 1:
                extra_meta["pool_filepaths"] = slot_paths
                extra_meta["is_pool"] = True
                extra_meta["is_dynamic_pool"] = True
            system.record_node_stem(
                self.node_id,
                "sample",
                self.name,
                output_buffer,
                sample_natural_dur,
                extra=extra_meta,
            )
        self._store_cached_render(
            output_buffer,
            cache_ctx,
            system,
            slot=eff_slot,
            extra={"natural_duration": getattr(self, "_natural_duration", sample_natural_dur)},
        )
        return output_buffer

    def render(self, system: Optional[System] = None, **kwargs: Any) -> np.ndarray:
        return self.render_slot(0, system=system, **kwargs)


class SequenceObject(AudioObject):
    """
    Rhythmic step sequencer node that takes a single child audio object (sample)
    and outputs a rhythmically sequenced audio array based on an internal step array.
    Supports multiple sequence slots and per-step sample slot selection (`sample_slot` / `step_slots`).
    """
    def __init__(
        self,
        name: str = "SequenceObject",
        sequence: Optional[List[int]] = None,
        step_parameters: Optional[List[Dict[str, Any]]] = None,
        step_length: float = 0.25,
        play_mode: str = "gate",
        release: float = 0.0,
        fade_ms: float = 0.0,
        seed: Optional[Union[str, float, int]] = None,
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
        stretch_algorithm: str = "rubberband",
        total_bars: Optional[float] = None,
        loop: bool = True,
        key_match_mode: str = "off",
        key_match_algorithm: str = "nearest",
        node_id: Optional[int] = None,
        slots: Optional[List[Any]] = None,
        sample_slot: Optional[str] = "0",
        step_slots: Optional[List[int]] = None,
        cycle_seeds: Optional[List[int]] = None,
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
            stretch_algorithm=stretch_algorithm,
            total_bars=total_bars,
            key_match_mode=key_match_mode,
            key_match_algorithm=key_match_algorithm,
            node_id=node_id,
            node_type="sequence"
        )
        self.sequence: List[int] = sequence if sequence is not None else [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]
        self.step_length: float = float(step_length)
        self.step_parameters: List[Dict[str, Any]] = step_parameters or []
        self.play_mode: str = str(play_mode).lower() if play_mode else "gate"
        self.loop: bool = bool(loop)
        try:
            parsed_release = float(release)
        except (TypeError, ValueError):
            parsed_release = 0.0
        self.release: float = max(0.0, min(1.0, parsed_release if np.isfinite(parsed_release) else 0.0))
        try:
            parsed_fade_ms = float(fade_ms)
        except (TypeError, ValueError):
            parsed_fade_ms = 0.0
        self.fade_ms: float = max(0.0, min(5.0, parsed_fade_ms if np.isfinite(parsed_fade_ms) else 0.0))
        self.seed: Union[str, float, int] = seed if seed is not None else 42
        self.seed_mode: str = str(seed_mode).lower() if seed_mode else "moving"
        self.sample_slot: str = str(sample_slot if sample_slot is not None else "0")
        self.step_slots: List[int] = [int(s) for s in (step_slots or [])]
        self.cycle_seeds: List[int] = [int(c) for c in (cycle_seeds or [])]
        self.slots: List[Dict[str, Any]] = self._normalize_slots(slots)
        self.is_dynamic: bool = (self.seed_mode == "moving" and not self.cycle_seeds and not isinstance(self.seed, str))

    def _normalize_slots(self, raw_slots: Optional[List[Any]]) -> List[Dict[str, Any]]:
        normalized: List[Dict[str, Any]] = []
        if isinstance(raw_slots, list):
            for idx, item in enumerate(raw_slots):
                if hasattr(item, "model_dump"):
                    d = item.model_dump()
                elif hasattr(item, "dict"):
                    d = item.dict()
                elif isinstance(item, dict):
                    d = dict(item)
                else:
                    continue
                d.setdefault("slot", idx)
                normalized.append(d)
        if not normalized:
            normalized.append({
                "slot": 0,
                "sequence": list(self.sequence),
                "step_parameters": list(self.step_parameters),
                "sample_slot": self.sample_slot,
                "step_slots": list(self.step_slots),
                "seed": self.seed,
                "cycle_seeds": list(self.cycle_seeds),
            })
        return normalized

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

    def _step_parameters(self, index: int, params_list: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
        """Return a sanitized step configuration, including legacy defaults."""
        source_list = params_list if params_list is not None else self.step_parameters
        raw = source_list[index] if index < len(source_list) else {}
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

        raw_start = _safe_float(raw.get("sample_start"), 0.0)
        if raw_start > 1.0:
            raw_start = raw_start / 100.0

        raw_gate = _safe_float(raw.get("gate_length"), 1.0)
        if raw_gate > 1.0:
            raw_gate = raw_gate / 100.0

        raw_prob = _safe_float(raw.get("probability"), 1.0)
        if raw_prob > 1.0:
            raw_prob = raw_prob / 100.0

        return {
            "offset": max(-1.0, min(1.0, _safe_float(raw.get("offset"), 0.0))),
            "velocity": max(0.0, min(1.0, _safe_float(raw.get("velocity"), 1.0))),
            "probability": max(0.0, min(1.0, raw_prob)),
            "sample_start": max(0.0, min(1.0, raw_start)),
            "gate_length": max(0.0, min(1.0, raw_gate)),
            "subdivision_enabled": subdivisions > 1,
            "subdivisions": subdivisions,
        }

    def render_slot(self, slot: int = 0, system: Optional[System] = None, iteration: int = 0, **kwargs: Any) -> np.ndarray:
        eff_slot = wrap_slot_index(slot, max(1, len(self.slots)))
        cache_ctx = self._cache_context(system, iteration=iteration, **kwargs)
        cached = self._try_get_cached_render(cache_ctx, system, slot=eff_slot)
        if cached is not None:
            return cached

        if system is None:
            raise ValueError("System instance must be provided to render a SequenceObject.")

        if not self.children:
            return np.zeros(0, dtype=np.float32)

        slot_cfg = self.slots[eff_slot] if eff_slot < len(self.slots) else {}
        active_sequence = list(slot_cfg.get("sequence") if isinstance(slot_cfg.get("sequence"), list) else self.sequence)
        active_step_params = slot_cfg.get("step_parameters") if isinstance(slot_cfg.get("step_parameters"), list) else self.step_parameters
        active_sample_slot = str(slot_cfg.get("sample_slot") if slot_cfg.get("sample_slot") is not None else self.sample_slot)
        active_seed = slot_cfg.get("seed") if slot_cfg.get("seed") is not None else self.seed

        if len(active_sequence) == 0:
            return np.zeros(0, dtype=np.float32)

        # Render the first child (the sample) as a single un-tiled trigger cycle
        _, first_child = self.children[0]
        if self.node_id is not None and getattr(first_child, "node_id", None) is not None:
            GLOBAL_DAG_CACHE.register_edge(parent_id=self.node_id, child_id=first_child.node_id)
        is_dynamic = getattr(first_child, "is_dynamic", False)
        upstream_slot_count = max(1, len(getattr(first_child, "slots", None) or [1]))

        child_kwargs = dict(kwargs)
        child_kwargs["loop"] = False
        child_kwargs.pop("parent_total_bars", None)

        # Calculate total pattern duration in beats & samples
        pattern_duration_beats = len(active_sequence) * self.step_length
        pattern_samples = system.beat_to_samples(pattern_duration_beats)

        loop_pattern = kwargs.get("loop", True) and getattr(self, "loop", True)
        eff_total_bars = self.total_bars
        if eff_total_bars is None and kwargs.get("parent_total_bars") is not None:
            eff_total_bars = kwargs.get("parent_total_bars")

        if loop_pattern and eff_total_bars is not None and eff_total_bars > 0 and pattern_duration_beats > 0:
            total_duration_beats = eff_total_bars * 4.0
            num_repeats = max(1, int(np.ceil(total_duration_beats / pattern_duration_beats)))
            timeline_samples = system.beat_to_samples(total_duration_beats)
            max_end_sample = timeline_samples
        else:
            num_repeats = 1
            timeline_samples = None
            max_end_sample = pattern_samples

        raw_cycle_seeds = slot_cfg.get("cycle_seeds") if isinstance(slot_cfg.get("cycle_seeds"), list) and slot_cfg.get("cycle_seeds") else self.cycle_seeds
        active_cycle_seeds = (
            list(raw_cycle_seeds)
            if raw_cycle_seeds
            else resolve_cycle_seeds(active_seed, num_repeats, (self.node_id or 1) + eff_slot)
        )

        raw_step_slots = slot_cfg.get("step_slots") if isinstance(slot_cfg.get("step_slots"), list) and slot_cfg.get("step_slots") else self.step_slots
        base_step_slots = (
            [wrap_slot_index(s, upstream_slot_count) for s in raw_step_slots]
            if raw_step_slots
            else resolve_step_slots(active_sample_slot, len(active_sequence), upstream_slot_count, active_cycle_seeds[0])
        )

        has_rand_slot = "rand" in active_sample_slot.lower()
        slot_audio_map: Dict[int, np.ndarray] = {}
        if not is_dynamic:
            slots_to_prerender = (
                list(range(upstream_slot_count))
                if has_rand_slot
                else sorted(set(base_step_slots) | {0})
            )
            for s_idx in slots_to_prerender:
                slot_audio_map[s_idx] = first_child.render_slot(s_idx, system=system, **child_kwargs)
            if all(arr.shape[-1] == 0 for arr in slot_audio_map.values()):
                for s_idx in range(upstream_slot_count):
                    if s_idx not in slot_audio_map:
                        slot_audio_map[s_idx] = first_child.render_slot(s_idx, system=system, **child_kwargs)
                if all(arr.shape[-1] == 0 for arr in slot_audio_map.values()):
                    return np.zeros(0, dtype=np.float32)

        rendered_steps: List[Tuple[int, np.ndarray, int, float]] = []

        for rep in range(num_repeats):
            rep_beat_offset = rep * pattern_duration_beats
            if timeline_samples is not None and system.beat_to_samples(rep_beat_offset) >= timeline_samples:
                break

            base_rep_seed = active_cycle_seeds[rep % len(active_cycle_seeds)]
            if self.seed_mode == "moving" and not raw_cycle_seeds and not isinstance(active_seed, str):
                rep_seed = hash_seed(base_rep_seed, iteration, rep + 1)
            else:
                rep_seed = base_rep_seed

            rng = mulberry32(hash_seed(rep_seed, rep, 0x1357))
            rep_step_slots = (
                resolve_step_slots(active_sample_slot, len(active_sequence), upstream_slot_count, rep_seed)
                if has_rand_slot
                else base_step_slots
            )

            for step_idx, step_val in enumerate(active_sequence):
                if step_val == 1:
                    params = self._step_parameters(step_idx, active_step_params)
                    if rng() >= params["probability"]:
                        continue

                    step_slot = rep_step_slots[step_idx % len(rep_step_slots)] if rep_step_slots else 0
                    if not is_dynamic and step_slot not in slot_audio_map:
                        slot_audio_map[step_slot] = first_child.render_slot(step_slot, system=system, **child_kwargs)

                    repeats = params["subdivisions"]
                    base_beat = rep_beat_offset + (step_idx + params["offset"]) * self.step_length
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
                        audio = (
                            first_child.render_slot(step_slot, system=system, **child_kwargs)
                            if is_dynamic
                            else slot_audio_map.get(step_slot, slot_audio_map.get(0, np.zeros(0, dtype=np.float32)))
                        )
                        velocity = float(params["velocity"])

                        # Apply sample_start (normalized 0.0 to 1.0) before copying/scaling
                        sample_start_ratio = float(params.get("sample_start", 0.0))
                        if sample_start_ratio > 0.0 and audio.shape[-1] > 0:
                            orig_samples = audio.shape[-1]
                            start_offset = min(orig_samples, int(round(orig_samples * sample_start_ratio)))
                            audio = audio[..., start_offset:]

                        if start_sample < 0:
                            skipped_samples = -start_sample
                            audio = audio[..., skipped_samples:]
                            start_sample = 0

                        if audio.shape[-1] == 0:
                            continue

                        gate_mult = max(0.0, min(1.0, float(params.get("gate_length", 1.0))))
                        rel_pct = max(0.0, min(1.0, self.release))
                        sample_len = audio.shape[-1]
                        rel_samples = max(1, int(round(sample_len * rel_pct))) if rel_pct > 0.0 else 0

                        if gate_mult < 1.0:
                            gate_samples = max(1, int(round(slot_samples * gate_mult)))
                            if sample_len > gate_samples:
                                total_len = min(sample_len, gate_samples + rel_samples)
                                audio = (audio[..., :total_len] * velocity).astype(np.float32, copy=True)
                                if rel_samples > 0:
                                    rel_len = total_len - gate_samples
                                    if rel_len > 0:
                                        ramp = np.linspace(1.0, 0.0, rel_len, dtype=np.float32) if rel_len > 1 else np.zeros(1, dtype=np.float32)
                                        audio[..., gate_samples:] *= ramp
                            else:
                                audio = (audio * velocity).astype(np.float32, copy=rel_samples > 0)
                                if rel_samples > 0:
                                    sustain_len = sample_len - min(sample_len, rel_samples)
                                    fade_len = sample_len - sustain_len
                                    ramp = np.linspace(1.0, 0.0, fade_len, dtype=np.float32) if fade_len > 1 else np.zeros(1, dtype=np.float32)
                                    audio[..., sustain_len:] *= ramp
                        else:
                            # Gate is fully open (1.0). Sample plays through without artificial step truncation.
                            audio = (audio * velocity).astype(np.float32, copy=rel_samples > 0)
                            if rel_samples > 0:
                                sustain_len = sample_len - min(sample_len, rel_samples)
                                fade_len = sample_len - sustain_len
                                ramp = np.linspace(1.0, 0.0, fade_len, dtype=np.float32) if fade_len > 1 else np.zeros(1, dtype=np.float32)
                                audio[..., sustain_len:] *= ramp

                        if audio.shape[-1] == 0:
                            continue

                        rendered_steps.append((start_sample, audio, step_slot, sample_start_ratio))

        # Mono vs Multivoice voice handling:
        is_mono = self.play_mode in ("gate", "mono")
        voice_cut_steps: List[Tuple[int, np.ndarray, int, float]] = []
        for i in range(len(rendered_steps)):
            start_i, audio_i, slot_i, start_ratio_i = rendered_steps[i]

            if is_mono:
                next_start = None
                for j in range(i + 1, len(rendered_steps)):
                    s_j, _, _, _ = rendered_steps[j]
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
                voice_cut_steps.append((start_i, audio_i, slot_i, start_ratio_i))
                end_sample = start_i + audio_i.shape[-1]
                if end_sample > max_end_sample:
                    max_end_sample = end_sample

        channel_sources = [audio for _, audio, _, _ in voice_cut_steps]
        for arr in slot_audio_map.values():
            if arr is not None and arr.shape[-1] > 0:
                channel_sources.append(arr)
        channel_shape = (
            np.broadcast_shapes(*(audio.shape[:-1] for audio in channel_sources))
            if channel_sources
            else ()
        )
        master_buffer = np.zeros((*channel_shape, max_end_sample), dtype=np.float32)

        for start_sample, audio, _, _ in voice_cut_steps:
            end_sample = start_sample + audio.shape[-1]
            master_buffer[..., start_sample:end_sample] += audio

        if timeline_samples is not None:
            fitted_buffer = np.zeros((*master_buffer.shape[:-1], timeline_samples), dtype=np.float32)
            copy_samples = min(timeline_samples, master_buffer.shape[-1])
            if copy_samples > 0:
                fitted_buffer[..., :copy_samples] = master_buffer[..., :copy_samples]
            master_buffer = fitted_buffer

        output_buffer = self.apply_chain(master_buffer, system)
        if system is not None and self.node_id is not None:
            dur = float(output_buffer.shape[-1]) / float(system.sample_rate)
            system.record_node_stem(
                self.node_id,
                "sequence",
                self.name,
                output_buffer,
                dur,
                extra={"sequence": active_sequence, "step_length": self.step_length, "slot": eff_slot}
            )
        base_offset_sec = float(kwargs.get("timeline_offset_sec", 0.0))
        if system is not None and getattr(first_child, "node_id", None) is not None:
            for start_i, audio_i, slot_i, start_ratio_i in voice_cut_steps:
                evt_time = base_offset_sec + (float(start_i) / float(system.sample_rate))
                evt_dur = float(audio_i.shape[-1]) / float(system.sample_rate)
                system.record_node_event(first_child.node_id, {
                    "time": round(evt_time, 4),
                    "duration": round(evt_dur, 4),
                    "sequence_id": self.node_id,
                    "slot": slot_i,
                    "sample_start": round(float(start_ratio_i), 4),
                    "loop": False,
                })
        self._store_cached_render(output_buffer, cache_ctx, system, slot=eff_slot)
        return output_buffer

    def render(self, system: Optional[System] = None, iteration: int = 0, **kwargs: Any) -> np.ndarray:
        return self.render_slot(0, system=system, iteration=iteration, **kwargs)


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
        stretch_algorithm: str = "rubberband",
        total_bars: Optional[float] = None,
        key_match_mode: str = "off",
        key_match_algorithm: str = "nearest",
        target_bpm: Optional[float] = None,
        node_id: Optional[int] = None,
        node_type: str = "asset_filter"
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
            stretch_algorithm=stretch_algorithm,
            total_bars=total_bars,
            key_match_mode=key_match_mode,
            key_match_algorithm=key_match_algorithm,
            target_bpm=target_bpm,
            node_id=node_id,
            node_type=node_type
        )
        self.selected_items = selected_items or []
        self.playback_mode = playback_mode or "Random"
        self.seed = seed if seed is not None else random.random()
        self.refresh_mode = str(refresh_mode or "off").strip().casefold()
        self.is_dynamic = self.refresh_mode in {"local", "local_refresh", "self_render"}
        self.current_pool = []
        self.last_played_index = -1
        self._render_count = 0
        self._transform_cache: dict[Tuple[Any, ...], np.ndarray] = {}
        self.updatePool()
        
    def updatePool(self):
        """Build the runtime pool from the explicit, already-resolved keys.

        Library filtering happens before an item is added in the SIN library
        panel. This layer must only choose among those exact references.
        """
        self.current_pool = []
        unresolved_ids: List[int] = []
        for index, item in enumerate(self.selected_items):
            if not isinstance(item, dict):
                raise ValueError(f"Asset Pool item {index} is not an asset reference")
            if item.get("id") is None:
                raise ValueError(f"Asset Pool item {index} is missing its GAIA id")
            filepath = item.get("absolute_path") or item.get("filepath") or item.get("path")
            if not filepath:
                try:
                    unresolved_ids.append(int(item["id"]))
                except (TypeError, ValueError):
                    pass

        resolved_by_id: dict[int, Tuple[str, Optional[float]]] = {}
        if unresolved_ids:
            try:
                import sqlite3
                import json
                from pathlib import Path
                proj_root = Path(__file__).resolve().parents[1]
                db_candidates = [
                    Path.cwd() / "gaia.db",
                    proj_root / "gaia.db",
                    proj_root / "gaia" / "gaia.db",
                ]
                db_path = next((p for p in db_candidates if p.is_file()), None)
                if db_path:
                    unique_ids = sorted(set(unresolved_ids))
                    placeholders = ",".join("?" for _ in unique_ids)
                    with sqlite3.connect(str(db_path)) as conn:
                        rows = conn.execute(
                            f"SELECT id, absolute_path, metadata_json FROM items WHERE id IN ({placeholders})",
                            unique_ids,
                        ).fetchall()
                    for row_id, raw_path, meta_json in rows:
                        if not raw_path:
                            continue
                        cand_path = Path(raw_path)
                        if not cand_path.is_file() and (proj_root / cand_path).is_file():
                            cand_path = proj_root / cand_path
                        bpm_val = None
                        if meta_json:
                            try:
                                bpm_val = (json.loads(meta_json) or {}).get("bpm")
                            except Exception:
                                bpm_val = None
                        resolved_by_id[int(row_id)] = (str(cand_path), bpm_val)
            except Exception:
                pass

        for index, item in enumerate(self.selected_items):
            filepath = item.get("absolute_path") or item.get("filepath") or item.get("path")
            if not filepath and item.get("id") is not None:
                try:
                    resolved = resolved_by_id.get(int(item["id"]))
                    if resolved:
                        filepath, resolved_bpm = resolved
                        if not item.get("bpm") and resolved_bpm is not None:
                            item["bpm"] = resolved_bpm
                except (TypeError, ValueError):
                    pass

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
            try:
                seed_int = int(self.seed or 0)
            except (TypeError, ValueError):
                seed_int = normalize_numeric_seed(self.seed, 0)
            next_idx = (seed_int + self._render_count) % pool_size
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
        
    def render_slot(self, slot_idx: int = 0, system: Optional[System] = None, **kwargs: Any) -> np.ndarray:
        return self.render(system=system, **kwargs)

    def render(self, system: Optional[System] = None, **kwargs: Any) -> np.ndarray:
        should_advance = self.refresh_mode in {
            "local",
            "local_refresh",
            "self_render",
            "parent",
            "parent_refresh",
        }
        filepath = self.getNextSample(advance=should_advance)
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
        if item_bpm is None and self.sample_type not in ("one_shot", "oneshot"):
            item_bpm = BPMAnalyzer.from_filename(filepath)
            if item_bpm is None and audio_array.shape[-1] > 0:
                item_bpm = BPMAnalyzer.from_duration(float(audio_array.shape[-1]) / sr)
        
        original_bpm = item_bpm if item_bpm is not None else (None if self.sample_type in ("one_shot", "oneshot") else self._original_bpm)
                
        if self.crop_start > 0.0 or self.crop_end < 1.0:
            total_samples = audio_array.shape[-1]
            start = int(max(0.0, min(1.0, self.crop_start)) * total_samples)
            end = int(max(0.0, min(1.0, self.crop_end)) * total_samples)
            audio_array = audio_array[..., start:end] if start < end else np.zeros(
                (*audio_array.shape[:-1], 0), dtype=np.float32
            )

        if audio_array.shape[-1] == 0:
            return np.zeros(0, dtype=np.float32)

        target_bpm = self.target_bpm if self.target_bpm is not None else (system.bpm if system is not None else 120.0)
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
            str(self.key_match_mode),
            str(self.key_match_algorithm),
            str(system.render_mode) if system is not None else "offline",
        )
        data_to_render = self._transform_cache.get(transform_cache_key)
        if data_to_render is None:
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
                key_match_mode=self.key_match_mode,
                key_match_algorithm=self.key_match_algorithm,
            )
            self._transform_cache[transform_cache_key] = data_to_render
            set_runtime_cache(transform_cache_key, data_to_render)
        else:
            self._transform_cache[transform_cache_key] = data_to_render
            trace_marker = ("pool_transform_hit_logged", transform_cache_key)
            if get_runtime_cache(trace_marker) is None:
                trace_runtime(f"DSP transform cache hit: {os.path.basename(filepath)}")
                set_runtime_cache(trace_marker, True)
            
        sample_natural_dur = float(data_to_render.shape[-1]) / float(system.sample_rate) if system is not None and data_to_render.shape[-1] > 0 else 0.0
        data_to_render = self._tile_loop_to_bars(data_to_render, system, **kwargs)
        output_buffer = self.apply_chain(data_to_render, system)
        if system is not None and self.node_id is not None:
            existing_entry = system.manifest.get("nodes", {}).get(str(self.node_id), {})
            pool_paths = list(existing_entry.get("pool_filepaths", []))
            if filepath not in pool_paths:
                pool_paths.append(filepath)
            first_filepath = existing_entry.get("filepath") or filepath
            system.record_node_stem(
                self.node_id,
                "sample",
                self.name,
                output_buffer,
                sample_natural_dur,
                extra={
                    "filepath": first_filepath,
                    "pool_filepaths": pool_paths,
                    "is_pool": True,
                    "is_dynamic_pool": len(pool_paths) > 1 or should_advance,
                }
            )
        return output_buffer

# Backward-compatible import for saved projects and external integrations.
SamplePoolObject = ItemPoolObject

class ArrangementObject(AudioObject):
    """
    Arrangement node that takes one or more child audio objects (loops) with a predefined length
    and repeats them to fill a user defined time length (`total_bars`).
    Each section owns its playback probability, source offset, quantization, anchor, and slot selector (`section_slots`).
    """
    def __init__(
        self,
        name: str = "ArrangementObject",
        total_bars: float = 4.0,
        probability: float = 1.0,
        seed: Optional[Union[str, float, int]] = None,
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
        section_slots: Optional[List[int]] = None,
        cycle_seeds: Optional[List[int]] = None,
        quant: Optional[Union[str, float]] = "auto",
        quant_anchor: str = "start",
        node_id: Optional[int] = None,
        node_type: str = "arrangement"
    ) -> None:
        super().__init__(
            name=name,
            volume=volume,
            pan=pan,
            original_bpm=original_bpm,
            chain=chain,
            data=data,
            sample_type=sample_type,
            node_id=node_id,
            node_type=node_type
        )
        self.total_bars = float(total_bars)
        self.seed = seed if seed is not None else 42
        self.section_points = sorted({
            float(point) for point in (section_points or [])
            if 0.0 < float(point) < self.total_bars
        })
        num_sections = len(self.section_points) + 1
        raw_section_enabled = section_enabled or []
        try:
            legacy_probability = max(0.0, min(1.0, float(probability)))
        except (TypeError, ValueError):
            legacy_probability = 1.0
        legacy_quant = "auto" if quant is None else str(quant).lower()
        if legacy_quant in ("", "global", "inherit", "continuous"):
            legacy_quant = "auto"
        legacy_anchor = "end" if quant_anchor == "end" else "start"

        raw_probability = list(section_probability) if section_probability is not None else []
        raw_sample_start = list(section_sample_start) if section_sample_start is not None else []
        raw_quant = list(section_quant) if section_quant is not None else []
        raw_anchor = list(section_quant_anchor) if section_quant_anchor is not None else []
        raw_slots = list(section_slots) if section_slots is not None else []
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
        self.section_slots = [
            int(raw_slots[index] or 0) if index < len(raw_slots) else 0
            for index in range(num_sections)
        ]
        self.cycle_seeds = (
            [int(c) for c in cycle_seeds]
            if cycle_seeds
            else resolve_cycle_seeds(self.seed, num_sections, self.node_id or 1)
        )

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

    def get_section_slot(self, section_index: int, upstream_slot_count: int = 1) -> int:
        raw_slot = self.section_slots[section_index] if 0 <= section_index < len(self.section_slots) else 0
        return wrap_slot_index(raw_slot, upstream_slot_count)

    def get_section_quant_samples(self, section_index: int, child: AudioObject, audio: np.ndarray, system: System) -> Optional[int]:
        s_quant = self.get_section_quant(section_index)
        if s_quant in ("", "none", "off", "once"):
            return None
        if s_quant in ("auto", "continuous"):
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
        cache_ctx = self._cache_context(system, **kwargs)
        cached = self._try_get_cached_render(cache_ctx, system)
        if cached is not None:
            return cached

        if system is None:
            raise ValueError("System instance must be provided to render.")
            
        if self.total_bars <= 0:
            return np.zeros(0, dtype=np.float32)

        total_samples_to_fill = system.beat_to_samples(self.total_bars * 4.0)
        if not self.children:
            return np.zeros(total_samples_to_fill, dtype=np.float32)

        for _, child in self.children:
            if self.node_id is not None and getattr(child, "node_id", None) is not None:
                GLOBAL_DAG_CACHE.register_edge(parent_id=self.node_id, child_id=child.node_id)

        cached_slot_audios: Dict[Tuple[int, int], np.ndarray] = {}
        child_template_events: Dict[Any, Dict[str, List[dict]]] = {}
        observed_channel_shapes: List[Tuple[int, ...]] = []

        def _render_child_slot(c_idx: int, c_obj: AudioObject, slot_idx: int, iter_idx: int = 0) -> Tuple[np.ndarray, Any]:
            is_dyn = getattr(c_obj, "is_dynamic", False)
            cache_key = (c_idx, slot_idx)
            if not is_dyn and cache_key in cached_slot_audios:
                return cached_slot_audios[cache_key], cache_key

            evt_key = f"dyn_{iter_idx}" if is_dyn else cache_key
            before_counts = {
                nid: len(nentry.get("events", []))
                for nid, nentry in (system.manifest.get("nodes", {}) if system is not None else {}).items()
            }
            child_kwargs = dict(kwargs)
            child_kwargs["loop"] = False
            child_kwargs["timeline_offset_sec"] = 0.0
            if is_dyn:
                audio_out = c_obj.render_slot(slot_idx, system=system, iteration=iter_idx, **child_kwargs)
            else:
                audio_out = c_obj.render_slot(slot_idx, system=system, **child_kwargs)
                cached_slot_audios[cache_key] = audio_out
            observed_channel_shapes.append(audio_out.shape[:-1])
            if system is not None:
                captured = {}
                for nid, nentry in system.manifest.get("nodes", {}).items():
                    start_idx = before_counts.get(nid, 0)
                    evts = nentry.get("events", [])[start_idx:]
                    if evts:
                        captured[nid] = [dict(e) for e in evts]
                        del nentry["events"][start_idx:]
                child_template_events[evt_key] = captured
            return audio_out, evt_key

        rendered_events: List[Tuple[int, np.ndarray, Optional[int], Any, int, int, int, int, int, bool]] = []
        
        iteration_count = 0
        boundaries = self.get_section_boundaries()
        for section_index in range(len(boundaries) - 1):
            section_start = system.beat_to_samples(boundaries[section_index] * 4.0)
            section_end = system.beat_to_samples(boundaries[section_index + 1] * 4.0)
            cell_start = section_start

            sec_prob = self.get_section_probability(section_index)
            sec_sample_start = self.get_section_sample_start(section_index)
            sec_quant = self.get_section_quant(section_index)
            is_continuous = sec_quant in ("auto", "continuous")
            sec_anchor = self.get_section_quant_anchor(section_index)
            sec_seed = self.cycle_seeds[section_index % len(self.cycle_seeds)] if self.cycle_seeds else 42
            sec_rng = mulberry32(hash_seed(sec_seed, section_index, 0xA44A))

            while cell_start < section_end:
                child_idx = int(sec_rng() * len(self.children)) if len(self.children) > 1 else 0
                _, child = self.children[child_idx]
                upstream_slots = max(1, len(getattr(child, "slots", None) or [1]))
                target_slot = self.get_section_slot(section_index, upstream_slots)

                audio, evt_key = _render_child_slot(child_idx, child, target_slot, iteration_count)
                iteration_count += 1
                if audio.shape[-1] == 0:
                    break

                quant_samples = self.get_section_quant_samples(section_index, child, audio, system)
                sample_count = audio.shape[-1]
                if is_continuous:
                    sample_offset = (int(sample_count * sec_sample_start) % sample_count) if sample_count > 0 else 0
                    if 0 < sample_offset < sample_count:
                        playable_audio = np.concatenate([audio[..., sample_offset:], audio[..., :sample_offset]], axis=-1)
                    else:
                        playable_audio = audio
                    target_cell_len = quant_samples if quant_samples is not None else (section_end - cell_start)
                    if target_cell_len > playable_audio.shape[-1] and playable_audio.shape[-1] > 0:
                        reps = int(np.ceil(target_cell_len / playable_audio.shape[-1]))
                        tiled = np.tile(playable_audio, (1, reps) if playable_audio.ndim > 1 else (reps,))
                        playable_audio = tiled[..., :target_cell_len]
                else:
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

                write_start = max(section_start, cell_start, event_start)
                write_end = min(section_end, cell_end, event_end)
                if write_start < write_end and sec_rng() < sec_prob:
                    source_start = write_start - event_start
                    source_end = source_start + (write_end - write_start)
                    rendered_events.append((
                        write_start,
                        playable_audio[..., source_start:source_end],
                        getattr(child, "node_id", None),
                        evt_key,
                        source_start,
                        source_end,
                        target_slot,
                        sample_offset,
                        sample_count,
                        is_continuous,
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
        for write_start, event_audio, child_node_id, evt_key, source_start, source_end, _, _, _, _ in rendered_events:
            write_end = write_start + event_audio.shape[-1]
            master_buffer[..., write_start:write_end] += event_audio

        output_buffer = self.apply_chain(master_buffer, system)
        if system is not None and self.node_id is not None:
            dur = float(output_buffer.shape[-1]) / float(system.sample_rate)
            system.record_node_stem(
                self.node_id,
                "arrangement",
                self.name,
                output_buffer,
                dur,
                extra={"total_bars": self.total_bars}
            )
        base_offset_sec = float(kwargs.get("timeline_offset_sec", 0.0))
        if system is not None:
            sr = float(system.sample_rate)
            for write_start, event_audio, child_node_id, evt_key, source_start, source_end, target_slot, sample_offset, sample_count, is_continuous in rendered_events:
                if child_node_id is not None:
                    evt_time = base_offset_sec + (float(write_start) / sr)
                    evt_dur = float(event_audio.shape[-1]) / sr
                    eff_offset = ((sample_offset + source_start) % sample_count) if (is_continuous and sample_count > 0) else min(sample_count, sample_offset + source_start)
                    eff_sample_start = (float(eff_offset) / float(sample_count)) if sample_count > 0 else 0.0
                    system.record_node_event(child_node_id, {
                        "time": round(evt_time, 4),
                        "duration": round(evt_dur, 4),
                        "arrangement_id": self.node_id,
                        "slot": target_slot,
                        "sample_start": round(eff_sample_start, 4),
                        "loop": bool(is_continuous),
                    })
                if evt_key in child_template_events:
                    source_start_sec = float(source_start) / sr
                    source_end_sec = float(source_end) / sr
                    offset_sec = float(sample_offset) / sr
                    wrap_tail_sec = float(sample_count - sample_offset) / sr
                    for desc_node_id, desc_evts in child_template_events[evt_key].items():
                        for devt in desc_evts:
                            t_rel = float(devt.get("time", 0.0))
                            d_rel = float(devt.get("duration", 0.0))
                            if t_rel >= offset_sec - 0.002:
                                t_playable = max(0.0, t_rel - offset_sec)
                            elif is_continuous and sample_offset > 0:
                                t_playable = t_rel + wrap_tail_sec
                            else:
                                continue
                            if t_playable >= source_start_sec - 0.002 and t_playable < source_end_sec:
                                new_evt = dict(devt)
                                actual_time = base_offset_sec + (float(write_start) / sr) + (t_playable - source_start_sec)
                                new_evt["time"] = round(actual_time, 4)
                                new_evt["duration"] = round(min(d_rel, source_end_sec - t_playable), 4)
                                new_evt["arrangement_id"] = self.node_id
                                system.record_node_event(int(desc_node_id), new_evt)
        self._store_cached_render(output_buffer, cache_ctx, system)
        return output_buffer
