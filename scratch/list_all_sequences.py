import sqlite3
import json
import os

conn = sqlite3.connect('gaia.db')
c = conn.cursor()
c.execute("PRAGMA table_info(items)")
cols = [col[1] for col in c.fetchall()]
print("Columns:", cols)

query = "SELECT id, " + (", ".join([c for c in ['title', 'filename', 'source_path', 'absolute_path', 'type', 'metadata_json'] if c in cols])) + " FROM items WHERE type = 'sequence' ORDER BY id"
c.execute(query)
rows = c.fetchall()
print(f"Total sequences: {len(rows)}")
for r in rows:
    print(r)
