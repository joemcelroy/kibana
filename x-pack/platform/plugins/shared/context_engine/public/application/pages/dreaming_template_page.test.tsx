/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { EuiProvider } from '@elastic/eui';
import { ChromeServiceProvider } from '@kbn/core-chrome-browser-context';
import { coreMock, scopedHistoryMock } from '@kbn/core/public/mocks';
import { I18nProvider } from '@kbn/i18n-react';
import { KibanaContextProvider } from '@kbn/kibana-react-plugin/public';
import { QueryClient, QueryClientProvider } from '@kbn/react-query';
import { MemoryRouter, Route } from '@kbn/shared-ux-router';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { CONTEXT_ENGINE_APP_ID } from '../../../common/features';
import { AI_INDEX_CREATED_LOCATION_STATE } from '../ai_index_created_location_state';
import { CONTEXT_ENGINE_PATHS, getAiIndexDreamingTemplatePath } from '../paths';
import { createAppChromeMock } from '../test_utils/app_chrome_mock';
import { DreamingTemplatePage } from './dreaming_template_page';

const INDEX = {
  templates: [
    { id: 'customer_support', name: 'Customer support', description: 'Tickets and docs.' },
    { id: 'legal_assistant', name: 'Legal assistant', description: 'Contracts.' },
  ],
};

const SUPPORT = {
  summary: 'Customer support knowledge base.',
  rationale: 'Support knowledge centers on issues.',
  dreaming: {
    instructions: 'Record confirmed fixes.',
    facts: [{ type: 'solution', description: 'A confirmed fix.' }],
    entities: [{ type: 'issue', description: 'A known problem.', attributes: ['severity'] }],
    relationships: [{ type: 'duplicate_of', source: 'issue', target: 'issue' }],
  },
};

const LEGAL = {
  summary: 'Legal knowledge.',
  rationale: 'Rules and the documents that apply them.',
  dreaming: {
    instructions: 'Record obligations.',
    facts: [{ type: 'obligation' }],
    entities: [{ type: 'contract' }],
    relationships: [{ type: 'supersedes', source: 'contract', target: 'contract' }],
  },
};

