/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  CONTEXT_ENGINE_DOCUMENT_ORCHESTRATION_TEMPLATE,
  CONTEXT_ENGINE_DOCUMENT_SUMMARY_WORKFLOW_ID,
  CONTEXT_ENGINE_ENTITY_PROFILE_TEMPLATE,
  CONTEXT_ENGINE_INDEX_METADATA_TEMPLATE,
} from '@kbn/workflows/managed';

export type AutomationTemplateId = 'document_orchestration' | 'entity_profile' | 'index_metadata';

/** Stable tag written into each installed workflow so a later call updates that workflow. */
export const AUTOMATION_TEMPLATE_TAGS: Record<AutomationTemplateId, string> = {
  document_orchestration: 'ce-template:document_orchestration',
  entity_profile: 'ce-template:entity_profile',
  index_metadata: 'ce-template:index_metadata',
};

export interface DocumentOrchestrationTemplateValues {
  aiIndexId: string;
  sourceIndex: string;
  titleField: string;
  bodyField: string;
  corpusFilter: string;
  maxDocuments: number;
  bodyMaxChars: number;
}

export interface EntityProfileTemplateValues {
  aiIndexId: string;
  sourceIndex: string;
  entityField: string;
  breakdownField: string;
  metricFields: string[];
  maxEntities: number;
}

export interface IndexMetadataTemplateValues {
  aiIndexId: string;
  sourceIndex: string;
  categoryField: string;
}

const yamlString = (value: string): string => JSON.stringify(value);

/**
 * Index and field names reach ES|QL inside backticks and reach Liquid unescaped, so a backtick or
 * a brace pair in one would change the query the workflow runs rather than fail it.
 */
export const assertSafeIdentifier = (label: string, value: string): void => {
  if (/[`\r\n]/.test(value) || value.includes('{{') || value.includes('}}')) {
    throw new Error(
      `${label} "${value}" contains a backtick, a line break or a Liquid brace pair, which an ES|QL identifier cannot carry.`
    );
  }
};

/** An ES|QL column name derived from a field name, unique within one rendered query. */
const metricColumnName = (field: string, taken: Set<string>): string => {
  const slug = field
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const base = `avg_${slug === '' ? 'metric' : slug}`;
  let column = base;
  for (let suffix = 2; taken.has(column); suffix++) {
    column = `${base}_${suffix}`;
  }
  taken.add(column);
  return column;
};

/** The orchestration splices this between FROM and the next pipe. A bare WHERE is not valid there. */
const corpusFilterLine = (filter: string): string => {
  const trimmed = filter.trim();
  if (trimmed === '' || trimmed.startsWith('|')) {
    return trimmed;
  }
  return `| ${trimmed}`;
};

const replaceTokens = (template: string, tokens: Record<string, string>): string =>
  template.replace(/__[A-Z0-9_]+__/g, (token) => {
    const value = tokens[token];
    if (value === undefined) {
      throw new Error(
        `Automation template defines ${token}, and the renderer has no value for it.`
      );
    }
    return value;
  });

export const renderDocumentOrchestrationTemplate = (
  values: DocumentOrchestrationTemplateValues
): string => {
  assertSafeIdentifier('sourceIndex', values.sourceIndex);
  assertSafeIdentifier('titleField', values.titleField);
  assertSafeIdentifier('bodyField', values.bodyField);

  return replaceTokens(CONTEXT_ENGINE_DOCUMENT_ORCHESTRATION_TEMPLATE, {
    __AI_INDEX_ID__: yamlString(values.aiIndexId),
    __SOURCE_INDEX__: yamlString(values.sourceIndex),
    __TITLE_FIELD__: yamlString(values.titleField),
    __BODY_FIELD__: yamlString(values.bodyField),
    __CORPUS_FILTER__: yamlString(corpusFilterLine(values.corpusFilter)),
    __MAX_DOCUMENTS__: String(values.maxDocuments),
    __BODY_MAX_CHARS__: String(values.bodyMaxChars),
    __DOCUMENT_SUMMARY_WORKFLOW_ID__: yamlString(CONTEXT_ENGINE_DOCUMENT_SUMMARY_WORKFLOW_ID),
  });
};

export const renderEntityProfileTemplate = (values: EntityProfileTemplateValues): string => {
  assertSafeIdentifier('sourceIndex', values.sourceIndex);
  assertSafeIdentifier('entityField', values.entityField);
  assertSafeIdentifier('breakdownField', values.breakdownField);
  for (const field of values.metricFields) {
    assertSafeIdentifier('metricFields entry', field);
  }

  const taken = new Set<string>(['doc_count', 'distinct_breakdown']);
  const metrics = values.metricFields.map((field) => ({
    field,
    column: metricColumnName(field, taken),
  }));

  return replaceTokens(CONTEXT_ENGINE_ENTITY_PROFILE_TEMPLATE, {
    __AI_INDEX_ID__: yamlString(values.aiIndexId),
    __SOURCE_INDEX__: yamlString(values.sourceIndex),
    __ENTITY_FIELD__: yamlString(values.entityField),
    __BREAKDOWN_FIELD__: yamlString(values.breakdownField),
    __MAX_ENTITIES__: String(values.maxEntities),
    __METRIC_STATS__: metrics
      .map(({ field, column }) => `, ${column} = AVG(\`${field}\`)`)
      .join(''),
    __METRIC_COLUMNS__: metrics
      .map(({ field, column }) => `, ${column} (AVG of ${field})`)
      .join(''),
  });
};

export const renderIndexMetadataTemplate = (values: IndexMetadataTemplateValues): string => {
  assertSafeIdentifier('sourceIndex', values.sourceIndex);
  assertSafeIdentifier('categoryField', values.categoryField);

  return replaceTokens(CONTEXT_ENGINE_INDEX_METADATA_TEMPLATE, {
    __AI_INDEX_ID__: yamlString(values.aiIndexId),
    __SOURCE_INDEX__: yamlString(values.sourceIndex),
    __CATEGORY_FIELD__: yamlString(values.categoryField),
  });
};
