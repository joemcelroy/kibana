/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Logger } from '@kbn/core/server';
import {
  ROUND_RETENTION_MS,
  type DreamingRetryEntry,
  type DreamingRunStatus,
} from '../../common/dreaming';
import type { AiIndexService } from '../ai_indices/service';
import type { TranscriptServiceApi } from '../transcripts/service';
import type { DreamingMemoryReader } from './memory_reader';
import { DreamingRunInProgressError, InvalidDreamingConfigError } from './errors';
import { planRun, type DreamingTarget } from './plan_run';
import type { DreamingRunProgress, RunKey } from './run_progress';
import {
  closeRun,
  completeRun,
  mergeRetryEntries,
  runningExecutionId,
  startRun,
  stateOf,
} from './state';

/** Recorded rounds past their retention that one run deletes at most. */
const EXPIRED_ROUNDS_PER_RUN = 500;

export interface StartedDreamingRun {
  tasks: Array<{ task_id: string; group_key: string; count: number }>;
  dry_run: boolean;
}

export interface CommittedDreamingRun {
  status: Exclude<DreamingRunStatus, 'running'>;
  tasks: number;
  failed_tasks: number;
  cursor_moved: boolean;
  /** Set when the retry list was full, so the cursor stayed put. */
  warning?: string;
}

/** Starts and ends dreaming runs: claims the AI index, plans the tasks, and commits progress. */
export class DreamingService {
  private readonly aiIndexService: AiIndexService;
  private readonly memoryReader: DreamingMemoryReader;
  private readonly transcripts: Pick<TranscriptServiceApi, 'deleteBefore'>;
  private readonly runProgress: DreamingRunProgress;
  private readonly logger: Logger;

  constructor({
    aiIndexService,
    memoryReader,
    transcripts,
    runProgress,
    logger,
  }: {
    aiIndexService: AiIndexService;
    memoryReader: DreamingMemoryReader;
    transcripts: Pick<TranscriptServiceApi, 'deleteBefore'>;
    runProgress: DreamingRunProgress;
    logger: Logger;
  }) {
    this.aiIndexService = aiIndexService;
    this.memoryReader = memoryReader;
    this.transcripts = transcripts;
    this.runProgress = runProgress;
    this.logger = logger;
  }

  async start(
    key: RunKey,
    { target, dryRun, now = new Date() }: { target?: DreamingTarget; dryRun: boolean; now?: Date }
  ): Promise<StartedDreamingRun> {
    const { aiIndexId, spaceId, executionId } = key;
    const [dreaming, aiIndex] = await Promise.all([
      this.aiIndexService.getDreaming(aiIndexId, spaceId),
      this.aiIndexService.get(aiIndexId, spaceId),
    ]);
    if (!dreaming?.enabled) {
      throw new InvalidDreamingConfigError(
        `Dreaming is not turned on for AI index '${aiIndexId}'.`
      );
    }

    await this.aiIndexService.updateDreamingState(aiIndexId, spaceId, (current) => {
      const running = runningExecutionId(stateOf(current), now);
      if (running !== undefined && running !== executionId) {
        throw new DreamingRunInProgressError(aiIndexId, running);
      }
      return startRun(current, executionId, now);
    });

    const plan = await planRun({
      memoryReader: this.memoryReader,
      spaceId,
      aiIndexId,
      userScoped: aiIndex.memory_scope === 'user',
      dreaming,
      target,
      dryRun,
      now,
    });
    await this.runProgress.saveRun(key, plan);
    this.logger.debug(
      `Dreaming run '${executionId}' for AI index '${aiIndexId}' planned ${plan.tasks.length} tasks`
    );
    return {
      tasks: plan.tasks.map(({ task_id: taskId, group_key: groupKey, memory_ids: ids }) => ({
        task_id: taskId,
        group_key: groupKey,
        count: ids.length,
      })),
      dry_run: dryRun,
    };
  }

  /**
   * Ends a run. Tasks that didn't finish go to `retry` at their start position; the cursor moves
   * past what the run read, unless `retry` is full, in which case nothing is lost by keeping it.
   */
  async commit(key: RunKey, now: Date = new Date()): Promise<CommittedDreamingRun> {
    const { aiIndexId, spaceId, executionId } = key;
    const plan = await this.runProgress.getRun(key);
    if (!plan) {
      throw new InvalidDreamingConfigError(
        `Dreaming run '${executionId}' has no plan for AI index '${aiIndexId}'.`
      );
    }
    const done = await this.runProgress.doneTaskIds(key);
    const failed = plan.tasks.filter(({ task_id: taskId }) => !done.has(taskId));
    const status: CommittedDreamingRun['status'] =
      failed.length === 0
        ? 'succeeded'
        : failed.length === plan.tasks.length
        ? 'failed'
        : 'partial';

    if (plan.dry_run) {
      await this.aiIndexService.updateDreamingState(aiIndexId, spaceId, (current) =>
        closeRun(current, executionId, status, now)
      );
      await this.runProgress.clear(key);
      return {
        status,
        tasks: plan.tasks.length,
        failed_tasks: failed.length,
        cursor_moved: false,
      };
    }

    const additions: DreamingRetryEntry[] = [
      ...failed.map(({ group_key: groupKey, from }) => ({ group_key: groupKey, from })),
      ...plan.deferred_retry,
    ];
    let cursorMoved = false;
    let warning: string | undefined;
    await this.aiIndexService.updateDreamingState(aiIndexId, spaceId, (current) => {
      const queued = stateOf(current).retry.filter(
        (entry) =>
          !plan.consumed_retry.some(({ group_key: groupKey }) => groupKey === entry.group_key)
      );
      const { overflow } = mergeRetryEntries(queued, additions);
      const keepCursor = overflow.length > 0;
      cursorMoved = !keepCursor && plan.new_cursor !== undefined;
      warning = keepCursor
        ? `The retry list is full; ${overflow.length} groups were not queued, so the cursor did not move.`
        : undefined;
      return completeRun(
        current,
        {
          execution_id: executionId,
          ...(!keepCursor && plan.new_cursor && { cursor: plan.new_cursor }),
          retry: additions,
          consumed: plan.consumed_retry,
        },
        keepCursor && status === 'succeeded' ? 'partial' : status,
        now
      );
    });
    await this.runProgress.clear(key);
    if (warning) {
      this.logger.warn(`Dreaming run '${executionId}' for AI index '${aiIndexId}': ${warning}`);
    }
    await this.expireRounds(spaceId, now);
    return {
      status: warning && status === 'succeeded' ? 'partial' : status,
      tasks: plan.tasks.length,
      failed_tasks: failed.length,
      cursor_moved: cursorMoved,
      ...(warning && { warning }),
    };
  }

  /**
   * Deletes the space's transcripts past their retention, a batch per run. Never fails the
   * run: what is left is deleted by a later one.
   */
  private async expireRounds(spaceId: string, now: Date): Promise<void> {
    try {
      const before = new Date(now.getTime() - ROUND_RETENTION_MS).toISOString();
      const deleted = await this.transcripts.deleteBefore(spaceId, before, EXPIRED_ROUNDS_PER_RUN);
      if (deleted > 0) {
        this.logger.debug(`Deleted ${deleted} transcripts older than ${before} in '${spaceId}'`);
      }
    } catch (error) {
      this.logger.warn(`Could not delete expired transcripts in '${spaceId}': ${error}`);
    }
  }
}
