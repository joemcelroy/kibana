/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  CONTEXT_ENGINE_DOCUMENT_ORCHESTRATION_TEMPLATE,
  CONTEXT_ENGINE_DOCUMENT_SUMMARY_WORKFLOW,
  CONTEXT_ENGINE_INDEX_METADATA_TEMPLATE,
} from '@kbn/workflows/managed';
import { WorkflowSchemaBase } from '@kbn/workflows/spec/schema';
import { parse } from 'yaml';
import {
  AUTOMATION_TEMPLATE_TAGS,
  renderDocumentOrchestrationTemplate,
  renderEntityProfileTemplate,
  renderIndexMetadataTemplate,
} from './render';

const entityValues = {
  aiIndexId: 'airline-loyalty',
  sourceIndex: 'airline_loyalty_customer_loyalty_history',
  entityField: 'Province',
  breakdownField: 'Loyalty Card',
  metricFields: [] as string[],
  maxEntities: 25,
};

describe('automation template rendering', () => {
  it('keeps the installed document summary on one straight branch', () => {
    const summary = CONTEXT_ENGINE_DOCUMENT_SUMMARY_WORKFLOW.yaml;
    const orchestration = CONTEXT_ENGINE_DOCUMENT_ORCHESTRATION_TEMPLATE;

    expect(orchestration).toContain('type: parallel');
    expect(orchestration).toContain('mode: settled');
    expect(orchestration).toContain('max: 5');
    expect(orchestration).toContain('type: workflow.execute');
    expect(orchestration).toContain('__DOCUMENT_SUMMARY_WORKFLOW_ID__');
    expect(summary).toContain('reasoning-level: minimal');
    expect(summary).toContain('connector-id-by-feature: context_engine_prompt');
    expect(summary).not.toContain('type: parallel');
    expect(CONTEXT_ENGINE_INDEX_METADATA_TEMPLATE).toContain(
      'connector-id-by-feature: context_engine_prompt'
    );
  });

  it('quotes string consts and leaves numbers bare', () => {
    const yaml = renderDocumentOrchestrationTemplate({
      aiIndexId: 'airline-loyalty',
      sourceIndex: 'loyalty-docs',
      titleField: 'title',
      bodyField: 'body',
      corpusFilter: 'WHERE title == "O\'Brien"',
      maxDocuments: 50,
      bodyMaxChars: 12000,
    });

    expect(yaml).toContain('ai_index_id: "airline-loyalty"');
    expect(yaml).toContain('corpus_filter: "| WHERE title == \\"O\'Brien\\""');
    expect(yaml).toContain('max_documents: 50');
    expect(yaml).toContain('body_max_chars: 12000');
    expect(yaml).toContain('workflow-id: "system-context-engine-document-summary"');
    expect(yaml).toContain(AUTOMATION_TEMPLATE_TAGS.document_orchestration);
    expect(yaml).not.toMatch(/__[A-Z0-9_]+__/);
  });

  it('keeps a corpus filter that itself contains underscores', () => {
    const yaml = renderDocumentOrchestrationTemplate({
      aiIndexId: 'airline-loyalty',
      sourceIndex: 'loyalty-docs',
      titleField: 'title',
      bodyField: 'body',
      corpusFilter: 'WHERE code == "__KEEP__"',
      maxDocuments: 50,
      bodyMaxChars: 12000,
    });

    expect(yaml).toContain('| WHERE code == \\"__KEEP__\\"');
  });

  it('fills the index metadata consts', () => {
    const yaml = renderIndexMetadataTemplate({
      aiIndexId: 'airline-loyalty',
      sourceIndex: 'loyalty-docs',
      categoryField: 'tier',
    });

    expect(yaml).toContain('category_field: "tier"');
    expect(yaml).toContain(AUTOMATION_TEMPLATE_TAGS.index_metadata);
    expect(yaml).not.toMatch(/__[A-Z0-9_]+__/);
  });

  it('fills the entity profile consts', () => {
    const yaml = renderEntityProfileTemplate(entityValues);

    expect(yaml).toContain('entity_field: "Province"');
    expect(yaml).toContain('breakdown_field: "Loyalty Card"');
    expect(yaml).toContain('max_entities: 25');
    expect(yaml).toContain(AUTOMATION_TEMPLATE_TAGS.entity_profile);
    expect(yaml).not.toMatch(/__[A-Z0-9_]+__/);
  });

  it('appends one averaged column per metric field, after the two fixed columns', () => {
    const yaml = renderEntityProfileTemplate({
      ...entityValues,
      metricFields: ['CLV', 'Points Accumulated'],
    });

    expect(yaml).toContain(
      'STATS doc_count = COUNT(*), distinct_breakdown = COUNT_DISTINCT(`{{ consts.breakdown_field }}`), avg_clv = AVG(`CLV`), avg_points_accumulated = AVG(`Points Accumulated`)'
    );
    expect(yaml).toContain(
      'columns: doc_count, distinct_breakdown, avg_clv (AVG of CLV), avg_points_accumulated (AVG of Points Accumulated))'
    );
    expect(yaml).toContain('doc_count: "{{ steps.entity_totals.output.values[0][0] }}"');
    expect(yaml).toContain('distinct_breakdown: "{{ steps.entity_totals.output.values[0][1] }}"');
  });

  it('leaves the totals query unchanged when no metric fields are passed', () => {
    const yaml = renderEntityProfileTemplate(entityValues);

    expect(yaml).toContain(
      'STATS doc_count = COUNT(*), distinct_breakdown = COUNT_DISTINCT(`{{ consts.breakdown_field }}`)\n'
    );
    expect(yaml).not.toContain('avg_');
    expect(yaml).toContain('columns: doc_count, distinct_breakdown)');
  });

  it('gives metric fields that slug to the same name distinct columns', () => {
    const yaml = renderEntityProfileTemplate({
      ...entityValues,
      metricFields: ['total points', 'total_points'],
    });

    expect(yaml).toContain('avg_total_points = AVG(`total points`)');
    expect(yaml).toContain('avg_total_points_2 = AVG(`total_points`)');
  });

  it('backticks every field identifier so names containing spaces parse', () => {
    expect(CONTEXT_ENGINE_INDEX_METADATA_TEMPLATE).toContain('BY `{{ consts.category_field }}`');
    expect(CONTEXT_ENGINE_INDEX_METADATA_TEMPLATE).toContain(
      'COUNT_DISTINCT(`{{ consts.category_field }}`)'
    );
    expect(CONTEXT_ENGINE_DOCUMENT_ORCHESTRATION_TEMPLATE).toContain(
      'SUBSTRING(`{{ consts.body_field }}`'
    );
    expect(CONTEXT_ENGINE_DOCUMENT_ORCHESTRATION_TEMPLATE).toContain(
      'KEEP _id, `{{ consts.title_field }}`, body'
    );
  });

  it.each([
    [
      'document_orchestration',
      () =>
        renderDocumentOrchestrationTemplate({
          aiIndexId: 'airline-loyalty',
          sourceIndex: 'loyalty-docs',
          titleField: 'title',
          bodyField: 'body',
          corpusFilter: 'WHERE tier == "gold"',
          maxDocuments: 50,
          bodyMaxChars: 12000,
        }),
    ],
    [
      'entity_profile',
      () => renderEntityProfileTemplate({ ...entityValues, metricFields: ['CLV'] }),
    ],
    [
      'index_metadata',
      () =>
        renderIndexMetadataTemplate({
          aiIndexId: 'airline-loyalty',
          sourceIndex: 'loyalty-docs',
          categoryField: 'tier',
        }),
    ],
  ])('renders %s into a definition the workflow schema accepts', (_template, render) => {
    const parsed = WorkflowSchemaBase.safeParse(parse(render()));

    if (!parsed.success) {
      throw new Error(JSON.stringify(parsed.error.issues, null, 2));
    }
  });

  it('rejects an identifier that would break out of its backticks', () => {
    expect(() =>
      renderEntityProfileTemplate({ ...entityValues, entityField: 'Province` | DROP x | EVAL y="' })
    ).toThrow(/entityField .* backtick/);
    expect(() =>
      renderEntityProfileTemplate({ ...entityValues, metricFields: ['{{ consts.ai_index_id }}'] })
    ).toThrow(/metricFields entry/);
    expect(() =>
      renderIndexMetadataTemplate({
        aiIndexId: 'airline-loyalty',
        sourceIndex: 'loyalty-docs',
        categoryField: 'tier`',
      })
    ).toThrow(/categoryField/);
  });
});
