import secrets
import string
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import delete, select

from app.auth import (
    AuthUser,
    MCP_TOKEN_PREFIX,
    hash_mcp_token,
    mint_token_for_user,
    require_admin,
    require_auth,
)
from app.db import SessionLocal
from app.models import Enterprise, EnterpriseMembership, InviteCode, McpAccessToken, User, UserRole

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


class SwitchEnterpriseRequest(BaseModel):
    enterprise_id: int


class UpdateRoleRequest(BaseModel):
    role: UserRole


@router.get("/mcp-token", include_in_schema=False)
def get_mcp_token_status(current_user: AuthUser = Depends(require_auth)):
    if current_user.enterprise_id is None:
        raise HTTPException(status_code=400, detail="Not part of an enterprise")
    with SessionLocal() as db:
        row = db.execute(
            select(McpAccessToken).where(
                McpAccessToken.user_id == current_user.id,
                McpAccessToken.enterprise_id == current_user.enterprise_id,
            ),
        ).scalar_one_or_none()
    if row is None:
        return {"configured": False, "created_at": None}
    return {
        "configured": True,
        "created_at": row.created_at.isoformat(),
        "hint": f"{MCP_TOKEN_PREFIX}… (full value shown only when created)",
    }


@router.post("/mcp-token", include_in_schema=False)
def create_or_rotate_mcp_token(current_user: AuthUser = Depends(require_auth)):
    if current_user.enterprise_id is None:
        raise HTTPException(status_code=400, detail="Not part of an enterprise")
    with SessionLocal() as db:
        m = db.execute(
            select(EnterpriseMembership).where(
                EnterpriseMembership.user_id == current_user.id,
                EnterpriseMembership.enterprise_id == current_user.enterprise_id,
            ),
        ).scalar_one_or_none()
        if m is None:
            raise HTTPException(status_code=403, detail="No membership for this workspace")
        existing = db.execute(
            select(McpAccessToken).where(
                McpAccessToken.user_id == current_user.id,
                McpAccessToken.enterprise_id == current_user.enterprise_id,
            ),
        ).scalar_one_or_none()
        if existing is not None:
            db.delete(existing)
            db.flush()
        raw = f"{MCP_TOKEN_PREFIX}{secrets.token_urlsafe(32)}"
        db.add(
            McpAccessToken(
                user_id=current_user.id,
                enterprise_id=current_user.enterprise_id,
                token_hash=hash_mcp_token(raw),
            ),
        )
        db.commit()
        row = db.execute(
            select(McpAccessToken).where(
                McpAccessToken.user_id == current_user.id,
                McpAccessToken.enterprise_id == current_user.enterprise_id,
            ),
        ).scalar_one_or_none()
        created_at = row.created_at.isoformat() if row else ""
    return {"token": raw, "created_at": created_at}


@router.delete("/mcp-token", include_in_schema=False)
def revoke_own_mcp_token(current_user: AuthUser = Depends(require_auth)):
    if current_user.enterprise_id is None:
        raise HTTPException(status_code=400, detail="Not part of an enterprise")
    with SessionLocal() as db:
        db.execute(
            delete(McpAccessToken).where(
                McpAccessToken.user_id == current_user.id,
                McpAccessToken.enterprise_id == current_user.enterprise_id,
            ),
        )
        db.commit()
    return {"revoked": True}


@router.delete("/mcp-token/members/{user_id}", include_in_schema=False)
def admin_revoke_member_mcp_token(user_id: int, current_user: AuthUser = Depends(require_admin)):
    if current_user.enterprise_id is None:
        raise HTTPException(status_code=400, detail="Not part of an enterprise")
    with SessionLocal() as db:
        m = db.execute(
            select(EnterpriseMembership).where(
                EnterpriseMembership.user_id == user_id,
                EnterpriseMembership.enterprise_id == current_user.enterprise_id,
            ),
        ).scalar_one_or_none()
        if m is None:
            raise HTTPException(status_code=404, detail="Member not found")
        db.execute(
            delete(McpAccessToken).where(
                McpAccessToken.user_id == user_id,
                McpAccessToken.enterprise_id == current_user.enterprise_id,
            ),
        )
        db.commit()
    return {"revoked": user_id}


