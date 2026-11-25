import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
for p in (ROOT / "api", ROOT, ROOT / "sim"):
    sys.path.insert(0, str(p))
os.environ.setdefault("DATABASE_URL", os.environ.get("TEST_DATABASE_URL", "postgresql+psycopg://carbonkhata:carbonkhata@localhost:5432/carbonkhata_test"))
os.environ["MQTT_ENABLED"] = "false"
os.environ["SCHEDULER_ENABLED"] = "false"
os.environ["OPEN_METEO_ENABLED"] = "false"
