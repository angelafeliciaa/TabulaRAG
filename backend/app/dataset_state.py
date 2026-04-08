from __future__ import annotations

from sqlalchemy import inspect, select, text, update

import app.db as app_db
from app.models import Dataset, Enterprise, EnterpriseMembership, Folder, FolderGroupAccess, McpAccessToken, UserGroup, UserGroupMembership, UserRole


def ensure_dataset_columns_normalized_columns() -> None:
    """Migrate dataset_columns from name to original_name + normalized_name if needed."""
    inspector = inspect(app_db.engine)
    if "dataset_columns" not in inspector.get_table_names():
        return
    column_names = {c["name"] for c in inspector.get_columns("dataset_columns")}
    if "normalized_name" in column_names:
        return
    if "name" not in column_names:
        return

    dialect = app_db.engine.dialect.name
    if dialect == "postgresql":
        with app_db.engine.begin() as conn:
            conn.execute(text("ALTER TABLE dataset_columns ADD COLUMN original_name VARCHAR(512)"))
            conn.execute(text("ALTER TABLE dataset_columns ADD COLUMN normalized_name VARCHAR(255)"))
            conn.execute(
                text("UPDATE dataset_columns SET original_name = name, normalized_name = name")
            )
            conn.execute(
                text("ALTER TABLE dataset_columns ALTER COLUMN normalized_name SET NOT NULL")
            )
            conn.execute(
                text("ALTER TABLE dataset_columns DROP CONSTRAINT uq_dataset_columns_name")
            )
            conn.execute(text("ALTER TABLE dataset_columns DROP COLUMN name"))
            conn.execute(
                text(
                    "ALTER TABLE dataset_columns "
                    "ADD CONSTRAINT uq_dataset_columns_name UNIQUE (dataset_id, normalized_name)"
                )
            )
    elif dialect == "sqlite":
        with app_db.engine.begin() as conn:
            conn.execute(text("ALTER TABLE dataset_columns ADD COLUMN original_name VARCHAR(512)"))
            conn.execute(text("ALTER TABLE dataset_columns ADD COLUMN normalized_name VARCHAR(255)"))
            conn.execute(
                text("UPDATE dataset_columns SET original_name = name, normalized_name = name")
            )
            # SQLite: recreate table to add NOT NULL and drop name (no DROP CONSTRAINT/DROP COLUMN in older SQLite)
            conn.execute(text(
                "CREATE TABLE dataset_columns_new ("
                "id INTEGER NOT NULL PRIMARY KEY,"
                "dataset_id INTEGER NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,"
                "column_index INTEGER NOT NULL,"
                "original_name VARCHAR(512),"
                "normalized_name VARCHAR(255) NOT NULL,"
                "UNIQUE (dataset_id, column_index),"
                "UNIQUE (dataset_id, normalized_name)"
                ")"
            ))
            conn.execute(
                text(
                    "INSERT INTO dataset_columns_new (id, dataset_id, column_index, original_name, normalized_name) "
                    "SELECT id, dataset_id, column_index, original_name, normalized_name FROM dataset_columns"
                )
            )
            conn.execute(text("DROP TABLE dataset_columns"))
            conn.execute(text("ALTER TABLE dataset_columns_new RENAME TO dataset_columns"))
            conn.execute(
                text(
                    "CREATE INDEX ix_dataset_columns_dataset_id ON dataset_columns (dataset_id)"
                )
            )


def ensure_dataset_index_ready_column() -> None:
    inspector = inspect(app_db.engine)
    if "datasets" not in inspector.get_table_names():
        return

    column_names = {column["name"] for column in inspector.get_columns("datasets")}
    if "is_index_ready" in column_names:
        return

    with app_db.engine.begin() as conn:
        conn.execute(
            text(
                "ALTER TABLE datasets "
                "ADD COLUMN is_index_ready BOOLEAN NOT NULL DEFAULT FALSE"
            )
        )


