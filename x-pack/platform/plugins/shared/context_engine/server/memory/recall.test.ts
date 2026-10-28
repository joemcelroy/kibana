/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AiIndexHttpItem } from '../../common/http_api/ai_indices';
import { MAX_RECALL_CONTENT_LENGTH } from '../../common/http_api/memory';
import type { AiIndexDataReadServiceApi } from '../ai_indices/data_read_service';
import { recallQuery, searchAiIndices, searchShortTermMemory } from './recall';

const aiIndex = (id: string, dest: string) =>
  ({ id, dest: { type: 'index', value: dest } } as AiIndexHttpItem);

const columns = ['id', 'type', 'title', 'description', 'content', 'updated_at', '_score'].map(
  (name) => ({ name, type: 'keyword' })
);

const row = (id: string, score: number, content = `content of ${id}`) => [
  id,
  'fact.preference',
  `title of ${id}`,
  null,
  content,
  '2026-10-27T10:00:00.000Z',
  score,
];

const createDataRead = (
  aiIndices: AiIndexHttpItem[],
  rowsByDest: Record<string, unknown[][] | Error>
) => {
  const dataRead = {
    list: jest.fn(async (ids?: string[]) =>
      ids ? aiIndices.filter(({ id }) => ids.includes(id)) : aiIndices
    ),
    query: jest.fn(async ({ query }: { query: string }) => {
      const dest = Object.keys(rowsByDest).find((name) => query.startsWith(`FROM ${name} `));
      const rows = dest ? rowsByDest[dest] : [];
      if (rows instanceof Error) {
        throw rows;
      }
      return { columns, values: rows };
    }),
  };
  // The read service's response types are ES|QL's; the rows here are plain values.
  return dataRead as unknown as typeof dataRead & Pick<AiIndexDataReadServiceApi, 'list' | 'query'>;
};

describe('recallQuery', () => {
  it('fuses lexical and semantic matches over the KI text fields', () => {
    const query = recallQuery('ai-index-idx-user-memories', 10);

    // FUSE fails without _index in METADATA.
    expect(query).toContain('FROM ai-index-idx-user-memories METADATA _id, _index, _score');
    expect(query).toContain('MATCH(content, ?query)');
    expect(query).toContain('MATCH(content.semantic, ?query)');
    expect(query).toContain('| FUSE');
    expect(query).toContain('| LIMIT 10');
  });
});

describe('searchAiIndices', () => {
  const userMemories = aiIndex('user-memories', 'ai-index-idx-user-memories');
  const support = aiIndex('support', 'ai-index-idx-support');

  it('searches each AI index given and merges the results by score', async () => {
    const dataRead = createDataRead([userMemories, support], {
      'ai-index-idx-user-memories': [row('me/profile', 0.03), row('me/fact-1', 0.01)],
      'ai-index-idx-support': [row('shared/fact-2', 0.02)],
    });

    const { results, errors } = await searchAiIndices({
      dataRead,
      query: 'seat preference',
      aiIndexIds: ['user-memories', 'support'],
      limit: 2,
    });

    expect(dataRead.query).toHaveBeenCalledWith(
      expect.objectContaining({ params: { query: 'seat preference' }, limit: 2 })
    );
    expect(results.map(({ ai_index_id: aiIndexId, id }) => `${aiIndexId}:${id}`)).toEqual([
      'user-memories:me/profile',
      'support:shared/fact-2',
    ]);
    expect(results[0]).toEqual({
      ai_index_id: 'user-memories',
      id: 'me/profile',
      type: 'fact.preference',
      title: 'title of me/profile',
      content: 'content of me/profile',
      updated_at: '2026-10-27T10:00:00.000Z',
      score: 0.03,
    });
    expect(errors).toEqual([]);
  });

  it('searches every readable AI index when none are given', async () => {
    const dataRead = createDataRead([userMemories, support], {});

    await searchAiIndices({ dataRead, query: 'anything' });

    expect(dataRead.list).toHaveBeenCalledWith(undefined);
    expect(dataRead.query).toHaveBeenCalledTimes(2);
  });

  it('searches nothing for an empty list of AI indices', async () => {
    const dataRead = createDataRead([userMemories], {});

    expect(await searchAiIndices({ dataRead, query: 'anything', aiIndexIds: [] })).toEqual({
      results: [],
      errors: [],
    });
    expect(dataRead.list).not.toHaveBeenCalled();
  });

  it('reports AI indices it cannot read or search, and still returns the rest', async () => {
    const dataRead = createDataRead([userMemories, support], {
      'ai-index-idx-user-memories': [row('me/profile', 0.03)],
      'ai-index-idx-support': new Error('Unknown column [content.semantic]'),
    });

    const { results, errors } = await searchAiIndices({
      dataRead,
      query: 'anything',
      aiIndexIds: ['user-memories', 'support', 'missing'],
    });

    expect(results.map(({ id }) => id)).toEqual(['me/profile']);
    expect(errors).toEqual([
      { ai_index_id: 'missing', message: 'AI index not found or not readable.' },
      { ai_index_id: 'support', message: 'Unknown column [content.semantic]' },
    ]);
  });

  it('cuts long content', async () => {
    const dataRead = createDataRead([support], {
      'ai-index-idx-support': [row('shared/doc', 0.1, 'x'.repeat(MAX_RECALL_CONTENT_LENGTH + 50))],
    });

    const { results } = await searchAiIndices({
      dataRead,
      query: 'anything',
      aiIndexIds: ['support'],
    });

    expect(results[0].content).toHaveLength(MAX_RECALL_CONTENT_LENGTH + 1);
  });
});

