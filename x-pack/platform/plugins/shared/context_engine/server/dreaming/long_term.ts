/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { estypes } from '@elastic/elasticsearch';
import type { ElasticsearchClient } from '@kbn/core/server';
import { ENTITY_TYPE_PREFIX, FACT_TYPE_PREFIX, SESSION_KI_TYPE } from '../../common/dreaming';
import type { AiIndexDest } from '../../common/http_api/ai_indices';
import type { KiReferenceRelation } from '../../common/step_types/ki';
import { isKiDeleted, type StoredKi } from '../ai_indices/ki_revision';
import { memoryIdFromUri, memoryUri, ownerIdPrefix, sessionKiId } from './ids';

export const USER_ATTRIBUTE = 'memory.user_id';
export const SESSION_ATTRIBUTE = 'memory.session_id';
export const ENTITY_ATTRIBUTE_PREFIX = 'entity.';

/** Most long-term KIs of one owner a task shows the model. */
export const MAX_OWNER_KIS = 500;

export type DreamedKiAttributes = Record<string, string | number | boolean | string[]>;

export interface DreamedKiReference {
  uri: string;
  relation?: KiReferenceRelation;
  type?: string;
  description?: string;
}

/** A long-term entity or fact as dreaming reads and writes it. */
export interface DreamedKi extends StoredKi {
  id: string;
  type: string;
  title: string;
  description?: string;
  content?: string;
  attributes?: DreamedKiAttributes;
  references?: DreamedKiReference[];
}

const LENIENT_INDEX_OPTIONS = { ignore_unavailable: true, allow_no_indices: true } as const;

const dreamedTypeFilter: estypes.QueryDslQueryContainer = {
  bool: {
    should: [{ prefix: { type: ENTITY_TYPE_PREFIX } }, { prefix: { type: FACT_TYPE_PREFIX } }],
    minimum_should_match: 1,
  },
};

/** Everything dreaming writes, session documents included: what forget has to reach. */
const writtenByDreamingFilter: estypes.QueryDslQueryContainer = {
  bool: {
    should: [dreamedTypeFilter, { term: { type: SESSION_KI_TYPE } }],
    minimum_should_match: 1,
  },
};

const isDreamedKi = (source: StoredKi | undefined): source is DreamedKi =>
  typeof source?.id === 'string' && typeof source.type === 'string';

/**
 * Searches current KI revisions: newest revision per id, then drops deleted ones, so an older
 * active revision of a deleted KI never resurfaces.
 */
const searchCurrentKis = async ({
  esClient,
  dest,
  query,
  size,
  abortSignal,
}: {
  esClient: ElasticsearchClient;
  dest: AiIndexDest;
  query: estypes.QueryDslQueryContainer;
  size: number;
  abortSignal?: AbortSignal;
}): Promise<DreamedKi[]> => {
  const response = await esClient.search<StoredKi>(
    {
      index: dest.value,
      ...LENIENT_INDEX_OPTIONS,
      size,
      track_total_hits: false,
      query,
      collapse: { field: 'id' },
      sort: [
        { '@timestamp': { order: 'desc', unmapped_type: 'date' } },
        { updated_at: { order: 'desc', unmapped_type: 'date' } },
      ],
    },
    { signal: abortSignal }
  );
  return response.hits.hits.flatMap(({ _source: source }) =>
    isDreamedKi(source) && !isKiDeleted(source) ? [source] : []
  );
};

/** The owner's current long-term entities and facts, newest first. */
export const loadOwnerKis = ({
  esClient,
  dest,
  owner,
  abortSignal,
}: {
  esClient: ElasticsearchClient;
  dest: AiIndexDest;
  owner: string;
  abortSignal?: AbortSignal;
}): Promise<DreamedKi[]> =>
  searchCurrentKis({
    esClient,
    dest,
    size: MAX_OWNER_KIS,
    abortSignal,
    query: {
      bool: { filter: [{ prefix: { id: ownerIdPrefix(owner) } }, dreamedTypeFilter] },
    },
  });

/**
 * The owner's session documents a task needs: the ones for its sessions, and any marked stale by
 * a forget so the task can rewrite or delete them. A stale match can be an older revision, so
 * stale ones are kept only when their current revision is stale.
 */
export const loadSessionKis = async ({
  esClient,
  dest,
  owner,
  sessionIds,
  abortSignal,
}: {
  esClient: ElasticsearchClient;
  dest: AiIndexDest;
  owner: string;
  sessionIds: readonly string[];
  abortSignal?: AbortSignal;
}): Promise<DreamedKi[]> => {
  const ownerSessions: estypes.QueryDslQueryContainer[] = [
    { prefix: { id: ownerIdPrefix(owner) } },
    { term: { type: SESSION_KI_TYPE } },
  ];
  const staleCandidates = await searchCurrentKis({
    esClient,
    dest,
    size: MAX_OWNER_KIS,
    abortSignal,
    query: {
      bool: { filter: [...ownerSessions, { term: { 'governance.lifecycle.status': 'stale' } }] },
    },
  });
  const taskIds = new Set(sessionIds.map((sessionId) => sessionKiId(owner, sessionId)));
  const ids = [...new Set([...taskIds, ...staleCandidates.map(({ id }) => id)])];
  if (ids.length === 0) {
    return [];
  }
  const current = await searchCurrentKis({
    esClient,
    dest,
    size: ids.length,
    abortSignal,
    query: { bool: { filter: [...ownerSessions, { terms: { id: ids } }] } },
  });
  return current.filter((ki) => taskIds.has(ki.id) || isStale(ki));
};

export const isSessionKi = (ki: DreamedKi): boolean => ki.type === SESSION_KI_TYPE;

/** Current long-term KIs, session documents included, that cite any of `memoryIds` as a source. */
export const findKisDerivedFrom = ({
  esClient,
  dest,
  memoryIds,
  abortSignal,
}: {
  esClient: ElasticsearchClient;
  dest: AiIndexDest;
  memoryIds: readonly string[];
  abortSignal?: AbortSignal;
}): Promise<DreamedKi[]> => {
  if (memoryIds.length === 0) {
    return Promise.resolve([]);
  }
  return searchCurrentKis({
    esClient,
    dest,
    size: MAX_OWNER_KIS,
    abortSignal,
    query: {
      bool: {
        filter: [
          { terms: { 'references.uri': memoryIds.map(memoryUri) } },
          writtenByDreamingFilter,
        ],
      },
    },
  });
};

/** Whether a forgotten source left the KI hidden from recall until a run re-evaluates it. */
export const isStale = (ki: DreamedKi): boolean => ki.governance?.lifecycle?.status === 'stale';

/** The short-term memories a KI was derived from. */
export const citedMemoryIds = (ki: DreamedKi): string[] =>
  (ki.references ?? []).flatMap(({ uri, relation }) => {
    const memoryId = relation === 'derived_from' ? memoryIdFromUri(uri) : undefined;
    return memoryId !== undefined ? [memoryId] : [];
  });
