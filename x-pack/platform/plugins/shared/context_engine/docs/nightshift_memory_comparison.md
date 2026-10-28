# Nightshift knowledge (Cortex, Memory, decision trees) vs Context Engine memory

Status: research draft, not for merge.

Abbreviations: **NI** = `x-pack/solutions/observability/plugins/nightshift_investigations`,
**NS** = `x-pack/solutions/observability/plugins/nightshift`,
**DT** = `x-pack/solutions/observability/packages/kbn-nightshift-decision-trees`,
**WF** = `src/platform/packages/shared/kbn-workflows/managed/definitions/nightshift_investigations`.

## TL;DR

- **Nightshift already stores its knowledge in Context Engine.** Three managed AI indices are
  registered with `contextEngine.registerAiIndex`:
  - `nightshift-cortex` (`ai-index-idx-nightshift-cortex`) holds the wiki pages
    (`NI/server/cortex/register_cortex.ts:46`).
  - `nightshift-semantic-memory` holds task-recall memories (`NI/server/memory/register_memory.ts:34`).
  - `nightshift-decision-trees` holds Mermaid trees, their versions and learnings
    (`NI/server/decision_trees/register_decision_trees.ts:33`).
- **No AI index holds investigations.** The transcripts are Agent Builder conversations
  (`.chat-conversations`, `template_id: 'investigation'`). Structured results go to the
  `agentic_investigations` attachment indices (`.kibana-investigation-{hypotheses,impact,subject,claim}`).
  The three AI indices hold knowledge distilled *from* those rounds.
- **Nightshift uses AI indices only as storage.** It writes raw documents with `esClient.index` and
  `esClient.delete`, and bypasses `ki_write` / `ki_revision`. So it gets no revisions, no
  `governance.lifecycle`, no provenance and no references. Its statuses
  (`tentative|established|archived`) live in flattened `attributes`, which ES|QL can't filter. As a
  result, `query_ai_indices` on these indices returns archived Cortex pages and memories.
  Context Engine also has no write contract other plugins could use instead: the start contract
  exposes reads, signals, improvements, short-term memory and forget only (`context_engine/server/types.ts:44`).
- **The biggest difference is when and how knowledge is derived.** Nightshift learns implicitly:
  it reads the transcript after every round and derives straight into its stores. We learn
  explicitly: the agent calls `remember`, then dreaming runs as a batched, cursor-driven,
  configurable consolidation per AI index.
- **On retrieval, the approaches are opposite.** Nightshift pre-hydrates knowledge as markdown
  files into the agent's sandbox, and the agent is told *not* to use KI tools
  (`investigator.md.text:31`). Context Engine is pull-based: `describe_ai_index`, then ES|QL via
  `query_ai_indices`.

## 1. How each system derives knowledge

| | Nightshift Cortex (wiki) | Nightshift Memory | Nightshift decision trees | CE dreaming |
|---|---|---|---|---|
| **Trigger** | Agent post-execution workflow `system-nightshift-agent-optimize`, after **every** round (`NI/server/agents/investigation/index.ts:165`) | Same workflow, in parallel with Cortex | Same workflow, sequential after Cortex/Memory | Scheduled managed workflow per AI index (default daily), or `_dream` |
| **Input** | Round transcript: prompt and response (12k chars each), sandbox tool calls and results (32k). Seeded-file reads are filtered out | Round transcript, plus the memories recalled this round and whether the agent opened them | Replay of the full round, with reasoning steps, and the trees the agent opened | Short-term memories the agent chose to `remember`, grouped by session or user |
| **Gate** | Investigator/assistant agents only, ≥ 3 sandbox tool calls | Same agent gate | Investigator rounds only | Any `remember` caller; `memory_enabled` |
| **LLM shape** | One structured-output call (`nightshift_cortex_optimize`). Sees a catalog of existing pages (slug, type, title, status, count) but **not their content**. Up to 8 edits: `upsert`, `corroborate`, `archive` | Pipeline: `critique` (recalled memories → useful/harmful), `extract` (≤ 3 topics), `write`, `compact` | **A full agent** (`significant-events.decision-tree-reinforcement`) with sandbox file tools. It edits Mermaid files following one of four scripts (create/merge/extend/reinforce) and submits through a guarded tool that rejects and lets it retry | One structured-output call per task. Returns a typed change set (entities, facts, relationships, access patterns) against existing KIs **with their content** |
| **Output model** | Flat markdown pages; 9 entity types (service, alert, runbook, query, …); no links | Markdown "lessons" with bandit counters | Mermaid `flowchart` (symptom → evidence → decision → end), learnings, append-only versions | Typed graph: `entity.<type>` with content summary, `fact.<type>`, `relates_to`/`about` references, ES\|QL access patterns |
| **Schema config** | Hard-coded in the prompt | Hard-coded | Hard-coded (format guide) | Per AI index: instructions, fact/entity/relationship types |
| **Validation** | Enum checks and truncation; slug/title dedupe; duplicate pruning (hard delete) | Length budget, compaction | Parse, min graph, ≤ 30% node loss, size ≥ 50%, slug rules (`DT/src/guardrails.ts`) | Per-item validation, configured types only, ref resolution, source-memory checks, **ES\|QL verification of access patterns** |
| **Confidence** | `tentative` → `established` after 1 corroboration from a later run | Thompson sampling over impressions/conversions (7-day half-life); critique archives `harmful` | `tentative` → `established` when a confirmed root cause adds a new ✅ edge | None. Lifecycle is `active`/`stale`/`deleted` only |
| **History/provenance** | None: overwrite in place; `_seq_no` only | `conversation_id`, `merged_from` | Version docs (author, summary) | `derived_from` memory ids, `observed_in` session, `ki_revision` history, `task://dreaming` provenance |
| **Idempotency / retry** | Not atomic; page-by-page writes | Not atomic | Retry loop inside the agent | Plan persisted before apply; retries replay it; cursor plus `retry` queue |
| **Forget / privacy** | Prompt rule only (no PII) | Archive/delete via UI | None | `forget` → stale → re-dream; per-user groups |
| **Human review** | None before commit; UI edit/archive afterwards | UI archive/delete | None; UI is read-only | None for dreaming. CE improvements (feedback analysis) do have approve/reject |
| **Model** | The round's connector | The round's connector; usage id `nightshift_investigation_memory` | `resolveModel` | `context_engine` inference feature |

