/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { IRouter, KibanaResponseFactory, Logger, RouteSecurity } from '@kbn/core/server';
import type { SpacesPluginStart } from '@kbn/spaces-plugin/server';
import {
  AI_INDEX_API_VERSION,
  RECALL_PATH,
  REMEMBER_PATH,
  SAVE_TRANSCRIPT_PATH,
} from '../../common/constants';
import { apiPrivileges } from '../../common/features';
import type { MemoryApi } from '../memory/api';
import {
  InvalidMemoryRequestError,
  MemoryAccessDeniedError,
  MemoryDisabledError,
} from '../memory/errors';
import { TranscriptExistsError } from '../transcripts/errors';
import { resolveSpaceId } from '../utils/resolve_space_id';
import { handleDreamingError } from './dreaming';
import {
  recallBodySchema,
  rememberBodySchema,
  saveTranscriptBodySchema,
} from './schemas/memory_schema';
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

const handleMemoryError = (error: unknown, response: KibanaResponseFactory, logger: Logger) => {
  if (error instanceof InvalidMemoryRequestError || error instanceof MemoryDisabledError) {
    return response.badRequest({ body: { message: error.message } });
  }
  if (error instanceof MemoryAccessDeniedError) {
    return response.forbidden({ body: { message: error.message } });
  }
  if (error instanceof TranscriptExistsError) {
    return response.conflict({ body: { message: error.message } });
  }
  return handleDreamingError(error, response, logger);
};

/**
 * Remember, recall and save transcript over HTTP: the same calls as the start contract, as the
 * request's user, in the space from the URL.
 */
export const registerMemoryRoutes = ({
  router,
  logger,
  getMemoryApi,
  getSpaces,
}: {
  router: IRouter;
  logger: Logger;
  getMemoryApi: () => MemoryApi;
  getSpaces: () => Promise<SpacesPluginStart | undefined>;
}): void => {
  router.versioned
    .post({
      path: REMEMBER_PATH,
      security: WRITE_SECURITY,
      access: 'public',
      summary: 'Remember',
      description:
        'Appends a memory to short-term memory, for AI indices with dreaming on to turn into long-term memory. Returns its id and session id. Needs Context Engine memory turned on.',
      options: PUBLIC_OPTIONS,
    })
    .addVersion(
      { version: AI_INDEX_API_VERSION, validate: { request: { body: rememberBodySchema } } },
      withContextEngineFeatureFlag(async (ctx, request, response) => {
        try {
          const spaceId = resolveSpaceId(await getSpaces(), request);
          const body = await getMemoryApi().remember({ spaceId, request, input: request.body });
          return response.ok({ body });
        } catch (error) {
          return handleMemoryError(error, response, logger);
        }
      })
    );

  router.versioned
    .post({
      path: RECALL_PATH,
      security: READ_SECURITY,
      access: 'public',
      summary: 'Recall',
      description:
        "Looks something up. With `scope: 'ai-index'` (default) it searches the knowledge in AI indices: plain words get a hybrid search, best matches first; an ES|QL query returns its columns and rows. With `scope: 'short-term'` it searches memories remembered and not yet dreamed, shared or about the caller. Transcripts are never searched.",
      options: PUBLIC_OPTIONS,
    })
    .addVersion(
      { version: AI_INDEX_API_VERSION, validate: { request: { body: recallBodySchema } } },
      withContextEngineFeatureFlag(async (ctx, request, response) => {
        try {
          const spaceId = resolveSpaceId(await getSpaces(), request);
          const body = await getMemoryApi().recall({ spaceId, request, input: request.body });
          return response.ok({ body });
        } catch (error) {
          return handleMemoryError(error, response, logger);
        }
      })
    );

  router.versioned
    .post({
      path: SAVE_TRANSCRIPT_PATH,
      security: READ_SECURITY,
      access: 'public',
      summary: 'Save a transcript',
      description:
        "Saves the transcript of one of the caller's conversation rounds, apart from short-term memory, for the AI indices it names to dream. Each must take conversation rounds: memory and dreaming on, with `rounds` not set to `false`. The transcript is always about the caller.",
      options: PUBLIC_OPTIONS,
    })
    .addVersion(
      { version: AI_INDEX_API_VERSION, validate: { request: { body: saveTranscriptBodySchema } } },
      withContextEngineFeatureFlag(async (ctx, request, response) => {
        try {
          const spaceId = resolveSpaceId(await getSpaces(), request);
          const body = await getMemoryApi().saveTranscript({
            spaceId,
            request,
            input: request.body,
          });
          return response.ok({ body });
        } catch (error) {
          return handleMemoryError(error, response, logger);
        }
      })
    );
};
