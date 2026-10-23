/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { estypes } from '@elastic/elasticsearch';
import type { ElasticsearchClient } from '@kbn/core/server';
import type { IDataStreamClient } from '@kbn/core-data-streams-server';
import {
  SHARED_MEMORY_OWNER,
  cursorOfMemory,
  type DreamingCursor,
  type DreamingGroupBy,
  type ShortTermMemory,
} from '../../common/dreaming';
import type { ShortTermMemoryMappings } from './storage';

export type ShortTermMemoryClient = IDataStreamClient<ShortTermMemoryMappings, ShortTermMemory>;

export interface PullShortTermMemoriesParams {
  /** Exclusive lower bound. Omitted reads from the start of the stream. */
  after?: DreamingCursor;
  /** Inclusive upper bound on `@timestamp`. */
  until: string;
  groupBy: DreamingGroupBy;
  /** Restricts the read to these groups. */
  groupKeys?: readonly string[];
  size: number;
}

export interface PullShortTermMemoriesResult {
  memories: ShortTermMemory[];
  /** Set when the page was full, so more memories may follow it. */
  next?: DreamingCursor;
}

export interface ShortTermMemoryServiceApi {
  remember(spaceId: string, memory: ShortTermMemory): Promise<void>;
  /** Deletes a memory and returns it, or `undefined` when it does not exist. */
  forget(spaceId: string, memoryId: string): Promise<ShortTermMemory | undefined>;
  pull(spaceId: string, params: PullShortTermMemoriesParams): Promise<PullShortTermMemoriesResult>;
  /** The memories among `ids` that still exist. */
  getByIds(spaceId: string, ids: readonly string[]): Promise<ShortTermMemory[]>;
}

/** The value a memory groups under; memories without a user share one group. */
export const groupKeyOf = (memory: ShortTermMemory, groupBy: DreamingGroupBy): string =>
  groupBy === 'session_id' ? memory.session_id : memory.user_id ?? SHARED_MEMORY_OWNER;

const buildGroupFilter = (
  groupBy: DreamingGroupBy,
  groupKeys: readonly string[]
): estypes.QueryDslQueryContainer => {
  if (groupBy === 'session_id') {
    return { terms: { session_id: [...groupKeys] } };
  }
  const userIds = groupKeys.filter((key) => key !== SHARED_MEMORY_OWNER);
  const should: estypes.QueryDslQueryContainer[] = [];
  if (userIds.length > 0) {
    should.push({ terms: { user_id: userIds } });
  }
  if (userIds.length < groupKeys.length) {
    should.push({ bool: { must_not: { exists: { field: 'user_id' } } } });
  }
  return { bool: { should, minimum_should_match: 1 } };
};

/**
 * Owns the shared short-term memory data stream. Every call runs as the internal user and is
 * scoped to one space; callers authorize the request first.
 */
export class ShortTermMemoryService implements ShortTermMemoryServiceApi {
  private readonly getClient: () => Promise<ShortTermMemoryClient>;
  private readonly esClient: ElasticsearchClient;

  constructor({
    getClient,
    esClient,
  }: {
    getClient: () => Promise<ShortTermMemoryClient>;
    esClient: ElasticsearchClient;
  }) {
    this.getClient = getClient;
    this.esClient = esClient;
  }

  async remember(spaceId: string, memory: ShortTermMemory): Promise<void> {
    const client = await this.getClient();
    const response = await client.create({
      space: spaceId,
      documents: [{ _id: memory.id, ...memory }],
      refresh: 'wait_for',
    });
    const failure = response.items.find((item) => item.create?.error)?.create?.error;
    if (failure) {
      throw new Error(`Failed to store short-term memory '${memory.id}': ${failure.reason}`);
    }
  }

  async forget(spaceId: string, memoryId: string): Promise<ShortTermMemory | undefined> {
    const client = await this.getClient();
    const response = await client.search({
      space: spaceId,
      size: 1,
      track_total_hits: false,
      query: { term: { id: memoryId } },
    });
    const [hit] = response.hits.hits;
    if (!hit?._source || hit._index === undefined || hit._id === undefined) {
      return undefined;
    }
    // Data stream documents can only be deleted from their backing index.
    await this.esClient.delete({ index: hit._index, id: hit._id, refresh: 'wait_for' });
    return hit._source;
  }

  async pull(
    spaceId: string,
    { after, until, groupBy, groupKeys, size }: PullShortTermMemoriesParams
  ): Promise<PullShortTermMemoriesResult> {
    if (groupKeys !== undefined && groupKeys.length === 0) {
      return { memories: [] };
    }
    const client = await this.getClient();
    const filter: estypes.QueryDslQueryContainer[] = [
      {
        range: {
          '@timestamp': { lte: until, ...(after !== undefined && { gte: after.timestamp }) },
        },
      },
    ];
    if (groupKeys !== undefined) {
      filter.push(buildGroupFilter(groupBy, groupKeys));
    }

    const response = await client.search({
      space: spaceId,
      size,
      track_total_hits: false,
      query: { bool: { filter } },
      sort: [{ '@timestamp': { order: 'asc' } }, { id: { order: 'asc' } }],
      ...(after !== undefined && { search_after: [Date.parse(after.timestamp), after.memory_id] }),
    });

    const memories = response.hits.hits.flatMap((hit) => (hit._source ? [hit._source] : []));
    const last = memories[memories.length - 1];
    return {
      memories,
      ...(memories.length === size && last !== undefined && { next: cursorOfMemory(last) }),
    };
  }

  async getByIds(spaceId: string, ids: readonly string[]): Promise<ShortTermMemory[]> {
    if (ids.length === 0) {
      return [];
    }
    const client = await this.getClient();
    const response = await client.search({
      space: spaceId,
      size: ids.length,
      track_total_hits: false,
      query: { bool: { filter: [{ terms: { id: [...ids] } }] } },
      sort: [{ '@timestamp': { order: 'asc' } }, { id: { order: 'asc' } }],
    });
    return response.hits.hits.flatMap((hit) => (hit._source ? [hit._source] : []));
  }
}
