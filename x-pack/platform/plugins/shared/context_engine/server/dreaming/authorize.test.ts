/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ElasticsearchClient } from '@kbn/core/server';
import type { AiIndexService } from '../ai_indices/service';
import { authorizeDreaming } from './authorize';
import { DreamingForbiddenError, InvalidDreamingConfigError } from './errors';

describe('authorizeDreaming', () => {
  const get = jest.fn();
  const hasPrivileges = jest.fn();
  const aiIndexService = { get } as unknown as AiIndexService;
  const currentUserClient = { security: { hasPrivileges } } as unknown as ElasticsearchClient;
  const authorize = () =>
    authorizeDreaming({ aiIndexId: 'a', spaceId: 'default', aiIndexService, currentUserClient });

  beforeEach(() => {
    jest.clearAllMocks();
    hasPrivileges.mockResolvedValue({ has_all_requested: true });
  });

  it('needs write on the backing index', async () => {
    const aiIndex = { id: 'a', memory_enabled: true, dest: { value: 'ai-index-idx-a' } };
    get.mockResolvedValue(aiIndex);

    await expect(authorize()).resolves.toBe(aiIndex);
    expect(hasPrivileges).toHaveBeenCalledWith({
      index: [{ names: ['ai-index-idx-a'], privileges: ['write'] }],
    });

    hasPrivileges.mockResolvedValue({ has_all_requested: false });
    await expect(authorize()).rejects.toBeInstanceOf(DreamingForbiddenError);
  });

  it("does not check a hidden AI index's system index, which only Kibana writes", async () => {
    const aiIndex = {
      id: 'a',
      memory_enabled: true,
      hidden: true,
      dest: { value: '.ai-index-idx-a' },
    };
    get.mockResolvedValue(aiIndex);

    await expect(authorize()).resolves.toBe(aiIndex);
    expect(hasPrivileges).not.toHaveBeenCalled();
  });

  it('refuses an AI index without memory', async () => {
    get.mockResolvedValue({ id: 'a', memory_enabled: false, hidden: true, dest: { value: 'x' } });

    await expect(authorize()).rejects.toBeInstanceOf(InvalidDreamingConfigError);
  });
});
