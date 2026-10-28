/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { estypes } from '@elastic/elasticsearch';
import type { ElasticsearchClient } from '@kbn/core/server';
import type { IDataStreamClient } from '@kbn/core-data-streams-server';
import { cursorOfMemory, type DreamingCursor, type Transcript } from '../../common/dreaming';
import type { PullShortTermMemoriesParams } from '../short_term_memory/service';
import { buildAiIndexFilter, buildGroupFilter, deleteHits } from '../short_term_memory/queries';
import { TranscriptExistsError } from './errors';
import type { TranscriptMappings } from './storage';

export type TranscriptClient = IDataStreamClient<TranscriptMappings, Transcript>;

export type PullTranscriptsParams = PullShortTermMemoriesParams;

export interface PullTranscriptsResult {
  transcripts: Transcript[];
  /** Set when the page was full, so more transcripts may follow it. */
  next?: DreamingCursor;
}

/** Checks, before a transcript is written, that each AI index it names may receive it. */
export type AssertTranscriptTargets = (
  spaceId: string,
  aiIndexIds: readonly string[],
  transcript: Pick<Transcript, 'user_id'>
) => Promise<void>;

export interface TranscriptServiceApi {
  /**
   * Stores a transcript. Throws unless it has `raw`, a user and at least one AI index, and
   * {@link TranscriptExistsError} when its id is taken.
   */
  save(spaceId: string, transcript: Transcript): Promise<void>;
  pull(spaceId: string, params: PullTranscriptsParams): Promise<PullTranscriptsResult>;
  /** The transcripts among `ids` that still exist. */
  getByIds(spaceId: string, ids: readonly string[]): Promise<Transcript[]>;
  /** The ids of a user's transcripts in a space, at most `size`. */
  listIds(spaceId: string, userId: string, size: number): Promise<string[]>;
  /** Deletes up to `size` of a space's transcripts written before `before`. Returns how many. */
  deleteBefore(spaceId: string, before: string, size: number): Promise<number>;
  /** Deletes a transcript and returns it, or `undefined` when it does not exist. */
  delete(spaceId: string, transcriptId: string): Promise<Transcript | undefined>;
}

const SORT: estypes.Sort = [{ '@timestamp': { order: 'asc' } }, { id: { order: 'asc' } }];

/**
 * Owns the transcripts data stream, kept apart from short-term memory. Every call runs as the
 * internal user and is scoped to one space; callers authorize the request first.
 */
export class TranscriptService implements TranscriptServiceApi {
  private readonly getClient: () => Promise<TranscriptClient>;
  private readonly esClient: ElasticsearchClient;
  private readonly assertTargets?: AssertTranscriptTargets;

  constructor({
    getClient,
    esClient,
    assertTargets,
  }: {
    getClient: () => Promise<TranscriptClient>;
    esClient: ElasticsearchClient;
    assertTargets?: AssertTranscriptTargets;
  }) {
    this.getClient = getClient;
    this.esClient = esClient;
    this.assertTargets = assertTargets;
  }

  async save(spaceId: string, transcript: Transcript): Promise<void> {
    if (!transcript.raw) {
      throw new Error(`Transcript '${transcript.id}' is empty.`);
    }
    if (!transcript.user_id) {
      throw new Error(`Transcript '${transcript.id}' must name its user.`);
    }
    const targets = [...new Set(transcript.ai_index_ids)];
    // A transcript shows what its user can read, so it never reaches every AI index.
    if (targets.length === 0) {
      throw new Error(`Transcript '${transcript.id}' must name the AI indices it is for.`);
    }
    await this.assertTargets?.(spaceId, targets, transcript);
    const client = await this.getClient();
    const response = await client.create({
      space: spaceId,
      documents: [{ _id: transcript.id, ...transcript, ai_index_ids: targets }],
      refresh: 'wait_for',
    });
    const failure = response.items.find((item) => item.create?.error)?.create?.error;
    if (failure?.type === 'version_conflict_engine_exception') {
      throw new TranscriptExistsError(transcript.id);
    }
    if (failure) {
      throw new Error(`Failed to store transcript '${transcript.id}': ${failure.reason}`);
    }
  }

  async pull(
    spaceId: string,
    { after, until, groupBy, groupKeys, aiIndexId, userScoped = false, size }: PullTranscriptsParams
  ): Promise<PullTranscriptsResult> {
    if (groupKeys !== undefined && groupKeys.length === 0) {
      return { transcripts: [] };
    }
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
      filter.push(buildAiIndexFilter(aiIndexId, { userScoped, untargetedApplies: false }));
    }
    const client = await this.getClient();
    const response = await client.search({
      space: spaceId,
      size,
      track_total_hits: false,
      query: { bool: { filter } },
      sort: SORT,
      ...(after !== undefined && { search_after: [Date.parse(after.timestamp), after.memory_id] }),
    });
    const transcripts = response.hits.hits.flatMap((hit) => (hit._source ? [hit._source] : []));
    const last = transcripts[transcripts.length - 1];
    return {
      transcripts,
      ...(transcripts.length === size && last !== undefined && { next: cursorOfMemory(last) }),
    };
  }

  async getByIds(spaceId: string, ids: readonly string[]): Promise<Transcript[]> {
    if (ids.length === 0) {
      return [];
    }
    const client = await this.getClient();
    const response = await client.search({
      space: spaceId,
      size: ids.length,
      track_total_hits: false,
      query: { bool: { filter: [{ terms: { id: [...ids] } }] } },
      sort: SORT,
    });
    return response.hits.hits.flatMap((hit) => (hit._source ? [hit._source] : []));
  }

  async listIds(spaceId: string, userId: string, size: number): Promise<string[]> {
    const client = await this.getClient();
    const response = await client.search({
      space: spaceId,
      size,
      track_total_hits: false,
      _source: ['id'],
      query: { bool: { filter: [{ term: { user_id: userId } }] } },
      sort: SORT,
    });
    return response.hits.hits.flatMap((hit) => (hit._source?.id ? [hit._source.id] : []));
  }

  async deleteBefore(spaceId: string, before: string, size: number): Promise<number> {
    const client = await this.getClient();
    const response = await client.search({
      space: spaceId,
      size,
      track_total_hits: false,
      _source: false,
      query: { bool: { filter: [{ range: { '@timestamp': { lt: before } } }] } },
    });
    return deleteHits(this.esClient, response.hits.hits);
  }

  async delete(spaceId: string, transcriptId: string): Promise<Transcript | undefined> {
    const client = await this.getClient();
    const response = await client.search({
      space: spaceId,
      size: 1,
      track_total_hits: false,
      query: { term: { id: transcriptId } },
    });
    const [hit] = response.hits.hits;
    if (!hit?._source) {
      return undefined;
    }
    await deleteHits(this.esClient, [hit]);
    return hit._source;
  }
}
