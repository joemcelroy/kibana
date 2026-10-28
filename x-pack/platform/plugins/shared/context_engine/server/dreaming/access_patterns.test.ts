/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  accessPatternAttributes,
  accessPatternsOf,
  baseContent,
  keepVerifiedPatterns,
  renderContent,
  type AccessPattern,
} from './access_patterns';
import type { UpsertFactOperation } from './resolve_change_set';

const pattern = (label: string): AccessPattern => ({
  question_type: label,
  esql_template: 'FROM orders | WHERE customer == ?customer | LIMIT 10',
  esql_example: `FROM orders | WHERE customer == "${label}" | LIMIT 10`,
  returns: `Orders for ${label}`,
});

describe('access patterns', () => {
  it('renders patterns after the content and splits them off again', () => {
    const content = renderContent('Alice orders tea.', [pattern('alice')]);
    expect(content).toBe(
      [
        'Alice orders tea.',
        '',
        '## Access patterns',
        '- [alice] Orders for alice',
        '  Template: `FROM orders | WHERE customer == ?customer | LIMIT 10`',
        '  Example: `FROM orders | WHERE customer == "alice" | LIMIT 10`',
      ].join('\n')
    );
    expect(baseContent(content)).toBe('Alice orders tea.');
    expect(baseContent(renderContent(undefined, [pattern('alice')]))).toBe('');
    expect(renderContent('Alice orders tea.', [])).toBe('Alice orders tea.');
  });

  it('round-trips patterns through attributes, with every example under esql', () => {
    const attributes = accessPatternAttributes([pattern('alice'), pattern('bob')]);
    expect(attributes.esql).toEqual([
      'FROM orders | WHERE customer == "alice" | LIMIT 10',
      'FROM orders | WHERE customer == "bob" | LIMIT 10',
    ]);
    expect(accessPatternsOf({ id: 'k', type: 'fact.fact', title: 't', attributes })).toEqual([
      pattern('alice'),
      pattern('bob'),
    ]);
    expect(accessPatternAttributes([])).toEqual({});
  });

  it('ignores stored patterns that do not parse', () => {
    expect(
      accessPatternsOf({
        id: 'k',
        type: 'fact.fact',
        title: 't',
        attributes: { access_patterns: ['not json', '{"question_type":"x"}'] },
      })
    ).toEqual([]);
  });

  it('keeps existing patterns when every new one fails', async () => {
    const operation: UpsertFactOperation = {
      op: 'upsert_fact',
      id: 'alice/fact-1',
      type: 'fact',
      title: 'Alice orders',
      content: 'Alice orders tea.',
      accessPatterns: [pattern('alice')],
      sourceMemoryIds: ['m-1'],
      sessionIds: [],
    };
    const { operations, dropped } = await keepVerifiedPatterns([operation], async () => false);
    expect(dropped).toBe(1);
    expect(operations).toEqual([
      expect.not.objectContaining({ accessPatterns: expect.anything() }),
    ]);
  });
});
