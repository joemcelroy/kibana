/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { ToolType } from '@kbn/agent-builder-common';
import { contextEngineMemoryTools } from '@kbn/agent-builder-common/tools';
import { ToolResultType } from '@kbn/agent-builder-common/tools/tool_result';
import type { BuiltinToolDefinition } from '@kbn/agent-builder-server';
import { getAgentFromRunContext } from '@kbn/agent-builder-server';
import {
  MAX_SHORT_TERM_AI_INDEX_IDS,
  MAX_SHORT_TERM_CONTENT_LENGTH,
  MAX_SHORT_TERM_SESSION_ID_LENGTH,
} from '@kbn/context-engine-plugin/common/dreaming';
import type { ContextEnginePluginStart } from '@kbn/context-engine-plugin/server';
import type { CoreStart } from '@kbn/core/server';
import { z } from '@kbn/zod/v4';
import dedent from 'dedent';
import { createMemoryToolsAvailability } from '../ai_index_tools_availability';
import { chooseMemoryTargets } from './targets';

const rememberSchema = z.object({
  content: z
    .string()
    .min(1)
    .max(MAX_SHORT_TERM_CONTENT_LENGTH)
    .describe('What to remember, with enough context to use it without re-deriving it.'),
  sessionId: z
    .string()
    .min(1)
    .max(MAX_SHORT_TERM_SESSION_ID_LENGTH)
    .optional()
    .describe(
      'For MCP calls only: omit unless continuing a memory session using the sessionId returned by an earlier remember call. Do not invent a value. Agent Builder calls ignore this input and use the current conversation ID.'
    ),
  aboutUser: z
    .boolean()
    .optional()
    .describe(
      'True when the memory is about the current user, such as their preferences or role, so it is kept in their own long-term memory. Omit for knowledge useful to anyone in this space.'
    ),
  aiIndexIds: z
    .array(z.string().min(1))
    .max(MAX_SHORT_TERM_AI_INDEX_IDS)
    .optional()
    .describe(
      "The AI indices whose long-term memory this belongs in, by id. In an Agent Builder conversation, omit to use the agent's own memory AI indices; outside one, omit to let every AI index with dreaming turned on use it."
    ),
  dreamNow: z
    .boolean()
    .optional()
    .describe(
      'True to turn this session’s memories into long-term memory now, in each AI index the memory goes to, instead of waiting for the schedule. Set it only on the last remember call of a session.'
    ),
});

export const createRememberTool = ({
  getContextEngineStart,
  getCoreStart,
}: {
  getContextEngineStart: () => Promise<
    Pick<ContextEnginePluginStart, 'resolveMemoryTargets' | 'remember'>
  >;
  getCoreStart: () => Promise<CoreStart>;
}): BuiltinToolDefinition<typeof rememberSchema> => ({
  id: contextEngineMemoryTools.remember,
  type: ToolType.builtin,
  availability: createMemoryToolsAvailability(getCoreStart),
  tags: ['context_engine', 'memory'],
  annotations: {
    title: 'Remember',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  description: dedent`
    Record something learned in this session in Context Engine short-term memory.
    Short-term memory is not recalled directly. AI indices with dreaming turned on later turn it
    into long-term facts, entities and relationships that are shared with users and agents that
    can access those AI indices. Record findings useful in later sessions, such as discovered
    patterns, effective approaches, domain knowledge, or what was tried and what worked. Each call
    appends one memory; to correct one, remember the correction or forget the memory by its id.
    Put what to remember in content.
    Set aboutUser when the memory is about the current user. This tool handles the session and
    user server-side. For MCP calls, omit sessionId unless continuing with the sessionId returned
    by an earlier remember call. Agent Builder calls ignore sessionId and use the current
    conversation ID.
    In an Agent Builder conversation, memories go to the agent's own AI indices that have memory
    on: a memory about the user goes to all of them, any other to the shared ones. An AI index
    that keeps each user's memory apart always records the current user. Set aiIndexIds to pick
    among them. Outside a conversation, set aiIndexIds to the AI indices the memory belongs in,
    using ids from the list or describe AI Index tools; without it, every AI index with dreaming
    on may use it. Set dreamNow on the last remember call of a session to make it long-term
    memory right away.
  `,
  schema: rememberSchema,
  handler: async (params, context) => {
    const { request, spaceId, runContext, logger, callContext } = context;
    const agent = getAgentFromRunContext(runContext);
    const conversationId = agent?.conversationId || undefined;

    if (!conversationId && callContext?.callSource !== 'mcp') {
      return {
        results: [
          {
            type: ToolResultType.error,
            data: { message: 'Cannot store memory outside an Agent Builder conversation.' },
          },
        ],
      };
    }

    try {
      const contextEngine = await getContextEngineStart();
      const agentAiIndices = conversationId ? agent?.aiIndices : undefined;
      const targets = await chooseMemoryTargets({
        contextEngine,
        spaceId,
        agentAiIndices,
        requested: params.aiIndexIds,
        aboutUser: params.aboutUser === true,
      });
      if (params.dreamNow && targets.length === 0) {
        throw new Error('dreamNow needs an AI index to dream in: set aiIndexIds.');
      }
      const aiIndexIds = targets.map(({ aiIndexId }) => aiIndexId);
      // Context Engine checks the caller's access, records them as the user when it should, and
      // starts the dream.
      const remembered = await contextEngine.remember({
        spaceId,
        request,
        // In a conversation the targets are the agent's, user-memories among them when the agent
        // remembers users. Over MCP, a hidden AI index named in aiIndexIds is refused.
        includeHidden: agentAiIndices !== undefined,
        input: {
          content: params.content,
          ...((conversationId ?? params.sessionId) && {
            session_id: conversationId ?? params.sessionId,
          }),
          ...(params.aboutUser && { about_user: true }),
          ...(aiIndexIds.length > 0 && { ai_index_ids: aiIndexIds }),
          ...(params.dreamNow && { dream_now: true }),
        },
      });

      return {
        results: [
          {
            type: ToolResultType.other,
            data: {
              id: remembered.id,
              sessionId: remembered.session_id,
              ...(remembered.ai_index_ids && { aiIndexIds: remembered.ai_index_ids }),
              ...(remembered.dreams && {
                dreams: remembered.dreams.map(
                  ({ ai_index_id: aiIndexId, run_id: runId, ...rest }) => ({
                    aiIndexId,
                    ...rest,
                    ...(runId && { runId }),
                  })
                ),
              }),
            },
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Error running ${contextEngineMemoryTools.remember}: ${message}`, { error });
      return {
        results: [
          {
            type: ToolResultType.error,
            data: { message: `Failed to store memory: ${message}` },
          },
        ],
      };
    }
  },
});
