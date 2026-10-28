/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ElasticsearchClient } from '@kbn/core/server';
import type { AiIndexDreamingConfig, DreamingMemory } from '../../common/dreaming';
import type { AiIndexDest } from '../../common/http_api/ai_indices';
import type { DreamingMemoryReader } from './memory_reader';
import {
  applyOperations,
  deleteKi,
  dreamingWriter,
  emptyCounts,
  pruneSources,
  type ApplyContext,
  type ApplyCounts,
} from './apply';
import { keepVerifiedPatterns, type VerifyEsql } from './access_patterns';
import { changeSetSchema } from './change_set';
import { DreamingTaskNotFoundError, InvalidChangeSetError } from './errors';
import { memoryUri, ownerOf } from './ids';
import {
  SESSION_ATTRIBUTE,
  USER_ATTRIBUTE,
  citedMemoryIds,
  findKisDerivedFrom,
  isSessionKi,
  isStale,
  loadOwnerKis,
  loadSessionKis,
  type DreamedKi,
} from './long_term';
import { buildInput, buildSystemPrompt, type PromptSession } from './prompt';
import { resolveChangeSet, vocabularyOf, type DreamingOperation } from './resolve_change_set';
import type { DreamingRunProgress, RunKey } from './run_progress';

/** Asks the configured model for a change set. */
export type DreamingModel = (prompt: {
  system: string;
  input: string;
  abortSignal?: AbortSignal;
}) => Promise<unknown>;

export interface GraphifyParams extends RunKey {
  taskId: string;
  dest: AiIndexDest;
  config: AiIndexDreamingConfig;
  dryRun: boolean;
  /** The workflow user's client; every long-term read and write goes through it. */
  esClient: ElasticsearchClient;
  memoryReader: DreamingMemoryReader;
  runProgress: DreamingRunProgress;
  getModel: () => Promise<DreamingModel>;
  /** Checks access pattern examples as the workflow user, so they only cite data it can read. */
  verifyEsql: VerifyEsql;
  abortSignal?: AbortSignal;
}

export interface GraphifyResult extends ApplyCounts {
  task_id: string;
  status: 'applied' | 'unchanged' | 'dry_run';
  rejected: number;
  /** Access patterns dropped because their example did not run. */
  access_patterns_dropped?: number;
  /** Only for a dry run. */
  operations?: DreamingOperation[];
  /** Only for a dry run: why each rejected item was rejected. */
  rejections?: Array<{ item: string; reason: string }>;
}

const belongsTo = (ki: DreamedKi, userId: string | undefined): boolean =>
  ki.attributes?.[USER_ATTRIBUTE] === userId;

const sessionOfKi = (ki: DreamedKi): string | undefined => {
  const sessionId = ki.attributes?.[SESSION_ATTRIBUTE];
  return typeof sessionId === 'string' ? sessionId : undefined;
};

/**
 * The task's sessions, each with its current session document: the sessions of its new memories,
 * and those of stale session documents it has to rewrite.
 */
const taskSessions = (
  newMemories: readonly DreamingMemory[],
  sessionKis: readonly DreamedKi[],
  standing: readonly DreamedKi[]
): Map<string, DreamedKi | undefined> => {
  const sessions = new Map<string, DreamedKi | undefined>();
  for (const { session_id: sessionId } of newMemories) {
    sessions.set(
      sessionId,
      sessionKis.find((ki) => !isStale(ki) && sessionOfKi(ki) === sessionId)
    );
  }
  for (const ki of standing) {
    const sessionId = sessionOfKi(ki);
    if (sessionId !== undefined) {
      sessions.set(sessionId, ki);
    }
  }
  return sessions;
};

const promptSessions = (
  sessions: ReadonlyMap<string, DreamedKi | undefined>,
  memories: readonly DreamingMemory[]
): PromptSession[] =>
  [...sessions].map(([sessionId, document]) => {
    const recordedAt = memories
      .filter(({ session_id: id }) => id === sessionId)
      .map((memory) => memory.occurred_at ?? memory['@timestamp'])
      .sort();
    return {
      sessionId,
      firstRecordedAt: recordedAt[0] ?? '',
      lastRecordedAt: recordedAt[recordedAt.length - 1] ?? '',
      ...(document && { document }),
    };
  });

/**
 * Settles stale KIs before the model sees them: drops references to forgotten memories, and
 * deletes KIs left with no source. Returns the stale KIs still standing and their sources.
 */
const settleStaleKis = async (
  context: ApplyContext,
  {
    staleKis,
    memoryReader,
    spaceId,
    dryRun,
  }: {
    staleKis: readonly DreamedKi[];
    memoryReader: DreamingMemoryReader;
    spaceId: string;
    dryRun: boolean;
  }
): Promise<{ standing: DreamedKi[]; sources: DreamingMemory[]; deleted: number }> => {
  const cited = [...new Set(staleKis.flatMap(citedMemoryIds))];
  const sources = await memoryReader.getByIds(spaceId, cited);
  const remaining = new Set(sources.map(({ id }) => id));
  const standing: DreamedKi[] = [];
  let deleted = 0;
  for (const ki of staleKis) {
    const kiSources = citedMemoryIds(ki);
    const forgotten = new Set(kiSources.filter((id) => !remaining.has(id)));
    if (forgotten.size === kiSources.length) {
      if (!dryRun) {
        await deleteKi(context, ki.id);
      }
      deleted += 1;
      continue;
    }
    if (forgotten.size > 0 && !dryRun) {
      await pruneSources(context, ki.id, forgotten);
    }
    standing.push({
      ...ki,
      references: ki.references?.filter(
        ({ uri, relation }) =>
          relation !== 'derived_from' || ![...forgotten].some((id) => uri === memoryUri(id))
      ),
    });
  }
  return { standing, sources, deleted };
};

