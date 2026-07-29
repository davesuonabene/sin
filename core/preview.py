from typing import List, Dict, Any, Optional
from pydantic import BaseModel, Field


class TimelineMarker(BaseModel):
    """Represents a named timestamp marker on a timeline."""
    name: str = Field(..., description="Name or tag of the marker")
    timestamp: float = Field(..., ge=0.0, description="Position in seconds on the timeline")
    metadata: Dict[str, Any] = Field(default_factory=dict, description="Additional context or properties")


class PreviewTimeline(BaseModel):
    """
    Timeline utility for placing and visualizing named markers across an audio duration.
    """
    total_duration: float = Field(default=0.0, ge=0.0, description="Total duration of the timeline in seconds")
    markers: List[TimelineMarker] = Field(default_factory=list, description="Ordered list of timeline markers")

    def add_marker(self, name: str, timestamp: float, metadata: Optional[Dict[str, Any]] = None) -> TimelineMarker:
        """Place a named marker on the timeline."""
        if timestamp < 0:
            raise ValueError("Timestamp cannot be negative")
        marker = TimelineMarker(name=name, timestamp=timestamp, metadata=metadata or {})
        self.markers.append(marker)
        self.markers.sort(key=lambda m: m.timestamp)
        if timestamp > self.total_duration:
            self.total_duration = timestamp
        return marker

    def get_markers_at(self, timestamp: float, tolerance: float = 0.01) -> List[TimelineMarker]:
        """Find markers occurring around a specific timestamp."""
        return [m for m in self.markers if abs(m.timestamp - timestamp) <= tolerance]

    def render_ascii(self, width: int = 50) -> str:
        """Renders a simple ASCII visual timeline representation of the markers."""
        if self.total_duration <= 0:
            return "| (empty timeline) |"
        
        char_array = ["-"] * width
        for marker in self.markers:
            pos = int((marker.timestamp / self.total_duration) * (width - 1))
            pos = min(max(pos, 0), width - 1)
            char_array[pos] = "M"
        
        timeline_str = "".join(char_array)
        marker_details = ", ".join([f"{m.name}@{m.timestamp:.2f}s" for m in self.markers])
        return f"[{timeline_str}] (Total: {self.total_duration:.2f}s) | Markers: [{marker_details}]"
