/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { agentBuilderMocks } from '@kbn/agent-builder-plugin/server/mocks';
import { contextEngineMemoryTools } from '@kbn/agent-builder-common/tools';
import { ToolResultType } from '@kbn/agent-builder-common/tools/tool_result';
import type { ToolHandlerContext, ToolHandlerStandardReturn } from '@kbn/agent-builder-server';
import { coreMock } from '@kbn/core/server/mocks';
import { createRememberTool } from './tool';

describe('remember tool', () => {
  const remember = jest.fn();
  const resolveMemoryTargets = jest.fn();

  const createTool = () =>
    createRememberTool({
      getContextEngineStart: async () => ({ resolveMemoryTargets, remember }),
      getCoreStart: async () => coreMock.createStart(),
    });

  const createContext = (
    conversationId: string | undefined,
    callSource?: 'mcp',
    aiIndices?: string[]
  ) => {
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
            ...(aiIndices !== undefined && { aiIndices }),
          },
          { type: 'tool' as const, toolId: contextEngineMemoryTools.remember },
        ],
      },
    } as unknown as ToolHandlerContext;
  };

  const params = { content: 'Cast duration_ms with TO_DOUBLE before numeric comparisons.' };

  const run = async (
    input: Parameters<NonNullable<ReturnType<typeof createTool>['handler']>>[0] = params,
    /** `null` for a call outside a conversation. */
    conversationId: string | null = 'conversation-1',
    callSource?: 'mcp',
    aiIndices?: string[]
  ) => {
    const { handler } = createTool();
    if (!handler) {
      throw new Error('Expected remember tool handler');
    }
    return handler(input, createContext(conversationId ?? undefined, callSource, aiIndices));
  };

  const rememberedWith = () => remember.mock.calls[0][0].input;

  beforeEach(() => {
    jest.clearAllMocks();
    remember.mockImplementation(async ({ input }) => ({
      id: 'memory-1',
      session_id: input.session_id ?? 'generated-session-id',
      ...(input.ai_index_ids && { ai_index_ids: input.ai_index_ids }),
    }));
    const scopes: Record<string, 'shared' | 'user'> = {
      'support-insights': 'shared',
      'team-notes': 'shared',
      'user-memories': 'user',
    };
    resolveMemoryTargets.mockImplementation(async ({ aiIndexIds }: { aiIndexIds: string[] }) =>
      aiIndexIds.flatMap((aiIndexId) =>
        scopes[aiIndexId] ? [{ aiIndexId, memoryScope: scopes[aiIndexId] }] : []
      )
    );
  });

  it('accepts content with an optional session and user flag, and content only', () => {
    const tool = createTool();

    expect(tool.id).toBe(contextEngineMemoryTools.remember);
    expect(tool.availability?.cacheMode).toBe('none');
    expect(tool.schema.safeParse(params).success).toBe(true);
    expect(tool.schema.safeParse({ ...params, aboutUser: true }).success).toBe(true);
    expect(tool.schema.safeParse({ content: '' }).success).toBe(false);
    expect(tool.schema.safeParse({}).success).toBe(false);
    expect(tool.schema.shape.sessionId.description).toContain(
      'sessionId returned by an earlier remember call'
    );
  });

  it('remembers through Context Engine for the conversation, as the request', async () => {
    const context = createContext('conversation-1');
    const result = await createTool().handler!({ ...params, sessionId: 'ignored' }, context);

    expect(remember).toHaveBeenCalledWith({
      spaceId: 'space-1',
      request: context.request,
      input: { content: params.content, session_id: 'conversation-1' },
    });
    expect(result).toEqual({
      results: [
        { type: ToolResultType.other, data: { id: 'memory-1', sessionId: 'conversation-1' } },
      ],
    });
  });

  it('passes on that the memory is about the user', async () => {
    await run({ ...params, aboutUser: true });

    expect(rememberedWith()).toEqual(expect.objectContaining({ about_user: true }));
  });

  it('rejects non-MCP calls outside a conversation', async () => {
    const result = await run(params, null);

    expect(remember).not.toHaveBeenCalled();
    expect(result).toEqual({
      results: [
        {
          type: ToolResultType.error,
          data: { message: 'Cannot store memory outside an Agent Builder conversation.' },
        },
      ],
    });
  });

  it('lets Context Engine generate a session for an MCP call without one, and reuses a supplied one', async () => {
    const generated = await run(params, null, 'mcp');
    expect(rememberedWith()).not.toHaveProperty('session_id');
    expect((generated as ToolHandlerStandardReturn).results[0].data).toEqual({
      id: 'memory-1',
      sessionId: 'generated-session-id',
    });

    remember.mockClear();
    await run({ ...params, sessionId: 'mcp-session' }, null, 'mcp');
    expect(rememberedWith()).toEqual(expect.objectContaining({ session_id: 'mcp-session' }));
  });

  it('reports a refusal from Context Engine as an error result', async () => {
    remember.mockRejectedValue(new Error('Context Engine memory is not enabled.'));

    const result = await run();

    expect(result).toEqual({
      results: [
        {
          type: ToolResultType.error,
          data: { message: 'Failed to store memory: Context Engine memory is not enabled.' },
        },
      ],
    });
  });

  describe('targets', () => {
    it('passes requested AI indices and dream now, and returns the dreams', async () => {
      remember.mockResolvedValue({
        id: 'memory-1',
        session_id: 'session-1',
        ai_index_ids: ['support-insights'],
        dreams: [{ ai_index_id: 'support-insights', status: 'started', run_id: 'run-9' }],
      });

      const result = await run(
        { ...params, sessionId: 'session-1', aiIndexIds: ['support-insights'], dreamNow: true },
        null,
        'mcp'
      );

      expect(rememberedWith()).toEqual({
        content: params.content,
        session_id: 'session-1',
        ai_index_ids: ['support-insights'],
        dream_now: true,
      });
      expect((result as ToolHandlerStandardReturn).results[0].data).toEqual({
        id: 'memory-1',
        sessionId: 'session-1',
        aiIndexIds: ['support-insights'],
        dreams: [{ aiIndexId: 'support-insights', status: 'started', runId: 'run-9' }],
      });
    });

    it('treats an empty list as every AI index', async () => {
      await run({ ...params, aiIndexIds: [] }, null, 'mcp');

      expect(rememberedWith()).not.toHaveProperty('ai_index_ids');
    });

    it('rejects dream now without targets', async () => {
      const result = await run({ ...params, dreamNow: true }, null, 'mcp');

      expect(remember).not.toHaveBeenCalled();
      expect((result as ToolHandlerStandardReturn).results[0].type).toBe(ToolResultType.error);
    });

    it('rejects an AI index that does not take memories', async () => {
      const result = await run({ ...params, aiIndexIds: ['nope'] }, null, 'mcp');

      expect(remember).not.toHaveBeenCalled();
      expect((result as ToolHandlerStandardReturn).results[0].data).toEqual({
        message: "Failed to store memory: AI indices not found or without memory: 'nope'",
      });
    });

    it('sends a memory to the agent’s shared memory AI indices', async () => {
      await run(params, 'conversation-1', undefined, ['support-insights', 'user-memories']);

      expect(rememberedWith().ai_index_ids).toEqual(['support-insights']);
    });

    it('sends a memory about the user to all of the agent’s memory AI indices', async () => {
      await run({ ...params, aboutUser: true }, 'conversation-1', undefined, [
        'support-insights',
        'user-memories',
      ]);

      expect(rememberedWith().ai_index_ids).toEqual(['support-insights', 'user-memories']);
    });

    it('picks among the agent’s memory AI indices, and refuses others', async () => {
      await run({ ...params, aiIndexIds: ['team-notes'] }, 'conversation-1', undefined, [
        'support-insights',
        'team-notes',
      ]);
      expect(rememberedWith().ai_index_ids).toEqual(['team-notes']);

      remember.mockClear();
      const refused = await run(
        { ...params, aiIndexIds: ['user-memories'] },
        'conversation-1',
        undefined,
        ['support-insights']
      );
      expect(remember).not.toHaveBeenCalled();
      expect((refused as ToolHandlerStandardReturn).results[0].type).toBe(ToolResultType.error);
    });
  });
});
