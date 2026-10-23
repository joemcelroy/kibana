/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ElasticsearchClient, Logger } from '@kbn/core/server';
import { DEFAULT_DREAMING_GROUP_BY, cursorBeforeMemory } from '../../common/dreaming';
import type { AiIndexService } from '../ai_indices/service';
import { groupKeyOf, type ShortTermMemoryServiceApi } from '../short_term_memory/service';
import { markStale } from './apply';
import { findKisDerivedFrom } from './long_term';
import { queueRetries } from './state';

export const FORGET_WRITER_URI = 'task://dreaming/forget';

export interface ForgetMemoryResult {
  forgotten: boolean;
  /** AI indices whose long-term memory used the memory and will re-dream it. */
  ai_index_ids: string[];
}

/**
 * Deletes a short-term memory, flags every long-term KI derived from it as stale, and queues its
 * group for re-dreaming on each AI index that held one. The next run rewrites or deletes those
 * KIs.
 */
export const forgetMemory = async ({
  spaceId,
  memoryId,
  shortTermMemory,
  aiIndexService,
  esClient,
  logger,
}: {
  spaceId: string;
  memoryId: string;
  shortTermMemory: ShortTermMemoryServiceApi;
  aiIndexService: AiIndexService;
  /** Writes the stale flags; forgetting must reach every AI index that used the memory. */
  esClient: ElasticsearchClient;
  logger: Logger;
}): Promise<ForgetMemoryResult> => {
  const memory = await shortTermMemory.forget(spaceId, memoryId);
  if (!memory) {
    return { forgotten: false, ai_index_ids: [] };
  }

  const affected: string[] = [];
  for (const { id: aiIndexId, dest, dreaming } of await aiIndexService.listDreaming(spaceId)) {
    const derived = await findKisDerivedFrom({ esClient, dest, memoryIds: [memoryId] });
    const context = {
      esClient,
      aiIndexId,
      dest,
      writer: { uri: FORGET_WRITER_URI, metadata: { space_id: spaceId } },
    };
    let marked = 0;
    for (const ki of derived) {
      if (await markStale(context, ki.id, memoryId)) {
        marked += 1;
      }
    }
    if (marked === 0) {
      continue;
    }
    const groupKey = groupKeyOf(memory, dreaming.group_by ?? DEFAULT_DREAMING_GROUP_BY);
    await aiIndexService.updateDreamingState(aiIndexId, spaceId, (current) =>
      queueRetries(current, [{ group_key: groupKey, from: cursorBeforeMemory(memory) }])
    );
    affected.push(aiIndexId);
    logger.debug(
      `Forgot memory '${memoryId}': ${marked} KIs in AI index '${aiIndexId}' will be re-dreamed`
    );
  }
  return { forgotten: true, ai_index_ids: affected };
};
