import io

from fastapi.testclient import TestClient

import app.main as app_main
from app.auth import create_jwt
from app.db import SessionLocal
from app.models import EnterpriseMembership, User, UserRole


def make_csv(content: str, filename: str = "test.csv"):
    return {"file": (filename, io.BytesIO(content.encode("utf-8")), "text/csv")}


def _create_user_and_token(*, google_id: str, login: str) -> str:
    with SessionLocal() as db:
        u = User(google_id=google_id, login=login)
        db.add(u)
        db.commit()
        db.refresh(u)
        uid = u.id
    return create_jwt(user_id=uid, login=login, name=login, avatar_url="")


def test_workspace_name_not_unique():
    """Two different workspaces may share the same name."""
    token = _create_user_and_token(google_id="u_workspace_names", login="u_workspace_names@example.com")
    with TestClient(app_main.app) as c:
        first = c.post("/enterprises", headers={"Authorization": f"Bearer {token}"}, json={"name": "Same Name"})
        assert first.status_code == 200, first.text
        second = c.post("/enterprises", headers={"Authorization": f"Bearer {token}"}, json={"name": "Same Name"})
        assert second.status_code == 200, second.text
        assert first.json()["enterprise_id"] != second.json()["enterprise_id"]


def test_create_workspace_rejects_too_long_name():
    token = _create_user_and_token(google_id="u_workspace_long_name", login="u_workspace_long_name@example.com")
    too_long = "a" * 256
    with TestClient(app_main.app) as c:
        res = c.post("/enterprises", headers={"Authorization": f"Bearer {token}"}, json={"name": too_long})
        assert res.status_code == 400, res.text
        assert res.json().get("detail") == "Workspace name is too long"


def test_members_visible_to_any_member_and_mcp_flag_updates():
    token = _create_user_and_token(google_id="u_members", login="u_members@example.com")

    with TestClient(app_main.app) as c:
        created = c.post("/enterprises", headers={"Authorization": f"Bearer {token}"}, json={"name": "Org"})
        assert created.status_code == 200, created.text
        token_owner = created.json()["token"]
        eid = created.json()["enterprise_id"]

        with SessionLocal() as db:
            member = User(google_id="u_members_2", login="u_members_2@example.com", last_active_enterprise_id=eid)
            db.add(member)
            db.flush()
            db.add(EnterpriseMembership(user_id=member.id, enterprise_id=eid, role=UserRole.querier))
            db.commit()
            mid = member.id

        token_member = create_jwt(
            user_id=mid,
            login="u_members_2@example.com",
            name="u2",
            avatar_url="",
        )

        members1 = c.get("/enterprises/members", headers={"Authorization": f"Bearer {token_member}"})
        assert members1.status_code == 200, members1.text
        rows = members1.json()
        assert any(r["role"] == "owner" for r in rows)
        assert any(r["role"] in ("querier", "admin") for r in rows)

        created_token = c.post("/enterprises/mcp-token", headers={"Authorization": f"Bearer {token_member}"})
        assert created_token.status_code == 200, created_token.text

        members2 = c.get("/enterprises/members", headers={"Authorization": f"Bearer {token_owner}"})
        assert members2.status_code == 200, members2.text
        member_row = next(r for r in members2.json() if r["login"] == "u_members_2@example.com")
        assert member_row["mcp_token_configured"] is True


