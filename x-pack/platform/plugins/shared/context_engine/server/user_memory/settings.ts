/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ElasticsearchClient, Logger } from '@kbn/core/server';
import type { IndexStorageSettings, IStorageClient } from '@kbn/storage-adapter';
import { StorageIndexAdapter, types } from '@kbn/storage-adapter';

export const memorySettingsIndexName = '.contextengine-memory-settings';

const storageSettings = {
  name: memorySettingsIndexName,
  schema: {
    properties: {
      space: types.keyword({}),
      user_id: types.keyword({}),
      learn_from_conversations: types.boolean({}),
      updated_at: types.date({}),
    },
  },
} satisfies IndexStorageSettings;

interface MemorySettingsDocument {
  space: string;
  user_id: string;
  learn_from_conversations: boolean;
  updated_at: string;
}

type MemorySettingsStorageClient = IStorageClient<typeof storageSettings, MemorySettingsDocument>;

export interface MemorySettingsServiceApi {
  /** Whether a user lets agents learn from their conversations in a space. Unset means yes. */
  learnsFromConversations(spaceId: string, userIds: readonly string[]): Promise<boolean>;
  setLearnFromConversations(
    spaceId: string,
    userIds: readonly string[],
    learn: boolean
  ): Promise<void>;
}

const docId = (spaceId: string, userId: string) => `${spaceId}:${userId}`;

/**
 * Each user's own memory settings, per space. A user is stored under every id their memory can be
 * owned by (profile uid and username), so a check by either finds it.
 */
export class MemorySettingsService implements MemorySettingsServiceApi {
  private readonly client: MemorySettingsStorageClient;

  constructor({ esClient, logger }: { esClient: ElasticsearchClient; logger: Logger }) {
    this.client = new StorageIndexAdapter<typeof storageSettings, MemorySettingsDocument>(
      esClient,
      logger,
      storageSettings
    ).getClient();
  }

  async learnsFromConversations(spaceId: string, userIds: readonly string[]): Promise<boolean> {
    if (userIds.length === 0) {
      return true;
    }
    const response = await this.client.search({
      size: userIds.length,
      track_total_hits: false,
      query: { ids: { values: userIds.map((userId) => docId(spaceId, userId)) } },
    });
    return !response.hits.hits.some((hit) => hit._source?.learn_from_conversations === false);
  }

  async setLearnFromConversations(
    spaceId: string,
    userIds: readonly string[],
    learn: boolean
  ): Promise<void> {
    const updatedAt = new Date().toISOString();
    for (const userId of userIds) {
      await this.client.index({
        id: docId(spaceId, userId),
        document: {
          space: spaceId,
          user_id: userId,
          learn_from_conversations: learn,
          updated_at: updatedAt,
        },
        refresh: 'wait_for',
      });
    }
  }
}
