from __future__ import annotations
from pathlib import Path
from typing import List, Tuple, Optional, Union, Any, TYPE_CHECKING
import numpy as np
from core.base_object import BaseObject
from core.analyzers import BPMAnalyzer
from core.dsp import stretch_audio, load_sample

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
        data: Optional[Any] = None
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
        self.is_dynamic = False

        # Children stored as list of (start_beat: float, child_object: AudioObject) tuples
        self.children: List[Tuple[float, AudioObject]] = []

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

        if self.audio_data is not None and len(self.audio_data) > 0:
            duration_seconds = float(len(self.audio_data)) / float(sample_rate)
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
            if self._original_bpm is None:
                sr = system.sample_rate if system is not None else 44100
                self.detect_and_set_bpm(sample_rate=sr)

            data_to_render = self.audio_data
            if system is not None and self._original_bpm is not None and self._original_bpm != system.bpm:
                data_to_render = stretch_audio(self.audio_data, self._original_bpm, system.bpm)

            return (data_to_render * self.volume).astype(np.float32)

        if system is None:
            raise ValueError("System instance must be provided to render a composite AudioObject graph.")

        # Render all child nodes recursively and record (start_sample, child_rendered_array)
        rendered_children: List[Tuple[int, np.ndarray]] = []
        max_end_sample = 0

        for start_beat, child in self.children:
            child_audio = child.render(system, **kwargs)
            start_sample = system.beat_to_samples(start_beat)
            end_sample = start_sample + len(child_audio)

            if end_sample > max_end_sample:
                max_end_sample = end_sample

            rendered_children.append((start_sample, child_audio))

        # If base audio_data exists on composite node, include its length in max_end_sample
        if self.audio_data is not None:
            max_end_sample = max(max_end_sample, len(self.audio_data))

        if max_end_sample == 0:
            return np.zeros(0, dtype=np.float32)

        # Instantiate parent master numpy array based on mix_mode
        if self.mix_mode == "chained":
            # Chained mode: sequence all child arrays horizontally ignoring start_beat
            if len(rendered_children) > 0:
                master_buffer = np.concatenate([child_arr for _, child_arr in rendered_children])
            else:
                master_buffer = np.zeros(0, dtype=np.float32)

            if self.audio_data is not None:
                # Prepend the composite's own data to the chain
                master_buffer = np.concatenate([self.audio_data, master_buffer])

        else:
            # Sum mode (default): layer child arrays vertically at their start_beat offsets
            master_buffer = np.zeros(max_end_sample, dtype=np.float32)

            # If composite node has its own base audio_data, add it
            if self.audio_data is not None:
                master_buffer[:len(self.audio_data)] += self.audio_data

            # SUM child audio arrays into parent buffer at their start_sample offsets
            for start_sample, child_audio in rendered_children:
                end_sample = start_sample + len(child_audio)
                master_buffer[start_sample:end_sample] += child_audio

        # Apply parent node volume scaling
        return (master_buffer * self.volume).astype(np.float32)


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
        data: Optional[Any] = None
    ) -> None:
        super().__init__(
            name=name,
            filepath=filepath,
            volume=volume,
            pan=pan,
            original_bpm=original_bpm,
            data=data
        )

    def render(self, system: Optional[System] = None, **kwargs: Any) -> np.ndarray:
        if not self.filepath:
            return np.zeros(0, dtype=np.float32)

        sr = system.sample_rate if system is not None else 44100
        audio_array, _ = load_sample(self.filepath, target_sr=sr)

        if self._original_bpm is None:
            self.detect_and_set_bpm(sample_rate=sr)

        data_to_render = audio_array
        if system is not None and self._original_bpm is not None and self._original_bpm != system.bpm:
            data_to_render = stretch_audio(audio_array, self._original_bpm, system.bpm)

        return (data_to_render * self.volume).astype(np.float32)


