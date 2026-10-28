/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { elasticsearchServiceMock } from '@kbn/core/server/mocks';
import type { ShortTermMemory } from '../../common/dreaming';
import type { DreamingMemoryReader } from './memory_reader';
import { applyOperations, deleteKi, pruneSources } from './apply';
import { DreamingTaskNotFoundError, InvalidChangeSetError } from './errors';
import { graphifyTask, type GraphifyParams } from './graphify';
import { findKisDerivedFrom, loadOwnerKis, USER_ATTRIBUTE } from './long_term';
import type { DreamingRunProgress, DreamingTask } from './run_progress';

jest.mock('./apply', () => ({
  ...jest.requireActual('./apply'),
  applyOperations: jest.fn(),
  deleteKi: jest.fn(),
  pruneSources: jest.fn(),
}));
jest.mock('./long_term', () => ({
  ...jest.requireActual('./long_term'),
  findKisDerivedFrom: jest.fn(),
  loadOwnerKis: jest.fn(),
}));

const applyOperationsMock = applyOperations as jest.MockedFunction<typeof applyOperations>;
const deleteKiMock = deleteKi as jest.MockedFunction<typeof deleteKi>;
const pruneSourcesMock = pruneSources as jest.MockedFunction<typeof pruneSources>;
const findKisDerivedFromMock = findKisDerivedFrom as jest.MockedFunction<typeof findKisDerivedFrom>;
const loadOwnerKisMock = loadOwnerKis as jest.MockedFunction<typeof loadOwnerKis>;

const memory = (id: string): ShortTermMemory => ({
  '@timestamp': '2026-10-23T10:00:00.000Z',
  id,
  session_id: 's-1',
  user_id: 'alice',
  content: `Alice said ${id}`,
});

const task: DreamingTask = {
  task_id: 'task-1',
  group_key: 's-1',
  session_id: 's-1',
  user_id: 'alice',
  memory_ids: ['m-1', 'm-2'],
  from: { timestamp: '2026-10-23T10:00:00.000Z', memory_id: '' },
};

const counts = { created: 1, updated: 0, deleted: 0 };

const setup = ({
  saved,
  modelOutput = {
    facts: [
      {
        ref: 'new:1',
        type: 'fact',
        title: 'Tea',
        content: 'Alice likes tea',
        source_memory_ids: ['m-1'],
      },
    ],
  },
  memories = [memory('m-1'), memory('m-2')],
}: {
  saved?: Awaited<ReturnType<DreamingRunProgress['getTask']>>;
  modelOutput?: unknown;
  memories?: ShortTermMemory[];
} = {}) => {
  const runProgress = {
    getRun: jest.fn().mockResolvedValue({
      tasks: [task],
      consumed_retry: [],
      deferred_retry: [],
      dry_run: false,
    }),
    getTask: jest.fn().mockResolvedValue(saved),
    saveTask: jest.fn(),
  };
  const memoryReader = {
    getByIds: jest.fn(async (_spaceId: string, ids: readonly string[]) =>
      memories.filter(({ id }) => ids.includes(id))
    ),
  };
  const model = jest.fn().mockResolvedValue(modelOutput);
  const verifyEsql = jest.fn(async (query: string) => !query.includes('missing_field'));
  const params: GraphifyParams = {
    spaceId: 'default',
    aiIndexId: 'memory',
    executionId: 'exec-1',
    taskId: 'task-1',
    dest: { type: 'index', value: 'ai-index-idx-memory' },
    config: { enabled: true },
    dryRun: false,
    esClient: elasticsearchServiceMock.createElasticsearchClient(),
    memoryReader: memoryReader as unknown as DreamingMemoryReader,
    runProgress: runProgress as unknown as DreamingRunProgress,
    getModel: async () => model,
    verifyEsql,
  };
  return { params, runProgress, model, verifyEsql };
};