@router.get("/me", include_in_schema=False)
def list_my_enterprises(current_user: AuthUser = Depends(require_auth)):
    with SessionLocal() as db:
        rows = db.execute(
            select(EnterpriseMembership, Enterprise.name)
            .join(Enterprise, Enterprise.id == EnterpriseMembership.enterprise_id)
            .where(EnterpriseMembership.user_id == current_user.id)
            .order_by(Enterprise.name.asc()),
        ).all()
        return [
            {
                "enterprise_id": m.enterprise_id,
                "enterprise_name": name,
                "role": m.role.value,
                "is_active": m.enterprise_id == current_user.enterprise_id,
            }
            for m, name in rows
        ]


@router.post("/switch", include_in_schema=False)
def switch_enterprise(body: SwitchEnterpriseRequest, current_user: AuthUser = Depends(require_auth)):
    with SessionLocal() as db:
        user = db.execute(select(User).where(User.id == current_user.id)).scalar_one_or_none()
        if user is None:
            raise HTTPException(status_code=401, detail="User not found")
        m = db.execute(
            select(EnterpriseMembership).where(
                EnterpriseMembership.user_id == user.id,
                EnterpriseMembership.enterprise_id == body.enterprise_id,
            ),
        ).scalar_one_or_none()
        if m is None:
            raise HTTPException(status_code=404, detail="You are not a member of that enterprise")
        user.last_active_enterprise_id = body.enterprise_id
        db.add(user)
        db.commit()
        db.refresh(user)
        token = mint_token_for_user(db, user)
        ent = db.get(Enterprise, m.enterprise_id)
        return {
            "token": token,
            "enterprise_id": m.enterprise_id,
            "enterprise_name": ent.name if ent else "",
            "role": m.role.value,
        }


@router.post("", include_in_schema=False)
def create_enterprise(body: CreateEnterpriseRequest, current_user: AuthUser = Depends(require_auth)):
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Enterprise name cannot be empty")

    with SessionLocal() as db:
        user = db.execute(select(User).where(User.google_id == current_user.google_id)).scalar_one_or_none()
        if user is None:
            raise HTTPException(status_code=401, detail="User not found")

        existing = db.execute(select(Enterprise).where(Enterprise.name == name)).scalar_one_or_none()
        if existing is not None:
            raise HTTPException(status_code=409, detail="An enterprise with that name already exists")

        enterprise = Enterprise(name=name)
        db.add(enterprise)
        db.flush()

        db.add(
            EnterpriseMembership(
                user_id=user.id,
                enterprise_id=enterprise.id,
                role=UserRole.admin,
            ),
        )
        user.last_active_enterprise_id = enterprise.id
        db.add(user)
        db.commit()
        db.refresh(user)

        token = mint_token_for_user(db, user)

        return {
            "enterprise_id": enterprise.id,
            "enterprise_name": enterprise.name,
            "role": UserRole.admin.value,
            "token": token,
        }


@router.post("/join", include_in_schema=False)
def join_enterprise(body: JoinEnterpriseRequest, current_user: AuthUser = Depends(require_auth)):
    code_str = (body.code or "").strip().upper()
    if not code_str:
        raise HTTPException(status_code=400, detail="Invite code cannot be empty")

    with SessionLocal() as db:
        user = db.execute(select(User).where(User.google_id == current_user.google_id)).scalar_one_or_none()
        if user is None:
            raise HTTPException(status_code=401, detail="User not found")

        invite = db.execute(select(InviteCode).where(InviteCode.code == code_str)).scalar_one_or_none()
        if invite is None:
            raise HTTPException(status_code=404, detail="Invalid invite code")

        now = datetime.now(timezone.utc)
        if invite.expires_at is not None and invite.expires_at.replace(tzinfo=timezone.utc) < now:
            raise HTTPException(status_code=410, detail="Invite code has expired")

        dup = db.execute(
            select(EnterpriseMembership).where(
                EnterpriseMembership.user_id == user.id,
                EnterpriseMembership.enterprise_id == invite.enterprise_id,
            ),
        ).scalar_one_or_none()
        if dup is not None:
            raise HTTPException(status_code=409, detail="You already belong to that enterprise")

        enterprise = db.get(Enterprise, invite.enterprise_id)
        db.add(
            EnterpriseMembership(
                user_id=user.id,
                enterprise_id=invite.enterprise_id,
                role=UserRole.querier,
            ),
        )
        user.last_active_enterprise_id = invite.enterprise_id
        db.add(user)
        db.commit()
        db.refresh(user)

        token = mint_token_for_user(db, user)

        return {
            "enterprise_id": enterprise.id,
            "enterprise_name": enterprise.name,
            "role": UserRole.querier.value,
            "token": token,
        }


@router.post("/invite-codes", include_in_schema=False)
def create_invite_code(current_user: AuthUser = Depends(require_admin)):
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


