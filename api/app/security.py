"""Auth (email + OTP → JWT), role-based access, tenancy context, device keys and the hash-chained audit log."""
from __future__ import annotations

import datetime as dt
import hashlib
import hmac
import logging
import secrets
import threading
from dataclasses import dataclass, field
from typing import Iterable, Optional

import jwt
from fastapi import Depends, Header, HTTPException, Query, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import settings
from .db import get_db
from .models import AuditEvent, Device, OemSupplierLink, RoleAssignment, Tenant, User

log = logging.getLogger("carbonkhata.auth")
ROLES = ("operator", "custodian", "owner", "oem", "cluster", "admin")
PLANT_ROLES = ("operator", "custodian", "owner")


def _h(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


@dataclass
class Ctx:
    user_id: str
    name: str
    email: str
    role: str
    tenant_id: str
    tenant_kind: str
    tenant_code: Optional[str] = None
    read_only: bool = False
    device: bool = False
    tenants: list[str] = field(default_factory=list)

    @property
    def actor(self) -> str:
        return self.name


def issue_token(user: User, ra: RoleAssignment, tenant: Tenant, read_only: bool = False, minutes: int | None = None) -> str:
    exp = dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=minutes or settings.jwt_ttl_minutes)
    claims = {"sub": user.id, "name": user.name, "email": user.email, "role": ra.role, "tid": tenant.id, "tkind": tenant.kind, "tcode": tenant.code, "ro": read_only, "exp": exp}
    return jwt.encode(claims, settings.jwt_secret, algorithm="HS256")


def new_otp(db: Session, email: str) -> str:
    from .models import OtpChallenge
    code = f"{secrets.randbelow(1_000_000):06d}"
    db.add(OtpChallenge(email=email.lower(), code_hash=_h(f"{email.lower()}:{code}"), expires_at=dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=10)))
    db.commit()
    print(f"\n[OTP] sign-in code for {email}: {code}  (dev mode: printed instead of e-mailed)\n", flush=True)
    return code


def check_otp(db: Session, email: str, code: str) -> bool:
    from .models import OtpChallenge
    rows = db.scalars(select(OtpChallenge).where(OtpChallenge.email == email.lower(), OtpChallenge.used.is_(False)).order_by(OtpChallenge.id.desc()).limit(3)).all()
    nowt = dt.datetime.now(dt.timezone.utc)
    for r in rows:
        r.attempts += 1
        if r.attempts <= 5 and r.expires_at > nowt and hmac.compare_digest(r.code_hash, _h(f"{email.lower()}:{code}")):
            r.used = True
            db.commit()
            return True
    db.commit()
    return False


def _device_ctx(db: Session, key: str) -> Ctx:
    pairs = dict(p.split(":", 1) for p in settings.device_keys.split(",") if ":" in p)
    for dev_id, k in pairs.items():
        if hmac.compare_digest(k, key):
            d = db.get(Device, dev_id)
            if d is None:
                break
            t = db.get(Tenant, d.tenant_id)
            return Ctx(user_id=d.id, name=d.name, email="", role="device", tenant_id=d.tenant_id, tenant_kind=t.kind if t else "plant", tenant_code=t.code if t else None, device=True)
    raise HTTPException(401, "Unknown device key")


def current(request: Request, db: Session = Depends(get_db), authorization: str = Header(default=""), x_device_key: str = Header(default=""),
            token: str = Query(default="")) -> Ctx:
    if x_device_key:
        return _device_ctx(db, x_device_key)
    raw = authorization.removeprefix("Bearer ").strip() or token
    if not raw:
        raise HTTPException(401, "Sign in required")
    try:
        c = jwt.decode(raw, settings.jwt_secret, algorithms=["HS256"])
    except jwt.PyJWTError:
        raise HTTPException(401, "Session expired, sign in again")
    ctx = Ctx(user_id=c["sub"], name=c["name"], email=c["email"], role=c["role"], tenant_id=c["tid"], tenant_kind=c["tkind"], tenant_code=c.get("tcode"), read_only=bool(c.get("ro")))
    if request.method not in ("GET", "HEAD", "OPTIONS") and ctx.read_only and not request.url.path.endswith("/auth/end-support"):
        raise HTTPException(403, "Read-only support session: changes are disabled.")
    return ctx


def require(*roles: str):
    def dep(ctx: Ctx = Depends(current)) -> Ctx:
        if ctx.role not in roles and not (ctx.device and "device" in roles):
            raise HTTPException(403, f"Not allowed for role '{ctx.role}'")
        return ctx
    return dep


def plant_tenant_for(db: Session, ctx: Ctx, supplier_id: Optional[str] = None) -> str:
    """Which plant's data the caller may read. Plant roles → own tenant. OEM → a linked supplier with consent.
    Admin → any plant. Cluster coordinator → none (aggregates only)."""
    if ctx.role in PLANT_ROLES or (ctx.device and ctx.tenant_kind == "plant"):
        if supplier_id and supplier_id != ctx.tenant_id:
            raise HTTPException(403, "Other tenants' data is not visible")
        return ctx.tenant_id
    if ctx.role == "admin":
        return supplier_id or "vbw"
    if ctx.role == "oem":
        links = db.scalars(select(OemSupplierLink).where(OemSupplierLink.oem_tenant_id == ctx.tenant_id, OemSupplierLink.consent.is_not(None))).all()
        allowed = [l.supplier_tenant_id for l in links]
        sid = supplier_id or (allowed[0] if allowed else None)
        if not sid or sid not in allowed:
            raise HTTPException(403, "This supplier has not shared data with you")
        return sid
    raise HTTPException(403, "No plant data for this role")


# ---------------- audit (append-only, hash-chained) ----------------
_audit_lock = threading.Lock()


def audit(db: Session, actor: str, role: Optional[str], action: str, entity: str, detail: str = "", tenant_id: Optional[str] = None, commit: bool = True):
    with _audit_lock:
        prev = db.scalars(select(AuditEvent.hash).order_by(AuditEvent.id.desc()).limit(1)).first()
        at = dt.datetime.now(dt.timezone.utc)
        h = _h(f"{prev or ''}|{at.isoformat()}|{tenant_id}|{actor}|{action}|{entity}|{detail}")
        db.add(AuditEvent(at=at, tenant_id=tenant_id, actor=actor, role=role, action=action, entity=entity, detail=detail[:4000], prev_hash=prev, hash=h))
        if commit:
            db.commit()


def roles_of(db: Session, user_id: str) -> list[RoleAssignment]:
    return list(db.scalars(select(RoleAssignment).where(RoleAssignment.user_id == user_id)).all())
