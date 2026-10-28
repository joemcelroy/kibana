/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { forgetRounds } from './forget_rounds';

describe('forgetRounds', () => {
  it('forgets each of the user’s rounds, page by page, and counts them', async () => {
    const pages = [Array.from({ length: 100 }, (_, index) => `round-${index}`), ['round-100']];
    const listIds = jest.fn(async () => pages.shift() ?? []);
    const forget = jest.fn(async () => ({ forgotten: true, ai_index_ids: ['user-memories'] }));

    await expect(
      forgetRounds({ transcripts: { listIds }, forget, spaceId: 'default', userId: 'u-1' })
    ).resolves.toEqual({ forgotten: 101 });
    expect(listIds).toHaveBeenCalledWith('default', 'u-1', 100);
    expect(forget).toHaveBeenCalledWith('default', 'round-100');
  });

  it('stops when a page cannot be forgotten, instead of reading it again forever', async () => {
    const listIds = jest.fn(async () => Array.from({ length: 100 }, (_, i) => `round-${i}`));
    const forget = jest.fn(async () => ({ forgotten: false, ai_index_ids: [] }));

    await expect(
      forgetRounds({ transcripts: { listIds }, forget, spaceId: 'default', userId: 'u-1' })
    ).resolves.toEqual({ forgotten: 0 });
    expect(listIds).toHaveBeenCalledTimes(1);
  });
});
