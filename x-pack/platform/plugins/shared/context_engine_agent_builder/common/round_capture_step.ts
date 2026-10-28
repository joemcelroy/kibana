/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { z } from '@kbn/zod/v4';
import { i18n } from '@kbn/i18n';
import { StepCategory } from '@kbn/workflows';
import type { CommonStepDefinition } from '@kbn/workflows-extensions/common';

export const CAPTURE_ROUND_STEP_ID = 'context-engine.captureRound' as const;

const MAX_ID_LENGTH = 1024;

export const captureRoundInputSchema = z.object({
  conversation_id: z
    .string()
    .min(1)
    .max(MAX_ID_LENGTH)
    .describe('Conversation of the completed round'),
  round_id: z.string().min(1).max(MAX_ID_LENGTH).describe('Id of the completed round'),
  agent_id: z.string().max(MAX_ID_LENGTH).optional().describe('Agent that had the round'),
});

export const CAPTURE_ROUND_SKIP_REASONS = [
  'memory_off',
  'not_found',
  'not_owner',
  'opted_out',
  'no_target',
  'already_captured',
] as const;

export type CaptureRoundSkipReason = (typeof CAPTURE_ROUND_SKIP_REASONS)[number];

// Never any content: a run keeps its step outputs.
export const captureRoundOutputSchema = z.object({
  status: z.enum(['captured', 'skipped']),
  reason: z.enum(CAPTURE_ROUND_SKIP_REASONS).optional().describe('Why the round was skipped'),
  ai_index_ids: z.array(z.string()).optional().describe('The AI indices the recorded round is for'),
});

export type CaptureRoundInput = z.infer<typeof captureRoundInputSchema>;
export type CaptureRoundOutput = z.infer<typeof captureRoundOutputSchema>;

export const captureRoundStepCommonDefinition: CommonStepDefinition<
  typeof captureRoundInputSchema,
  typeof captureRoundOutputSchema
> = {
  id: CAPTURE_ROUND_STEP_ID,
  label: i18n.translate('xpack.contextEngine.workflows.steps.captureRound.label', {
    defaultMessage: 'Record a conversation round',
  }),
  description: i18n.translate('xpack.contextEngine.workflows.steps.captureRound.description', {
    defaultMessage:
      "Save the transcript of a completed Agent Builder round, for the agent's per-user AI indices to dream.",
  }),
  category: StepCategory.Kibana,
  stability: 'tech_preview',
  inputSchema: captureRoundInputSchema,
  outputSchema: captureRoundOutputSchema,
  documentation: {
    details: i18n.translate(
      'xpack.contextEngine.workflows.steps.captureRound.documentation.details',
      {
        defaultMessage:
          'Reads the round as the user who had it, renders it as a transcript, and saves the ' +
          "transcript, apart from short-term memory, for the agent's AI indices that take " +
          'conversation rounds. Skips the round when the user ' +
          'turned learning from conversations off, or when no AI index takes it.',
      }
    ),
    examples: [
      `## Record a round
\`\`\`yaml
- name: capture_round
  type: ${CAPTURE_ROUND_STEP_ID}
  with:
    conversation_id: "{{ inputs.conversation_id }}"
    round_id: "{{ inputs.round_id }}"
    agent_id: "{{ inputs.agent_id }}"
\`\`\``,
    ],
  },
};
