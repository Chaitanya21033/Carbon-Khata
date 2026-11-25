"""The simulator and its controls must never be part of the product UI or product API."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _files(d, exts):
    return [p for p in (ROOT / d).rglob("*") if p.suffix in exts and "node_modules" not in p.parts]


def test_product_code_does_not_import_the_simulator():
    for p in _files("api/app", {".py"}):
        t = p.read_text(encoding="utf-8")
        assert "import simulator" not in t and "from simulator" not in t, p
    for p in _files("api/app", {".py"}):
        if p.parts[-2] != "seed":
            assert "demo_data" not in p.read_text(encoding="utf-8"), f"{p} uses dummy-data generators"


def test_web_has_no_demo_controls():
    for p in _files("web/src", {".ts", ".tsx"}):
        t = p.read_text(encoding="utf-8")
        for banned in ("ControlPanel", "/sim/cmd", ":5175", "SimEngine(", "inject("):
            assert banned not in t, f"{banned} found in {p}"
