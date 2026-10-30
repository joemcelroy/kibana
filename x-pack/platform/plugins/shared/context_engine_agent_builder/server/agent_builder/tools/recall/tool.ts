/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { ToolType } from '@kbn/agent-builder-common';
import { contextEngineRecallTools } from '@kbn/agent-builder-common/tools';
import { ToolResultType } from '@kbn/agent-builder-common/tools/tool_result';
import type { BuiltinToolDefinition } from '@kbn/agent-builder-server';
import { getAgentFromRunContext } from '@kbn/agent-builder-server';
import {
  DEFAULT_AI_INDEX_QUERY_LIMIT,
  MAX_AI_INDEX_QUERY_LIMIT,
  MAX_AI_INDEX_QUERY_PARAMS,
  MAX_AI_INDEX_QUERY_PARAM_KEY_LENGTH,
  MAX_AI_INDEX_QUERY_PARAM_VALUE_LENGTH,
} from '@kbn/context-engine-plugin/common/constants';
import {
  DEFAULT_RECALL_LIMIT,
  DEFAULT_RECALL_SCOPE,
  MAX_RECALL_AI_INDICES,
  MAX_RECALL_LIMIT,
  MAX_RECALL_QUERY_LENGTH,
  RECALL_SCOPES,
} from '@kbn/context-engine-plugin/common/http_api/memory';
import type { ContextEnginePluginStart } from '@kbn/context-engine-plugin/server';
import { isEsqlQuery } from '@kbn/context-engine-plugin/server/memory/esql';
import { z } from '@kbn/zod/v4';
import dedent from 'dedent';
import { aiIndexToolsAvailability } from '../ai_index_tools_availability';
import { getErrorMessage } from '../ai_index_read_service';

