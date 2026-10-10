import sqlite3
import os

conn = sqlite3.connect('gaia.db')
c = conn.cursor()

print("--- 808 SAMPLES ---")
c.execute("SELECT id, absolute_path FROM items WHERE absolute_path LIKE '%808%' ORDER BY id")
rows = c.fetchall()
print(f"Total 808s: {len(rows)}")
for r in rows:
    print(f"ID {r[0]:4d}: {os.path.basename(r[1])}")

print("\n--- KICK SAMPLES ---")
c.execute("SELECT id, absolute_path FROM items WHERE absolute_path LIKE '%Kick%' AND type = 'sample' ORDER BY id LIMIT 30")
for r in c.fetchall():
    print(f"ID {r[0]:4d}: {os.path.basename(r[1])}")

print("\n--- SNARE & CLAP SAMPLES ---")
c.execute("SELECT id, absolute_path FROM items WHERE (absolute_path LIKE '%Snare%' OR absolute_path LIKE '%Clap%' OR absolute_path LIKE '%Rim%') AND type = 'sample' ORDER BY id LIMIT 30")
for r in c.fetchall():
    print(f"ID {r[0]:4d}: {os.path.basename(r[1])}")

print("\n--- HAT SAMPLES ---")
c.execute("SELECT id, absolute_path FROM items WHERE (absolute_path LIKE '%Hat%' OR absolute_path LIKE '%Shaker%') AND type = 'sample' ORDER BY id LIMIT 30")
for r in c.fetchall():
    print(f"ID {r[0]:4d}: {os.path.basename(r[1])}")
