import sqlite3

conn = sqlite3.connect('gaia.db')
c = conn.cursor()

def verify_ids(id_list, name=""):
    missing = []
    found = []
    for i in id_list:
        c.execute("SELECT id, absolute_path, type FROM items WHERE id = ?", (i,))
        row = c.fetchone()
        if row:
            found.append((row[0], row[1], row[2]))
        else:
            missing.append(i)
    if missing:
        print(f"[{name}] WARNING: Missing IDs: {missing}")
    else:
        print(f"[{name}] All {len(found)} IDs verified in gaia.db!")
    return found

# Test candidate pools
melodic_drift = [1700, 1701, 2273, 1684, 857, 664, 628, 626, 630, 633, 648, 649, 655, 658]
melodic_tape = [628, 634, 651, 661, 669, 670, 677, 684, 691, 1658, 1700, 1701, 2273, 1684]
melodic_drip = [857, 664, 666, 678, 680, 682, 686, 1658, 2273, 1700, 1701, 1684, 626, 628]

verify_ids(melodic_drift, "Melodic Drift")
verify_ids(melodic_tape, "Melodic Tape")
verify_ids(melodic_drip, "Melodic Drip")

sub_808_pool = [3007, 3056, 3047, 3050, 3018, 3019, 3021, 3024, 3030, 3035, 3040, 3043, 3048, 3051, 3059, 7288]
verify_ids(sub_808_pool, "808 Sub Pool")

kick_pool = [352, 353, 354, 355, 356, 357, 358, 359, 360, 371, 376, 475, 3615]
verify_ids(kick_pool, "Kick Pool")

snare_pool = [1083, 1084, 1085, 1086, 1087, 1088, 1091, 1094, 127, 128, 129, 131, 135, 1173, 1174, 1179, 3157]
verify_ids(snare_pool, "Snare Pool")

hat_pool = [260, 261, 262, 263, 264, 265, 267, 268, 270, 271, 274, 278, 279, 280, 323, 188, 3711, 3712]
verify_ids(hat_pool, "Hi-Hat Pool")

# Sequences
pattern_kick = [7354, 7355, 7356, 7364, 7267, 7272]
pattern_snare = [7357, 7358, 7359, 7365, 7268, 7270, 7283]
pattern_hat = [7360, 7361, 7362, 7366, 7269, 7281, 7282, 7285]
pattern_808 = [7354, 7356, 7274, 7276, 7279]

verify_ids(pattern_kick, "Kick Pattern Pool")
verify_ids(pattern_snare, "Snare Pattern Pool")
verify_ids(pattern_hat, "Hi-Hat Pattern Pool")
verify_ids(pattern_808, "808 Pattern Pool")
