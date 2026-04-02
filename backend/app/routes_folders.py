from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select

from app.auth import AuthUser, require_admin, require_auth
from app.db import SessionLocal
from app.models import Dataset, Folder, FolderPrivacy, UserRole

router = APIRouter(prefix="/folders")


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


def _assert_folder_visible(folder: Folder, auth: AuthUser) -> None:
    """Raise 404 if a querier tries to access a private folder."""
    if not _is_admin(auth) and folder.privacy == FolderPrivacy.private:
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


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("")
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

        stmt = stmt.group_by(Folder.id).order_by(Folder.name)

        rows = db.execute(stmt).all()

        return [
            {
                "folder_id": folder.id,
                "name": folder.name,
                "privacy": folder.privacy,
                "dataset_count": dataset_count,
                "created_at": folder.created_at.isoformat(),
            }
            for folder, dataset_count in rows
        ]


@router.post("", status_code=201, include_in_schema=False)
def create_folder(
    body: CreateFolderRequest,
    current_user: AuthUser = Depends(require_admin),
):
    """Create a new folder. Admins and owners only."""
    enterprise_id = _scoped_enterprise_id(current_user)

    with SessionLocal() as db:
        folder = Folder(
            enterprise_id=enterprise_id,
            name=body.name.strip(),
            privacy=body.privacy,
            created_by=current_user.id,
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
            folder.name = body.name.strip()
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
    current_user: AuthUser = Depends(require_admin),
):
    """
    Delete a folder. Datasets inside become unassigned (folder_id set to NULL).
    Admins and owners only.
    """
    enterprise_id = _scoped_enterprise_id(current_user)

    with SessionLocal() as db:
        folder = _get_folder_or_404(db, folder_id, enterprise_id)

        # Unassign all datasets — the ON DELETE SET NULL FK handles this at the
        # DB level, but we do it explicitly so SQLAlchemy's session stays consistent.
        datasets = db.execute(
            select(Dataset).where(Dataset.folder_id == folder.id)
        ).scalars().all()
        for dataset in datasets:
            dataset.folder_id = None

        db.delete(folder)
        db.commit()


@router.get("/{folder_id}/datasets")
def list_folder_datasets(
    folder_id: int,
    current_user: AuthUser = Depends(require_auth),
):
    """
    List all datasets inside a folder.
    Queriers cannot access private folders (returns 404).
    """
    enterprise_id = _scoped_enterprise_id(current_user)

    with SessionLocal() as db:
        folder = _get_folder_or_404(db, folder_id, enterprise_id)
        _assert_folder_visible(folder, current_user)

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
    current_user: AuthUser = Depends(require_admin),
):
    """
    Assign a dataset to a folder, or unassign it (folder_id: null).
    The target folder must belong to the same workspace.
    Admins and owners only.
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
            dataset.folder_id = folder.id
        else:
            dataset.folder_id = None

        db.commit()

        return {
            "dataset_id": dataset.id,
            "folder_id": dataset.folder_id,
        }
