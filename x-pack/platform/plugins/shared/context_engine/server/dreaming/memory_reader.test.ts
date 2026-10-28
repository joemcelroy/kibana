/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ShortTermMemory, Transcript } from '../../common/dreaming';
import { createDreamingMemoryReader } from './memory_reader';

const memory = (id: string, minute: number): ShortTermMemory => ({
  '@timestamp': `2026-10-28T10:${String(minute).padStart(2, '0')}:00.000Z`,
  id,
  session_id: 'conv-1',
  user_id: 'u-1',
  content: `Memory ${id}.`,
});

const transcript = (id: string, minute: number): Transcript => ({
  '@timestamp': `2026-10-28T10:${String(minute).padStart(2, '0')}:00.000Z`,
  id,
  session_id: 'conv-1',
  user_id: 'u-1',
  raw: `Transcript ${id}.`,
  ai_index_ids: ['user-memories'],
});

describe('createDreamingMemoryReader', () => {
  const shortTermMemory = { pull: jest.fn(), getByIds: jest.fn(), forget: jest.fn() };
  const transcripts = { pull: jest.fn(), getByIds: jest.fn(), delete: jest.fn() };
  const reader = createDreamingMemoryReader({ shortTermMemory, transcripts });
  const params = {
    until: '2026-10-28T11:00:00.000Z',
    groupBy: 'user_id' as const,
    aiIndexId: 'user-memories',
    size: 3,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    shortTermMemory.pull.mockResolvedValue({ memories: [] });
    transcripts.pull.mockResolvedValue({ transcripts: [] });
  });

  describe('pull', () => {
    it('reads memories and transcripts as one stream, in cursor order', async () => {
      shortTermMemory.pull.mockResolvedValue({ memories: [memory('m-1', 1), memory('m-3', 3)] });
      transcripts.pull.mockResolvedValue({ transcripts: [transcript('round-2', 2)] });

      const result = await reader.pull('default', params);

      expect(shortTermMemory.pull).toHaveBeenCalledWith('default', params);
      expect(transcripts.pull).toHaveBeenCalledWith('default', params);
      expect(result).toEqual({
        memories: [
          memory('m-1', 1),
          {
            '@timestamp': '2026-10-28T10:02:00.000Z',
            id: 'round-2',
            session_id: 'conv-1',
            user_id: 'u-1',
            transcript: 'Transcript round-2.',
            ai_index_ids: ['user-memories'],
          },
          memory('m-3', 3),
        ],
      });
    });

    it('keeps the first page of both together and continues after it', async () => {
      shortTermMemory.pull.mockResolvedValue({ memories: [memory('m-1', 1), memory('m-4', 4)] });
      transcripts.pull.mockResolvedValue({
        transcripts: [transcript('round-2', 2), transcript('round-3', 3)],
      });

      const { memories, next } = await reader.pull('default', params);

      expect(memories.map(({ id }) => id)).toEqual(['m-1', 'round-2', 'round-3']);
      expect(next).toEqual({ timestamp: '2026-10-28T10:03:00.000Z', memory_id: 'round-3' });
    });

    it('continues when one source filled its page, even if the merged page is short', async () => {
      shortTermMemory.pull.mockResolvedValue({
        memories: [memory('m-1', 1)],
        next: { timestamp: '2026-10-28T10:01:00.000Z', memory_id: 'm-1' },
      });

      const { next } = await reader.pull('default', { ...params, size: 1 });

      expect(next).toEqual({ timestamp: '2026-10-28T10:01:00.000Z', memory_id: 'm-1' });
    });
  });

  it('finds memories and transcripts by id', async () => {
    shortTermMemory.getByIds.mockResolvedValue([memory('m-3', 3)]);
    transcripts.getByIds.mockResolvedValue([transcript('round-2', 2)]);

    const found = await reader.getByIds('default', ['m-3', 'round-2']);

    expect(found.map(({ id }) => id)).toEqual(['round-2', 'm-3']);
  });

  describe('forget', () => {
    it('deletes a short-term memory', async () => {
      shortTermMemory.forget.mockResolvedValue(memory('m-1', 1));

      await expect(reader.forget('default', 'm-1')).resolves.toEqual(memory('m-1', 1));
      expect(transcripts.delete).not.toHaveBeenCalled();
    });

    it('deletes a transcript when no memory has the id', async () => {
      shortTermMemory.forget.mockResolvedValue(undefined);
      transcripts.delete.mockResolvedValue(transcript('round-2', 2));

      await expect(reader.forget('default', 'round-2')).resolves.toEqual(
        expect.objectContaining({ id: 'round-2', transcript: 'Transcript round-2.' })
      );
    });
  });
});
