/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { EuiProvider } from '@elastic/eui';
import { I18nProvider } from '@kbn/i18n-react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import type { AiIndexDreaming } from '../../../../common/dreaming';
import { useAiIndexDreaming } from '../../hooks/use_ai_index_dreaming';
import { useAllDreamingTemplates } from '../../hooks/use_dreaming_templates';
import { useSaveDreamingConfig } from '../../hooks/use_save_dreaming_config';
import { DreamingPanel } from './dreaming_panel';

jest.mock('../../hooks/use_ai_index_dreaming', () => ({ useAiIndexDreaming: jest.fn() }));
jest.mock('../../hooks/use_save_dreaming_config', () => ({ useSaveDreamingConfig: jest.fn() }));
jest.mock('../../hooks/use_dreaming_templates', () => ({ useAllDreamingTemplates: jest.fn() }));
const navigateToContextEngine = jest.fn();
jest.mock('../../hooks/use_navigation', () => ({
  useNavigation: () => ({ navigateToContextEngine }),
}));

const saveConfig = jest.fn();

const SUPPORT_ENTITIES = {
  nodes: [{ type: 'issue' }, { type: 'product_area' }],
  edges: [{ type: 'affects', source: 'issue', target: 'product_area' }],
};

const factsOnly: AiIndexDreaming = {
  enabled: true,
  instructions: 'Record fixes.',
  facts: [{ type: 'solution' }, { type: 'policy' }],
  state: { retry: [] },
};

const withDreaming = (dreaming: AiIndexDreaming | undefined, rest = {}) =>
  jest
    .mocked(useAiIndexDreaming)
    .mockReturnValue({ dreaming, isLoading: false, error: undefined, ...rest });

const renderPanel = (managed = false) =>
  render(
    <I18nProvider>
      <EuiProvider>
        <DreamingPanel aiIndexId="tickets" managed={managed} />
      </EuiProvider>
    </I18nProvider>
  );

describe('DreamingPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    saveConfig.mockResolvedValue(true);
    jest.mocked(useSaveDreamingConfig).mockReturnValue({ saveConfig, isSaving: false });
    jest.mocked(useAllDreamingTemplates).mockReturnValue({
      templates: [
        {
          id: 'customer_support',
          name: 'Customer support',
          description: 'Tickets.',
          summary: 'Support.',
          rationale: 'Issues.',
          dreaming: { facts: [{ type: 'solution' }], entities: SUPPORT_ENTITIES },
        },
      ],
      isLoading: false,
      error: undefined,
    });
  });

  it('links to the setup when dreaming was never set up', () => {
    withDreaming(undefined);
    renderPanel();

    fireEvent.click(screen.getByTestId('contextAiIndexDreamingSetUp'));

    expect(navigateToContextEngine).toHaveBeenCalledWith('/ai_index/tickets/dreaming_template');
  });

  it('shows the config and state as JSON in a modal', () => {
    withDreaming(factsOnly);
    renderPanel();

    expect(screen.queryByTestId('contextAiIndexDreamingJson')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('contextAiIndexDreamingViewJson'));

    const json = screen.getByTestId('contextAiIndexDreamingJson');
    expect(json).toHaveTextContent('"instructions": "Record fixes."');
    expect(json).toHaveTextContent('"retry": []');
  });

  it('saves edited types, keeping the rest of the config', async () => {
    withDreaming(factsOnly);
    renderPanel();

    expect(screen.queryByTestId('contextAiIndexDreamingSave')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('contextDreamingConfigFact-policy-delete'));
    fireEvent.click(screen.getByTestId('contextAiIndexDreamingSave'));

    await waitFor(() =>
      expect(saveConfig).toHaveBeenCalledWith({
        aiIndexId: 'tickets',
        config: {
          enabled: true,
          instructions: 'Record fixes.',
          facts: [{ type: 'solution' }],
          entities: null,
        },
      })
    );
  });

  it('suggests the entities of the example the facts match when entities are turned on', async () => {
    withDreaming(factsOnly);
    renderPanel();

    fireEvent.click(screen.getByTestId('contextDreamingConfigEntitiesSwitch'));
    expect(screen.getByTestId('contextDreamingConfigEntity-product_area')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('contextAiIndexDreamingSave'));

    await waitFor(() =>
      expect(saveConfig).toHaveBeenCalledWith({
        aiIndexId: 'tickets',
        config: expect.objectContaining({ entities: SUPPORT_ENTITIES }),
      })
    );
  });

  it('shows the instructions first, and saves edits to them', async () => {
    withDreaming(factsOnly);
    renderPanel();

    const instructions = screen.getByTestId('contextAiIndexDreamingInstructions');
    expect(instructions).toHaveValue('Record fixes.');
    const order = [
      ...screen
        .getByTestId('contextAiIndexDreamingPanel')
        .querySelectorAll(
          '[data-test-subj="contextAiIndexDreamingInstructions"], [data-test-subj="contextDreamingConfigEditor"]'
        ),
    ].map((element) => element.getAttribute('data-test-subj'));
    expect(order).toEqual(['contextAiIndexDreamingInstructions', 'contextDreamingConfigEditor']);
    fireEvent.change(instructions, { target: { value: 'Record confirmed fixes only.' } });
    fireEvent.click(screen.getByTestId('contextAiIndexDreamingSave'));

    await waitFor(() =>
      expect(saveConfig).toHaveBeenCalledWith({
        aiIndexId: 'tickets',
        config: {
          enabled: true,
          instructions: 'Record confirmed fixes only.',
          facts: factsOnly.facts,
          entities: null,
        },
      })
    );
  });

  it('discards edits', () => {
    withDreaming(factsOnly);
    renderPanel();

    fireEvent.click(screen.getByTestId('contextDreamingConfigFact-policy-delete'));
    fireEvent.click(screen.getByTestId('contextAiIndexDreamingDiscard'));

    expect(screen.getByTestId('contextDreamingConfigFact-policy')).toBeInTheDocument();
    expect(screen.queryByTestId('contextAiIndexDreamingSave')).not.toBeInTheDocument();
  });

  it('shows a managed AI index’s config read-only', () => {
    withDreaming({ ...factsOnly, entities: SUPPORT_ENTITIES });
    renderPanel(true);

    expect(screen.getByTestId('contextAiIndexDreamingManaged')).toBeInTheDocument();
    expect(screen.getByTestId('contextAiIndexDreamingInstructions')).toHaveAttribute('readonly');
    expect(screen.queryByTestId('contextDreamingConfigFact-policy-delete')).not.toBeInTheDocument();
    expect(screen.getByTestId('contextDreamingConfigEntity-issue')).toBeInTheDocument();
  });

  it('shows a skeleton while loading and an error when the request fails', () => {
    withDreaming(undefined, { isLoading: true });
    const { unmount } = renderPanel();
    expect(screen.getByTestId('contextAiIndexDreamingLoading')).toBeInTheDocument();
    unmount();

    withDreaming(undefined, { error: new Error('Forbidden') });
    renderPanel();
    expect(screen.getByTestId('contextAiIndexDreamingError')).toHaveTextContent('Forbidden');
    expect(screen.queryByTestId('contextAiIndexDreamingViewJson')).not.toBeInTheDocument();
  });
});
