from __future__ import annotations

from sqlalchemy import inspect, select, text, update

import app.db as app_db
from app.models import Dataset, EnterpriseMembership, McpAccessToken, UserRole


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
    return UserRole(str(value))


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


def set_dataset_index_ready(dataset_id: int, is_ready: bool) -> None:
    with app_db.SessionLocal() as db:
        db.execute(
            update(Dataset)
            .where(Dataset.id == dataset_id)
            .values(is_index_ready=bool(is_ready))
        )
        db.commit()
