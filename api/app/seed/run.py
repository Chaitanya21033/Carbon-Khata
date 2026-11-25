"""Seed the database with the fictional demo companies. Usage: python -m app.seed.run [--reset]

Adds (all invented): Vardhan Body Works (24 months of history with planted mistakes + open-month days 1–9),
Annapurna Foods (FMCG co-packer), OEM A/B/C, Brand A/B, the Adityapur Green Cluster with year-to-date pool and
exchange history from 1 April 2026, demo users for every role, factor library v1, rules V01–V12, meters, assets."""
from __future__ import annotations

import datetime as dt
import json
import sys
import time
from pathlib import Path

from sqlalchemy import text

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))  # demo_data (dummy-data generators)

from ..config import settings  # noqa: E402
from ..db import SessionLocal, engine  # noqa: E402
from ..domain import cluster as CL  # noqa: E402
from ..domain import fmcg as FM  # noqa: E402
from ..domain.grid import market_day  # noqa: E402
from ..domain.ledger import DIRECTION  # noqa: E402
from ..domain.measures import MEASURE_SEED  # noqa: E402
from ..domain.samples import SAMPLE_CASES  # noqa: E402
from ..domain.seed import FACTORS, PLANT, build_seed  # noqa: E402
from ..domain.validation import RULES  # noqa: E402
from ..models import (Asset, Base, Cluster, ClusterMember, CreditAllocation, Device, EmissionFactor, EmsSettings, ExchangeAccrual, ExchangeAgreement, FmcgProduct, LedgerEntry,  # noqa: E402
                      Meter, OemSteelFactor, OemSupplierLink, OnboardingCase, PoolDay, Register, RegisterType, RoleAssignment, Tenant, TenantSetting, User, ValidationRule)
from ..security import _h, audit  # noqa: E402

DATA = Path(__file__).resolve().parents[1] / "data"
REVENUE_PER_BODY = 620000  # ₹, dummy turnover per tipper body (financials register)
SEED_UNTIL = dt.date(2026, 11, 9)  # cluster history back-filled up to the day before the simulator starts

