/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { EuiProvider } from '@elastic/eui';
import { I18nProvider } from '@kbn/i18n-react';
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { AiIndicesFields, type AiIndicesFieldsProps } from './ai_indices_fields';

const aiIndices = [
  { id: 'elastic', description: 'Elastic knowledge' },
  { id: 'user-memories', description: 'What agents learn about each user' },
  { id: 'sales', description: 'Sales data' },
];

const renderFields = (props: Partial<AiIndicesFieldsProps> = {}) => {
  const onElasticAiIndexChange = jest.fn();
  render(
    <I18nProvider>
      <EuiProvider>
        <AiIndicesFields
          aiIndices={aiIndices}
          assignedIds={[]}
          inheritedIds={['elastic', 'user-memories', 'type-index']}
          isLoading={false}
          isFormDisabled={false}
          onChange={jest.fn()}
          onElasticAiIndexChange={onElasticAiIndexChange}
          {...props}
        />
      </EuiProvider>
    </I18nProvider>
  );
  return { onElasticAiIndexChange };
};

describe('AiIndicesFields built-in AI indices', () => {
  it('shows elastic as a checked checkbox, other defaults as badges, and no user-memories', () => {
    renderFields();

    expect(screen.getByTestId('agentBuilderElasticAiIndex')).toBeChecked();
    expect(screen.getByTestId('agentBuilderDefaultAiIndex-type-index')).toBeInTheDocument();
    expect(screen.queryByTestId('agentBuilderDefaultAiIndex-elastic')).not.toBeInTheDocument();
    expect(screen.queryByText('user-memories')).not.toBeInTheDocument();
  });

  it('reports a change to the elastic checkbox', () => {
    const { onElasticAiIndexChange } = renderFields();

    fireEvent.click(screen.getByTestId('agentBuilderElasticAiIndex'));

    expect(onElasticAiIndexChange).toHaveBeenCalledWith(false);
  });

  it('shows elastic unchecked once switched off', () => {
    renderFields({ inheritedIds: ['type-index'], elasticAiIndexEnabled: false });

    expect(screen.getByTestId('agentBuilderElasticAiIndex')).not.toBeChecked();
  });

  it('leaves out the elastic checkbox for an agent whose type does not provide it', () => {
    renderFields({ inheritedIds: ['user-memories'] });

    expect(screen.queryByTestId('agentBuilderElasticAiIndex')).not.toBeInTheDocument();
  });
});
