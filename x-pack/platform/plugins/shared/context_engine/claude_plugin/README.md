# Context Engine plugin for Claude Code

Gives Claude Code the same Context Engine memory an Agent Builder agent has:

- **Session start** (`SessionStart` hook): lists the AI indices the user can read (`GET /api/context_engine/ai_index`, plus each per-user AI index's dreaming settings) and adds them to Claude's context, with how to search them. It is the counterpart of Agent Builder's `AI INDICES` prompt section.
- **Recall and remember** (the `context-engine` MCP server): `recall` and `remember` call `POST /api/context_engine/_recall` and `_remember`. `describe_ai_index` and `list_ai_indices` help write ES|QL for `recall`.
- **After each round** (`Stop` hook, async): renders the round that just ended and saves it with `POST /api/context_engine/_save_transcript`, the way Agent Builder's round capture does after each round (`context_engine_agent_builder/server/round_capture`). Like it, the hook:
  - saves only for AI indices that keep each user's memory apart and have dreaming on with `rounds`;
  - skips the round when the user turned off "Learn from my conversations";
  - saves each round once, as `round-<prompt uuid>`, so a repeated save is a no-op (409).

  `scripts/lib/render_round.mjs` is a port of `render_round.ts`: keep the two in step. Each round's outcome (status only, never content) is appended to `rounds.log` in the plugin's data directory.

The session's `session_id` is the Claude Code session id, for both `remember` and saved rounds, so they dream together.

## Install

Needs Node.js 18 or later, and Kibana with Context Engine memory turned on.

From a Claude Code session:

```
/plugin marketplace add ./x-pack/platform/plugins/shared/context_engine/claude_plugin
/plugin install context-engine@elastic-context-engine
```

Installing asks for:

| Setting | |
| --- | --- |
| Kibana URL | Base URL of Kibana. |
| API key | The encoded Elasticsearch API key of the user whose memory this is. Stored in the system keychain. |
| Space | Kibana space id; empty for the default space. |
| AI indices | Comma-separated AI index ids to use, like an agent's AI index list; empty for every AI index the user can read. |

`/plugin configure context-engine@elastic-context-engine` changes them later.

For development, load the plugin without installing it and set the settings as environment variables instead (`KIBANA_URL`, `KIBANA_API_KEY`, `KIBANA_SPACE_ID`, `CONTEXT_ENGINE_AI_INDEX_IDS`):

```
claude --plugin-dir ./x-pack/platform/plugins/shared/context_engine/claude_plugin
```

## The API key

Rounds and memories about the user are recorded as the API key's user, so use a key for the person running Claude Code. It needs the Context Engine `read` privilege to recall and save rounds, and `write` to remember. Saving a round also needs the privilege to dream for each AI index it goes to.