def ensure_dataset_description_column() -> None:
    inspector = inspect(app_db.engine)
    if "datasets" not in inspector.get_table_names():
        return

    column_names = {column["name"] for column in inspector.get_columns("datasets")}
    if "description" in column_names:
        return

    with app_db.engine.begin() as conn:
        conn.execute(
            text(
                "ALTER TABLE datasets "
                "ADD COLUMN description VARCHAR(1024) NULL"
            )
        )


def ensure_dataset_query_context_column() -> None:
    inspector = inspect(app_db.engine)
    if "datasets" not in inspector.get_table_names():
        return

    column_names = {column["name"] for column in inspector.get_columns("datasets")}
    if "query_context" in column_names:
        return

    with app_db.engine.begin() as conn:
        conn.execute(
            text(
                "ALTER TABLE datasets "
                "ADD COLUMN query_context JSON NULL"
            )
        )


def ensure_dataset_enterprise_id_column() -> None:
    """Add datasets.enterprise_id for multi-tenant enterprises (existing DB volumes)."""
    inspector = inspect(app_db.engine)
    if "datasets" not in inspector.get_table_names():
        return
    if "enterprises" not in inspector.get_table_names():
        return

    column_names = {column["name"] for column in inspector.get_columns("datasets")}
    if "enterprise_id" in column_names:
        return

    dialect = app_db.engine.dialect.name
    with app_db.engine.begin() as conn:
        if dialect == "postgresql":
            conn.execute(
                text(
                    "ALTER TABLE datasets "
                    "ADD COLUMN enterprise_id INTEGER NULL "
                    "REFERENCES enterprises(id) ON DELETE SET NULL"
                )
            )
        else:
            conn.execute(text("ALTER TABLE datasets ADD COLUMN enterprise_id INTEGER NULL"))


def _coerce_user_role(value) -> UserRole:
    if isinstance(value, UserRole):
        return value
    if value is None:
        return UserRole.querier
    s = str(value)
    if s == "member":
        return UserRole.querier
    return UserRole(s)


def ensure_enterprise_memberships_and_last_active() -> None:
    """Memberships table, users.last_active_enterprise_id, backfill from legacy user.enterprise_id/role."""
    EnterpriseMembership.__table__.create(bind=app_db.engine, checkfirst=True)

    inspector = inspect(app_db.engine)
    if "users" not in inspector.get_table_names():
        return

    user_cols = {c["name"] for c in inspector.get_columns("users")}
    dialect = app_db.engine.dialect.name

    if "last_active_enterprise_id" not in user_cols:
        with app_db.engine.begin() as conn:
            if dialect == "postgresql":
                conn.execute(
                    text(
                        "ALTER TABLE users ADD COLUMN last_active_enterprise_id INTEGER NULL "
                        "REFERENCES enterprises(id) ON DELETE SET NULL"
                    )
                )
            else:
                conn.execute(text("ALTER TABLE users ADD COLUMN last_active_enterprise_id INTEGER NULL"))

    if "enterprise_id" not in user_cols:
        return

    with app_db.SessionLocal() as db:
        legacy_rows = db.execute(
            text("SELECT id, enterprise_id, role FROM users WHERE enterprise_id IS NOT NULL"),
        ).all()
        for row in legacy_rows:
            uid, eid, role_raw = int(row[0]), int(row[1]), row[2]
            role = _coerce_user_role(role_raw)
            exists = db.execute(
                select(EnterpriseMembership).where(
                    EnterpriseMembership.user_id == uid,
                    EnterpriseMembership.enterprise_id == eid,
                ),
            ).scalar_one_or_none()
            if exists is None:
                db.add(EnterpriseMembership(user_id=uid, enterprise_id=eid, role=role))

        db.execute(
            text(
                "UPDATE users SET last_active_enterprise_id = enterprise_id "
                "WHERE enterprise_id IS NOT NULL AND last_active_enterprise_id IS NULL",
            ),
        )
        db.commit()


