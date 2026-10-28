/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ElasticsearchClient } from '@kbn/core/server';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import { MemorySettingsService } from './settings';

const search = jest.fn();
const index = jest.fn();

jest.mock('@kbn/storage-adapter', () => ({
  ...jest.requireActual('@kbn/storage-adapter'),
  StorageIndexAdapter: jest.fn().mockImplementation(() => ({
    getClient: () => ({ search, index }),
  })),
}));

describe('MemorySettingsService', () => {
  const service = new MemorySettingsService({
    esClient: {} as ElasticsearchClient,
    logger: loggingSystemMock.createLogger(),
  });

  beforeEach(() => jest.clearAllMocks());

  it('lets agents learn from a user’s conversations until they say otherwise', async () => {
    search.mockResolvedValue({ hits: { hits: [] } });

    await expect(service.learnsFromConversations('default', ['u_jdoe', 'jdoe'])).resolves.toBe(
      true
    );
    expect(search.mock.calls[0][0].query).toEqual({
      ids: { values: ['default:u_jdoe', 'default:jdoe'] },
    });
  });

  it('stops when the user turned it off under any of their ids', async () => {
    search.mockResolvedValue({
      hits: { hits: [{ _source: { learn_from_conversations: false } }] },
    });

    await expect(service.learnsFromConversations('default', ['u_jdoe', 'jdoe'])).resolves.toBe(
      false
    );
  });

  it('stores the switch under each of the user’s ids', async () => {
    await service.setLearnFromConversations('default', ['u_jdoe', 'jdoe'], false);

    expect(index.mock.calls.map(([request]) => request.id)).toEqual([
      'default:u_jdoe',
      'default:jdoe',
    ]);
    expect(index.mock.calls[0][0].document).toEqual(
      expect.objectContaining({
        space: 'default',
        user_id: 'u_jdoe',
        learn_from_conversations: false,
      })
    );
  });
});
