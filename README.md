# TabulaRAG

## Quick start (infra)

1. Copy environment file:
   `cp .env.example .env`
2. Build and start services:
   `docker compose up --build`
3. Verify backend:
   `http://localhost:8000/health`

Services:
- Backend: `localhost:8000`
- Postgres: `localhost:5432`
- Qdrant: `localhost:6333`