def ensure_mcp_access_tokens_table() -> None:
    McpAccessToken.__table__.create(bind=app_db.engine, checkfirst=True)


def ensure_folders_table() -> None:
    """Create the folders table (and folderprivacy enum on PostgreSQL) for existing DB volumes."""
    inspector = inspect(app_db.engine)
    if "folders" in inspector.get_table_names():
        return

    dialect = app_db.engine.dialect.name
    if dialect == "postgresql":
        # Create the native enum type before the table references it.
        try:
            with app_db.engine.begin() as conn:
                conn.execute(
                    text(
                        "DO $$ BEGIN "
                        "CREATE TYPE folderprivacy AS ENUM ('public', 'protected', 'private'); "
                        "EXCEPTION WHEN duplicate_object THEN NULL; "
                        "END $$"
                    )
                )
        except Exception:
            pass

    Folder.__table__.create(bind=app_db.engine, checkfirst=True)


def ensure_folder_sort_order_column() -> None:
    """Add folders.sort_order for user-defined ordering (existing DB volumes)."""
    inspector = inspect(app_db.engine)
    if "folders" not in inspector.get_table_names():
        return
    column_names = {c["name"] for c in inspector.get_columns("folders")}
    if "sort_order" in column_names:
        return
    dialect = app_db.engine.dialect.name
    with app_db.engine.begin() as conn:
        if dialect == "postgresql":
            conn.execute(text("ALTER TABLE folders ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0"))
        else:
            conn.execute(text("ALTER TABLE folders ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0"))
    # Backfill: stable order matches previous behavior (name) within each enterprise.
    with app_db.engine.begin() as conn:
        enterprises = conn.execute(
            select(Folder.enterprise_id).distinct()
        ).scalars().all()
        for eid in enterprises:
            if eid is None:
                continue
            rows = conn.execute(
                select(Folder.id, Folder.name)
                .where(Folder.enterprise_id == eid)
                .order_by(Folder.name)
            ).all()
            for i, (fid, _name) in enumerate(rows):
                conn.execute(
                    update(Folder).where(Folder.id == fid).values(sort_order=i)
                )


def ensure_dataset_folder_id_column() -> None:
    """Add datasets.folder_id for folder-based access control (existing DB volumes)."""
    inspector = inspect(app_db.engine)
    if "datasets" not in inspector.get_table_names():
        return
    if "folders" not in inspector.get_table_names():
        return

    column_names = {c["name"] for c in inspector.get_columns("datasets")}
    if "folder_id" in column_names:
        return

    dialect = app_db.engine.dialect.name
    with app_db.engine.begin() as conn:
        if dialect == "postgresql":
            conn.execute(
                text(
                    "ALTER TABLE datasets "
                    "ADD COLUMN folder_id INTEGER NULL "
                    "REFERENCES folders(id) ON DELETE SET NULL"
                )
            )
        else:
            conn.execute(text("ALTER TABLE datasets ADD COLUMN folder_id INTEGER NULL"))


def ensure_querier_role_and_migrate_member() -> None:
    """Ensure 'querier' exists on PostgreSQL enum; rewrite any 'member' rows to 'querier'."""
    inspector = inspect(app_db.engine)
    if "enterprise_memberships" not in inspector.get_table_names():
        return
    dialect = app_db.engine.dialect.name
    if dialect == "postgresql":
        try:
            with app_db.engine.begin() as conn:
                conn.execute(text("ALTER TYPE userrole ADD VALUE IF NOT EXISTS 'querier'"))
        except Exception:
            try:
                with app_db.engine.begin() as conn:
                    conn.execute(text("ALTER TYPE userrole ADD VALUE 'querier'"))
            except Exception:
                pass
    with app_db.engine.begin() as conn:
        if dialect == "postgresql":
            conn.execute(
                text(
                    "UPDATE enterprise_memberships SET role = 'querier'::userrole "
                    "WHERE role::text = 'member'",
                ),
            )
        else:
            conn.execute(text("UPDATE enterprise_memberships SET role = 'querier' WHERE role = 'member'"))
        user_cols: set[str] = set()
        if "users" in inspector.get_table_names():
            user_cols = {c["name"] for c in inspector.get_columns("users")}
        if "role" in user_cols:
            if dialect == "postgresql":
                # Compare as text so WHERE 'member' is not parsed as userrole (may not exist on enum).
                conn.execute(
                    text(
                        "UPDATE users SET role = 'querier'::userrole WHERE role::text = 'member'",
                    ),
                )
            else:
                conn.execute(text("UPDATE users SET role = 'querier' WHERE role = 'member'"))