### What Nightshift does that we don't

1. **Learns from the transcript, not only from what the agent chose to remember.** Nothing depends
   on the agent remembering to call `remember`. This matters most for investigations, where the
   valuable signal is in the tool calls (the queries that worked).
2. **Uses outcome and usage to reinforce knowledge.**
   - Memory critiques what it recalled (useful/harmful) and keeps bandit statistics.
   - Cortex promotes a page once a later run corroborates it.
   - Trees mark the path a confirmed root cause took.
   - Dreaming has no notion of "this KI was read and helped or hurt".
3. **Guards against learning its own knowledge back.** `isSeededWorkspaceAccess`
   (`NI/server/investigation_round/seeded_filter.ts`) strips reads of hydrated knowledge before the
   optimizers see them. We have the same risk: an agent that recalls a KI and then `remember`s it
   feeds it straight back into dreaming.
4. **Has procedural knowledge (decision trees).** Our schema is declarative
   (entities/facts/relationships). Access patterns are the only procedural piece.
5. **Treats knowledge as hypotheses.** The prompt makes the agent treat tentative pages and trees as
   leads to verify, not answers.

### What we do that Nightshift doesn't

1. **Configurable, typed schema per AI index.** Nightshift's 9 Cortex types are one hard-coded
   instance of the dreaming config.
2. **Provenance, revisions and forget.** Every KI traces back to source memories and sessions.
   Cortex can't say where a page came from or what it said yesterday.
3. **Verified access patterns.** Cortex `query` pages are unverified ES|QL in markdown. Dreaming
   runs every example through the ES|QL verifiers as the workflow user.
4. **The model sees existing content when it edits.** The Cortex optimizer sees only titles and
   slugs, so an `upsert` can overwrite a page it never read.
5. **Deterministic ids, plan persistence and an idempotent apply.** Nightshift's writes are
   page-by-page and not atomic.
6. **Batched, bounded cost.** Nightshift spends up to four LLM calls plus a reinforcement agent run
   after every round.

## 2. How each system retrieves knowledge

| | Nightshift | Context Engine |
|---|---|---|
| **Mechanism** | Before-agent workflow `system-nightshift-sandbox-materialize-workspace` writes files into the sandbox: `/workspace/cortex/{README,INDEX}.md` + `{bucket}/{slug}.md`, `/workspace/memories/*.md` + `.index.json`, `/workspace/decision-trees/*.md` + `monitors.md` | Agent tools: `describe_ai_index` (fields, example queries, memory queries), then `query_ai_indices` (ES\|QL) |
| **Selection** | Cortex: **all** non-archived pages in the space (cap 500). Memory: top 15 by RRF hybrid (BM25 + `description.semantic`) on the user prompt, falling back to Thompson sampling. Trees: all non-archived; the LLM picks by reading `monitors.md` | The agent writes the query. It can be entity-scoped (`MV_CONTAINS(references.uri, "ki://<entity>")`) |
| **Filtering** | Space, via an `_id` prefix and `attributes.space_id` | Server-side space filter and lifecycle filter (`active` only), plus a row limit |
| **Agent reads** | `nightshift_sandbox_view_file` / `bash`; reads are parsed afterwards to tell which knowledge was used | Tool calls (logged as signals) |
| **Cost profile** | Fixed context cost; the agent needs no query skill; scales poorly as the wiki grows | Pay per query; needs the agent to write ES\|QL; scales well |

