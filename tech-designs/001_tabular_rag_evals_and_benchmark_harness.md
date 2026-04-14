# TabulaRAG Evals & Benchmark Harness

## Document Info

- **Feature ID**: 001 (no ticket system in repo yet)
- **Created**: 2026-04-14
- **Status**: Draft — awaiting review
- **Author**: Angela Felicia (design drafted via Claude brainstorming)
- **Related files (no LLM, pure retrieval + SQL pipeline):**
  - `backend/app/retrieval.py` — `semantic_search()`, `generate_highlights()`, `_infer_aggregate_answer()`
  - `backend/app/routes_query.py` — `unified_query_endpoint()`, `_run_semantic_query()`, `_run_aggregate_query()`, `_run_filter_query()`
  - `backend/app/indexing.py`, `embeddings.py`, `normalization.py` — ingestion + type inference
  - `backend/app/mcp_server.py`, `mcp_connection.py` — MCP tool exposure
  - `tests/` — existing unit coverage (see Current State)

---

## Executive Summary

TabulaRAG has no end-to-end evaluation or benchmark today. Existing `tests/` are unit tests of individual functions (filter correctness, aggregate math, ingest robustness). There is no answer to the question that actually matters to users: **"is TabulaRAG actually better than just handing a CSV to ChatGPT?"**

This design introduces an `evals/` harness in the same repo that produces a **head-to-head comparison scorecard** for tabular QA. The primary artifact is a comparison table (answer accuracy, latency, token cost) across:

- **TabulaRAG** — Claude using the TabulaRAG MCP tool against a pre-ingested dataset
- **CSV-attached baseline** — the same Claude with the raw CSV in context, no tool
- **Open WebUI RAG** — *deferred to v1.5*; noted in scope but not implemented in v1

We use **DataBench** (SemEval-2025 Task 8) as the corpus. It provides CSVs and natural-language questions with deterministic, programmatic ground-truth answers, so scoring is exact-match / numeric-tolerance — **no LLM-as-judge anywhere in the main loop.**

v1 focuses on **semantic + aggregate** modes (scope "C" from brainstorming — filter mode deferred because existing unit tests cover it well). v1 runs locally on demand; nightly CI reporting and per-PR gates are Phase 2 and Phase 3.

The purpose is **trust-building through evidence**: a number we can publish on the README, in a pitch, or in a paper that proves specialized tabular retrieval beats generic CSV-in-chat.

---

## Current State

### What exists

- 17 test files under `tests/` totalling ~300 unit tests. Strong coverage of:
  - Filter mode correctness (`test_filter.py`, `test_query_table.py`, ~60 tests)
  - Aggregate math (`test_aggregate.py`, 12 tests)
  - Normalization / type inference on synthetic inputs (`test_normalization.py`, 48 tests)
  - Ingestion happy paths (`test_ingest.py`, 28 tests)
  - Unified query routing (`test_query_unified.py`, 18 tests)
- CI runs pytest on every PR (see `.github/workflows/`).

### Gaps

The existing suite cannot answer any of:

1. **Retrieval quality** — given a natural-language question, does `semantic_search()` return the right row in the top-k? There is no labeled Q→row dataset.
2. **End-to-end correctness** — with an LLM client (the real usage mode), are answers factually correct against ground truth?
3. **Competitive comparison** — is TabulaRAG-as-tool better than CSV-in-context for the same LLM on the same question?
4. **Latency** — is TabulaRAG fast enough to be preferable to generic RAG?
5. **Citation relevance** — do the highlighted cells actually contain the information that answers the question?

### Why "evals" is the right framing now

Teams ship RAG systems without evals all the time and none of them can answer "are we actually good?" Users, investors, and collaborators correctly discount unevaluated claims. For TabulaRAG the value proposition — *"specialized tabular retrieval with cell citations beats generic CSV RAG"* — is unfalsifiable until we build the evidence for it.

---

## Goals and Non-Goals

### Goals (v1)