@router.get("/invite-codes", include_in_schema=False)
def list_invite_codes(current_user: AuthUser = Depends(require_admin)):
    if current_user.enterprise_id is None:
        raise HTTPException(status_code=400, detail="Not part of an enterprise")

    now = datetime.now(timezone.utc)
    with SessionLocal() as db:
        codes = db.execute(
            select(InviteCode)
            .where(InviteCode.enterprise_id == current_user.enterprise_id)
            .order_by(InviteCode.created_at.desc()),
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


@router.delete("/invite-codes/{code}", include_in_schema=False)
def revoke_invite_code(code: str, current_user: AuthUser = Depends(require_admin)):
    if current_user.enterprise_id is None:
        raise HTTPException(status_code=400, detail="Not part of an enterprise")

    code_str = code.strip().upper()
    with SessionLocal() as db:
        invite = db.execute(
            select(InviteCode).where(
                InviteCode.code == code_str,
                InviteCode.enterprise_id == current_user.enterprise_id,
            ),
        ).scalar_one_or_none()
        if invite is None:
            raise HTTPException(status_code=404, detail="Invite code not found")
        db.delete(invite)
        db.commit()

    return {"revoked": code_str}


@router.get("/members", include_in_schema=False)
def list_members(current_user: AuthUser = Depends(require_admin)):
    if current_user.enterprise_id is None:
        raise HTTPException(status_code=400, detail="Not part of an enterprise")

    with SessionLocal() as db:
        rows = db.execute(
            select(User, EnterpriseMembership.role)
            .join(EnterpriseMembership, EnterpriseMembership.user_id == User.id)
            .where(EnterpriseMembership.enterprise_id == current_user.enterprise_id)
            .order_by(User.created_at.asc()),
        ).all()

        out = []
        for u, role in rows:
            has_mcp = (
                db.execute(
                    select(McpAccessToken.id).where(
                        McpAccessToken.user_id == u.id,
                        McpAccessToken.enterprise_id == current_user.enterprise_id,
                    ).limit(1),
                ).scalar_one_or_none()
                is not None
            )
            out.append(
                {
                    "id": u.id,
                    "login": u.login,
                    "role": role.value,
                    "joined_at": u.created_at.isoformat(),
                    "mcp_token_configured": has_mcp,
                },
            )
        return out


@router.patch("/members/{user_id}/role", include_in_schema=False)
def update_member_role(user_id: int, body: UpdateRoleRequest, current_user: AuthUser = Depends(require_admin)):
    if current_user.enterprise_id is None:
        raise HTTPException(status_code=400, detail="Not part of an enterprise")
    if user_id == current_user.id:
        raise HTTPException(status_code=400, detail="You cannot change your own role")

    with SessionLocal() as db:
        m = db.execute(
            select(EnterpriseMembership).where(
                EnterpriseMembership.user_id == user_id,
                EnterpriseMembership.enterprise_id == current_user.enterprise_id,
            ),
        ).scalar_one_or_none()
        if m is None:
            raise HTTPException(status_code=404, detail="Member not found")

        m.role = body.role
        db.add(m)
        db.commit()
        db.refresh(m)
        target = db.get(User, user_id)
        if target is None:
            raise HTTPException(status_code=404, detail="Member not found")

        return {
            "id": target.id,
            "login": target.login,
            "role": m.role.value,
        }


@router.delete("/members/{user_id}", include_in_schema=False)
def remove_member(user_id: int, current_user: AuthUser = Depends(require_admin)):
    if current_user.enterprise_id is None:
        raise HTTPException(status_code=400, detail="Not part of an enterprise")
    if user_id == current_user.id:
        raise HTTPException(status_code=400, detail="You cannot remove yourself from the enterprise")

    with SessionLocal() as db:
        m = db.execute(
            select(EnterpriseMembership).where(
                EnterpriseMembership.user_id == user_id,
                EnterpriseMembership.enterprise_id == current_user.enterprise_id,
            ),
        ).scalar_one_or_none()
        if m is None:
            raise HTTPException(status_code=404, detail="Member not found")

        target = db.get(User, user_id)
        if target is not None and target.last_active_enterprise_id == current_user.enterprise_id:
            target.last_active_enterprise_id = None
            db.add(target)

        db.execute(
            delete(McpAccessToken).where(
                McpAccessToken.user_id == user_id,
                McpAccessToken.enterprise_id == current_user.enterprise_id,
            ),
        )
        db.delete(m)
        db.commit()

    return {"removed": user_id}
