import unittest
import numpy as np
from core.dag_cache import DagNodeCache, compute_waveform_peaks


class TestDagNodeCache(unittest.TestCase):
    def setUp(self):
        self.cache = DagNodeCache()

    def test_store_and_retrieve(self):
        audio = np.array([0.1, 0.2, 0.3], dtype=np.float32)
        fp = "fingerprint_1"
        self.cache.store("10", fp, audio)
        retrieved = self.cache.get("10", fp)
        self.assertIsNotNone(retrieved)
        np.testing.assert_array_equal(retrieved, audio)

    def test_get_stale_fingerprint_returns_none(self):
        audio = np.array([0.1, 0.2], dtype=np.float32)
        self.cache.store("10", "old_hash", audio)
        self.assertIsNone(self.cache.get("10", "new_hash"))

    def test_downstream_invalidation(self):
        # Topology: 1 (sample) -> 2 (track) -> 3 (master)
        #           4 (sample) -> 2 (track)
        self.cache.register_edge(parent_id="2", child_id="1")
        self.cache.register_edge(parent_id="2", child_id="4")
        self.cache.register_edge(parent_id="3", child_id="2")

        self.cache.store("1", "h1", np.ones(10))
        self.cache.store("4", "h4", np.ones(10))
        self.cache.store("2", "h2", np.ones(10))
        self.cache.store("3", "h3", np.ones(10))

        # Modifying node 1 should invalidate 1, 2, and 3, but keep 4 intact!
        invalidated = self.cache.invalidate_downstream("1")
        self.assertEqual(invalidated, {"1", "2", "3"})

        self.assertIsNone(self.cache.get("1", "h1"))
        self.assertIsNone(self.cache.get("2", "h2"))
        self.assertIsNone(self.cache.get("3", "h3"))
        # Node 4 remains cached!
        self.assertIsNotNone(self.cache.get("4", "h4"))

    def test_clear_wipes_all_entries(self):
        self.cache.store("1", "h1", np.ones(5))
        self.cache.register_edge("2", "1")
        self.cache.clear()
        self.assertEqual(len(self.cache), 0)
        self.assertIsNone(self.cache.get("1", "h1"))

    def test_compute_waveform_peaks(self):
        audio = np.array([0.5, -0.8, 0.2, -0.1, 0.9, -0.4], dtype=np.float32)
        peaks = compute_waveform_peaks(audio, columns=3)
        self.assertEqual(len(peaks), 6)  # 3 columns * 2 (min, max)


    def test_end_to_end_graph_caching(self):
        from core.system import System
        from core.audio_object import AudioObject
        from core.dag_cache import GLOBAL_DAG_CACHE

        GLOBAL_DAG_CACHE.clear()

        s1 = AudioObject(audio_data=np.ones(100, dtype=np.float32), node_id=1)
        s1.fingerprint = "fp1"
        s2 = AudioObject(audio_data=np.ones(100, dtype=np.float32) * 2.0, node_id=2)
        s2.fingerprint = "fp2"

        parent = AudioObject(node_id=3)
        parent.fingerprint = "fp3"
        parent.add_child(s1, 0.0)
        parent.add_child(s2, 0.0)

        sys = System(bpm=120)
        res1 = parent.render(sys)
        self.assertEqual(len(GLOBAL_DAG_CACHE), 3)

        # Invalidate only node 1
        GLOBAL_DAG_CACHE.invalidate_downstream(1)
        self.assertIsNone(GLOBAL_DAG_CACHE.get(1, "fp1"))
        self.assertIsNone(GLOBAL_DAG_CACHE.get(3, "fp3"))
        # Node 2 must remain in cache!
        self.assertIsNotNone(GLOBAL_DAG_CACHE.get(2, "fp2"))

        GLOBAL_DAG_CACHE.clear()


if __name__ == "__main__":
    unittest.main()
