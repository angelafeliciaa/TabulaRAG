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

## Prior art & research influences

The 2025 eval landscape is noisy. Most published "RAG eval" tooling assumes LLM-generated answers; most "MCP eval" tooling is either scaffolding or LLM-judge prompts of dubious rigor. A few sources are worth building on.

| Source | What we borrowed | Where it shows up in this design |
|---|---|---|
| [GitHub MCP offline evaluation](https://github.blog/ai-and-ml/generative-ai/measuring-what-matters-how-offline-evaluation-of-github-mcp-server-works/) | **Tool-selection confusion matrix** — diagnose "did the LLM pick the right mode?" as a side-metric, not a gate. | Section 5 (diagnostic metrics) + Section 6 (report layout). |
| [`jorses/databench_eval`](https://github.com/jorses/databench_eval) | Use the official DataBench scorer library as a dependency — numeric tolerance (2dp truncation), category exact match, set equality — instead of reimplementing. | Section 5 and Phase 1 step 8. |
| [Anthropic: Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) | *"Sanity-check brittle tasks with a tool-less baseline; a 0% pass rate usually means the eval is broken, not the model."* | Section 4 (new pre-pass), Verification §5. |
| [τ-bench (Sierra)](https://github.com/sierra-research/tau-bench) | `pass^k` consistency (run N times, require consistency). **Not adopted for v1** because it 3×s our LLM cost; flagged in Risk 7 and deferred to v2. | Risks §7 + Deferred §v2. |
| [Sentry `mcp-server-evals`](https://github.com/getsentry/sentry-mcp) | Structural model for MCP eval checked into the same repo as the product, run in CI. | Directory layout §1, Phase 2. |
| [Stainless `mcp-evals-harness`](https://github.com/stainless-api/mcp-evals-harness) | "Efficiency" intuition: turns + tokens budget matters alongside correctness. | Section 5 metrics (token budget as a first-class metric). |
| [Hamel Husain — Evals FAQ](https://hamel.dev/blog/posts/evals-faq/) and [Eugene Yan — Task-specific LLM evals](https://eugeneyan.com/writing/evals/) | Binary/deterministic scoring over Likert; avoid LLM-as-judge where a deterministic oracle exists. | Goals §3, Section 5 framing. |

**What we explicitly *don't* borrow:**
- The LLM-as-judge stack (Ragas metrics that require a generator, TruLens, most MCP-eval prompts). Only useful for generative RAG; we don't have one.
- `mclenhard/mcp-evals` and `mcpx-eval` style "how helpful was the answer? 1–5" scoring. Called out by [Glama.ai's MCP-eval review](https://glama.ai/blog/2025-05-01-mcp-evals) as exactly the anti-pattern to avoid.
- ToolBench / agent-SDK benchmarks built for multi-tool orchestration. Our server is a single MCP tool with a handful of modes.

**Note on novelty.** We searched the major MCP server repos (Sentry, GitHub, Stainless, Canva, Block, Cloudflare, Linear, Notion) — **none publish a head-to-head comparison against a "no tool, raw file in context" baseline.** That's the core contribution of this harness and the reason it needs to be built rather than copied.

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

Three kinds of cases, all grounded in DataBench tables. Counts are sized to give each stratum adequate statistical power (see Section 3 on stratification and Section 5 on CIs).

| Family | Question source | Ground-truth source | Target count v1 |
|---|---|---|---|
| `semantic.lookup` | DataBench's natural-language questions | DataBench's labeled answer (row ids or answer string) | ~50 (≥25 per stratum) |
| `aggregate.pandas_oracle` | Templated (*"What's the sum of X grouped by Y?"*) | `pandas.groupby().agg()` on the CSV | ~50 (≥25 per stratum) |
| `semantic.edge` | Hand-authored — **matched refuse + control pair** | Hand-labeled acceptable-answer-set (incl. "should return nothing" on refuse cases; real answers on control cases) | ~40 (20 refuse + 20 control) |

**Total ≈ 140 cases v1.** 140 × 2 arms × ~1-2 LLM calls/arm = ~350 LLM calls/run. At Claude Sonnet pricing this is roughly **$8-15 per full run.** Acceptable for on-demand use. Per-run cost cap enforced in `config.py`.

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

### 3. Stratification by table size (decided *before* generating cases)

The CSV-attached baseline is not a uniform arm — its performance depends strongly on whether the table fits in Claude's context window. If we blend all cases into a single headline number, we are secretly measuring context-window limits, not retrieval quality.

**Two strata, decided upfront:**

| Stratum | Definition | What it measures |
|---|---|---|
| `fits_in_context` | Table serializes to ≤ *N* tokens under Claude Sonnet's tokenizer, where *N* = 0.5 × the model's context (so ~100K tokens for Sonnet's 200K window, leaving room for question + answer + instructions). | Tool-based retrieval vs. in-context reasoning when both arms see the full data. The honest accuracy comparison. |
| `requires_truncation` | Table exceeds *N* tokens. CSV-attached arm must downsample (first-N-rows sampling matching Claude Desktop file-attach behaviour). | Tool-based retrieval vs. the realistic fallback a user hits today when their CSV is too big. Still a fair comparison — this is the real-world experience of the baseline. |

**Pre-implementation audit (step 0 of Phase 1, before any case generation):**

1. Compute token count for each candidate DataBench CSV using `anthropic`'s tokenizer (or a deterministic approximation: `row_count × avg_row_serialization_tokens`).
2. Log the distribution. Pick the DataBench subset to have **balanced coverage** across both strata — target ≥ 25 cases per stratum per family (so `aggregate.pandas_oracle × fits` ≥ 25, `aggregate.pandas_oracle × requires_truncation` ≥ 25, same for `semantic.lookup`).
3. Commit the token-count audit as `evals/datasets/databench/token_audit.json` so reviewers can reproduce the stratum assignment.

**Report implications:**

- The headline scorecard shows **two sub-tables**, one per stratum, with a note that no single "overall" accuracy number is reported. This is a design choice, not an oversight — blending strata hides the mechanism.
- Each metric in each stratum gets a **95% Wilson confidence interval** next to the point estimate (see Section 5 on sample-size adequacy).
- Latency is reported **per stratum** because prompt size dominates it for the CSV-attached arm.

### 4. Arms — the systems being compared

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
- **`csv_attached.py`** — reads the CSV file, attaches it to the prompt, sends the same question to Claude with no tools. For tables in the `requires_truncation` stratum (defined in Section 3 — serialized size > ~100K tokens), downsample with a note in the prompt (`[dataset truncated; first 2000 of N rows shown]`). This mirrors how ChatGPT / Claude Desktop file attachments behave in practice; it is documented in the report header so readers know what the baseline actually saw.
- **`open_webui.py`** — v1.5. Stub raises `NotImplementedError` with a TODO pointing at this design doc.

**LLM client (shared by all arms):** `evals/arms/_llm.py` — thin wrapper around the Anthropic SDK. Retry on transient errors (with per-retry logging so retries don't silently mask regressions). Deterministic `temperature=0`. **Prompt caching is disabled in v1** for arm symmetry — the TabulaRAG arm would benefit from caching the MCP tool preamble across cases, but CSV-attached cannot cache a different CSV per case, so leaving caching on would inflate the cost/latency gap artificially. One model for v1: `claude-sonnet-4-6` (swap via config).

**Pre-pass — raw-Claude sanity check (before the main run).** Before we declare any TabulaRAG regression, we run each test case through a third "control" arm: **raw Claude with no tools and no CSV, just the question.** Any question this arm answers correctly is almost certainly too general ("what is the capital of France?") — such questions don't actually test tabular retrieval and should be flagged for removal from the suite. Any question on which *all arms* score 0, including this tool-less control, is likely a broken case (bad DataBench label, ambiguous phrasing) and should be excluded from the headline, not charged against the tool. This pattern is recommended explicitly in [Anthropic's agent eval guidance](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) — *a 0% pass rate usually means the task is broken, not the model.* The pre-pass runs once per eval suite version, not per run; results are committed alongside cases as `cases/_prepass_results.json` and used to auto-filter the main run.

### 5. Metrics & scoring

**Honest framing.** Calling this "deterministic" on free-form LLM output is misleading — a substring check on prose is a weak rule-based judge. To deserve the "deterministic" label, both arms must emit **structured output** under a fixed schema, and the scorer compares schema fields directly (not prose).

**Structured-output contract (both arms, enforced at prompt level):**

Each arm receives a system prompt instructing it to return a final JSON payload conforming to a `CaseAnswer` schema that depends on `case.expected.type`:

```python
# evals/arms/schemas.py
class RowValueAnswer(TypedDict):
    answer: str                    # the specific value/entity the question asks for
    supporting_columns: list[str]  # which column(s) of the table carried the answer

class GroupedNumericAnswer(TypedDict):
    groups: dict[str, float]       # {group_key: numeric_value}

class SingleNumericAnswer(TypedDict):
    value: float

class RefuseAnswer(TypedDict):
    refuse: bool                   # must be true on a legitimate refuse
    reason: str                    # "column not in table" / "no matching rows" / etc.
```

- **TabulaRAG arm** — achieves this naturally (tool returns structured data; we instruct Claude to format the final answer as the target schema and stop).
- **CSV-attached arm** — uses Anthropic's structured-output / JSON-mode parameter with the same schema. No tools.
- **Parse-failure handling** — if the final payload does not validate against the schema, the case is recorded as `parse_failed` for that arm. `parse_failed` is reported as its own metric (see below); it is **not** silently counted as a score of 0.

**Scoring rules per `expected.type`:**

| `expected.type` | Comparison (all on the parsed structured payload, not prose) |
|---|---|
| `row_value` | `answer.strip().casefold()` equals any entry in `expected.answer_value_contains` after the same normalization. *Substring matching is not used.* Citation check (TabulaRAG-only): set intersection of `supporting_columns` with `expected_columns_cited` must be non-empty. |
| `grouped_numeric` | All keys in `expected.groups` present in `groups`; for each group, `\|pred - truth\| / max(\|truth\|, 1e-9) < tolerance`. Extra groups in the answer are a penalty (precision degradation) but do not fail the case outright. |
| `single_numeric` | Same tolerance check on `value`. |
| `should_refuse` | `refuse == true`. See "Refuse-set integrity" below. |

**Scoring dependency — `databench_eval`.** Where possible, we use the official [`jorses/databench_eval`](https://github.com/jorses/databench_eval) scorer library rather than reimplementing comparison primitives. It provides: numeric tolerance (2-decimal truncation matching SemEval-2025 Task 8 scoring), category exact match, and order-independent set equality. These map directly onto our `single_numeric`, `row_value`, and parts of `grouped_numeric`. Keeping the dependency means our scores match the DataBench leaderboard's official scoring, which is useful if we ever want to report an absolute number (not just a gap).

**Refuse-set integrity.** `should_refuse` scoring is gameable if an arm just refuses everything. To catch this we always pair the refuse set with a **control set** — cases that look superficially similar but *do* have a correct answer. The reported metric is:

- **`refuse_precision`** — of cases where the arm refused, how many were supposed to be refused
- **`refuse_recall`** — of cases that were supposed to be refused, how many were
- **Primary**: F1 of the above, not pass/fail

An arm that refuses everything gets high recall but near-zero precision → low F1. An arm that never refuses gets recall 0 → low F1. Discrimination is rewarded.

**Per-arm, per-stratum metrics reported:**

- **`answer_accuracy`** + 95% Wilson confidence interval — fraction of cases scored correct (excluding parse failures from the denominator, counting them separately).
- **`parse_failure_rate`** — fraction of cases where the arm's output did not conform to the schema. **Asymmetric parse failure between arms invalidates the accuracy comparison**; the runner emits a warning in the report header if the two arms differ by > 3pp on this.
- **`median_latency_ms`** and **`p95_latency_ms`**
- **`time_to_first_token_ms`** (median) — separated out because TTFT often matters more for perceived UX than total latency, and it isolates prompt-ingestion from generation time.
- **`input_tokens`**, **`output_tokens`** — reported separately; cache-hit tokens reported separately from billed input tokens when available.

**Statistical adequacy.** With ≥ 25 cases per stratum per family, a 5pp accuracy gap has a 95% CI of roughly ±10pp. Target for **publishable** claims is ≥ 50 per stratum per family (~200 cases total across strata × families); v1 ships with the minimum adequate size and the roadmap expands to publishable.

**Prompt-caching symmetry.** Anthropic prompt caching is disabled for both arms in v1 (enable only once we've established baseline comparability). The TabulaRAG arm would naturally benefit from caching the MCP tool-schema preamble across cases; the CSV-attached arm cannot cache (different CSV per case). Leaving caching on asymmetrically inflates the cost/latency gap. Revisit in v2 after the baseline comparison is credible.

**Tool-selection diagnostic — mode confusion matrix (TabulaRAG arm only).**

Each `Case` carries an `expected_mode` label (semantic / aggregate / filter / filter_row_indices) — the mode a competent tool user *should* pick for that question. For every TabulaRAG-arm run we record which mode Claude actually invoked (extracted from `tool_calls[0].arguments.mode` in `ArmResult`) and tabulate a confusion matrix at the end of the run:

```
                   Claude picked →
                semantic  aggregate  filter  filter_row_indices
Expected ↓
semantic            20        3         2          0
aggregate            1       18         1          0
filter               0        2         8          0
filter_row_indices   0        0         0          0
```

The diagonal is correct mode-selection; off-diagonal entries reveal systematic confusions — e.g., "when aggregate is correct, Claude often picks filter" suggests your `UnifiedQueryRequest` mode descriptions are ambiguous between those two. This is a **diagnostic for tool-description quality**, not a pass/fail score. Pattern borrowed from [GitHub's MCP offline evaluation](https://github.blog/ai-and-ml/generative-ai/measuring-what-matters-how-offline-evaluation-of-github-mcp-server-works/), where confusion-matrix analysis was the highest-signal lever for improving their tool descriptions.

We also log the **tool-bypass rate**: fraction of cases where Claude answered without any MCP tool call at all. High tool-bypass rate on tabular questions is a sign the tool description doesn't read as useful enough — another signal that feeds back into prompt/schema improvements, not a bug in retrieval.

**TabulaRAG-internal retrieval metrics (not comparative):**

These measure *our system's* retrieval without going through the LLM arm — they are produced by a **separate retrieval-probe pass** that calls `semantic_search()` directly (from `backend/app/retrieval.py`) for each `semantic.lookup` case. They do not rely on scraping MCP tool-call traces, which is not a stable interface.

- **`retrieval.recall@5`** — for `semantic.lookup` cases, did any row-id in `expected.row_ids_any_of` appear in the top-5 returned rows?
- **`retrieval.mrr`** — mean reciprocal rank of the first matching row id.
- **`citation.precision`** — for cases with `expected_columns_cited`, did `generate_highlights()[0].column` match?

These are published in a separate "TabulaRAG internals" subsection of the report — clearly flagged as *not* comparable to the CSV-attached arm.

### 6. Report format

Written to `evals/reports/benchmark-<YYYY-MM-DD>.md` and `.json`. The markdown version is human-scannable; the JSON version is what future runs diff against. Numbers in the example below are illustrative only.

**No single overall accuracy number is reported.** The headline is always stratified, per the rationale in Section 3.

Markdown example:

```markdown
# TabulaRAG Benchmark — 2026-04-14

**Config**: model=claude-sonnet-4-6, temp=0, prompt_caching=off,
           subset_seed=42, embedding=MiniLM-L6, databench@abc1234, backend@def5678

## Headline — stratified

### Stratum: `fits_in_context` (table ≤ ~100K tokens)

|                          | TabulaRAG           | CSV-attached        | Open WebUI |
|--------------------------|---------------------|---------------------|------------|
| answer_accuracy (95% CI) | 0.84 [0.75 – 0.91]  | 0.81 [0.71 – 0.88]  | (deferred) |
| parse_failure_rate       | 0.02                | 0.04                | —          |
| median_latency           | 2.4s                | 3.1s                | —          |
| time_to_first_token      | 0.6s                | 1.2s                | —          |
| input_tokens (median)    | 1,200               | 24,000              | —          |
| output_tokens (median)   | 280                 | 310                 | —          |
| cases                    | 50                  | 50                  | 0          |

### Stratum: `requires_truncation` (table > ~100K tokens)

|                          | TabulaRAG           | CSV-attached (truncated to first 2000 rows) | Open WebUI |
|--------------------------|---------------------|--------|---|
| answer_accuracy (95% CI) | 0.72 [0.61 – 0.81]  | 0.18 [0.11 – 0.29] | (deferred) |
| parse_failure_rate       | 0.03                | 0.03   | — |
| median_latency           | 3.1s                | 14.2s  | — |
| input_tokens (median)    | 1,400               | 94,000 | — |
| cases                    | 40                  | 40     | 0 |

> ⚠️ Parse-failure rates differ by < 3pp → accuracy comparison is valid within this stratum.

## By family (within each stratum)

### semantic.lookup — fits_in_context (n=25)
... per-case breakdown ...

### aggregate.pandas_oracle — fits_in_context (n=25)
... per-case breakdown ...

### semantic.edge (refuse set, n=20) — refusal discrimination

|                     | TabulaRAG | CSV-attached |
|---------------------|-----------|--------------|
| refuse_precision    | 0.85      | 0.40         |
| refuse_recall       | 0.75      | 0.90         |
| refuse_f1           | 0.80      | 0.55         |

## TabulaRAG internals (not comparative — direct retrieval probe)

retrieval.recall@5: 0.83
retrieval.mrr:      0.71
citation.precision: 0.67

## Failures worth looking at
- sem_lookup_019 (fits): TabulaRAG scored 0 (returned wrong row); CSV-attached scored 1. [link to trace]
- agg_gen_017 (truncation): Both arms got group totals wrong by the same amount — suggests CSV-ingest normalization issue, not retrieval.

## Known caveats
- DataBench labels have ~5-10% known noise; absolute accuracy ceilings ~0.90-0.95.
- n=50 per stratum per family gives 95% CI halfwidths of ~10pp — treat gaps < 10pp as non-significant.
- CSV-attached truncation rule matches Claude Desktop file-attach behavior (first-N-rows). Other clients may behave differently.
```

The **"Failures worth looking at"** section is auto-generated from cases where arms disagree — the highest-signal debug artifact.

---

## Implementation Steps

Phased so each phase ships useful value.

### Phase 1 — Local-only harness (v1; realistic: 2-3 weeks)

*Previous estimate of ~1 week was optimistic. MCP + Anthropic client wiring (step 9), DataBench import + license review (step 2), and structured-output contract enforcement (step 10) are each 2-4 days in practice. 2-3 weeks covers both implementation and a verification pass that doesn't get dropped under deadline pressure.*

0. **Table-size audit — DO FIRST.** Before generating any test cases:
   - Survey DataBench's available tables, compute per-table serialized token count under Claude Sonnet's tokenizer.
   - Pick the DataBench subset (10-12 tables) aiming for balanced coverage above and below the `fits_in_context` boundary (~100K tokens). Use a fixed seed; document the seed in `datasets/manifest.json`.
   - Commit `evals/datasets/databench/token_audit.json` — the reviewable evidence that stratum assignment was decided before case generation.
   - If the audit reveals that <25% of suitable tables fall in one stratum, revisit the design (may need larger DataBench subset or a different benchmark).
1. **Scaffold `evals/`** directory and empty `__init__.py` files. Add `evals/` to the pytest configuration's ignore list so it doesn't accidentally run as part of `pytest tests/`.
2. **Implement `generators/databench_import.py`** — fetch the subset selected in step 0. Confirm license compatibility and add attribution file.
3. **Implement `harness/loader.py`** with the `Case` dataclass (including `stratum` field) and JSONL parser.
4. **Implement `harness/fixtures.py`** — session-scoped fixture that, given a `table` path, ingests it via `ingest_table()` in-process (`backend/app/main.py`) and returns `dataset_id`. Cache by file hash.
5. **Implement `generators/aggregate_gen.py`** — emit JSONL cases with pandas-computed ground truth, respecting the stratum balance from step 0.
6. **Implement `metrics/schemas.py`** — the `CaseAnswer` TypedDicts + a `validate_and_parse(payload, expected_type)` helper used by both the arms (to shape prompts) and the scorer (to check outputs). One source of truth.
7. **Hand-author `cases/semantic_edge.jsonl`** — ~20 refuse cases **plus a matched control set** of cases that look similar but *do* have answers. Target n ≥ 40 total (20 refuse + 20 control) so `refuse_f1` is meaningful.
8. **Implement `metrics/answer_match.py`** — wrap the [`databench_eval`](https://github.com/jorses/databench_eval) scorer library for numeric tolerance / category EM / set equality, plus parse-failure classification and a Wilson CI helper. Do not reimplement comparison primitives that already exist upstream.
9. **Implement `arms/_llm.py`** — Anthropic SDK wrapper. Enforces structured-output schema per case. Retry on transient errors with logging so retries don't silently mask regressions. Deterministic `temperature=0`. Prompt caching disabled in v1.
10. **Implement `arms/tabularag.py`** — issues MCP token, configures Claude to use `http://localhost:8000/mcp`, sends question *with the `CaseAnswer` schema requirement*, captures trace + answer. Detects when Claude fails to invoke the tool at all (answering from general knowledge) and flags the case as `tool_bypassed`.
11. **Implement `arms/csv_attached.py`** — sends CSV content + question under the same structured-output contract, no tools. For tables in `requires_truncation` stratum, applies the documented truncation rule (first 2000 rows).
12. **Implement `harness/retrieval_probe.py`** — separate non-LLM pass that calls `semantic_search()` directly for `semantic.lookup` cases to compute internal retrieval metrics. Does not require MCP trace scraping.
13. **Raw-Claude sanity pre-pass (Section 4).** Run each case through a tool-less, no-CSV control arm. Commit `cases/_prepass_results.json`. Flag and exclude from the headline any case that the tool-less control answers correctly (too general — not testing retrieval) or that scores 0 on every arm (likely broken case). Runs once per suite version, not per run.
14. **Implement `harness/runner.py`** — loops cases × arms × strata. Respects the pre-pass exclusion list. Persists intermediate state so interrupted runs can resume.
15. **Implement `run.py`** — CLI; prints a summary to stdout and writes stratified markdown + JSON to `reports/`.
16. **Write `evals/README.md`** — how to run, how to add a case, how to interpret the stratified report, how to regenerate cases.
17. **Commit a first baseline run** to `reports/` and link it from the repo README. Manual spot-check and read-30-transcripts gates (covered in Verification) must pass before announcement.

### Phase 2 — Nightly CI report (~1 day on top of Phase 1)

- GitHub Action on a cron schedule (02:00 UTC, `main` branch only).
- Runs `python evals/run.py --suite all`. Budget: wall-clock < 20 minutes, cost < $20/run (updated from earlier $10 estimate — see Section 2 on case-count inflation after stratification).
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
3. **Manual spot-check** after first baseline run — pull 10 random cases per stratum, look at arm outputs alongside `expected`, sanity-check the grading decisions match a human eye. Blocks v1 announcement.
4. **Read-30-transcripts rule** — for every major eval run (first baseline, before any publication of numbers, and whenever accuracy moves > 5pp run-over-run), read 30 random raw transcripts. Graders fail silently all the time; this catches it. Pattern recommended explicitly in [Anthropic's agent eval guidance](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) ("you won't know if your graders work unless you read transcripts").
5. **Trivial case sanity check** — a case where CSV-attached *must* win (tiny CSV, lookup question) and one where TabulaRAG *must* win (thousands of rows, needs semantic search). If the scorer rewards the "wrong" arm in the obvious cases, something's off.
6. **Pre-pass exclusion review** — after the raw-Claude sanity pre-pass (Phase 1 step 13), manually review the "excluded as too general" and "excluded as 0% across all arms" lists. The exclusion heuristic is conservative; any excluded case a human disagrees with should be re-added.

---

## Fallback & Error Handling

- **LLM API transient failures** — arm wrapper retries with exponential backoff, 3 attempts. After exhaustion, case records `error` and is scored as 0 for that arm. Report flags "partial run" in the header.
- **TabulaRAG backend down** — runner checks `/health` before starting; aborts with a clear message. No silent failures.
- **MCP tool call loop** — hard cap of 10 tool calls per case; breaking the cap records an error for that case and moves on.
- **Latency outlier** — per-case timeout (30s). Timed-out cases are scored 0 and flagged in the report.
- **Structured-output parse failure** — if the arm's output does not validate against its `CaseAnswer` schema, the case is recorded as `parse_failed` for that arm. **Parse failures are a separate reported metric — `parse_failure_rate` — not silently counted as an accuracy of 0** (see Section 5). The raw answer is logged for manual review. Asymmetric parse-failure rates between arms (> 3pp gap) trigger a warning in the report header; a large gap means we are partly measuring "which model follows the schema better," not retrieval quality.
- **Partial CSV ingestion** — if `ingest_table()` errors on a DataBench CSV (encoding, bad delimiters, etc.), the table is excluded from the run with a warning. Log the exclusion so we can fix the ingest gap.

---

## Open Questions / Risks

1. **DataBench subset selection bias.** Picking the "easy" tables inflates the headline number. Mitigation: seeded pseudo-random selection from step-0 token audit; document seed + selection criteria in `manifest.json`; include at least 2 tables flagged by DataBench as "hard" in each stratum.
2. **Ground-truth noise in DataBench.** Known ~5-10% of labels are noisy; this caps maximum accuracy meaningfully below 1.0, and it also caps *gap-between-arms* detection — if both arms hit the noisy ceiling differently, some of the gap is noise. Mitigation: run a one-time label audit on the chosen subset before generating cases; flag the noisiest 10% for exclusion or extra caution.
3. **CSV-attached baseline fairness.** The truncation rule for the `requires_truncation` stratum mirrors Claude Desktop's first-N-rows file-attach behaviour. We document it in `arms/csv_attached.py` and disclose it in the report. Other clients (ChatGPT, Cursor) may truncate differently — we note this as a limitation of the comparison, not a bug.
4. **Asymmetric parse-failure rates invalidate accuracy comparison.** If the two arms have materially different parse_failure_rate, we are partly measuring "which model follows the schema better," not retrieval quality. Mitigation: the runner emits a warning in the report header if the two arms' parse_failure_rates differ by > 3pp; that warning is prominent, not buried.
5. **TabulaRAG arm: silent tool-bypass.** Claude may answer from general knowledge without ever calling the MCP tool, effectively turning TabulaRAG-arm into a slightly-worse CSV-attached arm. We detect this per case (no MCP tool calls in trace) and record `tool_bypassed=true`; those cases are reported separately — their accuracy contribution is a signal of how compelling the tool's description is, not of retrieval quality.
6. **`retrieval.recall@5` is measured by a separate probe pass**, not scraped from MCP traces. MCP transport doesn't stably surface internal `semantic_search()` results to the client. The probe invokes `semantic_search()` directly (in-process), which is a clean, reproducible interface.
7. **LLM determinism.** Even at temp=0, Claude answers can drift slightly (~1-3% case-level flip rate in practice). Mitigation: `k=1` runs for v1 (single-pass), add `k=3` majority voting in v2 if we see flakiness > 3% on a given case.
8. **Retry masking regressions.** Anthropic SDK wrapper retries transient 5xx / rate-limit errors. If retries succeed silently, real timeout regressions in production configurations stay hidden from the eval. Mitigation: every retry is logged with reason and count; the report header surfaces total retry-count and any cases that needed >1 retry.
9. **Sample-size adequacy.** With ≥ 25 cases per stratum per family, a 5pp accuracy gap has a ~±10pp 95% CI. Results < 10pp gap should be treated as non-significant. Publishable claims need ≥ 50 per stratum per family; v1 ships with the minimum adequate size and the roadmap expands to publishable.
10. **Cost.** ~$8-15 per full run for v1 (140 cases × 2 arms at Claude Sonnet pricing, stratified = more baseline input tokens than the earlier back-of-envelope). Fine for on-demand. Phase 2 nightly ≈ ~$300/month. Phase 3 PR-smoke-set multiplies that by PR volume. Hard per-run cost cap enforced in `config.py`. If Anthropic Startups / AWS Bedrock / GCP Vertex credits are available, use those — see Misc section.
11. **"We're not better" (or "we're not better where it counts").** The stratified report may reveal that TabulaRAG ties with CSV-attached on small tables (the `fits_in_context` stratum) and only wins on large ones. That's still a real claim — just a narrower one than "TabulaRAG wins across the board." We publish what we find.
12. **Embedding model drift.** The FastEmbed model is pinned in code, but if someone changes `EMBEDDING_MODEL` between the eval ingestion and production, numbers move independently of quality. Mitigation: report header records `EMBEDDING_MODEL` at ingestion time AND at query time; a mismatch is a blocker, not a warning.
13. **Dataset schema drift.** If we change the shape of `UnifiedQueryRequest` or MCP tool descriptions between nightly runs, apparent regressions may be harness-misalignment, not real. Mitigation: each case records `authored_against_backend_sha`; runner logs when the active backend sha differs and flags results from that run as "backend drift — re-author cases if schema changed."
14. **DataBench upstream updates.** If DataBench publishes new versions of tables or revises answers, our committed JSONL cases may diverge from upstream ground truth without us noticing. Mitigation: `databench_import.py` pins a DataBench commit/version; regeneration requires a deliberate bump.
15. **`supporting_columns` is still LLM-produced prose.** For the `row_value` citation check we ask Claude to name the columns that carried its answer. That is an arm-produced string; treating it as ground-truth for citation scoring slightly circular. It is fine as a diagnostic signal, but we should not use it as a pass/fail gate for the headline accuracy number.

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

### v2.5 — `pass^k` consistency metric

Each case is run N times (k=3 minimum, k=8 ideal per [τ-bench's findings](https://github.com/sierra-research/tau-bench)). Report `pass@1` (at-least-one-success rate) alongside `pass^k` (all-k-succeed rate). The gap between these two numbers is a direct measure of non-determinism: τ-bench found `pass^8` under 25% on tasks where `pass@1` was 50% — single-run numbers massively overstate reliability. **Explicitly deferred from v1 because it triples LLM cost.** Add once we have credits or the baseline comparison is trusted enough to justify the budget.

### v3 — Ingestion / type-inference eval

Separate corpus of CSVs with labeled ground truth for: correct delimiter, correct header row, money/date/measurement columns. F1-scored. Measures `normalization.py` and ingestion-time inference logic in `backend/app/main.py`. Different shape of eval — no LLM involved.

### v4+ — Multi-model comparison, online eval, LLM-as-judge for phrasing quality

Open-ended research territory. Not planned.

---

## Misc

- **License of DataBench CSVs**: DataBench is released under a permissive license per the SemEval 2025 Task 8 paper. Confirm license compatibility and add attribution in `datasets/databench/README.md` during Phase 1.
- **Secrets handling**: `ANTHROPIC_API_KEY` and TabulaRAG API keys must be in env, never in files. `evals/config.py` reads from env only and errors loudly if missing.
- **Paying for runs**: Cursor credits do not apply (Cursor is a separate brokerage). Use direct Anthropic API credits (apply to [Anthropic for Startups](https://www.anthropic.com/startups) — TabulaRAG should qualify), AWS Bedrock credits (Claude is available on Bedrock), or GCP Vertex credits (Claude is on Vertex). For one-off v1 runs at ~$8-15 each, paying out of pocket is fine.
- **Reproducibility**: Every report includes: seed, DataBench subset commit, LLM model ID, `EMBEDDING_MODEL`, Python `requirements.txt` hash. Anyone with the same inputs should reproduce the numbers within LLM-determinism noise.
- **Naming**: "eval" and "benchmark" are used interchangeably in casual conversation; in this repo, the user-visible artifact is always called a **benchmark report** (the comparison is the point). "Eval" is the internal word for the harness.
