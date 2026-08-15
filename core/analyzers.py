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

        # 2. Look for standalone/trailing numeric values that fit within reasonable BPM ranges (85-169)
        matches = re.findall(r'(?:^|[_\s-])(\d{2,3})(?=[._\s-]|$)', filename)
        for candidate in reversed(matches):
            val = float(candidate)
            if 85.0 <= val <= 169.0:
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
            if 85.0 <= bpm <= 169.0:
                return float(bpm)
        return None

    @staticmethod
    def from_duration(duration_seconds: float) -> float:
        """
        Calculates assumed BPM from duration by checking standard loop lengths (in bars).
        Returns assumed_bpm if within reasonable range (85 to 169), default 120.0 fallback.
        """
        if duration_seconds <= 0:
            return 120.0

        inferred = BPMAnalyzer.from_loop_duration(duration_seconds)
        return inferred if inferred is not None else 120.0


class KeyAnalyzer:
    """
    Extracts musical key from audio files using Chromagram pitch profile correlation
    (Krumhansl-Schmuckler key profile templates).
    """

    MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
    MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 2.69, 3.34, 3.17, 3.28]
    PITCH_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

    @classmethod
    def from_audio_file(
        cls,
        filepath: Union[str, Path],
        duration_limit: float = 30.0,
        pitch_only: bool = False,
    ) -> Optional[str]:
        """
        Analyzes audio signal using librosa chromagram and correlates with K-S key profiles.
        Returns a normalized key (e.g., 'Cmaj', 'Amin'), or only its dominant
        pitch class (e.g., 'C') for known single-note material.
        """
        try:
            import numpy as np
            import librosa

            path_str = str(filepath)
            if not Path(path_str).exists():
                return None

            duration = librosa.get_duration(path=path_str)
            if not duration or duration < 0.5:
                return None

            start_time = max(0.0, (duration / 2.0) - (duration_limit / 2.0))
            y, sr = librosa.load(path_str, sr=22050, mono=True, offset=start_time, duration=duration_limit)
            if len(y) == 0:
                return None

            # Spectral flatness threshold: skip high-flatness unpitched drums / white noise
            flatness = float(np.mean(librosa.feature.spectral_flatness(y=y)))
            if flatness > 0.4:
                return None

            chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
            chroma_mean = np.mean(chroma, axis=1)

            if np.max(chroma_mean) < 1e-4:
                return None

            chroma_mean /= np.sum(chroma_mean)

            sorted_chroma = np.sort(chroma_mean)
            dominant_share = float(sorted_chroma[-1])
            runner_up = float(sorted_chroma[-2]) if len(sorted_chroma) > 1 else 0.0
            is_single_pitch = dominant_share >= 0.5 and (runner_up <= 0.0 or dominant_share / runner_up >= 2.0)
            if pitch_only or is_single_pitch:
                return cls.PITCH_NAMES[int(np.argmax(chroma_mean))]

            best_corr = -1.0
            best_key = None
            major_prof = np.array(cls.MAJOR_PROFILE)
            minor_prof = np.array(cls.MINOR_PROFILE)

            for i in range(12):
                shifted_chroma = np.roll(chroma_mean, -i)
                corr_maj = float(np.corrcoef(shifted_chroma, major_prof)[0, 1])
                corr_min = float(np.corrcoef(shifted_chroma, minor_prof)[0, 1])

                if corr_maj > best_corr:
                    best_corr = corr_maj
                    best_key = f"{cls.PITCH_NAMES[i]}maj"
                if corr_min > best_corr:
                    best_corr = corr_min
                    best_key = f"{cls.PITCH_NAMES[i]}min"

            return best_key
        except Exception:
            return None
