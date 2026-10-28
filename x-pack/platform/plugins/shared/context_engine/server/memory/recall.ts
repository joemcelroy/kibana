/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AiIndexHttpItem } from '../../common/http_api/ai_indices';
import {
  DEFAULT_RECALL_LIMIT,
  MAX_RECALL_CONTENT_LENGTH,
  type RecallError,
  type RecalledKi,
  type RecalledMemory,
} from '../../common/http_api/memory';
import type { AiIndexDataReadServiceApi } from '../ai_indices/data_read_service';
import type { ShortTermMemoryServiceApi } from '../short_term_memory/service';

const RECALL_FIELDS = ['id', 'type', 'title', 'description', 'content', 'updated_at'] as const;

/**
 * Lexical and semantic search over one AI index's KIs, fused by rank. The read path adds the space,
 * lifecycle and user filters after `FROM`. `FUSE` keys on `_id` and `_index`, so both are loaded.
 */
export const recallQuery = (target: string, limit: number): string =>
  [
    `FROM ${target} METADATA _id, _index, _score`,
    '| FORK',
    '    ( WHERE MATCH(title, ?query) OR MATCH(description, ?query) OR MATCH(content, ?query) | SORT _score DESC | LIMIT 20 )',
    '    ( WHERE MATCH(title.semantic, ?query) OR MATCH(description.semantic, ?query) OR MATCH(content.semantic, ?query) | SORT _score DESC | LIMIT 20 )',
    '| FUSE',
    '| SORT _score DESC, _id ASC',
    `| KEEP ${RECALL_FIELDS.join(', ')}, _score`,
    `| LIMIT ${limit}`,
  ].join('\n');

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const truncate = (content: string | undefined): string | undefined =>
  content && content.length > MAX_RECALL_CONTENT_LENGTH
    ? `${content.slice(0, MAX_RECALL_CONTENT_LENGTH)}…`
    : content;

const toRecalled = (
  aiIndexId: string,
  columns: Array<{ name: string }>,
  values: unknown[][]
): RecalledKi[] =>
  values.flatMap((row) => {
    const record = Object.fromEntries(columns.map(({ name }, index) => [name, row[index]]));
    const id = asString(record.id);
    if (!id) {
      return [];
    }
    const fields = {
      type: asString(record.type),
      title: asString(record.title),
      description: asString(record.description),
      content: truncate(asString(record.content)),
      updated_at: asString(record.updated_at),
    };
    return [
      {
        ai_index_id: aiIndexId,
        id,
        ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
        score: typeof record._score === 'number' ? record._score : 0,
      },
    ];
  });

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The AI indices among `aiIndexIds` the caller can read (every one when omitted), and an error for
 * each requested one they can't.
 */
const readableAiIndices = async (
  dataRead: Pick<AiIndexDataReadServiceApi, 'list'>,
  aiIndexIds: readonly string[] | undefined
): Promise<{ aiIndices: AiIndexHttpItem[]; errors: RecallError[] }> => {
  const ids = aiIndexIds && [...new Set(aiIndexIds)];
  const aiIndices = ids && ids.length === 0 ? [] : await dataRead.list(ids && [...ids]);
  const errors = (ids ?? [])
    .filter((id) => !aiIndices.some((aiIndex) => aiIndex.id === id))
    .map((id) => ({ ai_index_id: id, message: 'AI index not found or not readable.' }));
  return { aiIndices, errors };
};

/**
 * Searches each of `aiIndexIds` (every AI index the caller can read when omitted) for `query`, in
 * parallel, and returns the best `limit` results. Fused scores are rank-based, so results from
 * different AI indices are comparable. An AI index that can't be searched is reported in `errors`.
 */
export const searchAiIndices = async ({
  dataRead,
  query,
  aiIndexIds,
  limit = DEFAULT_RECALL_LIMIT,
}: {
  dataRead: Pick<AiIndexDataReadServiceApi, 'list' | 'query'>;
  query: string;
  aiIndexIds?: readonly string[];
  limit?: number;
}): Promise<{ results: RecalledKi[]; errors: RecallError[] }> => {
  const { aiIndices, errors } = await readableAiIndices(dataRead, aiIndexIds);
  const searched = await Promise.all(
    aiIndices.map(async ({ id, dest }) => {
      try {
        const { columns, values } = await dataRead.query({
          query: recallQuery(dest.value, limit),
          params: { query },
          limit,
        });
        return toRecalled(id, columns, values as unknown[][]);
      } catch (error) {
        errors.push({ ai_index_id: id, message: errorMessage(error) });
        return [];
      }
    })
  );
  const results = searched
    .flat()
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return { results, errors };
};

/**
 * Searches short-term memory for `query`. A caller finds shared memories and memories about
 * themselves, untargeted or targeted at one of `aiIndexIds` they can read (every AI index they can
 * read when omitted). Transcripts are never searched.
 */
export const searchShortTermMemory = async ({
  dataRead,
  shortTermMemory,
  spaceId,
  userIds,
  query,
  aiIndexIds,
  limit = DEFAULT_RECALL_LIMIT,
}: {
  dataRead: Pick<AiIndexDataReadServiceApi, 'list'>;
  shortTermMemory: Pick<ShortTermMemoryServiceApi, 'search'>;
  spaceId: string;
  userIds: readonly string[];
  query: string;
  aiIndexIds?: readonly string[];
  limit?: number;
}): Promise<{ results: RecalledMemory[]; errors: RecallError[] }> => {
  const { aiIndices, errors } = await readableAiIndices(dataRead, aiIndexIds);
  const memories = await shortTermMemory.search(spaceId, {
    query,
    size: limit,
    aiIndexIds: aiIndices.map(({ id }) => id),
    userIds,
  });
  const results = memories.map((memory) => ({
    id: memory.id,
    session_id: memory.session_id,
    content: truncate(memory.content) ?? '',
    recorded_at: memory.occurred_at ?? memory['@timestamp'],
    about_user: memory.user_id !== undefined,
    ...(memory.ai_index_ids && { ai_index_ids: memory.ai_index_ids }),
    score: memory.score,
  }));
  return { results, errors };
};
