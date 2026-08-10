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
        self.assertEqual(len(res["step_parameters"]), 16)
        print(f"Parsed MIDI: BPM={res['bpm']}, Key={res['key']}, sequence={res['sequence']}")

    def test_03_midi_roll_and_step_parameters(self):
        events = [
            {"beat": 0.0, "velocity": 127},
            {"beat": 0.125, "velocity": 64},
            {"beat": 0.5 - 0.025, "velocity": 100},
        ]
        sequence, parameters = midi_parser.build_step_sequence(events)

        self.assertEqual(sequence[0], 1)
        self.assertTrue(parameters[0]["subdivision_enabled"])
        self.assertEqual(parameters[0]["subdivisions"], 2)
        self.assertEqual(sequence[2], 1)
        self.assertAlmostEqual(parameters[2]["offset"], -0.1)
        self.assertAlmostEqual(parameters[2]["velocity"], 100 / 127, places=4)

    def test_04_off_grid_midi_roll_quantizes_to_step_boundary(self):
        events = [
            {"beat": 0.125, "velocity": 127},
            {"beat": 0.1875, "velocity": 127},
        ]

        sequence, parameters = midi_parser.build_step_sequence(events)

        self.assertEqual(sequence[0], 1)
        self.assertEqual(parameters[0]["offset"], 0.0)
        self.assertTrue(parameters[0]["subdivision_enabled"])
        self.assertEqual(parameters[0]["subdivisions"], 2)

if __name__ == "__main__":
    unittest.main()
