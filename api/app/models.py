"""Database schema. Every tenant-owned row carries tenant_id; access checks are enforced in app/security.py."""
from __future__ import annotations

import datetime as dt
from typing import Any, Optional

from sqlalchemy import JSON, BigInteger, Identity, Boolean, DateTime, Float, ForeignKey, Index, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    type_annotation_map = {dict[str, Any]: JSON, list[Any]: JSON}


def now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


TS = DateTime(timezone=True)


# ---------------- organisations & access ----------------
class Tenant(Base):
    __tablename__ = "tenant"
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    kind: Mapped[str] = mapped_column(String(20))  # plant | oem | brand | cluster | platform
    name: Mapped[str] = mapped_column(String(200))
    plant_name: Mapped[Optional[str]] = mapped_column(String(200))
    code: Mapped[Optional[str]] = mapped_column(String(20))  # OEM A/B/C, brand A/B, cluster member id
    gstin: Mapped[Optional[str]] = mapped_column(String(20))
    udyam: Mapped[Optional[str]] = mapped_column(String(30))
    contract_kva: Mapped[Optional[float]] = mapped_column(Float)
    lat: Mapped[Optional[float]] = mapped_column(Float)
    lon: Mapped[Optional[float]] = mapped_column(Float)
    tz: Mapped[str] = mapped_column(String(40), default="Asia/Kolkata")
    meta: Mapped[dict[str, Any]] = mapped_column(default=dict)


class User(Base):
    __tablename__ = "app_user"
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    email: Mapped[str] = mapped_column(String(200), unique=True)
    name: Mapped[str] = mapped_column(String(200))
    title: Mapped[Optional[str]] = mapped_column(String(200))
    title_hi: Mapped[Optional[str]] = mapped_column(String(200))
    lang: Mapped[str] = mapped_column(String(5), default="en")
    active: Mapped[bool] = mapped_column(Boolean, default=True)


class RoleAssignment(Base):
    __tablename__ = "role_assignment"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("app_user.id"))
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenant.id"))
    role: Mapped[str] = mapped_column(String(20))  # operator custodian owner oem cluster admin
    __table_args__ = (UniqueConstraint("user_id", "tenant_id", "role"),)


class OemSupplierLink(Base):
    __tablename__ = "oem_supplier_link"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    oem_tenant_id: Mapped[str] = mapped_column(ForeignKey("tenant.id"))
    supplier_tenant_id: Mapped[str] = mapped_column(ForeignKey("tenant.id"))
    consent: Mapped[Optional[str]] = mapped_column(String(20))  # summary | detailed | None (revoked)
    vendor_code: Mapped[Optional[str]] = mapped_column(String(40))
    granted_by: Mapped[Optional[str]] = mapped_column(String(200))
    granted_at: Mapped[dt.datetime] = mapped_column(TS, default=now)
    __table_args__ = (UniqueConstraint("oem_tenant_id", "supplier_tenant_id"),)


class OtpChallenge(Base):
    __tablename__ = "otp_challenge"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    email: Mapped[str] = mapped_column(String(200), index=True)
    code_hash: Mapped[str] = mapped_column(String(128))
    expires_at: Mapped[dt.datetime] = mapped_column(TS)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    used: Mapped[bool] = mapped_column(Boolean, default=False)


class Device(Base):
    __tablename__ = "device"
    id: Mapped[str] = mapped_column(String(60), primary_key=True)
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenant.id"))
    kind: Mapped[str] = mapped_column(String(30))  # gateway | phone | mes | market_feed | cluster_meters
    name: Mapped[str] = mapped_column(String(200))
    key_hash: Mapped[str] = mapped_column(String(128))
    online: Mapped[bool] = mapped_column(Boolean, default=True)
    last_seen: Mapped[Optional[dt.datetime]] = mapped_column(TS)


class IdempotencyRecord(Base):
    __tablename__ = "idempotency_record"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    tenant_id: Mapped[str] = mapped_column(String(40))
    key: Mapped[str] = mapped_column(String(200))
    route: Mapped[str] = mapped_column(String(100))
    response: Mapped[dict[str, Any]] = mapped_column(default=dict)
    created_at: Mapped[dt.datetime] = mapped_column(TS, default=now)
    __table_args__ = (UniqueConstraint("tenant_id", "key"),)


