/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { errors } from '@elastic/elasticsearch';
import { isAiIndexDest, missingIndicesOf, withoutSources } from './missing_indices';

const esqlError = (error: Record<string, unknown>) =>
  new errors.ResponseError({
    meta: {
      aborted: false,
      attempts: 1,
      connection: null,
      context: null,
      name: 'response_error',
      request: {} as never,
    },
    warnings: [],
    body: { error, status: 400 },
    statusCode: 400,
  });

describe('missingIndicesOf', () => {
  it('reads the index of a query that also named existing indices', () => {
    expect(
      missingIndicesOf(
        esqlError({ type: 'index_not_found_exception', index: 'ai-index-idx-user-memories' })
      )
    ).toEqual(['ai-index-idx-user-memories']);
  });

  it('reads every index a verification error calls unknown', () => {
    expect(
      missingIndicesOf(
        esqlError({
          type: 'verification_exception',
          reason: 'Found 1 problem\nline 1:1: Unknown index [ai-index-idx-a, ai-index-idx-b]',
        })
      )
    ).toEqual(['ai-index-idx-a', 'ai-index-idx-b']);
  });

  it('ignores every other error', () => {
    expect(missingIndicesOf(new Error('boom'))).toEqual([]);
    expect(
      missingIndicesOf(esqlError({ type: 'verification_exception', reason: 'Unknown column [x]' }))
    ).toEqual([]);
  });
});

describe('isAiIndexDest', () => {
  const dests = [{ type: 'index' as const, value: 'ai-index-idx-a, ai-index-idx-b' }];

  it('matches a registered backing index by name', () => {
    expect(isAiIndexDest('ai-index-idx-b', dests)).toBe(true);
    expect(isAiIndexDest('logs-app', dests)).toBe(false);
  });
});

describe('withoutSources', () => {
  it('drops missing sources and keeps the rest of the query', () => {
    expect(
      withoutSources('FROM ai-index-idx-a, ai-index-idx-b METADATA _id | LIMIT 5', [
        'ai-index-idx-b',
      ])
    ).toBe('FROM ai-index-idx-a METADATA _id | LIMIT 5');
  });

  it('reports a query left with no source', () => {
    expect(withoutSources('FROM ai-index-idx-a | LIMIT 5', ['ai-index-idx-a'])).toBeUndefined();
  });

  it('leaves a query it cannot change as it is', () => {
    expect(withoutSources('FROM ai-index-idx-a | LIMIT 5', ['other'])).toBe(
      'FROM ai-index-idx-a | LIMIT 5'
    );
    expect(withoutSources('FROM |', ['ai-index-idx-a'])).toBe('FROM |');
  });
});
