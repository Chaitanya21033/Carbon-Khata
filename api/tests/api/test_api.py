"""API tests: OTP auth, tenancy (OEM A cannot see OEM B), idempotency, reversal, month close, held entries,
factor versioning, public pages, FMCG recall, cluster lines. Runs against the test database (seeded fresh)."""
import datetime as dt
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

API = Path(__file__).resolve().parents[2]


@pytest.fixture(scope="module")
def client():
    subprocess.run([sys.executable, "-m", "alembic", "upgrade", "head"], cwd=API, check=True, capture_output=True)
    from app.seed.run import seed, truncate_all
    truncate_all()
    seed()
    from app.main import app
    with TestClient(app) as c:
        yield c


def login(c, email):
    code = c.post("/api/v1/auth/otp/request", json={"email": email}).json()["devCode"]
    r = c.post("/api/v1/auth/otp/verify", json={"email": email, "code": code})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


DEV = {"X-Device-Key": "dev-key-vbw"}
AFL = {"X-Device-Key": "dev-key-afl"}
CLU = {"X-Device-Key": "dev-key-cluster"}


def test_otp_wrong_code_rejected(client):
    client.post("/api/v1/auth/otp/request", json={"email": "priya@vardhan.example"})
    assert client.post("/api/v1/auth/otp/verify", json={"email": "priya@vardhan.example", "code": "000000x"}).status_code == 401
    assert client.get("/api/v1/workspace").status_code == 401


def test_roles_enforced(client):
    op = login(client, "ramesh@vardhan.example")
    assert client.post("/api/v1/ledger/lines/correct", headers=op, json={"registerId": "DIESEL", "month": "2025-01", "line": "issued", "qty": 1, "reason": "x"}).status_code == 403
    coord = login(client, "coordinator@adityapur.example")
    assert client.get("/api/v1/ledger/entries", headers=coord).status_code == 403


def test_idempotency_same_key_twice_is_one_entry(client):
    h = login(client, "priya@vardhan.example")
    body = {"registerId": "DIESEL", "line": "issued", "qty": 40, "docRef": "SLIP-IDEM-1", "month": "2026-11"}
    a = client.post("/api/v1/ledger/entries", headers={**h, "Idempotency-Key": "idem-1"}, json=body).json()
    b = client.post("/api/v1/ledger/entries", headers={**h, "Idempotency-Key": "idem-1"}, json=body).json()
    assert a["result"] == "posted" and b["result"] == "duplicate" and a["entry"]["id"] == b["entry"]["id"]
    n = [e for e in client.get("/api/v1/ledger/entries?register=DIESEL&month=2026-11", headers=h).json() if e.get("docRef") == "SLIP-IDEM-1"]
    assert len(n) == 1


def test_held_entry_never_reaches_emissions_until_confirmed(client):
    h = login(client, "priya@vardhan.example")
    before = client.get("/api/v1/workspace", headers=h).json()
    r = client.post("/api/v1/ledger/entries", headers={**h, "Idempotency-Key": "held-1"}, json={"registerId": "DIESEL", "line": "issued", "qty": 4000, "docRef": "SLIP-HELD-1", "month": "2026-11"}).json()
    assert r["result"] == "held" and r["hold"]["rule"] == "V01"
    ws = client.get("/api/v1/workspace", headers=h).json()
    assert not any(e["id"] == r["entry"]["id"] for e in ws["entries"])
    assert any(x["id"] == r["entry"]["id"] for x in ws["held"])
    d = client.post(f"/api/v1/validation/held/{r['entry']['id']}/decide", headers=h, json={"action": "fix", "value": 40}).json()
    assert d["result"] == "posted"
    after = [e for e in client.get("/api/v1/ledger/entries?register=DIESEL&month=2026-11", headers=h).json() if e.get("docRef") == "SLIP-HELD-1"]
    assert [e["qty"] for e in after if e["status"] == "posted"] == [40]


def test_historic_blocking_issue_excluded_from_reports(client):
    h = login(client, "priya@vardhan.example")
    q = client.get("/api/v1/validation/queue", headers=h).json()
    v01 = [i for i in q["issues"] if i["rule"] == "V01"]
    assert v01 and all(i["status"] == "open" for i in v01)


