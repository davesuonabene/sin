import struct
import os
import math
from typing import Dict, Any, List, Optional

KEY_SIGNATURES_MAJOR = {
    0: "C", 1: "G", 2: "D", 3: "A", 4: "E", 5: "B", 6: "F#", 7: "C#",
    -1: "F", -2: "Bb", -3: "Eb", -4: "Ab", -5: "Db", -6: "Gb", -7: "Cb"
}

KEY_SIGNATURES_MINOR = {
    0: "Am", 1: "Em", 2: "Bm", 3: "F#m", 4: "C#m", 5: "G#m", 6: "D#m", 7: "A#m",
    -1: "Dm", -2: "Gm", -3: "Cm", -4: "Fm", -5: "Bbm", -6: "Ebm", -7: "Abm"
}

DEFAULT_STEP_PARAMETER = {
    "offset": 0.0,
    "velocity": 1.0,
    "probability": 100.0,
    "subdivision_enabled": False,
    "subdivisions": 1,
}


def build_step_sequence(note_events: List[Dict[str, Any]], step_count: int = 16) -> tuple[List[int], List[Dict[str, Any]]]:
    """Map MIDI onsets to a one-bar grid while retaining timing and roll information."""
    sequence = [0] * step_count
    parameters = [dict(DEFAULT_STEP_PARAMETER) for _ in range(step_count)]
    if not note_events:
        return sequence, parameters

    grouped: Dict[int, List[tuple[float, int]]] = {}
    for event in note_events:
        step_position = (float(event.get("beat", 0.0)) * 4.0) % step_count
        floor_step = int(math.floor(step_position + 1e-9))
        fractional = step_position - floor_step

        # Multiple onsets inside one sixteenth are a roll. A lone off-grid onset
        # belongs to its nearest step so imported timing may be negative or positive.
        grouped.setdefault(floor_step % step_count, []).append((fractional, int(event.get("velocity", 127))))

    for floor_step, events in grouped.items():
        unique_positions = sorted({round(position, 5) for position, _ in events})
        is_roll = len(unique_positions) > 1
        if is_roll:
            step_idx = floor_step
            # A roll is quantized to the parent step. Its individual triggers are
            # generated as equal partitions by the audio processor; carrying the
            # first MIDI onset as an offset shifts the whole roll and can spill its
            # final trigger into the following step.
            offset = 0.0
            subdivision_count = min(16, len(unique_positions))
        else:
            absolute_position = floor_step + unique_positions[0]
            nearest = int(math.floor(absolute_position + 0.5))
            step_idx = nearest % step_count
            offset = absolute_position - nearest
            subdivision_count = 1

        sequence[step_idx] = 1
        velocities = [velocity for _, velocity in events]
        parameters[step_idx] = {
            "offset": round(max(-1.0, min(1.0, offset)), 5),
            "velocity": round(max(0.0, min(1.0, sum(velocities) / len(velocities) / 127.0)), 5),
            "probability": 100.0,
            "subdivision_enabled": is_roll,
            "subdivisions": subdivision_count,
        }

    return sequence, parameters

def read_varlen(data: bytes, offset: int) -> tuple[int, int]:
    """Reads a variable-length quantity from binary MIDI data."""
    value = 0
    bytes_read = 0
    while offset < len(data):
        byte = data[offset]
        offset += 1
        bytes_read += 1
        value = (value << 7) | (byte & 0x7F)
        if not (byte & 0x80):
            break
    return value, bytes_read