def test_invite_codes_require_admin():
    token = _create_user_and_token(google_id="u_invites", login="u_invites@example.com")

    with TestClient(app_main.app) as c:
        created = c.post("/enterprises", headers={"Authorization": f"Bearer {token}"}, json={"name": "Org"})
        assert created.status_code == 200, created.text
        token_owner = created.json()["token"]
        eid = created.json()["enterprise_id"]

        with SessionLocal() as db:
            member = User(google_id="u_invites_2", login="u_invites_2@example.com", last_active_enterprise_id=eid)
            db.add(member)
            db.flush()
            db.add(EnterpriseMembership(user_id=member.id, enterprise_id=eid, role=UserRole.querier))
            db.commit()
            mid = member.id

        token_member = create_jwt(
            user_id=mid,
            login="u_invites_2@example.com",
            name="u2",
            avatar_url="",
        )

        forbidden = c.post("/enterprises/invite-codes", headers={"Authorization": f"Bearer {token_member}"})
        assert forbidden.status_code == 403, forbidden.text

        ok = c.post("/enterprises/invite-codes", headers={"Authorization": f"Bearer {token_owner}"})
        assert ok.status_code == 200, ok.text
        body = ok.json()
        assert "code" in body and body["code"]


def test_owner_cannot_leave_workspace_member_can_leave():
    token = _create_user_and_token(google_id="u_leave", login="u_leave@example.com")
    with TestClient(app_main.app) as c:
        created = c.post("/enterprises", headers={"Authorization": f"Bearer {token}"}, json={"name": "Org"})
        assert created.status_code == 200, created.text
        token_owner = created.json()["token"]
        eid = created.json()["enterprise_id"]

        owner_leave = c.post("/enterprises/leave", headers={"Authorization": f"Bearer {token_owner}"})
        assert owner_leave.status_code == 400, owner_leave.text

        with SessionLocal() as db:
            member = User(google_id="u_leave_2", login="u_leave_2@example.com", last_active_enterprise_id=eid)
            db.add(member)
            db.flush()
            db.add(EnterpriseMembership(user_id=member.id, enterprise_id=eid, role=UserRole.querier))
            db.commit()
            mid = member.id

        token_member = create_jwt(
            user_id=mid,
            login="u_leave_2@example.com",
            name="u2",
            avatar_url="",
        )

        member_leave = c.post("/enterprises/leave", headers={"Authorization": f"Bearer {token_member}"})
        assert member_leave.status_code == 200, member_leave.text
        left = member_leave.json()
        assert left["enterprise_id"] is None
        assert left["role"] is None


def test_only_owner_can_demote_admin_to_member():
    token = _create_user_and_token(google_id="u_demote_owner", login="owner@example.com")
    with TestClient(app_main.app) as c:
        created = c.post("/enterprises", headers={"Authorization": f"Bearer {token}"}, json={"name": "Org"})
        assert created.status_code == 200, created.text
        token_owner = created.json()["token"]
        eid = created.json()["enterprise_id"]

        with SessionLocal() as db:
            admin_a = User(
                google_id="u_demote_admin_a",
                login="admin_a@example.com",
                last_active_enterprise_id=eid,
            )
            admin_b = User(
                google_id="u_demote_admin_b",
                login="admin_b@example.com",
                last_active_enterprise_id=eid,
            )
            db.add(admin_a)
            db.add(admin_b)
            db.flush()
            admin_b_id = admin_b.id
            db.add(
                EnterpriseMembership(user_id=admin_a.id, enterprise_id=eid, role=UserRole.admin),
            )
            db.add(
                EnterpriseMembership(user_id=admin_b_id, enterprise_id=eid, role=UserRole.admin),
            )
            db.commit()
            admin_a_id = admin_a.id

        token_admin_a = create_jwt(
            user_id=admin_a_id,
            login="admin_a@example.com",
            name="a",
            avatar_url="",
        )

        demote = c.patch(
            f"/enterprises/members/{admin_b_id}/role",
            headers={"Authorization": f"Bearer {token_admin_a}"},
            json={"role": "querier"},
        )
        assert demote.status_code == 403, demote.text
        assert demote.json()["detail"] == "Only the workspace owner can demote an admin to member"

        ok = c.patch(
            f"/enterprises/members/{admin_b_id}/role",
            headers={"Authorization": f"Bearer {token_owner}"},
            json={"role": "querier"},
        )
        assert ok.status_code == 200, ok.text
        assert ok.json()["role"] == "querier"