1. Produce a **comparison scorecard** (markdown + JSON) showing TabulaRAG vs. CSV-attached baseline on the same questions, with the same LLM, scored the same way.
2. Evaluate **semantic** and **aggregate** modes using DataBench tables and pandas-computed ground truth.
3. **Deterministic scoring only** in the main loop (numeric tolerance, string exact match, set match). No LLM-as-judge.
4. Run **locally on demand** — single entry point `python evals/run.py`.
5. Record **answer accuracy, latency, token usage** per arm per case.
6. Produce a checked-in report under `evals/reports/benchmark-<date>.md`.

### Non-Goals (v1 — explicitly deferred)

- **Open WebUI arm** — v1.5, after we have a working harness. Requires Open WebUI local/hosted setup and API access. Captured in "Deferred" section with hooks left in the arm interface.
- **Filter mode evaluation** — existing unit tests are thorough; revisit in v2 if data suggests filter-routing failures.
- **Ingestion / type-inference accuracy eval** — separate effort (different corpus, different metric). v3.
- **Per-PR CI regression gate** — Phase 3; requires 2+ weeks of Phase 2 nightly data to set defensible thresholds.
- **LLM-as-judge** — intentionally out of scope. DataBench answers are deterministic; we don't need a judge.
- **Multi-LLM comparison** — v1 uses one LLM (Claude Sonnet). Swapping models is a future experiment.
- **Production monitoring / online eval** — out of scope.

---

## Proposed Solution

### 1. Directory layout

```
evals/
├── README.md                     # how to run, how to add cases, how to read a report
├── run.py                        # CLI entry: python evals/run.py [--suite semantic|aggregate|all]
│                                  #                       [--arms tabularag,csv_attached]
│                                  #                       [--limit N]
├── config.py                     # model IDs, API keys (read from env), paths, thresholds
│
├── datasets/
│   ├── databench/                # vendored subset of DataBench CSVs
│   │   ├── table_001.csv
│   │   ├── table_012.csv
│   │   └── ...
│   └── manifest.json             # {table_id, source_url, row_count, column_types, license}
│
├── cases/                        # JSONL fixtures — the gold set
│   ├── semantic_lookup.jsonl     # from DataBench questions
│   ├── aggregate_oracle.jsonl    # pandas-synthesized {group_by, metric, op}
│   └── semantic_edge.jsonl       # ~30 hand-authored ambiguous / OOS cases
│
├── harness/
│   ├── loader.py                 # load JSONL → typed Case objects
│   ├── fixtures.py               # pytest-style: ingest each CSV once per session
│   └── runner.py                 # orchestrator — loops cases × arms, records results
│
├── arms/                         # one file per system being compared
│   ├── base.py                   # ArmProtocol: run(case) -> ArmResult
│   ├── tabularag.py              # Claude + TabulaRAG MCP
│   ├── csv_attached.py           # Claude + raw CSV in prompt
│   └── open_webui.py             # v1.5 — stub with NotImplementedError + TODO
│
├── metrics/                      # all deterministic
│   ├── answer_match.py           # numeric tolerance, string EM, set match
│   ├── retrieval.py              # recall@k, MRR (used by semantic.lookup scoring)
│   └── citations.py              # did highlights[0].column answer the question?
│
├── generators/                   # offline tools; their output (JSONL) is committed
│   ├── databench_import.py       # fetch DataBench subset → datasets/databench/
│   ├── aggregate_gen.py          # {table, group_by, metric, op} → pandas ground truth
│   └── edge_case_author.py       # scaffolding for hand-authored edge cases
│
└── reports/                      # gitignored — produced per run
    ├── benchmark-2026-04-14.md
    └── benchmark-2026-04-14.json
```

**Design principles:**

- **In-process where possible, HTTP where the shape demands it.** The TabulaRAG arm exercises the full MCP round-trip via a real Claude call; the arm runner spawns or connects to a running backend. The ingestion fixture, however, calls `ingest_table()` directly (`backend/app/main.py:1323`) — no need to push through HTTP for data loading.
- **JSONL cases are the source of truth.** Generators are one-shot scripts; their output is committed and reviewed like normal code.
- **Arms implement a single protocol.** Adding Open WebUI later means writing one file against the `ArmProtocol` in `arms/base.py`.

### 2. Test case families

Three kinds of cases, all grounded in DataBench tables:

