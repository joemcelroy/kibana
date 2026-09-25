/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import DOCUMENT_ORCHESTRATION_TEMPLATE_YAML from './document_orchestration_template.yaml';
import DOCUMENT_SUMMARY_YAML from './document_summary.yaml';
import FEEDBACK_ANALYSIS_YAML from './feedback_analysis.yaml';
import INDEX_METADATA_TEMPLATE_YAML from './index_metadata_template.yaml';
import UNIT_PROFILE_TEMPLATE_YAML from './unit_profile_template.yaml';
import type { ManagedWorkflowDefinition, ManagedWorkflowTemplateValues } from '../../types';

export const CONTEXT_ENGINE_FEEDBACK_ANALYSIS_WORKFLOW_ID =
  'system-context-engine-feedback-analysis';

export const CONTEXT_ENGINE_DOCUMENT_SUMMARY_WORKFLOW_ID = 'system-context-engine-document-summary';

/**
 * System workflows an unmanaged AI-index automation is allowed to call. workflow.execute
 * otherwise hides managed and global workflows from an unmanaged parent.
 */
export const UNMANAGED_CALLABLE_CONTEXT_ENGINE_WORKFLOW_IDS = [
  CONTEXT_ENGINE_DOCUMENT_SUMMARY_WORKFLOW_ID,
] as const;

/** YAML the install tool fills in. Not a managed workflow; the saved copy is the AI-index automation. */
export const CONTEXT_ENGINE_DOCUMENT_ORCHESTRATION_TEMPLATE = DOCUMENT_ORCHESTRATION_TEMPLATE_YAML;
export const CONTEXT_ENGINE_UNIT_PROFILE_TEMPLATE = UNIT_PROFILE_TEMPLATE_YAML;
export const CONTEXT_ENGINE_INDEX_METADATA_TEMPLATE = INDEX_METADATA_TEMPLATE_YAML;

export interface ContextEngineFeedbackAnalysisWorkflowTemplateValues
  extends ManagedWorkflowTemplateValues {
  /** The AI index this instance analyzes. */
  aiIndexId: string;
  /** How often the workflow runs. */
  intervalMinutes: number;
}

// `restorable` rather than `enforced`: an instance is enabled after install, by the request of
// whoever turned analysis on, and that enablement is what holds its Task Manager trigger. Enforced
// enablement reapplies the template's `enabled` on every managed update, which would unschedule a
// running instance the next time this definition ships a new version.
const CONTEXT_ENGINE_WORKFLOW_MANAGEMENT = {
  lifecycle: 'dynamic',
  versionStrategy: 'auto',
  enablement: 'restorable',
} as const;

const renderTemplate = (template: string, values: Record<string, string | number>): string =>
  Object.entries(values).reduce(
    (yaml, [token, value]) => yaml.split(token).join(String(value)),
    template
  );

export const CONTEXT_ENGINE_FEEDBACK_ANALYSIS_WORKFLOW = {
  id: CONTEXT_ENGINE_FEEDBACK_ANALYSIS_WORKFLOW_ID,
  pluginId: 'contextEngine',
  version: 1,
  billable: false,
  yamlTemplate: ({ aiIndexId, intervalMinutes }) =>
    renderTemplate(FEEDBACK_ANALYSIS_YAML, {
      __AI_INDEX_ID__: aiIndexId,
      __INTERVAL_MINUTES__: intervalMinutes,
    }),
  management: CONTEXT_ENGINE_WORKFLOW_MANAGEMENT,
} as const satisfies ManagedWorkflowDefinition<ContextEngineFeedbackAnalysisWorkflowTemplateValues>;

// Enforced: workflow.execute rejects a disabled workflow, which would silently stop every
// document orchestration. The manual trigger only declares inputs. Static: one global definition,
// not one per index.
const CONTEXT_ENGINE_DOCUMENT_SUMMARY_MANAGEMENT = {
  lifecycle: 'static',
  versionStrategy: 'auto',
  enablement: 'enforced',
} as const;

export const CONTEXT_ENGINE_DOCUMENT_SUMMARY_WORKFLOW = {
  id: CONTEXT_ENGINE_DOCUMENT_SUMMARY_WORKFLOW_ID,
  pluginId: 'contextEngine',
  version: 1,
  billable: false,
  yaml: DOCUMENT_SUMMARY_YAML,
  management: CONTEXT_ENGINE_DOCUMENT_SUMMARY_MANAGEMENT,
} as const satisfies ManagedWorkflowDefinition;
