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
import { useForm } from 'react-hook-form';
import { useIsContextEngineEnabled } from '../../../../hooks/use_is_context_engine_enabled';
import type { AgentFormData } from '../agent_form';
import { MemorySection } from './memory_section';

jest.mock('../../../../hooks/use_is_context_engine_enabled', () => ({
  useIsContextEngineEnabled: jest.fn(),
}));

const mockUseIsContextEngineEnabled = jest.mocked(useIsContextEngineEnabled);

let readValue: () => boolean | undefined;

const Harness = ({ enableUserMemory }: { enableUserMemory?: boolean }) => {
  const { control, getValues } = useForm<AgentFormData>({
    defaultValues: {
      configuration: {
        tools: [],
        enable_user_memory: enableUserMemory,
      },
    },
  });
  readValue = () => getValues('configuration.enable_user_memory');
  return <MemorySection control={control} isFormDisabled={false} />;
};

const renderSection = (enableUserMemory?: boolean) =>
  render(
    <I18nProvider>
      <EuiProvider>
        <Harness enableUserMemory={enableUserMemory} />
      </EuiProvider>
    </I18nProvider>
  );

describe('MemorySection', () => {
  beforeEach(() => mockUseIsContextEngineEnabled.mockReturnValue(true));

  it('shows user memory on when the agent has not set it', () => {
    renderSection();

    expect(screen.getByTestId('agentSettingsUserMemorySwitch')).toBeChecked();
  });

  it('turns user memory off', () => {
    renderSection();

    fireEvent.click(screen.getByTestId('agentSettingsUserMemorySwitch'));

    expect(screen.getByTestId('agentSettingsUserMemorySwitch')).not.toBeChecked();
    expect(readValue()).toBe(false);
  });

  it('shows user memory off when the agent switched it off', () => {
    renderSection(false);

    expect(screen.getByTestId('agentSettingsUserMemorySwitch')).not.toBeChecked();
  });

  it('is hidden while Context Engine is off', () => {
    mockUseIsContextEngineEnabled.mockReturnValue(false);
    renderSection();

    expect(screen.queryByTestId('agentSettingsUserMemorySwitch')).not.toBeInTheDocument();
  });
});
