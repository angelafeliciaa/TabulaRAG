import secrets
import string
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select

from app.auth import require_admin, require_auth
from app.db import SessionLocal
from app.models import Enterprise, InviteCode, User, UserRole

router = APIRouter(prefix="/enterprises")

_INVITE_CODE_LENGTH = 8
_INVITE_CODE_EXPIRY_HOURS = 48
_CODE_ALPHABET = string.ascii_uppercase + string.digits


def _generate_unique_code(db) -> str:
    for _ in range(10):
        code = "".join(secrets.choice(_CODE_ALPHABET) for _ in range(_INVITE_CODE_LENGTH))
        exists = db.execute(select(InviteCode).where(InviteCode.code == code)).scalar_one_or_none()
        if exists is None:
            return code
    raise HTTPException(status_code=500, detail="Failed to generate a unique invite code")


class CreateEnterpriseRequest(BaseModel):
    name: str


class JoinEnterpriseRequest(BaseModel):
    code: str


class UpdateRoleRequest(BaseModel):
    role: UserRole


@router.post("")
def create_enterprise(body: CreateEnterpriseRequest, current_user: User = Depends(require_auth)):
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Enterprise name cannot be empty")

    with SessionLocal() as db:
        user = db.execute(select(User).where(User.google_id == current_user.google_id)).scalar_one_or_none()
        if user is None:
            raise HTTPException(status_code=401, detail="User not found")
        if user.enterprise_id is not None:
            raise HTTPException(status_code=400, detail="You already belong to an enterprise")

        existing = db.execute(select(Enterprise).where(Enterprise.name == name)).scalar_one_or_none()
        if existing is not None:
            raise HTTPException(status_code=409, detail="An enterprise with that name already exists")

        enterprise = Enterprise(name=name)
        db.add(enterprise)
        db.flush()

        user.enterprise_id = enterprise.id
        user.role = UserRole.admin
        db.commit()

        return {
            "enterprise_id": enterprise.id,
            "enterprise_name": enterprise.name,
            "role": user.role.value,
        }


@router.post("/join")
def join_enterprise(body: JoinEnterpriseRequest, current_user: User = Depends(require_auth)):
    code_str = (body.code or "").strip().upper()
    if not code_str:
        raise HTTPException(status_code=400, detail="Invite code cannot be empty")

    with SessionLocal() as db:
        user = db.execute(select(User).where(User.google_id == current_user.google_id)).scalar_one_or_none()
        if user is None:
            raise HTTPException(status_code=401, detail="User not found")
        if user.enterprise_id is not None:
            raise HTTPException(status_code=400, detail="You already belong to an enterprise")

        invite = db.execute(select(InviteCode).where(InviteCode.code == code_str)).scalar_one_or_none()
        if invite is None:
            raise HTTPException(status_code=404, detail="Invalid invite code")

        now = datetime.now(timezone.utc)
        if invite.expires_at is not None and invite.expires_at.replace(tzinfo=timezone.utc) < now:
            raise HTTPException(status_code=410, detail="Invite code has expired")

        enterprise = db.get(Enterprise, invite.enterprise_id)
        user.enterprise_id = invite.enterprise_id
        user.role = UserRole.querier
        db.commit()

        return {
            "enterprise_id": enterprise.id,
            "enterprise_name": enterprise.name,
            "role": user.role.value,
        }


@router.post("/invite-codes")
def create_invite_code(current_user: User = Depends(require_admin)):
    if current_user.enterprise_id is None:
        raise HTTPException(status_code=400, detail="Not part of an enterprise")

    with SessionLocal() as db:
        code_str = _generate_unique_code(db)
        expires_at = datetime.now(timezone.utc) + timedelta(hours=_INVITE_CODE_EXPIRY_HOURS)
        invite = InviteCode(
            enterprise_id=current_user.enterprise_id,
            code=code_str,
            created_by=current_user.id,
            expires_at=expires_at,
        )
        db.add(invite)
        db.commit()
        db.refresh(invite)

        return {
            "code": invite.code,
            "expires_at": invite.expires_at.isoformat(),
            "created_at": invite.created_at.isoformat(),
        }


@router.get("/invite-codes")
def list_invite_codes(current_user: User = Depends(require_admin)):
    if current_user.enterprise_id is None:
        raise HTTPException(status_code=400, detail="Not part of an enterprise")

    now = datetime.now(timezone.utc)
    with SessionLocal() as db:
        codes = db.execute(
            select(InviteCode)
            .where(InviteCode.enterprise_id == current_user.enterprise_id)
            .order_by(InviteCode.created_at.desc())
        ).scalars().all()

        return [
            {
                "code": c.code,
                "expires_at": c.expires_at.isoformat() if c.expires_at else None,
                "expired": c.expires_at is not None and c.expires_at.replace(tzinfo=timezone.utc) < now,
                "created_at": c.created_at.isoformat(),
            }
            for c in codes
        ]


@router.delete("/invite-codes/{code}")
def revoke_invite_code(code: str, current_user: User = Depends(require_admin)):
    if current_user.enterprise_id is None:
        raise HTTPException(status_code=400, detail="Not part of an enterprise")

    code_str = code.strip().upper()
    with SessionLocal() as db:
        invite = db.execute(
            select(InviteCode).where(
                InviteCode.code == code_str,
                InviteCode.enterprise_id == current_user.enterprise_id,
            )
        ).scalar_one_or_none()
        if invite is None:
            raise HTTPException(status_code=404, detail="Invite code not found")
        db.delete(invite)
        db.commit()

    return {"revoked": code_str}


@router.get("/members")
def list_members(current_user: User = Depends(require_admin)):
    if current_user.enterprise_id is None:
        raise HTTPException(status_code=400, detail="Not part of an enterprise")

    with SessionLocal() as db:
        members = db.execute(
            select(User)
            .where(User.enterprise_id == current_user.enterprise_id)
            .order_by(User.created_at.asc())
        ).scalars().all()

        return [
            {
                "id": m.id,
                "login": m.login,
                "role": m.role.value,
                "joined_at": m.created_at.isoformat(),
            }
            for m in members
        ]


@router.patch("/members/{user_id}/role")
def update_member_role(user_id: int, body: UpdateRoleRequest, current_user: User = Depends(require_admin)):
    if current_user.enterprise_id is None:
        raise HTTPException(status_code=400, detail="Not part of an enterprise")
    if user_id == current_user.id:
        raise HTTPException(status_code=400, detail="You cannot change your own role")

    with SessionLocal() as db:
        target = db.get(User, user_id)
        if target is None or target.enterprise_id != current_user.enterprise_id:
            raise HTTPException(status_code=404, detail="Member not found")

        target.role = body.role
        db.commit()

        return {
            "id": target.id,
            "login": target.login,
            "role": target.role.value,
        }


@router.delete("/members/{user_id}")
def remove_member(user_id: int, current_user: User = Depends(require_admin)):
    if current_user.enterprise_id is None:
        raise HTTPException(status_code=400, detail="Not part of an enterprise")
    if user_id == current_user.id:
        raise HTTPException(status_code=400, detail="You cannot remove yourself from the enterprise")

    with SessionLocal() as db:
        target = db.get(User, user_id)
        if target is None or target.enterprise_id != current_user.enterprise_id:
            raise HTTPException(status_code=404, detail="Member not found")

        target.enterprise_id = None
        target.role = UserRole.querier
        db.commit()

    return {"removed": user_id}
