from __future__ import annotations

from typing import Optional

from sqlalchemy import func, select, update

from app.models import Dataset, Folder, FolderPrivacy


UNASSIGNED_FOLDER_NAME = "Unassigned"


def get_or_create_unassigned_folder(db, enterprise_id: Optional[int]) -> Optional[Folder]:
    """
    Ensure a per-enterprise "Unassigned" folder exists.

    Returns the Folder, or None if enterprise_id is None (global API key scope).
    """
    if enterprise_id is None:
        return None

    existing = db.execute(
        select(Folder)
        .where(Folder.enterprise_id == enterprise_id)
        .where(Folder.name == UNASSIGNED_FOLDER_NAME)
        .limit(1)
    ).scalar_one_or_none()
    if existing is not None:
        return existing

    max_so = db.execute(
        select(func.coalesce(func.max(Folder.sort_order), -1)).where(
            Folder.enterprise_id == enterprise_id,
        ),
    ).scalar_one()
    folder = Folder(
        enterprise_id=enterprise_id,
        name=UNASSIGNED_FOLDER_NAME,
        privacy=FolderPrivacy.protected,
        created_by=None,
        sort_order=int(max_so) + 1,
    )
    db.add(folder)
    db.flush()  # get folder.id without forcing commit here
    return folder


def ensure_all_datasets_have_folder(db, enterprise_id: Optional[int]) -> Optional[int]:
    """
    Move any datasets with folder_id NULL into the "Unassigned" folder.

    Returns the unassigned folder id (or None if enterprise_id is None).
    """
    if enterprise_id is None:
        return None

    orphan = db.execute(
        select(Dataset.id)
        .where(Dataset.enterprise_id == enterprise_id)
        .where(Dataset.folder_id.is_(None))
        .limit(1)
    ).scalar_one_or_none()
    if orphan is None:
        # Don't create the Unassigned folder unless we actually need it.
        return None

    folder = get_or_create_unassigned_folder(db, enterprise_id)
    if folder is None:
        return None

    db.execute(
        update(Dataset)
        .where(Dataset.enterprise_id == enterprise_id)
        .where(Dataset.folder_id.is_(None))
        .values(folder_id=folder.id)
    )
    db.flush()
    return int(folder.id)

