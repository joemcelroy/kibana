/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Logger } from '@kbn/core/server';
import { CONTEXT_ENGINE_DOCUMENT_SUMMARY_WORKFLOW_ID } from '@kbn/workflows/managed';
import { GLOBAL_WORKFLOW_SPACE_ID } from '@kbn/workflows/server';
import type { WorkflowsExtensionsServerPluginStart } from '@kbn/workflows-extensions/server';

/** Must match the `pluginId` on the managed workflow definition. */
export const CONTEXT_ENGINE_WORKFLOW_OWNER = 'contextEngine';

/** Installs the global per-document KI summary workflow. One definition, not one per AI index. */
export const installDocumentSummaryWorkflow = async ({
  workflowsExtensions,
  logger,
}: {
  workflowsExtensions: WorkflowsExtensionsServerPluginStart;
  logger: Logger;
}): Promise<void> => {
  try {
    const client = await workflowsExtensions.initManagedWorkflowsClient(
      CONTEXT_ENGINE_WORKFLOW_OWNER
    );
    await client.install(CONTEXT_ENGINE_DOCUMENT_SUMMARY_WORKFLOW_ID, {
      spaceId: GLOBAL_WORKFLOW_SPACE_ID,
    });
    // ready() also re-applies this owner's dynamic instances (feedback analysis) from the
    // current registry definition. That workflow is restorable, so a re-apply keeps its enablement.
    await client.ready();
  } catch (error) {
    logger.warn(
      `Failed to install managed workflow "${CONTEXT_ENGINE_DOCUMENT_SUMMARY_WORKFLOW_ID}": ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
};
