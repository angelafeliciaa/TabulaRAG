<h1 align="center">
  <img src="frontend/src/images/logo.png" alt="TabulaRAG logo" width="64" height="64" /></br>
  TabulaRAG
</h1>

<p align="center">
  <strong>A fast-ingesting tabular data MCP RAG tool backed with cell citations.</strong><br/>
  Upload a CSV or TSV, then query it in natural language. Results include cell-level citations so you can trace exactly where each answer came from. We also have multi-role access where admin users can add, delete, edit datasets as well as invite users to their enterprise/organization via invite codes. 
</p>

<p align="center">
  <img src="https://img.shields.io/badge/python-3.11-blue" alt="Python 3.11" />
  <img src="https://img.shields.io/badge/node-20-brightgreen" alt="Node 20" />
  <img src="https://img.shields.io/badge/typescript-strict-blue" alt="TypeScript Strict" />
  <img src="https://img.shields.io/badge/license-MIT-lightgrey" alt="License" />
</p>

---

## Features

- **CSV/TSV ingestion** — upload tabular files with automatic header detection, delimiter inference, and column type recognition (dates, money, measurements)
- **Semantic search** — each row is embedded via `sentence-transformers/all-MiniLM-L6-v2` and indexed in Qdrant for natural-language retrieval with cell-level citations
- **Structured queries** — filter and aggregate data through the API with SQL over PostgreSQL JSON columns
- **Multi-tenant workspaces** — enterprises with invite codes, roles (owner / admin / querier), and switchable active workspace
- **Folders & access control** — public, protected, and private folders with user-group-based permissions
- **MCP server** — exposes Streamable HTTP + SSE endpoints so AI assistants can use your tables as a retrieval tool
- **Auth** — Google OAuth and email/password with verification codes and password reset (via Brevo SMTP)
- **Background indexing** — threaded worker pool for non-blocking embedding and Qdrant upserts with progress tracking

---

## Architecture

| Layer | Technology |
| ------------ | --------------------------------------------------- |
| Frontend | React 19, TypeScript 5.9, Vite 7, React Router 7 |
| Backend | Python 3.11, FastAPI, SQLAlchemy 2.x, Uvicorn |
| Database | PostgreSQL 16 |
| Vector store | Qdrant v1.13.4 (FastEmbed, 384-dim dense vectors) |
| Auth | JWT, Google OAuth, bcrypt |
| MCP | fastapi-mcp (Streamable HTTP + SSE) |
| Web server | Nginx 1.27 (production frontend) |
| CI | GitHub Actions (pytest, ESLint, Docker builds) |

---

## MCP integration

TabulaRAG exposes endpoints for AI assistant integration:

| Type | URL |
| --------------------- | ------------------------------------ |
| OpenAPI | `http://localhost:8000/openapi.json` |
| MCP (Streamable HTTP) | `http://localhost:8000/mcp` |

**Authentication:** use a personal MCP token (generated from the app's MCP section) in `Authorization: Bearer <token>`, or the server `API_KEY` for automation. Tokens are scoped per user and workspace.

> If your MCP client runs outside the browser (e.g. Docker, desktop app), replace `localhost` with your machine's IP (`ipconfig` on Windows, `ifconfig` on Mac/Linux).

---

## Local vs. Deployed

| Feature      | Local (Docker Compose) | Deployed            |
| ------------ | ---------------------- | ------------------- |
| Database     | PostgreSQL in Docker   | External PostgreSQL |
| Vector store | Qdrant in Docker       | External Qdrant     |

---

## Prerequisites (Local)

| Tool | Version | Notes |
| ---- | ------- | ----- |
| [Docker](https://docs.docker.com/get-docker/) | Latest | https://docs.docker.com/get-docker/ |
| [Docker Compose](https://docs.docker.com/compose/install/) | v2+ | Bundled with Docker Desktop |

> Docker Compose v2 is required (`docker compose`, not `docker-compose`). It ships with [Docker Desktop](https://www.docker.com/products/docker-desktop/) on Mac and Windows. Linux users may need to install it separately.

You do **not** need to install Python or Node locally — everything runs inside containers.

---

## Quick start

```bash
cp .env.example .env      # create config (edit values as needed)
./scripts/dev-up.sh        # build and start all services
```

Once running:

| Service | URL |
| ----------- | ---------------------- |
| Frontend | http://localhost:5173 |
| Backend API | http://localhost:8000 |
| PostgreSQL | localhost:5433 |
| Qdrant | http://localhost:6333 |

Health checks:

```bash
curl http://localhost:8000/health
curl http://localhost:8000/health/deps
```

Stop / logs:

```bash
./scripts/dev-down.sh
./scripts/dev-logs.sh              # all services
./scripts/dev-logs.sh backend      # single service
```

---

## Environment variables

Copy `.env.example` to `.env`. The key variables:

| Variable | Required | Description |
| ---------------------- | -------- | --------------------------------------------------- |
| `POSTGRES_DB` | Yes | Database name (default: `tabularag`) |
| `POSTGRES_USER` | Yes | Database user (default: `tabularag`) |
| `POSTGRES_PASSWORD` | Yes | Database password |
| `DATABASE_URL` | Yes | PostgreSQL connection string (set in docker-compose) |
| `QDRANT_URL` | Yes | Qdrant endpoint (set in docker-compose) |
| `JWT_SECRET` | Yes | Secret for signing JWT tokens |
| `PUBLIC_API_BASE_URL` | Yes | Backend URL used in email links (default: `http://localhost:8000`) |
| `PUBLIC_UI_BASE_URL` | Yes | Frontend URL used in email links (default: `http://localhost:5173`) |
| `API_KEY` | No | Optional static key for script/API access |
| `GOOGLE_CLIENT_ID` | No | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | No | Google OAuth client secret |
| `SMTP_HOST` | No | Brevo SMTP relay for verification/reset emails |
| `SMTP_PORT` | No | SMTP port (default: `587`) |
| `SMTP_USER` | No | SMTP login |
| `SMTP_PASSWORD` | No | SMTP key |
| `SMTP_FROM` | No | Sender email address |

> **SMTP is optional for local development.** If `SMTP_HOST` is empty, verification and reset codes are written to the backend logs instead of being emailed. For any real deployment, configure SMTP so users receive emails.

The remaining variables in `.env.example` control embedding model tuning, Qdrant HNSW parameters, batch sizes, and indexing concurrency. The defaults work for local development.

---


## License

[MIT](LICENSE)
