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

## Prerequisites

Before you begin, install the following:

| Tool                                                       | Version | Download                            |
| ---------------------------------------------------------- | ------- | ----------------------------------- |
| [Docker](https://docs.docker.com/get-docker/)              | Latest  | https://docs.docker.com/get-docker/ |
| [Docker Compose](https://docs.docker.com/compose/install/) | v2+     | Included with Docker Desktop        |

> Docker Compose v2 is required (uses `docker compose`, not `docker-compose`). It is bundled with [Docker Desktop](https://www.docker.com/products/docker-desktop/) for Mac and Windows. Linux users may need to install it separately.

You do **not** need to install Python or Node locally — everything runs inside Docker containers.

---

## Environment

| Component    | Runtime           |
| ------------ | ----------------- |
| Backend      | Python 3.11 (pip) |
| Frontend     | Node 20 (npm)     |
| Database     | PostgreSQL 16     |
| Vector store | Qdrant v1.13.4    |
| Web server   | Nginx 1.27        |

---

## Environment variables

Copy the example file and fill in the required values:

```bash
cp .env.example .env
```

| Variable            | Required | Description                                       |
| ------------------- | -------- | ------------------------------------------------- |
| `API_KEY`           | No       | Optional static key for script/API access         |
| `DATABASE_URL`      | Yes      | Set automatically in docker-compose for local use |
| `QDRANT_URL`        | Yes      | Set automatically in docker-compose for local use |
| `POSTGRES_DB`       | Yes      | Database name (default: `tabularag`)              |
| `POSTGRES_USER`     | Yes      | Database user (default: `tabularag`)              |
| `POSTGRES_PASSWORD` | Yes      | Database password                                 |

The remaining variables in `.env.example` control embedding model behaviour and Qdrant tuning — the defaults are fine for local use.

---

## Quick start

```bash
cp .env.example .env
./scripts/dev-up.sh         # 2. build and start all services
```

Once running:

| Service     | URL                   |
| ----------- | --------------------- |
| Frontend    | http://localhost:5173 |
| Backend API | http://localhost:8000 |
| PostgreSQL  | localhost:5433        |
| Qdrant      | http://localhost:6333 |

Check backend health:

```bash
curl http://localhost:8000/health
curl http://localhost:8000/health/deps
```

Stop services:

```bash
./scripts/dev-down.sh
```

Stream logs:

```bash
./scripts/dev-logs.sh             # all services
./scripts/dev-logs.sh backend     # backend only
```

---

## Connecting via external tools

TabulaRAG exposes two endpoints for integration with AI assistants and tool runners:

| Type                  | URL                                  |
| --------------------- | ------------------------------------ |
| OpenAPI               | `http://localhost:8000/openapi.json` |
| MCP (Streamable HTTP) | `http://localhost:8000/mcp`          |

MCP requires authentication: use a **personal MCP token** from the app home page (MCP section) in `Authorization: Bearer <token>`, or the server **`API_KEY`** (automation/tests). Tokens are per user and workspace; they stop working if you leave that enterprise.

> **Note:** If your client is running outside the browser (e.g. inside Docker or a desktop app), replace `localhost` with your machine's local IP address. Run `ipconfig` (Windows) or `ifconfig` (Mac/Linux) to find it.

---

## Local vs. deployment differences

| Feature      | Local (Docker Compose) | Deployed            |
| ------------ | ---------------------- | ------------------- |
| Database     | PostgreSQL in Docker   | External PostgreSQL |
| Vector store | Qdrant in Docker       | External Qdrant     |