| Family | Question source | Ground-truth source | Target count v1 |
|---|---|---|---|
| `semantic.lookup` | DataBench's natural-language questions | DataBench's labeled answer (row ids or answer string) | ~30 |
| `aggregate.pandas_oracle` | Templated (*"What's the sum of X grouped by Y?"*) | `pandas.groupby().agg()` on the CSV | ~30 |
| `semantic.edge` | Hand-authored (~20-30, one-time cost) | Hand-labeled acceptable-answer-set (incl. "should return nothing") | ~20 |

**Total ≈ 80 cases v1.** 80 × 2 arms × ~1-2 LLM calls/arm = ~200 LLM calls/run. At Claude Sonnet pricing this is roughly **$3-8 per full run.** Acceptable for on-demand use.

**Case JSONL format (stable schema across families):**

```jsonl
{
  "id": "sem_lookup_012",
  "kind": "semantic.lookup",
  "table": "databench/table_012.csv",
  "question": "Who is the highest-paid manager in the Europe region?",
  "expected": {
    "type": "row_value",
    "row_ids_any_of": [42],
    "answer_value_contains": ["Alex Morgan"],
    "expected_columns_cited": ["salary", "region"]
  },
  "metadata": {"source": "databench", "difficulty": "easy"}
}
{
  "id": "agg_gen_007",
  "kind": "aggregate.pandas_oracle",
  "table": "databench/table_012.csv",
  "spec": {"op": "sum", "metric_column": "revenue", "group_by": "region"},
  "question": "What is the total revenue by region?",
  "expected": {
    "type": "grouped_numeric",
    "groups": {"US": 540000.0, "EU": 320000.0, "APAC": 120000.0},
    "tolerance": 0.001
  }
}
{
  "id": "sem_edge_003",
  "kind": "semantic.edge",
  "table": "databench/table_012.csv",
  "question": "What is the average salary on Mars?",
  "expected": {
    "type": "should_refuse",
    "acceptable_answers": ["[empty]", "cannot be determined", "no matching rows"]
  }
}
```

### 3. Arms — the systems being compared

All arms implement:

```python
# evals/arms/base.py
from dataclasses import dataclass
from typing import Protocol

@dataclass
class ArmResult:
    answer_text: str           # the LLM's final natural-language answer
    answer_parsed: object      # numeric value / list / dict extracted from answer_text
    tool_calls: list[dict]     # for debugging: what the LLM did
    latency_ms: int            # wall clock, question → final answer
    tokens: dict               # {"input": int, "output": int}
    error: str | None          # None on success

class Arm(Protocol):
    name: str
    def run(self, case: Case) -> ArmResult: ...
```

**v1 arms:**

- **`tabularag.py`** — starts (or connects to) a running TabulaRAG backend, ensures the case's CSV is ingested (idempotent — keyed on file hash), issues an MCP token, spawns a Claude client with the MCP tool configured, sends the case question, captures the final answer.
- **`csv_attached.py`** — reads the CSV file, attaches it (as a file block or large prompt inclusion, depending on size), sends the same question to Claude with no tools. For CSVs over ~200 KB, downsample with a note in the prompt ("[dataset truncated; first 2000 of 8000 rows shown]"); this mirrors how ChatGPT/Claude file attachments behave in practice.
- **`open_webui.py`** — v1.5. Stub raises `NotImplementedError` with a TODO pointing at this design doc.

**LLM client (shared by all arms):** `evals/arms/_llm.py` — thin wrapper around the Anthropic SDK with prompt caching, retry on transient errors, deterministic `temperature=0` for reproducibility. One model for v1: `claude-sonnet-4-6` (swap via config).

### 4. Metrics & scoring

All scoring is **deterministic.** The scorer inspects `ArmResult.answer_parsed` and compares to `case.expected`:

| `expected.type` | Comparison |
|---|---|
| `row_value` | Does `answer_text` contain any value from `answer_value_contains` (case-insensitive)? + did the arm's citation (`tool_calls[*].highlights[0].column` for TabulaRAG) match `expected_columns_cited`? |
| `grouped_numeric` | Extract `{group: value}` dict from answer (regex + JSON-mode hint in arm prompt). Compute per-group `\|pred - truth\| / max(\|truth\|, 1e-9)` and require < `tolerance` for all groups. |
| `single_numeric` | Extract number from answer; same tolerance check. |
| `should_refuse` | True if answer is empty, matches any `acceptable_answers` phrase, or below a confidence signal (for TabulaRAG: zero results returned). |

