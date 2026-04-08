from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Path
from pydantic import BaseModel
from sqlalchemy import delete, func, select

from app.auth import AuthUser, require_admin, require_auth
from app.db import SessionLocal
from app.index_jobs import clear_index_job
from app.models import Dataset, DatasetColumn, DatasetRow, Folder, FolderGroupAccess, FolderPrivacy, UserGroup, UserGroupMembership, UserRole
from app.qdrant_client import delete_collection
from app.unassigned_folder import ensure_all_datasets_have_folder

router = APIRouter(prefix="/folders")


def _delete_collection_safe(dataset_id: int) -> None:
    try:
        delete_collection(dataset_id)
    except Exception:
        # Best-effort cleanup; should not block folder deletion.
        pass


def _scoped_enterprise_id(auth: AuthUser) -> Optional[int]:
    """API key may use None (all tenants). Interactive users must have an active workspace."""
    if auth.google_id == "api_key":
        return auth.enterprise_id
    if auth.enterprise_id is None:
        raise HTTPException(
            status_code=403,
            detail="Join or create a workspace to access folders.",
        )
    return auth.enterprise_id


def _is_admin(auth: AuthUser) -> bool:
    return auth.role in (UserRole.owner, UserRole.admin)


def _get_folder_or_404(db, folder_id: int, enterprise_id: Optional[int]) -> Folder:
    stmt = select(Folder).where(Folder.id == folder_id)
    if enterprise_id is not None:
        stmt = stmt.where(Folder.enterprise_id == enterprise_id)
    folder = db.execute(stmt).scalar_one_or_none()
    if folder is None:
        raise HTTPException(status_code=404, detail="Folder not found")
    return folder


MAX_FOLDER_NAME_LEN = 255


def _folder_name_taken(
    db,
    enterprise_id: int,
    name: str,
    exclude_folder_id: Optional[int] = None,
) -> bool:
    stmt = select(Folder.id).where(
        Folder.enterprise_id == enterprise_id,
        func.lower(Folder.name) == func.lower(name),
    )
    if exclude_folder_id is not None:
        stmt = stmt.where(Folder.id != exclude_folder_id)
    return db.execute(stmt.limit(1)).scalar_one_or_none() is not None


def _unique_folder_name(
    db,
    enterprise_id: int,
    base_name: str,
    exclude_folder_id: Optional[int] = None,
) -> str:
    """
    If the desired name is already used (case-insensitive), append _2, _3, …
    until unique. Truncates base when needed to stay within MAX_FOLDER_NAME_LEN.
    """
    base = base_name.strip()
    if not base:
        raise HTTPException(status_code=422, detail="Folder name cannot be empty.")
    base = base[:MAX_FOLDER_NAME_LEN]

    if not _folder_name_taken(db, enterprise_id, base, exclude_folder_id):
        return base

    suffix = 2
    while suffix <= 100_000:
        suffix_part = f"_{suffix}"
        room = MAX_FOLDER_NAME_LEN - len(suffix_part)
        if room < 1:
            raise HTTPException(
                status_code=422,
                detail="Folder name cannot be made unique within length limit.",
            )
        truncated = base[:room]
        candidate = f"{truncated}{suffix_part}"
        if not _folder_name_taken(db, enterprise_id, candidate, exclude_folder_id):
            return candidate
        suffix += 1
    raise HTTPException(status_code=500, detail="Could not allocate unique folder name.")


def _querier_can_see_protected_folder(db, folder_id: int, user_id: int) -> bool:
    """A protected folder is visible to all queriers unless group restrictions exist,
    in which case the querier must belong to at least one permitted group."""
    restriction_count = db.execute(
        select(func.count(FolderGroupAccess.id))
        .where(FolderGroupAccess.folder_id == folder_id)
    ).scalar_one()

    if restriction_count == 0:
        return True  # no restrictions → all queriers can see it

    user_access = db.execute(
        select(FolderGroupAccess.id)
        .join(UserGroupMembership, UserGroupMembership.group_id == FolderGroupAccess.group_id)
        .where(
            FolderGroupAccess.folder_id == folder_id,
            UserGroupMembership.user_id == user_id,
        )
        .limit(1)
    ).scalar_one_or_none()

    return user_access is not None


def _assert_folder_visible(db, folder: Folder, auth: AuthUser) -> None:
    """Raise 404 if a querier cannot access the folder."""
    if _is_admin(auth):
        return
    if folder.privacy == FolderPrivacy.private:
        raise HTTPException(status_code=404, detail="Folder not found")
    if folder.privacy == FolderPrivacy.protected:
        if not _querier_can_see_protected_folder(db, folder.id, auth.id):
            raise HTTPException(status_code=404, detail="Folder not found")


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------

class CreateFolderRequest(BaseModel):
    name: str
    privacy: FolderPrivacy = FolderPrivacy.protected


class UpdateFolderRequest(BaseModel):
    name: Optional[str] = None
    privacy: Optional[FolderPrivacy] = None