TENANTS = [
    dict(id="vbw", kind="plant", name=PLANT["tenant"], plant_name=PLANT["plant"], gstin="20ABCDE1234F1Z5", udyam=PLANT["udyam"], contract_kva=450, lat=22.8, lon=86.18,
         meta={"live": True, "ledger": True, "product": PLANT["product"], "utility": PLANT["utility"], "oem": PLANT["oem"], "cluster": "adityapur", "member": "vbw"}),
    dict(id="afl", kind="plant", name="Annapurna Foods Pvt. Ltd.", plant_name=FM.CO_PACKER["plant"], code="AFL", contract_kva=600, meta={"fmcg": True, "cluster": "adityapur", "member": "fm1"}),
    dict(id="oem-a", kind="oem", name="OEM A", code="A", meta={"sub": "Commercial vehicles (domestic)"}),
    dict(id="oem-b", kind="oem", name="OEM B", code="B", meta={"sub": "Construction equipment"}),
    dict(id="oem-c", kind="oem", name="OEM C", code="C", meta={"sub": "Export to EU (CBAM)"}),
    dict(id="brand-a", kind="brand", name="Brand A Foods", code="A", meta={}),
    dict(id="brand-b", kind="brand", name="Brand B Nutrition", code="B", meta={}),
    dict(id="adityapur", kind="cluster", name=CL.CLUSTER_NAME, meta={}),
    dict(id="platform", kind="platform", name="CarbonKhata platform", meta={}),
]
USERS = [
    ("u-ramesh", "ramesh@vardhan.example", "Ramesh", "Store keeper (Operator)", "स्टोर कीपर (ऑपरेटर)", "vbw", "operator"),
    ("u-priya", "priya@vardhan.example", "Priya", "Accounts & ESG custodian", "अकाउंट्स व ईएसजी कस्टोडियन", "vbw", "custodian"),
    ("u-owner", "owner@vardhan.example", "Plant owner", "Managing director (Owner)", "प्रबंध निदेशक (मालिक)", "vbw", "owner"),
    ("u-oema", "esg@oem-a.example", "OEM A ESG team", "OEM viewer (OEM A)", "ओईएम व्यूअर", "oem-a", "oem"),
    ("u-oemb", "esg@oem-b.example", "OEM B ESG team", "OEM viewer (OEM B)", "ओईएम व्यूअर", "oem-b", "oem"),
    ("u-oemc", "esg@oem-c.example", "OEM C ESG team", "OEM viewer (OEM C, EU export)", "ओईएम व्यूअर", "oem-c", "oem"),
    ("u-meena", "meena@annapurna.example", "Meena", "QC & ESG manager (Annapurna Foods)", "क्यूसी व ईएसजी प्रबंधक", "afl", "custodian"),
    ("u-branda", "quality@brand-a.example", "Brand A quality team", "Brand viewer (Brand A Foods)", "ब्रांड व्यूअर", "brand-a", "oem"),
    ("u-brandb", "quality@brand-b.example", "Brand B quality team", "Brand viewer (Brand B Nutrition)", "ब्रांड व्यूअर", "brand-b", "oem"),
    ("u-coord", "coordinator@adityapur.example", "Cluster coordinator", "Cluster coordinator (association)", "क्लस्टर समन्वयक", "adityapur", "cluster"),
    ("u-admin", "ops@carbonkhata.example", "Ops admin", "CarbonKhata platform admin", "प्लेटफ़ॉर्म एडमिन", "platform", "admin"),
]
DEVICES = [("sim-vbw", "vbw", "gateway", "Vardhan smart-meter gateway & shop-floor phones"), ("sim-afl", "afl", "mes", "Annapurna line MES / QC lab"),
           ("sim-cluster", "adityapur", "cluster_meters", "Cluster member meters & weighbridges"), ("sim-market", "platform", "market_feed", "Market-data & DISCOM event feed")]


def _rows(db):
    for t in TENANTS:
        db.add(Tenant(**t))
    db.flush()
    for uid_, email, name, title, title_hi, tid, role in USERS:
        db.add(User(id=uid_, email=email, name=name, title=title, title_hi=title_hi))
        db.flush()
        db.add(RoleAssignment(user_id=uid_, tenant_id=tid, role=role))
    for code, vendor in (("oem-a", "VBW-0412"), ("oem-b", "VBW-0412-B"), ("oem-c", "VBW-EU-77")):
        db.add(OemSupplierLink(oem_tenant_id=code, supplier_tenant_id="vbw", consent="summary", vendor_code=vendor, granted_by="Plant owner"))
    keys = dict(p.split(":", 1) for p in settings.device_keys.split(",") if ":" in p)
    for did, tid, kind, name in DEVICES:
        db.add(Device(id=did, tenant_id=tid, kind=kind, name=name, key_hash=_h(keys.get(did, ""))))
    # libraries
    for rt in json.loads((DATA / "register_types.json").read_text(encoding="utf-8"))["register_types"]:
        db.add(RegisterType(code=rt["code"], name=rt["name"], unit=rt["unit"], category=rt["category"], factor_code=rt.get("factor_code"),
                            meta={k: v for k, v in rt.items() if k not in ("code", "name", "unit", "category", "factor_code")}))
    for r in RULES:
        db.add(ValidationRule(code=r["code"], name=r["name"], severity=r["severity"], params=r["params"], message_en=r["message_en"], message_hi=r["message_hi"]))
    for f in FACTORS:
        db.add(EmissionFactor(code=f["code"], activity=f["activity"], scope=f["scope"], unit=f["unit"], kgco2e_per_unit=f["kgco2e_per_unit"], source=f["source"], version=f["version"],
                              valid_from=f["valid_from"], valid_to=f["valid_to"], status=f["status"], created_by="library v1"))
    for code, ef, note in (("A", 2.3, "BF-BOF steel, India average"), ("B", 2.3, "BF-BOF steel, India average"), ("C", 1.55, "Mill-certified lower-carbon steel")):
        db.add(OemSteelFactor(oem_code=code, kg_per_kg=ef, note=note, version=1, valid_from="2026-04-01"))
    db.flush()


