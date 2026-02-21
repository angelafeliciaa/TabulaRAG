import io
import sys
import pytest
from pathlib import Path
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

# Add backend directory to path so we can import app
sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

from app.main import app
from app.models import Base
import app.db as app_db

TEST_DATABASE_URL = "sqlite://"  # in-memory SQLite

@pytest.fixture(scope="session")
def test_engine():
    engine = create_engine(
        TEST_DATABASE_URL,
        connect_args={"check_same_thread": False},
    )
    Base.metadata.create_all(bind=engine)
    yield engine
    engine.dispose()

@pytest.fixture(scope="session", autouse=True)
def patch_db(test_engine):
    """Redirect the app's SessionLocal to the test DB."""
    TestingSessionLocal = sessionmaker(bind=test_engine, autocommit=False, autoflush=False)
    app_db.engine = test_engine
    app_db.SessionLocal = TestingSessionLocal

@pytest.fixture(autouse=True)
def clean_tables(test_engine):
    yield
    # Truncate all tables after each test
    from sqlalchemy import text
    with test_engine.connect() as conn:
        conn.execute(text("DELETE FROM dataset_rows"))
        conn.execute(text("DELETE FROM dataset_columns"))
        conn.execute(text("DELETE FROM datasets"))
        conn.commit()

@pytest.fixture(scope="session")
def client(patch_db):
    with TestClient(app) as c:
        yield c