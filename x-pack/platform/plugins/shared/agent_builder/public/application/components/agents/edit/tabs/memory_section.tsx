/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import React from 'react';
import {
  EuiFlexGroup,
  EuiFlexItem,
  EuiHorizontalRule,
  EuiIcon,
  EuiSwitch,
  EuiText,
  EuiTitle,
} from '@elastic/eui';
import { Controller } from 'react-hook-form';
import type { Control } from 'react-hook-form';
import { useIsContextEngineEnabled } from '../../../../hooks/use_is_context_engine_enabled';
import { labels } from '../../../../utils/i18n';
import type { AgentFormData } from '../agent_form';

interface MemorySectionProps {
  control: Control<AgentFormData>;
  isFormDisabled: boolean;
}

/**
 * Switches the agent's user memory (`enable_user_memory`; unset means on), as a section of the
 * agent form's settings tab.
 */
export const MemorySection: React.FC<MemorySectionProps> = ({ control, isFormDisabled }) => {
  const isContextEngineEnabled = useIsContextEngineEnabled();

  if (!isContextEngineEnabled) {
    return null;
  }

  return (
    <>
      <EuiHorizontalRule />
      <EuiFlexGroup
        direction="row"
        gutterSize="xl"
        alignItems="flexStart"
        aria-labelledby="memory-section-title"
      >
        <EuiFlexItem grow={1}>
          <EuiFlexGroup direction="column" gutterSize="s" alignItems="flexStart">
            <EuiFlexGroup direction="row" gutterSize="s" alignItems="center">
              <EuiIcon type="memory" aria-hidden={true} />
              <EuiTitle size="xs">
                <h2 id="memory-section-title">{labels.userMemory.sectionTitle}</h2>
              </EuiTitle>
            </EuiFlexGroup>
            <EuiText size="s" color="subdued">
              <p>{labels.userMemory.sectionDescription}</p>
            </EuiText>
          </EuiFlexGroup>
        </EuiFlexItem>
        <EuiFlexItem grow={2}>
          <Controller
            name="configuration.enable_user_memory"
            control={control}
            render={({ field: { onChange, value } }) => (
              <EuiSwitch
                label={labels.userMemory.switchLabel}
                checked={value !== false}
                onChange={(e) => onChange(e.target.checked)}
                disabled={isFormDisabled}
                data-test-subj="agentSettingsUserMemorySwitch"
              />
            )}
          />
        </EuiFlexItem>
      </EuiFlexGroup>
    </>
  );
};
