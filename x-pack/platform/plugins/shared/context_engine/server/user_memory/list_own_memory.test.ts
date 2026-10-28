/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AiIndexService } from '../ai_indices/service';
import { listOwnMemory } from './list_own_memory';

describe('listOwnMemory', () => {
  const aiIndices: Record<string, { memory_enabled: boolean; memory_scope?: 'user' }> = {
    elastic: { memory_enabled: false },
    'user-memories': { memory_enabled: true, memory_scope: 'user' },
    notes: { memory_enabled: true },
  };
  const aiIndexService = {
    get: jest.fn(async (id: string) => ({
      id,
      ...aiIndices[id],
      description: `${id} description`,
      dest: { type: 'index', value: `ai-index-idx-${id}` },
    })),
    list: jest.fn(async () =>
      Object.entries(aiIndices).map(([id, settings]) => ({ id, ...settings }))
    ),
  } as unknown as Pick<AiIndexService, 'get' | 'list'>;
  const query = jest.fn();

  beforeEach(() => {
    query.mockReset();
  });

  it('reads the caller’s KIs from each AI index that takes memories', async () => {
    query.mockImplementation(async ({ query: esql }: { query: string }) =>
      esql.startsWith('FROM ai-index-idx-user-memories')
        ? {
            columns: [
              { name: 'id', type: 'keyword' },
              { name: 'type', type: 'keyword' },
              { name: 'title', type: 'text' },
              { name: 'content', type: 'text' },
              { name: 'updated_at', type: 'date' },
            ],
            values: [['u1/entity-user-profile', 'entity.user', 'profile', '## Work', null]],
          }
        : { columns: [], values: [] }
    );

    const result = await listOwnMemory({
      aiIndexService,
      dataRead: { query },
      spaceId: 'default',
      userIds: ['u1', 'jdoe'],
      aiIndexIds: ['elastic', 'user-memories', 'notes'],
    });

    expect(result).toEqual([
      {
        id: 'user-memories',
        description: 'user-memories description',
        memory_scope: 'user',
        kis: [
          {
            id: 'u1/entity-user-profile',
            type: 'entity.user',
            title: 'profile',
            content: '## Work',
          },
        ],
      },
      { id: 'notes', description: 'notes description', memory_scope: 'shared', kis: [] },
    ]);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][0]).toEqual(
      expect.objectContaining({ params: { owner_prefix_0: 'u1/', owner_prefix_1: 'jdoe/' } })
    );
    expect(query.mock.calls[0][0].query).toContain(
      'STARTS_WITH(id, ?owner_prefix_0) OR STARTS_WITH(id, ?owner_prefix_1)'
    );
  });

  it('reads every AI index that keeps each user’s memory apart when none are named', async () => {
    query.mockResolvedValue({ columns: [], values: [] });

    const result = await listOwnMemory({
      aiIndexService,
      dataRead: { query },
      spaceId: 'default',
      userIds: ['u1'],
    });

    expect(result.map(({ id }) => id)).toEqual(['user-memories']);
    expect(aiIndexService.list).toHaveBeenCalledWith('default');
  });

  it('reports an AI index it cannot read and still returns the others', async () => {
    query.mockRejectedValueOnce(new Error('Forbidden'));
    query.mockResolvedValueOnce({ columns: [], values: [] });

    const result = await listOwnMemory({
      aiIndexService,
      dataRead: { query },
      spaceId: 'default',
      userIds: ['u1'],
      aiIndexIds: ['user-memories', 'notes'],
    });

    expect(result[0]).toEqual(expect.objectContaining({ kis: [], error: 'Forbidden' }));
    expect(result[1]).toEqual(expect.objectContaining({ id: 'notes', kis: [] }));
  });
});
