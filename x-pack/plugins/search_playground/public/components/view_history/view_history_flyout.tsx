/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  EuiButtonEmpty,
  EuiFlexGroup,
  EuiFlexItem,
  EuiFlyout,
  EuiFlyoutBody,
  EuiFlyoutHeader,
  EuiPanel,
  EuiSpacer,
  EuiText,
  EuiTitle,
  EuiIcon,
  EuiTimeline,
  EuiTimelineItem,
} from '@elastic/eui';
import { FormattedMessage } from '@kbn/i18n-react';
import React from 'react';
import { useFormContext } from 'react-hook-form';
import { ChatForm } from '../../types';
import { useFormHistory } from '../../hooks/use_form_history';

interface ViewHistoryFlyoutProps {
  onClose: () => void;
}

export const ViewHistoryFlyout: React.FC<ViewHistoryFlyoutProps> = ({ onClose }) => {
  // const usageTracker = useUsageTracker();
  const form = useFormContext<ChatForm>();
  const { getHistory, revertToVersion } = useFormHistory(form);

  const history = getHistory();
  const historyDays = Object.keys(history);

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
          <EuiFlexItem grow={6}>
            {historyDays.length > 0 &&
              historyDays.map((day) => (
                <EuiPanel>
                  <EuiTitle size="xs">
                    <h3>{day}</h3>
                  </EuiTitle>
                  <EuiTimeline>
                    {history[day].map((entry) => (
                      <EuiTimelineItem
                        key={entry.id}
                        icon={<EuiIcon type="editorBold" />}
                        verticalAlign="center"
                      >
                        <EuiText>
                          <p>{entry.summary.join('\n')}</p>
                        </EuiText>
                        <EuiButtonEmpty
                          onClick={() => {
                            revertToVersion(entry.id);
                            onClose();
                          }}
                        >
                          <FormattedMessage
                            id="xpack.searchPlayground.viewHistory.flyout.revertButton"
                            defaultMessage="Revert"
                          />
                        </EuiButtonEmpty>
                      </EuiTimelineItem>
                    ))}
                  </EuiTimeline>
                </EuiPanel>
              ))}
            {historyDays.length === 0 && (
              <EuiText>
                <p>
                  <FormattedMessage
                    id="xpack.searchPlayground.viewHistory.flyout.emptyHistoryMessage"
                    defaultMessage="No history available."
                  />
                </p>
              </EuiText>
            )}
          </EuiFlexItem>
        </EuiFlexGroup>
      </EuiFlyoutBody>
    </EuiFlyout>
  );
};
