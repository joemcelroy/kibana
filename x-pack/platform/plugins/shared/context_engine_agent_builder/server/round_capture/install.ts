/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Logger } from '@kbn/core/server';
import { CONTEXT_ENGINE_ROUND_CAPTURE_WORKFLOW_ID } from '@kbn/workflows/managed';
import { GLOBAL_WORKFLOW_SPACE_ID } from '@kbn/workflows/server';
import type {
  WorkflowsExtensionsServerPluginSetup,
  WorkflowsExtensionsServerPluginStart,
} from '@kbn/workflows-extensions/server';

/** Owns the round capture system workflow (its definition's `pluginId`). */
export const ROUND_CAPTURE_WORKFLOW_OWNER = 'contextEngineAgentBuilder';

export const registerRoundCaptureWorkflowOwner = (
  workflowsExtensions: WorkflowsExtensionsServerPluginSetup
): void => {
  workflowsExtensions.registerManagedWorkflowOwner(ROUND_CAPTURE_WORKFLOW_OWNER);
};

/**
 * Installs the round capture system workflow once, in the global space, so Agent Builder's
 * post-execution hook finds it from every space.
 */
export const installRoundCaptureWorkflow = async ({
  workflowsExtensions,
  logger,
}: {
  workflowsExtensions: WorkflowsExtensionsServerPluginStart;
  logger: Logger;
}): Promise<void> => {
  try {
    const client = await workflowsExtensions.initManagedWorkflowsClient(
      ROUND_CAPTURE_WORKFLOW_OWNER
    );
    await client.install(CONTEXT_ENGINE_ROUND_CAPTURE_WORKFLOW_ID, {
      spaceId: GLOBAL_WORKFLOW_SPACE_ID,
    });
    await client.ready();
  } catch (error) {
    logger.warn(`Could not install the round capture workflow: ${error}`);
  }
};
