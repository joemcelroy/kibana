/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { AiIndexCatalogEntry } from '../../types';
import {
  getAiIndicesInstructions,
  getUserMemoryInstructions,
  MAX_USER_MEMORY_CONTENT_LENGTH,
  MAX_USER_MEMORY_ENTRIES,
} from './ai_indices';

const defaultCatalog: AiIndexCatalogEntry[] = [
  {
    id: 'elastic',
    esqlTarget: 'sml-main',
    description: 'Summaries of Kibana resources such as dashboards and connectors.',
  },
];

const render = (overrides: Partial<Parameters<typeof getAiIndicesInstructions>[0]> = {}) =>
  getAiIndicesInstructions({
    enabled: true,
    catalog: defaultCatalog,
    spaceId: 'default',
    ...overrides,
  });

describe('getAiIndicesInstructions', () => {
  it('renders nothing when AI Index instructions are disabled', () => {
    expect(render({ enabled: false })).toBe('');
  });

  it('renders nothing for an agent with an empty catalog', () => {
    expect(render({ catalog: [] })).toBe('');
  });

  it('explains what an AI Index is and how it is named', () => {
    const instructions = render();

    expect(instructions).toContain('## AI INDICES');
    expect(instructions).toContain('`ai-index-idx-*`');
    expect(instructions).toContain('`ai-index-ds-*`');
  });

  it('describes KIs as context that may answer directly or lead to another source', () => {
    const instructions = render();

    expect(instructions).toContain('may answer a question directly');
    expect(instructions).toContain('help locate and use another source');
  });

  it('continues with other relevant sources when KIs do not cover the question', () => {
    const instructions = render();

    expect(instructions).toContain('Search relevant AI Indices before broader retrieval');
    expect(instructions).toContain('continue with other relevant data or tools');
  });

  it('starts lookups with recall, narrowed by scope', () => {
    const instructions = render();

    expect(instructions).toContain('start with `platform.context_engine.recall`');
    expect(instructions).toContain("`scope: 'short-term'`");
    expect(instructions).not.toContain('user-memories');
  });

  it('renders each catalog entry with its registry ID, ES|QL target, and description', () => {
    const instructions = render();

    expect(instructions).toContain('Available to this agent:');
    expect(instructions).toContain(
      '- Registry ID: `elastic`; ES|QL target: sml-main — Summaries of Kibana resources such as dashboards and connectors.'
    );
  });

  it('renders every catalog entry, including custom AI Indices', () => {
    const instructions = render({
      catalog: [
        ...defaultCatalog,
        { id: 'my-custom', esqlTarget: 'ai-index-idx-custom', description: 'Support tickets.' },
      ],
    });

    expect(instructions).toContain('- Registry ID: `elastic`; ES|QL target: sml-main');
    expect(instructions).toContain(
      '- Registry ID: `my-custom`; ES|QL target: ai-index-idx-custom — Support tickets.'
    );
  });

  it('omits entries with no ES|QL target from the available list, keeping the resolved ones', () => {
    const instructions = render({ catalog: [...defaultCatalog, { id: 'unresolved-custom' }] });

    expect(instructions).toContain('Available to this agent:');
    expect(instructions).toContain('- Registry ID: `elastic`; ES|QL target: sml-main');
    expect(instructions).not.toContain('unresolved-custom');
  });

  it('renders the section without an available list when no entry resolved to a target', () => {
    const instructions = render({ catalog: [{ id: 'unresolved-custom' }] });

    expect(instructions).toContain('## AI INDICES');
    expect(instructions).toContain('`ki-retrieval`');
    expect(instructions).not.toContain('Available to this agent:');
    expect(instructions).not.toContain('unresolved-custom');
  });

  it('renders both identifiers for an entry without a description', () => {
    const instructions = render({ catalog: [{ id: 'bare-id', esqlTarget: 'bare-target' }] });

    expect(instructions).toContain('- Registry ID: `bare-id`; ES|QL target: bare-target');
    expect(instructions).not.toContain('bare-target —');
  });

  it('points at the ki-retrieval skill by name, leaving the path to the SKILLS section', () => {
    const instructions = render();

    expect(instructions).toContain('recall also takes an ES|QL query');
    expect(instructions).toContain('Load the `ki-retrieval` skill');
    expect(instructions).toContain('carries the AI Index list and describe tools');
    expect(instructions).not.toContain('/skills/');
  });

  it('leaves the list/describe/query guidance to the skill', () => {
    const instructions = render();

    expect(instructions).not.toContain('list_ai_indices');
    expect(instructions).not.toContain('describe_ai_index');
    expect(instructions).not.toContain('query_ai_indices');
    expect(instructions).not.toContain('sml_');
  });

  it("routes everything other than AI Indices to the agent's other data tools", () => {
    const instructions = render();

    expect(instructions).toContain('Query everything else');
    expect(instructions).toContain('including a source a KI points you to');
    expect(instructions).toContain('`generate_esql`');
    expect(instructions).toContain('`execute_esql`');
  });

  it('names the space the conversation runs in', () => {
    const instructions = render({ spaceId: 'marketing' });

    expect(instructions).toContain('This conversation runs in the space `marketing`');
  });

  it('carries no space filter for the agent to copy', () => {
    const instructions = render({ spaceId: 'marketing' });

    expect(instructions).not.toContain('permissions.kibana.privileges');
    expect(instructions).not.toContain('"filter"');
    expect(instructions).not.toContain('ignore_unmapped');
    expect(instructions).not.toContain('verbatim');
  });

  it('marks AI Indices that take memories and points the agent at remember', () => {
    const instructions = render({
      catalog: [
        ...defaultCatalog,
        {
          id: 'support-insights',
          esqlTarget: 'ai-index-idx-support-insights',
          description: 'What support learned.',
          memoryEnabled: true,
        },
      ],
    });

    expect(instructions).toContain(
      '- Registry ID: `support-insights`; ES|QL target: ai-index-idx-support-insights; takes memories — What support learned.'
    );
    expect(instructions).toContain('record it with `remember`');
    expect(instructions).toContain('Memories go to the AI Indices above');
    expect(render({ catalog: defaultCatalog })).not.toContain('`remember`');
  });

  describe('with a hidden AI Index', () => {
    const userMemories: AiIndexCatalogEntry = {
      id: 'user-memories',
      esqlTarget: '.ai-index-idx-user-memories',
      description: 'What agents learned about each user.',
      memoryEnabled: true,
      hidden: true,
    };

    it('leaves it out of the list, and says remembering about the user carries over', () => {
      const instructions = render({ catalog: [...defaultCatalog, userMemories] });

      expect(instructions).toContain('- Registry ID: `elastic`');
      expect(instructions).not.toContain('user-memories');
      expect(instructions).toContain('record it with `remember`');
      expect(instructions).not.toContain('Memories go to the AI Indices above');
      expect(instructions).toContain('it becomes part of what you know about them');
    });

    it('renders only remember guidance when it is the only AI Index', () => {
      const instructions = render({ catalog: [userMemories] });

      expect(instructions).toContain('## MEMORY');
      expect(instructions).toContain('record it with `remember`');
      expect(instructions).not.toContain('## AI INDICES');
      expect(instructions).not.toContain('recall');
    });

    it('renders nothing when it is the only AI Index and takes no memories', () => {
      expect(render({ catalog: [{ ...userMemories, memoryEnabled: false }] })).toBe('');
    });
  });
});