/**
 * Turns one task's short-term memories into long-term entities, facts, and relationships. The
 * plan is saved before anything is written, so a retried task re-applies it instead of asking
 * the model again.
 */
export const graphifyTask = async (params: GraphifyParams): Promise<GraphifyResult> => {
  const {
    spaceId,
    aiIndexId,
    executionId,
    taskId,
    dest,
    config,
    dryRun,
    esClient,
    memoryReader,
    runProgress,
    getModel,
    verifyEsql,
    abortSignal,
  } = params;
  const key: RunKey = { spaceId, aiIndexId, executionId };

  const run = await runProgress.getRun(key);
  const task = run?.tasks.find(({ task_id: id }) => id === taskId);
  if (!task) {
    throw new DreamingTaskNotFoundError(executionId, taskId);
  }

  const context: ApplyContext = {
    esClient,
    aiIndexId,
    dest,
    writer: dreamingWriter({ executionId, taskId, spaceId }),
    ...(task.user_id !== undefined && { userId: task.user_id }),
    abortSignal,
  };

  const saved = await runProgress.getTask(key, taskId);
  if (saved?.status === 'done') {
    return {
      task_id: taskId,
      status: 'applied',
      rejected: saved.progress.rejected,
      ...(saved.progress.counts ?? emptyCounts()),
    };
  }
  if (saved && !dryRun) {
    const counts = await applyOperations(context, saved.progress.operations);
    await runProgress.saveTask(key, taskId, 'done', { ...saved.progress, counts });
    return { task_id: taskId, status: 'applied', rejected: saved.progress.rejected, ...counts };
  }

  const memories = await memoryReader.getByIds(spaceId, task.memory_ids);
  const alreadyDreamed = new Set(
    (await findKisDerivedFrom({ esClient, dest, memoryIds: task.memory_ids, abortSignal })).flatMap(
      citedMemoryIds
    )
  );
  const newMemories = memories.filter(({ id }) => !alreadyDreamed.has(id));

  const owner = ownerOf(task.user_id);
  const ownerKis = (await loadOwnerKis({ esClient, dest, owner, abortSignal })).filter((ki) =>
    belongsTo(ki, task.user_id)
  );
  const sessionKis = config.sessions
    ? (
        await loadSessionKis({
          esClient,
          dest,
          owner,
          sessionIds: [...new Set(newMemories.map(({ session_id: sessionId }) => sessionId))],
          abortSignal,
        })
      ).filter((ki) => belongsTo(ki, task.user_id))
    : [];
  const settled = await settleStaleKis(context, {
    staleKis: [...ownerKis, ...sessionKis].filter(isStale),
    memoryReader,
    spaceId,
    dryRun,
  });
  const existing = [
    ...ownerKis.filter((ki) => !isStale(ki)),
    ...settled.standing.filter((ki) => !isSessionKi(ki)),
  ];
  const sessions = config.sessions
    ? taskSessions(newMemories, sessionKis, settled.standing.filter(isSessionKi))
    : undefined;

  const result = (counts: ApplyCounts, rejected: number, status: GraphifyResult['status']) => ({
    task_id: taskId,
    status,
    rejected,
    ...counts,
    deleted: counts.deleted + settled.deleted,
  });

  if (newMemories.length === 0 && settled.standing.length === 0) {
    if (!dryRun) {
      await runProgress.saveTask(key, taskId, 'done', {
        operations: [],
        rejected: 0,
        counts: emptyCounts(),
      });
    }
    return result(emptyCounts(), 0, dryRun ? 'dry_run' : 'unchanged');
  }

  const model = await getModel();
  const raw = await model({
    system: buildSystemPrompt(config),
    input: buildInput({
      memories: newMemories,
      staleSources: settled.sources,
      existing,
      ...(sessions && {
        sessions: promptSessions(sessions, [...newMemories, ...settled.sources]),
      }),
    }),
    abortSignal,
  });
  const parsed = changeSetSchema.safeParse(raw);
  if (!parsed.success) {
    throw new InvalidChangeSetError(parsed.error.message);
  }

  const sessionByMemoryId = new Map(
    [...memories, ...settled.sources].map(({ id, session_id: sessionId }) => [id, sessionId])
  );
  const resolved = resolveChangeSet(parsed.data, {
    executionId,
    taskId,
    owner,
    vocabulary: vocabularyOf(config),
    memoryIds: new Set(newMemories.map(({ id }) => id)),
    sessionByMemoryId,
    existing: new Map(existing.map((ki) => [ki.id, ki])),
    ...(sessions && { sessions }),
  });
  const { rejected } = resolved;
  const { operations, dropped } = await keepVerifiedPatterns(resolved.operations, verifyEsql);

  if (dryRun) {
    return {
      ...result(emptyCounts(), rejected.length, 'dry_run'),
      access_patterns_dropped: dropped,
      operations,
      rejections: rejected,
    };
  }

  await runProgress.saveTask(key, taskId, 'planned', { operations, rejected: rejected.length });
  const counts = await applyOperations(context, operations);
  await runProgress.saveTask(key, taskId, 'done', {
    operations,
    rejected: rejected.length,
    counts,
  });
  return { ...result(counts, rejected.length, 'applied'), access_patterns_dropped: dropped };
};
