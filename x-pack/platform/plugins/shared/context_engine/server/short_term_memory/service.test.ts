/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ElasticsearchClient } from '@kbn/core/server';
import type { ShortTermMemory } from '../../common/dreaming';
import { ShortTermMemoryExistsError } from './errors';
import { ShortTermMemoryService, type ShortTermMemoryClient } from './service';

describe('ShortTermMemoryService', () => {
  const create = jest.fn();
  const search = jest.fn();
  const client = { create, search } as unknown as ShortTermMemoryClient;
  const assertTargets = jest.fn();

  const service = new ShortTermMemoryService({
    getClient: async () => client,
    esClient: {} as unknown as ElasticsearchClient,
    assertTargets,
  });

  const memory: ShortTermMemory = {
    '@timestamp': '2026-10-25T10:00:00.000Z',
    id: 'm-1',
    session_id: 's-1',
    content: 'Gold members fly most in July.',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    create.mockResolvedValue({ items: [{ create: {} }] });
    search.mockResolvedValue({ hits: { hits: [] } });
    assertTargets.mockResolvedValue(undefined);
  });

  describe('remember', () => {
    it('stores an untargeted memory without checking targets', async () => {
      await service.remember('default', memory);

      expect(assertTargets).not.toHaveBeenCalled();
      expect(create).toHaveBeenCalledWith({
        space: 'default',
        documents: [{ _id: 'm-1', ...memory }],
        refresh: 'wait_for',
      });
    });

    it('stores an empty target list as missing, so it applies to every AI index', async () => {
      await service.remember('default', { ...memory, ai_index_ids: [] });

      expect(assertTargets).not.toHaveBeenCalled();
      expect(create.mock.calls[0][0].documents[0]).not.toHaveProperty('ai_index_ids');
    });

    it('checks each distinct target before storing it', async () => {
      await service.remember('default', { ...memory, ai_index_ids: ['a', 'b', 'a'] });

      expect(assertTargets).toHaveBeenCalledWith(
        'default',
        ['a', 'b'],
        expect.objectContaining({ id: 'm-1' })
      );
      expect(create.mock.calls[0][0].documents[0].ai_index_ids).toEqual(['a', 'b']);
    });

    it('refuses a memory without content', async () => {
      await expect(service.remember('default', { ...memory, content: '' })).rejects.toThrow(
        "Short-term memory 'm-1' needs content."
      );
      expect(create).not.toHaveBeenCalled();
    });

    it('reports a memory id that is already stored', async () => {
      create.mockResolvedValue({
        items: [{ create: { error: { type: 'version_conflict_engine_exception', reason: 'x' } } }],
      });

      await expect(service.remember('default', memory)).rejects.toBeInstanceOf(
        ShortTermMemoryExistsError
      );
    });

    it('writes nothing when a target is refused', async () => {
      assertTargets.mockRejectedValue(new Error("AI index 'a' not found"));

      await expect(service.remember('default', { ...memory, ai_index_ids: ['a'] })).rejects.toThrow(
        "AI index 'a' not found"
      );
      expect(create).not.toHaveBeenCalled();
    });
  });

  describe('pull', () => {
    it('reads only memories the AI index may dream', async () => {
      await service.pull('default', {
        until: '2026-10-25T10:00:00.000Z',
        groupBy: 'session_id',
        aiIndexId: 'support-insights',
        size: 10,
      });

      expect(search.mock.calls[0][0].query.bool.filter).toContainEqual({
        bool: {
          should: [
            { bool: { must_not: { exists: { field: 'ai_index_ids' } } } },
            { term: { ai_index_ids: 'support-insights' } },
          ],
          minimum_should_match: 1,
        },
      });
    });

    it('reads only targeted memories about a user for a user-scoped AI index', async () => {
      await service.pull('default', {
        until: '2026-10-25T10:00:00.000Z',
        groupBy: 'user_id',
        aiIndexId: 'user-memories',
        userScoped: true,
        size: 10,
      });

      expect(search.mock.calls[0][0].query.bool.filter).toContainEqual({
        bool: {
          filter: [{ term: { ai_index_ids: 'user-memories' } }, { exists: { field: 'user_id' } }],
        },
      });
    });

    it('reads every memory without an AI index', async () => {
      await service.pull('default', {
        until: '2026-10-25T10:00:00.000Z',
        groupBy: 'session_id',
        size: 10,
      });

      expect(search.mock.calls[0][0].query.bool.filter).toHaveLength(1);
    });
  });

  describe('search', () => {
    it('searches content by meaning among memories the caller may see', async () => {
      search.mockResolvedValue({ hits: { hits: [{ _source: memory, _score: 4.5 }] } });

      await expect(
        service.search('default', {
          query: 'when do gold members fly',
          size: 5,
          aiIndexIds: ['support'],
          userIds: ['u_jdoe', 'jdoe'],
        })
      ).resolves.toEqual([{ ...memory, score: 4.5 }]);
      expect(search.mock.calls[0][0]).toEqual({
        space: 'default',
        size: 5,
        track_total_hits: false,
        query: {
          bool: {
            must: [{ match: { content: 'when do gold members fly' } }],
            filter: [
              {
                bool: {
                  should: [
                    { bool: { must_not: { exists: { field: 'ai_index_ids' } } } },
                    { terms: { ai_index_ids: ['support'] } },
                  ],
                  minimum_should_match: 1,
                },
              },
              {
                bool: {
                  should: [
                    { bool: { must_not: { exists: { field: 'user_id' } } } },
                    { terms: { user_id: ['u_jdoe', 'jdoe'] } },
                  ],
                  minimum_should_match: 1,
                },
              },
            ],
          },
        },
      });
    });

    it('finds only untargeted, shared memories for a caller with no AI index or identity', async () => {
      await service.search('default', { query: 'x', size: 5, aiIndexIds: [], userIds: [] });

      expect(search.mock.calls[0][0].query.bool.filter).toEqual([
        { bool: { must_not: { exists: { field: 'ai_index_ids' } } } },
        { bool: { must_not: { exists: { field: 'user_id' } } } },
      ]);
    });
  });
});
