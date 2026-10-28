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
  type DreamingMemory,
  type ShortTermMemory,
} from '../../common/dreaming';
import { ShortTermMemoryExistsError } from './errors';
import { buildAiIndexFilter, buildGroupFilter, deleteHits } from './queries';
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
  /** Reads only memories this AI index may dream: untargeted ones and ones naming it. */
  aiIndexId?: string;
  /**
   * With `aiIndexId`, reads only memories that name it and a user, for an AI index that keeps
   * each user's memory apart.
   */
  userScoped?: boolean;
  size: number;
}

export interface PullShortTermMemoriesResult {
  memories: ShortTermMemory[];
  /** Set when the page was full, so more memories may follow it. */
  next?: DreamingCursor;
}

export interface SearchShortTermMemoriesParams {
  query: string;
  size: number;
  /**
   * The AI indices the caller may read. A targeted memory is found only through one of them;
   * an untargeted one applies to every AI index.
   */
  aiIndexIds: readonly string[];
  /** Every id the caller's memories are recorded under. A memory about another user is never found. */
  userIds: readonly string[];
}

export interface SearchedShortTermMemory extends ShortTermMemory {
  score: number;
}

export interface ShortTermMemoryServiceApi {
  /** Appends a memory. Throws unless it has `content`. */
  remember(spaceId: string, memory: ShortTermMemory): Promise<void>;
  /** Deletes a memory and returns it, or `undefined` when it does not exist. */
  forget(spaceId: string, memoryId: string): Promise<ShortTermMemory | undefined>;
  pull(spaceId: string, params: PullShortTermMemoriesParams): Promise<PullShortTermMemoriesResult>;
  /** The memories among `ids` that still exist. */
  getByIds(spaceId: string, ids: readonly string[]): Promise<ShortTermMemory[]>;
  /**
   * Searches memories' `content` by meaning, best first, among those the caller may see: shared or
   * about them, and untargeted or targeted at an AI index they can read.
   */
  search(
    spaceId: string,
    params: SearchShortTermMemoriesParams
  ): Promise<SearchedShortTermMemory[]>;
}

/** The value a memory or transcript groups under; memories without a user share one group. */
export const groupKeyOf = (
  memory: Pick<DreamingMemory, 'session_id' | 'user_id'>,
  groupBy: DreamingGroupBy
): string => (groupBy === 'session_id' ? memory.session_id : memory.user_id ?? SHARED_MEMORY_OWNER);

/** Checks, before a memory is written, that each AI index it names may receive it. */
export type AssertMemoryTargets = (
  spaceId: string,
  aiIndexIds: readonly string[],
  memory: Pick<DreamingMemory, 'user_id'>
) => Promise<void>;

/**
 * Owns the shared short-term memory data stream. Every call runs as the internal user and is
 * scoped to one space; callers authorize the request first.
 */
export class ShortTermMemoryService implements ShortTermMemoryServiceApi {
  private readonly getClient: () => Promise<ShortTermMemoryClient>;
  private readonly esClient: ElasticsearchClient;
  private readonly assertTargets?: AssertMemoryTargets;

  constructor({
    getClient,
    esClient,
    assertTargets,
  }: {
    getClient: () => Promise<ShortTermMemoryClient>;
    esClient: ElasticsearchClient;
    assertTargets?: AssertMemoryTargets;
  }) {
    this.getClient = getClient;
    this.esClient = esClient;
    this.assertTargets = assertTargets;
  }

  async remember(spaceId: string, memory: ShortTermMemory): Promise<void> {
    if (!memory.content) {
      throw new Error(`Short-term memory '${memory.id}' needs content.`);
    }
    const { ai_index_ids: aiIndexIds, ...rest } = memory;
    const targets = [...new Set(aiIndexIds ?? [])];
    if (targets.length > 0) {
      await this.assertTargets?.(spaceId, targets, memory);
    }
    const client = await this.getClient();
    const response = await client.create({
      space: spaceId,
      // An empty list is stored as missing, so it applies to every AI index.
      documents: [
        { _id: memory.id, ...rest, ...(targets.length > 0 && { ai_index_ids: targets }) },
      ],
      refresh: 'wait_for',
    });
    const failure = response.items.find((item) => item.create?.error)?.create?.error;
    if (failure?.type === 'version_conflict_engine_exception') {
      throw new ShortTermMemoryExistsError(memory.id);
    }
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
    await deleteHits(this.esClient, [hit]);
    return hit._source;
  }

  async pull(
    spaceId: string,
    {
      after,
      until,
      groupBy,
      groupKeys,
      aiIndexId,
      userScoped = false,
      size,
    }: PullShortTermMemoriesParams
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
    if (aiIndexId !== undefined) {
      filter.push(buildAiIndexFilter(aiIndexId, { userScoped, untargetedApplies: true }));
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

  async search(
    spaceId: string,
    { query, size, aiIndexIds, userIds }: SearchShortTermMemoriesParams
  ): Promise<SearchedShortTermMemory[]> {
    const client = await this.getClient();
    const untargeted: estypes.QueryDslQueryContainer = {
      bool: { must_not: { exists: { field: 'ai_index_ids' } } },
    };
    const shared: estypes.QueryDslQueryContainer = {
      bool: { must_not: { exists: { field: 'user_id' } } },
    };
    const response = await client.search({
      space: spaceId,
      size,
      track_total_hits: false,
      query: {
        bool: {
          must: [{ match: { content: query } }],
          filter: [
            aiIndexIds.length > 0
              ? {
                  bool: {
                    should: [untargeted, { terms: { ai_index_ids: [...aiIndexIds] } }],
                    minimum_should_match: 1,
                  },
                }
              : untargeted,
            userIds.length > 0
              ? {
                  bool: {
                    should: [shared, { terms: { user_id: [...userIds] } }],
                    minimum_should_match: 1,
                  },
                }
              : shared,
          ],
        },
      },
    });
    return response.hits.hits.flatMap((hit) =>
      hit._source ? [{ ...hit._source, score: hit._score ?? 0 }] : []
    );
  }
}