describe('graphifyTask', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    findKisDerivedFromMock.mockResolvedValue([]);
    loadOwnerKisMock.mockResolvedValue([]);
    applyOperationsMock.mockResolvedValue(counts);
  });

  it('saves the plan before applying it, then records the task as done', async () => {
    const { params, runProgress, model } = setup();

    const result = await graphifyTask(params);

    expect(model).toHaveBeenCalledTimes(1);
    expect(runProgress.saveTask.mock.calls.map(([, , status]) => status)).toEqual([
      'planned',
      'done',
    ]);
    const [[, operations]] = applyOperationsMock.mock.calls;
    expect(operations).toEqual([
      expect.objectContaining({ op: 'upsert_fact', content: 'Alice likes tea' }),
    ]);
    expect(result).toEqual({
      task_id: 'task-1',
      status: 'applied',
      rejected: 0,
      access_patterns_dropped: 0,
      ...counts,
    });
  });

  it('drops access patterns whose example does not run before saving the plan', async () => {
    const pattern = (label: string, field: string) => ({
      question_type: label,
      esql_template: `FROM orders | WHERE customer == ?customer | KEEP ${field}`,
      esql_example: `FROM orders | WHERE customer == "alice" | KEEP ${field} | LIMIT 5`,
      returns: `Alice's ${field}`,
    });
    const { params, runProgress, verifyEsql } = setup({
      modelOutput: {
        facts: [
          {
            ref: 'new:1',
            type: 'fact',
            title: 'Alice orders',
            content: 'Alice orders tea',
            access_patterns: [pattern('orders', 'item'), pattern('broken', 'missing_field')],
            source_memory_ids: ['m-1'],
          },
        ],
      },
    });

    const result = await graphifyTask(params);

    expect(verifyEsql).toHaveBeenCalledTimes(2);
    expect(result.access_patterns_dropped).toBe(1);
    const [[, , , { operations }]] = runProgress.saveTask.mock.calls;
    expect(operations).toEqual([
      expect.objectContaining({ accessPatterns: [pattern('orders', 'item')] }),
    ]);
  });

  it('re-applies a saved plan without asking the model again', async () => {
    const operations = [{ op: 'delete' as const, id: 'alice/fact-x' }];
    const { params, runProgress, model } = setup({
      saved: { status: 'planned', progress: { operations, rejected: 2 } },
    });

    const result = await graphifyTask(params);

    expect(model).not.toHaveBeenCalled();
    expect(applyOperationsMock).toHaveBeenCalledWith(expect.anything(), operations);
    expect(runProgress.saveTask).toHaveBeenCalledWith(
      expect.anything(),
      'task-1',
      'done',
      expect.objectContaining({ counts })
    );
    expect(result.rejected).toBe(2);
  });

  it('returns the saved counts for a task that is already done', async () => {
    const { params, model } = setup({
      saved: { status: 'done', progress: { operations: [], rejected: 0, counts } },
    });
    expect(await graphifyTask(params)).toMatchObject({ status: 'applied', ...counts });
    expect(model).not.toHaveBeenCalled();
    expect(applyOperationsMock).not.toHaveBeenCalled();
  });

  it('skips the model when every memory was already dreamed', async () => {
    findKisDerivedFromMock.mockResolvedValue([
      {
        id: 'alice/fact-a',
        type: 'fact.fact',
        title: 'a',
        references: [
          { uri: 'memory://m-1', relation: 'derived_from' },
          { uri: 'memory://m-2', relation: 'derived_from' },
        ],
      },
    ]);
    const { params, model } = setup();
    expect(await graphifyTask(params)).toMatchObject({ status: 'unchanged' });
    expect(model).not.toHaveBeenCalled();
  });

  it('returns planned operations on a dry run without writing', async () => {
    const { params, runProgress } = setup();
    const result = await graphifyTask({ ...params, dryRun: true });
    expect(result.status).toBe('dry_run');
    expect(result.operations).toHaveLength(1);
    expect(runProgress.saveTask).not.toHaveBeenCalled();
    expect(applyOperationsMock).not.toHaveBeenCalled();
  });

  it('fails on a change set that does not match the schema', async () => {
    const { params } = setup({ modelOutput: { facts: 'nope' } });
    await expect(graphifyTask(params)).rejects.toThrow(InvalidChangeSetError);
  });

  it('fails when the task is not part of the run', async () => {
    const { params } = setup();
    await expect(graphifyTask({ ...params, taskId: 'task-9' })).rejects.toThrow(
      DreamingTaskNotFoundError
    );
  });

  it('deletes stale KIs left with no source and prunes the rest before calling the model', async () => {
    const stale = (id: string, sources: string[]) => ({
      id,
      type: 'fact.fact',
      title: id,
      attributes: { [USER_ATTRIBUTE]: 'alice' },
      governance: { lifecycle: { status: 'stale' as const } },
      references: sources.map((source) => ({
        uri: `memory://${source}`,
        relation: 'derived_from' as const,
      })),
    });
    loadOwnerKisMock.mockResolvedValue([
      stale('alice/fact-orphan', ['m-forgotten']),
      stale('alice/fact-kept', ['m-forgotten', 'm-1']),
    ]);
    const { params, model } = setup();

    const result = await graphifyTask(params);

    expect(deleteKiMock).toHaveBeenCalledWith(expect.anything(), 'alice/fact-orphan');
    expect(pruneSourcesMock).toHaveBeenCalledWith(
      expect.anything(),
      'alice/fact-kept',
      new Set(['m-forgotten'])
    );
    const [[{ input }]] = model.mock.calls;
    expect(input).toContain('alice/fact-kept');
    expect(input).not.toContain('alice/fact-orphan');
    expect(result.deleted).toBe(counts.deleted + 1);
  });
});
