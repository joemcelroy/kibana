/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  DEFAULT_DREAMING_GROUP_BY,
  DREAMING_SETTLE_LAG_MS,
  MAX_DREAMING_MEMORIES_PER_RUN,
  MAX_DREAMING_MEMORIES_PER_TASK,
  MAX_DREAMING_TASK_CHARACTERS,
  promptCharactersOf,
  MAX_SHORT_TERM_PULL_SIZE,
  SHARED_MEMORY_OWNER,
  compareDreamingCursors,
  cursorBeforeMemory,
  cursorOfMemory,
  type AiIndexDreaming,
  type DreamingCursor,
  type DreamingGroupBy,
  type DreamingRetryEntry,
  type DreamingMemory,
} from '../../common/dreaming';
import { groupKeyOf } from '../short_term_memory/service';
import type { DreamingMemoryReader } from './memory_reader';
import type { DreamingRunPlan, DreamingTask } from './run_progress';
import { stateOf } from './state';

/** Restricts an explicit run to one session or one user. */
export interface DreamingTarget {
  session_id?: string;
  user_id?: string;
}

interface PlanRunParams {
  memoryReader: DreamingMemoryReader;
  spaceId: string;
  /** Every read skips memories targeted at other AI indices. */
  aiIndexId: string;
  /** The AI index keeps each user's memory apart; see `PullShortTermMemoriesParams`. */
  userScoped?: boolean;
  dreaming: AiIndexDreaming;
  target?: DreamingTarget;
  dryRun: boolean;
  now: Date;
}

interface RangeRead {
  memories: DreamingMemory[];
  /** Where reading stopped when the budget ran out first. */
  resumeAfter?: DreamingCursor;
}

/** Reads one range in pages until it ends or `budget` memories were read. */
const readRange = async (
  memoryReader: DreamingMemoryReader,
  spaceId: string,
  {
    after,
    until,
    groupBy,
    groupKeys,
    aiIndexId,
    userScoped,
    budget,
  }: {
    after?: DreamingCursor;
    until: string;
    groupBy: DreamingGroupBy;
    groupKeys?: string[];
    aiIndexId: string;
    userScoped?: boolean;
    budget: number;
  }
): Promise<RangeRead> => {
  const memories: DreamingMemory[] = [];
  let position = after;
  while (memories.length < budget) {
    const size = Math.min(MAX_SHORT_TERM_PULL_SIZE, budget - memories.length);
    const page = await memoryReader.pull(spaceId, {
      after: position,
      until,
      groupBy,
      groupKeys,
      aiIndexId,
      userScoped,
      size,
    });
    memories.push(...page.memories);
    if (!page.next) {
      return { memories };
    }
    position = page.next;
  }
  return { memories, resumeAfter: position };
};

const targetGroupOf = (
  target: DreamingTarget | undefined
): { groupBy: DreamingGroupBy; key: string } | undefined => {
  if (target?.session_id !== undefined) {
    return { groupBy: 'session_id', key: target.session_id };
  }
  if (target?.user_id !== undefined) {
    return { groupBy: 'user_id', key: target.user_id };
  }
  return undefined;
};

const ownerSortKey = (memory: DreamingMemory): string => memory.user_id ?? SHARED_MEMORY_OWNER;

/**
 * Splits a group's memories into chunks of at most {@link MAX_DREAMING_MEMORIES_PER_TASK} memories
 * and {@link MAX_DREAMING_TASK_CHARACTERS} characters. A memory larger than that gets its own chunk.
 */
const chunkBySize = (memories: readonly DreamingMemory[]): DreamingMemory[][] => {
  const chunks: DreamingMemory[][] = [];
  let chunk: DreamingMemory[] = [];
  let characters = 0;
  for (const memory of memories) {
    const size = promptCharactersOf(memory);
    if (
      chunk.length > 0 &&
      (chunk.length >= MAX_DREAMING_MEMORIES_PER_TASK ||
        characters + size > MAX_DREAMING_TASK_CHARACTERS)
    ) {
      chunks.push(chunk);
      chunk = [];
      characters = 0;
    }
    chunk.push(memory);
    characters += size;
  }
  if (chunk.length > 0) {
    chunks.push(chunk);
  }
  return chunks;
};