class AssignFolderRequest(BaseModel):
    folder_id: Optional[int] = None


class ReorderFoldersRequest(BaseModel):
    folder_ids: list[int]


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("", include_in_schema=False)
def list_folders(current_user: AuthUser = Depends(require_auth)):
    """
    List all folders for the current workspace.
    Queriers only see public and protected folders.
    """
    enterprise_id = _scoped_enterprise_id(current_user)

    with SessionLocal() as db:
        stmt = select(
            Folder,
            func.count(Dataset.id).label("dataset_count"),
        ).outerjoin(Dataset, Dataset.folder_id == Folder.id)

        if enterprise_id is not None:
            stmt = stmt.where(Folder.enterprise_id == enterprise_id)

        if not _is_admin(current_user):
            stmt = stmt.where(Folder.privacy != FolderPrivacy.private)

        stmt = stmt.group_by(Folder.id).order_by(Folder.sort_order, Folder.name)

        rows = db.execute(stmt).all()

        result = []
        for folder, dataset_count in rows:
            # For queriers: additionally filter protected folders by group access.
            if not _is_admin(current_user) and folder.privacy == FolderPrivacy.protected:
                if not _querier_can_see_protected_folder(db, folder.id, current_user.id):
                    continue
            result.append({
                "folder_id": folder.id,
                "name": folder.name,
                "privacy": folder.privacy,
                "dataset_count": dataset_count,
                "created_at": folder.created_at.isoformat(),
            })
        return result


@router.post("", status_code=201, include_in_schema=False)
def create_folder(
    body: CreateFolderRequest,
    current_user: AuthUser = Depends(require_admin),
):
    """Create a new folder. Admins and owners only."""
    enterprise_id = _scoped_enterprise_id(current_user)

    with SessionLocal() as db:
        name = _unique_folder_name(db, enterprise_id, body.name)

        max_so = db.execute(
            select(func.coalesce(func.max(Folder.sort_order), -1)).where(
                Folder.enterprise_id == enterprise_id,
            ),
        ).scalar_one()
        folder = Folder(
            enterprise_id=enterprise_id,
            name=name,
            privacy=body.privacy,
            created_by=current_user.id,
            sort_order=int(max_so) + 1,
        )
        db.add(folder)
        db.commit()
        db.refresh(folder)

        return {
            "folder_id": folder.id,
            "name": folder.name,
            "privacy": folder.privacy,
            "dataset_count": 0,
            "created_at": folder.created_at.isoformat(),
        }


@router.put("/reorder", include_in_schema=False)
def reorder_folders(
    body: ReorderFoldersRequest,
    current_user: AuthUser = Depends(require_auth),
):
    """Persist folder order for the workspace. Any authenticated workspace member may reorder."""
    enterprise_id = _scoped_enterprise_id(current_user)
    ids = body.folder_ids
    if not ids:
        raise HTTPException(status_code=400, detail="folder_ids must not be empty")
    if len(ids) != len(set(ids)):
        raise HTTPException(status_code=400, detail="Duplicate folder ids")

    with SessionLocal() as db:
        all_folders = db.execute(
            select(Folder).where(Folder.enterprise_id == enterprise_id),
        ).scalars().all()
        by_id = {f.id: f for f in all_folders}
        for fid in ids:
            if fid not in by_id:
                raise HTTPException(status_code=400, detail="Invalid folder id in folder_ids")

        id_set = set(ids)
        for i, fid in enumerate(ids):
            by_id[fid].sort_order = i
        extra = [f for f in all_folders if f.id not in id_set]
        next_i = len(ids)
        for f in sorted(extra, key=lambda x: (x.sort_order, x.name or "")):
            f.sort_order = next_i
            next_i += 1

        db.commit()

    return {"ok": True}


@router.patch("/{folder_id}", include_in_schema=False)
def update_folder(
    folder_id: int,
    body: UpdateFolderRequest,
    current_user: AuthUser = Depends(require_admin),
):
    """Rename a folder or change its privacy state. Admins and owners only."""
    enterprise_id = _scoped_enterprise_id(current_user)

    with SessionLocal() as db:
        folder = _get_folder_or_404(db, folder_id, enterprise_id)

        if body.name is not None:
            folder.name = _unique_folder_name(
                db,
                enterprise_id,
                body.name,
                exclude_folder_id=folder.id,
            )
        if body.privacy is not None:
            folder.privacy = body.privacy

        db.commit()
        db.refresh(folder)

        dataset_count = db.execute(
            select(func.count(Dataset.id)).where(Dataset.folder_id == folder.id)
        ).scalar_one()

        return {
            "folder_id": folder.id,
            "name": folder.name,
            "privacy": folder.privacy,
            "dataset_count": dataset_count,
            "created_at": folder.created_at.isoformat(),
        }