const recallSchema = z.object({
  query: z
    .string()
    .min(1)
    .max(MAX_RECALL_QUERY_LENGTH)
    .describe(
      'What to look up: plain words, such as a question or the names involved, or an ES|QL query starting with FROM for counts, filters and exact lookups. ES|QL reads AI indices only: use the esql_target from the list or describe AI Index tools, and do not add a space condition, the server adds it.'
    ),
  scope: z
    .enum(RECALL_SCOPES)
    .optional()
    .describe(
      `(Optional) What to search. ai-index: the knowledge in AI indices, including long-term memory that was remembered and dreamed. short-term: memories remembered recently and not yet dreamed, shared ones and ones about the current user; plain words only. Defaults to ${DEFAULT_RECALL_SCOPE}.`
    ),
  aiIndexIds: z
    .array(z.string().min(1))
    .max(MAX_RECALL_AI_INDICES)
    .optional()
    .describe(
      "(Optional) For plain words: the AI indices to search, by id. With scope short-term, memories remembered for these AI indices, plus ones remembered for every AI index. In an Agent Builder conversation, omit to search all of the agent's AI indices; outside one, omit to search every AI index you can read. An ES|QL query's FROM names its AI indices instead."
    ),
  params: z
    .record(
      z.string().min(1).max(MAX_AI_INDEX_QUERY_PARAM_KEY_LENGTH),
      z.union([z.string().max(MAX_AI_INDEX_QUERY_PARAM_VALUE_LENGTH), z.number(), z.boolean()])
    )
    .refine((params) => Object.keys(params).length <= MAX_AI_INDEX_QUERY_PARAMS, {
      message: `params must not have more than ${MAX_AI_INDEX_QUERY_PARAMS} entries.`,
    })
    .optional()
    .describe('(Optional) For ES|QL: values for ?named parameters in the query.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_AI_INDEX_QUERY_LIMIT)
    .optional()
    .describe(
      `(Optional) Plain words: maximum results, default ${DEFAULT_RECALL_LIMIT}, at most ${MAX_RECALL_LIMIT}. ES|QL: maximum rows, default ${DEFAULT_AI_INDEX_QUERY_LIMIT}, at most ${MAX_AI_INDEX_QUERY_LIMIT}.`
    ),
});

/**
 * The AI indices a plain-language recall searches. In an agent, `requested` must be among the
 * agent's AI indices, and omitting it means all of them. Outside one, `requested` is used as is.
 */
export const chooseRecallAiIndices = ({
  agentAiIndices,
  requested,
}: {
  /** The agent's effective AI indices; `undefined` outside an agent. */
  agentAiIndices?: readonly string[];
  requested?: readonly string[];
}): string[] | undefined => {
  if (agentAiIndices === undefined) {
    return requested && [...requested];
  }
  if (!requested || requested.length === 0) {
    return [...agentAiIndices];
  }
  const outside = requested.filter((id) => !agentAiIndices.includes(id));
  if (outside.length > 0) {
    throw new Error(
      `${outside.map((id) => `'${id}'`).join(', ')} not among this agent's AI indices: ${
        agentAiIndices.map((id) => `'${id}'`).join(', ') || 'none'
      }`
    );
  }
  return [...requested];
};

export const createRecallTool = ({
  getContextEngineStart,
}: {
  getContextEngineStart: () => Promise<Pick<ContextEnginePluginStart, 'recall'>>;
}): BuiltinToolDefinition<typeof recallSchema> => ({
  id: contextEngineRecallTools.recall,
  type: ToolType.builtin,
  availability: aiIndexToolsAvailability,
  tags: ['context_engine', 'memory'],
  annotations: {
    title: 'Recall',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  description: dedent`
    Look up what Context Engine knows about something. Set scope to choose what to search.
    ai-index (the default): the knowledge in AI indices, including long-term memory that was
    remembered and dreamed. Plain words get a search
    by meaning and by words, best matches first, each with the AI index it came from. An ES|QL
    query (starting with FROM) returns its columns and rows: use it for counts, filters and exact
    lookups. Call the describe AI Index tool first for the FROM target, fields and example queries.
    The server adds the space filter and a row limit; put time constraints in the query or params.
    The space comes from the request. Over MCP that is the URL: /api/agent_builder/mcp is the
    default space, /s/{spaceId}/api/agent_builder/mcp is another space.
    short-term: memories remembered recently that dreaming has not turned into long-term memory
    yet. Searches their content by meaning. Finds shared memories and ones about the current user,
    never another user's. Use it for what was learned in recent sessions.
    For plain words, set aiIndexIds to search specific AI indices. In an Agent Builder
    conversation, they must be among the agent's AI indices, and omitting them searches all of
    them. What is known about the current user is not recalled: an agent that remembers users has
    it in its instructions.
  `,
  schema: recallSchema,
  // Not esql_results: the UI re-runs those in Discover and Lens without the server's space filter and limit.
  handler: async ({ scope, query, aiIndexIds: requested, params, limit }, context) => {
    const { runContext, logger, request, spaceId } = context;
    try {
      const agent = getAgentFromRunContext(runContext);
      // An ES|QL query's FROM names its AI indices; Context Engine refuses ai_index_ids with it.
      const aiIndexIds = isEsqlQuery(query)
        ? requested
        : chooseRecallAiIndices({
            agentAiIndices: agent ? agent.aiIndices ?? [] : undefined,
            requested,
          });
      const result = await (
        await getContextEngineStart()
      ).recall({
        spaceId,
        request,
        input: {
          query,
          ...(scope && { scope }),
          ...(aiIndexIds && { ai_index_ids: aiIndexIds }),
          ...(params && { params }),
          ...(limit !== undefined && { limit }),
        },
      });
      return { results: [{ type: ToolResultType.other, data: { ...result } }] };
    } catch (error) {
      const message = getErrorMessage(error);
      logger.error(`Error running ${contextEngineRecallTools.recall}: ${message}`, { error });
      return {
        results: [
          { type: ToolResultType.error, data: { message: `Failed to recall: ${message}` } },
        ],
      };
    }
  },
});
