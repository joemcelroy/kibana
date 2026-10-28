/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { z } from '@kbn/zod/v4';
import { StepCategory } from '@kbn/workflows';
import type { CommonStepDefinition } from '@kbn/workflows-extensions/common';
import { i18n } from '@kbn/i18n';
import { MAX_SHORT_TERM_SESSION_ID_LENGTH, MAX_SHORT_TERM_USER_ID_LENGTH } from '../dreaming';
import { aiIndexIdSchema } from './ki';

export const GET_DREAMING_TASKS_STEP_ID = 'context-engine.getDreamingTasks' as const;
export const GRAPHIFY_STEP_ID = 'context-engine.graphify' as const;
export const COMMIT_DREAMING_STATE_STEP_ID = 'context-engine.commitDreamingState' as const;

const MAX_TASK_ID_LENGTH = 64;

const taskIdSchema = z.string().min(1).max(MAX_TASK_ID_LENGTH).describe('A task of this run');

// An empty string means no target: the workflow renders an absent input that way.
const optionalTargetSchema = (max: number) => z.string().max(max).optional();

export const getDreamingTasksInputSchema = z.object({
  ai_index_id: aiIndexIdSchema.describe('The AI index that dreams'),
  session_id: optionalTargetSchema(MAX_SHORT_TERM_SESSION_ID_LENGTH).describe(
    'Dream only this session. The cursor does not move.'
  ),
  user_id: optionalTargetSchema(MAX_SHORT_TERM_USER_ID_LENGTH).describe(
    'Dream only this user. The cursor does not move.'
  ),
  dry_run: z.boolean().optional().describe('Plan and extract without writing anything'),
});

export const getDreamingTasksOutputSchema = z.object({
  tasks: z
    .array(
      z.object({
        task_id: taskIdSchema,
        group_key: z.string().describe('The session or user the task covers'),
        count: z.number().describe('How many short-term memories the task reads'),
      })
    )
    .describe('The tasks to run, in order. Holds ids and counts only.'),
  dry_run: z.boolean(),
});

export const graphifyInputSchema = z.object({
  ai_index_id: aiIndexIdSchema.describe('The AI index that dreams'),
  task_id: taskIdSchema,
  dry_run: z.boolean().optional().describe('Return the planned changes without writing them'),
});

export const graphifyOutputSchema = z.object({
  task_id: z.string(),
  status: z.enum(['applied', 'unchanged', 'dry_run']),
  created: z.number(),
  updated: z.number(),
  deleted: z.number(),
  rejected: z.number().describe('Change set items that failed validation and were dropped'),
  access_patterns_dropped: z
    .number()
    .optional()
    .describe('Access patterns dropped because their example query did not run'),
  operations: z
    .array(z.record(z.string(), z.unknown()))
    .optional()
    .describe('The planned changes. Only set on a dry run.'),
  rejections: z
    .array(z.object({ item: z.string(), reason: z.string() }))
    .optional()
    .describe('Why each rejected item was rejected. Only set on a dry run.'),
});

export const commitDreamingStateInputSchema = z.object({
  ai_index_id: aiIndexIdSchema.describe('The AI index that dreams'),
});

export const commitDreamingStateOutputSchema = z.object({
  status: z.enum(['succeeded', 'partial', 'failed']),
  tasks: z.number(),
  failed_tasks: z.number(),
  cursor_moved: z.boolean(),
  warning: z.string().optional(),
});

export const getDreamingTasksStepCommonDefinition: CommonStepDefinition<
  typeof getDreamingTasksInputSchema,
  typeof getDreamingTasksOutputSchema
