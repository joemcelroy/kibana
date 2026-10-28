/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ElasticsearchClient, KibanaRequest } from '@kbn/core/server';
import { SHARED_MEMORY_OWNER, type AiIndexDreaming } from '../../common/dreaming';
import type { AiIndexService } from '../ai_indices/service';
import {
  assertMemoryTargets,
  authorizeMemoryTargets,
  dreamTargetOf,
  requestDream,
  resolveMemoryTargets,
  resolveRoundTargets,
} from './request_dream';
import { AiIndexNotFoundError } from '../ai_indices/errors';
import type { DreamingScheduleService } from './schedule';

describe('request_dream', () => {
  const aiIndices: Record<
    string,
    { memory_enabled: boolean; memory_scope?: 'shared' | 'user'; dreaming?: AiIndexDreaming }
  > = {
    sessions: { memory_enabled: true, dreaming: { enabled: true, group_by: 'session_id' } },
    users: { memory_enabled: true, dreaming: { enabled: true, group_by: 'user_id' } },
    asleep: { memory_enabled: true, dreaming: { enabled: false } },
    forgetful: { memory_enabled: false },
    personal: { memory_enabled: true, memory_scope: 'user', dreaming: { enabled: true } },
    rounds: {
      memory_enabled: true,
      memory_scope: 'user',
      dreaming: { enabled: true, rounds: true },
    },
    roundsAsleep: {
      memory_enabled: true,
      memory_scope: 'user',
      dreaming: { enabled: false, rounds: true },
    },
    sharedRounds: { memory_enabled: true, dreaming: { enabled: true, rounds: true } },
    noRounds: { memory_enabled: true, dreaming: { enabled: true, rounds: false } },
  };

  const aiIndexService = {
    get: jest.fn(async (id: string) => {
      const aiIndex = aiIndices[id];
      if (!aiIndex) {
        throw new Error(`AI index '${id}' not found`);
      }
      return {
        id,
        memory_enabled: aiIndex.memory_enabled,
        ...(aiIndex.memory_scope && { memory_scope: aiIndex.memory_scope }),
        dest: { value: `ai-index-idx-${id}` },
      };
    }),
    getDreaming: jest.fn(async (id: string) => aiIndices[id]?.dreaming),
  } as unknown as AiIndexService;

  const hasPrivileges = jest.fn();
  const currentUserClient = {
    security: { hasPrivileges },
  } as unknown as ElasticsearchClient;
  const run = jest.fn();
  const dreamingSchedule = { run } as unknown as DreamingScheduleService;
  const request = {} as KibanaRequest;

  beforeEach(() => {
    jest.clearAllMocks();
    hasPrivileges.mockResolvedValue({ has_all_requested: true });
    run.mockImplementation(async ({ aiIndexId }) => `run-${aiIndexId}`);
  });

  describe('assertMemoryTargets', () => {
    it('accepts AI indices that exist and have memory on', async () => {
      await expect(
        assertMemoryTargets({ aiIndexService, spaceId: 'default', aiIndexIds: ['sessions'] })
      ).resolves.toBeUndefined();
    });

    it('rejects a missing AI index or one without memory', async () => {
      await expect(
        assertMemoryTargets({ aiIndexService, spaceId: 'default', aiIndexIds: ['missing'] })
      ).rejects.toThrow("AI index 'missing' not found");
      await expect(
        assertMemoryTargets({ aiIndexService, spaceId: 'default', aiIndexIds: ['forgetful'] })
      ).rejects.toThrow("AI index 'forgetful' does not have memory enabled");
    });

    it('requires a user for an AI index that keeps each user’s memory apart', async () => {
      await expect(
        assertMemoryTargets({ aiIndexService, spaceId: 'default', aiIndexIds: ['personal'] })
      ).rejects.toThrow("AI index 'personal' keeps each user's memory apart");
      await expect(
        assertMemoryTargets({
          aiIndexService,
          spaceId: 'default',
          aiIndexIds: ['personal'],
          userId: 'u-1',
        })
      ).resolves.toBeUndefined();
    });

    it('rejects more targets than a memory may hold', async () => {
      await expect(
        assertMemoryTargets({
          aiIndexService,
          spaceId: 'default',
          aiIndexIds: Array.from({ length: 21 }, (_, index) => `idx-${index}`),
        })
      ).rejects.toThrow('at most 20 AI indices');
    });
  });

  describe('recorded rounds', () => {
    it('go to every AI index that dreams, shared or per user, unless it turns rounds off', async () => {
      await expect(
        resolveRoundTargets({
          aiIndexService,
          spaceId: 'default',
          aiIndexIds: [
            'sessions',
            'personal',
            'rounds',
            'roundsAsleep',
            'sharedRounds',
            'noRounds',
            'asleep',
            'forgetful',
            'rounds',
          ],
        })
      ).resolves.toEqual(['sessions', 'personal', 'rounds', 'sharedRounds']);
    });

    it('are refused by an AI index that does not dream or turns rounds off, and without a user', async () => {
      await expect(
        assertMemoryTargets({
          aiIndexService,
          spaceId: 'default',
          aiIndexIds: ['rounds', 'sharedRounds', 'sessions'],
          userId: 'u-1',
          round: true,
        })
      ).resolves.toBeUndefined();
      for (const aiIndexId of ['roundsAsleep', 'noRounds', 'forgetful']) {
        await expect(
          assertMemoryTargets({
            aiIndexService,
            spaceId: 'default',
            aiIndexIds: [aiIndexId],
            userId: 'u-1',
            round: true,
          })
        ).rejects.toThrow(`AI index '${aiIndexId}' does not take conversation rounds`);
      }
      await expect(
        assertMemoryTargets({
          aiIndexService,
          spaceId: 'default',
          aiIndexIds: ['rounds'],
          round: true,
        })
      ).rejects.toThrow('A recorded round must be about a user.');
    });
  });

  describe('resolveMemoryTargets', () => {
    it('keeps the AI indices that take memories, with their scope, and skips the rest', async () => {
      (aiIndexService.get as jest.Mock).mockImplementationOnce(async () => {
        throw new AiIndexNotFoundError('missing');
      });
      await expect(
        resolveMemoryTargets({
          aiIndexService,
          spaceId: 'default',
          aiIndexIds: ['missing', 'sessions', 'forgetful', 'personal', 'sessions'],
        })
      ).resolves.toEqual([
        { aiIndexId: 'sessions', memoryScope: 'shared' },
        { aiIndexId: 'personal', memoryScope: 'user' },
      ]);
    });
  });

  describe('authorizeMemoryTargets', () => {
    it('requires write access to every target’s backing index', async () => {
      hasPrivileges.mockResolvedValueOnce({ has_all_requested: true });
      hasPrivileges.mockResolvedValueOnce({ has_all_requested: false });

      await expect(
        authorizeMemoryTargets({
          aiIndexService,
          spaceId: 'default',
          aiIndexIds: ['sessions', 'users'],
          currentUserClient,
        })
      ).rejects.toThrow("Missing write privilege on 'ai-index-idx-users'");
      expect(hasPrivileges).toHaveBeenLastCalledWith({
        index: [{ names: ['ai-index-idx-users'], privileges: ['write'] }],
      });
    });
  });

  describe('dreamTargetOf', () => {
    it('dreams the memory’s session or user, by the AI index’s group_by', () => {
      const memory = { session_id: 's-1', user_id: 'u-1' };
      expect(dreamTargetOf(memory, 'session_id')).toEqual({ session_id: 's-1' });
      expect(dreamTargetOf(memory, 'user_id')).toEqual({ user_id: 'u-1' });
      expect(dreamTargetOf({ session_id: 's-1' }, 'user_id')).toEqual({
        user_id: SHARED_MEMORY_OWNER,
      });
      expect(dreamTargetOf({ session_id: 's-1' })).toEqual({ session_id: 's-1' });
    });
  });

  describe('requestDream', () => {
    it('starts a targeted run on each AI index and skips the ones that cannot dream', async () => {
      hasPrivileges.mockImplementation(async ({ index: [{ names }] }) => ({
        has_all_requested: names[0] !== 'ai-index-idx-locked',
      }));
      aiIndices.locked = { memory_enabled: true, dreaming: { enabled: true } };

      const results = await requestDream({
        aiIndexService,
        dreamingSchedule,
        spaceId: 'default',
        aiIndexIds: ['sessions', 'users', 'asleep', 'locked', 'sessions'],
        memory: { session_id: 's-1' },
        request,
        currentUserClient,
      });

      expect(results).toEqual([
        { aiIndexId: 'sessions', status: 'started', runId: 'run-sessions' },
        { aiIndexId: 'users', status: 'started', runId: 'run-users' },
        { aiIndexId: 'asleep', status: 'skipped', reason: 'Dreaming is not turned on.' },
        {
          aiIndexId: 'locked',
          status: 'skipped',
          reason: expect.stringContaining("Missing write privilege on 'ai-index-idx-locked'"),
        },
      ]);
      expect(run).toHaveBeenCalledWith({
        aiIndexId: 'sessions',
        spaceId: 'default',
        target: { session_id: 's-1' },
        dryRun: false,
        request,
      });
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({ aiIndexId: 'users', target: { user_id: SHARED_MEMORY_OWNER } })
      );
      delete aiIndices.locked;
    });

    it('reports a run that fails to start as skipped', async () => {
      run.mockRejectedValue(new Error('Dreaming is not scheduled'));

      const results = await requestDream({
        aiIndexService,
        dreamingSchedule,
        spaceId: 'default',
        aiIndexIds: ['sessions'],
        memory: { session_id: 's-1' },
        request,
        currentUserClient,
      });

      expect(results).toEqual([
        { aiIndexId: 'sessions', status: 'skipped', reason: 'Dreaming is not scheduled' },
      ]);
    });
  });
});
