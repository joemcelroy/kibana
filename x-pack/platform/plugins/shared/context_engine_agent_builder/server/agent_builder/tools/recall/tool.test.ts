/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { agentBuilderMocks } from '@kbn/agent-builder-plugin/server/mocks';
import { ToolResultType } from '@kbn/agent-builder-common/tools/tool_result';
import type { ToolHandlerContext, ToolHandlerStandardReturn } from '@kbn/agent-builder-server';
import { chooseRecallAiIndices, createRecallTool } from './tool';

describe('chooseRecallAiIndices', () => {
  const agentAiIndices = ['elastic', 'user-memories', 'support'];

  it("searches all of the agent's AI indices when none are given", () => {
    expect(chooseRecallAiIndices({ agentAiIndices })).toEqual(agentAiIndices);
    expect(chooseRecallAiIndices({ agentAiIndices, requested: [] })).toEqual(agentAiIndices);
  });

  it("narrows to the requested AI indices among the agent's", () => {
    expect(chooseRecallAiIndices({ agentAiIndices, requested: ['user-memories'] })).toEqual([
      'user-memories',
    ]);
  });

  it("refuses an AI index outside the agent's", () => {
    expect(() =>
      chooseRecallAiIndices({ agentAiIndices, requested: ['user-memories', 'payroll'] })
    ).toThrow("'payroll' not among this agent's AI indices: 'elastic', 'user-memories', 'support'");
  });

  it('searches nothing for an agent without AI indices', () => {
    expect(chooseRecallAiIndices({ agentAiIndices: [] })).toEqual([]);
  });

  it('uses the requested AI indices as they are outside an agent, and every AI index without them', () => {
    expect(chooseRecallAiIndices({ requested: ['payroll'] })).toEqual(['payroll']);
    expect(chooseRecallAiIndices({})).toBeUndefined();
  });
});

describe('recall tool', () => {
  const recall = jest.fn();
  const tool = createRecallTool({ getContextEngineStart: async () => ({ recall }) });

  const contextFor = (aiIndices?: string[]) => {
    const context = agentBuilderMocks.tools.createHandlerContext();
    return {
      ...context,
      spaceId: 'space-1',
      runContext: {
        runId: 'run-1',
        stack: aiIndices
          ? [{ type: 'agent' as const, agentId: 'agent-1', conversationId: 'c-1', aiIndices }]
          : [],
      },
    } as unknown as ToolHandlerContext;
  };

  beforeEach(() => {
    recall.mockReset();
    recall.mockResolvedValue({ scope: 'ai-index', query_type: 'text', results: [] });
  });

  it("searches the agent's AI indices for plain words", async () => {
    const context = contextFor(['elastic', 'user-memories']);

    await tool.handler!({ query: 'which seat?' }, context);

    expect(recall).toHaveBeenCalledWith({
      spaceId: 'space-1',
      request: context.request,
      input: { query: 'which seat?', ai_index_ids: ['elastic', 'user-memories'] },
    });
  });

  it('passes short-term scope and limit through', async () => {
    await tool.handler!(
      { query: 'which seat?', scope: 'short-term', aiIndexIds: ['user-memories'], limit: 5 },
      contextFor(['elastic', 'user-memories'])
    );

    expect(recall.mock.calls[0][0].input).toEqual({
      query: 'which seat?',
      scope: 'short-term',
      ai_index_ids: ['user-memories'],
      limit: 5,
    });
  });

  it("leaves an ES|QL query's AI indices to its FROM", async () => {
    await tool.handler!(
      { query: 'FROM ai-index-idx-support | WHERE type == ?type', params: { type: 'faq' } },
      contextFor(['elastic'])
    );

    expect(recall.mock.calls[0][0].input).toEqual({
      query: 'FROM ai-index-idx-support | WHERE type == ?type',
      params: { type: 'faq' },
    });
  });

  it('refuses AI indices outside the agent’s, and reports Context Engine errors', async () => {
    const refused = await tool.handler!(
      { query: 'which seat?', aiIndexIds: ['payroll'] },
      contextFor(['elastic'])
    );
    expect(recall).not.toHaveBeenCalled();
    expect((refused as ToolHandlerStandardReturn).results[0].type).toBe(ToolResultType.error);

    recall.mockRejectedValue(new Error('Insufficient privileges to read Context Engine.'));
    const failed = await tool.handler!({ query: 'which seat?' }, contextFor(['elastic']));
    expect((failed as ToolHandlerStandardReturn).results[0].data).toEqual({
      message: 'Failed to recall: Insufficient privileges to read Context Engine.',
    });
  });
});
