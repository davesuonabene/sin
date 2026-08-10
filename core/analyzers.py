import re
from pathlib import Path
from typing import Union, Optional


class BPMAnalyzer:
    """
    Utility class for analyzing and detecting BPM of audio files
    either via filename regex heuristics or audio duration.
    """

    @staticmethod
    def from_filename(filepath: Union[str, Path]) -> Optional[float]:
        """
        Uses regex to search the filename for common BPM patterns
        (e.g., "120bpm", "120_bpm", "120 BPM", "171").
        Returns float if found, else None.
        """
        if not filepath:
            return None

        filename = Path(filepath).name

        # 1. Look for explicit BPM suffix patterns (e.g. 120bpm, 120_bpm, 120 BPM, 120-bpm)
        match = re.search(r'(\d{2,3}(?:\.\d+)?)\s*bpm', filename, re.IGNORECASE)
        if match:
            return float(match.group(1))

        match = re.search(r'(\d{2,3}(?:\.\d+)?)[_\s-]+bpm', filename, re.IGNORECASE)
        if match:
            return float(match.group(1))

        # 2. Look for standalone/trailing numeric values that fit within reasonable BPM ranges (e.g. _171 or _174)
        matches = re.findall(r'(?:^|[_\s-])(\d{2,3})(?=[._\s-]|$)', filename)
        for candidate in reversed(matches):
            val = float(candidate)
            if 60.0 <= val <= 220.0:
                return val

        return None

    @staticmethod
    def from_loop_duration(duration_seconds: float) -> Optional[float]:
        """Infer a plausible tempo for a musical loop from its duration.

        The method favors the common four-bar interpretation, then shorter or
        longer power-of-two loop lengths. It deliberately returns ``None`` for
        implausible durations instead of fabricating a default tempo.
        """
        if not duration_seconds or duration_seconds < 0.2 or duration_seconds > 180.0:
            return None
        for bars in (4, 8, 16, 2, 1, 32):
            bpm = (bars * 4.0 * 60.0) / duration_seconds
            if 60.0 <= bpm <= 220.0:
                return float(bpm)
        return None

    @staticmethod
    def from_duration(duration_seconds: float) -> float:
        """
        Calculates assumed BPM from duration by checking standard loop lengths (in bars).
        Returns assumed_bpm if within reasonable range (90 to 180), default 120.0 fallback.
        """
        if duration_seconds <= 0:
            return 120.0

        inferred = BPMAnalyzer.from_loop_duration(duration_seconds)
        return inferred if inferred is not None else 120.0
