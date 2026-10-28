/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ElasticsearchClient } from '@kbn/core/server';
import type { Transcript } from '../../common/dreaming';
import { TranscriptExistsError } from './errors';
import { TranscriptService, type TranscriptClient } from './service';

describe('TranscriptService', () => {
  const create = jest.fn();
  const search = jest.fn();
  const bulk = jest.fn();
  const assertTargets = jest.fn();
  const service = new TranscriptService({
    getClient: async () => ({ create, search } as unknown as TranscriptClient),
    esClient: { bulk } as unknown as ElasticsearchClient,
    assertTargets,
  });

  const transcript: Transcript = {
    '@timestamp': '2026-10-28T10:00:00.000Z',
    id: 'round-1',
    session_id: 'conv-1',
    user_id: 'u-1',
    raw: '## User\nWhich seat do I like?\n## Answer\nAn aisle seat.',
    ai_index_ids: ['user-memories'],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    create.mockResolvedValue({ items: [{ create: {} }] });
    search.mockResolvedValue({ hits: { hits: [] } });
    assertTargets.mockResolvedValue(undefined);
  });

  describe('save', () => {
    it('checks each distinct target, then stores the transcript', async () => {
      await service.save('default', { ...transcript, ai_index_ids: ['a', 'b', 'a'] });

      expect(assertTargets).toHaveBeenCalledWith(
        'default',
        ['a', 'b'],
        expect.objectContaining({ user_id: 'u-1' })
      );
      expect(create).toHaveBeenCalledWith({
        space: 'default',
        documents: [{ _id: 'round-1', ...transcript, ai_index_ids: ['a', 'b'] }],
        refresh: 'wait_for',
      });
    });

    it.each([
      ['an empty transcript', { raw: '' }, "Transcript 'round-1' is empty."],
      ['no user', { user_id: '' }, "Transcript 'round-1' must name its user."],
      [
        'no AI index, since that would mean all of them',
        { ai_index_ids: [] },
        "Transcript 'round-1' must name the AI indices it is for.",
      ],
    ])('refuses %s', async (_, change, message) => {
      await expect(service.save('default', { ...transcript, ...change })).rejects.toThrow(message);
      expect(create).not.toHaveBeenCalled();
    });

    it('writes nothing when a target is refused', async () => {
      assertTargets.mockRejectedValue(new Error("AI index 'user-memories' does not take rounds"));

      await expect(service.save('default', transcript)).rejects.toThrow('does not take rounds');
      expect(create).not.toHaveBeenCalled();
    });

    it('reports a transcript id that is already stored', async () => {
      create.mockResolvedValue({
        items: [{ create: { error: { type: 'version_conflict_engine_exception', reason: 'x' } } }],
      });

      await expect(service.save('default', transcript)).rejects.toBeInstanceOf(
        TranscriptExistsError
      );
    });
  });

  describe('pull', () => {
    it('reads only transcripts naming the AI index, never untargeted ones', async () => {
      await service.pull('default', {
        until: '2026-10-28T10:00:00.000Z',
        groupBy: 'user_id',
        aiIndexId: 'support-insights',
        size: 10,
      });

      expect(search.mock.calls[0][0].query.bool.filter).toContainEqual({
        term: { ai_index_ids: 'support-insights' },
      });
    });

    it('continues after the cursor and reports the next one when the page is full', async () => {
      search.mockResolvedValue({ hits: { hits: [{ _source: transcript }] } });

      const result = await service.pull('default', {
        after: { timestamp: '2026-10-28T09:00:00.000Z', memory_id: 'round-0' },
        until: '2026-10-28T10:00:00.000Z',
        groupBy: 'user_id',
        size: 1,
      });

      expect(search.mock.calls[0][0].search_after).toEqual([
        Date.parse('2026-10-28T09:00:00.000Z'),
        'round-0',
      ]);
      expect(result).toEqual({
        transcripts: [transcript],
        next: { timestamp: '2026-10-28T10:00:00.000Z', memory_id: 'round-1' },
      });
    });
  });

  it('lists a user’s transcripts', async () => {
    search.mockResolvedValue({ hits: { hits: [{ _source: { id: 'round-1' } }] } });

    await expect(service.listIds('default', 'u-1', 10)).resolves.toEqual(['round-1']);
    expect(search.mock.calls[0][0]).toMatchObject({
      space: 'default',
      size: 10,
      query: { bool: { filter: [{ term: { user_id: 'u-1' } }] } },
    });
  });

  describe('deleteBefore', () => {
    it('deletes transcripts written before a time from their backing index', async () => {
      search.mockResolvedValue({
        hits: { hits: [{ _index: '.ds-transcripts-1', _id: 'default:round-1' }] },
      });

      await expect(service.deleteBefore('default', '2026-09-28T00:00:00.000Z', 500)).resolves.toBe(
        1
      );
      expect(search.mock.calls[0][0].query.bool.filter).toEqual([
        { range: { '@timestamp': { lt: '2026-09-28T00:00:00.000Z' } } },
      ]);
      expect(bulk).toHaveBeenCalledWith({
        operations: [{ delete: { _index: '.ds-transcripts-1', _id: 'default:round-1' } }],
        refresh: 'wait_for',
      });
    });

    it('deletes nothing when no transcript is old enough', async () => {
      await expect(service.deleteBefore('default', '2026-09-28T00:00:00.000Z', 500)).resolves.toBe(
        0
      );
      expect(bulk).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('deletes a transcript and returns it', async () => {
      search.mockResolvedValue({
        hits: {
          hits: [{ _index: '.ds-transcripts-1', _id: 'default:round-1', _source: transcript }],
        },
      });

      await expect(service.delete('default', 'round-1')).resolves.toEqual(transcript);
      expect(bulk).toHaveBeenCalledWith({
        operations: [{ delete: { _index: '.ds-transcripts-1', _id: 'default:round-1' } }],
        refresh: 'wait_for',
      });
    });

    it('returns nothing for an unknown id', async () => {
      await expect(service.delete('default', 'round-9')).resolves.toBeUndefined();
      expect(bulk).not.toHaveBeenCalled();
    });
  });
});