def _ledger(db):
    s = build_seed()
    regs = s["registers"]
    for i, r in enumerate(regs):
        db.add(Register(tenant_id="vbw", id=r.id, code=r.code, label=r.label, label_hi=r.labelHi, unit=r.unit, category=r.category, mode=r.mode, required=r.required,
                        conversion=r.conversion, factor_code=r.factorCode, typical=r.typical, sort=i))
    db.add(Register(tenant_id="vbw", id="TURNOVER_INR", code="TURNOVER_INR", label="Turnover (financials, dummy)", label_hi="टर्नओवर", unit="₹", category="financial", mode="reading", sort=999))
    unit = {r.id: r.unit for r in regs}
    db.flush()
    rows = []
    for e in s["entries"]:
        rows.append(dict(id=e.id, tenant_id="vbw", register_id=e.registerId, month=e.month, line=e.line, direction=DIRECTION[e.line], qty=e.qty, unit=unit[e.registerId], status="posted",
                         reason=e.reason, doc_ref=e.docRef, source=e.source, idempotency_key=None, posted_by=e.by, posted_at=e.at))
    for m in s["plantMonths"]:
        bodies = next(e.qty for e in s["entries"] if e.registerId == "PROD" and e.month == m)
        rows.append(dict(id=f"seed_to_{m}", tenant_id="vbw", register_id="TURNOVER_INR", month=m, line="reading", direction="reading", qty=bodies * REVENUE_PER_BODY, unit="₹",
                         status="posted", reason="Dummy turnover = bodies × ₹6.2 lakh", doc_ref=f"FIN-{m}", source="import", idempotency_key=None, posted_by="Accounts (dummy)", posted_at="2026-11-02T10:00:00.000Z"))
    db.execute(LedgerEntry.__table__.insert(), rows)


def _plant_config(db):
    for mid, label, kind in (("incomer", "Main incomer (HT)", "main"), ("comp", "Compressor", "sub"), ("weld", "Welding bay", "sub"), ("paint", "Paint shop & oven", "sub"),
                             ("light", "Lighting", "sub"), ("util", "Utilities & office", "sub"), ("solar", "Rooftop solar 250 kWp", "solar"), ("export", "Export (net meter)", "main")):
        db.add(Meter(tenant_id="vbw", id=mid, label=label, kind=kind, serial=f"DLMS-{mid.upper()}-0001"))
    for aid, kind, params in (("solar", "solar", {"kwp": 250}), ("bess", "battery", {"capKwh": 400, "powerKw": 150, "reserveSoc": 0.2, "eff": 0.92}),
                              ("genset", "gas_genset", {"kw": 150, "fuelInrPerKwh": 5.6, "kwhPerScm": 3.3}), ("flex", "flex_load", {"runKw": 60, "deadlineH": 21})):
        db.add(Asset(tenant_id="vbw", id=aid, kind=kind, params=params))
    db.add(EmsSettings(tenant_id="vbw"))
    db.add(CreditAllocation(tenant_id="vbw", project="SOLAR", credits_share=0.6, oem_claim_share=0.4, version=1, set_by="seed"))
    db.add(TenantSetting(tenant_id="vbw", key="measures", value=MEASURE_SEED))
    db.add(TenantSetting(tenant_id="vbw", key="consent", value="summary"))
    for p in FM.PRODUCTS.values():
        db.add(FmcgProduct(id=p["id"], tenant_id="afl", brand_code=p["brand"], data=p))
    for c in SAMPLE_CASES:
        db.add(OnboardingCase(id=c["id"], supplier=c["supplier"], cluster=c["cluster"], sponsor=c["sponsor"], associate=c["associate"], stage=c["stage"], days_in_stage=c["daysInStage"],
                              days_total=c["daysTotal"], sample=c["sample"]))