Nightshift's approach works because its agent already lives in a sandbox and is good at file
navigation. That is the "wiki" experience. CE has no file rendering of KIs today.

## 3. Proposed integration

The goal is for Nightshift to keep its product behaviour (wiki, trees, learning after each
investigation) while Context Engine owns storage, derivation, governance and viewing. The phases
are ordered so that each one ships value on its own and can be evaluated with Nightshift's
existing eval suite (`kbn-evals-suite-nightshift-investigations`, including
`decision_tree_evidence.ts`).

### Phase 0: write through Context Engine (no behaviour change)

- **CE:** add a KI write contract to `ContextEnginePluginStart`, for example
  `getKiWriter({ aiIndexId, spaceId, provenance })` with `upsert`, `softDelete` and `setStatus`.
  It wraps `ki_write.ts` / `ki_revision.ts`. Today, plugins that register managed indices have no
  supported way to write them.
- **Nightshift:** switch the three page stores (`cortex/page_store.ts`, `memory/page_store.ts`,
  `decision_trees/store.ts`) to use it.
  - **Archive:** map `archived` to the CE soft delete, so `query_ai_indices` and the lifecycle
    filter stop surfacing archived pages.
  - **Maturity:** keep `tentative`/`established` as an attribute for now (see Phase 3).
  - **Provenance:** `task://nightshift/cortex-optimize` (and the same for memory and trees), plus
    `observed_in: session://<conversation_id>`.
- **Wins:** Cortex gets version history for free through `ki_revision`; the UI could show diffs
  the same way trees already do. Decision-tree version docs could then be retired in favour of KI
  revisions.

### Phase 1: feed short-term memory from investigation rounds

- Add a step to `system-nightshift-agent-optimize` that writes the round's distilled observations
  to short-term memory through `getShortTermMemoryService()`:
  - one memory per finding
  - `session_id` = conversation id
  - no `user_id`, so the memory is shared
  - `attributes`: agent id, round, verdict and whether root cause was confirmed, the knowledge ids
    the agent opened, and the ES|QL queries that returned evidence
- Reuse the shared round loader and `seeded_filter`, so recalled knowledge never re-enters as a
  memory.
- I'd do this deterministically in the post-round step rather than asking the investigator to call
  `remember`. It keeps Nightshift's "learn from everything" property, and the transcript is
  already loaded there. An investigator-side `remember` tool can come later for things only the
  agent knows are worth keeping.
- **Freshness:** Nightshift expects the next investigation to benefit right away. After writing,
  the step calls `_dream` targeted at `session_id`. This first needs the open question in the
  dreaming spec fixed: `_dream` should queue or report a concurrent run, not silently drop it.
  Otherwise a burst of investigations loses dreams until the next schedule.

### Phase 2: Cortex becomes a dreaming config (run in shadow first)

Turn on dreaming for a shadow AI index `nightshift-cortex-v2` with a config that expresses Cortex:

- **Entity types:** `service`, `integration`, `alert`, `dashboard`, `topic`, `glossary`, with
  attributes such as `service.name`, `rule_id`, `dashboard_id`. The **entity content summary is
  the wiki page**, rewritten whenever a fact about it changes.
- **Fact types:** `symptom`, `root_cause`, `remediation`, `runbook_step`, `data_caveat`,
  `postmortem`.
- **Relationship types:** `depends_on` (service → service), `alerts_on` (alert → service),
  `documented_by` (service → dashboard).
- **Cortex `query` pages become access patterns** on the service and alert entities, verified by
  ES|QL. Today they are unverified markdown.
- **`group_by: session_id`:** one investigation is one task, consolidating into the shared graph.

Compare v1 and v2 on the investigation evals and `cortex-v*-eval-results`-style scoring. Switch the
hydrate step to read v2 once it is at parity, then turn off the Cortex optimizer.

**Graphify gaps this exposes:**

- **Loading existing KIs.** Graphify loads *all* of the group's existing entities and facts. In
  the `_shared` group, that is the whole operational wiki, which won't fit in context after a few
  hundred investigations. It needs scoped loading: semantic or BM25 search over existing KIs using
  the task's memories, plus 1-hop `relates_to` expansion.
- **Entity name drift** (the `364710` vs `Member 364710` gap already seen). This gets worse with
  service names. Add an alias/attribute-key match (for example `service.name`) before
  slug-matching.

