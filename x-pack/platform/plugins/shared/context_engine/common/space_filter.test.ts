/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  AI_INDEX_PRIVILEGES_PATH,
  buildAiIndexSpaceFilter,
  buildAiIndexUserFilter,
} from './space_filter';

describe('buildAiIndexSpaceFilter', () => {
  it('matches documents scoped to the space or to the global wildcard', () => {
    expect(buildAiIndexSpaceFilter('marketing')).toEqual({
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
                  should: [
                    { term: { [`${AI_INDEX_PRIVILEGES_PATH}.space`]: 'marketing' } },
                    { term: { [`${AI_INDEX_PRIVILEGES_PATH}.space`]: '*' } },
                  ],
                  minimum_should_match: 1,
                },
              },
            },
          },
        ],
        minimum_should_match: 1,
      },
    });
  });
});

describe('buildAiIndexUserFilter', () => {
  const dests = [
    { type: 'index', value: 'ai-index-idx-user-memories' },
    { type: 'data_stream', value: 'ai-index-ds-notes' },
  ];

  it('is not needed when no AI index keeps users apart', () => {
    expect(buildAiIndexUserFilter([], ['u-1'])).toBeUndefined();
  });

  it('keeps other indices, and only the caller’s KIs in user-scoped ones', () => {
    expect(buildAiIndexUserFilter(dests, ['u-1', 'jdoe'])).toEqual({
      bool: {
        should: [
          {
            bool: {
              must_not: [
                { term: { _index: 'ai-index-idx-user-memories' } },
                { prefix: { _index: '.ds-ai-index-ds-notes-' } },
              ],
            },
          },
          { prefix: { id: 'u-1/' } },
          { prefix: { id: 'jdoe/' } },
        ],
        minimum_should_match: 1,
      },
    });
  });

  it('hides every KI of user-scoped indices from a caller with no user id', () => {
    expect(buildAiIndexUserFilter(dests, [])?.bool?.should).toHaveLength(1);
  });
});
