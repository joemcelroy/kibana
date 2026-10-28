/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { IRouter, RequestHandler } from '@kbn/core/server';
import { httpServerMock, loggingSystemMock } from '@kbn/core/server/mocks';
import { RECALL_PATH, REMEMBER_PATH, SAVE_TRANSCRIPT_PATH } from '../../common/constants';
import { apiPrivileges } from '../../common/features';
import type { MemoryApi } from '../memory/api';
import {
  InvalidMemoryRequestError,
  MemoryAccessDeniedError,
  MemoryDisabledError,
} from '../memory/errors';
import { TranscriptExistsError } from '../transcripts/errors';
import { registerMemoryRoutes } from './memory';

interface RegisteredRoute {
  config: { access: string; security: { authz: { requiredPrivileges: string[] } } };
  handler: RequestHandler;
}

describe('memory routes', () => {
  const routes: Record<string, RegisteredRoute> = {};
  const memoryApi = { remember: jest.fn(), recall: jest.fn(), saveTranscript: jest.fn() };
  let response: ReturnType<typeof httpServerMock.createResponseFactory>;

  const call = (path: string, body: Record<string, unknown>) =>
    routes[path].handler(
      {
        core: Promise.resolve({
          uiSettings: { client: { get: jest.fn().mockResolvedValue(true) } },
        }),
      } as unknown as Parameters<RequestHandler>[0],
      httpServerMock.createKibanaRequest({ body }),
      response
    );

  beforeAll(() => {
    const router = {
      versioned: {
        post: (config: RegisteredRoute['config'] & { path: string }) => ({
          addVersion: (_: unknown, handler: RequestHandler) => {
            routes[config.path] = { config, handler };
          },
        }),
      },
    } as unknown as IRouter;
    registerMemoryRoutes({
      router,
      logger: loggingSystemMock.createLogger(),
      getMemoryApi: () => memoryApi as unknown as MemoryApi,
      getSpaces: async () => undefined,
    });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    response = httpServerMock.createResponseFactory();
  });

  it('registers public routes: remember needs write, recall and save transcript read', () => {
    expect(routes[REMEMBER_PATH].config).toMatchObject({
      access: 'public',
      security: { authz: { requiredPrivileges: [apiPrivileges.writeContextEngine] } },
    });
    for (const path of [RECALL_PATH, SAVE_TRANSCRIPT_PATH]) {
      expect(routes[path].config).toMatchObject({
        access: 'public',
        security: { authz: { requiredPrivileges: [apiPrivileges.readContextEngine] } },
      });
    }
  });

  it('calls the memory API in the space from the URL, as the request', async () => {
    memoryApi.recall.mockResolvedValue({ scope: 'ai-index', query_type: 'text', results: [] });

    await call(RECALL_PATH, { query: 'which seat?' });

    expect(memoryApi.recall).toHaveBeenCalledWith({
      spaceId: 'default',
      request: expect.anything(),
      input: { query: 'which seat?' },
    });
    expect(response.ok).toHaveBeenCalledWith({
      body: { scope: 'ai-index', query_type: 'text', results: [] },
    });
  });

  it.each([
    [new InvalidMemoryRequestError('bad'), 'badRequest'],
    [new MemoryDisabledError(), 'badRequest'],
    [new MemoryAccessDeniedError('no'), 'forbidden'],
    [new TranscriptExistsError('round-1'), 'conflict'],
  ] as const)('maps %s to %s', async (error, status) => {
    memoryApi.saveTranscript.mockRejectedValue(error);

    await call(SAVE_TRANSCRIPT_PATH, { session_id: 's', raw: 'x', ai_index_ids: ['a'] });

    expect(response[status]).toHaveBeenCalledWith({ body: { message: error.message } });
  });
});
