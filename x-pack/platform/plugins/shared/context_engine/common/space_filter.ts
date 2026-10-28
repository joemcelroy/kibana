/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { QueryDslQueryContainer } from '@elastic/elasticsearch/lib/api/types';

export const AI_INDEX_PRIVILEGES_PATH = 'permissions.kibana.privileges';
const SPACE_FIELD = `${AI_INDEX_PRIVILEGES_PATH}.space`;

/**
 * ES|QL `filter` for AI-index reads: docs with no `permissions.kibana.privileges`, or one scoped to
 * `spaceId` or `*`. Like SML `buildVisibilityFilter` minus Kibana object-privilege check; ES RBAC
 * comes from `asCurrentUser`. `ignore_unmapped` keeps indices lacking this field. Explicit
 * `minimum_should_match: 1` required for FORK filter pushdown; do not drop.
 */
/** Matches documents of `dest`'s backing indices. */
const inDest = ({ type, value }: { type: string; value: string }): QueryDslQueryContainer =>
  type === 'data_stream' ? { prefix: { _index: `.ds-${value}-` } } : { term: { _index: value } };

/**
 * ES|QL `filter` that keeps a caller to their own KIs in AI indices that keep each user's memory
 * apart: there, a KI's id starts with its owner's user id. A caller can own KIs under more than
 * one id, their profile uid and their username, as Agent Builder matches users. Other indices
 * pass through. A caller with no user id sees no KI of those indices.
 */
export const buildAiIndexUserFilter = (
  userScopedDests: ReadonlyArray<{ type: string; value: string }>,
  userIds: readonly string[]
): QueryDslQueryContainer | undefined =>
  userScopedDests.length === 0
    ? undefined
    : {
        bool: {
          should: [
            { bool: { must_not: userScopedDests.map(inDest) } },
            ...userIds.map((userId) => ({ prefix: { id: `${userId}/` } })),
          ],
          minimum_should_match: 1,
        },
      };

export const buildAiIndexSpaceFilter = (spaceId: string): QueryDslQueryContainer => ({
  bool: {
    should: [
      {
        bool: {
          must_not: {
            nested: {
              path: AI_INDEX_PRIVILEGES_PATH,
              query: { match_all: {} },
              ignore_unmapped: true,
            },
          },
        },
      },
      {
        nested: {
          path: AI_INDEX_PRIVILEGES_PATH,
          ignore_unmapped: true,
          query: {
            bool: {
              should: [{ term: { [SPACE_FIELD]: spaceId } }, { term: { [SPACE_FIELD]: '*' } }],
              minimum_should_match: 1,
            },
          },
        },
      },
    ],
    minimum_should_match: 1,
  },
});
