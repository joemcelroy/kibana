/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ElasticsearchClient } from '@kbn/core/server';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import type { DreamingMemory } from '../../common/dreaming';
import type { AiIndexService } from '../ai_indices/service';
import type { DreamingMemoryReader } from './memory_reader';
import { markStale } from './apply';
import { forgetMemory } from './forget';
import { findKisDerivedFrom } from './long_term';

jest.mock('./apply', () => ({ markStale: jest.fn() }));
jest.mock('./long_term', () => ({ findKisDerivedFrom: jest.fn() }));

const mockMarkStale = jest.mocked(markStale);
const mockFindKisDerivedFrom = jest.mocked(findKisDerivedFrom);

describe('forgetMemory', () => {
  const memory: DreamingMemory = {
    '@timestamp': '2026-10-27T10:00:00.000Z',
    id: 'round-1',
    session_id: 'conv-1',
    user_id: 'u-1',
    transcript: '## User\nWhich seat?',
  };
  const getByIds = jest.fn();
  const forget = jest.fn();
  const memoryReader = { getByIds, forget } as unknown as DreamingMemoryReader;
  const updateDreamingState = jest.fn();
  const aiIndexService = {
    listDreaming: jest.fn(async () => [
      { id: 'support', dest: { value: 'ai-index-idx-support' }, dreaming: {} },
      {
        id: 'user-memories',
        dest: { value: '.ai-index-idx-user-memories' },
        dreaming: {},
        hidden: true,
      },
    ]),
    updateDreamingState,
  } as unknown as AiIndexService;
  const esClient = {} as ElasticsearchClient;
  const internalEsClient = {} as ElasticsearchClient;

  const run = () =>
    forgetMemory({
      spaceId: 'default',
      memoryId: 'round-1',
      memoryReader,
      aiIndexService,
      esClient,
      internalEsClient,
      logger: loggingSystemMock.createLogger(),
    });

  beforeEach(() => {
    jest.clearAllMocks();
    getByIds.mockResolvedValue([memory]);
    mockFindKisDerivedFrom.mockResolvedValue([{ id: 'u-1/fact-1' }] as never);
    mockMarkStale.mockResolvedValue(true);
  });

  it('marks what was dreamed from the memory stale, queues it, then deletes the memory', async () => {
    await expect(run()).resolves.toEqual({
      forgotten: true,
      ai_index_ids: ['support', 'user-memories'],
    });

    expect(mockMarkStale).toHaveBeenCalledWith(
      expect.objectContaining({ esClient, aiIndexId: 'support' }),
      'u-1/fact-1',
      'round-1'
    );
    expect(updateDreamingState).toHaveBeenCalled();
    expect(forget).toHaveBeenCalledWith('default', 'round-1');
    expect(mockMarkStale.mock.invocationCallOrder[0]).toBeLessThan(
      forget.mock.invocationCallOrder[0]
    );
  });

  it("writes a hidden AI index's system index as Kibana", async () => {
    await run();

    const [userMemories] = mockMarkStale.mock.calls.filter(
      ([context]) => context.aiIndexId === 'user-memories'
    );
    expect(userMemories[0].esClient).toBe(internalEsClient);
    expect(userMemories[0].esClient).not.toBe(esClient);
    expect(mockFindKisDerivedFrom).toHaveBeenCalledWith(
      expect.objectContaining({ esClient: internalEsClient })
    );
  });

  it('keeps the memory when its KIs cannot be marked, so it can be forgotten again', async () => {
    mockMarkStale.mockRejectedValue(new Error('security_exception'));

    await expect(run()).rejects.toThrow('security_exception');
    expect(forget).not.toHaveBeenCalled();
  });

  it('forgets nothing for a memory that does not exist', async () => {
    getByIds.mockResolvedValue([]);

    await expect(run()).resolves.toEqual({ forgotten: false, ai_index_ids: [] });
    expect(forget).not.toHaveBeenCalled();
  });
});
