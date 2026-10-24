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
import { randomUUID } from 'crypto';
import {
  MAX_SHORT_TERM_CONTENT_LENGTH,
  MAX_SHORT_TERM_SESSION_ID_LENGTH,
  type ShortTermMemory,
} from '@kbn/context-engine-plugin/common/dreaming';
import type { ShortTermMemoryServiceApi } from '@kbn/context-engine-plugin/server/short_term_memory/service';
import type { CoreStart } from '@kbn/core/server';
import type { SecurityPluginStart } from '@kbn/security-plugin/server';
import { z } from '@kbn/zod/v4';
import dedent from 'dedent';
import { assertContextEngineWriteAccess } from '../../assert_context_engine_write_access';
import { createMemoryToolsAvailability } from '../ai_index_tools_availability';
import { assertMemoryEnabled, getCurrentUserId } from '../short_term_memory_access';

const rememberSchema = z.object({
  content: z
    .string()
    .min(1)
    .max(MAX_SHORT_TERM_CONTENT_LENGTH)
    .describe('What to remember, with enough context to use it without re-deriving it'),
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
});

export const createRememberTool = ({
  getShortTermMemory,
  getCoreStart,
  getSecurityStart,
  generateId = randomUUID,
  generateSessionId = randomUUID,
  getCurrentDate = () => new Date(),
}: {
  getShortTermMemory: () => Promise<ShortTermMemoryServiceApi>;
  getCoreStart: () => Promise<CoreStart>;
  getSecurityStart: () => Promise<SecurityPluginStart | undefined>;
  generateId?: () => string;
  generateSessionId?: () => string;
  getCurrentDate?: () => Date;
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
    Set aboutUser when the memory is about the current user. This tool handles the session and
    user server-side. For MCP calls, omit sessionId unless continuing with the sessionId returned
    by an earlier remember call. Agent Builder calls ignore sessionId and use the current
    conversation ID.
  `,
  schema: rememberSchema,
  handler: async (params, context) => {
    const { request, spaceId, runContext, logger, callContext } = context;
    const conversationId = getAgentFromRunContext(runContext)?.conversationId || undefined;

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
      const sessionId = conversationId ?? params.sessionId ?? generateSessionId();

      await assertContextEngineWriteAccess({
        request,
        spaceId,
        getCoreStart,
        getSecurityStart,
      });
      await assertMemoryEnabled({ request, getCoreStart });

      const userId = params.aboutUser
        ? await getCurrentUserId({ request, getCoreStart })
        : undefined;
      const id = generateId();
      const memory: ShortTermMemory = {
        '@timestamp': getCurrentDate().toISOString(),
        id,
        session_id: sessionId,
        ...(userId !== undefined && { user_id: userId }),
        content: params.content,
      };
      await (await getShortTermMemory()).remember(spaceId, memory);

      return {
        results: [
          {
            type: ToolResultType.other,
            data: { id, sessionId },
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