class AuditEvent(Base):
    """Append-only (a trigger in the migration forbids UPDATE/DELETE). Each row hashes the previous one."""
    __tablename__ = "audit_event"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    at: Mapped[dt.datetime] = mapped_column(TS, default=now, index=True)
    tenant_id: Mapped[Optional[str]] = mapped_column(String(40), index=True)
    actor: Mapped[str] = mapped_column(String(200))
    role: Mapped[Optional[str]] = mapped_column(String(30))
    action: Mapped[str] = mapped_column(String(60))
    entity: Mapped[str] = mapped_column(String(200))
    detail: Mapped[str] = mapped_column(Text, default="")
    prev_hash: Mapped[Optional[str]] = mapped_column(String(64))
    hash: Mapped[str] = mapped_column(String(64))


# ---------------- registers & ledger ----------------
class RegisterType(Base):
    __tablename__ = "register_type"
    code: Mapped[str] = mapped_column(String(40), primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    unit: Mapped[str] = mapped_column(String(20))
    category: Mapped[str] = mapped_column(String(30))
    factor_code: Mapped[Optional[str]] = mapped_column(String(40))
    meta: Mapped[dict[str, Any]] = mapped_column(default=dict)


class Register(Base):
    __tablename__ = "register"
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenant.id"), primary_key=True)
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    code: Mapped[str] = mapped_column(String(40))
    label: Mapped[str] = mapped_column(String(200))
    label_hi: Mapped[Optional[str]] = mapped_column(String(200))
    unit: Mapped[str] = mapped_column(String(20))
    category: Mapped[str] = mapped_column(String(30))
    mode: Mapped[str] = mapped_column(String(20))
    required: Mapped[bool] = mapped_column(Boolean, default=False)
    conversion: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON)
    factor_code: Mapped[Optional[str]] = mapped_column(String(40))
    typical: Mapped[Optional[float]] = mapped_column(Float)
    sort: Mapped[int] = mapped_column(Integer, default=0)


class LedgerEntry(Base):
    __tablename__ = "ledger_entry"
    id: Mapped[str] = mapped_column(String(60), primary_key=True)
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenant.id"), index=True)
    seq: Mapped[int] = mapped_column(BigInteger, Identity(), index=True)
    register_id: Mapped[str] = mapped_column(String(40))
    month: Mapped[str] = mapped_column(String(7))
    line: Mapped[str] = mapped_column(String(12))
    direction: Mapped[str] = mapped_column(String(10))
    qty: Mapped[float] = mapped_column(Float)
    unit: Mapped[Optional[str]] = mapped_column(String(20))
    status: Mapped[str] = mapped_column(String(12), default="posted")  # posted reversed held rejected
    reverses_entry_id: Mapped[Optional[str]] = mapped_column(String(60))
    corrects_entry_id: Mapped[Optional[str]] = mapped_column(String(60))
    reason: Mapped[Optional[str]] = mapped_column(Text)
    doc_ref: Mapped[Optional[str]] = mapped_column(String(120), index=True)
    source: Mapped[str] = mapped_column(String(12))
    idempotency_key: Mapped[Optional[str]] = mapped_column(String(160))
    posted_by: Mapped[str] = mapped_column(String(200))
    posted_at: Mapped[str] = mapped_column(String(40))
    hold: Mapped[Optional[dict[str, Any]]] = mapped_column(JSON)
    __table_args__ = (UniqueConstraint("tenant_id", "idempotency_key"), Index("ix_ledger_reg_month", "tenant_id", "register_id", "month"))


class Period(Base):
    __tablename__ = "period"
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenant.id"), primary_key=True)
    month: Mapped[str] = mapped_column(String(7), primary_key=True)
    status: Mapped[str] = mapped_column(String(12), default="open")  # open in_review closed reopened
    reopened_count: Mapped[int] = mapped_column(Integer, default=0)
    submitted_by: Mapped[Optional[str]] = mapped_column(String(200))
    approved_by: Mapped[Optional[str]] = mapped_column(String(200))
    history: Mapped[list[Any]] = mapped_column(default=list)


