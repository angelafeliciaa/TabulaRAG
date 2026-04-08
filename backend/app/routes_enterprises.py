import secrets
import string
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import delete, func, select

from app.auth import (
    AuthUser,
    MCP_TOKEN_PREFIX,
    get_active_membership,
    hash_mcp_token,
    is_admin_capable,
    mint_token_for_user,
    require_admin,
    require_auth,
    require_owner,
)
from app.db import SessionLocal
from app.index_jobs import clear_index_job
from app.models import (
    Dataset,
    DatasetColumn,
    DatasetRow,
    Enterprise,
    EnterpriseMembership,
    InviteCode,
    McpAccessToken,
    User,
    UserRole,
)
from app.routes_tables import _delete_collection_safe

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


class RenameEnterpriseRequest(BaseModel):
    name: str


class JoinEnterpriseRequest(BaseModel):
    code: str


class SwitchEnterpriseRequest(BaseModel):
    enterprise_id: int


class UpdateRoleRequest(BaseModel):
    role: UserRole


class TransferOwnershipRequest(BaseModel):
    user_id: int


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
        "hint": f"{MCP_TOKEN_PREFIX}… (full value shown only when generated)",
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
        eids = {m.enterprise_id for m, _ in rows}
        counts: dict[int, int] = {}
        if eids:
            cnt_rows = db.execute(
                select(EnterpriseMembership.enterprise_id, func.count().label("c"))
                .where(EnterpriseMembership.enterprise_id.in_(eids))
                .group_by(EnterpriseMembership.enterprise_id),
            ).all()
            counts = {int(eid): int(c) for eid, c in cnt_rows}
        return [
            {
                "enterprise_id": m.enterprise_id,
                "enterprise_name": name,
                "role": m.role.value,
                "is_active": m.enterprise_id == current_user.enterprise_id,
                "member_count": counts.get(m.enterprise_id, 0),
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


@router.post("/leave", include_in_schema=False)
def leave_current_enterprise(current_user: AuthUser = Depends(require_auth)):
    """Remove the current user from their active workspace. Owners must transfer ownership first."""
    if current_user.enterprise_id is None:
        raise HTTPException(status_code=400, detail="Not part of an enterprise")
    eid = current_user.enterprise_id

    with SessionLocal() as db:
        user = db.execute(select(User).where(User.id == current_user.id)).scalar_one_or_none()
        if user is None:
            raise HTTPException(status_code=401, detail="User not found")
        m = db.execute(
            select(EnterpriseMembership).where(
                EnterpriseMembership.user_id == user.id,
                EnterpriseMembership.enterprise_id == eid,
            ),
        ).scalar_one_or_none()
        if m is None:
            raise HTTPException(status_code=404, detail="No membership for this workspace")
        if m.role == UserRole.owner:
            raise HTTPException(
                status_code=400,
                detail="Workspace owners cannot leave until ownership is transferred to another member",
            )

        db.execute(
            delete(McpAccessToken).where(
                McpAccessToken.user_id == user.id,
                McpAccessToken.enterprise_id == eid,
            ),
        )
        db.delete(m)
        db.flush()

        if user.last_active_enterprise_id == eid:
            other = db.execute(
                select(EnterpriseMembership)
                .where(EnterpriseMembership.user_id == user.id)
                .order_by(EnterpriseMembership.id.asc()),
            ).scalars().first()
            user.last_active_enterprise_id = other.enterprise_id if other else None
            db.add(user)

        db.commit()
        db.refresh(user)
        token = mint_token_for_user(db, user)
        m_active = get_active_membership(db, user)
        ent_name = ""
        if m_active is not None:
            ent = db.get(Enterprise, m_active.enterprise_id)
            ent_name = ent.name if ent else ""

    return {
        "token": token,
        "enterprise_id": m_active.enterprise_id if m_active else None,
        "enterprise_name": ent_name,
        "role": m_active.role.value if m_active else None,
    }


@router.post("", include_in_schema=False)
def create_enterprise(body: CreateEnterpriseRequest, current_user: AuthUser = Depends(require_auth)):
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Workspace name cannot be empty")
    if len(name) > 255:
        raise HTTPException(status_code=400, detail="Workspace name is too long")

    with SessionLocal() as db:
        if current_user.id == 0:
            raise HTTPException(status_code=401, detail="User not found")
        user = db.get(User, current_user.id)
        if user is None:
            raise HTTPException(status_code=401, detail="User not found")

        enterprise = Enterprise(name=name)
        db.add(enterprise)
        db.flush()

        db.add(
            EnterpriseMembership(
                user_id=user.id,
                enterprise_id=enterprise.id,
                role=UserRole.owner,
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
            "role": UserRole.owner.value,
            "token": token,
        }


@router.patch("/name", include_in_schema=False)
def rename_current_enterprise(
    body: RenameEnterpriseRequest,
    current_user: AuthUser = Depends(require_owner),
):
    if current_user.enterprise_id is None:
        raise HTTPException(status_code=400, detail="Not part of an enterprise")
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Workspace name cannot be empty")
    if len(name) > 255:
        raise HTTPException(status_code=400, detail="Workspace name is too long")

    with SessionLocal() as db:
        ent = db.get(Enterprise, current_user.enterprise_id)
        if ent is None:
            raise HTTPException(status_code=404, detail="Workspace not found")
        ent.name = name
        db.add(ent)
        db.commit()

    return {"enterprise_id": current_user.enterprise_id, "enterprise_name": name}


@router.post("/join", include_in_schema=False)
def join_enterprise(body: JoinEnterpriseRequest, current_user: AuthUser = Depends(require_auth)):
    code_str = (body.code or "").strip().upper()
    if not code_str:
        raise HTTPException(status_code=400, detail="Invite code cannot be empty")

    with SessionLocal() as db:
        if current_user.id == 0:
            raise HTTPException(status_code=401, detail="User not found")
        user = db.get(User, current_user.id)
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
def list_members(current_user: AuthUser = Depends(require_auth)):
    if current_user.enterprise_id is None:
        raise HTTPException(status_code=400, detail="Not part of an enterprise")

    viewer_is_admin = is_admin_capable(current_user.role)

    with SessionLocal() as db:
        rows = db.execute(
            select(User, EnterpriseMembership.role)
            .join(EnterpriseMembership, EnterpriseMembership.user_id == User.id)
            .where(EnterpriseMembership.enterprise_id == current_user.enterprise_id)
            .order_by(User.created_at.asc()),
        ).all()

        out = []
        for u, role in rows:
            display_name = (u.display_name or "").strip() or u.login.split("@", 1)[0]
            is_self = u.id == current_user.id
            entry: dict = {
                "id": u.id,
                "display_name": display_name,
                "is_self": is_self,
                "role": role.value,
                "joined_at": u.created_at.isoformat(),
            }
            if viewer_is_admin or is_self:
                entry["login"] = u.login
            if viewer_is_admin:
                has_mcp = (
                    db.execute(
                        select(McpAccessToken.id).where(
                            McpAccessToken.user_id == u.id,
                            McpAccessToken.enterprise_id == current_user.enterprise_id,
                        ).limit(1),
                    ).scalar_one_or_none()
                    is not None
                )
                entry["mcp_token_configured"] = has_mcp
            out.append(entry)
        return out


@router.post("/transfer-ownership", include_in_schema=False)
def transfer_ownership(body: TransferOwnershipRequest, current_user: AuthUser = Depends(require_owner)):
    if current_user.enterprise_id is None:
        raise HTTPException(status_code=400, detail="Not part of an enterprise")
    if body.user_id == current_user.id:
        raise HTTPException(status_code=400, detail="You already own this enterprise")

    eid = current_user.enterprise_id
    with SessionLocal() as db:
        me = db.execute(
            select(EnterpriseMembership).where(
                EnterpriseMembership.user_id == current_user.id,
                EnterpriseMembership.enterprise_id == eid,
            ),
        ).scalar_one_or_none()
        if me is None or me.role != UserRole.owner:
            raise HTTPException(status_code=403, detail="Enterprise owner access required")

        target = db.execute(
            select(EnterpriseMembership).where(
                EnterpriseMembership.user_id == body.user_id,
                EnterpriseMembership.enterprise_id == eid,
            ),
        ).scalar_one_or_none()
        if target is None:
            raise HTTPException(status_code=404, detail="Member not found")
        if target.role not in (UserRole.admin, UserRole.querier):
            raise HTTPException(status_code=400, detail="Invalid target role for ownership transfer")

        me.role = UserRole.admin
        target.role = UserRole.owner
        db.add(me)
        db.add(target)
        db.commit()

        user = db.execute(select(User).where(User.id == current_user.id)).scalars().first()
        if user is None:
            raise HTTPException(status_code=401, detail="User not found")
        token = mint_token_for_user(db, user)

    return {"token": token, "role": UserRole.admin.value}


@router.delete("", include_in_schema=False)
def disband_enterprise(
    background_tasks: BackgroundTasks,
    current_user: AuthUser = Depends(require_owner),
):
    """Permanently delete the enterprise, all memberships, invites, MCP tokens, and datasets."""
    if current_user.enterprise_id is None:
        raise HTTPException(status_code=400, detail="Not part of an enterprise")
    eid = current_user.enterprise_id
    dataset_ids: list[int] = []

    with SessionLocal() as db:
        me = db.execute(
            select(EnterpriseMembership).where(
                EnterpriseMembership.user_id == current_user.id,
                EnterpriseMembership.enterprise_id == eid,
                EnterpriseMembership.role == UserRole.owner,
            ),
        ).scalar_one_or_none()
        if me is None:
            raise HTTPException(status_code=403, detail="Enterprise owner access required")

        ent = db.get(Enterprise, eid)
        if ent is None:
            raise HTTPException(status_code=404, detail="Enterprise not found")

        dataset_ids = list(db.execute(select(Dataset.id).where(Dataset.enterprise_id == eid)).scalars().all())
        for did in dataset_ids:
            db.execute(delete(DatasetRow).where(DatasetRow.dataset_id == did))
            db.execute(delete(DatasetColumn).where(DatasetColumn.dataset_id == did))
            db.execute(delete(Dataset).where(Dataset.id == did))

        member_user_ids = db.execute(
            select(EnterpriseMembership.user_id).where(EnterpriseMembership.enterprise_id == eid),
        ).scalars().all()
        for uid in member_user_ids:
            u = db.get(User, uid)
            if u is not None and u.last_active_enterprise_id == eid:
                u.last_active_enterprise_id = None
                db.add(u)

        db.execute(delete(McpAccessToken).where(McpAccessToken.enterprise_id == eid))
        db.execute(delete(InviteCode).where(InviteCode.enterprise_id == eid))
        db.execute(delete(EnterpriseMembership).where(EnterpriseMembership.enterprise_id == eid))
        db.delete(ent)
        db.commit()

    for did in dataset_ids:
        clear_index_job(did)
        background_tasks.add_task(_delete_collection_safe, did)

    return {"disbanded": True, "enterprise_id": eid}


@router.patch("/members/{user_id}/role", include_in_schema=False)
def update_member_role(user_id: int, body: UpdateRoleRequest, current_user: AuthUser = Depends(require_admin)):
    if current_user.enterprise_id is None:
        raise HTTPException(status_code=400, detail="Not part of an enterprise")
    if user_id == current_user.id:
        raise HTTPException(status_code=400, detail="You cannot change your own role")

    if body.role == UserRole.owner:
        raise HTTPException(
            status_code=400,
            detail="Use POST /enterprises/transfer-ownership to assign a new owner",
        )
    if body.role not in (UserRole.admin, UserRole.querier):
        raise HTTPException(status_code=400, detail="Role must be admin or querier")

    with SessionLocal() as db:
        m = db.execute(
            select(EnterpriseMembership).where(
                EnterpriseMembership.user_id == user_id,
                EnterpriseMembership.enterprise_id == current_user.enterprise_id,
            ),
        ).scalar_one_or_none()
        if m is None:
            raise HTTPException(status_code=404, detail="Member not found")
        if m.role == UserRole.owner:
            raise HTTPException(status_code=403, detail="Cannot change the enterprise owner's role here")

        if body.role == UserRole.querier and m.role == UserRole.admin and current_user.role != UserRole.owner:
            raise HTTPException(
                status_code=403,
                detail="Only the workspace owner can demote an admin to member",
            )

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
        if m.role == UserRole.owner:
            raise HTTPException(
                status_code=400,
                detail="Cannot remove the enterprise owner; transfer ownership or disband the enterprise",
            )

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