def _cluster(db):
    from demo_data.cluster_gen import member_load
    db.add(Cluster(id="adityapur", name=CL.CLUSTER_NAME, meta={"poolNode": CL.POOL_NODE}))
    tmap = {"vbw": "vbw", "fm1": "afl"}
    for m in CL.MEMBERS:
        db.add(ClusterMember(cluster_id="adityapur", id=m["id"], tenant_id=tmap.get(m["id"]), data=m, active=not m.get("late")))
    fy = dt.datetime(2026, 4, 1, tzinfo=dt.timezone.utc)
    for x in CL.BASE_EXCHANGES:
        db.add(ExchangeAgreement(cluster_id="adityapur", id=x["id"], data=x, status="agreed", sender_share=x["senderShare"], claim=x["claim"], agreed_at=fy))
    for x in CL.PROPOSALS:
        db.add(ExchangeAgreement(cluster_id="adityapur", id=x["id"], data=x, status="proposed", sender_share=x["senderShare"], claim=x["claim"]))
    db.flush()
    members = [m for m in CL.MEMBERS if m["kw"] > 0 and not m.get("late")]
    d = dt.date(2026, 4, 1)
    pdays, acc = [], []
    while d <= SEED_UNTIL:
        di = (d - dt.date(1970, 1, 1)).days
        mk = market_day(di)
        tot = {"solo": 0.0, "pooled": 0.0, "ip": 0.0, "pp": 0.0}
        for b in range(96):
            t = di * 86_400_000 + b * 15 * 60_000 + 7 * 60_000
            s = CL.settle_block(b, {m["id"]: (member_load(m, t, False), member_load(m, t, True)) for m in members}, mk[b])
            tot["solo"] += s["soloCost"]; tot["pooled"] += s["pooledCost"]; tot["ip"] += s["indivPen"]; tot["pp"] += s["pooledPen"]
        pdays.append(dict(cluster_id="adityapur", date=d.isoformat(), solo_cost=tot["solo"], pooled_cost=tot["pooled"], indiv_pen=tot["ip"], pooled_pen=tot["pp"], blocks=96))
        for x in CL.BASE_EXCHANGES:
            k = 1 / 30.4
            acc.append(dict(cluster_id="adityapur", agreement_id=x["id"], date=d.isoformat(), inr=x["inrPerMonth"] * k, tco2=x["tco2PerMonth"] * k, m3=x.get("m3PerMonth", 0) * k,
                            mwh=x.get("mwhPerMonth", 0) * k, t_mat=x.get("tMatPerMonth", 0) * k))
        d += dt.timedelta(days=1)
    db.execute(PoolDay.__table__.insert(), pdays)
    db.execute(ExchangeAccrual.__table__.insert(), acc)


def seed(db=None):
    own = db is None
    db = db or SessionLocal()
    t0 = time.time()
    _rows(db)
    _ledger(db)
    _plant_config(db)
    _cluster(db)
    db.commit()
    audit(db, "Field associate", "field", "import", PLANT["tenant"], "History import: 24 plant-months of registers, bills and meters (demo)", "vbw")
    print(f"[seed] demo data loaded in {time.time() - t0:.1f}s", flush=True)
    if own:
        db.close()


def truncate_all():
    with engine.begin() as c:
        names = ", ".join(f'"{t.name}"' for t in reversed(Base.metadata.sorted_tables))
        c.execute(text(f"TRUNCATE {names} RESTART IDENTITY CASCADE"))


def reset_all():
    from ..live import registry
    from ..services import ledger as svc
    truncate_all()
    seed()
    with registry._lock:
        registry.TWINS.clear()
    svc._cache.clear()
    from .. import events
    events.publish(None, "reset", {"at": time.time()})


if __name__ == "__main__":
    if "--reset" in sys.argv:
        truncate_all()
    else:
        with SessionLocal() as db:
            if db.get(Tenant, "vbw"):
                print("[seed] already seeded (use --reset to reload the demo data)")
                sys.exit(0)
    seed()
