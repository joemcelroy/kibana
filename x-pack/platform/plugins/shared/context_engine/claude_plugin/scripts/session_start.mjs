#!/usr/bin/env node
/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// SessionStart: lists the AI indices the user can read and tells Claude how to search them, the
// way Agent Builder's AI INDICES prompt section does for an agent.

import { learnsFromConversations, listCatalog, roundTargetsOf } from './lib/ai_indices.mjs';
import { createKibanaClient, isConfigured, readConfig } from './lib/kibana.mjs';
import { readStdinJson, writeSessionState } from './lib/session_state.mjs';

const emit = (output) => process.stdout.write(JSON.stringify(output));

const describeEntry = ({ id, esqlTarget, description, memoryEnabled, memoryScope, takesRounds }) =>
  [
    `- \`${id}\``,
    esqlTarget && `; ES|QL target: \`${esqlTarget}\``,
    memoryEnabled &&
      `; takes memories (${memoryScope === 'user' ? "each user's apart" : 'shared'})`,
    takesRounds && '; learns from this session',
    description && ` — ${description}`,
  ]
    .filter(Boolean)
    .join('');

const instructionsFor = ({ config, sessionId, catalog, targets, learns }) => {
  const space = config.spaceId || 'default';
  const memorySection = catalog.some(({ memoryEnabled }) => memoryEnabled)
    ? [
        '',
        'When you learn something a later session would need, such as what the user is working on, how they like things done, or what worked, record it with `remember`. Memories go to the AI indices above that take memories, and dreaming turns them into KIs there later. Set `about_user` when the memory is about the user, and `ai_index_ids` to pick AI indices.',
        `Pass \`session_id: "${sessionId}"\` to \`remember\`, so this session's memories and transcripts dream together.`,
      ]
    : [];
  const targetList = targets.map((id) => `\`${id}\``).join(', ');
  let roundsSection = [];
  if (targets.length > 0) {
    roundsSection = learns
      ? [
          '',
          `Each round of this session is saved as a transcript for ${targetList} to dream into long-term memory. Transcripts are never searched directly.`,
        ]
      : [
          '',
          'The user turned off learning from conversations, so rounds of this session are not saved.',
        ];
  }

  return [
    '## Context Engine',
    '',
    `Context Engine on ${config.url} (space \`${space}\`) is available through the \`context-engine\` MCP server. An AI index stores Knowledge Indicators (KIs): context prepared for agents, such as data descriptions, summaries, access patterns, queries, records of Kibana resources, and long-term memory dreamed from what was remembered.`,
    '',
    'AI indices the user can read:',
    '',
    ...catalog.map(describeEntry),
    '',
    'Search them before broader retrieval when their KIs may help:',
    '- `recall` with plain words (a question, or the names involved) runs a search by meaning and by words over the AI indices, best matches first, each with the AI index it came from. Set `ai_index_ids` to narrow it.',
    '- `recall` with `scope: "short-term"` searches memories remembered recently that dreaming has not turned into KIs yet: shared ones and ones about the user. Plain words only.',
    "- `recall` also takes an ES|QL query starting with `FROM <ES|QL target>` for counts, filters, exact lookups or following a KI's references. Call `describe_ai_index` first for its fields, KI types and example queries. The server adds the space filter and a row limit.",
    '- `list_ai_indices` lists the AI indices again if this list is out of date.',
    ...memorySection,
    ...roundsSection,
  ].join('\n');
};

const main = async () => {
  const input = await readStdinJson();
  const config = readConfig();
  if (!isConfigured(config)) {
    emit({
      systemMessage:
        'Context Engine: set the Kibana URL and API key in the plugin configuration (/plugin) to enable memory.',
    });
    return;
  }
  const client = createKibanaClient(config);
  try {
    const [catalog, learns] = await Promise.all([
      listCatalog(client, { aiIndexIds: config.aiIndexIds }),
      learnsFromConversations(client),
    ]);
    const targets = roundTargetsOf(catalog);
    if (input.session_id) {
      await writeSessionState(input.session_id, { targets, learns });
    }
    if (catalog.length === 0) {
      return;
    }
    emit({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: instructionsFor({
          config,
          sessionId: input.session_id,
          catalog,
          targets,
          learns,
        }),
      },
    });
  } catch (error) {
    emit({ systemMessage: `Context Engine is unavailable: ${error.message}` });
  }
};

await main();
