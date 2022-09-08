/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import React from 'react';

import { ENTERPRISE_SEARCH_ANALYTICS_LOGS_SOURCE_ID } from '../../../../../common/constants';
import { EntSearchLogStream } from '../../../shared/log_stream';
import { EnterpriseSearchAnalyticsPageTemplate } from '../layout/page_template';
import { useParams } from 'react-router-dom';

export const AnalyticCollectionView: React.FC = () => {
  const { name } = useParams() as { name: string };
  const filters = {
    bool: {
      must: [],
      should: [],
      must_not: [],
      filter: [
        {
          term: {
            _index: `logs-elastic_analytics.events-${name}*`,
          },
        },
      ],
    },
  };

  return (
    <EnterpriseSearchAnalyticsPageTemplate
      pageChrome={[]}
      restrictWidth
      isLoading={false}
      pageViewTelemetry="Analytics Collections Overview"
    >
      <EntSearchLogStream
        logView={{
          type: 'log-view-reference',
          logViewId: ENTERPRISE_SEARCH_ANALYTICS_LOGS_SOURCE_ID,
        }}
        columns={[
          {
            type: 'timestamp',
          },
          {
            type: 'field',
            field: 'event',
            header: 'Event',
          },
        ]}
        query={filters}
      />
    </EnterpriseSearchAnalyticsPageTemplate>
  );
};