describe('getUserMemoryInstructions', () => {
  const profile = {
    type: 'entity.user',
    title: 'profile',
    content: '## Work context\nRuns support for the loyalty program.',
    updated_at: '2026-10-28T12:00:00.000Z',
  };

  it('renders nothing when disabled or with nothing to give', () => {
    expect(getUserMemoryInstructions({ enabled: false, userMemory: [profile] })).toBe('');
    expect(getUserMemoryInstructions({ enabled: true, userMemory: [] })).toBe('');
    expect(
      getUserMemoryInstructions({ enabled: true, userMemory: [{ type: 'fact.preference' }] })
    ).toBe('');
  });

  it('lists what is known about the user on one line each, with its type and date', () => {
    const instructions = getUserMemoryInstructions({
      enabled: true,
      userMemory: [profile, { type: 'fact.preference', content: 'Prefers aisle seats.' }],
    });

    expect(instructions).toContain('## ABOUT THE USER');
    expect(instructions).toContain('what the user says now wins');
    expect(instructions).toContain(
      '- profile: ## Work context Runs support for the loyalty program. (entity.user, 2026-10-28)'
    );
    expect(instructions).toContain('- Prefers aisle seats. (fact.preference)');
  });

  it('caps how many entries it gives and how long each is', () => {
    const instructions = getUserMemoryInstructions({
      enabled: true,
      userMemory: Array.from({ length: MAX_USER_MEMORY_ENTRIES + 5 }, (_, index) => ({
        type: 'fact.history',
        content: `${index}:${'x'.repeat(MAX_USER_MEMORY_CONTENT_LENGTH)}`,
      })),
    });

    expect(instructions.match(/^- /gm)).toHaveLength(MAX_USER_MEMORY_ENTRIES);
    expect(instructions).not.toContain(`${MAX_USER_MEMORY_ENTRIES}:`);
    expect(instructions).toContain('…');
  });
});
