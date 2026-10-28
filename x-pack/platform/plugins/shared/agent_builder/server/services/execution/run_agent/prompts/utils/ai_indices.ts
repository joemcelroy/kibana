/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { cleanPrompt } from '@kbn/agent-builder-genai-utils/prompts';
import { kiRetrievalSkillId } from '@kbn/agent-builder-common';
import { contextEngineRecallTools } from '@kbn/agent-builder-common/tools';
import type { AiIndexCatalogEntry } from '../../types';

/**
 * Builds the AI INDICES prompt section from the resolved catalog. Empty when disabled or when
 * the catalog has no entries.
 */
export const getAiIndicesInstructions = ({
  enabled,
  catalog,
  spaceId,
}: {
  enabled: boolean;
  catalog: AiIndexCatalogEntry[];
  spaceId: string;
}): string => {
  if (!enabled || catalog.length === 0) {
    return '';
  }

  // Unresolved entries are omitted: the id is not a valid `FROM` target.
  const entries = catalog
    .filter(({ esqlTarget }) => esqlTarget !== undefined)
    .map(
      ({ id, esqlTarget, description, memoryEnabled }) =>
        `- Registry ID: \`${id}\`; ES|QL target: ${esqlTarget}${
          memoryEnabled ? '; takes memories' : ''
        }${description ? ` — ${description}` : ''}`
    );
  const catalogSection =
    entries.length > 0 ? `Available to this agent:\n\n${entries.join('\n')}` : '';
  const memorySection = catalog.some(({ memoryEnabled }) => memoryEnabled)
    ? 'When you learn something a later conversation would need, such as what the user is working on, how they like things done, or what worked, record it with `remember`. Memories go to the AI Indices above that take memories, and are turned into KIs there later; set `aboutUser` when the memory is about the user.'
    : '';

  return cleanPrompt(`
## AI INDICES

An AI Index stores Knowledge Indicators (KIs): context prepared for agents, such as data descriptions, summaries, access patterns, queries, or records of Kibana resources. A KI may answer a question directly or help locate and use another source. AI Indices are Elasticsearch indices named \`ai-index-idx-*\`, or data streams named \`ai-index-ds-*\`.

Search relevant AI Indices before broader retrieval when their KIs may help. If they do not cover the question, continue with other relevant data or tools.

To look something up, start with \`${contextEngineRecallTools.recall}\`: it searches the AI Indices below by meaning and by words, including what was remembered. Set \`aiIndexIds\` to narrow it, such as \`user-memories\` for what you know about the user, or \`scope: 'short-term'\` to search recently remembered memories that are not dreamed yet.

${catalogSection}

${memorySection}

For counts, filters, exact lookups or following a KI's references, recall also takes an ES|QL query in place of plain words. Load the \`${kiRetrievalSkillId}\` skill first: it carries the AI Index list and describe tools and the guidance for writing those queries.

Query everything else, including a source a KI points you to, with your other data tools, such as \`generate_esql\` and \`execute_esql\`, as you would without AI Indices.

This conversation runs in the space \`${spaceId}\`.
`);
};
