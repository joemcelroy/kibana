/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { estypes } from '@elastic/elasticsearch';
import type { ElasticsearchClient } from '@kbn/core/server';
import { SHARED_MEMORY_OWNER, type DreamingGroupBy } from '../../common/dreaming';

/**
 * What an AI index may dream: documents naming it, and with `untargetedApplies` also documents
 * naming no AI index. A user-scoped AI index takes only documents that name it and a user, so
 * nothing shared leaks in.
 */
export const buildAiIndexFilter = (
  aiIndexId: string,
  { userScoped, untargetedApplies }: { userScoped: boolean; untargetedApplies: boolean }
): estypes.QueryDslQueryContainer => {
  if (userScoped) {
    return {
      bool: {
        filter: [{ term: { ai_index_ids: aiIndexId } }, { exists: { field: 'user_id' } }],
      },
    };
  }
  if (!untargetedApplies) {
    return { term: { ai_index_ids: aiIndexId } };
  }
  return {
    bool: {
      should: [
        { bool: { must_not: { exists: { field: 'ai_index_ids' } } } },
        { term: { ai_index_ids: aiIndexId } },
      ],
      minimum_should_match: 1,
    },
  };
};

/** Documents in the given groups; documents without a user share one group. */
export const buildGroupFilter = (
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

interface Hit {
  _index?: string;
  _id?: string | null;
}

/** Deletes search hits. Data stream documents can only be deleted from their backing index. */
export const deleteHits = async (
  esClient: ElasticsearchClient,
  hits: readonly Hit[]
): Promise<number> => {
  const operations = hits.flatMap(({ _index, _id }) =>
    _index !== undefined && typeof _id === 'string' ? [{ delete: { _index, _id } }] : []
  );
  if (operations.length === 0) {
    return 0;
  }
  await esClient.bulk({ operations, refresh: 'wait_for' });
  return operations.length;
};
