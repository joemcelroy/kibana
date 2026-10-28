/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Logger } from '@kbn/core/server';
import { createServerStepDefinition } from '@kbn/workflows-extensions/server';
import { ExecutionError } from '@kbn/workflows/server';
import { captureRoundStepCommonDefinition } from '../../common/round_capture_step';
import { captureRound, type CaptureRoundDeps } from './capture_round';

/** The `context-engine.captureRound` step the round capture system workflow runs. */
export const createCaptureRoundStepDefinition = ({
  getDeps,
  logger,
}: {
  getDeps: () => Promise<Omit<CaptureRoundDeps, 'logger'>>;
  logger: Logger;
}) =>
  createServerStepDefinition({
    ...captureRoundStepCommonDefinition,
    handler: async (context) => {
      const { workflow } = context.contextManager.getContext();
      try {
        const output = await captureRound(
          { ...(await getDeps()), logger },
          {
            input: context.input,
            // The execution's space: the system workflow itself is global.
            spaceId: workflow.spaceId,
            request: context.contextManager.getFakeRequest(),
          }
        );
        context.logger.debug(
          `Round '${context.input.round_id}': ${output.status}${
            output.reason ? ` (${output.reason})` : ''
          }`
        );
        return { output };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new ExecutionError({
          type: 'RoundCaptureError',
          message: `Failed to record round '${context.input.round_id}': ${message}`,
        });
      }
    },
  });
