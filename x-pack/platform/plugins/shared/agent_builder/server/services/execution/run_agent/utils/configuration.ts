/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Logger } from '@kbn/logging';
import type { KibanaRequest } from '@kbn/core-http-server';
import type {
  AiIndexResolver,
  UserMemoryEntry,
  UserMemoryProvider,
} from '@kbn/agent-builder-server';
import type { AgentConfiguration } from '@kbn/agent-builder-common';
import type { ResolvedConfiguration } from '../types';
import { resolveAiIndexCatalog } from './resolve_ai_index_catalog';

/** What the agent knows about the user; nothing when the provider fails, so the run goes on. */
const resolveUserMemory = async ({
  aiIndices,
  request,
  provider,
  logger,
}: {
  aiIndices: string[];
  request: KibanaRequest;
  provider?: UserMemoryProvider;
  logger?: Logger;
}): Promise<UserMemoryEntry[]> => {
  if (!provider || aiIndices.length === 0) {
    return [];
  }
  try {
    return await provider({ aiIndexIds: aiIndices, request });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger?.warn(`Failed to load user memory, running without it: ${message}`);
    return [];
  }
};

export const resolveConfiguration = async (
  configuration: AgentConfiguration,
  {
    aiIndicesEnabled,
    request,
    resolver,
    userMemoryProvider,
    logger,
  }: {
    aiIndicesEnabled: boolean;
    request: KibanaRequest;
    resolver?: AiIndexResolver;
    userMemoryProvider?: UserMemoryProvider;
    logger?: Logger;
  }
): Promise<ResolvedConfiguration> => {
  const base: ResolvedConfiguration = {
    instructions: configuration.instructions ?? '',
    aiIndices: configuration.ai_indices ?? [],
  };

  if (!aiIndicesEnabled) return base;

  const [aiIndexCatalog, userMemory] = await Promise.all([
    resolveAiIndexCatalog({
      aiIndices: base.aiIndices,
      request,
      resolver,
      logger,
    }),
    resolveUserMemory({
      aiIndices: base.aiIndices,
      request,
      provider: userMemoryProvider,
      logger,
    }),
  ]);
  return {
    ...base,
    aiIndexCatalog,
    ...(userMemory.length > 0 && { userMemory }),
  };
};
