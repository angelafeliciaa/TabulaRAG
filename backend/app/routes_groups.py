from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select

from app.auth import AuthUser, require_admin
from app.db import SessionLocal
from app.models import EnterpriseMembership, Folder, FolderGroupAccess, FolderPrivacy, User, UserGroup, UserGroupMembership

router = APIRouter(prefix="/groups")


def _get_group_or_404(db, group_id: int, enterprise_id: int) -> UserGroup:
    group = db.execute(
        select(UserGroup).where(
            UserGroup.id == group_id,
            UserGroup.enterprise_id == enterprise_id,
        )
    ).scalar_one_or_none()
    if group is None:
        raise HTTPException(status_code=404, detail="Group not found")
    return group


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------

class CreateGroupRequest(BaseModel):
    name: str


class UpdateGroupRequest(BaseModel):
    name: str


class AddMemberRequest(BaseModel):
    user_id: int


class SetFolderAccessRequest(BaseModel):
    folder_id: int


# ---------------------------------------------------------------------------
# Groups CRUD
# ---------------------------------------------------------------------------

@router.get("", include_in_schema=False)
def list_groups(current_user: AuthUser = Depends(require_admin)):
    """List all user groups for the current workspace."""
    enterprise_id = current_user.enterprise_id
    if enterprise_id is None:
        raise HTTPException(status_code=403, detail="Join or create a workspace first.")

    with SessionLocal() as db:
        groups = db.execute(
            select(UserGroup)
            .where(UserGroup.enterprise_id == enterprise_id)
            .order_by(UserGroup.name)
        ).scalars().all()

        result = []
        for g in groups:
            members = db.execute(
                select(UserGroupMembership).where(UserGroupMembership.group_id == g.id)
            ).scalars().all()
            folder_accesses = db.execute(
                select(FolderGroupAccess).where(FolderGroupAccess.group_id == g.id)
            ).scalars().all()
            result.append({
                "group_id": g.id,
                "name": g.name,
                "member_count": len(members),
                "folder_access_count": len(folder_accesses),
                "created_at": g.created_at.isoformat(),
            })
        return result


@router.post("", status_code=201, include_in_schema=False)
def create_group(
    body: CreateGroupRequest,
    current_user: AuthUser = Depends(require_admin),
):
    """Create a new user group. Owner or admin only."""
    enterprise_id = current_user.enterprise_id
    if enterprise_id is None:
        raise HTTPException(status_code=403, detail="Join or create a workspace first.")

    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="Group name cannot be empty.")

    with SessionLocal() as db:
        existing = db.execute(
            select(UserGroup).where(
                UserGroup.enterprise_id == enterprise_id,
                UserGroup.name == name,
            )
        ).scalar_one_or_none()
        if existing is not None:
            raise HTTPException(status_code=409, detail="A group with that name already exists.")

        group = UserGroup(enterprise_id=enterprise_id, name=name)
        db.add(group)
        db.commit()
        db.refresh(group)
        return {
            "group_id": group.id,
            "name": group.name,
            "member_count": 0,
            "folder_access_count": 0,
            "created_at": group.created_at.isoformat(),
        }


@router.patch("/{group_id}", include_in_schema=False)
def update_group(
    group_id: int,
    body: UpdateGroupRequest,
    current_user: AuthUser = Depends(require_admin),
):
    """Rename a user group. Owner or admin only."""
    enterprise_id = current_user.enterprise_id
    if enterprise_id is None:
        raise HTTPException(status_code=403, detail="Join or create a workspace first.")

    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="Group name cannot be empty.")

    with SessionLocal() as db:
        group = _get_group_or_404(db, group_id, enterprise_id)

        conflict = db.execute(
            select(UserGroup).where(
                UserGroup.enterprise_id == enterprise_id,
                UserGroup.name == name,
                UserGroup.id != group_id,
            )
        ).scalar_one_or_none()
        if conflict is not None:
            raise HTTPException(status_code=409, detail="A group with that name already exists.")

        group.name = name
        db.commit()
        db.refresh(group)
        return {"group_id": group.id, "name": group.name}


