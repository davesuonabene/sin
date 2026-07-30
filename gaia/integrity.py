import hashlib
import os

def calculate_file_hash(file_path: str, chunk_size: int = 8192) -> str:
    """Calculates the SHA-256 hash of a file."""
    sha256_hash = hashlib.sha256()
    try:
        with open(file_path, "rb") as f:
            for byte_block in iter(lambda: f.read(chunk_size), b""):
                sha256_hash.update(byte_block)
        return sha256_hash.hexdigest()
    except FileNotFoundError:
        return ""

def verify_file_integrity(file_path: str, expected_hash: str) -> bool:
    """Verifies if the file at file_path matches the expected hash."""
    if not os.path.exists(file_path):
        return False
    current_hash = calculate_file_hash(file_path)
    return current_hash == expected_hash

def get_file_metadata(file_path: str):
    """Returns basic metadata like size for the file."""
    if not os.path.exists(file_path):
        return None
    
    stat_info = os.stat(file_path)
    return {
        "size_bytes": stat_info.st_size,
        # Further metadata extraction (like mime type) could be added here
    }
