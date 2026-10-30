/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ElasticsearchClient, Logger } from '@kbn/core/server';
import { DEFAULT_DREAMING_GROUP_BY, cursorBeforeMemory } from '../../common/dreaming';
import type { AiIndexService } from '../ai_indices/service';
import { groupKeyOf } from '../short_term_memory/service';
import type { DreamingMemoryReader } from './memory_reader';
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
 * Flags every long-term KI derived from a short-term memory or transcript as stale, queues its group for
 * re-dreaming on each AI index that held one, then deletes the memory. The next run rewrites or
 * deletes those KIs. The memory goes last, so a write that fails leaves it to be forgotten again.
 */
export const forgetMemory = async ({
  spaceId,
  memoryId,
  memoryReader,
  aiIndexService,
  esClient,
  internalEsClient,
  logger,
}: {
  spaceId: string;
  memoryId: string;
  memoryReader: DreamingMemoryReader;
  aiIndexService: AiIndexService;
  /**
   * Writes the stale flags, as the user forgetting: AI index data is the user's, and Kibana's own
   * user cannot write it on every deployment.
   */
  esClient: ElasticsearchClient;
  /** Writes them in a hidden AI index, whose system index only Kibana can write. */
  internalEsClient: ElasticsearchClient;
  logger: Logger;
}): Promise<ForgetMemoryResult> => {
  const [memory] = await memoryReader.getByIds(spaceId, [memoryId]);
  if (!memory) {
    return { forgotten: false, ai_index_ids: [] };
  }

  const affected: string[] = [];
  for (const { id: aiIndexId, dest, dreaming, hidden } of await aiIndexService.listDreaming(
    spaceId
  )) {
    const client = hidden ? internalEsClient : esClient;
    const derived = await findKisDerivedFrom({ esClient: client, dest, memoryIds: [memoryId] });
    const context = {
      esClient: client,
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
  await memoryReader.forget(spaceId, memoryId);
  return { forgotten: true, ai_index_ids: affected };
};