def ensure_postgres_userrole_owner_enum() -> None:
    """Add 'owner' to native PostgreSQL enum for enterprise_memberships.role."""
    if app_db.engine.dialect.name != "postgresql":
        return
    try:
        with app_db.engine.begin() as conn:
            conn.execute(text("ALTER TYPE userrole ADD VALUE IF NOT EXISTS 'owner'"))
    except Exception:
        try:
            with app_db.engine.begin() as conn:
                conn.execute(text("ALTER TYPE userrole ADD VALUE 'owner'"))
        except Exception:
            pass


def ensure_enterprise_name_non_unique() -> None:
    """Allow duplicate workspace names: drop unique constraint on enterprises.name (existing DBs)."""
    inspector = inspect(app_db.engine)
    if "enterprises" not in inspector.get_table_names():
        return

    ucs = inspector.get_unique_constraints("enterprises")
    name_only = [uc for uc in ucs if set(uc.get("column_names") or []) == {"name"}]

    dialect = app_db.engine.dialect.name

    if dialect == "postgresql":
        if not name_only:
            return
        with app_db.engine.begin() as conn:
            for uc in name_only:
                cname = uc.get("name")
                if cname:
                    conn.execute(text(f'ALTER TABLE enterprises DROP CONSTRAINT IF EXISTS "{cname}"'))
        return

    if dialect == "sqlite":
        needs_rebuild = bool(name_only)
        if not needs_rebuild:
            with app_db.engine.connect() as c:
                create_sql = c.execute(
                    text("SELECT sql FROM sqlite_master WHERE type='table' AND name='enterprises'"),
                ).scalar_one_or_none()
            if create_sql and "UNIQUE" in create_sql.upper() and "name" in create_sql.lower():
                needs_rebuild = True
        if not needs_rebuild:
            return
        # SQLite note: PRAGMA foreign_keys is a no-op inside a transaction.
        # We need to issue it before beginning transactional DDL, and re-enable
        # afterward, on the same connection.
        with app_db.engine.connect() as conn:
            conn.execute(text("PRAGMA foreign_keys=OFF"))
            trans = conn.begin()
            try:
                conn.execute(
                    text(
                        """
                        CREATE TABLE enterprises__nq (
                            id INTEGER NOT NULL,
                            name VARCHAR(255) NOT NULL,
                            created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
                            PRIMARY KEY (id)
                        )
                        """
                    ),
                )
                conn.execute(
                    text(
                        "INSERT INTO enterprises__nq (id, name, created_at) "
                        "SELECT id, name, created_at FROM enterprises"
                    )
                )
                conn.execute(text("DROP TABLE enterprises"))
                conn.execute(text("ALTER TABLE enterprises__nq RENAME TO enterprises"))
                trans.commit()
            except Exception:
                trans.rollback()
                raise
            finally:
                conn.execute(text("PRAGMA foreign_keys=ON"))


