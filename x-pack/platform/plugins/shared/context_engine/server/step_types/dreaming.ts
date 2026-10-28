/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { KibanaRequest } from '@kbn/core/server';
import type { Logger } from '@kbn/logging';
import { createServerStepDefinition } from '@kbn/workflows-extensions/server';
import { ExecutionError } from '@kbn/workflows/server';
import {
  commitDreamingStateStepCommonDefinition,
  getDreamingTasksStepCommonDefinition,
  graphifyStepCommonDefinition,
} from '../../common/step_types/dreaming';
import { AiIndexNotFoundError } from '../ai_indices/errors';
import type { AiIndexService } from '../ai_indices/service';
import { createVerifyEsql } from '../dreaming/access_patterns';
import { authorizeDreaming } from '../dreaming/authorize';
import {
  DreamingForbiddenError,
  DreamingModelUnavailableError,
  DreamingRunInProgressError,
  DreamingStateConflictError,
  DreamingTaskNotFoundError,
  InvalidChangeSetError,
  InvalidDreamingConfigError,
} from '../dreaming/errors';
import { graphifyTask, type DreamingModel } from '../dreaming/graphify';
import type { DreamingRunProgress } from '../dreaming/run_progress';
import type { DreamingService } from '../dreaming/service';
import type { DreamingMemoryReader } from '../dreaming/memory_reader';
import { assertContextEngineEnabled } from './helpers';
import { toStepError } from './to_step_error';

/** Dependencies injected into the dreaming step definition factories. */
export interface DreamingStepDependencies {
  getAiIndexService: () => AiIndexService;
  getDreamingService: () => DreamingService;
  getMemoryReader: () => DreamingMemoryReader;
  getRunProgress: () => DreamingRunProgress;
  getDreamingModel: (request: KibanaRequest) => Promise<DreamingModel>;
  isContextEngineEnabled: (spaceId: string) => Promise<boolean>;
  logger: Logger;
}

const ERROR_TYPES: ReadonlyArray<[new (...args: never[]) => Error, string]> = [
  [AiIndexNotFoundError, 'NotFoundError'],
  [DreamingTaskNotFoundError, 'NotFoundError'],
  [DreamingForbiddenError, 'PermissionError'],
  [InvalidDreamingConfigError, 'ValidationError'],
  [InvalidChangeSetError, 'ValidationError'],
  [DreamingModelUnavailableError, 'ValidationError'],
  [DreamingRunInProgressError, 'ConflictError'],
  [DreamingStateConflictError, 'ConflictError'],
];

const toDreamingStepError = (error: unknown, fallbackMessage: string): ExecutionError => {
  const match = ERROR_TYPES.find(([constructor]) => error instanceof constructor);
  return match && error instanceof Error
    ? new ExecutionError({ type: match[1], message: error.message })
    : toStepError(error, fallbackMessage);
};

const emptyToUndefined = (value: string | undefined): string | undefined =>
  value === '' ? undefined : value;

export const getDreamingTasksStepDefinition = ({
  getAiIndexService,
  getDreamingService,
  isContextEngineEnabled,
}: DreamingStepDependencies) =>
  createServerStepDefinition({
    ...getDreamingTasksStepCommonDefinition,
    handler: async (context) => {
      const { workflow, execution } = context.contextManager.getContext();
      const { spaceId } = workflow;
      await assertContextEngineEnabled(isContextEngineEnabled, spaceId);
      const { ai_index_id: aiIndexId, dry_run: dryRun = false } = context.input;
      const sessionId = emptyToUndefined(context.input.session_id);
      const userId = emptyToUndefined(context.input.user_id);
      try {
        await authorizeDreaming({
          aiIndexId,
          spaceId,
          aiIndexService: getAiIndexService(),
          currentUserClient: context.contextManager.getScopedEsClient(),
        });
        const output = await getDreamingService().start(
          { spaceId, aiIndexId, executionId: execution.id },
          {
            dryRun,
            ...((sessionId !== undefined || userId !== undefined) && {
              target: {
                ...(sessionId !== undefined && { session_id: sessionId }),
                ...(userId !== undefined && { user_id: userId }),
              },
            }),
          }
        );
        return { output };
      } catch (error) {
        throw toDreamingStepError(error, `Failed to plan dreaming for AI index '${aiIndexId}'`);
      }
    },
  });

export const getGraphifyStepDefinition = ({
  getAiIndexService,
  getMemoryReader,
  getRunProgress,
  getDreamingModel,
  isContextEngineEnabled,
  logger,
}: DreamingStepDependencies) =>
  createServerStepDefinition({
    ...graphifyStepCommonDefinition,
    handler: async (context) => {
      const { workflow, execution } = context.contextManager.getContext();
      const { spaceId } = workflow;
      await assertContextEngineEnabled(isContextEngineEnabled, spaceId);
      const { ai_index_id: aiIndexId, task_id: taskId, dry_run: dryRun = false } = context.input;
      const request = context.contextManager.getFakeRequest();
      const esClient = context.contextManager.getScopedEsClient();
      try {
        const aiIndexService = getAiIndexService();
        const { dest } = await authorizeDreaming({
          aiIndexId,
          spaceId,
          aiIndexService,
          currentUserClient: esClient,
        });
        const dreaming = await aiIndexService.getDreaming(aiIndexId, spaceId);
        const output = await graphifyTask({
          spaceId,
          aiIndexId,
          executionId: execution.id,
          taskId,
          dest,
          config: dreaming ?? { enabled: false },
          dryRun,
          esClient,
          memoryReader: getMemoryReader(),
          runProgress: getRunProgress(),
          getModel: () => getDreamingModel(request),
          verifyEsql: createVerifyEsql({ esClient, logger, abortSignal: context.abortSignal }),
          abortSignal: context.abortSignal,
        });
        const { operations, ...counts } = output;
        return {
          output: {
            ...counts,
            ...(operations && {
              operations: operations.map((operation) => ({ ...operation })),
            }),
          },
        };
      } catch (error) {
        throw toDreamingStepError(error, `Failed to graphify task '${taskId}'`);
      }
    },
  });

export const getCommitDreamingStateStepDefinition = ({
  getAiIndexService,
  getDreamingService,
  isContextEngineEnabled,
}: DreamingStepDependencies) =>
  createServerStepDefinition({
    ...commitDreamingStateStepCommonDefinition,
    handler: async (context) => {
      const { workflow, execution } = context.contextManager.getContext();
      const { spaceId } = workflow;
      await assertContextEngineEnabled(isContextEngineEnabled, spaceId);
      const { ai_index_id: aiIndexId } = context.input;
      try {
        await authorizeDreaming({
          aiIndexId,
          spaceId,
          aiIndexService: getAiIndexService(),
          currentUserClient: context.contextManager.getScopedEsClient(),
        });
        const output = await getDreamingService().commit({
          spaceId,
          aiIndexId,
          executionId: execution.id,
        });
        return { output };
      } catch (error) {
        throw toDreamingStepError(error, `Failed to commit dreaming for AI index '${aiIndexId}'`);
      }
    },
  });