class SequenceObject(AudioObject):
    """
    Rhythmic step sequencer node that takes a single child audio object (sample)
    and outputs a rhythmically sequenced audio array based on an internal step array.
    """
    def __init__(
        self,
        name: str = "SequenceObject",
        sequence: Optional[List[int]] = None,
        step_length: float = 0.25,
        volume: float = 1.0,
        pan: float = 0.0,
        original_bpm: Optional[float] = None,
        filepath: Optional[Union[str, Path]] = None,
        data: Optional[Any] = None
    ) -> None:
        super().__init__(
            name=name,
            filepath=filepath,
            volume=volume,
            pan=pan,
            original_bpm=original_bpm,
            data=data
        )
        self.sequence: List[int] = sequence if sequence is not None else [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]
        self.step_length: float = float(step_length)

    def render(self, system: Optional[System] = None, **kwargs: Any) -> np.ndarray:
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
            if len(cached_child_audio) == 0 or len(self.sequence) == 0:
                return np.zeros(0, dtype=np.float32)

        if len(self.sequence) == 0:
            return np.zeros(0, dtype=np.float32)

        # Calculate total pattern duration in beats & samples
        pattern_duration_beats = len(self.sequence) * self.step_length
        pattern_samples = system.beat_to_samples(pattern_duration_beats)

        rendered_steps = []
        max_end_sample = pattern_samples

        for step_idx, step_val in enumerate(self.sequence):
            if step_val == 1:
                start_beat = step_idx * self.step_length
                start_sample = system.beat_to_samples(start_beat)

                audio = first_child.render(system, **kwargs) if is_dynamic else cached_child_audio
                rendered_steps.append((start_sample, audio))

                end_sample = start_sample + len(audio)
                if end_sample > max_end_sample:
                    max_end_sample = end_sample

        master_buffer = np.zeros(max_end_sample, dtype=np.float32)

        for start_sample, audio in rendered_steps:
            end_sample = start_sample + len(audio)
            master_buffer[start_sample:end_sample] += audio

        return (master_buffer * self.volume).astype(np.float32)


import sqlite3
import random
import os

class SamplePoolObject(AudioObject):
    def __init__(
        self,
        name: str = "SamplePoolObject",
        filters: Optional[dict] = None,
        playback_mode: str = "Random",
        seed: Optional[float] = None,
        refresh_mode: str = "manual",
        volume: float = 1.0,
        pan: float = 0.0,
        original_bpm: Optional[float] = None,
        data: Optional[Any] = None
    ) -> None:
        super().__init__(
            name=name,
            volume=volume,
            pan=pan,
            original_bpm=original_bpm,
            data=data
        )
        self.filters = filters or {}
        self.playback_mode = playback_mode or "Random"
        self.seed = seed if seed is not None else random.random()
        self.refresh_mode = refresh_mode
        self.is_dynamic = False
        self.current_pool = []
        self.last_played_index = -1
        self.updatePool()
        
        # Pre-load audio data for the statically evaluated render
        sample_path = self.getNextSample()
        if sample_path:
            if not os.path.exists(sample_path):
                alt_path = os.path.join("assets", sample_path)
                if os.path.exists(alt_path):
                    sample_path = alt_path
            try:
                from core.dsp import load_sample
                self.audio_data, _ = load_sample(sample_path)
                self.filepath = sample_path
            except Exception as e:
                import logging
                logging.getLogger("beat_generator").warning(f"Failed to load pool sample: {e}")
        
    def updatePool(self):
        self.current_pool = []
        db_path = "gaia.db"
        if not os.path.exists(db_path):
            db_path = os.path.join("gaia", "gaia.db")
        if not os.path.exists(db_path):
            return
            
        try:
            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            
            query = "SELECT i.id, i.absolute_path, i.type FROM items i"
            joins = []
            conditions = []
            params = []
            
            tags = self.filters.get("tags")
            if tags:
                if isinstance(tags, str):
                    tags = [t.strip() for t in tags.split(",") if t.strip()]
                if tags:
                    joins.append("JOIN item_tags it ON i.id = it.item_id JOIN tags t ON it.tag_id = t.id")
                    tag_placeholders = ",".join(["?"] * len(tags))
                    conditions.append(f"t.name IN ({tag_placeholders})")
                    params.extend(tags)
                    
            item_type = self.filters.get("type")
            if item_type:
                conditions.append("i.type = ?")
                params.append(item_type)
                
            bpm_min = self.filters.get("bpm_min")
            bpm_max = self.filters.get("bpm_max")
            
            if bpm_min is not None or bpm_max is not None:
                joins.append("LEFT JOIN loop_sample_items lsi ON i.id = lsi.id")
                if bpm_min is not None:
                    conditions.append("lsi.bpm >= ?")
                    params.append(bpm_min)
                if bpm_max is not None:
                    conditions.append("lsi.bpm <= ?")
                    params.append(bpm_max)
            
            if joins:
                query += " " + " ".join(joins)
            if conditions:
                query += " WHERE " + " AND ".join(conditions)
                
            query += " GROUP BY i.id"
            
            cursor.execute(query, params)
            rows = cursor.fetchall()
            
            for row in rows:
                self.current_pool.append({
                    "id": row["id"],
                    "absolute_path": row["absolute_path"],
                    "type": row["type"]
                })
                
            conn.close()
        except Exception as e:
            import logging
            logging.getLogger("beat_generator.core").error(f"Failed to update SamplePool: {e}")
            
    def getNextSample(self) -> Optional[str]:
        if not self.current_pool:
            return None
            
        pool_size = len(self.current_pool)
        if pool_size == 1:
            self.last_played_index = 0
            return self.current_pool[0]["absolute_path"]
            
        import hashlib
        seed_hash = int(hashlib.md5(str(self.seed).encode()).hexdigest(), 16)
        next_idx = seed_hash % pool_size
                
        self.last_played_index = next_idx
        return self.current_pool[next_idx]["absolute_path"]
        
    def render(self, system: Optional[System] = None, **kwargs: Any) -> np.ndarray:
        filepath = self.getNextSample()
        if not filepath:
            return np.zeros(0, dtype=np.float32)
            
        sr = system.sample_rate if system is not None else 44100
        
        if not os.path.exists(filepath):
            alt_path = os.path.join("assets", filepath)
            if os.path.exists(alt_path):
                filepath = alt_path
        
        try:
            audio_array, _ = load_sample(filepath, target_sr=sr)
        except Exception as e:
            import logging
            logging.getLogger("beat_generator.core").error(f"Failed to load sample {filepath}: {e}")
            return np.zeros(0, dtype=np.float32)
        
        original_bpm = self._original_bpm
        if original_bpm is None:
            bpm = BPMAnalyzer.from_filename(filepath)
            if bpm is None and len(audio_array) > 0:
                bpm = BPMAnalyzer.from_duration(float(len(audio_array)) / sr)
            if bpm is not None:
                original_bpm = bpm
                
        data_to_render = audio_array
        if system is not None and original_bpm is not None and original_bpm != system.bpm:
            data_to_render = stretch_audio(audio_array, original_bpm, system.bpm)
            
        return (data_to_render * self.volume).astype(np.float32)

