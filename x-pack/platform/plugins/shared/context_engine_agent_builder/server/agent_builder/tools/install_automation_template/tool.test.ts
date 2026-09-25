/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createInstallAutomationTemplateTool } from './tool';

const createTool = () =>
  createInstallAutomationTemplateTool({
    getAiIndexService: async () => {
      throw new Error('not used');
    },
    getCoreStart: async () => {
      throw new Error('not used');
    },
    getSecurityStart: async () => undefined,
    getWorkflowsManagement: () => {
      throw new Error('not used');
    },
  });

describe('install_automation_template schema', () => {
  const schema = createTool().schema;

  it('defaults the document bounds and does not ask for an AI index id', () => {
    const parsed = schema.safeParse({
      template: 'document_orchestration',
      sourceIndex: 'loyalty-docs',
      titleField: 'title',
      bodyField: 'body',
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).not.toHaveProperty('aiIndexId');
      expect(parsed.data.corpusFilter).toBeUndefined();
      expect(parsed.data.maxDocuments).toBeUndefined();
      expect(parsed.data.bodyMaxChars).toBeUndefined();
    }
    expect(createTool().confirmation).toBeUndefined();
  });

  it('rejects index metadata arguments on a document install', () => {
    const parsed = schema.safeParse({
      template: 'document_orchestration',
      sourceIndex: 'loyalty-docs',
      titleField: 'title',
      bodyField: 'body',
      categoryField: 'tier',
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects document arguments on an index metadata install', () => {
    const parsed = schema.safeParse({
      template: 'index_metadata',
      sourceIndex: 'loyalty-docs',
      categoryField: 'tier',
      corpusFilter: '| WHERE tier == "gold"',
    });

    expect(parsed.success).toBe(false);
  });

  it('requires the fields the template fills', () => {
    expect(
      schema.safeParse({ template: 'document_orchestration', sourceIndex: 'loyalty-docs' }).success
    ).toBe(false);
    expect(
      schema.safeParse({ template: 'index_metadata', sourceIndex: 'loyalty-docs' }).success
    ).toBe(false);
    expect(
      schema.safeParse({ template: 'entity_profile', sourceIndex: 'loyalty-history' }).success
    ).toBe(false);
  });

  it('takes an entity profile install with the metric fields optional', () => {
    const parsed = schema.safeParse({
      template: 'entity_profile',
      sourceIndex: 'loyalty-history',
      entityField: 'Province',
      breakdownField: 'Loyalty Card',
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.metricFields).toBeUndefined();
      expect(parsed.data.maxEntities).toBeUndefined();
    }
  });

  it('rejects arguments belonging to either other template on an entity install', () => {
    const base = {
      template: 'entity_profile',
      sourceIndex: 'loyalty-history',
      entityField: 'Province',
      breakdownField: 'Loyalty Card',
    };

    expect(schema.safeParse({ ...base, categoryField: 'tier' }).success).toBe(false);
    expect(schema.safeParse({ ...base, maxDocuments: 10 }).success).toBe(false);
  });

  it('rejects entity arguments on the other two templates', () => {
    expect(
      schema.safeParse({
        template: 'index_metadata',
        sourceIndex: 'loyalty-docs',
        categoryField: 'tier',
        maxEntities: 10,
      }).success
    ).toBe(false);
    expect(
      schema.safeParse({
        template: 'document_orchestration',
        sourceIndex: 'loyalty-docs',
        titleField: 'title',
        bodyField: 'body',
        metricFields: ['CLV'],
      }).success
    ).toBe(false);
  });
});
