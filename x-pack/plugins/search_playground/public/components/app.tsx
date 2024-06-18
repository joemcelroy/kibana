/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import React, { useEffect, useState } from 'react';
import { KibanaPageTemplate } from '@kbn/shared-ux-page-kibana-template';

import { useFormContext } from 'react-hook-form';
import { SetupPage } from './setup_page/setup_page';
import { useLoadConnectors } from '../hooks/use_load_connectors';
import { ChatForm, ChatFormFields } from '../types';
import { Chat } from './chat';

export const App: React.FC = () => {
  const [showSetupPage, setShowSetupPage] = useState(true);
  const { watch } = useFormContext<ChatForm>();
  const { data: connectors } = useLoadConnectors();
  const hasSelectedIndices = watch(ChatFormFields.indices).length;

  useEffect(() => {
    if (showSetupPage && connectors?.length && hasSelectedIndices) {
      setShowSetupPage(false);
    }
  }, [connectors, hasSelectedIndices, showSetupPage]);

  return (
    <KibanaPageTemplate.Section
      alignment="top"
      restrictWidth={false}
      grow
      css={{
        position: 'relative',
      }}
      contentProps={{ css: { display: 'flex', flexGrow: 1, position: 'absolute', inset: 0 } }}
      paddingSize="none"
      className="eui-fullHeight"
    >
      {showSetupPage ? <SetupPage /> : <Chat />}
    </KibanaPageTemplate.Section>
  );
};
