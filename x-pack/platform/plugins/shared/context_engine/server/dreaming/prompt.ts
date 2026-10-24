/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  ENTITY_TYPE_PREFIX,
  FACT_TYPE_PREFIX,
  type AiIndexDreamingConfig,
  type ShortTermMemory,
} from '../../common/dreaming';
import { memoryIdFromUri } from './ids';
import { ENTITY_ATTRIBUTE_PREFIX, isStale, type DreamedKi } from './long_term';

/** Longest memory content shown to the model; the rest is cut. */
const MAX_PROMPT_MEMORY_LENGTH = 4000;
const MAX_PROMPT_KI_CONTENT_LENGTH = 2000;

const truncate = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max)}…` : value;

const describeVocabulary = (config: AiIndexDreamingConfig): string => {
  const facts =
    config.facts && config.facts.length > 0
      ? config.facts
      : [{ type: 'fact', description: 'Any durable fact worth remembering.' }];
  const lines = [
    'FACT TYPES:',
    ...facts.map(({ type, description }) => `- ${type}${description ? `: ${description}` : ''}`),
  ];
  if (config.entities && config.entities.length > 0) {
    lines.push(
      'ENTITY TYPES:',
      ...config.entities.map(
        ({ type, description, attributes }) =>
          `- ${type}${description ? `: ${description}` : ''}${
            attributes && attributes.length > 0 ? ` (attributes: ${attributes.join(', ')})` : ''
          }`
      )
    );
  } else {
    lines.push(
      'ENTITY TYPES: any, named in lowercase snake_case (for example person, service). No attributes.'
    );
  }
  lines.push(
    'RELATIONSHIP TYPES:',
    ...(config.relationships && config.relationships.length > 0
      ? config.relationships.map(
          ({ type, source, target, description }) =>
            `- ${type}: ${source} -> ${target}${description ? ` (${description})` : ''}`
        )
      : ['(none; return no relationships)'])
  );
  return lines.join('\n');
};

export const buildSystemPrompt = (config: AiIndexDreamingConfig): string =>
  [
    'You consolidate short-term memories into long-term memory: entities, facts about them, and relationships between entities.',
    'You are given MEMORIES (new, raw notes from conversations) and EXISTING long-term entities and facts.',
    'Return only changes. Update an existing item by repeating its id as ref with the new values; create one with a new key like "new:1"; delete one with delete: true.',
    'Merge rather than duplicate: if a memory restates or refines an existing fact, update that fact.',
    'Facts are read without their entities, so write each one to stand alone: name the entities it is about in its title and content, and keep every number exactly as stated.',
    'Add a relationship of a configured type whenever the memories support it, so related entities are linked.',
    'Every created or updated item must list the MEMORIES it is based on in source_memory_ids.',
    'An item marked stale lost one of its sources. Rewrite it from its remaining sources, delete it if they no longer support it, or leave it out to keep it unchanged.',
    'Ignore memories that hold nothing worth remembering. An empty change set is a valid answer.',
    describeVocabulary(config),
    ...(config.instructions ? ['INSTRUCTIONS:', config.instructions] : []),
  ].join('\n\n');

const promptKi = (ki: DreamedKi) => {
  const isEntity = ki.type.startsWith(ENTITY_TYPE_PREFIX);
  const references = ki.references ?? [];
  return {
    id: ki.id,
    kind: isEntity ? 'entity' : 'fact',
    type: ki.type.slice((isEntity ? ENTITY_TYPE_PREFIX : FACT_TYPE_PREFIX).length),
    [isEntity ? 'name' : 'title']: ki.title,
    ...(ki.description && { description: ki.description }),
    ...(ki.content && { content: truncate(ki.content, MAX_PROMPT_KI_CONTENT_LENGTH) }),
    ...(isEntity && {
      attributes: Object.fromEntries(
        Object.entries(ki.attributes ?? {}).flatMap(([key, value]) =>
          key.startsWith(ENTITY_ATTRIBUTE_PREFIX)
            ? [[key.slice(ENTITY_ATTRIBUTE_PREFIX.length), value]]
            : []
        )
      ),
      relationships: references
        .filter(({ relation }) => relation === 'relates_to')
        .map(({ type, uri }) => ({ type, target: uri.replace(/^ki:\/\//, '') })),
    }),
    ...(!isEntity && {
      about: references
        .filter(({ relation }) => relation === 'about')
        .map(({ uri }) => uri.replace(/^ki:\/\//, '')),
    }),
    source_memory_ids: references.flatMap(({ uri, relation }) => {
      const id = relation === 'derived_from' ? memoryIdFromUri(uri) : undefined;
      return id !== undefined ? [id] : [];
    }),
    ...(isStale(ki) && { stale: true }),
  };
};

const promptMemory = (memory: ShortTermMemory) => ({
  id: memory.id,
  session_id: memory.session_id,
  recorded_at: memory.occurred_at ?? memory['@timestamp'],
  content: truncate(memory.content, MAX_PROMPT_MEMORY_LENGTH),
});

export const buildInput = ({
  memories,
  staleSources,
  existing,
}: {
  memories: readonly ShortTermMemory[];
  /** Remaining sources of stale items, shown so the model can rewrite them. */
  staleSources: readonly ShortTermMemory[];
  existing: readonly DreamedKi[];
}): string =>
  [
    `MEMORIES:\n${JSON.stringify(memories.map(promptMemory), null, 1)}`,
    ...(staleSources.length > 0
      ? [
          `SOURCES OF STALE ITEMS (already remembered; cite them only for stale items):\n${JSON.stringify(
            staleSources.map(promptMemory),
            null,
            1
          )}`,
        ]
      : []),
    `EXISTING:\n${JSON.stringify(existing.map(promptKi), null, 1)}`,
  ].join('\n\n');
