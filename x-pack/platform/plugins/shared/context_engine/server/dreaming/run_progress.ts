/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ElasticsearchClient, Logger } from '@kbn/core/server';
import type { IndexStorageSettings, IStorageClient } from '@kbn/storage-adapter';
import { StorageIndexAdapter, types } from '@kbn/storage-adapter';
import type { DreamingCursor, DreamingRetryEntry } from '../../common/dreaming';
import type { ApplyCounts } from './apply';
import type { DreamingOperation } from './resolve_change_set';

export const dreamingRunsIndexName = '.contextengine-dreaming-runs';

/** Progress of runs that never committed is dropped after this long. */
const RUN_PROGRESS_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CLEANUP_DOCS = 1000;

const storageSettings = {
  name: dreamingRunsIndexName,
  schema: {
    properties: {
      kind: types.keyword({}),
      space: types.keyword({}),
      ai_index_id: types.keyword({}),
      execution_id: types.keyword({}),
      task_id: types.keyword({}),
      status: types.keyword({}),
      created_at: types.date({}),
      // Read back whole and never queried.
      run: types.object({ enabled: false }),
      task: types.object({ enabled: false }),
    },
  },
} satisfies IndexStorageSettings;

/** One task of a run: a group's memories, read in order. */
export interface DreamingTask {
  task_id: string;
  group_key: string;
  user_id?: string;
  session_id?: string;
  memory_ids: string[];
  /** Where the task's group resumes from if it doesn't finish. */
  from: DreamingCursor;
}

export interface DreamingRunPlan {
  tasks: DreamingTask[];
  /** `undefined` leaves the cursor where it is. */
  new_cursor?: DreamingCursor;
  /** Retry entries this run took over, removed from `retry` on commit. */
  consumed_retry: DreamingRetryEntry[];
  /** Retry entries for groups over the run's memory cap. */
  deferred_retry: DreamingRetryEntry[];
  dry_run: boolean;
}

export type DreamingTaskStatus = 'planned' | 'done';

export interface DreamingTaskProgress {
  operations: DreamingOperation[];
  rejected: number;
  counts?: ApplyCounts;
}

interface DreamingRunDocument {
  kind: 'run' | 'task';
  space: string;
  ai_index_id: string;
  execution_id: string;
  task_id?: string;
  status?: DreamingTaskStatus;
  created_at: string;
  run?: DreamingRunPlan;
  task?: DreamingTaskProgress;
}

type DreamingRunsStorageClient = IStorageClient<typeof storageSettings, DreamingRunDocument>;

/** Plans and per-task progress of dreaming runs, kept until the run commits. */
export class DreamingRunProgress {
  private readonly client: DreamingRunsStorageClient;

  constructor({ esClient, logger }: { esClient: ElasticsearchClient; logger: Logger }) {
    this.client = new StorageIndexAdapter<typeof storageSettings, DreamingRunDocument>(
      esClient,
      logger,
      storageSettings
    ).getClient();
  }

  async saveRun({ spaceId, aiIndexId, executionId }: RunKey, run: DreamingRunPlan): Promise<void> {
    await this.client.index({
      id: runDocId(spaceId, aiIndexId, executionId),
      document: {
        kind: 'run',
        space: spaceId,
        ai_index_id: aiIndexId,
        execution_id: executionId,
        created_at: new Date().toISOString(),
        run,
      },
      refresh: 'wait_for',
    });
  }

  async getRun({ spaceId, aiIndexId, executionId }: RunKey): Promise<DreamingRunPlan | undefined> {
    const document = await this.findById(runDocId(spaceId, aiIndexId, executionId));
    return document?.run;
  }

  async getTask(
    key: RunKey,
    taskId: string
  ): Promise<{ status: DreamingTaskStatus; progress: DreamingTaskProgress } | undefined> {
    const document = await this.findById(taskDocId(key, taskId));
    return document?.status && document.task
      ? { status: document.status, progress: document.task }
      : undefined;
  }

  async saveTask(
    { spaceId, aiIndexId, executionId }: RunKey,
    taskId: string,
    status: DreamingTaskStatus,
    progress: DreamingTaskProgress
  ): Promise<void> {
    await this.client.index({
      id: taskDocId({ spaceId, aiIndexId, executionId }, taskId),
      document: {
        kind: 'task',
        space: spaceId,
        ai_index_id: aiIndexId,
        execution_id: executionId,
        task_id: taskId,
        status,
        created_at: new Date().toISOString(),
        task: progress,
      },
      refresh: 'wait_for',
    });
  }

  async doneTaskIds({ spaceId, aiIndexId, executionId }: RunKey): Promise<Set<string>> {
    const response = await this.client.search({
      size: MAX_CLEANUP_DOCS,
      track_total_hits: false,
      _source: ['task_id'],
      query: {
        bool: {
          filter: [
            { term: { kind: 'task' } },
            { term: { space: spaceId } },
            { term: { ai_index_id: aiIndexId } },
            { term: { execution_id: executionId } },
            { term: { status: 'done' } },
          ],
        },
      },
    });
    return new Set(response.hits.hits.flatMap(({ _source: source }) => source?.task_id ?? []));
  }

  /** Drops this run's progress, and any older run's that never committed. */
  async clear({ spaceId, aiIndexId, executionId }: RunKey): Promise<void> {
    const cutoff = new Date(Date.now() - RUN_PROGRESS_RETENTION_MS).toISOString();
    const response = await this.client.search({
      size: MAX_CLEANUP_DOCS,
      track_total_hits: false,
      _source: false,
      query: {
        bool: {
          filter: [{ term: { space: spaceId } }, { term: { ai_index_id: aiIndexId } }],
          should: [
            { term: { execution_id: executionId } },
            { range: { created_at: { lt: cutoff } } },
          ],
          minimum_should_match: 1,
        },
      },
    });
    const ids = response.hits.hits.flatMap(({ _id: id }) => id ?? []);
    if (ids.length === 0) {
      return;
    }
    await this.client.bulk({ operations: ids.map((id) => ({ delete: { _id: id } })) });
  }

  private async findById(id: string): Promise<DreamingRunDocument | undefined> {
    const response = await this.client.search({
      size: 1,
      track_total_hits: false,
      query: { ids: { values: [id] } },
    });
    return response.hits.hits[0]?._source;
  }
}

export interface RunKey {
  spaceId: string;
  aiIndexId: string;
  executionId: string;
}

// A colon is safe: neither a space id nor an AI index id may contain one.
const runDocId = (spaceId: string, aiIndexId: string, executionId: string): string =>
  `${spaceId}:${aiIndexId}:${executionId}`;

const taskDocId = ({ spaceId, aiIndexId, executionId }: RunKey, taskId: string): string =>
  `${runDocId(spaceId, aiIndexId, executionId)}:task:${taskId}`;