@router.delete("/{group_id}", status_code=204, include_in_schema=False)
def delete_group(
    group_id: int,
    current_user: AuthUser = Depends(require_admin),
):
    """Delete a user group. Owner or admin only."""
    enterprise_id = current_user.enterprise_id
    if enterprise_id is None:
        raise HTTPException(status_code=403, detail="Join or create a workspace first.")

    with SessionLocal() as db:
        group = _get_group_or_404(db, group_id, enterprise_id)
        db.delete(group)
        db.commit()


# ---------------------------------------------------------------------------
# Group membership
# ---------------------------------------------------------------------------

@router.get("/{group_id}/members", include_in_schema=False)
def list_members(
    group_id: int,
    current_user: AuthUser = Depends(require_admin),
):
    """List all members of a group with their login and user_id."""
    enterprise_id = current_user.enterprise_id
    if enterprise_id is None:
        raise HTTPException(status_code=403, detail="Join or create a workspace first.")

    with SessionLocal() as db:
        _get_group_or_404(db, group_id, enterprise_id)

        rows = db.execute(
            select(UserGroupMembership, User)
            .join(User, User.id == UserGroupMembership.user_id)
            .where(UserGroupMembership.group_id == group_id)
            .order_by(User.login)
        ).all()

        return [
            {
                "membership_id": m.id,
                "user_id": u.id,
                "login": u.login,
                "added_at": m.created_at.isoformat(),
            }
            for m, u in rows
        ]


@router.post("/{group_id}/members", status_code=201, include_in_schema=False)
def add_member(
    group_id: int,
    body: AddMemberRequest,
    current_user: AuthUser = Depends(require_admin),
):
    """Add a workspace member to a group. Owner or admin only."""
    enterprise_id = current_user.enterprise_id
    if enterprise_id is None:
        raise HTTPException(status_code=403, detail="Join or create a workspace first.")

    with SessionLocal() as db:
        _get_group_or_404(db, group_id, enterprise_id)

        # Ensure the target user is actually in this workspace.
        membership = db.execute(
            select(EnterpriseMembership).where(
                EnterpriseMembership.user_id == body.user_id,
                EnterpriseMembership.enterprise_id == enterprise_id,
            )
        ).scalar_one_or_none()
        if membership is None:
            raise HTTPException(status_code=404, detail="User is not a member of this workspace.")

        # Idempotent — return existing if already a member.
        existing = db.execute(
            select(UserGroupMembership).where(
                UserGroupMembership.group_id == group_id,
                UserGroupMembership.user_id == body.user_id,
            )
        ).scalar_one_or_none()
        if existing is not None:
            user = db.get(User, body.user_id)
            return {
                "membership_id": existing.id,
                "user_id": body.user_id,
                "login": user.login if user else "",
                "added_at": existing.created_at.isoformat(),
            }

        gm = UserGroupMembership(group_id=group_id, user_id=body.user_id)
        db.add(gm)
        db.commit()
        db.refresh(gm)

        user = db.get(User, body.user_id)
        return {
            "membership_id": gm.id,
            "user_id": body.user_id,
            "login": user.login if user else "",
            "added_at": gm.created_at.isoformat(),
        }


@router.delete("/{group_id}/members/{user_id}", status_code=204, include_in_schema=False)
def remove_member(
    group_id: int,
    user_id: int,
    current_user: AuthUser = Depends(require_admin),
):
    """Remove a user from a group. Owner or admin only."""
    enterprise_id = current_user.enterprise_id
    if enterprise_id is None:
        raise HTTPException(status_code=403, detail="Join or create a workspace first.")

    with SessionLocal() as db:
        _get_group_or_404(db, group_id, enterprise_id)

        gm = db.execute(
            select(UserGroupMembership).where(
                UserGroupMembership.group_id == group_id,
                UserGroupMembership.user_id == user_id,
            )
        ).scalar_one_or_none()
        if gm is None:
            raise HTTPException(status_code=404, detail="User is not a member of this group.")

        db.delete(gm)
        db.commit()


