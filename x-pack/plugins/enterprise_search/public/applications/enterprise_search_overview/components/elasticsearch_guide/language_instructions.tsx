/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import React from 'react';

import { EuiCodeBlock, EuiTitle, EuiLink, EuiSpacer } from '@elastic/eui';
import { i18n } from '@kbn/i18n';

// prettier-ignore
const javascript1 = 
`{
  "elastic": {
    "cloudID": "Empty:dXMtY2VudHJhbDEuZ2NwLmNsb3VkLmVzLmlvJDM4NzNmN...",
    "username": "elastic",
    "password": "LONGPASSWORD"
  }
}`;

// prettier-ignore
const javascript2 = 
`const { Client } = require('@elastic/elasticsearch')
const config = require('config');
const elasticConfig = config.get('elastic');

const client = new Client({
  cloud: {
    id: elasticConfig.cloudID
  },
  auth: {
    username: elasticConfig.username,
    password: elasticConfig.password
  }
})`;

export const LanguageInstructions: React.FC<{ language: string }> = ({ language }) => {
  if (language === 'javascript') {
    return (
      <>
        <EuiTitle size="xxs">
          <h4>
            {i18n.translate(
              'xpack.enterpriseSearch.overview.elasticsearchGuide.createSampleApplicationTitle',
              { defaultMessage: 'Create a sample application' }
            )}
          </h4>
        </EuiTitle>
        <EuiSpacer size="s" />
        <EuiCodeBlock fontSize="m" isCopyable>
          {javascript1}
        </EuiCodeBlock>
        <EuiSpacer size="m" />
        <EuiTitle size="xxs">
          <h4>
            {i18n.translate('xpack.enterpriseSearch.overview.elasticsearchGuide.ingestDataTitle', {
              defaultMessage: 'Ingest data',
            })}
          </h4>
        </EuiTitle>
        <EuiSpacer size="s" />
        <EuiCodeBlock fontSize="m" isCopyable overflowHeight={300}>
          {javascript2}
        </EuiCodeBlock>
        <EuiSpacer size="l" />
        <EuiLink href="#" external>
          {i18n.translate(
            'xpack.enterpriseSearch.overview.elasticsearchGuide.javascriptClientLink',
            { defaultMessage: 'Learn more about the Elasticsearch JavaScript client' }
          )}
        </EuiLink>
      </>
    );
  }

  return null;
};
