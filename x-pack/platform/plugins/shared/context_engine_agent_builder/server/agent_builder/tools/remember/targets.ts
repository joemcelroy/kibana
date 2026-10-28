/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ContextEnginePluginStart } from '@kbn/context-engine-plugin/server';
import type { MemoryTarget } from '@kbn/context-engine-plugin/server/dreaming/request_dream';

export type MemoryTargetsApi = Pick<ContextEnginePluginStart, 'resolveMemoryTargets'>;

/**
 * Picks the AI indices a memory goes to.
 *
 * - An Agent Builder agent writes to its own AI indices that take memories. `requested` picks
 *   among them. Otherwise a memory about the user goes to all of them, and any other memory goes
 *   to the shared ones, or to the user-scoped ones when the agent has nothing else.
 * - Without an agent (MCP), only `requested` is used, and an empty list leaves the memory
 *   untargeted, so every AI index with dreaming on may use it.
 *
 * Throws when a requested AI index is not one the memory may go to.
 */
export const chooseMemoryTargets = async ({
  contextEngine,
  spaceId,
  agentAiIndices,
  requested,
  aboutUser,
}: {
  contextEngine: MemoryTargetsApi;
  spaceId: string;
  /** The agent's configured AI indices; `undefined` outside an agent. */
  agentAiIndices?: readonly string[];
  requested?: readonly string[];
  aboutUser: boolean;
}): Promise<MemoryTarget[]> => {
  const wanted = [...new Set(requested ?? [])];
  if (agentAiIndices === undefined) {
    if (wanted.length === 0) {
      return [];
    }
    const targets = await contextEngine.resolveMemoryTargets({ spaceId, aiIndexIds: wanted });
    const missing = wanted.filter((id) => !targets.some(({ aiIndexId }) => aiIndexId === id));
    if (missing.length > 0) {
      throw new Error(
        `AI indices not found or without memory: ${missing.map((id) => `'${id}'`).join(', ')}`
      );
    }
    return targets;
  }

  const agentTargets = await contextEngine.resolveMemoryTargets({
    spaceId,
    aiIndexIds: agentAiIndices,
  });
  if (wanted.length > 0) {
    const outside = wanted.filter((id) => !agentTargets.some(({ aiIndexId }) => aiIndexId === id));
    if (outside.length > 0) {
      throw new Error(
        `${outside.map((id) => `'${id}'`).join(', ')} not among this agent's memory AI indices: ${
          agentTargets.map(({ aiIndexId }) => `'${aiIndexId}'`).join(', ') || 'none'
        }`
      );
    }
    return agentTargets.filter(({ aiIndexId }) => wanted.includes(aiIndexId));
  }
  if (aboutUser) {
    return agentTargets;
  }
  const shared = agentTargets.filter(({ memoryScope }) => memoryScope === 'shared');
  return shared.length > 0 ? shared : agentTargets;
};
