import unittest
import json
from unittest.mock import MagicMock
import numpy as np
from ermes import AudioNodeModel
from core.dag_cache import GLOBAL_DAG_CACHE
import api as sin_api


class TestApiStreaming(unittest.TestCase):
    def setUp(self):
        GLOBAL_DAG_CACHE.clear()
        sin_api.RAM_PREVIEW_STORE.clear()

    def test_invalidate_endpoint(self):
        GLOBAL_DAG_CACHE.register_edge("2", "1")
        GLOBAL_DAG_CACHE.store("1", "h1", np.ones(5))
        GLOBAL_DAG_CACHE.store("2", "h2", np.ones(5))

        req = sin_api.InvalidateNodesRequest(node_ids=["1"])
        res = sin_api.invalidate_graph_nodes(req)
        self.assertEqual(res["status"], "success")
        self.assertIn("1", res["invalidated"])
        self.assertIn("2", res["invalidated"])
        self.assertEqual(len(GLOBAL_DAG_CACHE), 0)

    def test_progressive_stream_endpoint(self):
        payload = AudioNodeModel(
            node_name="Streaming Track",
            node_type="track",
            bpm=120.0,
            total_bars=2.0,
            filename="test_stream",
        )
        response = sin_api.preview_graph_progressive(payload)
        self.assertEqual(response.media_type, "application/x-ndjson")

        import asyncio

        async def consume():
            res = []
            async for line in response.body_iterator:
                line_str = line.decode("utf-8").strip() if isinstance(line, bytes) else line.strip()
                if line_str:
                    res.append(json.loads(line_str))
            return res

        chunks = asyncio.run(consume())

        self.assertGreater(len(chunks), 1)
        # First chunk should be bar 0
        first = chunks[0]
        self.assertEqual(first["chunk_type"], "bar")
        self.assertEqual(first["bar_index"], 0)
        self.assertIn("audio_base64", first)
        self.assertIn("peaks", first)

        # Last chunk should be complete
        last = chunks[-1]
        self.assertEqual(last["chunk_type"], "complete")
        self.assertIn("audio_url", last)


if __name__ == "__main__":
    unittest.main()
