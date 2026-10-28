/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ElasticsearchClient, KibanaRequest } from '@kbn/core/server';
import {
  DEFAULT_DREAMING_GROUP_BY,
  MAX_SHORT_TERM_AI_INDEX_IDS,
  SHARED_MEMORY_OWNER,
  type ShortTermMemory,
} from '../../common/dreaming';
import type { AiIndexMemoryScope } from '../../common/http_api/ai_indices';
import { AiIndexNotFoundError } from '../ai_indices/errors';
import type { AiIndexService } from '../ai_indices/service';
import { authorizeDreaming } from './authorize';
import { InvalidDreamingConfigError } from './errors';
import type { DreamingTarget } from './plan_run';
import type { DreamingScheduleService } from './schedule';

/** What happened to one AI index's dream request. */
export interface DreamRequestResult {
  aiIndexId: string;
  status: 'started' | 'skipped';
  /** The workflow execution, when started. It may wait for a run already in progress. */
  runId?: string;
  /** Why the request was skipped. */
  reason?: string;
}

const uniqueTargets = (aiIndexIds: readonly string[]): string[] => {
  const targets = [...new Set(aiIndexIds)];
  if (targets.length > MAX_SHORT_TERM_AI_INDEX_IDS) {
    throw new InvalidDreamingConfigError(
      `A memory can target at most ${MAX_SHORT_TERM_AI_INDEX_IDS} AI indices.`
    );
  }
  return targets;
};

/**
 * Checks what the internal user can see alone: each AI index a memory targets exists in the
 * space and has memory turned on, and one that keeps each user's memory apart gets a memory
 * about a user. Callers check the user's write privilege themselves.
 */
export const assertMemoryTargets = async ({
  aiIndexService,
  spaceId,
  aiIndexIds,
  userId,
  round = false,
}: {
  aiIndexService: Pick<AiIndexService, 'get' | 'getDreaming'>;
  spaceId: string;
  aiIndexIds: readonly string[];
  userId?: string;
  /** The memory records a conversation round: see {@link resolveRoundTargets}. */
  round?: boolean;
}): Promise<void> => {
  if (round && userId === undefined) {
    throw new InvalidDreamingConfigError('A recorded round must be about a user.');
  }
  for (const aiIndexId of uniqueTargets(aiIndexIds)) {
    const aiIndex = await aiIndexService.get(aiIndexId, spaceId);
    if (round && !(await takesRounds(aiIndexService, aiIndex, spaceId))) {
      throw new InvalidDreamingConfigError(
        `AI index '${aiIndexId}' does not take conversation rounds: it must have memory and dreaming on, with rounds not turned off.`
      );
    }
    if (!aiIndex.memory_enabled) {
      throw new InvalidDreamingConfigError(
        `AI index '${aiIndexId}' does not have memory enabled, so a memory cannot target it.`
      );
    }
    if (aiIndex.memory_scope === 'user' && userId === undefined) {
      throw new InvalidDreamingConfigError(
        `AI index '${aiIndexId}' keeps each user's memory apart, so a memory targeting it must be about a user.`
      );
    }
  }
};

/** Whether an AI index takes recorded rounds: memory on, dreaming on, rounds not turned off. */
const takesRounds = async (
  aiIndexService: Pick<AiIndexService, 'getDreaming'>,
  aiIndex: { id: string; memory_enabled?: boolean },
  spaceId: string
): Promise<boolean> => {
  if (!aiIndex.memory_enabled) {
    return false;
  }
  const dreaming = await aiIndexService.getDreaming(aiIndex.id, spaceId);
  return dreaming?.enabled === true && dreaming.rounds !== false;
};

/**
 * The AI indices among `aiIndexIds` that take recorded conversation rounds: memory on, and dreaming
 * on without `rounds: false`. A shared AI index takes them too, so what a round shows its user can
 * reach everyone who reads that AI index. Unknown ids are left out.
 */
export const resolveRoundTargets = async ({
  aiIndexService,
  spaceId,
  aiIndexIds,
}: {
  aiIndexService: Pick<AiIndexService, 'get' | 'getDreaming'>;
  spaceId: string;
  aiIndexIds: readonly string[];
}): Promise<string[]> => {
  const targets: string[] = [];
  for (const aiIndexId of new Set(aiIndexIds)) {
    try {
      const aiIndex = await aiIndexService.get(aiIndexId, spaceId);
      if (await takesRounds(aiIndexService, aiIndex, spaceId)) {
        targets.push(aiIndexId);
      }
    } catch (error) {
      if (!(error instanceof AiIndexNotFoundError)) {
        throw error;
      }
    }
  }
  return targets;
};

