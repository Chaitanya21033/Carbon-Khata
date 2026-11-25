import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
for p in (ROOT / "api", ROOT, ROOT / "sim"):
    sys.path.insert(0, str(p))
# Tests always run against the separate test database (they truncate it), never the demo database.
os.environ["DATABASE_URL"] = os.environ.get("TEST_DATABASE_URL") or "postgresql+psycopg://carbonkhata:carbonkhata@localhost:5432/carbonkhata_test"
assert os.environ["DATABASE_URL"].rstrip("/").endswith("_test"), "TEST_DATABASE_URL must point at a *_test database"
os.environ["MQTT_ENABLED"] = "false"
os.environ["SCHEDULER_ENABLED"] = "false"
os.environ["OPEN_METEO_ENABLED"] = "false"
