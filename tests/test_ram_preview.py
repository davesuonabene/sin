import unittest
import os
from api import preview_graph_ram, stream_ram_preview, export_ram_preview, AudioNodeModel, RAM_PREVIEW_STORE

class TestRamPreviewApi(unittest.TestCase):
    def test_preview_ram_and_stream(self):
        payload = AudioNodeModel(
            node_name="TestRamNode",
            node_type="sample",
            filepath="assets/KULTURE_LIQDNB1_DRUM_LOOP_25_171.wav",
            bpm=120.0,
            filename="export_123"
        )
        res = preview_graph_ram(payload)
        self.assertEqual(res["status"], "success")
        self.assertIn("audio_url", res)

        preview_id = res["preview_id"]
        self.assertIn(preview_id, RAM_PREVIEW_STORE)

        # Stream audio from RAM
        stream_resp = stream_ram_preview(preview_id)
        self.assertEqual(stream_resp.media_type, "audio/wav")
        self.assertGreater(len(stream_resp.body), 0)

        # Export audio from RAM to disk
        export_res = export_ram_preview(preview_id, payload)
        self.assertEqual(export_res["status"], "success")

        exported_file = os.path.join("export", export_res["filename"])
        self.assertTrue(os.path.exists(exported_file))

        # Cleanup created test export file
        if os.path.exists(exported_file):
            try:
                os.remove(exported_file)
            except Exception:
                pass

if __name__ == '__main__':
    unittest.main()
