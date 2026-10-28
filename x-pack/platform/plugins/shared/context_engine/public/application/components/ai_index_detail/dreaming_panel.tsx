/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  EuiCallOut,
  EuiCodeBlock,
  EuiPanel,
  EuiSkeletonText,
  EuiSpacer,
  EuiTitle,
} from '@elastic/eui';
import { i18n } from '@kbn/i18n';
import { FormattedMessage } from '@kbn/i18n-react';
import React from 'react';
import { useAiIndexDreaming } from '../../hooks/use_ai_index_dreaming';
import { AiIndexDetailPanelDescription } from './ai_index_detail_panel_description';

/** Tallest the JSON gets before it scrolls. */
export const DREAMING_JSON_MAX_HEIGHT = 400;

const errorTitle = i18n.translate('xpack.contextEngine.aiIndexDetail.dreaming.errorTitle', {
  defaultMessage: 'Unable to load the dreaming config',
});

interface DreamingPanelProps {
  aiIndexId: string;
}

/** Shows the AI index's dreaming config and state as read-only JSON. */
export const DreamingPanel = ({ aiIndexId }: DreamingPanelProps) => {
  const { dreaming, isLoading, error } = useAiIndexDreaming(aiIndexId);

  return (
    <EuiPanel hasBorder paddingSize="l" data-test-subj="contextAiIndexDreamingPanel">
      <EuiTitle size="s">
        <h2>
          <FormattedMessage
            id="xpack.contextEngine.aiIndexDetail.dreaming.title"
            defaultMessage="Dreaming"
          />
        </h2>
      </EuiTitle>
      <AiIndexDetailPanelDescription>
        <FormattedMessage
          id="xpack.contextEngine.aiIndexDetail.dreaming.description"
          defaultMessage="How this AI index turns short-term memories into long-term knowledge, and where its last run got to."
        />
      </AiIndexDetailPanelDescription>
      <EuiSpacer size="m" />
      {isLoading ? (
        <EuiSkeletonText lines={4} data-test-subj="contextAiIndexDreamingLoading" />
      ) : error ? (
        <EuiCallOut
          announceOnMount={false}
          title={errorTitle}
          color="danger"
          iconType="error"
          size="s"
          data-test-subj="contextAiIndexDreamingError"
        >
          <p>{error.message}</p>
        </EuiCallOut>
      ) : (
        <EuiCodeBlock
          language="json"
          fontSize="s"
          paddingSize="m"
          overflowHeight={DREAMING_JSON_MAX_HEIGHT}
          isCopyable
          data-test-subj="contextAiIndexDreamingJson"
        >
          {JSON.stringify(dreaming ?? { enabled: false }, null, 2)}
        </EuiCodeBlock>
      )}
    </EuiPanel>
  );
};