const renderPage = () => {
  const services = coreMock.createStart();
  jest
    .mocked(services.http.staticAssets.getPluginAssetHref)
    .mockImplementation((path) => `/assets/${path}`);
  services.http.get.mockImplementation((async (path: string) => {
    if (path === '/assets/dreaming_templates/index.json') return INDEX;
    if (path === '/assets/dreaming_templates/customer_support.json') return SUPPORT;
    if (path === '/assets/dreaming_templates/legal_assistant.json') return LEGAL;
    throw new Error(`unexpected ${path}`);
  }) as typeof services.http.get);
  services.http.put.mockResolvedValue({ dreaming: { enabled: true } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <ChromeServiceProvider value={{ chrome: services.chrome }}>
      <I18nProvider>
        <EuiProvider>
          <KibanaContextProvider
            services={{
              ...services,
              history: scopedHistoryMock.create(),
              appChrome: createAppChromeMock(),
            }}
          >
            <QueryClientProvider client={queryClient}>
              <MemoryRouter initialEntries={[getAiIndexDreamingTemplatePath('tickets')]}>
                <Route
                  path={CONTEXT_ENGINE_PATHS.dreamingTemplate}
                  exact
                  component={DreamingTemplatePage}
                />
              </MemoryRouter>
            </QueryClientProvider>
          </KibanaContextProvider>
        </EuiProvider>
      </I18nProvider>
    </ChromeServiceProvider>
  );
  return services;
};

const continuedToAiIndex = {
  path: '/ai_index/tickets',
  state: AI_INDEX_CREATED_LOCATION_STATE,
};

const proposeOntology = async () => {
  await waitFor(() => expect(screen.getByTestId('contextDreamingTemplateNext')).toBeEnabled());
  fireEvent.click(screen.getByTestId('contextDreamingTemplateNext'));
};

describe('DreamingTemplatePage', () => {
  it('lists the examples from the static JSON, starting from the first', async () => {
    const services = renderPage();

    expect(
      await screen.findByTestId('contextDreamingTemplateOption-legal_assistant')
    ).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('contextDreamingTemplateOption-customer_support')).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(await screen.findByTestId('contextDreamingTemplateGraph')).toHaveTextContent('ISSUE');
    expect(screen.getByTestId('contextDreamingTemplateSummary')).toHaveValue(
      'Customer support knowledge base.'
    );
    expect(services.http.get).toHaveBeenCalledWith(
      '/assets/dreaming_templates/index.json',
      expect.objectContaining({ prependBasePath: false })
    );
  });

  it('keeps an edited description until another example is picked', async () => {
    renderPage();

    const summary = await screen.findByTestId('contextDreamingTemplateSummary');
    await waitFor(() => expect(summary).toHaveValue('Customer support knowledge base.'));
    fireEvent.change(summary, { target: { value: 'Acme billing support.' } });
    expect(summary).toHaveValue('Acme billing support.');

    fireEvent.click(screen.getByTestId('contextDreamingTemplateOption-legal_assistant'));
    await waitFor(() =>
      expect(screen.getByTestId('contextDreamingTemplateSummary')).toHaveValue('Legal knowledge.')
    );
  });

  it("proposes the picked example's ontology, with the edited description opening the instructions", async () => {
    renderPage();

    fireEvent.change(await screen.findByTestId('contextDreamingTemplateSummary'), {
      target: { value: 'Acme customer support knowledge base.' },
    });
    await proposeOntology();

    expect(screen.getByTestId('contextDreamingTemplateRationale')).toHaveTextContent(
      'Support knowledge centers on issues.'
    );
    expect(screen.getByTestId('contextDreamingTemplateFact-solution')).toHaveTextContent(
      'A confirmed fix.'
    );
    expect(screen.getByTestId('contextDreamingTemplateEntity-issue')).toHaveTextContent('severity');
    expect(
      screen.getByTestId('contextDreamingTemplateRelationship-duplicate_of')
    ).toHaveTextContent('issue → issue');
    expect(screen.getByTestId('contextDreamingTemplateInstructions')).toHaveTextContent(
      'Acme customer support knowledge base. Record confirmed fixes.'
    );
  });

  it('applies the example, turning dreaming on, then continues to the AI index', async () => {
    const services = renderPage();

    fireEvent.change(await screen.findByTestId('contextDreamingTemplateSummary'), {
      target: { value: 'Acme customer support knowledge base.' },
    });
    await proposeOntology();
    fireEvent.click(screen.getByTestId('contextDreamingTemplateSave'));

    await waitFor(() =>
      expect(services.application.navigateToApp).toHaveBeenCalledWith(
        CONTEXT_ENGINE_APP_ID,
        continuedToAiIndex
      )
    );
    expect(services.http.put).toHaveBeenCalledWith(
      '/api/context_engine/ai_index/tickets/_dreaming',
      {
        version: '2023-10-31',
        body: JSON.stringify({
          enabled: true,
          ...SUPPORT.dreaming,
          instructions: 'Acme customer support knowledge base.\n\nRecord confirmed fixes.',
        }),
      }
    );
  });

  it('goes back to the examples, keeping what was typed', async () => {
    renderPage();

    fireEvent.change(await screen.findByTestId('contextDreamingTemplateSummary'), {
      target: { value: 'Billing support.' },
    });
    await proposeOntology();
    fireEvent.click(screen.getByTestId('contextDreamingTemplateBack'));

    expect(screen.getByTestId('contextDreamingTemplateSummary')).toHaveValue('Billing support.');
  });

  it('stays on the page when saving fails', async () => {
    const services = renderPage();
    services.http.put.mockRejectedValue(new Error('Forbidden'));

    await proposeOntology();
    fireEvent.click(screen.getByTestId('contextDreamingTemplateSave'));

    await waitFor(() => expect(services.notifications.toasts.addError).toHaveBeenCalled());
    expect(services.application.navigateToApp).not.toHaveBeenCalled();
  });

  it('skips to the AI index without saving', async () => {
    const services = renderPage();

    fireEvent.click(await screen.findByTestId('contextDreamingTemplateSkip'));

    expect(services.http.put).not.toHaveBeenCalled();
    expect(services.application.navigateToApp).toHaveBeenCalledWith(
      CONTEXT_ENGINE_APP_ID,
      continuedToAiIndex
    );
  });
});
