import enum

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    UniqueConstraint,
    false,
)
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.db import Base


class UserRole(str, enum.Enum):
    admin = "admin"
    querier = "querier"


class Enterprise(Base):
    __tablename__ = "enterprises"

    id = Column(Integer, primary_key=True)
    name = Column(String(255), unique=True, nullable=False)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    memberships = relationship("EnterpriseMembership", back_populates="enterprise", cascade="all, delete-orphan")
    datasets = relationship("Dataset", back_populates="enterprise")
    invite_codes = relationship("InviteCode", back_populates="enterprise")


class EnterpriseMembership(Base):
    """A user's role within one enterprise (users may belong to many)."""

    __tablename__ = "enterprise_memberships"
    __table_args__ = (
        UniqueConstraint("user_id", "enterprise_id", name="uq_enterprise_memberships_user_enterprise"),
        Index("ix_enterprise_memberships_user_id", "user_id"),
        Index("ix_enterprise_memberships_enterprise_id", "enterprise_id"),
    )

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    enterprise_id = Column(Integer, ForeignKey("enterprises.id", ondelete="CASCADE"), nullable=False)
    role = Column(Enum(UserRole), nullable=False, default=UserRole.querier)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    user = relationship("User", back_populates="memberships")
    enterprise = relationship("Enterprise", back_populates="memberships")


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True)
    google_id = Column(String(64), unique=True, nullable=False)
    login = Column(String(255), nullable=False)
    last_active_enterprise_id = Column(
        Integer,
        ForeignKey("enterprises.id", ondelete="SET NULL"),
        nullable=True,
    )
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    memberships = relationship("EnterpriseMembership", back_populates="user", cascade="all, delete-orphan")
    invite_codes_created = relationship("InviteCode", back_populates="created_by_user")


class InviteCode(Base):
    __tablename__ = "invite_codes"

    id = Column(Integer, primary_key=True)
    enterprise_id = Column(Integer, ForeignKey("enterprises.id", ondelete="CASCADE"), nullable=False)
    code = Column(String(8), unique=True, nullable=False)
    created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    expires_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    enterprise = relationship("Enterprise", back_populates="invite_codes")
    created_by_user = relationship("User", back_populates="invite_codes_created")


class McpAccessToken(Base):
    """Per-user MCP bearer for one enterprise; row deleted when membership ends."""

    __tablename__ = "mcp_access_tokens"
    __table_args__ = (
        UniqueConstraint("user_id", "enterprise_id", name="uq_mcp_tokens_user_enterprise"),
        Index("ix_mcp_access_tokens_token_hash", "token_hash"),
    )

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    enterprise_id = Column(Integer, ForeignKey("enterprises.id", ondelete="CASCADE"), nullable=False)
    token_hash = Column(String(64), nullable=False, unique=True)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    last_used_at = Column(DateTime(timezone=True), nullable=True)


class Dataset(Base):
    __tablename__ = "datasets"

    id = Column(Integer, primary_key=True)
    enterprise_id = Column(Integer, ForeignKey("enterprises.id", ondelete="SET NULL"), nullable=True)
    name = Column(String(255), nullable=False)
    description = Column(String(1024), nullable=True)
    query_context = Column(JSON, nullable=True)
    source_filename = Column(String(512), nullable=True)
    delimiter = Column(String(8), nullable=False, default=",")
    has_header = Column(Boolean, nullable=False, default=True)
    row_count = Column(Integer, nullable=False, default=0)
    column_count = Column(Integer, nullable=False, default=0)
    is_index_ready = Column(
        Boolean,
        nullable=False,
        default=False,
        server_default=false(),
    )
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    enterprise = relationship("Enterprise", back_populates="datasets")
    columns = relationship("DatasetColumn", back_populates="dataset", cascade="all, delete-orphan")
    rows = relationship("DatasetRow", back_populates="dataset", cascade="all, delete-orphan")


class DatasetColumn(Base):
    __tablename__ = "dataset_columns"

    id = Column(Integer, primary_key=True)
    dataset_id = Column(Integer, ForeignKey("datasets.id", ondelete="CASCADE"), nullable=False)
    column_index = Column(Integer, nullable=False)
    original_name = Column(String(512), nullable=True)  # raw header from CSV
    normalized_name = Column(String(255), nullable=False)  # deduped, safe key for row_data

    dataset = relationship("Dataset", back_populates="columns")

    __table_args__ = (
        UniqueConstraint("dataset_id", "column_index", name="uq_dataset_columns_index"),
        UniqueConstraint("dataset_id", "normalized_name", name="uq_dataset_columns_name"),
        Index("ix_dataset_columns_dataset_id", "dataset_id"),
    )


class DatasetRow(Base):
    __tablename__ = "dataset_rows"

    id = Column(Integer, primary_key=True)
    dataset_id = Column(Integer, ForeignKey("datasets.id", ondelete="CASCADE"), nullable=False)
    row_index = Column(Integer, nullable=False)
    row_data = Column(JSON, nullable=False)

    dataset = relationship("Dataset", back_populates="rows")

    __table_args__ = (
        UniqueConstraint("dataset_id", "row_index", name="uq_dataset_rows_index"),
        Index("ix_dataset_rows_dataset_id", "dataset_id"),
    )


__all__ = [
    "Base",
    "Dataset",
    "DatasetColumn",
    "DatasetRow",
    "Enterprise",
    "EnterpriseMembership",
    "User",
    "InviteCode",
    "McpAccessToken",
    "UserRole",
]
