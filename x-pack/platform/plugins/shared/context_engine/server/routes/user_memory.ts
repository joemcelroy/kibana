/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { schema } from '@kbn/config-schema';
import type { IRouter, Logger } from '@kbn/core/server';
import type { SpacesPluginStart } from '@kbn/spaces-plugin/server';
import {
  AI_INDEX_INTERNAL_API_VERSION,
  OWN_MEMORY_LIST_PATH,
  OWN_MEMORY_SETTINGS_PATH,
  OWN_ROUNDS_FORGET_PATH,
} from '../../common/constants';
import { apiPrivileges } from '../../common/features';
import {
  MAX_OWN_MEMORY_AI_INDICES,
  type ForgetOwnRoundsResponse,
  type ListOwnMemoryResponse,
  type OwnMemorySettings,
} from '../../common/http_api/user_memory';
import type { AiIndexDataReadServiceApi } from '../ai_indices/data_read_service';
import type { AiIndexService } from '../ai_indices/service';
import type { ContextEnginePluginStart, GetAiIndexDataReadServiceParams } from '../types';
import { listOwnMemory } from '../user_memory/list_own_memory';
import type { MemorySettingsServiceApi } from '../user_memory/settings';
import { ownerIdsOf } from '../user_memory/owner_ids';
import { resolveSpaceId } from '../utils/resolve_space_id';
import { handleAiIndexError } from './ai_indices';
import { withContextEngineFeatureFlag } from './with_feature_flag';

const MAX_AI_INDEX_ID_LENGTH = 256;

const listOwnMemoryBodySchema = schema.object({
  ai_index_ids: schema.maybe(
    schema.arrayOf(schema.string({ minLength: 1, maxLength: MAX_AI_INDEX_ID_LENGTH }), {
      maxSize: MAX_OWN_MEMORY_AI_INDICES,
      meta: {
        description:
          'AI indices to list the caller’s memory from. Missing: every AI index that keeps each user’s memory apart.',
      },
    })
  ),
});

/**
 * The caller's own memory, for the Agent Builder "Manage memory" page: lists their long-term
 * memory, and forgets the conversation rounds recorded about them.
 */
