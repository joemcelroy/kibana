/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  DREAMING_SETTLE_LAG_MS,
  MAX_DREAMING_MEMORIES_PER_TASK,
  compareDreamingCursors,
  cursorOfMemory,
  type AiIndexDreaming,
  type ShortTermMemory,
} from '../../common/dreaming';
import { groupKeyOf, type ShortTermMemoryServiceApi } from '../short_term_memory/service';
import { buildTasks, planRun } from './plan_run';

const memory = (
  id: string,
  timestamp: string,
  sessionId: string,
  userId?: string
): ShortTermMemory => ({
  '@timestamp': timestamp,
  id,
  session_id: sessionId,
  ...(userId !== undefined && { user_id: userId }),
  content: `memory ${id}`,
});

/** An in-memory short-term stream that pages like the real one. */
const fakeShortTermMemory = (memories: ShortTermMemory[]): ShortTermMemoryServiceApi => ({
  remember: jest.fn(),
  forget: jest.fn(),
  getByIds: jest.fn(),
  pull: jest.fn(async (_spaceId, { after, until, groupBy, groupKeys, size }) => {
    const matching = memories
      .filter((item) => Date.parse(item['@timestamp']) <= Date.parse(until))
      .filter((item) => !after || compareDreamingCursors(cursorOfMemory(item), after) > 0)
      .filter((item) => !groupKeys || groupKeys.includes(groupKeyOf(item, groupBy)))
      .sort((a, b) => compareDreamingCursors(cursorOfMemory(a), cursorOfMemory(b)));
    const page = matching.slice(0, size);
    const last = page[page.length - 1];
    return {
      memories: page,
      ...(page.length === size && last && { next: cursorOfMemory(last) }),
    };
  }),
});

const now = new Date('2026-10-23T12:00:00.000Z');

describe('buildTasks', () => {
  it('orders tasks by user, then by each group’s first memory, and splits large groups', () => {
    const many = Array.from({ length: MAX_DREAMING_MEMORIES_PER_TASK + 1 }, (_, index) =>
      memory(`b-${String(index).padStart(4, '0')}`, '2026-10-23T10:00:00.000Z', 's-big', 'bob')
    );
    const tasks = buildTasks(
      [
        memory('a-2', '2026-10-23T09:00:00.000Z', 's-a2', 'alice'),
        memory('a-1', '2026-10-23T08:00:00.000Z', 's-a1', 'alice'),
        ...many,
      ],
      'session_id'
    );
    expect(tasks.map(({ group_key: groupKey }) => groupKey)).toEqual([
      's-a1',
      's-a2',
      's-big',
      's-big',
    ]);
    expect(tasks[2].memory_ids).toHaveLength(MAX_DREAMING_MEMORIES_PER_TASK);
    expect(tasks[3].memory_ids).toHaveLength(1);
    expect(tasks[0].from).toEqual({ timestamp: '2026-10-23T08:00:00.000Z', memory_id: '' });
  });

  it('splits a session shared by two users into one task per user', () => {
    const tasks = buildTasks(
      [
        memory('m-1', '2026-10-23T08:00:00.000Z', 's-1', 'alice'),
        memory('m-2', '2026-10-23T08:01:00.000Z', 's-1', 'bob'),
      ],
      'session_id'
    );
    expect(tasks.map(({ user_id: userId }) => userId)).toEqual(['alice', 'bob']);
  });
});

describe('planRun', () => {
  const dreaming: AiIndexDreaming = {
    enabled: true,
    state: {
      cursor: { timestamp: '2026-10-23T09:00:00.000Z', memory_id: 'm-2' },
      retry: [
        {
          group_key: 's-retry',
          from: { timestamp: '2026-10-23T07:00:00.000Z', memory_id: '' },
        },
      ],
    },
  };

  const stream = [
    memory('m-0', '2026-10-23T07:30:00.000Z', 's-retry', 'alice'),
    memory('m-1', '2026-10-23T08:00:00.000Z', 's-done', 'alice'),
    memory('m-2', '2026-10-23T09:00:00.000Z', 's-done', 'alice'),
    memory('m-3', '2026-10-23T10:00:00.000Z', 's-new', 'alice'),
    // Inside the settle lag, so left for the next run.
    memory('m-4', new Date(now.getTime() - DREAMING_SETTLE_LAG_MS / 2).toISOString(), 's-new'),
  ];

  it('reads retry groups and everything after the cursor up to the settle lag', async () => {
    const plan = await planRun({
      shortTermMemory: fakeShortTermMemory(stream),
      spaceId: 'default',
      dreaming,
      dryRun: false,
      now,
    });
    expect(plan.tasks.flatMap(({ memory_ids: ids }) => ids).sort()).toEqual(['m-0', 'm-3']);
    expect(plan.new_cursor).toEqual({ timestamp: '2026-10-23T10:00:00.000Z', memory_id: 'm-3' });
    expect(plan.consumed_retry).toEqual(dreaming.state?.retry);
    expect(plan.deferred_retry).toEqual([]);
  });

  it('keeps the cursor when nothing new was written', async () => {
    const plan = await planRun({
      shortTermMemory: fakeShortTermMemory(stream.slice(0, 3)),
      spaceId: 'default',
      dreaming: { ...dreaming, state: { ...dreaming.state, retry: [] } },
      dryRun: false,
      now,
    });
    expect(plan.tasks).toEqual([]);
    expect(plan.new_cursor).toBeUndefined();
  });

  it('reads only the target for an explicit run, and neither moves the cursor nor consumes retries', async () => {
    const plan = await planRun({
      shortTermMemory: fakeShortTermMemory(stream),
      spaceId: 'default',
      dreaming,
      target: { session_id: 's-done' },
      dryRun: true,
      now,
    });
    expect(plan.tasks.flatMap(({ memory_ids: ids }) => ids)).toEqual(['m-1', 'm-2']);
    expect(plan.new_cursor).toBeUndefined();
    expect(plan.consumed_retry).toEqual([]);
    expect(plan.dry_run).toBe(true);
  });
});
