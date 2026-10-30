/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { KibanaRequest } from '@kbn/core-http-server';
import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import type { AgentConfiguration } from '@kbn/agent-builder-common';
import { resolveConfiguration } from './configuration';

describe('resolveConfiguration', () => {
  const request = {} as KibanaRequest;
  const logger = loggingSystemMock.createLogger();
  const configuration: AgentConfiguration = {
    instructions: 'Be brief.',
    tools: [],
    ai_indices: ['elastic', 'user-memories'],
  };
  const profile = { type: 'entity.user', title: 'profile', content: 'Runs support.' };

  it('gives the agent what it knows about the user', async () => {
    const userMemoryProvider = jest.fn().mockResolvedValue([profile]);

    const resolved = await resolveConfiguration(configuration, {
      aiIndicesEnabled: true,
      request,
      userMemoryProvider,
      logger,
    });

    expect(resolved.userMemory).toEqual([profile]);
    expect(userMemoryProvider).toHaveBeenCalledWith({
      aiIndexIds: ['elastic', 'user-memories'],
      request,
    });
  });

  it('asks for nothing with AI indices off or without AI indices', async () => {
    const userMemoryProvider = jest.fn().mockResolvedValue([profile]);

    const off = await resolveConfiguration(configuration, {
      aiIndicesEnabled: false,
      request,
      userMemoryProvider,
    });
    const none = await resolveConfiguration(
      { ...configuration, ai_indices: [] },
      { aiIndicesEnabled: true, request, userMemoryProvider }
    );

    expect(off.userMemory).toBeUndefined();
    expect(none.userMemory).toBeUndefined();
    expect(userMemoryProvider).not.toHaveBeenCalled();
  });

  it('runs without user memory when the provider fails', async () => {
    const userMemoryProvider = jest.fn().mockRejectedValue(new Error('boom'));

    const resolved = await resolveConfiguration(configuration, {
      aiIndicesEnabled: true,
      request,
      userMemoryProvider,
      logger,
    });

    expect(resolved.userMemory).toBeUndefined();
    expect(resolved.aiIndexCatalog).toHaveLength(2);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });
});
