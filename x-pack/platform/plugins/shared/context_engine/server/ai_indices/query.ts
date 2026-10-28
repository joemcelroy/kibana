/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { EsqlNamedValue } from '@elastic/elasticsearch/lib/api/types';
import type { ElasticsearchClient } from '@kbn/core/server';
import { isMaximumResponseSizeExceededError } from '@kbn/es-errors';
import {
  DEFAULT_AI_INDEX_QUERY_LIMIT,
  MAX_AI_INDEX_QUERY_RESPONSE_BYTES,
} from '../../common/constants';
import type {
  AiIndexDest,
  QueryAiIndicesRequest,
  QueryAiIndicesResponse,
} from '../../common/http_api/ai_indices';
import { buildAiIndexSpaceFilter, buildAiIndexUserFilter } from '../../common/space_filter';
import { validateQueryAiIndicesRequest } from '../../common/validation';
import { applyLimit } from './apply_limit';
import { AiIndexQueryResponseTooLargeError, InvalidAiIndexQueryError } from './errors';
import { applyKiLifecycle } from './ki_lifecycle';
import { isAiIndexDest, missingIndicesOf, withoutSources } from './missing_indices';

export interface QueryAiIndicesParams extends QueryAiIndicesRequest {
  esClient: ElasticsearchClient;
  spaceId: string;
  /** Registered AI index dests; a query reading one gets the lifecycle pipeline applied. */
  aiIndexDests?: AiIndexDest[];
  /** Dests of AI indices that keep each user's memory apart; the caller only reads their own. */
  userScopedDests?: AiIndexDest[];
  /** Ids the caller's KIs in `userScopedDests` can be owned by: profile uid and username. */
  userIds?: readonly string[];
}

/**
 * Runs caller-supplied ES|QL with server-owned lifecycle filters, space filter and row cap.
 * `allow_partial_results` may silently drop failed shards. A registered AI index's backing index
 * is created on its first write, so until then it reads as empty: the query runs without it, and
 * returns no rows when it read nothing else.
 */
export const queryAiIndices = async ({
  esClient,
  spaceId,
  query,
  params,
  limit,
  aiIndexDests = [],
  userScopedDests = [],
  userIds = [],
}: QueryAiIndicesParams): Promise<QueryAiIndicesResponse> => {
  const spaceFilter = buildAiIndexSpaceFilter(spaceId);
  const userFilter = buildAiIndexUserFilter(userScopedDests, userIds);
  const validationError = validateQueryAiIndicesRequest({ query, params, limit });
  if (validationError) {
    throw new InvalidAiIndexQueryError(validationError);
  }

  const namedParams: EsqlNamedValue[] = Object.entries(params ?? {}).map(([name, value]) => ({
    [name]: value,
  }));

  const run = async (source: string): Promise<QueryAiIndicesResponse> => {
    const { columns, values } = await esClient.esql.query(
      {
        query: applyLimit(
          applyKiLifecycle(source, aiIndexDests),
          limit ?? DEFAULT_AI_INDEX_QUERY_LIMIT
        ),
        filter: userFilter ? { bool: { filter: [spaceFilter, userFilter] } } : spaceFilter,
        drop_null_columns: true,
        allow_partial_results: true,
        ...(namedParams.length > 0 ? { params: namedParams } : {}),
      },
      { maxResponseSize: MAX_AI_INDEX_QUERY_RESPONSE_BYTES }
    );
    return { columns, values };
  };

  let current = query;
  // Each retry drops at least one source, so this ends.
  for (;;) {
    try {
      return await run(current);
    } catch (error) {
      if (isMaximumResponseSizeExceededError(error)) {
        throw new AiIndexQueryResponseTooLargeError(MAX_AI_INDEX_QUERY_RESPONSE_BYTES);
      }
      const missing = missingIndicesOf(error);
      if (missing.length === 0 || !missing.every((index) => isAiIndexDest(index, aiIndexDests))) {
        throw error;
      }
      const remaining = withoutSources(current, missing);
      if (remaining === undefined) {
        return { columns: [], values: [] };
      }
      if (remaining === current) {
        throw error;
      }
      current = remaining;
    }
  }
};
