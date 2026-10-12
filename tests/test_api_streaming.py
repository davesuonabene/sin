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
        self.assertIn("metrics", last)
        self.assertIn("render_ms", last["metrics"])

    def test_progressive_binary_stream_endpoint(self):
        import struct
        import asyncio

        payload = AudioNodeModel(
            node_name="Binary Streaming Track",
            node_type="track",
            bpm=120.0,
            total_bars=2.0,
            filename="test_bin_stream",
        )
        response = sin_api.preview_graph_progressive(payload, format="binary")
        self.assertEqual(response.media_type, "application/octet-stream")

        async def consume_binary():
            frames = []
            async for raw in response.body_iterator:
                buf = raw if isinstance(raw, bytes) else raw.encode("latin1")
                # Parse 12-byte header
                while len(buf) >= 12:
                    magic, meta_len, audio_len = struct.unpack(">4sII", buf[:12])
                    self.assertEqual(magic, b"SINB")
                    total_len = 12 + meta_len + audio_len
                    self.assertLessEqual(total_len, len(buf))
                    meta_bytes = buf[12 : 12 + meta_len]
                    audio_bytes = buf[12 + meta_len : total_len]
                    meta = json.loads(meta_bytes.decode("utf-8"))
                    frames.append((meta, audio_bytes))
                    buf = buf[total_len:]
            return frames

        frames = asyncio.run(consume_binary())
        self.assertGreater(len(frames), 1)

        # Bar chunk verification
        first_meta, first_audio = frames[0]
        self.assertEqual(first_meta["chunk_type"], "bar")
        self.assertEqual(first_meta["bar_index"], 0)
        self.assertNotIn("audio_base64", first_meta)  # No base64 overhead!
        self.assertIn("peaks", first_meta)
        self.assertGreater(len(first_audio), 0)
        self.assertTrue(first_audio.startswith(b"RIFF"))  # Valid WAV byte data

        # Complete chunk verification
        last_meta, last_audio = frames[-1]
        self.assertEqual(last_meta["chunk_type"], "complete")
        self.assertEqual(len(last_audio), 0)
        self.assertIn("metrics", last_meta)
        self.assertIn("render_ms", last_meta["metrics"])
        self.assertIn("runtime_log", last_meta)


if __name__ == "__main__":
    unittest.main()
