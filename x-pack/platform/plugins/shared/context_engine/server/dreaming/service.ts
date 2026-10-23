/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Logger } from '@kbn/core/server';
import type { DreamingRetryEntry, DreamingRunStatus } from '../../common/dreaming';
import type { AiIndexService } from '../ai_indices/service';
import type { ShortTermMemoryServiceApi } from '../short_term_memory/service';
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
  private readonly shortTermMemory: ShortTermMemoryServiceApi;
  private readonly runProgress: DreamingRunProgress;
  private readonly logger: Logger;

  constructor({
    aiIndexService,
    shortTermMemory,
    runProgress,
    logger,
  }: {
    aiIndexService: AiIndexService;
    shortTermMemory: ShortTermMemoryServiceApi;
    runProgress: DreamingRunProgress;
    logger: Logger;
  }) {
    this.aiIndexService = aiIndexService;
    this.shortTermMemory = shortTermMemory;
    this.runProgress = runProgress;
    this.logger = logger;
  }

  async start(
    key: RunKey,
    { target, dryRun, now = new Date() }: { target?: DreamingTarget; dryRun: boolean; now?: Date }
  ): Promise<StartedDreamingRun> {
    const { aiIndexId, spaceId, executionId } = key;
    const dreaming = await this.aiIndexService.getDreaming(aiIndexId, spaceId);
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
      shortTermMemory: this.shortTermMemory,
      spaceId,
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
    return {
      status: warning && status === 'succeeded' ? 'partial' : status,
      tasks: plan.tasks.length,
      failed_tasks: failed.length,
      cursor_moved: cursorMoved,
      ...(warning && { warning }),
    };
  }
}
