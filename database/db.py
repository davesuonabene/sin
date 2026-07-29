import sqlite3
from pathlib import Path
from typing import Union

DEFAULT_DB_PATH = Path("beat_generator.db")


def get_db_connection(db_path: Union[str, Path] = DEFAULT_DB_PATH) -> sqlite3.Connection:
    """
    Creates and returns a SQLite database connection with row factory enabled.
    """
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn


def init_db(db_path: Union[str, Path] = DEFAULT_DB_PATH) -> None:
    """
    Initializes the database schema for the audio objects library.
    """
    with get_db_connection(db_path) as conn:
        cursor = conn.cursor()
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS audio_objects (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                filepath TEXT,
                duration REAL DEFAULT 0.0,
                is_composite INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        conn.commit()