def parse_midi_file(filepath: str) -> Dict[str, Any]:
    """
    Parses a Standard MIDI File (.mid) and extracts metadata:
    - bpm (int)
    - key (str)
    - tracks_count (int)
    - sequence (List[int]): 16-step binary step array
    - step_parameters (List[dict]): timing, velocity, probability, and roll data
    - note_events (List[dict]): Raw parsed note events
    """
    if not os.path.exists(filepath):
        return {"bpm": None, "key": None, "sequence": [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], "step_parameters": [dict(DEFAULT_STEP_PARAMETER) for _ in range(16)], "note_events": []}

    try:
        with open(filepath, "rb") as f:
            data = f.read()

        if len(data) < 14 or data[:4] != b"MThd":
            return {"bpm": None, "key": None, "sequence": [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], "step_parameters": [dict(DEFAULT_STEP_PARAMETER) for _ in range(16)], "note_events": []}

        header_length = struct.unpack(">I", data[4:8])[0]
        fmt, n_tracks, division = struct.unpack(">HHH", data[8:14])

        bpm: Optional[int] = None
        key: Optional[str] = None
        note_events: List[Dict[str, Any]] = []

        offset = 8 + header_length
        for _ in range(n_tracks):
            if offset + 8 > len(data):
                break
            if data[offset:offset+4] != b"MTrk":
                break

            track_len = struct.unpack(">I", data[offset+4:offset+8])[0]
            track_data = data[offset+8 : offset+8+track_len]
            offset += 8 + track_len

            # Parse track events
            track_ptr = 0
            abs_ticks = 0
            running_status = None

            while track_ptr < len(track_data):
                delta, b_read = read_varlen(track_data, track_ptr)
                track_ptr += b_read
                abs_ticks += delta

                if track_ptr >= len(track_data):
                    break

                status = track_data[track_ptr]

                if status == 0xFF: # Meta event
                    track_ptr += 1
                    meta_type = track_data[track_ptr]
                    track_ptr += 1
                    meta_len, b_read = read_varlen(track_data, track_ptr)
                    track_ptr += b_read

                    meta_bytes = track_data[track_ptr : track_ptr + meta_len]
                    track_ptr += meta_len

                    if meta_type == 0x51 and len(meta_bytes) >= 3: # Set Tempo
                        mpqn = (meta_bytes[0] << 16) | (meta_bytes[1] << 8) | meta_bytes[2]
                        if mpqn > 0:
                            bpm = round(60_000_000 / mpqn)
                    elif meta_type == 0x59 and len(meta_bytes) >= 2: # Key Signature
                        sf = struct.unpack("b", bytes([meta_bytes[0]]))[0]
                        mi = meta_bytes[1]
                        if mi == 1:
                            key = KEY_SIGNATURES_MINOR.get(sf, None)
                        else:
                            key = KEY_SIGNATURES_MAJOR.get(sf, None)

                elif status == 0xF0 or status == 0xF7: # SysEx event
                    track_ptr += 1
                    sysex_len, b_read = read_varlen(track_data, track_ptr)
                    track_ptr += b_read + sysex_len

                else:
                    if status & 0x80:
                        running_status = status
                        track_ptr += 1
                    else:
                        status = running_status

                    if status is None:
                        break

                    cmd = status & 0xF0
                    channel = status & 0x0F

                    if cmd in (0x80, 0x90, 0xA0, 0xB0, 0xE0):
                        if track_ptr + 2 > len(track_data):
                            break
                        param1 = track_data[track_ptr]
                        param2 = track_data[track_ptr + 1]
                        track_ptr += 2

                        if cmd == 0x90 and param2 > 0: # Note On
                            beat = abs_ticks / float(division) if division > 0 else 0
                            note_events.append({
                                "pitch": param1,
                                "velocity": param2,
                                "channel": channel,
                                "ticks": abs_ticks,
                                "beat": beat
                            })

                    elif cmd in (0xC0, 0xD0):
                        track_ptr += 1

        sequence, step_parameters = build_step_sequence(note_events)

        return {
            "bpm": bpm,
            "key": key,
            "tracks_count": n_tracks,
            "sequence": sequence if any(sequence) else [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
            "step_parameters": step_parameters,
            "note_events": note_events
        }
    except Exception as e:
        import logging
        logging.getLogger("beat_generator.gaia").warning(f"Error parsing MIDI file {filepath}: {e}")
        return {"bpm": None, "key": None, "sequence": [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], "step_parameters": [dict(DEFAULT_STEP_PARAMETER) for _ in range(16)], "note_events": []}
