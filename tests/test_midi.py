import os
import unittest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from gaia import models, schemas, crud, midi_parser

class TestMidiFunctionality(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engine = create_engine("sqlite:///:memory:")
        models.Base.metadata.create_all(bind=cls.engine)
        cls.Session = sessionmaker(bind=cls.engine)

    def test_01_midi_item_crud(self):
        db = self.Session()
        try:
            midi_schema = schemas.MidiItemCreate(
                absolute_path="assets/Midi 2.mid",
                file_hash="dummyhash123",
                size_bytes=920,
                mime_type="audio/midi",
                type="midi",
                bpm=130,
                key="C"
            )
            item = crud.create_item(db, midi_schema)
            self.assertIsNotNone(item.id)
            self.assertEqual(item.type, "midi")
            self.assertEqual(item.bpm, 130)
            self.assertEqual(item.key, "C")
            self.assertTrue(isinstance(item, models.MidiItem))

            fetched = crud.get_item(db, item.id)
            self.assertEqual(fetched.absolute_path, "assets/Midi 2.mid")
            self.assertEqual(fetched.type, "midi")
        finally:
            db.close()

    def test_02_midi_parser(self):
        midi_path = os.path.join("assets", "Midi 2.mid")
        self.assertTrue(os.path.exists(midi_path), f"File {midi_path} should exist")

        res = midi_parser.parse_midi_file(midi_path)
        self.assertEqual(res["bpm"], 130)
        self.assertIn("sequence", res)
        self.assertEqual(len(res["sequence"]), 16)
        self.assertTrue(len(res["note_events"]) > 0)
        print(f"Parsed MIDI: BPM={res['bpm']}, Key={res['key']}, sequence={res['sequence']}")

if __name__ == "__main__":
    unittest.main()
