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
  EuiPanel,
  EuiSpacer,
  EuiSwitch,
  EuiText,
  EuiTitle,
} from '@elastic/eui';
import { Controller, useFormContext } from 'react-hook-form';
import { useIsContextEngineEnabled } from '../../../../hooks/use_is_context_engine_enabled';
import { labels } from '../../../../utils/i18n';
import type { EditDetailsFormData } from './types';

/**
 * Switches the agent's user memory (`enable_user_memory`; unset means on).
 */
export const MemorySection: React.FC = () => {
  const isContextEngineEnabled = useIsContextEngineEnabled();
  const { control } = useFormContext<EditDetailsFormData>();

  if (!isContextEngineEnabled) {
    return null;
  }

  return (
    <>
      <EuiSpacer size="m" />
      <EuiPanel hasBorder paddingSize="l" data-test-subj="editDetailsMemorySection">
        <EuiFlexGroup alignItems="center" justifyContent="spaceBetween" responsive={false}>
          <EuiFlexItem grow>
            <EuiTitle size="xxs">
              <h4>{labels.userMemory.sectionTitle}</h4>
            </EuiTitle>
            <EuiSpacer size="xs" />
            <EuiText size="s" color="subdued">
              {labels.userMemory.sectionDescription}
            </EuiText>
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <Controller
              name="configuration.enable_user_memory"
              control={control}
              render={({ field: { onChange, value } }) => (
                <EuiSwitch
                  label={labels.userMemory.switchLabel}
                  showLabel={false}
                  checked={value !== false}
                  onChange={(e) => onChange(e.target.checked)}
                  data-test-subj="editDetailsUserMemorySwitch"
                />
              )}
            />
          </EuiFlexItem>
        </EuiFlexGroup>
      </EuiPanel>
    </>
  );
};