**Per-arm metrics reported:**

- **`answer_accuracy`** — fraction of cases scored "correct" by its `expected.type` rule. *Primary headline metric.*
- **`median_latency_ms`** and **`p95_latency_ms`**
- **`total_tokens`** (input + output, for cost proxy)

**TabulaRAG-only additional metrics (not comparative, internal signal):**

- **`retrieval.recall@5`** — for `semantic.lookup` cases, did `expected.row_ids_any_of` appear in `semantic_search()`'s top-5 before the LLM answered? Inspected via the MCP tool call trace.
- **`citation.precision`** — for cases with `expected_columns_cited`, did the arm's cited column match?

### 5. Report format

Written to `evals/reports/benchmark-<YYYY-MM-DD>.md` and `.json`. The markdown version is human-scannable; the JSON version is what future runs diff against.

Markdown example:

```markdown
# TabulaRAG Benchmark — 2026-04-14

## Headline

|                    | TabulaRAG | CSV-attached | Open WebUI |
|--------------------|-----------|--------------|------------|
| answer_accuracy    | 0.78      | 0.52         | (deferred) |
| median_latency     | 2.1s      | 11.4s        | —          |
| p95_latency        | 4.8s      | 28.0s        | —          |
| total_tokens       | 72,400    | 861,000      | —          |
| cost ($USD est.)   | $0.58     | $4.12        | —          |
| cases              | 80        | 80           | 0          |

## By suite

### semantic.lookup (n=30)
... per-case breakdown ...

### aggregate.pandas_oracle (n=30)
... per-case breakdown ...

### semantic.edge (n=20)
... per-case breakdown ...

## TabulaRAG internals (not comparative)

retrieval.recall@5: 0.83
citation.precision: 0.67

## Failures worth looking at
- sem_lookup_019: TabulaRAG scored 0 (returned wrong row); CSV-attached scored 1. [link to trace]
- agg_gen_017: Both arms got group totals wrong by the same amount — suggests CSV-ingest normalization issue, not retrieval.
```

The "Failures worth looking at" section is auto-generated from cases where arms disagree — the highest-signal debug artifact.

---

## Implementation Steps

Phased so each phase ships useful value.

### Phase 1 — Local-only harness (v1; ~1 week)

