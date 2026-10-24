/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { contextEngineMemoryTools } from '@kbn/agent-builder-common/tools';
import { ToolResultType } from '@kbn/agent-builder-common/tools/tool_result';
import { agentBuilderMocks } from '@kbn/agent-builder-plugin/server/mocks';
import type { ToolHandlerContext } from '@kbn/agent-builder-server';
import type { ShortTermMemory } from '@kbn/context-engine-plugin/common/dreaming';
import type { ShortTermMemoryServiceApi } from '@kbn/context-engine-plugin/server/short_term_memory/service';
import { coreMock } from '@kbn/core/server/mocks';
import { assertContextEngineWriteAccess } from '../../assert_context_engine_write_access';
import { createForgetTool } from './tool';

jest.mock('../../assert_context_engine_write_access', () => ({
  assertContextEngineWriteAccess: jest.fn(),
}));

const assertContextEngineWriteAccessMock = jest.mocked(assertContextEngineWriteAccess);

describe('forget tool', () => {
  const getByIds = jest.fn();
  const forgetMemory = jest.fn();
  const getCurrentUser = jest.fn();

  const memory = (userId?: string): ShortTermMemory => ({
    '@timestamp': '2026-10-23T10:00:00.000Z',
    id: 'memory-1',
    session_id: 'conversation-1',
    ...(userId !== undefined && { user_id: userId }),
    content: 'Cast duration_ms before numeric comparisons.',
  });

  const createTool = () =>
    createForgetTool({
      getShortTermMemory: async () => ({ getByIds } as unknown as ShortTermMemoryServiceApi),
      forgetMemory,
      getCoreStart: async () => {
        const coreStart = coreMock.createStart();
        coreStart.uiSettings.globalAsScopedToClient = jest
          .fn()
          .mockReturnValue({ get: jest.fn().mockResolvedValue(true) });
        coreStart.security.authc.getCurrentUser = getCurrentUser;
        return coreStart;
      },
      getSecurityStart: async () => undefined,
    });

  const run = async () => {
    const { handler } = createTool();
    if (!handler) {
      throw new Error('Expected forget tool handler');
    }
    return handler({ id: 'memory-1' }, {
      ...agentBuilderMocks.tools.createHandlerContext(),
      spaceId: 'space-1',
    } as unknown as ToolHandlerContext);
  };

  beforeEach(() => {
    jest.clearAllMocks();
    assertContextEngineWriteAccessMock.mockResolvedValue();
    getCurrentUser.mockReturnValue({ username: 'jdoe', profile_uid: 'u_jdoe' });
    getByIds.mockResolvedValue([memory()]);
    forgetMemory.mockResolvedValue({ forgotten: true, ai_index_ids: ['support'] });
  });

  it('registers an id-only destructive tool without confirmation', () => {
    const tool = createTool();

    expect(tool.id).toBe(contextEngineMemoryTools.forget);
    expect(tool.availability?.cacheMode).toBe('none');
    expect(tool.schema.safeParse({ id: 'memory-1' }).success).toBe(true);
    expect(tool.schema.safeParse({}).success).toBe(false);
    expect(tool.annotations?.destructiveHint).toBe(true);
    expect(tool.confirmation).toBeUndefined();
  });

  it('forgets a shared memory', async () => {
    const result = await run();

    expect(forgetMemory).toHaveBeenCalledWith('space-1', 'memory-1');
    expect(result).toEqual({
      results: [{ type: ToolResultType.other, data: { id: 'memory-1', forgotten: true } }],
    });
  });

  it('forgets a memory about the current user', async () => {
    getByIds.mockResolvedValue([memory('u_jdoe')]);

    await run();

    expect(forgetMemory).toHaveBeenCalledWith('space-1', 'memory-1');
  });

  it('refuses to forget a memory about another user', async () => {
    getByIds.mockResolvedValue([memory('u_other')]);

    const result = await run();

    expect(forgetMemory).not.toHaveBeenCalled();
    expect(result).toEqual({
      results: [
        {
          type: ToolResultType.error,
          data: {
            message:
              "Failed to forget memory: Memory 'memory-1' is about another user and cannot be forgotten.",
          },
        },
      ],
    });
  });

  it('reports a memory that no longer exists as not forgotten', async () => {
    getByIds.mockResolvedValue([]);

    const result = await run();

    expect(forgetMemory).not.toHaveBeenCalled();
    expect(result).toEqual({
      results: [{ type: ToolResultType.other, data: { id: 'memory-1', forgotten: false } }],
    });
  });

  it('refuses without Context Engine write access', async () => {
    assertContextEngineWriteAccessMock.mockRejectedValue(new Error('Forbidden'));

    const result = await run();

    expect(result).toEqual({
      results: [
        { type: ToolResultType.error, data: { message: 'Failed to forget memory: Forbidden' } },
      ],
    });
    expect(getByIds).not.toHaveBeenCalled();
  });
});