export const registerUserMemoryRoutes = ({
  router,
  logger,
  getAiIndexService,
  getAiIndexDataReadService,
  getSpaces,
  forgetRounds,
  getMemorySettings,
}: {
  router: IRouter;
  logger: Logger;
  getAiIndexService: () => AiIndexService;
  getAiIndexDataReadService: (params: GetAiIndexDataReadServiceParams) => AiIndexDataReadServiceApi;
  getSpaces: () => Promise<SpacesPluginStart | undefined>;
  forgetRounds: ContextEnginePluginStart['forgetRounds'];
  getMemorySettings: () => MemorySettingsServiceApi;
}): void => {
  router.versioned
    .post({
      path: OWN_MEMORY_LIST_PATH,
      access: 'internal',
      security: { authz: { requiredPrivileges: [apiPrivileges.readContextEngine] } },
      summary: "List the caller's own long-term memory",
    })
    .addVersion(
      {
        version: AI_INDEX_INTERNAL_API_VERSION,
        validate: { request: { body: listOwnMemoryBodySchema } },
      },
      withContextEngineFeatureFlag(async (ctx, request, response) => {
        const core = await ctx.core;
        const userIds = ownerIdsOf(core.security.authc.getCurrentUser() ?? undefined);
        if (userIds.length === 0) {
          return response.forbidden({ body: { message: 'Cannot identify the current user.' } });
        }
        try {
          const body: ListOwnMemoryResponse = {
            ai_indices: await listOwnMemory({
              aiIndexService: getAiIndexService(),
              // Per-user AI indices are hidden, in system indices only Kibana reads; the query keeps
              // to the caller's own KIs.
              dataRead: getAiIndexDataReadService({
                esClient: core.elasticsearch.client.asInternalUser,
                request,
                includeHidden: true,
              }),
              spaceId: resolveSpaceId(await getSpaces(), request),
              userIds,
              aiIndexIds: request.body.ai_index_ids,
            }),
          };
          return response.ok({ body });
        } catch (error) {
          return handleAiIndexError(error, response, logger);
        }
      })
    );

  router.versioned
    .post({
      path: OWN_ROUNDS_FORGET_PATH,
      access: 'internal',
      security: { authz: { requiredPrivileges: [apiPrivileges.readContextEngine] } },
      summary: "Forget the caller's recorded conversation rounds",
    })
    .addVersion(
      { version: AI_INDEX_INTERNAL_API_VERSION, validate: false },
      withContextEngineFeatureFlag(async (ctx, request, response) => {
        const core = await ctx.core;
        const userIds = ownerIdsOf(core.security.authc.getCurrentUser() ?? undefined);
        if (userIds.length === 0) {
          return response.forbidden({ body: { message: 'Cannot identify the current user.' } });
        }
        try {
          const spaceId = resolveSpaceId(await getSpaces(), request);
          let forgotten = 0;
          // Rounds record the profile uid, or the username for a principal without one.
          for (const userId of userIds) {
            forgotten += (await forgetRounds({ spaceId, userId, request })).forgotten;
          }
          const body: ForgetOwnRoundsResponse = { forgotten };
          return response.ok({ body });
        } catch (error) {
          return handleAiIndexError(error, response, logger);
        }
      })
    );

  router.versioned
    .get({
      path: OWN_MEMORY_SETTINGS_PATH,
      access: 'internal',
      security: { authz: { requiredPrivileges: [apiPrivileges.readContextEngine] } },
      summary: "Get the caller's own memory settings",
    })
    .addVersion(
      { version: AI_INDEX_INTERNAL_API_VERSION, validate: false },
      withContextEngineFeatureFlag(async (ctx, request, response) => {
        const core = await ctx.core;
        const userIds = ownerIdsOf(core.security.authc.getCurrentUser() ?? undefined);
        if (userIds.length === 0) {
          return response.forbidden({ body: { message: 'Cannot identify the current user.' } });
        }
        try {
          const spaceId = resolveSpaceId(await getSpaces(), request);
          const body: OwnMemorySettings = {
            learn_from_conversations: await getMemorySettings().learnsFromConversations(
              spaceId,
              userIds
            ),
          };
          return response.ok({ body });
        } catch (error) {
          return handleAiIndexError(error, response, logger);
        }
      })
    );

  router.versioned
    .put({
      path: OWN_MEMORY_SETTINGS_PATH,
      access: 'internal',
      security: { authz: { requiredPrivileges: [apiPrivileges.readContextEngine] } },
      summary: "Update the caller's own memory settings",
    })
    .addVersion(
      {
        version: AI_INDEX_INTERNAL_API_VERSION,
        validate: {
          request: {
            body: schema.object({
              learn_from_conversations: schema.boolean({
                meta: {
                  description:
                    'Whether agents that learn from conversations record the caller’s conversations.',
                },
              }),
            }),
          },
        },
      },
      withContextEngineFeatureFlag(async (ctx, request, response) => {
        const core = await ctx.core;
        const userIds = ownerIdsOf(core.security.authc.getCurrentUser() ?? undefined);
        if (userIds.length === 0) {
          return response.forbidden({ body: { message: 'Cannot identify the current user.' } });
        }
        try {
          const spaceId = resolveSpaceId(await getSpaces(), request);
          const learn = request.body.learn_from_conversations;
          await getMemorySettings().setLearnFromConversations(spaceId, userIds, learn);
          const body: OwnMemorySettings = { learn_from_conversations: learn };
          return response.ok({ body });
        } catch (error) {
          return handleAiIndexError(error, response, logger);
        }
      })
    );
};
