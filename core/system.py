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
        root_object: Optional[AudioObject] = None,
        render_mode: str = "offline",
    ) -> None:
        self.bpm = float(bpm)
        self.sample_rate = int(sample_rate)
        self.root_object = root_object
        self.render_mode = str(render_mode or "offline").lower()
        self.manifest: dict = {"nodes": {}}

    def record_node_stem(
        self,
        node_id: int,
        node_type: str,
        node_name: str,
        audio_array: np.ndarray,
        duration_seconds: float,
        extra: Optional[dict] = None
    ) -> None:
        if node_id is None or self.render_mode != "preview":
            return
        node_entry = self.manifest["nodes"].setdefault(str(node_id), {
            "node_id": node_id,
            "node_type": node_type,
            "node_name": node_name,
            "duration_seconds": float(duration_seconds),
            "events": []
        })
        node_entry["duration_seconds"] = float(duration_seconds)
        if extra:
            node_entry.update(extra)
        # Store numpy buffer for composite and sequence nodes that require intermediate stem encoding.
        if node_type in ("track", "master", "bus", "arrangement", "sequence"):
            if not hasattr(self, "_node_stems"):
                self._node_stems = {}
            self._node_stems[str(node_id)] = audio_array

    def record_node_event(self, node_id: int, event: dict) -> None:
        if node_id is None or self.render_mode != "preview":
            return
        node_entry = self.manifest["nodes"].setdefault(str(node_id), {
            "node_id": node_id,
            "events": []
        })
        node_entry.setdefault("events", []).append(event)

    def capture_manifest_state(
        self,
        allowed_node_ids: Optional[set[str]] = None,
        base_offset_sec: float = 0.0,
    ) -> dict:
        import copy
        manifest_nodes = self.manifest.get("nodes", {})
        node_stems = getattr(self, "_node_stems", {})
        offset = float(base_offset_sec or 0.0)

        def _copy_and_normalize_entry(nentry: dict) -> dict:
            copied = copy.deepcopy(nentry)
            if "events" in copied and isinstance(copied["events"], list):
                rel_events = []
                for evt in copied["events"]:
                    if not isinstance(evt, dict):
                        continue
                    evt_t = float(evt.get("time", 0.0))
                    if evt_t >= offset - 1e-5:
                        evt_c = dict(evt)
                        evt_c["time"] = round(max(0.0, evt_t - offset), 4)
                        rel_events.append(evt_c)
                copied["events"] = rel_events
            return copied

        if allowed_node_ids is not None:
            return {
                "normalized_offset": True,
                "manifest_nodes": {
                    nid: _copy_and_normalize_entry(nentry)
                    for nid, nentry in manifest_nodes.items()
                    if str(nid) in allowed_node_ids
                },
                "node_stems": {
                    nid: stem
                    for nid, stem in node_stems.items()
                    if str(nid) in allowed_node_ids
                },
            }
        return {
            "normalized_offset": True,
            "manifest_nodes": {
                nid: _copy_and_normalize_entry(nentry)
                for nid, nentry in manifest_nodes.items()
            },
            "node_stems": node_stems.copy(),
        }

    def restore_manifest_state(self, state: dict, target_offset_sec: float = 0.0) -> None:
        if not state or not isinstance(state, dict):
            return
        import copy
        manifest_nodes = state.get("manifest_nodes", {})
        is_normalized = bool(state.get("normalized_offset", False))
        offset = float(target_offset_sec or 0.0) if is_normalized else 0.0

        for nid, nentry in manifest_nodes.items():
            if nid not in self.manifest.setdefault("nodes", {}):
                copied_entry = copy.deepcopy(nentry)
                if offset != 0.0 and isinstance(copied_entry.get("events"), list):
                    for evt in copied_entry["events"]:
                        if isinstance(evt, dict) and "time" in evt:
                            evt["time"] = round(float(evt["time"]) + offset, 4)
                self.manifest["nodes"][nid] = copied_entry
            else:
                existing = self.manifest["nodes"][nid]
                for k, v in nentry.items():
                    if k == "events":
                        existing_events = existing.setdefault("events", [])
                        for evt in v:
                            evt_copy = copy.deepcopy(evt)
                            if offset != 0.0 and isinstance(evt_copy, dict) and "time" in evt_copy:
                                evt_copy["time"] = round(float(evt_copy["time"]) + offset, 4)
                            if evt_copy not in existing_events:
                                existing_events.append(evt_copy)
                    elif k not in existing:
                        existing[k] = copy.deepcopy(v)

        stems = state.get("node_stems", {})
        if stems:
            if not hasattr(self, "_node_stems"):
                self._node_stems = {}
            self._node_stems.update(stems)

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

    @property
    def samples_per_bar(self) -> int:
        """Calculates audio samples in 1 4/4 musical bar."""
        return self.beat_to_samples(4.0)

    @property
    def seconds_per_bar(self) -> float:
        """Calculates duration in seconds of 1 4/4 musical bar."""
        return 4.0 * (60.0 / (self.bpm or 120.0))

    def bar_to_sample_range(self, bar_index: int, num_bars: int = 1) -> tuple[int, int]:
        """Calculates (start_sample, end_sample) for a given bar slice."""
        s = self.beat_to_samples(bar_index * 4.0)
        e = self.beat_to_samples((bar_index + num_bars) * 4.0)
        return s, e

    def render(self) -> np.ndarray:
        """
        Triggers rendering of the root AudioObject node graph and returns the final mixed audio array.
        """
        if self.root_object is None:
            return np.zeros(0, dtype=np.float32)
        return self.root_object.render(self)

    def render_bar(self, bar_index: int) -> np.ndarray:
        """
        Renders or extracts a 1-bar audio slice at bar_index.
        """
        full_audio = self.render()
        s, e = self.bar_to_sample_range(bar_index, 1)
        needed = self.samples_per_bar
        if full_audio.size == 0 or s >= full_audio.shape[-1]:
            channels = full_audio.shape[:-1] if full_audio.ndim > 1 else ()
            return np.zeros((*channels, needed), dtype=np.float32)
        slice_audio = full_audio[..., s:min(e, full_audio.shape[-1])]
        if slice_audio.shape[-1] < needed:
            pad = np.zeros((*slice_audio.shape[:-1], needed - slice_audio.shape[-1]), dtype=np.float32)
            slice_audio = np.concatenate([slice_audio, pad], axis=-1)
        return slice_audio