@router.delete("/{folder_id}", status_code=204, include_in_schema=False)
def delete_folder(
    folder_id: int,
    background_tasks: BackgroundTasks,
    current_user: AuthUser = Depends(require_admin),
):
    """
    Delete a folder. Datasets/files inside are deleted as well.
    Admins and owners only.
    """
    enterprise_id = _scoped_enterprise_id(current_user)

    with SessionLocal() as db:
        folder = _get_folder_or_404(db, folder_id, enterprise_id)

        # Delete all datasets inside this folder (and their rows/cols) without ORM cascade loading.
        dataset_ids = db.execute(
            select(Dataset.id).where(Dataset.folder_id == folder.id)
        ).scalars().all()
        if dataset_ids:
            db.execute(delete(DatasetRow).where(DatasetRow.dataset_id.in_(dataset_ids)))
            db.execute(delete(DatasetColumn).where(DatasetColumn.dataset_id.in_(dataset_ids)))
            db.execute(delete(Dataset).where(Dataset.id.in_(dataset_ids)))

        db.delete(folder)
        db.commit()

    for did in dataset_ids:
        clear_index_job(int(did))
        background_tasks.add_task(_delete_collection_safe, int(did))


@router.get("/{folder_id}/groups", include_in_schema=False)
def list_folder_groups(
    folder_id: int,
    current_user: AuthUser = Depends(require_admin),
):
    """
    List all groups that have explicit access to a protected folder.
    Admin and owners only.
    """
    enterprise_id = _scoped_enterprise_id(current_user)

    with SessionLocal() as db:
        folder = _get_folder_or_404(db, folder_id, enterprise_id)

        rows = db.execute(
            select(FolderGroupAccess, UserGroup)
            .join(UserGroup, UserGroup.id == FolderGroupAccess.group_id)
            .where(FolderGroupAccess.folder_id == folder.id)
            .order_by(UserGroup.name)
        ).all()

        return [
            {
                "access_id": a.id,
                "group_id": g.id,
                "group_name": g.name,
                "granted_at": a.created_at.isoformat(),
            }
            for a, g in rows
        ]


@router.get(
    "/{folder_id}/datasets",
    operation_id="list_folder_datasets",
    summary="List datasets in a folder (MCP discovery)",
    description=(
        "Returns folder metadata (folder_id, name, privacy) and every dataset in that folder "
        "with id, name, description, row_count, column_count, and created_at. "
        "Use when navigating by folder after listing folders, or when you already have a folder_id. "
        "This is folder-scoped discovery; GET /tables lists all datasets across the workspace. "
        "Members (queriers) cannot access private folders (404)."
    ),
)
def list_folder_datasets(
    folder_id: int = Path(..., description="Folder identifier in the current workspace."),
    current_user: AuthUser = Depends(require_auth),
):
    enterprise_id = _scoped_enterprise_id(current_user)

    with SessionLocal() as db:
        folder = _get_folder_or_404(db, folder_id, enterprise_id)
        _assert_folder_visible(db, folder, current_user)

        datasets = db.execute(
            select(Dataset)
            .where(Dataset.folder_id == folder.id)
            .order_by(Dataset.name)
        ).scalars().all()

        return {
            "folder_id": folder.id,
            "name": folder.name,
            "privacy": folder.privacy,
            "datasets": [
                {
                    "dataset_id": d.id,
                    "name": d.name,
                    "description": d.description,
                    "row_count": d.row_count,
                    "column_count": d.column_count,
                    "created_at": d.created_at.isoformat(),
                }
                for d in datasets
            ],
        }


@router.patch("/datasets/{dataset_id}", include_in_schema=False)
def assign_dataset_folder(
    dataset_id: int,
    body: AssignFolderRequest,
    current_user: AuthUser = Depends(require_auth),
):
    """
    Assign a dataset to a folder, or unassign it (folder_id: null).
    The target folder must belong to the same workspace.
    Queriers may only assign to (or unassign from) public folders.
    """
    enterprise_id = _scoped_enterprise_id(current_user)

    with SessionLocal() as db:
        stmt = select(Dataset).where(Dataset.id == dataset_id)
        if enterprise_id is not None:
            stmt = stmt.where(Dataset.enterprise_id == enterprise_id)
        dataset = db.execute(stmt).scalar_one_or_none()
        if dataset is None:
            raise HTTPException(status_code=404, detail="Dataset not found")

        if body.folder_id is not None:
            # Validate the target folder belongs to the same enterprise.
            folder = _get_folder_or_404(db, body.folder_id, enterprise_id)
            if not _is_admin(current_user) and folder.privacy != FolderPrivacy.public:
                raise HTTPException(status_code=403, detail="You can only add datasets to a public folder.")
            dataset.folder_id = folder.id
        else:
            # Unassign: clear folder_id. Queriers may only remove from public folders.
            if not _is_admin(current_user) and dataset.folder_id is not None:
                current_folder = db.get(Folder, dataset.folder_id)
                if current_folder is None or current_folder.privacy != FolderPrivacy.public:
                    raise HTTPException(status_code=403, detail="You can only remove datasets from a public folder.")
            dataset.folder_id = None

        db.commit()

        return {
            "dataset_id": dataset.id,
            "folder_id": dataset.folder_id,
        }
