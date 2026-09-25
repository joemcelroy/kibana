/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggingSystemMock } from '@kbn/core/server/mocks';
import { CONTEXT_ENGINE_DOCUMENT_SUMMARY_WORKFLOW_ID } from '@kbn/workflows/managed';
import { GLOBAL_WORKFLOW_SPACE_ID } from '@kbn/workflows/server';
import type { WorkflowsExtensionsServerPluginStart } from '@kbn/workflows-extensions/server';
import { CONTEXT_ENGINE_WORKFLOW_OWNER, installDocumentSummaryWorkflow } from './install';

const createClient = () => ({
  install: jest.fn().mockResolvedValue(undefined),
  ready: jest.fn().mockResolvedValue(undefined),
});

describe('installDocumentSummaryWorkflow', () => {
  it('installs the summary workflow globally and marks the owner ready', async () => {
    const client = createClient();
    const workflowsExtensions = {
      initManagedWorkflowsClient: jest.fn().mockResolvedValue(client),
    } as unknown as WorkflowsExtensionsServerPluginStart;

    await installDocumentSummaryWorkflow({
      workflowsExtensions,
      logger: loggingSystemMock.createLogger(),
    });

    expect(workflowsExtensions.initManagedWorkflowsClient).toHaveBeenCalledWith(
      CONTEXT_ENGINE_WORKFLOW_OWNER
    );
    expect(client.install).toHaveBeenCalledWith(CONTEXT_ENGINE_DOCUMENT_SUMMARY_WORKFLOW_ID, {
      spaceId: GLOBAL_WORKFLOW_SPACE_ID,
    });
    expect(client.ready).toHaveBeenCalledTimes(1);
  });

  it('does not mark the owner ready when install fails', async () => {
    const client = createClient();
    client.install.mockRejectedValue(new Error('install failed'));
    const workflowsExtensions = {
      initManagedWorkflowsClient: jest.fn().mockResolvedValue(client),
    } as unknown as WorkflowsExtensionsServerPluginStart;
    const logger = loggingSystemMock.createLogger();

    await installDocumentSummaryWorkflow({ workflowsExtensions, logger });

    expect(client.ready).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });
});
