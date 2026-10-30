/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { cleanPrompt } from '@kbn/agent-builder-genai-utils/prompts';
import { kiRetrievalSkillId } from '@kbn/agent-builder-common';
import { contextEngineRecallTools } from '@kbn/agent-builder-common/tools';
import type { UserMemoryEntry } from '@kbn/agent-builder-server';
import type { AiIndexCatalogEntry } from '../../types';

/** At most this many things about the user go into the prompt, newest first. */
export const MAX_USER_MEMORY_ENTRIES = 50;
/** Longer contents are cut, so one entry cannot crowd out the rest. */
export const MAX_USER_MEMORY_CONTENT_LENGTH = 300;

const getMemoryInstructions = (catalog: AiIndexCatalogEntry[]): string => {
  const memoryEntries = catalog.filter(({ memoryEnabled }) => memoryEnabled);
  if (memoryEntries.length === 0) {
    return '';
  }
  const where = memoryEntries.some(({ hidden }) => !hidden)
    ? ' Memories go to the AI Indices above that take memories, and are turned into KIs there later.'
    : '';
  const aboutUser = memoryEntries.some(({ hidden }) => hidden)
    ? ' Set `aboutUser` when the memory is about the user: it becomes part of what you know about them in later conversations.'
    : ' Set `aboutUser` when the memory is about the user.';
  return `When you learn something a later conversation would need, such as what the user is working on, how they like things done, or what worked, record it with \`remember\`.${where}${aboutUser}`;
};

/**
 * Builds the AI INDICES prompt section from the resolved catalog. Empty when disabled or when
 * the catalog has no entries. Hidden entries, such as `user-memories`, are not listed: an agent
 * gets what they know in the ABOUT THE USER section, and only remembers into them.
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

  const memorySection = getMemoryInstructions(catalog);
  const visible = catalog.filter(({ hidden }) => !hidden);
  if (visible.length === 0) {
    return memorySection ? cleanPrompt(`## MEMORY\n\n${memorySection}`) : '';
  }

  // Unresolved entries are omitted: the id is not a valid `FROM` target.
  const entries = visible
    .filter(({ esqlTarget }) => esqlTarget !== undefined)
    .map(
      ({ id, esqlTarget, description, memoryEnabled }) =>
        `- Registry ID: \`${id}\`; ES|QL target: ${esqlTarget}${
          memoryEnabled ? '; takes memories' : ''
        }${description ? ` — ${description}` : ''}`
    );
  const catalogSection =
    entries.length > 0 ? `Available to this agent:\n\n${entries.join('\n')}` : '';

  return cleanPrompt(`
## AI INDICES

An AI Index stores Knowledge Indicators (KIs): context prepared for agents, such as data descriptions, summaries, access patterns, queries, or records of Kibana resources. A KI may answer a question directly or help locate and use another source. AI Indices are Elasticsearch indices named \`ai-index-idx-*\`, or data streams named \`ai-index-ds-*\`.

Search relevant AI Indices before broader retrieval when their KIs may help. If they do not cover the question, continue with other relevant data or tools.

To look something up, start with \`${contextEngineRecallTools.recall}\`: it searches the AI Indices below by meaning and by words, including what was remembered. Set \`aiIndexIds\` to narrow it, or \`scope: 'short-term'\` to search recently remembered memories that are not dreamed yet.

${catalogSection}

${memorySection}

For counts, filters, exact lookups or following a KI's references, recall also takes an ES|QL query in place of plain words. Load the \`${kiRetrievalSkillId}\` skill first: it carries the AI Index list and describe tools and the guidance for writing those queries.

Query everything else, including a source a KI points you to, with your other data tools, such as \`generate_esql\` and \`execute_esql\`, as you would without AI Indices.

This conversation runs in the space \`${spaceId}\`.
`);
};

const truncate = (text: string): string =>
  text.length > MAX_USER_MEMORY_CONTENT_LENGTH
    ? `${text.slice(0, MAX_USER_MEMORY_CONTENT_LENGTH)}…`
    : text;

const formatUserMemoryEntry = ({
  type,
  title,
  content,
  updated_at: updatedAt,
}: UserMemoryEntry) => {
  const text = [title, content && content !== title ? content : undefined]
    .filter((part): part is string => Boolean(part))
    .join(': ');
  const date = updatedAt ? `, ${updatedAt.slice(0, 10)}` : '';
  return `- ${truncate(text.replace(/\s+/g, ' ').trim())} (${type}${date})`;
};

/**
 * Builds the ABOUT THE USER prompt section: what earlier conversations taught agents about the
 * user, so the agent has it without recalling it. Empty when disabled or when there is nothing.
 */
export const getUserMemoryInstructions = ({
  enabled,
  userMemory,
}: {
  enabled: boolean;
  userMemory: UserMemoryEntry[];
}): string => {
  const entries = userMemory
    .filter(({ title, content }) => Boolean(title || content))
    .slice(0, MAX_USER_MEMORY_ENTRIES);
  if (!enabled || entries.length === 0) {
    return '';
  }
  return cleanPrompt(`
## ABOUT THE USER

What earlier conversations taught you about the user you are talking to, newest first. Use it to tailor your answers without reciting it. It can be out of date: what the user says now wins.

${entries.map(formatUserMemoryEntry).join('\n')}
`);
};