### Phase 3: bring Nightshift's reinforcement into CE

These are generic features any memory consumer would want:

1. **Maturity separate from lifecycle.** Add `governance.maturity: tentative | established` and
   `corroborations`, promoted when a later session's memories support an existing KI (the model
   cites an existing id with new `source_memory_ids`). Recall can then rank or label by maturity,
   and Nightshift's UI badges map 1:1.
2. **Usage and outcome signals into dreaming.**
   - Record which KIs a session read: `query_ai_indices` results are already signals, and for
     Nightshift, the workspace reads.
   - Let `remember` carry an outcome (`confirmed`, `corrected_by_user`).
   - Graphify gets "KIs read in this session, and the outcome" as extra input, so it can
     corroborate or mark harmful. This is Nightshift's memory critique, generalised.
3. **Seeded-content guard.** Short-term memories record the KI ids recalled in the session.
   Graphify treats restatements of those as corroboration, never as new facts.

### Phase 4: procedures (decision trees) as a CE knowledge kind

Decision trees don't fit the graphify change set, and Nightshift's best results come from a
file-editing agent with guardrails rather than a one-shot structured call. Proposal:

- **A new dreamed kind:** `procedure.<type>` KIs.
  - `content` is the Mermaid (plus learnings).
  - `about` references point to the symptom/alert entity and to the entities the evidence nodes
    query.
  - `attributes.evidence` holds per-node ES|QL. It goes through the same verifiers as access
    patterns, which is a real improvement on `evidence_gatherer_metadata` free text.
- **Pluggable derivation steps.** The dreaming workflow's `foreach` runs `context-engine.graphify`
  and, when configured, more derivation steps that see the same task (memories plus loaded KIs).
  Nightshift registers its reinforcement agent as `nightshift.decisionTreeReinforce`, keeping its
  prompts, scripts and guardrails, and writes through the Phase 0 KI writer. CE owns scheduling,
  cursor, retry, plan persistence and provenance.
- **Generic grouping.** Trees are keyed per symptom, not per session. Add `group_by: attribute:<key>`
  (for example `symptom`) so procedure derivation sees every session that hit the same symptom.
- **Revisions replace `decision_tree_version`.** The existing diff UI reads KI revisions.

### Phase 5: retrieval and viewing

- **Retrieval: `materialize` for sandboxed agents.** Add a CE helper that renders an AI index's KIs
  as a markdown workspace:
  - `INDEX.md` by type
  - one file per entity, with its facts, access patterns and `relates_to` as relative links
  - procedures as Mermaid files

  Scope it by a seed set of entities: the investigation's subjects (service, alert, significant
  event), plus N hops. Nightshift's three hydrate steps become one call. Agents without a sandbox
  keep using `describe_ai_index` / `query_ai_indices`, so it's one store with two access paths.
  This also replaces "hydrate all 500 pages" with relevance-scoped hydration.
- **Allow the KI tools in Nightshift.** Once archived content is filtered by lifecycle (Phase 0),
  drop the "don't use `ki_search`" instruction. Let the investigator query the graph for things
  that weren't hydrated.
- **Viewing.** Nightshift's Knowledge tab already has the right components:
  - Cortex page view and editor
  - memory lineage
  - decision-tree graph (`@xyflow/react` + dagre) with version diff

  Lift them into a shared package that renders CE KIs by kind:
  - entity → wiki page (content, facts about it, relationships, access patterns, history)
  - procedure → tree view

  Nightshift and CE's own UI both mount it. Human edits go through the KI writer, so they get
  revisions and provenance (`user://`).

### Out of scope / keep in Nightshift for now

- **Semantic Memory's bandit ranking.** This is task-recall ranking, not a knowledge graph. Keep it
  Nightshift-side until Phase 3's usage signals exist, then reconsider it as recall ranking over
  `fact.*`.
- **Model choice.** Nightshift uses the round's connector and its own usage id; dreaming uses the
  `context_engine` feature. Decide whether Nightshift's derivation steps should keep their own
  feature id for billing attribution.

## 4. Open questions / things to verify

- Does `setDreamingConfig` accept a **managed** (code-registered) AI index? Nightshift's indices
  are all managed (`ai_indices/service.ts:169`, `:485`).
- How should the space be handled? Nightshift scopes by `_id` prefix and `attributes.space_id`;
  CE adds its own space filter. Migrated documents need CE's space field populated.
- Is graphify's cost acceptable when run per investigation (Phase 1 targeted dreams), compared
  with today's four calls plus an agent run per round?
- Should the LLM see full existing content (our approach) or a catalog (Cortex's)? Ours is more
  correct but is exactly what forces scoped loading in Phase 2.
