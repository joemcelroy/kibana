/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { loggingSystemMock } from '@kbn/core-logging-server-mocks';
import type { DashboardPluginStart } from '@kbn/dashboard-plugin/server';
import { matchesIndexPattern, registerAiIndexKisRoute } from './ai_index_kis';

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
    {
      type: 'vis',
      id: '5',
      config: {
        type: 'metric',
        title: 'Logs',
        data_source: { type: 'data_view_reference', ref_id: 'logs' },
        metrics: [{ operation: 'count' }],
      },
    },
    { type: 'discover_session', id: '10', config: {} },
  ],
};

const setup = () => {
  let handler: Function = () => undefined;
  const router = {
    versioned: {
      post: () => ({
        addVersion: (_: unknown, routeHandler: Function) => {
          handler = routeHandler;
        },
      }),
    },
  };
  const dashboardClient = {
    read: jest.fn().mockResolvedValue({ id: 'ecommerce-dash', data: dashboard }),
  } as unknown as DashboardPluginStart['client'];
  registerAiIndexKisRoute({
    router: router as never,
    logger: loggingSystemMock.createLogger(),
    getDashboardClient: async () => dashboardClient,
  });
  const views: Record<string, { title: string; timeFieldName: string }> = {
    ecommerce: { title: 'kibana_sample_data_ecommerce', timeFieldName: 'order_date' },
    logs: { title: 'logs-*', timeFieldName: '@timestamp' },
  };
  const savedObjectsClient = {
    find: jest.fn().mockResolvedValue({ saved_objects: [{ id: 'ecommerce-dash' }] }),
    get: jest.fn(async (_type: string, id: string) => ({ attributes: views[id] })),
  };
  const context = {
    core: Promise.resolve({
      savedObjects: { client: savedObjectsClient },
      elasticsearch: { client: { asCurrentUser: { esql: { query: jest.fn() } } } },
    }),
  };
  const call = async (body: Record<string, unknown>) =>
    (await handler(context, { body }, { ok: ({ body: out }: { body: unknown }) => out })) as {
      kis: Array<{ ki_id: string; ki: Record<string, unknown> }>;
    };
  return { call, savedObjectsClient };
};

describe('AI index dashboard KIs route', () => {
  it('matches index patterns by name, glob and comma list', () => {
    expect(
      matchesIndexPattern('kibana_sample_data_ecommerce', 'kibana_sample_data_ecommerce')
    ).toBe(true);
    expect(matchesIndexPattern('kibana_sample_data_ecommerce', '*ecommerce*')).toBe(true);
    expect(matchesIndexPattern('logs-*,metrics-*', 'metrics-*')).toBe(true);
    expect(matchesIndexPattern('logs-*', '*ecommerce*')).toBe(false);
  });

  it('writes a dashboard KI and a KI per panel that reads the index pattern', async () => {
    const { call, savedObjectsClient } = setup();

    const { kis } = await call({ index_pattern: '*ecommerce*' });

    expect(savedObjectsClient.find).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'dashboard' })
    );
    expect(kis.map(({ ki_id: id }) => id)).toEqual([
      'dashboard-ecommerce-dash',
      'dashboard_panel-ecommerce-dash-4',
    ]);
    expect(kis[0].ki).toEqual(
      expect.objectContaining({
        type: 'dashboard',
        title: '[eCommerce] Revenue Dashboard',
        attributes: expect.objectContaining({
          dashboard_id: 'ecommerce-dash',
          esql: [expect.stringContaining('MEDIAN(taxful_total_price)')],
          panel_count: 1,
        }),
        references: [{ uri: 'dashboard://ecommerce-dash', relation: 'derived_from' }],
      })
    );
    expect(kis[1].ki).toEqual(
      expect.objectContaining({
        type: 'dashboard_panel',
        title: 'Median spending',
        content: expect.stringContaining('```esql'),
      })
    );
  });

  it('reads only the dashboards it is given, and every panel without a pattern', async () => {
    const { call, savedObjectsClient } = setup();

    const { kis } = await call({ dashboard_ids: ['ecommerce-dash'] });

    expect(savedObjectsClient.find).not.toHaveBeenCalled();
    expect(kis).toHaveLength(3);
  });
});
