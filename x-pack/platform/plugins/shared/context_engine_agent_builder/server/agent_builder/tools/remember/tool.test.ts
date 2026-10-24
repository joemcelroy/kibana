/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { agentBuilderMocks } from '@kbn/agent-builder-plugin/server/mocks';
import { contextEngineMemoryTools } from '@kbn/agent-builder-common/tools';
import { ToolResultType } from '@kbn/agent-builder-common/tools/tool_result';
import type { ToolHandlerContext } from '@kbn/agent-builder-server';
import type { ShortTermMemoryServiceApi } from '@kbn/context-engine-plugin/server/short_term_memory/service';
import { coreMock } from '@kbn/core/server/mocks';
import { assertContextEngineWriteAccess } from '../../assert_context_engine_write_access';
import { createRememberTool } from './tool';

jest.mock('../../assert_context_engine_write_access', () => ({
  assertContextEngineWriteAccess: jest.fn(),
}));

const assertContextEngineWriteAccessMock = jest.mocked(assertContextEngineWriteAccess);

describe('remember tool', () => {
  const remember = jest.fn();
  const memoryEnabled = jest.fn();
  const getCurrentUser = jest.fn();

  const createTool = () =>
    createRememberTool({
      getShortTermMemory: async () => ({ remember } as unknown as ShortTermMemoryServiceApi),
      getCoreStart: async () => {
        const coreStart = coreMock.createStart();
        coreStart.uiSettings.globalAsScopedToClient = jest
          .fn()
          .mockReturnValue({ get: memoryEnabled });
        coreStart.security.authc.getCurrentUser = getCurrentUser;
        return coreStart;
      },
      getSecurityStart: async () => undefined,
      generateId: () => 'memory-1',
      generateSessionId: () => 'generated-session-id',
      getCurrentDate: () => new Date('2026-10-23T12:00:00.000Z'),
    });

  const createContext = (conversationId: string | undefined, callSource?: 'mcp') => {
    const context = agentBuilderMocks.tools.createHandlerContext();
    return {
      ...context,
      ...(callSource !== undefined && {
        callContext: { ...context.callContext, callSource },
      }),
      spaceId: 'space-1',
      runContext: {
        runId: 'run-1',
        stack: [
          {
            type: 'agent' as const,
            agentId: 'agent-1',
            ...(conversationId !== undefined && { conversationId }),
          },
          { type: 'tool' as const, toolId: contextEngineMemoryTools.remember },
        ],
      },
    } as unknown as ToolHandlerContext;
  };

  const params = { content: 'Cast duration_ms with TO_DOUBLE before numeric comparisons.' };

  const run = async (
    input: Parameters<NonNullable<ReturnType<typeof createTool>['handler']>>[0] = params,
    conversationId: string | undefined = 'conversation-1',
    callSource?: 'mcp'
  ) => {
    const { handler } = createTool();
    if (!handler) {
      throw new Error('Expected remember tool handler');
    }
    return handler(input, createContext(conversationId, callSource));
  };

  beforeEach(() => {
    jest.clearAllMocks();
    assertContextEngineWriteAccessMock.mockResolvedValue();
    memoryEnabled.mockResolvedValue(true);
    getCurrentUser.mockReturnValue({ username: 'jdoe', profile_uid: 'u_jdoe' });
  });

  it('accepts content with an optional session and user flag', () => {
    const tool = createTool();

    expect(tool.id).toBe(contextEngineMemoryTools.remember);
    expect(tool.availability?.cacheMode).toBe('none');
    expect(tool.schema.safeParse(params).success).toBe(true);
    expect(tool.schema.safeParse({ ...params, aboutUser: true }).success).toBe(true);
    expect(tool.schema.safeParse({ content: '' }).success).toBe(false);
    expect(tool.schema.shape.sessionId.description).toContain(
      'sessionId returned by an earlier remember call'
    );
  });

  it('appends a shared short-term memory for the conversation', async () => {
    const result = await run({ ...params, sessionId: 'ignored-session-id' });

    expect(assertContextEngineWriteAccessMock).toHaveBeenCalled();
    expect(remember).toHaveBeenCalledWith('space-1', {
      '@timestamp': '2026-10-23T12:00:00.000Z',
      id: 'memory-1',
      session_id: 'conversation-1',
      content: params.content,
    });
    expect(getCurrentUser).not.toHaveBeenCalled();
    expect(result).toEqual({
      results: [
        { type: ToolResultType.other, data: { id: 'memory-1', sessionId: 'conversation-1' } },
      ],
    });
  });

  it('records the current user when the memory is about them', async () => {
    await run({ ...params, aboutUser: true });

    expect(remember).toHaveBeenCalledWith(
      'space-1',
      expect.objectContaining({ user_id: 'u_jdoe' })
    );
  });

  it('rejects non-MCP calls outside a conversation', async () => {
    const result = await run(params, '');

    expect(result).toEqual({
      results: [
        {
          type: ToolResultType.error,
          data: { message: 'Cannot store memory outside an Agent Builder conversation.' },
        },
      ],
    });
    expect(assertContextEngineWriteAccessMock).not.toHaveBeenCalled();
    expect(remember).not.toHaveBeenCalled();
  });

  it('generates a session id for an MCP call without one, and reuses a supplied one', async () => {
    const generated = await run(params, '', 'mcp');
    const reused = await run({ ...params, sessionId: 'existing-session-id' }, '', 'mcp');

    expect(remember.mock.calls.map(([, memory]) => memory.session_id)).toEqual([
      'generated-session-id',
      'existing-session-id',
    ]);
    expect(generated).toEqual({
      results: [
        { type: ToolResultType.other, data: { id: 'memory-1', sessionId: 'generated-session-id' } },
      ],
    });
    expect(reused).toEqual({
      results: [
        { type: ToolResultType.other, data: { id: 'memory-1', sessionId: 'existing-session-id' } },
      ],
    });
  });

  it('refuses to write when memory is disabled', async () => {
    memoryEnabled.mockResolvedValue(false);

    const result = await run();

    expect(result).toEqual({
      results: [
        {
          type: ToolResultType.error,
          data: { message: 'Failed to store memory: Context Engine memory is not enabled.' },
        },
      ],
    });
    expect(remember).not.toHaveBeenCalled();
  });

  it('refuses to write without Context Engine write access', async () => {
    assertContextEngineWriteAccessMock.mockRejectedValue(new Error('Forbidden'));

    const result = await run();

    expect(result).toEqual({
      results: [
        { type: ToolResultType.error, data: { message: 'Failed to store memory: Forbidden' } },
      ],
    });
    expect(remember).not.toHaveBeenCalled();
  });
});