class ArrangementObject(AudioObject):
    """
    Arrangement node that takes one or more child audio objects (loops) with a predefined length
    and repeats them to fill a user defined time length (`total_bars`).
    Each iteration evaluates `probability` (0.0 - 1.0) to see if it should play or be bypassed (silenced).
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
        data: Optional[Any] = None
    ) -> None:
        super().__init__(
            name=name,
            volume=volume,
            pan=pan,
            original_bpm=original_bpm,
            data=data
        )
        self.total_bars = float(total_bars)
        self.probability = float(probability)
        self.seed = seed if seed is not None else random.random()

    def get_child_loop_samples(self, child: AudioObject, audio: np.ndarray, system: System) -> int:
        if hasattr(child, "sequence") and hasattr(child, "step_length"):
            beats = len(getattr(child, "sequence")) * getattr(child, "step_length")
            if beats > 0:
                return system.beat_to_samples(beats)
        elif getattr(child, "total_bars", 0) > 0:
            return system.beat_to_samples(getattr(child, "total_bars") * 4.0)
        elif getattr(child, "length_in_beats", 0) > 0:
            return system.beat_to_samples(getattr(child, "length_in_beats"))

        if len(audio) > 0:
            samples_per_beat = system.beat_to_samples(1.0)
            if samples_per_beat > 0:
                beats = len(audio) / float(samples_per_beat)
                nearest_beat = round(beats)
                if abs(beats - nearest_beat) < 0.15 and nearest_beat > 0:
                    return system.beat_to_samples(float(nearest_beat))
            return len(audio)

        return system.beat_to_samples(4.0)

    def render(self, system: Optional[System] = None, **kwargs: Any) -> np.ndarray:
        if system is None:
            raise ValueError("System instance must be provided to render.")
            
        if not self.children or self.total_bars <= 0:
            return np.zeros(0, dtype=np.float32)

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
                
        total_samples_to_fill = system.beat_to_samples(self.total_bars * 4.0)
        master_buffer = np.zeros(total_samples_to_fill, dtype=np.float32)
        
        # Use a reproducible random generator based on the seed
        seed_hash = int(hashlib.md5(str(self.seed).encode()).hexdigest(), 16)
        rng = random.Random(seed_hash)
        
        current_sample = 0
        
        while current_sample < total_samples_to_fill:
            child_idx = rng.randint(0, len(self.children) - 1)
            audio = cached_audios[child_idx]
            _, child = self.children[child_idx]
            
            if audio is None:
                audio = child.render(system, **kwargs)
                
            if len(audio) == 0:
                # To prevent infinite loop if child returns 0-length array
                break

            loop_samples = self.get_child_loop_samples(child, audio, system)
            if loop_samples <= 0:
                break
                
            # Check probability
            if rng.random() < self.probability:
                end_sample = current_sample + len(audio)
                
                # Copy audio into master buffer
                if end_sample <= total_samples_to_fill:
                    master_buffer[current_sample:end_sample] += audio
                else:
                    # Clip it if it exceeds total_samples_to_fill
                    remaining_samples = total_samples_to_fill - current_sample
                    if remaining_samples > 0:
                        master_buffer[current_sample:total_samples_to_fill] += audio[:remaining_samples]
            
            # Move the time cursor forward by the beat-quantized loop length
            current_sample += loop_samples
                
        return (master_buffer * self.volume).astype(np.float32)

