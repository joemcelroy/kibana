/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { isEsqlQuery } from './esql';

describe('isEsqlQuery', () => {
  it.each([
    'FROM ai-index-idx-support | WHERE type == "fact.preference" | LIMIT 5',
    'from ai-index-idx-support',
    'TS ai-index-ds-metrics | STATS max(cpu)',
  ])('takes %s as ES|QL', (query) => {
    expect(isEsqlQuery(query)).toBe(true);
  });

  it.each([
    'which seat does the user prefer?',
    'From what I remember, which seat does the user prefer?',
    'ROW a = 1',
    '',
  ])('takes %s as plain words', (query) => {
    expect(isEsqlQuery(query)).toBe(false);
  });
});