1. **Scaffold `evals/`** directory and empty `__init__.py` files. Add `evals/` to the pytest configuration's ignore list so it doesn't accidentally run as part of `pytest tests/`.
2. **Implement `harness/loader.py`** with the `Case` dataclass and JSONL parser.
3. **Implement `harness/fixtures.py`** — session-scoped fixture that, given a `table` path, ingests it via `ingest_table()` (calling into `backend/app/main.py` in-process) and returns the `dataset_id`. Cache by file hash.
4. **Implement `generators/databench_import.py`** — fetch DataBench subset (10-12 tables, pseudo-randomly selected with a fixed seed documented in `datasets/manifest.json`). Write CSVs to `datasets/databench/`.
5. **Implement `generators/aggregate_gen.py`** — for each imported table, pick 3-5 `{group_by, metric, op}` combinations where the pandas computation is unambiguous (numeric metric columns only, categorical group-by columns only). Emit JSONL cases with pandas-computed ground truth.
6. **Hand-author `cases/semantic_edge.jsonl`** — 20-30 cases including: ambiguous questions with multiple plausible answers, out-of-scope questions (question about a column that doesn't exist), questions that should return "no matching rows."
7. **Implement `arms/_llm.py`** — Anthropic SDK wrapper, retry, deterministic temp=0.
8. **Implement `arms/tabularag.py`** — issues MCP token via the app's token-generation path, configures Claude to use `http://localhost:8000/mcp` as a tool, sends question, captures trace + answer.
9. **Implement `arms/csv_attached.py`** — sends CSV content + question in a single prompt with no tools.
10. **Implement `metrics/answer_match.py`** — the per-`expected.type` comparison functions.
11. **Implement `harness/runner.py`** — loops cases × arms, dispatches, collects `ArmResult`s, persists intermediate state to `evals/reports/.cache/` so interrupted runs can resume.
12. **Implement `run.py`** — CLI with `--suite`, `--arms`, `--limit`, `--only-case-ids` flags; prints a summary table to stdout and writes markdown + JSON to `reports/`.
13. **Write `evals/README.md`** — how to run, how to add a case, how to interpret the report, how to regenerate `cases/*.jsonl` after changing a generator.
14. **Commit a first baseline run** to `reports/` and link it from the repo README.

### Phase 2 — Nightly CI report (~1 day on top of Phase 1)

- GitHub Action on a cron schedule (02:00 UTC, `main` branch only).
- Runs `python evals/run.py --suite all`. Budget: wall-clock < 20 minutes, cost < $10/run.
- Posts results as a workflow artifact and comments on a pinned issue (`#evals-nightly-results`).
- **No merge gating.**
- Two weeks of nightly data gives the variance we need to set Phase 3 thresholds responsibly.

### Phase 3 — Per-PR smoke gate (~3 days)

- Smoke set: 30 cases fixed-seed-sampled from the full 80.
- Runs on every PR touching `backend/app/retrieval.py`, `routes_query.py`, `indexing.py`, `embeddings.py`, `normalization.py`, or `mcp_server.py`. Skipped otherwise.
- **Threshold gate** — derived from Phase 2 data (e.g. "TabulaRAG answer_accuracy must not drop by more than 5pp vs. last nightly on main").
- Failures block merge; label `eval-override` bypasses with justification comment.

### Phase 4+ (future; not designed in detail)

See **Deferred** section.

---

## Verification

Evals are themselves code that can be wrong. We verify with:

1. **Unit tests for metrics** — `tests/evals/test_answer_match.py` covering numeric tolerance, set equality, case-insensitive string match, "should_refuse" classification. Small, fast, run with the normal test suite.
2. **Golden-run test** — a tiny `cases/_selftest.jsonl` with 3 hand-crafted cases whose answers we know; a runner test mocks the arms with canned `ArmResult`s and asserts the scorer produces the expected report. Catches breakage in the runner/scorer pipeline without needing live LLM calls.
3. **Manual spot-check** after first baseline run — pull 10 random cases, look at arm outputs alongside `expected`, sanity-check the grading decisions.
4. **Comparing arms on trivially different cases** — e.g., a case where CSV-attached *must* win (tiny CSV, lookup question) and one where TabulaRAG *must* win (thousands of rows, needs semantic search). If the scorer rewards the "wrong" arm in the obvious cases, something's off.

---

## Fallback & Error Handling

- **LLM API transient failures** — arm wrapper retries with exponential backoff, 3 attempts. After exhaustion, case records `error` and is scored as 0 for that arm. Report flags "partial run" in the header.
- **TabulaRAG backend down** — runner checks `/health` before starting; aborts with a clear message. No silent failures.
- **MCP tool call loop** — hard cap of 10 tool calls per case; breaking the cap records an error for that case and moves on.
- **Latency outlier** — per-case timeout (30s). Timed-out cases are scored 0 and flagged in the report.
- **Ground-truth parsing failure** — if the arm's answer can't be parsed into `answer_parsed`, the case is scored 0 and the raw answer is logged for manual review. (Expected to happen on ~5% of cases where the LLM phrases things unusually — this is a known noise floor.)
- **Partial CSV ingestion** — if `ingest_table()` errors on a DataBench CSV (encoding, bad delimiters, etc.), the table is excluded from the run with a warning. Log the exclusion so we can fix the ingest gap.

---

## Open Questions / Risks

1. **DataBench subset selection bias.** Picking the "easy" tables inflates the headline number. Mitigation: seeded pseudo-random selection; document seed + selection criteria in `manifest.json`; include at least 2 tables flagged by DataBench as "hard."
2. **Ground-truth noise in DataBench.** Known ~5-10% of labels are noisy; this caps maximum accuracy meaningfully below 1.0. We should note this in the report header and *not* aim for a number like "we hit 95%" — the absolute number is less meaningful than the **gap between arms** on the same cases.
3. **CSV-attached baseline fairness.** How we construct the CSV-attached prompt matters — if we dump a 10MB CSV in the context window, the arm fails trivially; if we clean it up too aggressively, we're unfairly helping the baseline. Mitigation: choose an approach that mirrors what a real user would do in Open WebUI or Claude Desktop (file attachment UI, typical truncation). Document the prompt in `arms/csv_attached.py`.
4. **LLM determinism.** Even at temp=0, Claude answers can drift slightly. Mitigation: `k=1` runs for v1 (single-pass), add `k=3` majority voting in v2 if we see flakiness > 3% on a case.
5. **Cost.** ~$3-8 per full run is fine for on-demand, but Phase 2 nightly = ~$200-250/month. Budget and enforce a per-run hard cap in `config.py`.
6. **"We're not better."** The eval may reveal that TabulaRAG loses to CSV-attached on some category of questions. That's the point. We publish what we find.
7. **Embedding model drift.** The FastEmbed model is pinned in code, but if someone changes `EMBEDDING_MODEL` env var, eval numbers move independently of quality changes. Mitigation: the report header records `EMBEDDING_MODEL`, `qdrant-client` version, Python package hashes for reproducibility.
8. **Dataset schema drift.** If we change the shape of `UnifiedQueryRequest` or MCP tool descriptions, old cases may fail not because the system got worse but because the eval harness needs updating. Mitigation: cases pin the backend commit they were authored against; runner warns if the active backend commit differs materially.

---

## Deferred / Future Work

### v1.5 — Open WebUI arm *(explicitly requested for roadmap)*

**What:** Third arm — run the same questions through Open WebUI's built-in RAG with the CSV uploaded via their UI.

**Why deferred:** Open WebUI setup requires either a local instance (Docker, auth, document indexing config) or access to a hosted deployment with API keys. Neither is trivial to automate. Not worth the setup tax for v1 when we can demonstrate the core thesis (TabulaRAG vs. CSV-attached) with two arms.

**What's already in place for this:** `arms/open_webui.py` file exists as a stub implementing the `Arm` protocol with `NotImplementedError`. `run.py` accepts `--arms open_webui` and will route to it cleanly once the stub is filled in. Comparison report format already reserves a column for it.

**What's needed to finish:**
- A local or hosted Open WebUI instance reachable from dev machine and (eventually) CI.
- Open WebUI API client (they expose a REST API for chats and document uploads).
- Per-case upload flow: upload CSV to their RAG knowledge base, ask question, capture answer + latency.
- Cost considerations: if their RAG calls an OpenAI/Anthropic API under the hood, we need to account for that separately.

**Estimated effort:** ~3-4 days once Open WebUI is set up.

### v2 — Filter mode eval

Add a `filter.pandas_oracle` case family — templated filter conditions (`{column, op, value}` chains) with pandas computing the expected row indices. Only worth building if Phase 2 surfaces filter-mode regressions that unit tests miss, or if we want to add a mode-routing arm where the LLM picks the mode itself.

### v3 — Ingestion / type-inference eval

Separate corpus of CSVs with labeled ground truth for: correct delimiter, correct header row, money/date/measurement columns. F1-scored. Measures `normalization.py` and ingestion-time inference logic in `backend/app/main.py`. Different shape of eval — no LLM involved.

### v4+ — Multi-model comparison, online eval, LLM-as-judge for phrasing quality

Open-ended research territory. Not planned.

---

## Misc

- **License of DataBench CSVs**: DataBench is released under a permissive license per the SemEval 2025 Task 8 paper. Confirm license compatibility and add attribution in `datasets/databench/README.md` during Phase 1.
- **Secrets handling**: `ANTHROPIC_API_KEY` and TabulaRAG API keys must be in env, never in files. `evals/config.py` reads from env only and errors loudly if missing.
- **Reproducibility**: Every report includes: seed, DataBench subset commit, LLM model ID, `EMBEDDING_MODEL`, Python `requirements.txt` hash. Anyone with the same inputs should reproduce the numbers within LLM-determinism noise.
- **Naming**: "eval" and "benchmark" are used interchangeably in casual conversation; in this repo, the user-visible artifact is always called a **benchmark report** (the comparison is the point). "Eval" is the internal word for the harness.