class ValidationResult(Base):
    """Decision state of a validation issue (issues themselves are recomputed from the ledger)."""
    __tablename__ = "validation_result"
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenant.id"), primary_key=True)
    issue_id: Mapped[str] = mapped_column(String(120), primary_key=True)
    rule: Mapped[str] = mapped_column(String(8))
    status: Mapped[str] = mapped_column(String(12))  # open accepted dismissed
    note: Mapped[Optional[str]] = mapped_column(Text)
    decided_by: Mapped[Optional[str]] = mapped_column(String(200))
    decided_at: Mapped[Optional[str]] = mapped_column(String(40))


class ValidationRule(Base):
    __tablename__ = "validation_rule"
    code: Mapped[str] = mapped_column(String(8), primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    severity: Mapped[str] = mapped_column(String(30))
    params: Mapped[dict[str, Any]] = mapped_column(default=dict)
    message_en: Mapped[str] = mapped_column(Text)
    message_hi: Mapped[str] = mapped_column(Text)
    version: Mapped[int] = mapped_column(Integer, default=1)


# ---------------- factors ----------------
class EmissionFactor(Base):
    """Versioned: a change inserts a new version and closes valid_to on the previous one. Never edited in place."""
    __tablename__ = "emission_factor"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    code: Mapped[str] = mapped_column(String(40))
    activity: Mapped[str] = mapped_column(String(200))
    scope: Mapped[int] = mapped_column(Integer)
    unit: Mapped[str] = mapped_column(String(20))
    kgco2e_per_unit: Mapped[float] = mapped_column(Float)
    source: Mapped[str] = mapped_column(Text)
    version: Mapped[int] = mapped_column(Integer)
    valid_from: Mapped[str] = mapped_column(String(10))
    valid_to: Mapped[Optional[str]] = mapped_column(String(10))
    status: Mapped[str] = mapped_column(String(20))
    created_by: Mapped[Optional[str]] = mapped_column(String(200))
    __table_args__ = (UniqueConstraint("code", "version"),)


class OemSteelFactor(Base):
    __tablename__ = "oem_steel_factor"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    oem_code: Mapped[str] = mapped_column(String(4))
    kg_per_kg: Mapped[float] = mapped_column(Float)
    note: Mapped[str] = mapped_column(String(200))
    version: Mapped[int] = mapped_column(Integer, default=1)
    valid_from: Mapped[str] = mapped_column(String(10))


# ---------------- meters & documents ----------------
class Meter(Base):
    __tablename__ = "meter"
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenant.id"), primary_key=True)
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    label: Mapped[str] = mapped_column(String(200))
    kind: Mapped[str] = mapped_column(String(20))  # main sub solar bess genset flex
    unit: Mapped[str] = mapped_column(String(10), default="kWh")
    serial: Mapped[Optional[str]] = mapped_column(String(60))


class MeterReading(Base):
    """15-minute interval data per meter (smart-meter load survey). TimescaleDB hypertable when available."""
    __tablename__ = "meter_reading"
    tenant_id: Mapped[str] = mapped_column(String(40), primary_key=True)
    meter_id: Mapped[str] = mapped_column(String(40), primary_key=True)
    ts: Mapped[dt.datetime] = mapped_column(TS, primary_key=True)
    kwh: Mapped[float] = mapped_column(Float)
    kw: Mapped[Optional[float]] = mapped_column(Float)
    kva: Mapped[Optional[float]] = mapped_column(Float)
    pf: Mapped[Optional[float]] = mapped_column(Float)
    cumulative: Mapped[Optional[float]] = mapped_column(Float)
    source: Mapped[str] = mapped_column(String(20), default="smart_meter")


class ManualMeterReading(Base):
    __tablename__ = "manual_meter_reading"
    id: Mapped[str] = mapped_column(String(60), primary_key=True)
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenant.id"))
    meter: Mapped[str] = mapped_column(String(200))
    value: Mapped[float] = mapped_column(Float)
    confidence: Mapped[float] = mapped_column(Float, default=1)
    source: Mapped[str] = mapped_column(String(20))  # smart_meter_api | manual
    at: Mapped[str] = mapped_column(String(40))
    by: Mapped[str] = mapped_column(String(200))


class Bill(Base):
    __tablename__ = "bill"
    id: Mapped[str] = mapped_column(String(60), primary_key=True)
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenant.id"))
    month: Mapped[str] = mapped_column(String(7))
    kwh: Mapped[Optional[float]] = mapped_column(Float)
    kvah: Mapped[Optional[float]] = mapped_column(Float)
    pf: Mapped[Optional[float]] = mapped_column(Float)
    md_kva: Mapped[Optional[float]] = mapped_column(Float)
    amount_inr: Mapped[Optional[float]] = mapped_column(Float)
    document_id: Mapped[Optional[str]] = mapped_column(String(60))
    source: Mapped[str] = mapped_column(String(30), default="manual")
    created_at: Mapped[dt.datetime] = mapped_column(TS, default=now)


class Document(Base):
    __tablename__ = "document"
    id: Mapped[str] = mapped_column(String(60), primary_key=True)
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenant.id"))
    kind: Mapped[str] = mapped_column(String(20))
    filename: Mapped[str] = mapped_column(String(200))
    path: Mapped[str] = mapped_column(String(400))
    sha256: Mapped[str] = mapped_column(String(64))
    fields: Mapped[dict[str, Any]] = mapped_column(default=dict)
    confirmed_by: Mapped[Optional[str]] = mapped_column(String(200))
    created_at: Mapped[dt.datetime] = mapped_column(TS, default=now)


# ---------------- production & passports ----------------
class ProductionEvent(Base):
    __tablename__ = "production_event"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id: Mapped[str] = mapped_column(String(40), index=True)
    serial: Mapped[int] = mapped_column(Integer)
    kind: Mapped[str] = mapped_column(String(20))
    station: Mapped[Optional[int]] = mapped_column(Integer)
    payload: Mapped[dict[str, Any]] = mapped_column(default=dict)
    ts: Mapped[dt.datetime] = mapped_column(TS)
    __table_args__ = (UniqueConstraint("tenant_id", "serial", "kind", "station"),)


class Passport(Base):
    __tablename__ = "passport"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id: Mapped[str] = mapped_column(String(40), index=True)
    serial: Mapped[int] = mapped_column(Integer)
    oem_code: Mapped[str] = mapped_column(String(4), index=True)
    order_no: Mapped[str] = mapped_column(String(40))
    started_at: Mapped[dt.datetime] = mapped_column(TS)
    finished_at: Mapped[dt.datetime] = mapped_column(TS)
    kwh: Mapped[float] = mapped_column(Float)
    s1: Mapped[float] = mapped_column(Float)
    s2: Mapped[float] = mapped_column(Float)
    steel: Mapped[float] = mapped_column(Float)
    steel_kg: Mapped[float] = mapped_column(Float)
    renewable_share: Mapped[float] = mapped_column(Float)
    total: Mapped[float] = mapped_column(Float)
    public_code: Mapped[str] = mapped_column(String(40), unique=True)
    factor_versions: Mapped[dict[str, Any]] = mapped_column(default=dict)
    __table_args__ = (UniqueConstraint("tenant_id", "serial"),)


# ---------------- energy ----------------
class MarketBlock(Base):
    __tablename__ = "market_block"
    date: Mapped[str] = mapped_column(String(10), primary_key=True)
    block: Mapped[int] = mapped_column(Integer, primary_key=True)
    dam: Mapped[float] = mapped_column(Float)
    gdam: Mapped[float] = mapped_column(Float)
    rtm: Mapped[float] = mapped_column(Float)
    discom: Mapped[float] = mapped_column(Float)
    grid_demand_gw: Mapped[float] = mapped_column(Float)
    solar_gw: Mapped[float] = mapped_column(Float)
    net_demand_gw: Mapped[float] = mapped_column(Float)
    marginal_ef: Mapped[float] = mapped_column(Float)
    stress: Mapped[int] = mapped_column(Integer)
    source: Mapped[str] = mapped_column(String(20), default="iex_mock")


class EmsSettings(Base):
    __tablename__ = "ems_settings"
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenant.id"), primary_key=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    solver: Mapped[str] = mapped_column(String(10), default="rules")
    carbon_price: Mapped[float] = mapped_column(Float, default=1500)
    green_cap_kw: Mapped[float] = mapped_column(Float, default=150)
    reserve_soc: Mapped[float] = mapped_column(Float, default=0.2)


class Asset(Base):
    __tablename__ = "asset"
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenant.id"), primary_key=True)
    id: Mapped[str] = mapped_column(String(30), primary_key=True)
    kind: Mapped[str] = mapped_column(String(20))
    params: Mapped[dict[str, Any]] = mapped_column(default=dict)


class EmsDecision(Base):
    __tablename__ = "ems_decision"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    tenant_id: Mapped[str] = mapped_column(String(40), index=True)
    ts: Mapped[dt.datetime] = mapped_column(TS, index=True)
    block: Mapped[int] = mapped_column(Integer)
    mode: Mapped[str] = mapped_column(String(12))
    reason: Mapped[str] = mapped_column(Text)
    plan: Mapped[dict[str, Any]] = mapped_column(default=dict)
    log: Mapped[dict[str, Any]] = mapped_column(default=dict)
    saved_inr: Mapped[float] = mapped_column(Float)
    avoided_kg: Mapped[float] = mapped_column(Float)


class WeatherForecast(Base):
    __tablename__ = "weather_forecast"
    ts: Mapped[str] = mapped_column(String(30), primary_key=True)
    ghi: Mapped[float] = mapped_column(Float)
    cloud: Mapped[float] = mapped_column(Float)
    source: Mapped[str] = mapped_column(String(20))


class PlantState(Base):
    __tablename__ = "plant_state"
    tenant_id: Mapped[str] = mapped_column(String(40), primary_key=True)
    state: Mapped[dict[str, Any]] = mapped_column(default=dict)
    updated_at: Mapped[dt.datetime] = mapped_column(TS, default=now)


# ---------------- credits ----------------
class CreditVintage(Base):
    __tablename__ = "credit_vintage"
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenant.id"), primary_key=True)
    month: Mapped[str] = mapped_column(String(7), primary_key=True)
    status: Mapped[str] = mapped_column(String(12), default="monitoring")
    history: Mapped[list[Any]] = mapped_column(default=list)
    serials: Mapped[Optional[str]] = mapped_column(String(200))
    tonnes: Mapped[Optional[float]] = mapped_column(Float)
    buyer: Mapped[Optional[str]] = mapped_column(String(200))


class CreditAllocation(Base):
    """Versioned split of verified solar tonnes between carbon credits and OEM value-chain claims (sums to 1)."""
    __tablename__ = "credit_allocation"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenant.id"))
    project: Mapped[str] = mapped_column(String(20))
    credits_share: Mapped[float] = mapped_column(Float)
    oem_claim_share: Mapped[float] = mapped_column(Float)
    version: Mapped[int] = mapped_column(Integer)
    set_by: Mapped[str] = mapped_column(String(200))
    at: Mapped[dt.datetime] = mapped_column(TS, default=now)


class VerificationRequest(Base):
    __tablename__ = "verification_request"
    id: Mapped[str] = mapped_column(String(60), primary_key=True)
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenant.id"))
    month: Mapped[str] = mapped_column(String(7))
    tonnes: Mapped[float] = mapped_column(Float)
    verifier: Mapped[str] = mapped_column(String(200))
    status: Mapped[str] = mapped_column(String(12))
    created_at: Mapped[dt.datetime] = mapped_column(TS, default=now)


class TenantSetting(Base):
    """Small per-tenant key/value state (measures status, consent, credit price, share links, comments, exports log)."""
    __tablename__ = "tenant_setting"
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenant.id"), primary_key=True)
    key: Mapped[str] = mapped_column(String(40), primary_key=True)
    value: Mapped[Any] = mapped_column(JSON)


# ---------------- FMCG ----------------
class FmcgProduct(Base):
    __tablename__ = "fmcg_product"
    id: Mapped[str] = mapped_column(String(20), primary_key=True)
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenant.id"))
    brand_code: Mapped[str] = mapped_column(String(4))
    data: Mapped[dict[str, Any]] = mapped_column(default=dict)


class MaterialLot(Base):
    __tablename__ = "material_lot"
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenant.id"), primary_key=True)
    code: Mapped[str] = mapped_column(String(20), primary_key=True)
    material: Mapped[str] = mapped_column(String(20))
    supplier: Mapped[str] = mapped_column(String(200))
    flagged: Mapped[bool] = mapped_column(Boolean, default=False)
    flag_reason: Mapped[Optional[str]] = mapped_column(Text)


class Batch(Base):
    __tablename__ = "batch"
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenant.id"), primary_key=True)
    code: Mapped[str] = mapped_column(String(30), primary_key=True)
    idx: Mapped[int] = mapped_column(Integer, index=True)
    product_id: Mapped[str] = mapped_column(String(20))
    brand_code: Mapped[str] = mapped_column(String(4), index=True)
    start: Mapped[int] = mapped_column(BigInteger)
    end: Mapped[int] = mapped_column(BigInteger)
    record: Mapped[dict[str, Any]] = mapped_column(default=dict)
    public_code: Mapped[str] = mapped_column(String(40), unique=True)


class BatchTest(Base):
    __tablename__ = "batch_test"
    tenant_id: Mapped[str] = mapped_column(String(40), primary_key=True)
    batch_code: Mapped[str] = mapped_column(String(30), primary_key=True)
    name: Mapped[str] = mapped_column(String(120), primary_key=True)
    value: Mapped[Optional[str]] = mapped_column(String(120))
    ok: Mapped[Optional[bool]] = mapped_column(Boolean)
    override: Mapped[Optional[str]] = mapped_column(String(10))
    by: Mapped[Optional[str]] = mapped_column(String(200))
    at: Mapped[Optional[int]] = mapped_column(BigInteger)


class BatchLotUsage(Base):
    __tablename__ = "batch_lot_usage"
    tenant_id: Mapped[str] = mapped_column(String(40), primary_key=True)
    batch_code: Mapped[str] = mapped_column(String(30), primary_key=True)
    lot: Mapped[str] = mapped_column(String(20), primary_key=True, index=True)
    kg: Mapped[float] = mapped_column(Float)


class Recall(Base):
    __tablename__ = "recall"
    id: Mapped[str] = mapped_column(String(60), primary_key=True)
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenant.id"))
    lot: Mapped[str] = mapped_column(String(20))
    reason: Mapped[str] = mapped_column(Text)
    created_by: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[dt.datetime] = mapped_column(TS, default=now)
    batches: Mapped[list[Any]] = mapped_column(default=list)
    notified: Mapped[list[Any]] = mapped_column(default=list)
    closed: Mapped[bool] = mapped_column(Boolean, default=False)


class DistributorDispatch(Base):
    __tablename__ = "distributor_dispatch"
    tenant_id: Mapped[str] = mapped_column(String(40), primary_key=True)
    batch_code: Mapped[str] = mapped_column(String(30), primary_key=True)
    distributor: Mapped[str] = mapped_column(String(120), primary_key=True)
    packs: Mapped[int] = mapped_column(Integer)


# ---------------- cluster ----------------
class Cluster(Base):
    __tablename__ = "cluster"
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    meta: Mapped[dict[str, Any]] = mapped_column(default=dict)


class ClusterMember(Base):
    __tablename__ = "cluster_member"
    cluster_id: Mapped[str] = mapped_column(ForeignKey("cluster.id"), primary_key=True)
    id: Mapped[str] = mapped_column(String(20), primary_key=True)
    tenant_id: Mapped[Optional[str]] = mapped_column(String(40))
    data: Mapped[dict[str, Any]] = mapped_column(default=dict)
    active: Mapped[bool] = mapped_column(Boolean, default=True)


class PoolBlock(Base):
    __tablename__ = "pool_block"
    cluster_id: Mapped[str] = mapped_column(String(40), primary_key=True)
    date: Mapped[str] = mapped_column(String(10), primary_key=True)
    block: Mapped[int] = mapped_column(Integer, primary_key=True)
    readings: Mapped[dict[str, Any]] = mapped_column(default=dict)  # member → [sched, actual]
    settlement: Mapped[dict[str, Any]] = mapped_column(default=dict)
    flags: Mapped[dict[str, Any]] = mapped_column(default=dict)


class PoolDay(Base):
    __tablename__ = "pool_day"
    cluster_id: Mapped[str] = mapped_column(String(40), primary_key=True)
    date: Mapped[str] = mapped_column(String(10), primary_key=True)
    solo_cost: Mapped[float] = mapped_column(Float, default=0)
    pooled_cost: Mapped[float] = mapped_column(Float, default=0)
    indiv_pen: Mapped[float] = mapped_column(Float, default=0)
    pooled_pen: Mapped[float] = mapped_column(Float, default=0)
    blocks: Mapped[int] = mapped_column(Integer, default=0)


class ExchangeAgreement(Base):
    __tablename__ = "exchange_agreement"
    cluster_id: Mapped[str] = mapped_column(String(40), primary_key=True)
    id: Mapped[str] = mapped_column(String(30), primary_key=True)
    data: Mapped[dict[str, Any]] = mapped_column(default=dict)
    status: Mapped[str] = mapped_column(String(12))  # proposed agreed
    sender_share: Mapped[float] = mapped_column(Float)
    claim: Mapped[str] = mapped_column(String(12))
    paused_until: Mapped[int] = mapped_column(BigInteger, default=0)
    agreed_at: Mapped[Optional[dt.datetime]] = mapped_column(TS)


class ExchangeLine(Base):
    """A paired weighbridge line: sender dispatch and receiver receipt (both tenants' ledgers)."""
    __tablename__ = "exchange_line"
    id: Mapped[str] = mapped_column(String(80), primary_key=True)
    cluster_id: Mapped[str] = mapped_column(String(40), index=True)
    agreement_id: Mapped[str] = mapped_column(String(30))
    t: Mapped[int] = mapped_column(BigInteger, index=True)
    sender: Mapped[str] = mapped_column(String(20))
    receiver: Mapped[str] = mapped_column(String(20))
    sent_qty: Mapped[float] = mapped_column(Float)
    received_qty: Mapped[float] = mapped_column(Float)
    unit: Mapped[str] = mapped_column(String(10))
    status: Mapped[str] = mapped_column(String(12))  # reconciled mismatch resolved
    confirmed_by: Mapped[list[Any]] = mapped_column(default=list)


class ExchangeAccrual(Base):
    __tablename__ = "exchange_accrual"
    cluster_id: Mapped[str] = mapped_column(String(40), primary_key=True)
    agreement_id: Mapped[str] = mapped_column(String(30), primary_key=True)
    date: Mapped[str] = mapped_column(String(10), primary_key=True)
    inr: Mapped[float] = mapped_column(Float, default=0)
    tco2: Mapped[float] = mapped_column(Float, default=0)
    m3: Mapped[float] = mapped_column(Float, default=0)
    mwh: Mapped[float] = mapped_column(Float, default=0)
    t_mat: Mapped[float] = mapped_column(Float, default=0)


class ClusterNeed(Base):
    __tablename__ = "cluster_need"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    cluster_id: Mapped[str] = mapped_column(String(40))
    member_id: Mapped[str] = mapped_column(String(20))
    what: Mapped[str] = mapped_column(String(200))
    match_proposal: Mapped[Optional[str]] = mapped_column(String(30))
    open: Mapped[bool] = mapped_column(Boolean, default=True)


class ClusterFeed(Base):
    __tablename__ = "cluster_feed"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    cluster_id: Mapped[str] = mapped_column(String(40))
    t: Mapped[int] = mapped_column(BigInteger)
    tone: Mapped[str] = mapped_column(String(6))
    text: Mapped[str] = mapped_column(Text)


# ---------------- onboarding ----------------
class OnboardingCase(Base):
    __tablename__ = "onboarding_case"
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    supplier: Mapped[str] = mapped_column(String(200))
    cluster: Mapped[str] = mapped_column(String(100))
    sponsor: Mapped[str] = mapped_column(String(100))
    associate: Mapped[str] = mapped_column(String(100))
    stage: Mapped[int] = mapped_column(Integer)
    days_in_stage: Mapped[int] = mapped_column(Integer, default=0)
    days_total: Mapped[int] = mapped_column(Integer, default=0)
    sample: Mapped[bool] = mapped_column(Boolean, default=True)


class KybCheck(Base):
    __tablename__ = "kyb_check"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    kind: Mapped[str] = mapped_column(String(10))
    input: Mapped[str] = mapped_column(String(60))
    result: Mapped[dict[str, Any]] = mapped_column(default=dict)
    by: Mapped[str] = mapped_column(String(200))
    at: Mapped[dt.datetime] = mapped_column(TS, default=now)