describe('searchShortTermMemory', () => {
  const aiIndices = [
    aiIndex('support', 'ai-index-idx-support'),
    aiIndex('user-memories', 'ai-index-idx-user-memories'),
  ];
  const memory = {
    '@timestamp': '2026-10-28T10:00:00.000Z',
    id: 'm-1',
    session_id: 'conv-1',
    content: 'Gold members fly most in July.',
    score: 3.2,
  };
  const search = jest.fn();
  const recallMemories = (aiIndexIds?: string[]) =>
    searchShortTermMemory({
      dataRead: createDataRead(aiIndices, {}),
      shortTermMemory: { search },
      spaceId: 'default',
      userIds: ['u_jdoe', 'jdoe'],
      query: 'when do gold members fly',
      aiIndexIds,
      limit: 5,
    });

  beforeEach(() => {
    search.mockReset();
    search.mockResolvedValue([]);
  });

  it('searches the memories the caller may see through the AI indices they can read', async () => {
    await recallMemories();

    expect(search).toHaveBeenCalledWith('default', {
      query: 'when do gold members fly',
      size: 5,
      aiIndexIds: ['support', 'user-memories'],
      userIds: ['u_jdoe', 'jdoe'],
    });
  });

  it('narrows to the AI indices given, reporting one it cannot read', async () => {
    const { errors } = await recallMemories(['support', 'payroll']);

    expect(search.mock.calls[0][1].aiIndexIds).toEqual(['support']);
    expect(errors).toEqual([
      { ai_index_id: 'payroll', message: 'AI index not found or not readable.' },
    ]);
  });

  it('returns each memory with when it was recorded and whether it is about the caller', async () => {
    search.mockResolvedValue([
      memory,
      {
        ...memory,
        id: 'm-2',
        user_id: 'u_jdoe',
        occurred_at: '2026-10-27T09:00:00.000Z',
        ai_index_ids: ['user-memories'],
        content: 'x'.repeat(MAX_RECALL_CONTENT_LENGTH + 10),
        score: 2.1,
      },
    ]);

    const { results } = await recallMemories();

    expect(results).toEqual([
      {
        id: 'm-1',
        session_id: 'conv-1',
        content: 'Gold members fly most in July.',
        recorded_at: '2026-10-28T10:00:00.000Z',
        about_user: false,
        score: 3.2,
      },
      expect.objectContaining({
        id: 'm-2',
        recorded_at: '2026-10-27T09:00:00.000Z',
        about_user: true,
        ai_index_ids: ['user-memories'],
        score: 2.1,
      }),
    ]);
    expect(results[1].content).toHaveLength(MAX_RECALL_CONTENT_LENGTH + 1);
  });
});