/** An AI index a memory can target, and whose memory it holds. */
export interface MemoryTarget {
  aiIndexId: string;
  memoryScope: AiIndexMemoryScope;
}

/**
 * The AI indices among `aiIndexIds` that take memories, in order. Unknown ones and ones without
 * memory are left out, so an agent's AI index list can be passed as it is.
 */
export const resolveMemoryTargets = async ({
  aiIndexService,
  spaceId,
  aiIndexIds,
}: {
  aiIndexService: Pick<AiIndexService, 'get'>;
  spaceId: string;
  aiIndexIds: readonly string[];
}): Promise<MemoryTarget[]> => {
  const targets: MemoryTarget[] = [];
  for (const aiIndexId of new Set(aiIndexIds)) {
    try {
      const aiIndex = await aiIndexService.get(aiIndexId, spaceId);
      if (aiIndex.memory_enabled) {
        targets.push({ aiIndexId, memoryScope: aiIndex.memory_scope ?? 'shared' });
      }
    } catch (error) {
      if (!(error instanceof AiIndexNotFoundError)) {
        throw error;
      }
    }
  }
  return targets;
};

/**
 * Checks that the user may write memories for each targeted AI index: the same check that lets
 * them dream for it, because dreaming is how a targeted memory reaches the AI index.
 */
export const authorizeMemoryTargets = async ({
  aiIndexService,
  spaceId,
  aiIndexIds,
  currentUserClient,
}: {
  aiIndexService: AiIndexService;
  spaceId: string;
  aiIndexIds: readonly string[];
  currentUserClient: ElasticsearchClient;
}): Promise<void> => {
  for (const aiIndexId of uniqueTargets(aiIndexIds)) {
    await authorizeDreaming({ aiIndexId, spaceId, aiIndexService, currentUserClient });
  }
};

/** The group a run must dream so that it includes `memory`, under the AI index's `group_by`. */
export const dreamTargetOf = (
  memory: Pick<ShortTermMemory, 'session_id' | 'user_id'>,
  groupBy = DEFAULT_DREAMING_GROUP_BY
): DreamingTarget =>
  groupBy === 'session_id'
    ? { session_id: memory.session_id }
    : { user_id: memory.user_id ?? SHARED_MEMORY_OWNER };

/**
 * Starts a targeted dreaming run on each AI index for the group `memory` belongs to, as the
 * request's user. A run requested while another is in progress is queued by the workflow. Each
 * AI index is handled on its own: one that can't dream is reported as skipped, and the memory
 * waits for its next scheduled run.
 */
export const requestDream = async ({
  aiIndexService,
  dreamingSchedule,
  spaceId,
  aiIndexIds,
  memory,
  request,
  currentUserClient,
}: {
  aiIndexService: AiIndexService;
  dreamingSchedule: DreamingScheduleService;
  spaceId: string;
  aiIndexIds: readonly string[];
  memory: Pick<ShortTermMemory, 'session_id' | 'user_id'>;
  request: KibanaRequest;
  currentUserClient: ElasticsearchClient;
}): Promise<DreamRequestResult[]> => {
  const results: DreamRequestResult[] = [];
  for (const aiIndexId of uniqueTargets(aiIndexIds)) {
    try {
      await authorizeDreaming({ aiIndexId, spaceId, aiIndexService, currentUserClient });
      const dreaming = await aiIndexService.getDreaming(aiIndexId, spaceId);
      if (!dreaming?.enabled) {
        results.push({ aiIndexId, status: 'skipped', reason: 'Dreaming is not turned on.' });
        continue;
      }
      const runId = await dreamingSchedule.run({
        aiIndexId,
        spaceId,
        target: dreamTargetOf(memory, dreaming.group_by),
        dryRun: false,
        request,
      });
      results.push({ aiIndexId, status: 'started', runId });
    } catch (error) {
      results.push({
        aiIndexId,
        status: 'skipped',
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
};
