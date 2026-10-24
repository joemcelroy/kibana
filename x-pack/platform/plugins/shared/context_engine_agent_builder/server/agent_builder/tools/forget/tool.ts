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
import { MAX_SHORT_TERM_MEMORY_ID_LENGTH } from '@kbn/context-engine-plugin/common/dreaming';
import type { ForgetMemoryResult } from '@kbn/context-engine-plugin/server/dreaming/forget';
import type { ShortTermMemoryServiceApi } from '@kbn/context-engine-plugin/server/short_term_memory/service';
import type { CoreStart } from '@kbn/core/server';
import type { SecurityPluginStart } from '@kbn/security-plugin/server';
import { z } from '@kbn/zod/v4';
import dedent from 'dedent';
import { assertContextEngineWriteAccess } from '../../assert_context_engine_write_access';
import { createMemoryToolsAvailability } from '../ai_index_tools_availability';
import { assertMemoryEnabled, getCurrentUserId } from '../short_term_memory_access';

const forgetSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(MAX_SHORT_TERM_MEMORY_ID_LENGTH)
    .describe('The id the remember tool returned for the memory'),
});

export const createForgetTool = ({
  getShortTermMemory,
  forgetMemory,
  getCoreStart,
  getSecurityStart,
}: {
  getShortTermMemory: () => Promise<ShortTermMemoryServiceApi>;
  forgetMemory: (spaceId: string, memoryId: string) => Promise<ForgetMemoryResult>;
  getCoreStart: () => Promise<CoreStart>;
  getSecurityStart: () => Promise<SecurityPluginStart | undefined>;
}): BuiltinToolDefinition<typeof forgetSchema> => ({
  id: contextEngineMemoryTools.forget,
  type: ToolType.builtin,
  availability: createMemoryToolsAvailability(getCoreStart),
  tags: ['context_engine', 'memory'],
  annotations: {
    title: 'Forget',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  description: dedent`
    Delete a short-term memory by the id the remember tool returned. Long-term knowledge that
    AI indices dreamed from it is hidden from recall, then rewritten or deleted on their next
    dreaming run.
  `,
  schema: forgetSchema,
  handler: async ({ id }, context) => {
    const { request, spaceId, logger } = context;

    try {
      await assertContextEngineWriteAccess({
        request,
        spaceId,
        getCoreStart,
        getSecurityStart,
      });
      await assertMemoryEnabled({ request, getCoreStart });

      const [memory] = await (await getShortTermMemory()).getByIds(spaceId, [id]);
      if (memory?.user_id !== undefined) {
        const userId = await getCurrentUserId({ request, getCoreStart });
        if (memory.user_id !== userId) {
          throw new Error(`Memory '${id}' is about another user and cannot be forgotten.`);
        }
      }

      const { forgotten } = memory ? await forgetMemory(spaceId, id) : { forgotten: false };
      return {
        results: [
          {
            type: ToolResultType.other,
            data: { id, forgotten },
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Error running ${contextEngineMemoryTools.forget}: ${message}`, { error });
      return {
        results: [
          {
            type: ToolResultType.error,
            data: { message: `Failed to forget memory: ${message}` },
          },
        ],
      };
    }
  },
});
