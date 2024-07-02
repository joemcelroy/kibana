/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import React, { useState } from 'react';
import { EuiButtonIcon } from '@elastic/eui';
import { useFormContext } from 'react-hook-form';
import { ViewHistoryFlyout } from './view_history_flyout';
import { ChatForm, ChatFormFields } from '../../types';

export const ViewHistoryAction: React.FC = () => {
  const [showFlyout, setShowFlyout] = useState(false);
  const { watch } = useFormContext<ChatForm>();
  const selectedIndices: string[] = watch(ChatFormFields.indices);

  return (
    <>
      {showFlyout && <ViewHistoryFlyout onClose={() => setShowFlyout(false)} />}
      <EuiButtonIcon
        aria-label="View history"
        onClick={() => setShowFlyout(true)}
        disabled={selectedIndices?.length === 0}
        display="base"
        data-test-subj="ViewHistoryButton"
        iconType="clockCounter"
        size="m"
      />
    </>
  );
};
