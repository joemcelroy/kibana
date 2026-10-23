/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  MAX_DREAMING_RETRY_ENTRIES,
  compareDreamingCursors,
  type AiIndexDreaming,
  type AiIndexDreamingState,
  type DreamingCursor,
  type DreamingRetryEntry,
  type DreamingRunStatus,
} from '../../common/dreaming';
import { DreamingStateConflictError } from './errors';

/** Matches the dreaming workflow timeout; a run marked running for longer has died. */
export const DREAMING_RUN_TIMEOUT_MS = 45 * 60 * 1000;

const EMPTY_STATE: AiIndexDreamingState = { retry: [] };

export const stateOf = (dreaming: AiIndexDreaming | undefined): AiIndexDreamingState =>
  dreaming?.state ?? EMPTY_STATE;

/** The execution currently dreaming this AI index, if any. */
export const runningExecutionId = (
  state: AiIndexDreamingState,
  now: Date = new Date()
): string | undefined => {
  const { last_run: lastRun } = state;
  if (lastRun?.status !== 'running') {
    return undefined;
  }
  const startedAt = Date.parse(lastRun.started_at);
  return now.getTime() - startedAt < DREAMING_RUN_TIMEOUT_MS ? lastRun.execution_id : undefined;
};

/** Merges retry entries, keeping the earliest `from` per group, within the retry cap. */
export const mergeRetryEntries = (
  current: readonly DreamingRetryEntry[],
  additions: readonly DreamingRetryEntry[]
): { retry: DreamingRetryEntry[]; overflow: DreamingRetryEntry[] } => {
  const byGroup = new Map<string, DreamingRetryEntry>();
  const overflow: DreamingRetryEntry[] = [];
  for (const entry of [...current, ...additions]) {
    const existing = byGroup.get(entry.group_key);
    if (existing) {
      if (compareDreamingCursors(entry.from, existing.from) < 0) {
        byGroup.set(entry.group_key, entry);
      }
    } else if (byGroup.size < MAX_DREAMING_RETRY_ENTRIES) {
      byGroup.set(entry.group_key, entry);
    } else {
      overflow.push(entry);
    }
  }
  return { retry: [...byGroup.values()], overflow };
};

/** Records that `executionId` started dreaming. */
export const startRun = (
  dreaming: AiIndexDreaming | undefined,
  executionId: string,
  now: Date = new Date()
): AiIndexDreamingState => ({
  ...stateOf(dreaming),
  last_run: { execution_id: executionId, status: 'running', started_at: now.toISOString() },
});

export interface DreamingStateUpdate {
  /** The run making the update. Required unless `reset` is set. */
  execution_id?: string;
  cursor: DreamingCursor;
  retry: DreamingRetryEntry[];
  /** Allows moving the cursor backwards, for example to re-dream. */
  reset?: boolean;
}

/**
 * Applies a cursor and retry update. Only the running execution may update the state, the
 * cursor only moves forward, and a reset is refused while another run is in progress.
 */
export const applyStateUpdate = (
  dreaming: AiIndexDreaming | undefined,
  update: DreamingStateUpdate,
  now: Date = new Date()
): AiIndexDreamingState => {
  const state = stateOf(dreaming);
  const running = runningExecutionId(state, now);

  if (update.reset) {
    if (running !== undefined && running !== update.execution_id) {
      throw new DreamingStateConflictError(
        `Cannot reset the dreaming state while run '${running}' is in progress.`
      );
    }
  } else {
    if (update.execution_id === undefined || running !== update.execution_id) {
      throw new DreamingStateConflictError(
        `Only the running dreaming execution can update the state${
          running ? `; run '${running}' is in progress` : ''
        }. Set reset to move the cursor outside a run.`
      );
    }
    if (state.cursor && compareDreamingCursors(update.cursor, state.cursor) < 0) {
      throw new DreamingStateConflictError(
        'The dreaming cursor can only move forward. Set reset to move it back.'
      );
    }
  }

  const { retry } = mergeRetryEntries([], update.retry);
  return { ...state, cursor: update.cursor, retry };
};

const isSameRetryEntry = (a: DreamingRetryEntry, b: DreamingRetryEntry): boolean =>
  a.group_key === b.group_key && compareDreamingCursors(a.from, b.from) === 0;

/**
 * Ends a run: applies its cursor and retry update and records how it finished. Retry entries
 * the run did not consume, such as ones a forget queued while it ran, are kept.
 */
export const completeRun = (
  dreaming: AiIndexDreaming | undefined,
  update: {
    execution_id: string;
    /** `undefined` leaves the cursor where it is. */
    cursor?: DreamingCursor;
    retry: readonly DreamingRetryEntry[];
    consumed: readonly DreamingRetryEntry[];
  },
  status: Exclude<DreamingRunStatus, 'running'>,
  now: Date = new Date()
): AiIndexDreamingState => {
  const current = stateOf(dreaming);
  const queuedDuringRun = current.retry.filter(
    (entry) => !update.consumed.some((consumed) => isSameRetryEntry(entry, consumed))
  );
  const { retry } = mergeRetryEntries(update.retry, queuedDuringRun);
  const cursor = update.cursor ?? current.cursor;
  const state = cursor
    ? applyStateUpdate(dreaming, { execution_id: update.execution_id, cursor, retry }, now)
    : { ...current, retry };
  return closeState(state, update.execution_id, status, now);
};

/** Records how a run finished without touching the cursor or retries, as a dry run does. */
export const closeRun = (
  dreaming: AiIndexDreaming | undefined,
  executionId: string,
  status: Exclude<DreamingRunStatus, 'running'>,
  now: Date = new Date()
): AiIndexDreamingState => closeState(stateOf(dreaming), executionId, status, now);

const closeState = (
  state: AiIndexDreamingState,
  executionId: string,
  status: Exclude<DreamingRunStatus, 'running'>,
  now: Date
): AiIndexDreamingState => {
  if (state.last_run?.execution_id !== executionId) {
    throw new DreamingStateConflictError(
      `Dreaming run '${executionId}' is not the latest run of this AI index.`
    );
  }
  return {
    ...state,
    last_run: { ...state.last_run, status, completed_at: now.toISOString() },
  };
};

/** Queues groups for the next run, outside of any run, as forget does. */
export const queueRetries = (
  dreaming: AiIndexDreaming | undefined,
  additions: readonly DreamingRetryEntry[]
): AiIndexDreamingState => {
  const state = stateOf(dreaming);
  const { retry } = mergeRetryEntries(state.retry, additions);
  return { ...state, retry };
};
