/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  EuiAccordion,
  EuiSelectable,
  EuiButton,
  EuiButtonEmpty,
  EuiCodeBlock,
  EuiFlexGroup,
  EuiFlexItem,
  EuiFlyout,
  EuiFlyoutBody,
  EuiFlyoutFooter,
  EuiFlyoutHeader,
  EuiPanel,
  EuiSpacer,
  EuiSelectableOption,
  EuiText,
  EuiTitle,
  EuiCheckbox,
  EuiLink,
  EuiIcon,
} from '@elastic/eui';
import { FormattedMessage } from '@kbn/i18n-react';
import React, { useEffect, useState } from 'react';
import { useFormContext } from 'react-hook-form';
import { useController } from 'react-hook-form';
import { AnalyticsEvents } from '../../analytics/constants';
import { docLinks } from '../../../common/doc_links';
import { useIndicesFields } from '../../hooks/use_indices_fields';
import { useUsageTracker } from '../../hooks/use_usage_tracker';
import { ChatForm, ChatFormFields, IndicesQuerySourceFields } from '../../types';
import { useFormHistory } from '../../hooks/use_form_history';

interface ViewHistoryFlyoutProps {
  onClose: () => void;
}

export const ViewHistoryFlyout: React.FC<ViewHistoryFlyoutProps> = ({ onClose }) => {
  const usageTracker = useUsageTracker();
  const useHistory = useFormHistory();


  // useEffect(() => {
  //   usageTracker?.load(AnalyticsEvents.ViewHistoryFlyoutOpened);
  // }, [usageTracker]);

  return (
    <EuiFlyout ownFocus onClose={onClose} size="s" data-test-subj="ViewHistoryFlyout">
      <EuiFlyoutHeader hasBorder>
        <EuiTitle size="m">
          <h2>
            <FormattedMessage
              id="xpack.searchPlayground.viewHistory.flyout.title"
              defaultMessage="History"
            />
          </h2>
        </EuiTitle>
        <EuiSpacer size="s" />
        <EuiText color="subdued">
          <p>
            <FormattedMessage
              id="xpack.searchPlayground.viewHistory.flyout.description"
              defaultMessage="Revert your workspace back to previous states by selecting a timeline entry from the past 30 days."
            />
          </p>
        </EuiText>
      </EuiFlyoutHeader>
      <EuiFlyoutBody>
        <EuiFlexGroup>
          <EuiFlexItem grow={6}>hello</EuiFlexItem>
        </EuiFlexGroup>
      </EuiFlyoutBody>
    </EuiFlyout>
  );
};
