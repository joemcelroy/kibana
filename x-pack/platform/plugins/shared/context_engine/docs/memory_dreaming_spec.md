# Context Engine memory: short-term memory and dreaming

Status: draft

## Overview

Memory has two tiers.

- **Short-term memory** is one shared data stream for all AI indices. `_remember` appends raw
  session memories to it. Short-term memories don't belong to any AI index.
- **Long-term memory** is the existing backing index of each AI index (for example
  `ai-index-idx-ops-memory`). It holds the facts, entities, and relationships that dreaming
  produces.

Each AI index with dreaming turned on runs a managed workflow. The workflow pulls every
short-term memory in its space written after that AI index's cursor and turns it into long-term
knowledge. AI indices dream independently of each other: the same short-term memory can be
dreamed by several AI indices, each tracking its own progress.

## Short-term memory data stream

Name: `.contextengine-memory-short-term`. The data stream is hidden and owned by Context Engine.
Users never read or write it directly.

| Field | Type | Notes |
| --- | --- | --- |
| `@timestamp` | date | The server sets it when `_remember` writes. The cursor sorts on it. |
| `id` | keyword | Memory id. Breaks ties in the cursor. |
| `space` | keyword | The space `_remember` was called in. |
| `session_id` | keyword | Required. |
| `user_id` | keyword | Optional. If missing, the memory goes to shared long-term memory. |
| `content` | semantic_text | |
| `attributes` | flattened | |
| `occurred_at` | date | Optional and set by the client. Never used for the cursor. |

Writes:

- `_remember` appends a memory as the internal user, after the existing Context Engine
  write-access checks. Short-term memory is append-only.
