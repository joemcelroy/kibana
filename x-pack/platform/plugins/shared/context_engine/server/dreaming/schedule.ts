/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createHash } from 'crypto';
import type { KibanaRequest, Logger } from '@kbn/core/server';
import { toWorkflowExecutionEngineModel } from '@kbn/workflows';
import { CONTEXT_ENGINE_DREAMING_WORKFLOW_ID } from '@kbn/workflows/managed';
import type { PluginScopedManagedWorkflowsApi } from '@kbn/workflows/server/types';
import {
  DEFAULT_DREAMING_INTERVAL,
  MIN_DREAMING_INTERVAL_MINUTES,
  type AiIndexDreamingConfig,
} from '../../common/dreaming';
import { parseIntervalMinutes } from '../../common/validation';
import type { WorkflowEnablementApi } from '../feedback_analysis/schedule';
import type { KiVerifierWorkflowRunner } from '../ki_verification';
import { InvalidDreamingConfigError } from './errors';
import type { DreamingTarget } from './plan_run';

const SPACE_HASH_LENGTH = 16;

export const DREAMING_TRIGGERED_BY = 'context_engine_dream';

export type DreamingWorkflowsApi = WorkflowEnablementApi &
  Pick<KiVerifierWorkflowRunner, 'getWorkflow' | 'runWorkflow'>;

export interface DreamingScheduleService {
  /** Installs and enables the dreaming workflow, or uninstalls it when dreaming is off. */
  reconcile(params: {
    aiIndexId: string;
    spaceId: string;
    dreaming?: AiIndexDreamingConfig;
    /** Enabling makes runs execute under an API key minted from this request. */
    request: KibanaRequest;
  }): Promise<void>;
  /** Tears the schedule down when its AI index is deleted. */
  remove(params: { aiIndexId: string; spaceId: string }): Promise<void>;
  /** Starts a run now through the workflow's manual trigger, as the request's user. */
  run(params: {
    aiIndexId: string;
    spaceId: string;
    target?: DreamingTarget;
    dryRun: boolean;
    request: KibanaRequest;
  }): Promise<string>;
}

export const createDreamingScheduleService = ({
  logger,
  getManagedWorkflowsClient,
  getWorkflowsManagement,
}: {
  logger: Logger;
  getManagedWorkflowsClient: () => Promise<PluginScopedManagedWorkflowsApi>;
  getWorkflowsManagement: () => Promise<DreamingWorkflowsApi | undefined>;
}): DreamingScheduleService => {
  const log = logger.get('dreaming_schedule');

  // Same scheme as the feedback analysis schedule: an AI index id is only unique per space.
  const workflowIdSuffixFor = (aiIndexId: string, spaceId: string) =>
    `${aiIndexId}-${createHash('sha256')
      .update(spaceId)
      .digest('hex')
      .slice(0, SPACE_HASH_LENGTH)}`;

  const workflowDocumentIdFor = (aiIndexId: string, spaceId: string) =>
    `${CONTEXT_ENGINE_DREAMING_WORKFLOW_ID}-${workflowIdSuffixFor(aiIndexId, spaceId)}`;

  const requireWorkflowsManagement = async (aiIndexId: string) => {
    const workflowsManagement = await getWorkflowsManagement();
    if (!workflowsManagement) {
      throw new InvalidDreamingConfigError(
        `Cannot dream for AI index '${aiIndexId}': the workflows management plugin is not available.`
      );
    }
    return workflowsManagement;
  };

  const uninstall = async (aiIndexId: string, spaceId: string) => {
    const client = await getManagedWorkflowsClient();
    await client.uninstall(CONTEXT_ENGINE_DREAMING_WORKFLOW_ID, {
      spaceId,
      workflowIdSuffix: workflowIdSuffixFor(aiIndexId, spaceId),
    });
  };

  return {
    async reconcile({ aiIndexId, spaceId, dreaming, request }) {
      if (!dreaming?.enabled) {
        await uninstall(aiIndexId, spaceId);
        log.debug(() => `Removed dreaming schedule for AI index '${aiIndexId}' in '${spaceId}'`);
        return;
      }
      const workflowsManagement = await requireWorkflowsManagement(aiIndexId);
      const intervalMinutes =
        parseIntervalMinutes(dreaming.schedule?.interval ?? DEFAULT_DREAMING_INTERVAL) ??
        MIN_DREAMING_INTERVAL_MINUTES;
      const client = await getManagedWorkflowsClient();
      await client.install(CONTEXT_ENGINE_DREAMING_WORKFLOW_ID, {
        spaceId,
        workflowIdSuffix: workflowIdSuffixFor(aiIndexId, spaceId),
        values: { aiIndexId, intervalMinutes },
      });
      // Every save re-enables, which re-mints the API key, so runs follow whoever saved last.
      await workflowsManagement.updateWorkflow(
        workflowDocumentIdFor(aiIndexId, spaceId),
        { enabled: true },
        spaceId,
        request
      );
      log.info(
        `Scheduled dreaming for AI index '${aiIndexId}' in space '${spaceId}' every ${intervalMinutes}m, running as the user who enabled it`
      );
    },

    async remove({ aiIndexId, spaceId }) {
      await uninstall(aiIndexId, spaceId);
    },

    async run({ aiIndexId, spaceId, target, dryRun, request }) {
      const workflowsManagement = await requireWorkflowsManagement(aiIndexId);
      const workflow = await workflowsManagement.getWorkflow(
        workflowDocumentIdFor(aiIndexId, spaceId),
        spaceId,
        request
      );
      if (!workflow?.enabled || !workflow.valid || !workflow.definition) {
        throw new InvalidDreamingConfigError(
          `Dreaming is not scheduled for AI index '${aiIndexId}'. Turn dreaming on first.`
        );
      }
      return workflowsManagement.runWorkflow(
        toWorkflowExecutionEngineModel(workflow),
        spaceId,
        {
          session_id: target?.session_id ?? '',
          user_id: target?.user_id ?? '',
          dry_run: dryRun,
        },
        request,
        DREAMING_TRIGGERED_BY
      );
    },
  };
};
