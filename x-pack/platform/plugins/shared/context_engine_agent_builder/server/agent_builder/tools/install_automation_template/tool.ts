/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { ToolType } from '@kbn/agent-builder-common';
import { ToolResultType } from '@kbn/agent-builder-common/tools/tool_result';
import type { BuiltinToolDefinition } from '@kbn/agent-builder-server';
import type { CoreStart } from '@kbn/core/server';
import type { SecurityPluginStart } from '@kbn/security-plugin/server';
import { z } from '@kbn/zod/v4';
import dedent from 'dedent';
import type { WorkflowsServerPluginSetup } from '@kbn/workflows-management-plugin/server';
import type { AiIndexService } from '@kbn/context-engine-plugin/server/ai_indices/service';
import { CONTEXT_ENGINE_INSTALL_AUTOMATION_TEMPLATE_TOOL_ID } from '../../../../common/agent_builder_tools';
import { getSaveAutomationErrorMessage } from '../save_automation/handler';
import { installAutomationTemplateHandler, type InstallAutomationTemplateParams } from './handler';

const MAX_SOURCE_INDEX_LENGTH = 1024;
const MAX_FIELD_NAME_LENGTH = 256;
const MAX_CORPUS_FILTER_LENGTH = 2000;
const MAX_DOCUMENTS_LIMIT = 10_000;
const MAX_BODY_CHARS_LIMIT = 50_000;
const MAX_ENTITIES_LIMIT = 1000;
const MAX_METRIC_FIELDS = 10;

/**
 * Which arguments belong to which template. Anything listed against another template is rejected
 * rather than ignored, so a wrong argument surfaces instead of silently taking a default.
 */
const TEMPLATE_FIELDS = {
  document_orchestration: [
    'titleField',
    'bodyField',
    'corpusFilter',
    'maxDocuments',
    'bodyMaxChars',
  ],
  entity_profile: ['entityField', 'breakdownField', 'metricFields', 'maxEntities'],
  index_metadata: ['categoryField'],
} as const;

const REQUIRED_TEMPLATE_FIELDS = {
  document_orchestration: ['titleField', 'bodyField'],
  entity_profile: ['entityField', 'breakdownField'],
  index_metadata: ['categoryField'],
} as const;

const installAutomationTemplateSchema = z
  .object({
    template: z
      .enum(['document_orchestration', 'entity_profile', 'index_metadata'])
      .describe(
        'Which automation to install. document_orchestration summarises each document. entity_profile writes one profile per recurring entity. index_metadata profiles the index.'
      ),
    sourceIndex: z
      .string()
      .min(1)
      .max(MAX_SOURCE_INDEX_LENGTH)
      .describe('Index or data stream the automation reads.'),
    titleField: z
      .string()
      .min(1)
      .max(MAX_FIELD_NAME_LENGTH)
      .optional()
      .describe('Document title field. Required for document_orchestration.'),
    bodyField: z
      .string()
      .min(1)
      .max(MAX_FIELD_NAME_LENGTH)
      .optional()
      .describe('Document body field. Required for document_orchestration.'),
    corpusFilter: z
      .string()
      .max(MAX_CORPUS_FILTER_LENGTH)
      .optional()
      .describe(
        'ES|QL clause inserted after FROM, such as "| WHERE published_at >= NOW() - 365 days". A WHERE line may omit the leading pipe. Empty reads the whole index. document_orchestration only. Defaults to empty.'
      ),
    maxDocuments: z
      .number()
      .int()
      .min(1)
      .max(MAX_DOCUMENTS_LIMIT)
      .optional()
      .describe(
        'Upper bound on documents summarised in one run. document_orchestration only. Defaults to 50.'
      ),
    bodyMaxChars: z
      .number()
      .int()
      .min(1)
      .max(MAX_BODY_CHARS_LIMIT)
      .optional()
      .describe(
        'Characters of body text sent to the prompt. document_orchestration only. Defaults to 12000.'
      ),
    categoryField: z
      .string()
      .min(1)
      .max(MAX_FIELD_NAME_LENGTH)
      .optional()
      .describe('Keyword field the index profile groups by. Required for index_metadata.'),
    entityField: z
      .string()
      .min(1)
      .max(MAX_FIELD_NAME_LENGTH)
      .optional()
      .describe(
        'Keyword field holding the entity identity. One profile is written per distinct value. Required for entity_profile.'
      ),
    breakdownField: z
      .string()
      .min(1)
      .max(MAX_FIELD_NAME_LENGTH)
      .optional()
      .describe(
        'Second field whose per-entity distribution characterises the entity. Required for entity_profile.'
      ),
    metricFields: z
      .array(z.string().min(1).max(MAX_FIELD_NAME_LENGTH))
      .max(MAX_METRIC_FIELDS)
      .optional()
      .describe(
        'Numeric fields averaged per entity and quoted in the profile. These are what separate sibling profiles for a retriever, so pass the ones an analyst would compare entities on. entity_profile only. Defaults to none.'
      ),
    maxEntities: z
      .number()
      .int()
      .min(1)
      .max(MAX_ENTITIES_LIMIT)
      .optional()
      .describe(
        'Upper bound on entities profiled in one run. Each costs a model call. entity_profile only. Defaults to 25.'
      ),
  })
  .superRefine((value, ctx) => {
    for (const field of REQUIRED_TEMPLATE_FIELDS[value.template]) {
      if (value[field] === undefined) {
        ctx.addIssue({
          code: 'custom',
          message: `${field} is required for ${value.template}.`,
          path: [field],
        });
      }
    }

    for (const [template, fields] of Object.entries(TEMPLATE_FIELDS)) {
      if (template === value.template) {
        continue;
      }
      for (const field of fields) {
        if (value[field] !== undefined) {
          ctx.addIssue({
            code: 'custom',
            message: `${field} is only valid for ${template}.`,
            path: [field],
          });
        }
      }
    }
  });