- `forget` deletes a memory (see [Forget](#forget)).

The Agent Builder tools `platform.context_engine.remember` and `platform.context_engine.forget`
write through the plugin start contract (`getShortTermMemoryService`, `forgetMemory`):

- `remember` takes `content`, plus `sessionId` for MCP calls (Agent Builder uses the
  conversation id). With `aboutUser: true` it records the caller's profile uid (or username) as
  `user_id`; otherwise the memory is shared. It returns `{ id, sessionId }`.
- `forget` takes the memory `id`. It refuses to forget a memory recorded about another user.

Short-term memory can't be recalled in this version.

## Dreaming config and state

Both live on the AI index document in `.contextengine-ai-indices`:

```ts
dreaming: {
  enabled: boolean,
  schedule,          // interval; defaults to daily
  group_by,          // 'session_id' (default) | 'user_id'
  instructions,
  facts,
  entities,
  relationships,
  state: {
    cursor?: { timestamp: string, memory_id: string },
    retry: Array<{ group_key: string, from: { timestamp: string, memory_id: string } }>, // bounded
    last_run?: { execution_id: string, status: string, completed_at?: string },
  },
}
```

Rules:

- The existing AI index metadata APIs never accept `dreaming.state`. Their schemas reject it.
  `writeDocument` copies the stored `dreaming.state` into every write, so an update built from a
  stale read can't bring back an old cursor. If the update gets a 409 conflict, it re-reads the
  document and retries once.
- The dreaming state API (below) and `forget` are the only writers of `dreaming.state`. Both do a
  partial update with optimistic concurrency.
- **Starting point.** When dreaming is turned on and the AI index has no cursor, the cursor is
  set to `{ timestamp: now, memory_id: '' }`. Dreaming never backfills by default. To backfill,
  move the cursor back explicitly with `reset: true`.

## APIs

### Configure dreaming

`PUT /api/context_engine/ai_index/{aiIndexId}/_dreaming`

Saves the config and reconciles the managed workflow, following the same pattern as
`feedback_analysis/schedule.ts`:

- Turning dreaming on installs the workflow and enables it with the caller's request. Runs then
  execute under an API key created from that request. Every save creates a new key, so the
  schedule always runs as whoever saved it last.
- Turning dreaming off uninstalls the workflow. `dreaming.state` is kept.
- The workflow is not added to the AI index's `automations` list.
- Saving fails if workflows management isn't available.

### Pull short-term memories

`POST /internal/context_engine/ai_index/{aiIndexId}/short_term_memory/_pull`

```ts
// request
{
  after?: { timestamp: string, memory_id: string },
  until: string,
  group_keys?: string[],                 // bounded maxSize
  size: number,                          // bounded, for example max 500
}
// response
{
  memories: ShortTermMemory[],
  next?: { timestamp: string, memory_id: string },
}
```

1. Authorize the caller: they need the Context Engine feature privilege, `memory_enabled` must be
   on, and `has_privileges` must confirm write access to the AI index's backing index.
2. Search as `asInternalUser`, filtered on `space` and on `(@timestamp, id)` being after `after`
   and up to `until`, and on `group_keys` when set. Sort on `@timestamp` then `id`, and page with
   `search_after`.

The workflow steps call the same service function in-process.

### Update dreaming state

`PUT /api/context_engine/ai_index/{aiIndexId}/_dreaming/_state`

```ts
{
  execution_id: string,                  // must match the workflow execution in progress
  cursor: { timestamp: string, memory_id: string },
  retry: Array<{ group_key: string, from: { timestamp: string, memory_id: string } }>, // bounded maxSize
  reset?: boolean,                       // allow moving the cursor backwards
}
```

- The cursor can only move forward unless `reset: true` is set.
- A `reset` request without a run in progress needs the same privileges as saving the dreaming
  config.

### Explicit run

`POST /api/context_engine/ai_index/{aiIndexId}/_dream`

```ts
{ session_id?: string, user_id?: string, dry_run?: boolean }
```

This calls the workflow's `manual` trigger and returns `{ run_id: <execution id> }`. If a run is
already in progress it returns 409, because the workflow's concurrency setting would otherwise
drop the request silently.

## Dreaming workflow

A new managed workflow definition sits next to the feedback analysis one in
`@kbn/workflows/managed/definitions/context_engine`.

```yaml
settings:
  timeout: '45m'
  concurrency:
    key: 'context-engine-dreaming-__AI_INDEX_ID__'
    strategy: drop
    max: 1
triggers:
  - type: scheduled
    with: { every: '__INTERVAL_MINUTES__m' }
  - type: manual
    inputs: { session_id, user_id, dry_run }     # '' means no target
steps:
  - name: plan_run
    type: context-engine.getDreamingTasks
  - name: run_tasks
    type: foreach
    foreach: '${{ steps.plan_run.output.tasks }}'
    iteration-on-failure: { continue: true }
    steps:
      - name: graphify
        type: context-engine.graphify
        on-failure: { retry: { max-attempts: 2, delay: '30s' } }
        with:
          task_id: '{{ foreach.item.task_id }}'
          dry_run: '${{ steps.plan_run.output.dry_run }}'
  - name: commit
    type: context-engine.commitDreamingState     # always runs; on dry_run it only closes the run
  - name: output_result
    type: workflow.output
```

The full definition is `kbn-workflows/managed/definitions/context_engine/dreaming.yaml`
(`system-context-engine-dreaming`).

### Run progress

The run's plan and each task's progress live in the hidden index `.contextengine-dreaming-runs`,
keyed by space, AI index and execution id. Memory content never goes there; tasks hold memory ids,
and a task's saved plan holds the resolved operations. `commit` deletes the run's documents, along
with any older than 7 days.

### Steps

1. **`getDreamingTasks`**
   - Reads the config and state, and sets `until = now - settleLag`.
   - Pulls the memories written after the cursor, plus each `retry` group from its `from`
     position (or only the `_dream` target).
   - Groups them by user and `group_by`, splits groups over 200 memories, and saves the plan in
     run progress. It returns `{ tasks: [{ task_id, group_key, count }], dry_run }`, so workflow
     state holds ids and counts only.
   - Tasks are sorted by user, then by each group's first memory.
   - The run is capped at 2,000 memories. Anything over the cap stays after the cursor, or in
     `retry`, for the next run.
   - Records the execution as `last_run` on the dreaming state. A run already in progress (within
     the 45 minute timeout) makes the step fail.
2. **`graphify`** turns one task's memories into long-term graph changes, entirely inside the
   step:
   - **Load.** Pulls this task's memories, and the user's current long-term facts and entities
     (including any marked stale), with their ids. It reads fresh on every iteration, so each
     task sees what the previous task wrote.
   - **Extract.** Calls the LLM (see [Model](#model)) with the dreaming instructions and the
     configured fact, entity and relationship types. The result is a change set: an existing id overwrites, `null`
     deletes, a new id creates. Irrelevant memories produce an empty change set.
   - **Persist the plan.** Saves the change set in the run-progress document, keyed by execution
     id and task, before writing anything. On a retry, it re-applies a saved plan instead of
     calling the LLM again, so a retry can't create duplicates.
   - **Apply.** Writes the change set with the workflow's scoped client through `ki_write.ts` and
     `ki_revision.ts`. Every KI created or updated gets a `derived_from` reference to the
     short-term memory ids it used, and `observed_in` the session. Provenance is
     `task://dreaming/default`, with `run_id` and `task_id` metadata.
   - **Record.** Marks the task as done in the run-progress document.
   - **Output.** Returns only ids and counts (`created`, `updated`, `deleted`), so memory content
     never enters workflow state. With `dry_run`, it returns the change set and doesn't write.
3. **`commitDreamingState`**
   - Moves the cursor to the last memory the plan read. A targeted run leaves the cursor alone.
   - Every task not recorded as done is written to `retry` at its `from` position. Retry entries
     consumed by the run are removed; entries queued during the run (by forget) are kept.
   - If `retry` is full, the cursor stays where it is and the run reports `partial` with a warning.
   - On a dry run, it only closes `last_run`, so the next run isn't blocked.

### Model

`graphify` uses the model configured for the existing Context Engine inference feature,
`context_engine`, in Model Management. The feature is registered in
`context_engine_agent_builder/server/register_inference_features.ts`. Neither the AI index nor
the dreaming config has its own model setting.

- Before each task, `graphify` resolves the model with
  `searchInferenceEndpoints.endpoints.getForFeature('context_engine', request)`, using the
  workflow's scoped request. It uses the first endpoint returned and calls it through the
  inference plugin's chat completion API.
- Resolution follows the existing chain: the admin override for `context_engine` first, then the
  global default. The feature registers no recommended endpoints and doesn't set
  `ignoreGlobalDefault`.
- If nothing resolves, the task fails with a clear error, and `commit` puts the group in `retry`.
- The model is resolved again for every task, so changing it in Model Management takes effect
  from the next task.
- `context_engine` gains `inference` as a required plugin and `searchInferenceEndpoints` as an
  optional plugin. Without `searchInferenceEndpoints`, turning dreaming on fails.

### Change set

The LLM only describes knowledge. `graphify` assigns the final ids, type prefixes, references
and provenance, and validates everything before it saves the plan.

#### What `graphify` sends the model

- The dreaming instructions, and the configured fact types, entity types (with their attribute
  keys) and relationship types (with their source and target entity types).
- The task's short-term memories, each with its id.
- The user's existing entities and facts, each with its id, type, current fields, and a `stale`
  flag.
- Rules that facts stand alone, naming the entities they are about and keeping exact values,
  because recall reads facts without their entities. The model should also link entities with
  the configured relationship types whenever the memories support it.

#### What the model returns

The model returns a structured output schema. The change set uses arrays rather than maps keyed
by id, because structured output modes handle arbitrary object keys and `null` poorly. The
semantics are the ones from the architecture doc: an existing id overwrites, `delete: true`
deletes, a new id creates. On an update, any field left out keeps its current value.

```ts
interface DreamingChangeSet {
  entities: Array<{
    ref: string;                 // an existing entity id, or a new key like "new:1"
    delete?: boolean;            // true deletes an existing entity
    type?: string;               // a configured entity type, without the "entity." prefix
    name?: string;
    description?: string;
    attributes?: Array<{ key: string; value: string }>; // configured keys only
    source_memory_ids?: string[]; // short-term memory ids; required unless deleting
  }>;
  facts: Array<{
    ref: string;                 // an existing fact id, or a new key like "new:1"
    delete?: boolean;            // true deletes an existing fact
    type?: string;               // a configured fact type, without the "fact." prefix
    title?: string;
    content?: string;
    about?: string[];            // entity refs, existing or new; replaces the current list
    source_memory_ids?: string[]; // short-term memory ids; required unless deleting
  }>;
  relationships: Array<{
    type: string;                // a configured relationship type
    source: string;              // entity ref
    target: string;              // entity ref
    remove?: boolean;            // true removes an existing relationship
    source_memory_ids?: string[]; // short-term memory ids
  }>;
}
```

Anything the model leaves out stays unchanged. An empty change set is valid.

#### Validation

`graphify` checks each item on its own. An invalid item is dropped and counted in the step's
`rejected` output, and the rest of the change set still applies.

- Types must be configured. With no dreaming config, the defaults apply: one generic fact type
  `fact`, and any entity type.
- An entity attribute key must be configured for that entity type.
- A relationship's source and target must resolve to entities of the configured source and
  target types.
- Every `ref` must be either an id loaded for this task or a new key defined in this change set.
  A delete is only valid for an id that was loaded.
- Every `source_memory_ids` entry must be one of this task's short-term memory ids or an existing
  source of the KI. Upserts must list at least one.
- Each list is capped at 200 items. Field lengths reuse the existing KI limits
  (`MAX_KI_TITLE_LENGTH`, `MAX_KI_CONTENT_LENGTH` and so on).

#### What `graphify` writes

Every write goes into the AI index's backing index, through `ki_write.ts` and `ki_revision.ts`.

**Entity:**
- **id:** `<user>/entity-<type>-<slug(name)>`. Because the id is deterministic, a new entity whose
  name matches an existing one resolves to it, so the model doesn't have to match names itself.
- **type:** `entity.<type>`.
- **title:** `name`. **description:** `description`.
- **attributes:** `memory.user_id`, plus each configured attribute under `entity.<key>`.

**Fact:**
- **id:** `<user>/fact-<hash(execution_id, task_id, ref)>`. The hash is computed once, when the
  plan is saved, so a retry writes the same id.
- **type:** `fact.<type>`.
- **title**, **content**, and **attributes:** `memory.user_id`.

`fact.*` and `entity.*` are the dreamed KI types. Like the session memory types, both are left
out of ordinary KI retrieval and type counts, and are recalled through the memory queries that
`describe_ai_index` shows. That a KI came from dreaming is recorded by its `derived_from`
references, not by its type.

**References**, added on top of whatever the KI already has:

| Reference | `uri` | `relation` |
| --- | --- | --- |
| Source memory | `memory://<short-term memory id>` | `derived_from` |
| Session | `session://<session_id>` | `observed_in` |
| Fact about an entity | `ki://<entity id>` | `about` |
| Configured relationship, stored on the source entity | `ki://<target entity id>` | `relates_to`, with `type: <relationship type>` |

`derived_from` references accumulate across runs, so forget can find every KI that used a
memory. `remove: true` deletes the matching relationship reference from the source entity.

**Deletes** use the existing soft delete (`softDeleteKi`). Deleting an entity doesn't change
other KIs that reference it, because recall already filters out deleted KIs.

**Memories without a `user_id`** use `_shared` in place of `<user>` in ids, and have no
`memory.user_id` attribute.

#### Stale KIs after a forget

Before calling the model, `graphify` does the following with stale KIs:

1. Removes the `derived_from` reference to the forgotten memory.
2. Soft-deletes any KI left with no `derived_from` references, without involving the model.
3. Sends the rest to the model with `stale: true`.

After the change set is applied, any stale KI the model didn't touch is made `active` again and
is kept as it is. A KI the model rewrites becomes `active`; a relationship change alone leaves its
source entity's status as it was.

#### Changes to the KI schema

- Add a `stale` value to `governance.lifecycle.status` (`active | stale | deleted`). The lifecycle
  filter Context Engine adds to every ES|QL query on a registered AI index keeps only `active`
  (or missing) statuses, so recall leaves out stale KIs without any extra filter. A flattened
  `attributes` flag wouldn't work, because ES|QL can't filter on flattened subfields.
- Add `about` and `observed_in` to `KI_REFERENCE_RELATIONS`.
- Add an optional bounded keyword `type` to `kiReferenceSchema`, for configured relationship
  types.

#### Changes to the `ai-index@mappings` template (Elasticsearch)

The AI index backing mappings come from the `ai-index@mappings` component template, which is
defined in the Elasticsearch codebase, not in Kibana. Dreaming needs these from it:

- **`references.type`:** a new `keyword` field. Without it, configured relationship types are
  stored in `_source` but can't be searched or filtered.
- **`references.relation`:** must stay a plain `keyword`, so the new `about` and `observed_in`
  values index without a mapping change.
- **`governance.lifecycle.status`:** already a `keyword`, so `stale` needs no mapping change.

The Elasticsearch change ships separately. Until it lands, dreaming still works; only queries on
`references.type` don't.

#### Telemetry

The `context_engine` usage collector counts stale KIs as their own lifecycle bucket,
`kis.<user|managed>.stale.<total|max|min|avg>`, next to `active`, `expired` and `deleted`. A KI
that is stale and past its `expires_at` counts as stale.

### Ordering and late writes

- Tasks run one at a time. Two runs can't overlap because of the workflow's concurrency key.
- A memory that becomes searchable after `until` is still after the cursor, so the next run
  picks it up.
- Changing the config affects the next run. Memories that were already dreamed aren't processed
  again unless the cursor is reset.

## Forget

1. Delete the short-term memory.
2. Find long-term KIs whose `derived_from` includes that memory id, across the space's AI indices
   that have dreaming turned on.
3. Set those KIs' lifecycle status to `stale`. Recall leaves out stale KIs.
4. Add the group to `retry` on every AI index that held one of those KIs, with `from` set to just
   before the forgotten memory.

On the next run, that group's task gets the stale KIs and their remaining sources. It then
rewrites or deletes each one. A KI whose only source was the forgotten memory is deleted without
calling the model.

## Accepted trade-offs

- **Execution history.** `graphify` keeps memory content out of workflow state, except for
  `dry_run` output. A change set returned by a dry run stays in the execution history after a
  forget, until that history expires.
- **Visibility.** Anyone who sets up dreaming on an AI index can read every short-term memory in
  the space through that dreaming process.
- **Cost.** LLM cost grows with the number of AI indices that dream times the short-term memory
  volume. Each run is bounded by the per-run memory cap.
- **Dependency.** Dreaming requires workflows management.

## Defaults

These started as open questions; the implementation picks these values, and they can be tuned:

- `settleLag` is 30 seconds. A run reads at most 2,000 memories, and a task at most 200.
- `retry` holds at most 100 entries. When two entries share a group key, the earliest `from` wins.
- A change set list holds at most 200 items.
- Entity name slugs are NFKD-normalized, stripped of accents, lowercased, with runs of other
  characters turned into `-`, and capped at 96 characters (a hash is used if nothing is left).
- Run-progress documents are deleted on commit, and any left over are removed after 7 days.

## Testing

Unit tests cover each piece (`plan_run`, `graphify`, `apply`, `state`, `resolve_change_set`, the
routes and the agent tools). The end-to-end happy path is tested with a customer support agent
that answers questions about an airline loyalty program, remembers what it learns, and has two AI
indices dream over the same short-term memories with different configs.

### Setup

- Kibana with Context Engine, `contextEngine:memoryEnabled` and workflows enabled.
- An LLM connector as the default AI connector, so the `context_engine` feature resolves to it.
- The airline loyalty data set from orca, seeded with `.tmp/airline/seed.py`:
  `customer_loyalty_history` (one document per member) and `customer_flight_activity` (one
  document per member and month).
- Two AI indices, both with `memory_enabled: true`, each with a different dreaming config:

| AI index | Remembers | `group_by` | Topology |
|---|---|---|---|
| `support-customers` | Individual members: who they are, what they prefer, their open issues, and what support promised them. Ignores program-wide statistics. | `session_id` | A star per member. The `member` entity (`loyalty_number`, `loyalty_card`, `province`, `city`) is linked by `opened` to `support_case` entities. Facts: `preference`, `issue`, `commitment`. |
| `support-insights` | Program-wide knowledge: computed statistics, how to compute them, and data caveats. Ignores anything about one member. | `user_id` | A small graph of program concepts. `loyalty_tier`, `metric` and `region` entities, with `ranks_above` (tier to tier) and `measured_by` (tier to metric) relationships. Facts: `statistic`, `method`, `data_caveat`. |

`support-customers` dreams per conversation, because one session is one customer contact.
`support-insights` dreams by user. Its memories have no `user_id`, so they form one `_shared` group
and are consolidated across sessions.

### Harness

The harness lives in orca at `harnesses/memory_dreaming` and runs with
`uv run python run.py [all|setup|remember|dream|recall]`.
A LangChain deep agent (`deepagents`) plays the support agent. It reaches Kibana through the Agent
Builder MCP server (`/api/agent_builder/mcp?namespace=platform.context_engine,platform.core`) and
uses:

- `platform.core.execute_esql` to compute answers over the airline data,
- `platform.context_engine.query_ai_indices` and `describe_ai_index` to recall long-term memory
  from the two AI indices. The describe output shows how to find an entity and list the facts
  `about` it (`MV_CONTAINS(references.uri, "ki://<entity id>")`), so a member's facts are not
  mixed with another member's,
- `platform.context_engine.remember` to record what it learned. The harness passes the
  `sessionId` returned by the first call in a conversation to the later calls, so each
  conversation is one session.

Each conversation is a member asking one question from the orca `airline_loyalty_qa` golden set,
with personal details (loyalty number, card, city, a preference or complaint) taken from that
member's record.

### Flow and checks

1. **Remember.** Run the conversations. Check that every `remember` call returned an id and that
   each id is in `.contextengine-memory-short-term` with the conversation's `session_id`.
2. **Dream.** `PUT _dreaming` on both AI indices, then `POST _dream` on each, and poll the workflow
   execution until it finishes. Check that:
   - the execution succeeded and `state.cursor` moved to the last memory, with `retry` empty;
   - `support-customers` holds `entity.member` entities and `fact.preference` or `fact.issue`
     facts, and no `fact.statistic` facts;
   - `support-insights` holds `entity.loyalty_tier` entities and `fact.statistic`
     facts, and no `entity.member` entities;
   - every long-term KI has a `derived_from` reference to a short-term memory and an
     `observed_in` reference to its session, and facts have `about` references to an entity;
   - a second `POST _dream` with no new memories writes nothing.
3. **Recall.** Ask the same questions in new conversations, without access to `execute_esql`.
   Score the answers against `expected_output` with an LLM judge. Answers recalled from
   `support-insights` should match the answers first computed from the data, and a returning
   member should be recognized from `support-customers`.

## Open questions

- The Elasticsearch change to `ai-index@mappings` described in
  [Changes to the `ai-index@mappings` template](#changes-to-the-ai-indexmappings-template-elasticsearch).
