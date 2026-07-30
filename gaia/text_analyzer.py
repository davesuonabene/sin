import re
import os

def extract_bpm(text: str) -> str | None:
    """Extracts BPM from text (e.g., '120bpm', '120 bpm')."""
    match = re.search(r'(?<!\d)(\d{2,3})\s*bpm\b', text, re.IGNORECASE)
    if match:
        return match.group(1)
    return None

def extract_key(text: str) -> str | None:
    """Extracts musical key from text (Standard or Camelot)."""
    # Try Camelot first (e.g., 1A, 12B)
    camelot_match = re.search(r'\b(1[0-2]|[1-9])[ab]\b', text, re.IGNORECASE)
    if camelot_match:
        return camelot_match.group(0).upper()
    
    # Try Standard keys (e.g., Cmin, F#maj, Am)
    # [a-g] followed optionally by # or b, followed by min/maj/m/M (not mix)
    standard_match = re.search(r'\b([a-g][#b]?\s*(?:min|maj|minor|major|m(?![ix])))\b', text, re.IGNORECASE)
    if standard_match:
        return standard_match.group(0).capitalize()
    
    return None

def detect_type(text: str, has_bpm: bool) -> str:
    """Determines if the sample is a loop or one-shot based on name/path."""
    text_lower = text.lower()
    
    # Explicit words for loops
    if 'loop' in text_lower:
        return 'loop'
        
    # Explicit words for one-shots
    one_shot_keywords = ['one shot', 'oneshot', ' os ', '_os_', '-os-']
    for kw in one_shot_keywords:
        if kw in text_lower:
            return 'one_shot'
            
    # If it has a BPM, it's very likely a loop
    if has_bpm:
        return 'loop'
        
    # Drum hits are usually one-shots if not explicitly labeled as loops
    drum_hit_keywords = ['kick', 'snare', 'hat', 'clap', 'crash', 'cymbal']
    if any(kw in text_lower for kw in drum_hit_keywords):
        return 'one_shot'
        
    return 'sample' # Default fallback

def detect_category(text: str) -> str:
    """Categorizes the sample into Drums, Bass, Vocals, or Other."""
    text_lower = text.lower()
    
    if any(kw in text_lower for kw in ['drum', 'kick', 'snare', 'hat', 'cymbal', 'perc', 'top', 'shaker', 'clap', 'break']):
        return 'Drums'
    if any(kw in text_lower for kw in ['bass', '808', 'sub', 'reese']):
        return 'Bass'
    if any(kw in text_lower for kw in ['vocal', 'vox', 'acapella', 'choir', 'voice', 'sing']):
        return 'Vocals'
        
    return 'Other'

def analyze_path(absolute_path: str) -> dict:
    """Analyzes a file path and returns extracted metadata."""
    path_parts = absolute_path.replace('/', os.sep).split(os.sep)
    # Get last 3 parts (e.g. category/bpm_folder/file.wav) for context
    context_parts = path_parts[-3:] if len(path_parts) >= 3 else path_parts
    search_text = " ".join(context_parts)
    
    # Replace common separators with spaces to help regex word boundaries
    search_text = search_text.replace('_', ' ').replace('-', ' ')
    
    bpm = extract_bpm(search_text)
    key = extract_key(search_text)
    sample_type = detect_type(search_text, bool(bpm))
    category = detect_category(search_text)
    
    return {
        "bpm": bpm,
        "key": key,
        "type": sample_type,
        "category": category
    }
