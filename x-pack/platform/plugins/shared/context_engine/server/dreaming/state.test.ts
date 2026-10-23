/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AiIndexDreaming, DreamingRetryEntry } from '../../common/dreaming';
import { MAX_DREAMING_RETRY_ENTRIES } from '../../common/dreaming';
import { DreamingStateConflictError } from './errors';
import {
  DREAMING_RUN_TIMEOUT_MS,
  applyStateUpdate,
  closeRun,
  completeRun,
  mergeRetryEntries,
  queueRetries,
  runningExecutionId,
  startRun,
  stateOf,
} from './state';

const now = new Date('2026-10-23T12:00:00.000Z');
const cursor = (timestamp: string, memoryId = '') => ({ timestamp, memory_id: memoryId });
const retry = (groupKey: string, timestamp: string): DreamingRetryEntry => ({
  group_key: groupKey,
  from: cursor(timestamp),
});

const running = (overrides: Partial<AiIndexDreaming['state']> = {}): AiIndexDreaming => ({
  enabled: true,
  state: {
    ...startRun(undefined, 'exec-1', now),
    cursor: cursor('2026-10-23T10:00:00.000Z', 'm-1'),
    ...overrides,
  },
});

describe('dreaming state', () => {
  describe('runningExecutionId', () => {
    it('returns the running execution until it times out', () => {
      const state = stateOf(running());
      expect(runningExecutionId(state, now)).toBe('exec-1');
      expect(
        runningExecutionId(state, new Date(now.getTime() + DREAMING_RUN_TIMEOUT_MS + 1))
      ).toBeUndefined();
    });
  });

  describe('mergeRetryEntries', () => {
    it('keeps the earliest position per group', () => {
      const { retry: merged } = mergeRetryEntries(
        [retry('s1', '2026-10-23T09:00:00.000Z')],
        [retry('s1', '2026-10-23T08:00:00.000Z'), retry('s2', '2026-10-23T09:30:00.000Z')]
      );
      expect(merged).toEqual([
        retry('s1', '2026-10-23T08:00:00.000Z'),
        retry('s2', '2026-10-23T09:30:00.000Z'),
      ]);
    });

    it('reports entries over the cap as overflow', () => {
      const entries = Array.from({ length: MAX_DREAMING_RETRY_ENTRIES + 2 }, (_, index) =>
        retry(`s${index}`, '2026-10-23T09:00:00.000Z')
      );
      const { retry: merged, overflow } = mergeRetryEntries([], entries);
      expect(merged).toHaveLength(MAX_DREAMING_RETRY_ENTRIES);
      expect(overflow).toHaveLength(2);
    });
  });

  describe('applyStateUpdate', () => {
    it('lets the running execution move the cursor forward', () => {
      const state = applyStateUpdate(
        running(),
        { execution_id: 'exec-1', cursor: cursor('2026-10-23T11:00:00.000Z', 'm-9'), retry: [] },
        now
      );
      expect(state.cursor).toEqual(cursor('2026-10-23T11:00:00.000Z', 'm-9'));
    });

    it('refuses another execution', () => {
      expect(() =>
        applyStateUpdate(
          running(),
          { execution_id: 'exec-2', cursor: cursor('2026-10-23T11:00:00.000Z'), retry: [] },
          now
        )
      ).toThrow(DreamingStateConflictError);
    });

    it('refuses to move the cursor backwards without reset', () => {
      expect(() =>
        applyStateUpdate(
          running(),
          { execution_id: 'exec-1', cursor: cursor('2026-10-23T09:00:00.000Z'), retry: [] },
          now
        )
      ).toThrow(DreamingStateConflictError);
    });

    it('allows a reset outside of a run', () => {
      const dreaming: AiIndexDreaming = {
        enabled: true,
        state: { cursor: cursor('2026-10-23T10:00:00.000Z'), retry: [] },
      };
      const state = applyStateUpdate(
        dreaming,
        { cursor: cursor('2026-01-01T00:00:00.000Z'), retry: [], reset: true },
        now
      );
      expect(state.cursor).toEqual(cursor('2026-01-01T00:00:00.000Z'));
    });

    it('refuses a reset while another run is in progress', () => {
      expect(() =>
        applyStateUpdate(
          running(),
          { cursor: cursor('2026-01-01T00:00:00.000Z'), retry: [], reset: true },
          now
        )
      ).toThrow(DreamingStateConflictError);
    });
  });

  describe('completeRun', () => {
    it('keeps retries queued during the run and drops consumed ones', () => {
      const consumed = retry('s-old', '2026-10-23T08:00:00.000Z');
      const queuedByForget = retry('s-forget', '2026-10-23T07:00:00.000Z');
      const dreaming = running({ retry: [consumed, queuedByForget] });

      const state = completeRun(
        dreaming,
        {
          execution_id: 'exec-1',
          cursor: cursor('2026-10-23T11:00:00.000Z', 'm-9'),
          retry: [retry('s-failed', '2026-10-23T10:30:00.000Z')],
          consumed: [consumed],
        },
        'partial',
        now
      );

      expect(state.cursor).toEqual(cursor('2026-10-23T11:00:00.000Z', 'm-9'));
      expect(state.retry.map(({ group_key: groupKey }) => groupKey).sort()).toEqual([
        's-failed',
        's-forget',
      ]);
      expect(state.last_run).toMatchObject({ execution_id: 'exec-1', status: 'partial' });
      expect(state.last_run?.completed_at).toBe(now.toISOString());
    });

    it('leaves the cursor in place when none is given', () => {
      const state = completeRun(
        running(),
        { execution_id: 'exec-1', retry: [], consumed: [] },
        'succeeded',
        now
      );
      expect(state.cursor).toEqual(cursor('2026-10-23T10:00:00.000Z', 'm-1'));
    });
  });

  describe('closeRun', () => {
    it('records the outcome without touching cursor or retries', () => {
      const dreaming = running({ retry: [retry('s1', '2026-10-23T08:00:00.000Z')] });
      const state = closeRun(dreaming, 'exec-1', 'succeeded', now);
      expect(state.cursor).toEqual(dreaming.state?.cursor);
      expect(state.retry).toEqual(dreaming.state?.retry);
      expect(state.last_run?.status).toBe('succeeded');
    });

    it('refuses a run that is not the latest', () => {
      expect(() => closeRun(running(), 'exec-2', 'succeeded', now)).toThrow(
        DreamingStateConflictError
      );
    });
  });

  it('queueRetries merges into the existing list', () => {
    const state = queueRetries(running({ retry: [retry('s1', '2026-10-23T09:00:00.000Z')] }), [
      retry('s1', '2026-10-23T08:00:00.000Z'),
    ]);
    expect(state.retry).toEqual([retry('s1', '2026-10-23T08:00:00.000Z')]);
  });
});
