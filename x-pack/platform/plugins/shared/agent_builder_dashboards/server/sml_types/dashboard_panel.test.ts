/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { DashboardPluginStart } from '@kbn/dashboard-plugin/server';
import type { DashboardState } from '@kbn/as-code-dashboard-schema';
import { createDashboardPanelSmlType, fromPanelOriginId, toPanelOriginId } from './dashboard_panel';

const dashboard = {
  title: '[eCommerce] Revenue Dashboard',
  time_range: { from: 'now-7d', to: 'now' },
  panels: [
    {
      type: 'vis',
      id: '4',
      config: {
        type: 'metric',
        title: 'Median spending',
        data_source: { type: 'data_view_reference', ref_id: 'ecommerce' },
        metrics: [{ label: 'Median spending', operation: 'median', field: 'taxful_total_price' }],
      },
    },
    { type: 'discover_session', id: '10', config: { ref_id: 'saved-search' } },
    {
      title: 'Products',
      panels: [{ type: 'vis', id: '9', config: { type: 'xy', title: 'Top products' } }],
    },
  ],
} as unknown as DashboardState;

const dashboardClient = {
  read: jest.fn().mockResolvedValue({ id: 'ecommerce', data: dashboard, meta: {} }),
} as unknown as DashboardPluginStart['client'];

const smlType = createDashboardPanelSmlType({ getDashboardClient: async () => dashboardClient });

const context = (savedObjectsClient: Record<string, unknown>) =>
  ({
    esClient: { esql: { query: jest.fn().mockResolvedValue({}) } },
    logger: { warn: jest.fn(), debug: jest.fn() },
    savedObjectsClient,
  } as never);

describe('dashboardPanelSmlType', () => {
  it('round-trips a panel origin id', () => {
    expect(fromPanelOriginId(toPanelOriginId('ecommerce', '4'))).toEqual({
      dashboardId: 'ecommerce',
      panelId: '4',
    });
    expect(fromPanelOriginId('no-panel')).toBeUndefined();
  });

  it('lists every visualization panel of every dashboard, sections included', async () => {
    const savedObjectsClient = {
      createPointInTimeFinder: jest.fn().mockReturnValue({
        async *find() {
          yield {
            saved_objects: [
              { id: 'ecommerce', updated_at: '2026-11-02T10:00:00.000Z', namespaces: ['default'] },
            ],
          };
        },
        close: jest.fn(),
      }),
    };

    const pages = [];
    for await (const page of smlType.list(context(savedObjectsClient))) {
      pages.push(page);
    }

    expect(pages).toEqual([
      [
        { id: 'ecommerce/4', updatedAt: '2026-11-02T10:00:00.000Z', spaces: ['default'] },
        { id: 'ecommerce/9', updatedAt: '2026-11-02T10:00:00.000Z', spaces: ['default'] },
      ],
    ]);
  });

  it('writes one KI per panel with its query, linked to its dashboard', async () => {
    const savedObjectsClient = {
      get: jest.fn().mockResolvedValue({
        attributes: { title: 'kibana_sample_data_ecommerce', timeFieldName: 'order_date' },
      }),
    };

    const entry = await smlType.getSmlEntry('ecommerce/4', context(savedObjectsClient));

    expect(entry).toEqual({
      type: 'dashboard_panel',
      title: 'Median spending',
      description: 'A metric panel on the dashboard "[eCommerce] Revenue Dashboard".',
      content: expect.stringContaining('Dashboard: [eCommerce] Revenue Dashboard'),
      attributes: {
        dashboard_id: 'ecommerce',
        panel_id: '4',
        chart_type: 'metric',
        esql: [
          [
            'FROM kibana_sample_data_ecommerce',
            '| WHERE order_date >= NOW() - 7 days AND order_date <= NOW()',
            '| STATS `Median spending` = MEDIAN(taxful_total_price)',
          ].join('\n'),
        ],
        index_patterns: ['kibana_sample_data_ecommerce'],
      },
      references: [{ uri: 'dashboard://ecommerce' }],
    });
  });

  it('writes nothing for a panel that is gone', async () => {
    expect(await smlType.getSmlEntry('ecommerce/99', context({ get: jest.fn() }))).toBeUndefined();
  });

  it('is read with the dashboard privilege', () => {
    expect(smlType.getPermissions?.('ecommerce/4', context({}))).toEqual({
      kibana: { privileges: { name: ['ai_index:dashboard/read'] } },
    });
  });
});
