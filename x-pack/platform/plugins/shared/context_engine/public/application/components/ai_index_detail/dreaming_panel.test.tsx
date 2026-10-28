/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { EuiProvider } from '@elastic/eui';
import { I18nProvider } from '@kbn/i18n-react';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { useAiIndexDreaming } from '../../hooks/use_ai_index_dreaming';
import { DreamingPanel } from './dreaming_panel';

jest.mock('../../hooks/use_ai_index_dreaming', () => ({
  useAiIndexDreaming: jest.fn(),
}));

const mockUseAiIndexDreaming = jest.mocked(useAiIndexDreaming);

const renderPanel = () =>
  render(
    <I18nProvider>
      <EuiProvider>
        <DreamingPanel aiIndexId="user-memories" />
      </EuiProvider>
    </I18nProvider>
  );

describe('DreamingPanel', () => {
  it('shows the config and state as pretty JSON', () => {
    mockUseAiIndexDreaming.mockReturnValue({
      dreaming: {
        enabled: true,
        group_by: 'user_id',
        sessions: true,
        state: { retry: [] },
      },
      isLoading: false,
      error: undefined,
    });

    renderPanel();

    expect(mockUseAiIndexDreaming).toHaveBeenCalledWith('user-memories');
    const json = screen.getByTestId('contextAiIndexDreamingJson');
    expect(json).toHaveTextContent('"group_by": "user_id"');
    expect(json).toHaveTextContent('"sessions": true');
  });

  it('shows dreaming as off when the AI index never dreamed', () => {
    mockUseAiIndexDreaming.mockReturnValue({
      dreaming: undefined,
      isLoading: false,
      error: undefined,
    });

    renderPanel();

    expect(screen.getByTestId('contextAiIndexDreamingJson')).toHaveTextContent('"enabled": false');
  });

  it('shows a skeleton while loading and an error when the request fails', () => {
    mockUseAiIndexDreaming.mockReturnValue({
      dreaming: undefined,
      isLoading: true,
      error: undefined,
    });
    const { rerender } = renderPanel();
    expect(screen.getByTestId('contextAiIndexDreamingLoading')).toBeInTheDocument();

    mockUseAiIndexDreaming.mockReturnValue({
      dreaming: undefined,
      isLoading: false,
      error: new Error('Forbidden'),
    });
    rerender(
      <I18nProvider>
        <EuiProvider>
          <DreamingPanel aiIndexId="user-memories" />
        </EuiProvider>
      </I18nProvider>
    );
    expect(screen.getByTestId('contextAiIndexDreamingError')).toHaveTextContent('Forbidden');
    expect(screen.queryByTestId('contextAiIndexDreamingJson')).not.toBeInTheDocument();
  });
});
