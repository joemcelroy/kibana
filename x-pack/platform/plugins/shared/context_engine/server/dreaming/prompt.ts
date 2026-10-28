/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  ENTITY_TYPE_PREFIX,
  FACT_TYPE_PREFIX,
  MAX_DREAMING_PROMPT_CONTENT_LENGTH,
  MAX_DREAMING_PROMPT_TRANSCRIPT_LENGTH,
  type AiIndexDreamingConfig,
  type DreamingMemory,
} from '../../common/dreaming';
import { accessPatternsOf, baseContent } from './access_patterns';
import { memoryIdFromUri } from './ids';
import { ENTITY_ATTRIBUTE_PREFIX, isStale, type DreamedKi } from './long_term';

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

const ACCESS_PATTERN_RULES = [
  'Give an entity or fact access_patterns when the MEMORIES show how to query the raw data about it: up to 5 distinct questions a later agent could answer from that data. Build them only from indices, fields, values and queries that appear in the MEMORIES; return none rather than invent an index or field. Each has:',
  '- question_type: a short label for the kind of question.',
  "- esql_template: the query with named ?param placeholders, without quotes, where the filters go. Scope an entity's queries to it, for example WHERE customer_id == ?customer.",
  '- esql_example: the same query with real values from the MEMORIES in place of the placeholders.',
  '- returns: a short description of what the query returns.',
  'esql_example is run to verify it, and a pattern that fails is dropped, so it must be valid and runnable:',
  '- Start with FROM <index>; use | between commands; use field names exactly as the MEMORIES give them, with backticks around names with spaces.',
  '- Quote string literals with double quotes; do not quote numbers or booleans. Write dates in ISO 8601.',
  '- Boolean fields take COUNT(*) WHERE field == true, never SUM()/AVG()/MIN()/MAX(). Only use AVG()/SUM() on numeric fields.',
  '- Keep it cheap: end it with a small | LIMIT n (n <= 20).',
  "An item's existing access_patterns are shown with it. Return access_patterns only to change them; the list you return replaces them.",
].join('\n');

const SESSION_RULES = [
  'SESSIONS lists each conversation session the MEMORIES come from, with its existing session document if it has one. Return one sessions entry per session in SESSIONS:',
  '- title: a short label for what the session was about.',
  '- summary: a few sentences on what happened, starting with the session date (YYYY-MM-DD) from recorded_at: what was asked or worked on, what was decided, and what was learned. Fold the new memories into the existing summary; keep what it already says unless a memory corrects it.',
  'A session document marked stale lost one of its memories: rewrite it from the memories that remain. Do not mention what the lost memory said.',
].join('\n');

export const buildSystemPrompt = (config: AiIndexDreamingConfig): string =>
  [
    'You consolidate short-term memories into long-term memory: entities, facts about them, and relationships between entities.',
    'You are given MEMORIES (new, raw notes from conversations) and EXISTING long-term entities and facts.',
    'A memory has content or a transcript. content is a note an agent chose to remember.',
    "A transcript records one conversation round as it happened: the user's message, the agent's notes, its tool calls with excerpts of their results, and its answer. Take from it only what it states or shows. Record what the user says about themselves and what a tool result shows. The agent's notes and answer can be wrong: do not record a fact only they support.",
    'Return only changes. Update an existing item by repeating its id as ref with the new values; create one with a new key like "new:1"; delete one with delete: true.',
    'Merge rather than duplicate: if a memory restates or refines an existing fact, update that fact.',
    'Facts are read without their entities, so write each one to stand alone: name the entities it is about in its title and content, and keep every number exactly as stated.',
    'List every entity a fact is about in its about field, creating an entity of a configured type if none exists yet.',
    'Add a relationship of a configured type whenever the memories support it, so related entities are linked.',
    'Give every entity a content summary of what is known about it: its attribute values and the main facts about it. When you create, update or delete a fact about an entity, update that entity and rewrite its content to match.',
    ACCESS_PATTERN_RULES,
    'Every created or updated item must list the MEMORIES it is based on in source_memory_ids.',
    'An item marked stale lost one of its sources. Rewrite it from its remaining sources, delete it if they no longer support it, or leave it out to keep it unchanged.',
    'Ignore memories that hold nothing worth remembering. An empty change set is a valid answer.',
    ...(config.sessions ? [SESSION_RULES] : []),
    describeVocabulary(config),
    ...(config.instructions ? ['INSTRUCTIONS:', config.instructions] : []),
  ].join('\n\n');

const promptKi = (ki: DreamedKi) => {
  const isEntity = ki.type.startsWith(ENTITY_TYPE_PREFIX);
  const references = ki.references ?? [];
  const content = baseContent(ki.content);
  const accessPatterns = accessPatternsOf(ki);
  return {
    id: ki.id,
    kind: isEntity ? 'entity' : 'fact',
    type: ki.type.slice((isEntity ? ENTITY_TYPE_PREFIX : FACT_TYPE_PREFIX).length),
    [isEntity ? 'name' : 'title']: ki.title,
    ...(ki.description && { description: ki.description }),
    ...(content && { content: truncate(content, MAX_PROMPT_KI_CONTENT_LENGTH) }),
    ...(accessPatterns.length > 0 && { access_patterns: accessPatterns }),
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

const promptMemory = (memory: DreamingMemory) => ({
  id: memory.id,
  session_id: memory.session_id,
  recorded_at: memory.occurred_at ?? memory['@timestamp'],
  ...(memory.content && { content: truncate(memory.content, MAX_DREAMING_PROMPT_CONTENT_LENGTH) }),
  ...(memory.transcript && {
    transcript: truncate(memory.transcript, MAX_DREAMING_PROMPT_TRANSCRIPT_LENGTH),
  }),
});

/** A session in this task, with the session document it already has. */
export interface PromptSession {
  sessionId: string;
  firstRecordedAt: string;
  lastRecordedAt: string;
  document?: DreamedKi;
}

const promptSession = ({
  sessionId,
  firstRecordedAt,
  lastRecordedAt,
  document,
}: PromptSession) => ({
  session_id: sessionId,
  first_recorded_at: firstRecordedAt,
  last_recorded_at: lastRecordedAt,
  ...(document && {
    title: document.title,
    summary: truncate(document.content ?? '', MAX_PROMPT_KI_CONTENT_LENGTH),
    ...(isStale(document) && { stale: true }),
  }),
});

export const buildInput = ({
  memories,
  staleSources,
  existing,
  sessions,
}: {
  memories: readonly DreamingMemory[];
  /** Remaining sources of stale items, shown so the model can rewrite them. */
  staleSources: readonly DreamingMemory[];
  existing: readonly DreamedKi[];
  /** Only when the config keeps session documents. */
  sessions?: readonly PromptSession[];
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
    ...(sessions && sessions.length > 0
      ? [`SESSIONS:\n${JSON.stringify(sessions.map(promptSession), null, 1)}`]
      : []),
  ].join('\n\n');