type InstallAutomationTemplateInput = z.infer<typeof installAutomationTemplateSchema>;

const toInstallParams = (
  input: InstallAutomationTemplateInput
): InstallAutomationTemplateParams => {
  if (input.template === 'document_orchestration') {
    if (!input.titleField || !input.bodyField) {
      throw new Error('titleField and bodyField are required for document_orchestration.');
    }
    return {
      template: 'document_orchestration',
      sourceIndex: input.sourceIndex,
      titleField: input.titleField,
      bodyField: input.bodyField,
      corpusFilter: input.corpusFilter ?? '',
      maxDocuments: input.maxDocuments ?? 50,
      bodyMaxChars: input.bodyMaxChars ?? 12000,
    };
  }

  if (input.template === 'entity_profile') {
    if (!input.entityField || !input.breakdownField) {
      throw new Error('entityField and breakdownField are required for entity_profile.');
    }
    return {
      template: 'entity_profile',
      sourceIndex: input.sourceIndex,
      entityField: input.entityField,
      breakdownField: input.breakdownField,
      metricFields: input.metricFields ?? [],
      maxEntities: input.maxEntities ?? 25,
    };
  }

  if (!input.categoryField) {
    throw new Error('categoryField is required for index_metadata.');
  }

  return {
    template: 'index_metadata',
    sourceIndex: input.sourceIndex,
    categoryField: input.categoryField,
  };
};

type WorkflowsManagementApi = WorkflowsServerPluginSetup['management'];

export const createInstallAutomationTemplateTool = ({
  getAiIndexService,
  getCoreStart,
  getSecurityStart,
  getWorkflowsManagement,
}: {
  getAiIndexService: () => Promise<AiIndexService>;
  getCoreStart: () => Promise<CoreStart>;
  getSecurityStart: () => Promise<SecurityPluginStart | undefined>;
  getWorkflowsManagement: () => WorkflowsManagementApi;
}): BuiltinToolDefinition<typeof installAutomationTemplateSchema> => ({
  id: CONTEXT_ENGINE_INSTALL_AUTOMATION_TEMPLATE_TOOL_ID,
  type: ToolType.builtin,
  tags: ['context_engine', 'workflows'],
  annotations: {
    title: 'Install automation template',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  description: dedent`
    Install the index-metadata, document-orchestration or entity-profile automation on the Context
    Engine AI index attached to this conversation. Arguments fill the workflow consts. Do not pass
    an AI index id and do not write the YAML yourself. Do not start a subagent for these three
    templates.
    document_orchestration attaches only the orchestration. Each document is summarised by the
    system workflow system-context-engine-document-summary, which is already installed and is not
    attached to the AI index.
    entity_profile writes one KI per distinct entityField value. Pass metricFields: sibling
    profiles are interchangeable to a retriever unless their descriptions carry numbers that
    separate them.
    If this template is already an automation on the AI index, the call replaces that workflow's
    definition and keeps the same workflow id. It does not add a second automation.
    To run it afterwards, call platform.context_engine.run_automation with the returned workflowId.
  `,
  schema: installAutomationTemplateSchema,
  handler: async (params, { request, spaceId, attachments, logger }) => {
    try {
      const result = await installAutomationTemplateHandler({
        params: toInstallParams(installAutomationTemplateSchema.parse(params)),
        request,
        spaceId,
        attachments,
        logger,
        getAiIndexService,
        getCoreStart,
        getSecurityStart,
        getWorkflowsManagement,
      });

      return {
        results: [
          {
            type: ToolResultType.other,
            data: result,
          },
        ],
      };
    } catch (error) {
      const message = getSaveAutomationErrorMessage(error);
      logger.error(
        `Error running ${CONTEXT_ENGINE_INSTALL_AUTOMATION_TEMPLATE_TOOL_ID}: ${message}`,
        { error }
      );
      return {
        results: [
          {
            type: ToolResultType.error,
            data: {
              message: `Failed to install automation template: ${message}`,
            },
          },
        ],
      };
    }
  },
});
