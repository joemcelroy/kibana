/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { IRouter, KibanaResponseFactory, Logger } from '@kbn/core/server';
import type { RouteSecurity } from '@kbn/core-http-server';
import type { SpacesPluginStart } from '@kbn/spaces-plugin/server';
import {
  AI_INDEX_API_VERSION,
  AI_INDEX_DREAM_PATH,
  AI_INDEX_DREAMING_PATH,
  AI_INDEX_DREAMING_STATE_PATH,
  AI_INDEX_INTERNAL_API_VERSION,
  AI_INDEX_SHORT_TERM_MEMORY_PULL_PATH,
} from '../../common/constants';
import { DEFAULT_DREAMING_GROUP_BY } from '../../common/dreaming';
import { apiPrivileges } from '../../common/features';
import { AiIndexAuditAction, aiIndexAuditEvent } from '../audit/audit_events';
import type { AiIndexService } from '../ai_indices/service';
import { authorizeDreaming } from '../dreaming/authorize';
import {
  DreamingForbiddenError,
  DreamingModelUnavailableError,
  DreamingRunInProgressError,
  DreamingStateConflictError,
  InvalidDreamingConfigError,
} from '../dreaming/errors';
import type { DreamingScheduleService } from '../dreaming/schedule';
import { applyStateUpdate, runningExecutionId, stateOf } from '../dreaming/state';
import type { ShortTermMemoryServiceApi } from '../short_term_memory/service';
import { resolveSpaceId } from '../utils/resolve_space_id';
import { handleAiIndexError } from './ai_indices';
import { aiIndexIdParamsSchema } from './schemas/ai_indices_schema';
import {
  dreamRequestSchema,
  dreamingConfigSchema,
  dreamingStateUpdateSchema,
  shortTermMemoryPullSchema,
} from './schemas/dreaming_schema';
import { withContextEngineFeatureFlag } from './with_feature_flag';

const READ_SECURITY: RouteSecurity = {
  authz: { requiredPrivileges: [apiPrivileges.readContextEngine] },
};

const WRITE_SECURITY: RouteSecurity = {
  authz: { requiredPrivileges: [apiPrivileges.writeContextEngine] },
};

const PUBLIC_OPTIONS = {
  tags: ['oas-tag:context engine'],
  availability: { stability: 'experimental' as const, since: '9.7.0' },
};

const handleDreamingError = (error: unknown, response: KibanaResponseFactory, logger: Logger) => {
  if (
    error instanceof InvalidDreamingConfigError ||
    error instanceof DreamingModelUnavailableError
  ) {
    return response.badRequest({ body: { message: error.message } });
  }
  if (error instanceof DreamingForbiddenError) {
    return response.forbidden({ body: { message: error.message } });
  }
  if (error instanceof DreamingStateConflictError || error instanceof DreamingRunInProgressError) {
    return response.conflict({ body: { message: error.message } });
  }
  return handleAiIndexError(error, response, logger);
};

