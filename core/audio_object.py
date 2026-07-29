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
        child_audio = first_child.render(system, **kwargs)

        if len(child_audio) == 0 or len(self.sequence) == 0:
            return np.zeros(0, dtype=np.float32)

        # Calculate total pattern duration in beats & samples
        pattern_duration_beats = len(self.sequence) * self.step_length
        pattern_samples = system.beat_to_samples(pattern_duration_beats)

        # Determine maximum required array length in samples (sequence duration + tail of final sample trigger)
        max_end_sample = pattern_samples
        for step_idx, step_val in enumerate(self.sequence):
            if step_val == 1:
                start_beat = step_idx * self.step_length
                start_sample = system.beat_to_samples(start_beat)
                end_sample = start_sample + len(child_audio)
                if end_sample > max_end_sample:
                    max_end_sample = end_sample

        master_buffer = np.zeros(max_end_sample, dtype=np.float32)

        # Mix child audio at active steps
        for step_idx, step_val in enumerate(self.sequence):
            if step_val == 1:
                start_beat = step_idx * self.step_length
                start_sample = system.beat_to_samples(start_beat)
                end_sample = start_sample + len(child_audio)
                master_buffer[start_sample:end_sample] += child_audio

        return (master_buffer * self.volume).astype(np.float32)

