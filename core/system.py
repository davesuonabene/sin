from __future__ import annotations
from typing import Optional, TYPE_CHECKING
import numpy as np

if TYPE_CHECKING:
    from core.audio_object import AudioObject


class System:
    """
    Global orchestrator for the graph-based beat generator system.
    Controls timing (BPM), audio format (sample rate), and root AudioObject rendering.
    """

    def __init__(
        self,
        bpm: float = 120.0,
        sample_rate: int = 44100,
        root_object: Optional[AudioObject] = None
    ) -> None:
        self.bpm = float(bpm)
        self.sample_rate = int(sample_rate)
        self.root_object = root_object

    def beat_to_samples(self, beat: float) -> int:
        """
        Calculates how many audio samples represent a given beat count
        based on the System's BPM and sample rate.
        """
        seconds_per_beat = 60.0 / self.bpm
        total_seconds = beat * seconds_per_beat
        return int(round(total_seconds * self.sample_rate))

    def play(self) -> None:
        """
        Stub method for real-time clocked playback.
        Will eventually handle streaming audio output buffers to audio driver hardware.
        """
        pass

    def render(self) -> np.ndarray:
        """
        Triggers rendering of the root AudioObject node graph and returns the final mixed audio array.
        """
        if self.root_object is None:
            return np.zeros(0, dtype=np.float32)
        return self.root_object.render(self)
