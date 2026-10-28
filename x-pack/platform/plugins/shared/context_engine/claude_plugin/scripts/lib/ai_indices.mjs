/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

export const AI_INDEX_PATH = '/api/context_engine/ai_index';
export const REMEMBER_PATH = '/api/context_engine/_remember';
export const RECALL_PATH = '/api/context_engine/_recall';
export const SAVE_TRANSCRIPT_PATH = '/api/context_engine/_save_transcript';
export const OWN_MEMORY_SETTINGS_PATH = '/internal/context_engine/memory/_mine/settings';

/** At most this many AI indices per memory or transcript. */
export const MAX_TARGET_AI_INDICES = 20;

export const aiIndexPath = (aiIndexId, suffix = '') =>
  `${AI_INDEX_PATH}/${encodeURIComponent(aiIndexId)}${suffix}`;

/**
 * Whether an AI index takes recorded rounds: memory on, per user, dreaming on with rounds. The
 * same check as Context Engine's `resolveRoundTargets`: a round shows what its user can read, so
 * it never goes to an AI index others read.
 */
const takesRounds = async (client, aiIndex) => {
  if (!aiIndex.memory_enabled || aiIndex.memory_scope !== 'user') {
    return false;
  }
  try {
    const { dreaming } = await client.get(aiIndexPath(aiIndex.id, '/_dreaming'));
    return dreaming?.enabled === true && dreaming.rounds === true;
  } catch {
    return false;
  }
};

/**
 * The AI indices the caller can read, as Agent Builder lists an agent's: id, ES|QL target,
 * description and memory settings. `aiIndexIds`, when set, keeps only those, like an agent's own
 * AI index list.
 */
export const listCatalog = async (client, { aiIndexIds = [] } = {}) => {
  const { ai_indices: aiIndices = [] } = await client.get(AI_INDEX_PATH);
  const chosen =
    aiIndexIds.length > 0 ? aiIndices.filter(({ id }) => aiIndexIds.includes(id)) : aiIndices;
  return Promise.all(
    chosen.map(async (aiIndex) => ({
      id: aiIndex.id,
      esqlTarget: aiIndex.dest?.value,
      description: aiIndex.description,
      memoryEnabled: aiIndex.memory_enabled === true,
      memoryScope: aiIndex.memory_enabled ? aiIndex.memory_scope ?? 'shared' : undefined,
      takesRounds: await takesRounds(client, aiIndex),
    }))
  );
};

export const roundTargetsOf = (catalog) =>
  catalog
    .filter(({ takesRounds: rounds }) => rounds)
    .map(({ id }) => id)
    .slice(0, MAX_TARGET_AI_INDICES);

/** Whether the caller lets agents learn from their conversations. Unknown counts as no. */
export const learnsFromConversations = async (client) => {
  try {
    const settings = await client.get(OWN_MEMORY_SETTINGS_PATH, { internal: true });
    return settings?.learn_from_conversations !== false;
  } catch {
    return false;
  }
};