/** Splits memories into ordered tasks: by user, then by each group's first memory. */
export const buildTasks = (
  memories: readonly DreamingMemory[],
  groupBy: DreamingGroupBy
): DreamingTask[] => {
  // A task writes one owner's long-term memory, so a session shared by several users splits.
  const groups = new Map<string, { groupKey: string; memories: DreamingMemory[] }>();
  const sorted = [...memories].sort((a, b) =>
    compareDreamingCursors(cursorOfMemory(a), cursorOfMemory(b))
  );
  for (const memory of sorted) {
    const groupKey = groupKeyOf(memory, groupBy);
    const key = `${ownerSortKey(memory)}\u0000${groupKey}`;
    const group = groups.get(key) ?? { groupKey, memories: [] };
    group.memories.push(memory);
    groups.set(key, group);
  }
  const ordered = [...groups.values()].sort(({ memories: a }, { memories: b }) => {
    const byOwner = ownerSortKey(a[0]).localeCompare(ownerSortKey(b[0]));
    return byOwner !== 0
      ? byOwner
      : compareDreamingCursors(cursorOfMemory(a[0]), cursorOfMemory(b[0]));
  });

  const tasks: DreamingTask[] = [];
  for (const { groupKey, memories: groupMemories } of ordered) {
    for (const chunk of chunkBySize(groupMemories)) {
      const [first] = chunk;
      tasks.push({
        task_id: `task-${tasks.length + 1}`,
        group_key: groupKey,
        ...(groupBy === 'user_id'
          ? { ...(first.user_id !== undefined && { user_id: first.user_id }) }
          : {
              session_id: first.session_id,
              ...(first.user_id !== undefined && { user_id: first.user_id }),
            }),
        memory_ids: chunk.map(({ id }) => id),
        from: cursorBeforeMemory(first),
      });
    }
  }
  return tasks;
};

/**
 * Decides what a run dreams: retry groups from where they stopped, then everything after the
 * cursor, up to the run's memory cap. A targeted run reads only its target and never moves the
 * cursor or consumes retries. It reads up to `now`: it is started right after its memories were
 * written, which `remember` waits to be searchable, and the settle lag only guards the cursor.
 */
export const planRun = async ({
  memoryReader,
  spaceId,
  aiIndexId,
  userScoped = false,
  dreaming,
  target,
  dryRun,
  now,
}: PlanRunParams): Promise<DreamingRunPlan> => {
  const groupBy = dreaming.group_by ?? DEFAULT_DREAMING_GROUP_BY;
  const until = new Date(now.getTime() - DREAMING_SETTLE_LAG_MS).toISOString();
  const state = stateOf(dreaming);
  const read = new Map<string, DreamingMemory>();
  const remaining = () => MAX_DREAMING_MEMORIES_PER_RUN - read.size;
  const collect = (memories: readonly DreamingMemory[]) => {
    for (const memory of memories) {
      read.set(memory.id, memory);
    }
  };

  const targeted = targetGroupOf(target);
  if (targeted) {
    const { memories } = await readRange(memoryReader, spaceId, {
      until: now.toISOString(),
      groupBy: targeted.groupBy,
      groupKeys: [targeted.key],
      aiIndexId,
      userScoped,
      budget: MAX_DREAMING_MEMORIES_PER_RUN,
    });
    const scoped =
      target?.session_id !== undefined && target.user_id !== undefined
        ? memories.filter(({ user_id: userId }) => userId === target.user_id)
        : memories;
    return {
      tasks: buildTasks(scoped, groupBy),
      consumed_retry: [],
      deferred_retry: [],
      dry_run: dryRun,
    };
  }

  const consumed: DreamingRetryEntry[] = [];
  const deferred: DreamingRetryEntry[] = [];
  for (const entry of state.retry) {
    consumed.push(entry);
    if (remaining() <= 0) {
      deferred.push(entry);
      continue;
    }
    const { memories, resumeAfter } = await readRange(memoryReader, spaceId, {
      after: entry.from,
      until,
      groupBy,
      groupKeys: [entry.group_key],
      aiIndexId,
      userScoped,
      budget: remaining(),
    });
    collect(memories);
    if (resumeAfter) {
      deferred.push({ group_key: entry.group_key, from: resumeAfter });
    }
  }

  let newCursor: DreamingCursor | undefined;
  if (remaining() > 0) {
    const { memories } = await readRange(memoryReader, spaceId, {
      after: state.cursor,
      until,
      groupBy,
      aiIndexId,
      userScoped,
      budget: remaining(),
    });
    collect(memories);
    const last = memories[memories.length - 1];
    newCursor = last ? cursorOfMemory(last) : undefined;
  }

  return {
    tasks: buildTasks([...read.values()], groupBy),
    ...(newCursor && { new_cursor: newCursor }),
    consumed_retry: consumed,
    deferred_retry: deferred,
    dry_run: dryRun,
  };
};