> = {
  id: GET_DREAMING_TASKS_STEP_ID,
  label: i18n.translate('xpack.contextEngine.workflows.steps.getDreamingTasks.label', {
    defaultMessage: 'Plan a dreaming run',
  }),
  description: i18n.translate('xpack.contextEngine.workflows.steps.getDreamingTasks.description', {
    defaultMessage:
      'Claim an AI index for dreaming and split its new short-term memories into tasks.',
  }),
  category: StepCategory.Kibana,
  stability: 'tech_preview',
  inputSchema: getDreamingTasksInputSchema,
  outputSchema: getDreamingTasksOutputSchema,
  documentation: {
    details: i18n.translate(
      'xpack.contextEngine.workflows.steps.getDreamingTasks.documentation.details',
      {
        defaultMessage:
          'Marks the run as in progress on the AI index, then reads the short-term memories ' +
          'written after its cursor, plus any groups queued for retry, and groups them into ' +
          'ordered tasks. Fails if another run is in progress.',
      }
    ),
    examples: [
      `## Plan a run
\`\`\`yaml
- name: plan_run
  type: ${GET_DREAMING_TASKS_STEP_ID}
  with:
    ai_index_id: "my-ai-index"
\`\`\``,
    ],
  },
};

export const graphifyStepCommonDefinition: CommonStepDefinition<
  typeof graphifyInputSchema,
  typeof graphifyOutputSchema
> = {
  id: GRAPHIFY_STEP_ID,
  label: i18n.translate('xpack.contextEngine.workflows.steps.graphify.label', {
    defaultMessage: 'Graphify memories',
  }),
  description: i18n.translate('xpack.contextEngine.workflows.steps.graphify.description', {
    defaultMessage:
      'Turn one dreaming task into long-term entities, facts, and relationships in an AI index.',
  }),
  category: StepCategory.Kibana,
  stability: 'tech_preview',
  inputSchema: graphifyInputSchema,
  outputSchema: graphifyOutputSchema,
  documentation: {
    details: i18n.translate('xpack.contextEngine.workflows.steps.graphify.documentation.details', {
      defaultMessage:
        "Loads the task's short-term memories and the owner's long-term memory, asks the " +
        'Context Engine model for a change set, validates it, and writes it. The plan is ' +
        'saved before writing, so a retried task applies the same changes. Only counts are ' +
        'returned, so memory content stays out of the execution history.',
    }),
    examples: [
      `## Graphify each task
\`\`\`yaml
- name: run_tasks
  type: foreach
  foreach: '\${{ steps.plan_run.output.tasks }}'
  steps:
    - name: graphify
      type: ${GRAPHIFY_STEP_ID}
      with:
        ai_index_id: "my-ai-index"
        task_id: '{{ foreach.item.task_id }}'
\`\`\``,
    ],
  },
};

export const commitDreamingStateStepCommonDefinition: CommonStepDefinition<
  typeof commitDreamingStateInputSchema,
  typeof commitDreamingStateOutputSchema
> = {
  id: COMMIT_DREAMING_STATE_STEP_ID,
  label: i18n.translate('xpack.contextEngine.workflows.steps.commitDreamingState.label', {
    defaultMessage: 'Commit dreaming state',
  }),
  description: i18n.translate(
    'xpack.contextEngine.workflows.steps.commitDreamingState.description',
    {
      defaultMessage: 'End a dreaming run: move the cursor and queue unfinished tasks for retry.',
    }
  ),
  category: StepCategory.Kibana,
  stability: 'tech_preview',
  inputSchema: commitDreamingStateInputSchema,
  outputSchema: commitDreamingStateOutputSchema,
  documentation: {
    details: i18n.translate(
      'xpack.contextEngine.workflows.steps.commitDreamingState.documentation.details',
      {
        defaultMessage:
          'Moves the cursor past what the run read and puts every task that did not finish ' +
          'into the retry list at its start position. A dry run only records that it finished.',
      }
    ),
    examples: [
      `## Commit a run
\`\`\`yaml
- name: commit
  type: ${COMMIT_DREAMING_STATE_STEP_ID}
  with:
    ai_index_id: "my-ai-index"
\`\`\``,
    ],
  },
};