def promote_legacy_admin_to_owner_per_enterprise() -> None:
    """Exactly one owner per enterprise: promote oldest admin if none marked owner."""
    with app_db.SessionLocal() as db:
        eids = db.execute(select(Enterprise.id)).scalars().all()
        for eid in eids:
            has_owner = db.execute(
                select(EnterpriseMembership.id).where(
                    EnterpriseMembership.enterprise_id == eid,
                    EnterpriseMembership.role == UserRole.owner,
                ).limit(1),
            ).scalar_one_or_none()
            if has_owner is not None:
                continue
            first_admin = db.execute(
                select(EnterpriseMembership)
                .where(
                    EnterpriseMembership.enterprise_id == eid,
                    EnterpriseMembership.role == UserRole.admin,
                )
                .order_by(EnterpriseMembership.id.asc()),
            ).scalars().first()
            if first_admin is not None:
                first_admin.role = UserRole.owner
                db.add(first_admin)
        db.commit()


def ensure_user_groups_tables() -> None:
    """Create user_groups, user_group_memberships, and folder_group_accesses tables for existing DB volumes."""
    UserGroup.__table__.create(bind=app_db.engine, checkfirst=True)
    UserGroupMembership.__table__.create(bind=app_db.engine, checkfirst=True)
    FolderGroupAccess.__table__.create(bind=app_db.engine, checkfirst=True)


def ensure_users_password_hash_column() -> None:
    """Add users.password_hash for email/password sign-up (existing DB volumes)."""
    inspector = inspect(app_db.engine)
    if "users" not in inspector.get_table_names():
        return
    cols = {c["name"] for c in inspector.get_columns("users")}
    if "password_hash" in cols:
        return
    with app_db.engine.begin() as conn:
        conn.execute(text("ALTER TABLE users ADD COLUMN password_hash VARCHAR(255) NULL"))


def ensure_users_email_verification_columns() -> None:
    """Add email_verified and pending-code columns for email sign-up (existing DB volumes)."""
    inspector = inspect(app_db.engine)
    if "users" not in inspector.get_table_names():
        return
    cols = {c["name"] for c in inspector.get_columns("users")}
    dialect = app_db.engine.dialect.name
    with app_db.engine.begin() as conn:
        if "email_verified" not in cols:
            if dialect == "postgresql":
                conn.execute(
                    text("ALTER TABLE users ADD COLUMN email_verified BOOLEAN NOT NULL DEFAULT true")
                )
            else:
                conn.execute(
                    text("ALTER TABLE users ADD COLUMN email_verified BOOLEAN NOT NULL DEFAULT 1")
                )
        if "verification_code_hash" not in cols:
            conn.execute(text("ALTER TABLE users ADD COLUMN verification_code_hash VARCHAR(128) NULL"))
        if "verification_code_expires_at" not in cols:
            if dialect == "postgresql":
                conn.execute(
                    text("ALTER TABLE users ADD COLUMN verification_code_expires_at TIMESTAMPTZ NULL")
                )
            else:
                conn.execute(text("ALTER TABLE users ADD COLUMN verification_code_expires_at DATETIME NULL"))


def ensure_users_legacy_enterprise_role_nullable() -> None:
    """
    Older PostgreSQL volumes still have users.enterprise_id / users.role (NOT NULL) from
    before workspace roles lived in enterprise_memberships. The ORM no longer maps those
    columns, so new rows must be able to omit them. Drop NOT NULL if still enforced.
    """
    inspector = inspect(app_db.engine)
    if "users" not in inspector.get_table_names():
        return
    if app_db.engine.dialect.name != "postgresql":
        return
    cols = {c["name"]: c for c in inspector.get_columns("users")}
    with app_db.engine.begin() as conn:
        role_col = cols.get("role")
        if role_col is not None and role_col.get("nullable") is False:
            conn.execute(text("ALTER TABLE users ALTER COLUMN role DROP NOT NULL"))
        ent_col = cols.get("enterprise_id")
        if ent_col is not None and ent_col.get("nullable") is False:
            conn.execute(text("ALTER TABLE users ALTER COLUMN enterprise_id DROP NOT NULL"))


def set_dataset_index_ready(dataset_id: int, is_ready: bool) -> None:
    with app_db.SessionLocal() as db:
        db.execute(
            update(Dataset)
            .where(Dataset.id == dataset_id)
            .values(is_index_ready=bool(is_ready))
        )
        db.commit()