export const registerDreamingRoutes = ({
  router,
  logger,
  getAiIndexService,
  getShortTermMemory,
  getDreamingSchedule,
  getSpaces,
}: {
  router: IRouter;
  logger: Logger;
  getAiIndexService: () => AiIndexService;
  getShortTermMemory: () => ShortTermMemoryServiceApi;
  getDreamingSchedule: () => DreamingScheduleService;
  getSpaces: () => Promise<SpacesPluginStart | undefined>;
}): void => {
  router.versioned
    .get({
      path: AI_INDEX_DREAMING_PATH,
      security: READ_SECURITY,
      access: 'public',
      summary: 'Get the dreaming configuration and state of an AI Index',
      options: PUBLIC_OPTIONS,
    })
    .addVersion(
      {
        version: AI_INDEX_API_VERSION,
        validate: { request: { params: aiIndexIdParamsSchema } },
      },
      withContextEngineFeatureFlag(async (ctx, request, response) => {
        const { aiIndexId } = request.params;
        const spaceId = resolveSpaceId(await getSpaces(), request);
        try {
          const dreaming = await getAiIndexService().getDreaming(aiIndexId, spaceId);
          return response.ok({ body: { dreaming: dreaming ?? { enabled: false } } });
        } catch (error) {
          return handleDreamingError(error, response, logger);
        }
      })
    );

  router.versioned
    .put({
      path: AI_INDEX_DREAMING_PATH,
      security: WRITE_SECURITY,
      access: 'public',
      summary: 'Configure dreaming for an AI Index',
      description:
        'Saves the dreaming configuration and schedules the dreaming workflow, which runs as the user who saved it. Turning dreaming on for the first time starts from now; earlier short-term memories are not dreamed.',
      options: PUBLIC_OPTIONS,
    })
    .addVersion(
      {
        version: AI_INDEX_API_VERSION,
        validate: { request: { params: aiIndexIdParamsSchema, body: dreamingConfigSchema } },
      },
      withContextEngineFeatureFlag(async (ctx, request, response) => {
        const core = await ctx.core;
        const auditLogger = core.security.audit.logger;
        const { aiIndexId } = request.params;
        const spaceId = resolveSpaceId(await getSpaces(), request);
        try {
          const aiIndexService = getAiIndexService();
          if (request.body.enabled) {
            await authorizeDreaming({
              aiIndexId,
              spaceId,
              aiIndexService,
              currentUserClient: core.elasticsearch.client.asCurrentUser,
            });
          }
          const dreaming = await aiIndexService.setDreamingConfig(aiIndexId, spaceId, request.body);
          auditLogger.log(aiIndexAuditEvent({ action: AiIndexAuditAction.UPDATE, id: aiIndexId }));
          await getDreamingSchedule().reconcile({ aiIndexId, spaceId, dreaming, request });
          return response.ok({ body: { dreaming } });
        } catch (error) {
          auditLogger.log(
            aiIndexAuditEvent({ action: AiIndexAuditAction.UPDATE, id: aiIndexId, error })
          );
          return handleDreamingError(error, response, logger);
        }
      })
    );

  router.versioned
    .put({
      path: AI_INDEX_DREAMING_STATE_PATH,
      security: WRITE_SECURITY,
      access: 'public',
      summary: 'Update the dreaming cursor of an AI Index',
      description:
        'Moves the dreaming cursor and replaces the retry list. Only the run in progress may move the cursor forward; set `reset` to move it back, for example to re-dream.',
      options: PUBLIC_OPTIONS,
    })
    .addVersion(
      {
        version: AI_INDEX_API_VERSION,
        validate: { request: { params: aiIndexIdParamsSchema, body: dreamingStateUpdateSchema } },
      },
      withContextEngineFeatureFlag(async (ctx, request, response) => {
        const core = await ctx.core;
        const auditLogger = core.security.audit.logger;
        const { aiIndexId } = request.params;
        const spaceId = resolveSpaceId(await getSpaces(), request);
        try {
          const aiIndexService = getAiIndexService();
          await authorizeDreaming({
            aiIndexId,
            spaceId,
            aiIndexService,
            currentUserClient: core.elasticsearch.client.asCurrentUser,
          });
          const state = await aiIndexService.updateDreamingState(aiIndexId, spaceId, (current) =>
            applyStateUpdate(current, request.body)
          );
          auditLogger.log(aiIndexAuditEvent({ action: AiIndexAuditAction.UPDATE, id: aiIndexId }));
          return response.ok({ body: { state } });
        } catch (error) {
          auditLogger.log(
            aiIndexAuditEvent({ action: AiIndexAuditAction.UPDATE, id: aiIndexId, error })
          );
          return handleDreamingError(error, response, logger);
        }
      })
    );

  router.versioned
    .post({
      path: AI_INDEX_DREAM_PATH,
      security: WRITE_SECURITY,
      access: 'public',
      summary: 'Dream now',
      description:
        'Starts a dreaming run of an AI Index now, optionally for one session or user, and returns its run id. Fails with a 409 while another run is in progress.',
      options: PUBLIC_OPTIONS,
    })
    .addVersion(
      {
        version: AI_INDEX_API_VERSION,
        validate: { request: { params: aiIndexIdParamsSchema, body: dreamRequestSchema } },
      },
      withContextEngineFeatureFlag(async (ctx, request, response) => {
        const core = await ctx.core;
        const { aiIndexId } = request.params;
        const { session_id: sessionId, user_id: userId, dry_run: dryRun } = request.body;
        const spaceId = resolveSpaceId(await getSpaces(), request);
        try {
          const aiIndexService = getAiIndexService();
          await authorizeDreaming({
            aiIndexId,
            spaceId,
            aiIndexService,
            currentUserClient: core.elasticsearch.client.asCurrentUser,
          });
          const running = runningExecutionId(
            stateOf(await aiIndexService.getDreaming(aiIndexId, spaceId))
          );
          if (running !== undefined) {
            throw new DreamingRunInProgressError(aiIndexId, running);
          }
          const runId = await getDreamingSchedule().run({
            aiIndexId,
            spaceId,
            dryRun,
            ...((sessionId !== undefined || userId !== undefined) && {
              target: {
                ...(sessionId !== undefined && { session_id: sessionId }),
                ...(userId !== undefined && { user_id: userId }),
              },
            }),
            request,
          });
          return response.ok({ body: { run_id: runId } });
        } catch (error) {
          return handleDreamingError(error, response, logger);
        }
      })
    );

  // Reads short-term memory as the internal user, so only after the caller is authorized to
  // dream for the AI index.
  router.versioned
    .post({
      path: AI_INDEX_SHORT_TERM_MEMORY_PULL_PATH,
      security: WRITE_SECURITY,
      access: 'internal',
      summary: 'Pull short-term memories for dreaming',
    })
    .addVersion(
      {
        version: AI_INDEX_INTERNAL_API_VERSION,
        validate: { request: { params: aiIndexIdParamsSchema, body: shortTermMemoryPullSchema } },
      },
      withContextEngineFeatureFlag(async (ctx, request, response) => {
        const core = await ctx.core;
        const { aiIndexId } = request.params;
        const { after, until, group_keys: groupKeys, size } = request.body;
        const spaceId = resolveSpaceId(await getSpaces(), request);
        try {
          const aiIndexService = getAiIndexService();
          await authorizeDreaming({
            aiIndexId,
            spaceId,
            aiIndexService,
            currentUserClient: core.elasticsearch.client.asCurrentUser,
          });
          const dreaming = await aiIndexService.getDreaming(aiIndexId, spaceId);
          const body = await getShortTermMemory().pull(spaceId, {
            after,
            until,
            groupBy: dreaming?.group_by ?? DEFAULT_DREAMING_GROUP_BY,
            groupKeys,
            size,
          });
          return response.ok({ body });
        } catch (error) {
          return handleDreamingError(error, response, logger);
        }
      })
    );
};