# ---------------------------------------------------------------------------
# Folder access grants
# ---------------------------------------------------------------------------

@router.get("/{group_id}/folders", include_in_schema=False)
def list_folder_accesses(
    group_id: int,
    current_user: AuthUser = Depends(require_admin),
):
    """List all folders this group has access to."""
    enterprise_id = current_user.enterprise_id
    if enterprise_id is None:
        raise HTTPException(status_code=403, detail="Join or create a workspace first.")

    with SessionLocal() as db:
        _get_group_or_404(db, group_id, enterprise_id)

        rows = db.execute(
            select(FolderGroupAccess, Folder)
            .join(Folder, Folder.id == FolderGroupAccess.folder_id)
            .where(FolderGroupAccess.group_id == group_id)
            .order_by(Folder.sort_order, Folder.name)
        ).all()

        return [
            {
                "access_id": a.id,
                "folder_id": f.id,
                "folder_name": f.name,
                "privacy": f.privacy,
                "granted_at": a.created_at.isoformat(),
            }
            for a, f in rows
        ]


@router.post("/{group_id}/folders", status_code=201, include_in_schema=False)
def grant_folder_access(
    group_id: int,
    body: SetFolderAccessRequest,
    current_user: AuthUser = Depends(require_admin),
):
    """Grant a group access to a protected folder. Owner or admin only."""
    enterprise_id = current_user.enterprise_id
    if enterprise_id is None:
        raise HTTPException(status_code=403, detail="Join or create a workspace first.")

    with SessionLocal() as db:
        _get_group_or_404(db, group_id, enterprise_id)

        folder = db.execute(
            select(Folder).where(
                Folder.id == body.folder_id,
                Folder.enterprise_id == enterprise_id,
            )
        ).scalar_one_or_none()
        if folder is None:
            raise HTTPException(status_code=404, detail="Folder not found.")
        if folder.privacy != FolderPrivacy.protected:
            raise HTTPException(
                status_code=422,
                detail="Group access only applies to protected folders. Public folders are open to all; private folders are admin-only.",
            )

        existing = db.execute(
            select(FolderGroupAccess).where(
                FolderGroupAccess.folder_id == body.folder_id,
                FolderGroupAccess.group_id == group_id,
            )
        ).scalar_one_or_none()
        if existing is not None:
            return {
                "access_id": existing.id,
                "folder_id": folder.id,
                "folder_name": folder.name,
                "privacy": folder.privacy,
                "granted_at": existing.created_at.isoformat(),
            }

        access = FolderGroupAccess(folder_id=body.folder_id, group_id=group_id)
        db.add(access)
        db.commit()
        db.refresh(access)

        return {
            "access_id": access.id,
            "folder_id": folder.id,
            "folder_name": folder.name,
            "privacy": folder.privacy,
            "granted_at": access.created_at.isoformat(),
        }


@router.delete("/{group_id}/folders/{folder_id}", status_code=204, include_in_schema=False)
def revoke_folder_access(
    group_id: int,
    folder_id: int,
    current_user: AuthUser = Depends(require_admin),
):
    """Revoke a group's access to a folder. Owner or admin only."""
    enterprise_id = current_user.enterprise_id
    if enterprise_id is None:
        raise HTTPException(status_code=403, detail="Join or create a workspace first.")

    with SessionLocal() as db:
        _get_group_or_404(db, group_id, enterprise_id)

        access = db.execute(
            select(FolderGroupAccess).where(
                FolderGroupAccess.folder_id == folder_id,
                FolderGroupAccess.group_id == group_id,
            )
        ).scalar_one_or_none()
        if access is None:
            raise HTTPException(status_code=404, detail="Access grant not found.")

        db.delete(access)
        db.commit()
