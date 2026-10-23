/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ElasticsearchClient } from '@kbn/core/server';
import type { AiIndexHttpItem } from '../../common/http_api/ai_indices';
import type { AiIndexService } from '../ai_indices/service';
import { DreamingForbiddenError, InvalidDreamingConfigError } from './errors';

/**
 * Checks that the caller may dream for an AI index: memory is enabled on it and the caller can
 * write to its backing store. Reading short-term memory is only allowed after this passes,
 * because that read runs as the internal user.
 */
export const authorizeDreaming = async ({
  aiIndexId,
  spaceId,
  aiIndexService,
  currentUserClient,
}: {
  aiIndexId: string;
  spaceId: string;
  aiIndexService: AiIndexService;
  currentUserClient: ElasticsearchClient;
}): Promise<AiIndexHttpItem> => {
  const aiIndex = await aiIndexService.get(aiIndexId, spaceId);
  if (!aiIndex.memory_enabled) {
    throw new InvalidDreamingConfigError(
      `AI index '${aiIndexId}' does not have memory enabled, so it cannot dream.`
    );
  }
  const { has_all_requested: hasAllRequested } = await currentUserClient.security.hasPrivileges({
    index: [{ names: [aiIndex.dest.value], privileges: ['write'] }],
  });
  if (!hasAllRequested) {
    throw new DreamingForbiddenError(
      `Missing write privilege on '${aiIndex.dest.value}', the backing store of AI index '${aiIndexId}'.`
    );
  }
  return aiIndex;
};