def test_reversal_requires_reason_and_negates(client):
    h = login(client, "priya@vardhan.example")
    e = client.post("/api/v1/ledger/entries", headers={**h, "Idempotency-Key": "rev-1"}, json={"registerId": "PAINT", "line": "issued", "qty": 22, "docRef": "SLIP-REV-1", "month": "2026-11"}).json()["entry"]
    assert client.post(f"/api/v1/ledger/entries/{e['id']}/reverse", headers=h, json={"reason": " "}).status_code == 422
    r = client.post(f"/api/v1/ledger/entries/{e['id']}/reverse", headers=h, json={"reason": "Wrong slip"}).json()
    assert r["reversal"]["qty"] == -22 and r["reversal"]["reversesId"] == e["id"]


def test_month_close_blocked_then_allowed(client):
    pr, ow = login(client, "priya@vardhan.example"), login(client, "owner@vardhan.example")
    m = "2025-03"  # V01 (HR sheet extra zero) blocks close
    r = client.post(f"/api/v1/periods/{m}/close", headers=pr, json={"action": "submit"})
    assert r.status_code == 409
    q = client.get("/api/v1/validation/queue", headers=pr).json()
    for i in [i for i in q["issues"] if i["month"] == m and i["blocksClose"]]:
        assert client.post(f"/api/v1/validation/issues/{i['id']}/decide", headers=pr, json={"status": "accepted", "note": "Checked against invoice"}).status_code == 200
    assert client.post(f"/api/v1/periods/{m}/close", headers=pr, json={"action": "submit"}).json()["status"] == "in_review"
    assert client.post(f"/api/v1/periods/{m}/close", headers=pr, json={"action": "approve"}).status_code == 403
    assert client.post(f"/api/v1/periods/{m}/close", headers=ow, json={"action": "approve"}).json()["status"] == "closed"
    assert client.post("/api/v1/ledger/entries", headers=pr, json={"registerId": "DIESEL", "line": "issued", "qty": 1, "month": m}).status_code == 409


def test_factor_change_creates_version_past_months_keep_old(client):
    ad, pr = login(client, "ops@carbonkhata.example"), login(client, "priya@vardhan.example")
    before = {r["month"]: r for r in client.get("/api/v1/workspace", headers=pr).json()["derived"]["emissions"]}
    fs = client.post("/api/v1/factors", headers=ad, json={"code": "EF_GRID_IN", "kgco2e_per_unit": 0.68, "valid_from": "2026-10-01", "source": "CEA v22 (demo)"}).json()
    grid = [f for f in fs if f["code"] == "EF_GRID_IN"]
    assert [f["version"] for f in grid] == [1, 2] and grid[0]["valid_to"] == "2026-09-30"
    after = {r["month"]: r for r in client.get("/api/v1/workspace", headers=pr).json()["derived"]["emissions"]}
    assert after["2026-09"]["scope2"] == pytest.approx(before["2026-09"]["scope2"])
    assert after["2026-10"]["scope2"] < before["2026-10"]["scope2"]
    assert next(i for i in after["2026-10"]["items"] if i["code"] == "GRID_KWH")["factorVersion"] == 2


def _make_passports(client):
    t0 = int(dt.datetime(2026, 11, 11, 8, 0, tzinfo=dt.timezone.utc).timestamp() * 1000)
    for serial, oem in ((901, "A"), (902, "B")):
        for k, extra in (("started", {"oem": oem, "order": f"PO-{oem}-9000", "steelKg": 3200}), ("moved", {"station": 2}), ("finished", {})):
            client.post("/api/v1/production/events", headers=DEV, json={"kind": k, "serial": serial, "ts": t0, **extra})
            t0 += 60_000


def test_tenancy_oem_a_cannot_see_oem_b(client):
    _make_passports(client)
    a = login(client, "esg@oem-a.example")
    ps = client.get("/api/v1/passports", headers=a).json()
    assert {p["oem"] for p in ps["passports"]} == {"A"} and ps["hiddenOtherOems"] >= 1
    assert client.get("/api/v1/passports/902", headers=a).status_code == 403
    assert client.get("/api/v1/reports/oem/B", headers=a).status_code == 403
    assert client.get("/api/v1/reports/oem/A?format=csv", headers=a).status_code == 200
    assert client.get("/api/v1/ledger/entries", headers=a).status_code == 403


def test_public_part_page_without_login(client):
    pr = login(client, "priya@vardhan.example")
    p = client.get("/api/v1/passports?oem=A", headers=pr).json()["passports"][0]
    pub = client.get(f"/api/v1/public/part/{p['publicCode']}").json()
    assert pub["serial"].startswith("VBW-") and "s1" not in pub and pub["carbon"]["total_kg"] > 0


