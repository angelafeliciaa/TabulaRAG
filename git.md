# Git Conventions — TabulaRAG

## Commit Format

Conventional Commits: `type(scope): subject`

```
feat(retrieval): add citation-precision scoring to semantic mode
```

- **Subject line** — one line, present tense, imperative mood ("add" not "added" or "adds")
- **Lowercase** after the colon — no capital letter
- **No period** at the end
- **50 chars max** for the subject (the part after `type(scope): `)
- **Body is optional** — one additional line max if the subject isn't enough. Two lines total, never more.
- **NEVER add `Co-Authored-By` trailers** — no AI attribution in commits, ever. All commits are authored by the developer only.

Prefer one-line commits. Keep changes small and focused so one line is sufficient:

```
fix(ingest): handle BOM in CSV encoding detection
```

## Pull Requests

- **Always create PRs as draft** — use `--draft` flag with `gh pr create`. Promote to ready when CI is green and you're ready for review.
- **One PR per logical change.** If you find yourself writing a multi-paragraph summary, it's probably two PRs.

## PR Titles

Short, descriptive, sentence case. No ticket prefix needed (no Linear / ticket system in this repo).

```
Add evals + benchmark harness
Fix CSV upload error when TSV has trailing tabs
Switch folder permission check to user groups
Bump fastembed to 0.3.x
```

- **Keep it under 70 characters.**
- **Describe the change**, not the problem. "Fix X by doing Y" is better than "Users can't do Y."
- Match the tone of recent merged PRs in the repo.

## Commit Types

| Type | When to use |
|---|---|
| `feat` | New functionality, new behavior |
| `fix` | Bug fix |
| `refactor` | Code change that doesn't fix a bug or add a feature |
| `docs` | Documentation only (README, tech-designs, code comments) |
| `test` | Adding or updating tests |
| `chore` | Maintenance, deps, config — no production code change |
| `style` | Formatting, whitespace, linting — no logic change |
| `ci` | CI/CD changes (`.github/workflows/`) |
| `perf` | Performance improvement |
| `build` | Build system, Dockerfile, Docker Compose |

## Scopes

Scope is **optional**. Omit it for changes that span multiple areas.

| Scope | Area |
|---|---|
| `api` | Backend FastAPI routes (`backend/app/routes_*.py`, `main.py`) |
| `retrieval` | Query + retrieval engine (`retrieval.py`, `routes_query.py`) |
| `ingest` | CSV/TSV ingestion + type inference (`indexing.py`, `normalization.py`) |
| `embed` | Embedding + Qdrant (`embeddings.py`, `qdrant_client.py`) |
| `mcp` | MCP server + tooling (`mcp_server.py`, `mcp_connection.py`) |
| `auth` | Authentication, JWT, OAuth, verification emails |
| `db` | Schema, models, migrations (`models/`, `db.py`) |
| `ui` | Frontend (`frontend/src/`) |
| `site` | Landing page (`site/`) |
| `evals` | Eval + benchmark harness (`evals/`) |
| `ci` | GitHub Actions, workflows |
| `pkg` | Python or npm dependency updates |
| `infra` | Docker, docker-compose, nginx config, deploy scripts |

Add new scopes as the codebase grows — this list isn't exhaustive.

## Examples

```
feat(evals): add DataBench import + aggregate case generator
feat(retrieval): return confidence score alongside top-k results
fix(ingest): handle BOM in CSV encoding detection
fix(mcp): return 401 on expired token instead of 500
refactor(retrieval): extract filter WHERE-clause builder
docs(readme): clarify local vs deployed env var rules
test(api): add coverage for filter_row_indices edge cases
chore(pkg): bump qdrant-client to 1.14
ci: run evals smoke set on PRs touching retrieval
perf(embed): batch-size autotune for FastEmbed
fix: resolve race when two uploads target the same folder
```
