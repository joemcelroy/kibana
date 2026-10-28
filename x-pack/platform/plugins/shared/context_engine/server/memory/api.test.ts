/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { KibanaRequest } from '@kbn/core/server';
import type { AiIndexHttpItem } from '../../common/http_api/ai_indices';
import { createMemoryApi, type MemoryApiDeps } from './api';
import { InvalidMemoryRequestError, MemoryAccessDeniedError, MemoryDisabledError } from './errors';

describe('createMemoryApi', () => {
  const request = {} as KibanaRequest;
  const spaceId = 'default';
  const remember = jest.fn();
  const search = jest.fn();
  const save = jest.fn();
  const list = jest.fn();
  const query = jest.fn();
  const resolveMemoryTargets = jest.fn();
  const authorizeMemoryTargets = jest.fn();
  const requestDream = jest.fn();
  const getCurrentUser = jest.fn();
  const isMemoryEnabled = jest.fn();
  const hasPrivilege = jest.fn();
  let ids: number;

  const api = createMemoryApi({
    shortTermMemory: { remember, search },
    transcripts: { save },
    getDataRead: () => ({ list, query } as unknown as ReturnType<MemoryApiDeps['getDataRead']>),
    resolveMemoryTargets,
    authorizeMemoryTargets,
    requestDream,
    getCurrentUser,
    isMemoryEnabled,
    hasPrivilege,
    generateId: () => `id-${++ids}`,
    now: () => new Date('2026-10-28T12:00:00.000Z'),
  });

  const scopes: Record<string, 'shared' | 'user'> = {
    'support-insights': 'shared',
    'user-memories': 'user',
  };
  const aiIndex = (id: string) =>
    ({ id, dest: { type: 'index', value: `ai-index-idx-${id}` } } as AiIndexHttpItem);

  beforeEach(() => {
    jest.clearAllMocks();
    ids = 0;
    hasPrivilege.mockResolvedValue(true);
    isMemoryEnabled.mockResolvedValue(true);
    getCurrentUser.mockReturnValue({ username: 'jdoe', profile_uid: 'u_jdoe' });
    resolveMemoryTargets.mockImplementation(async (_space: string, aiIndexIds: string[]) =>
      aiIndexIds.flatMap((aiIndexId) =>
        scopes[aiIndexId] ? [{ aiIndexId, memoryScope: scopes[aiIndexId] }] : []
      )
    );
    authorizeMemoryTargets.mockResolvedValue(undefined);
    list.mockImplementation(async (wanted?: string[]) =>
      ['support-insights', 'user-memories']
        .filter((id) => !wanted || wanted.includes(id))
        .map(aiIndex)
    );
    query.mockResolvedValue({ columns: [], values: [] });
    search.mockResolvedValue([]);
  });

  describe('remember', () => {
    it('stores a shared, untargeted memory in a new session', async () => {
      await expect(
        api.remember({ spaceId, request, input: { content: 'Gold members fly in July.' } })
      ).resolves.toEqual({ id: 'id-1', session_id: 'id-2' });
      expect(remember).toHaveBeenCalledWith(spaceId, {
        '@timestamp': '2026-10-28T12:00:00.000Z',
        id: 'id-1',
        session_id: 'id-2',
        content: 'Gold members fly in July.',
      });
      expect(authorizeMemoryTargets).not.toHaveBeenCalled();
      expect(getCurrentUser).not.toHaveBeenCalled();
    });

    it('records the caller for a memory about them', async () => {
      await api.remember({
        spaceId,
        request,
        input: { content: 'Prefers aisle seats.', session_id: 's-1', about_user: true },
      });

      expect(remember.mock.calls[0][1]).toEqual(
        expect.objectContaining({ session_id: 's-1', user_id: 'u_jdoe' })
      );
    });

    it('checks targets as the caller, and records them for a user-scoped AI index', async () => {
      const response = await api.remember({
        spaceId,
        request,
        input: {
          content: 'Prefers aisle seats.',
          ai_index_ids: ['user-memories', 'user-memories'],
        },
      });

      expect(authorizeMemoryTargets).toHaveBeenCalledWith(spaceId, ['user-memories'], request);
      expect(remember.mock.calls[0][1]).toEqual(
        expect.objectContaining({ user_id: 'u_jdoe', ai_index_ids: ['user-memories'] })
      );
      expect(response.ai_index_ids).toEqual(['user-memories']);
    });

    it('starts a dream after storing, and returns it', async () => {
      requestDream.mockResolvedValue([
        { aiIndexId: 'support-insights', status: 'started', runId: 'run-9' },
      ]);

      const response = await api.remember({
        spaceId,
        request,
        input: { content: 'x', ai_index_ids: ['support-insights'], dream_now: true },
      });

      expect(requestDream).toHaveBeenCalledWith({
        spaceId,
        aiIndexIds: ['support-insights'],
        memory: expect.objectContaining({ id: 'id-1' }),
        request,
      });
      expect(response.dreams).toEqual([
        { ai_index_id: 'support-insights', status: 'started', run_id: 'run-9' },
      ]);
    });

    it.each([
      [
        'without the write privilege',
        () => hasPrivilege.mockResolvedValue(false),
        { content: 'x' },
        MemoryAccessDeniedError,
      ],
      [
        'with memory off',
        () => isMemoryEnabled.mockResolvedValue(false),
        { content: 'x' },
        MemoryDisabledError,
      ],
      [
        'to dream with no AI index',
        () => {},
        { content: 'x', dream_now: true },
        InvalidMemoryRequestError,
      ],
      [
        'for an AI index without memory',
        () => {},
        { content: 'x', ai_index_ids: ['nope'] },
        InvalidMemoryRequestError,
      ],
    ])('refuses to remember %s', async (_, arrange, input, error) => {
      arrange();

      await expect(api.remember({ spaceId, request, input })).rejects.toBeInstanceOf(error);
      expect(remember).not.toHaveBeenCalled();
    });
  });

  describe('recall', () => {
    it('runs an ES|QL query and returns its rows', async () => {
      query.mockResolvedValue({ columns: [{ name: 'title', type: 'text' }], values: [['FAQ']] });

      await expect(
        api.recall({
          spaceId,
          request,
          input: {
            query: 'FROM ai-index-idx-support | WHERE type == ?type',
            params: { type: 'faq' },
          },
        })
      ).resolves.toEqual({
        scope: 'ai-index',
        query_type: 'esql',
        columns: [{ name: 'title', type: 'text' }],
        values: [['FAQ']],
      });
      expect(query).toHaveBeenCalledWith({
        query: 'FROM ai-index-idx-support | WHERE type == ?type',
        params: { type: 'faq' },
        limit: 100,
      });
    });

    it('searches each readable AI index for plain words', async () => {
      await expect(
        api.recall({
          spaceId,
          request,
          input: { query: 'which seat?', ai_index_ids: ['user-memories'] },
        })
      ).resolves.toEqual({ scope: 'ai-index', query_type: 'text', results: [] });
      expect(query).toHaveBeenCalledTimes(1);
      expect(query.mock.calls[0][0]).toEqual(
        expect.objectContaining({ params: { query: 'which seat?' }, limit: 10 })
      );
    });

    it('searches short-term memory as the caller', async () => {
      await api.recall({ spaceId, request, input: { query: 'which seat?', scope: 'short-term' } });

      expect(search).toHaveBeenCalledWith(spaceId, {
        query: 'which seat?',
        size: 10,
        aiIndexIds: ['support-insights', 'user-memories'],
        userIds: ['u_jdoe', 'jdoe'],
      });
    });

    it.each([
      [
        'without the read privilege',
        () => hasPrivilege.mockResolvedValue(false),
        { query: 'x' },
        MemoryAccessDeniedError,
      ],
      [
        'short-term memory with memory off',
        () => isMemoryEnabled.mockResolvedValue(false),
        { query: 'x', scope: 'short-term' as const },
        MemoryDisabledError,
      ],
      [
        'ES|QL over short-term memory',
        () => {},
        { query: 'FROM a', scope: 'short-term' as const },
        InvalidMemoryRequestError,
      ],
      [
        'ES|QL with AI index ids',
        () => {},
        { query: 'FROM a', ai_index_ids: ['a'] },
        InvalidMemoryRequestError,
      ],
      [
        'ES|QL beyond the row cap',
        () => {},
        { query: 'FROM a', limit: 1001 },
        InvalidMemoryRequestError,
      ],
      [
        'params with plain words',
        () => {},
        { query: 'x', params: { a: 1 } },
        InvalidMemoryRequestError,
      ],
      [
        'plain words beyond the result cap',
        () => {},
        { query: 'x', limit: 51 },
        InvalidMemoryRequestError,
      ],
    ])('refuses %s', async (_, arrange, input, error) => {
      arrange();

      await expect(api.recall({ spaceId, request, input })).rejects.toBeInstanceOf(error);
      expect(query).not.toHaveBeenCalled();
      expect(search).not.toHaveBeenCalled();
    });
  });

  describe('saveTranscript', () => {
    const input = {
      session_id: 'conv-1',
      raw: '## User\nWhich seat?',
      ai_index_ids: ['user-memories', 'user-memories'],
    };

    it('saves a transcript about the caller, under a generated id', async () => {
      await expect(api.saveTranscript({ spaceId, request, input })).resolves.toEqual({
        id: 'transcript-id-1',
        ai_index_ids: ['user-memories'],
      });
      expect(authorizeMemoryTargets).toHaveBeenCalledWith(spaceId, ['user-memories'], request);
      expect(save).toHaveBeenCalledWith(spaceId, {
        '@timestamp': '2026-10-28T12:00:00.000Z',
        id: 'transcript-id-1',
        session_id: 'conv-1',
        user_id: 'u_jdoe',
        raw: '## User\nWhich seat?',
        ai_index_ids: ['user-memories'],
      });
    });

    it('records the username for a caller without a profile', async () => {
      getCurrentUser.mockReturnValue({ username: 'jdoe' });

      await api.saveTranscript({ spaceId, request, input: { ...input, id: 'round-1' } });

      expect(save.mock.calls[0][1]).toEqual(
        expect.objectContaining({ id: 'round-1', user_id: 'jdoe' })
      );
    });

    it('refuses with memory off, and without an identity', async () => {
      isMemoryEnabled.mockResolvedValueOnce(false);
      await expect(api.saveTranscript({ spaceId, request, input })).rejects.toBeInstanceOf(
        MemoryDisabledError
      );

      getCurrentUser.mockReturnValue(undefined);
      await expect(api.saveTranscript({ spaceId, request, input })).rejects.toBeInstanceOf(
        MemoryAccessDeniedError
      );
      expect(save).not.toHaveBeenCalled();
    });
  });
});