def test_fmcg_recall_traces_exactly_the_batches_using_the_lot(client):
    sys.path.insert(0, str(API.parent))
    from demo_data.fmcg_gen import batch_record
    for i in range(30):
        rec = batch_record(i)
        plan = {**rec, "tests": [{k: t[k] for k in ("stage", "name", "spec", "by", "at")} for t in rec["tests"]]}
        assert client.post("/api/v1/fmcg/batches", headers=AFL, json=plan).status_code == 200
        for t in rec["tests"]:
            client.post(f"/api/v1/fmcg/batches/{rec['code']}/tests", headers=AFL, json={"name": t["name"], "value": t["value"], "ok": t["ok"], "at": t["at"]})
    m = login(client, "meena@annapurna.example")
    lot = next(l for l in client.get("/api/v1/fmcg/lots", headers=m).json() if l["material"] == "spice")
    before = client.get("/api/v1/fmcg/batches?limit=100", headers=m).json()["batches"]
    r = client.post("/api/v1/fmcg/recall", headers=m, json={"lot": lot["lot"], "reason": "test"}).json()
    assert set(lot["batches"]) <= set(r["batches"])
    bs = client.get("/api/v1/fmcg/batches?limit=100", headers=m).json()["batches"]
    expected = {b["id"] for b in before if b["id"] in lot["batches"] and b["status"] != "in_production"}
    assert expected and {b["id"] for b in bs if b["status"] == "recalled"} == expected
    brand_b = login(client, "quality@brand-b.example")
    assert {b["product"]["brand"] for b in client.get("/api/v1/fmcg/batches", headers=brand_b).json()["batches"]} == {"B"}
    pub = client.get(f"/api/v1/public/batch/{bs[0]['publicCode']}").json()
    assert "recalled" in pub


def test_cluster_mismatch_held_until_confirmed(client):
    co = login(client, "coordinator@adityapur.example")
    r = client.post("/api/v1/cluster/feed/weighbridge", headers=CLU, json={"agreementId": "x-scrap", "sent": 1.24, "received": 1.09, "ts": 1794400000000}).json()
    assert r["status"] == "mismatch"
    assert client.post(f"/api/v1/cluster/exchange-lines/{r['id']}/confirm", headers=co).status_code == 200
    line = next(l for l in client.get("/api/v1/cluster/exchanges", headers=co).json()["ledger"] if l["id"] == r["id"])
    assert line["status"] == "resolved" and line["received"] == line["sent"]
    sb = client.get("/api/v1/cluster/scoreboard", headers=co).json()
    assert sb["t"] > 1000 and sb["poolInr"] > 0


def test_audit_chain_intact_and_append_only(client):
    ad = login(client, "ops@carbonkhata.example")
    assert client.get("/api/v1/audit/verify", headers=ad).json()["ok"]
    from sqlalchemy import text
    from app.db import engine
    with pytest.raises(Exception):
        with engine.begin() as c:
            c.execute(text("UPDATE audit_event SET detail='x'"))


def test_phone_photo_saved_listed_and_served(client, tmp_path, monkeypatch):
    from app.config import settings
    monkeypatch.setattr(settings, "storage_dir", str(tmp_path / "captures"))
    op = login(client, "ramesh@vardhan.example")
    png = b"\x89PNG\r\n\x1a\n" + b"demo-slip-photo" * 50
    r = client.post("/api/v1/documents", headers=op, data={"kind": "slip", "docRef": "CH-7781", "note": "diesel"}, files={"file": ("slip.png", png, "image/png")})
    assert r.status_code == 200, r.text
    d = r.json()
    saved = list((tmp_path / "captures").rglob("*.png"))
    assert len(saved) == 1 and "Ramesh" in saved[0].name and "CH-7781" in saved[0].name
    assert client.post("/api/v1/documents", headers=op, data={"kind": "slip"}, files={"file": ("again.png", png, "image/png")}).status_code == 409
    pr = login(client, "priya@vardhan.example")
    assert d["id"] in [x["id"] for x in client.get("/api/v1/documents", headers=pr).json()]
    assert client.get(d["url"], headers=pr).content == png
    assert client.get(d["url"], headers=login(client, "esg@oem-a.example")).status_code == 403
