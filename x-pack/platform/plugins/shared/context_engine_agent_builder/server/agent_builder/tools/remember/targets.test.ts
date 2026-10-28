/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { chooseMemoryTargets, type MemoryTargetsApi } from './targets';

describe('chooseMemoryTargets', () => {
  const scopes: Record<string, 'shared' | 'user'> = { notes: 'shared', mine: 'user' };
  const contextEngine: MemoryTargetsApi = {
    resolveMemoryTargets: jest.fn(async ({ aiIndexIds }) =>
      aiIndexIds.flatMap((aiIndexId) =>
        scopes[aiIndexId] ? [{ aiIndexId, memoryScope: scopes[aiIndexId] }] : []
      )
    ),
  };
  const choose = (args: Partial<Parameters<typeof chooseMemoryTargets>[0]>) =>
    chooseMemoryTargets({ contextEngine, spaceId: 'default', aboutUser: false, ...args });

  it('leaves a memory outside an agent untargeted unless asked', async () => {
    await expect(choose({})).resolves.toEqual([]);
    await expect(choose({ requested: ['mine', 'mine'] })).resolves.toEqual([
      { aiIndexId: 'mine', memoryScope: 'user' },
    ]);
    await expect(choose({ requested: ['elastic'] })).rejects.toThrow(
      "AI indices not found or without memory: 'elastic'"
    );
  });

  it('uses the agent’s shared memory AI indices for a memory not about the user', async () => {
    await expect(choose({ agentAiIndices: ['elastic', 'notes', 'mine'] })).resolves.toEqual([
      { aiIndexId: 'notes', memoryScope: 'shared' },
    ]);
  });

  it('uses all of the agent’s memory AI indices for a memory about the user', async () => {
    await expect(
      choose({ agentAiIndices: ['elastic', 'notes', 'mine'], aboutUser: true })
    ).resolves.toEqual([
      { aiIndexId: 'notes', memoryScope: 'shared' },
      { aiIndexId: 'mine', memoryScope: 'user' },
    ]);
  });

  it('falls back to user-scoped AI indices when the agent has nothing else', async () => {
    await expect(choose({ agentAiIndices: ['elastic', 'mine'] })).resolves.toEqual([
      { aiIndexId: 'mine', memoryScope: 'user' },
    ]);
    await expect(choose({ agentAiIndices: ['elastic'] })).resolves.toEqual([]);
  });

  it('picks among the agent’s memory AI indices only', async () => {
    await expect(
      choose({ agentAiIndices: ['notes', 'mine'], requested: ['mine'] })
    ).resolves.toEqual([{ aiIndexId: 'mine', memoryScope: 'user' }]);
    await expect(choose({ agentAiIndices: ['notes'], requested: ['mine'] })).rejects.toThrow(
      "'mine' not among this agent's memory AI indices: 'notes'"
    );
  });
});
