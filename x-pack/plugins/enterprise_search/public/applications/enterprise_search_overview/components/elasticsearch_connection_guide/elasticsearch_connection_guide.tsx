/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */


import { EuiButton, EuiButtonEmpty, EuiButtonIcon, EuiCopy, EuiFieldText, EuiFlexGroup, EuiFlexItem, EuiForm, EuiFormRow, EuiLink, EuiPanel, EuiText, EuiTitle, EuiToolTip } from '@elastic/eui'
import React from 'react'

export const ElasticsearchConnectionGuide: React.FC = () => {

  const text = "d999a854f60a4cbc9fb1a58781d6f818"

  return (
    <EuiPanel color="subdued" grow={false}>
      <EuiFlexGroup justifyContent="spaceBetween" alignItems="center" responsive>
        <EuiFlexItem>
            <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false}>
              <EuiFlexItem>
                <EuiTitle size={"xs"}><h2>My deployment</h2></EuiTitle>
              </EuiFlexItem>
            </EuiFlexGroup>
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <EuiLink href="http://www.elastic.co" target="_blank">Manage</EuiLink>
        </EuiFlexItem>
      </EuiFlexGroup>
      <EuiFlexGroup justifyContent="spaceBetween" alignItems="flexStart" responsive direction='column'>
        <EuiFlexItem>

          <EuiForm component="form">
            <EuiFormRow label="Cloud ID">
              <EuiFieldText value={text} append={
                <EuiCopy textToCopy={text}>
                  {(copy) => (
                    <EuiButtonIcon iconType={"copyClipboard"} onClick={copy} iconSize="m" aria-label="Gear this" />
                  )}
                </EuiCopy>
              } />
            </EuiFormRow>
            </EuiForm>
          </EuiFlexItem>
          
          <EuiFlexItem>
            <EuiButton>Manage API Keys</EuiButton>

          </EuiFlexItem>

        
      </EuiFlexGroup>

    </EuiPanel>
  )
}
