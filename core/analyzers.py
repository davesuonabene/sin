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
    def from_duration(duration_seconds: float) -> float:
        """
        Calculates assumed BPM from duration by checking standard loop lengths (in bars).
        Returns assumed_bpm if within reasonable range (90 to 180), default 120.0 fallback.
        """
        if duration_seconds <= 0:
            return 120.0

        min_bpm = 90.0
        max_bpm = 180.0
        # Standard bar lengths to test (2, 4, 8, 16, 32)
        bar_lengths = [2, 4, 8, 16, 32]

        for bars in bar_lengths:
            assumed_beats = bars * 4.0
            assumed_bpm = assumed_beats / (duration_seconds / 60.0)
            if min_bpm <= assumed_bpm <= max_bpm:
                return float(assumed_bpm)

        # Secondary pass with wider range (70 to 200) if standard range yielded no result
        for bars in bar_lengths:
            assumed_beats = bars * 4.0
            assumed_bpm = assumed_beats / (duration_seconds / 60.0)
            if 70.0 <= assumed_bpm <= 200.0:
                return float(assumed_bpm)

        # Fallback default if none fit into range
        return 120.0
