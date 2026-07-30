import sys
import os
from gaia.database import SessionLocal
from gaia import models, schemas, crud

models.Base.metadata.create_all(bind=models.database.engine)
db = SessionLocal()

try:
    item_schema = schemas.ItemCreate(absolute_path="C:/test/path1.wav", size_bytes=100, type="audio")
    item = crud.create_item(db, item_schema)
    print("Created audio item with ID:", item.id)

    track_schema = schemas.ItemCreate(absolute_path="C:/test/path2.wav", size_bytes=200, type="track")
    track = crud.create_item(db, track_schema)
    print("Created track item with ID:", track.id)

    # verify polymorphic fetch
    fetched_items = crud.get_items(db)
    for i in fetched_items:
        print(i.id, i.type, type(i))
finally:
    db.close()
