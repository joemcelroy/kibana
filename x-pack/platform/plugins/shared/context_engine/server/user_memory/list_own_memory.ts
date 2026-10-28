/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { ENTITY_TYPE_PREFIX, FACT_TYPE_PREFIX, SESSION_KI_TYPE } from '../../common/dreaming';
import {
  MAX_OWN_MEMORY_KIS,
  type OwnMemoryAiIndex,
  type OwnMemoryKi,
} from '../../common/http_api/user_memory';
import type { AiIndexDataReadServiceApi } from '../ai_indices/data_read_service';
import type { AiIndexService } from '../ai_indices/service';
import { resolveMemoryTargets } from '../dreaming/request_dream';
import { ownerIdPrefix } from '../dreaming/ids';

const OWN_MEMORY_FIELDS = ['id', 'type', 'title', 'content', 'updated_at'] as const;

/** Dreamed KIs owned by the caller: their ids start with one of the caller's user ids. */
const ownMemoryQuery = (target: string, owners: number): string =>
  [
    `FROM ${target}`,
    `| WHERE (${Array.from(
      { length: owners },
      (_, index) => `STARTS_WITH(id, ?owner_prefix_${index})`
    ).join(' OR ')})`,
    `  AND (type LIKE "${ENTITY_TYPE_PREFIX}*" OR type LIKE "${FACT_TYPE_PREFIX}*" OR type == "${SESSION_KI_TYPE}")`,
    `| KEEP ${OWN_MEMORY_FIELDS.join(', ')}`,
    '| SORT updated_at DESC',
    `| LIMIT ${MAX_OWN_MEMORY_KIS}`,
  ].join('\n');

const toKis = (columns: Array<{ name: string }>, values: unknown[][]): OwnMemoryKi[] =>
  values.flatMap((row) => {
    const record = Object.fromEntries(columns.map(({ name }, index) => [name, row[index]]));
    if (typeof record.id !== 'string' || typeof record.type !== 'string') {
      return [];
    }
    return [
      {
        id: record.id,
        type: record.type,
        ...(typeof record.title === 'string' && { title: record.title }),
        ...(typeof record.content === 'string' && { content: record.content }),
        ...(typeof record.updated_at === 'string' && { updated_at: record.updated_at }),
      },
    ];
  });

/**
 * The caller's long-term memory in each of `aiIndexIds` that takes memories: the profile,
 * entities, facts and session documents dreaming wrote for them. Without `aiIndexIds`, every AI
 * index in the space that keeps each user's memory apart, whichever agents write to it. Reads go
 * through the caller's AI index read path, so they only see what they may read.
 */
export const listOwnMemory = async ({
  aiIndexService,
  dataRead,
  spaceId,
  userIds,
  aiIndexIds,
}: {
  aiIndexService: Pick<AiIndexService, 'get' | 'list'>;
  dataRead: Pick<AiIndexDataReadServiceApi, 'query'>;
  spaceId: string;
  /** The ids the caller's memory can be owned by, see `ownerIdsOf`. */
  userIds: readonly string[];
  aiIndexIds?: readonly string[];
}): Promise<OwnMemoryAiIndex[]> => {
  const ids =
    aiIndexIds ??
    (await aiIndexService.list(spaceId))
      .filter(
        ({ memory_enabled: memoryEnabled, memory_scope: scope }) =>
          memoryEnabled && scope === 'user'
      )
      .map(({ id }) => id);
  const targets = await resolveMemoryTargets({ aiIndexService, spaceId, aiIndexIds: ids });
  return Promise.all(
    targets.map(async ({ aiIndexId, memoryScope }) => {
      const aiIndex = await aiIndexService.get(aiIndexId, spaceId);
      const base = {
        id: aiIndexId,
        ...(aiIndex.description !== undefined && { description: aiIndex.description }),
        memory_scope: memoryScope,
      };
      try {
        const { columns, values } = await dataRead.query({
          query: ownMemoryQuery(aiIndex.dest.value, userIds.length),
          params: Object.fromEntries(
            userIds.map((userId, index) => [`owner_prefix_${index}`, ownerIdPrefix(userId)])
          ),
          limit: MAX_OWN_MEMORY_KIS,
        });
        return { ...base, kis: toKis(columns, values as unknown[][]) };
      } catch (error) {
        return { ...base, kis: [], error: error instanceof Error ? error.message : String(error) };
      }
    })
  );
};
