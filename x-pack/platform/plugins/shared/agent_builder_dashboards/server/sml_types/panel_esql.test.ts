/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  formulaToEsql,
  renderPanel,
  shiftTimeRange,
  summarizePanel,
  summarizePanels,
  timeRangeMs,
  type DashboardQueryContext,
  type ResolveDataView,
} from './panel_esql';

const ECOMMERCE = { type: 'data_view_reference', ref_id: 'ecommerce' };
const resolveDataView: ResolveDataView = async (refId) =>
  refId === 'ecommerce'
    ? { indexPattern: 'kibana_sample_data_ecommerce', timeField: 'order_date' }
    : undefined;
const lastWeek: DashboardQueryContext = { timeRange: { from: 'now-7d', to: 'now' } };

const vis = (config: Record<string, unknown>, id = '1') => ({ type: 'vis', id, config });

const queriesOf = async (config: Record<string, unknown>, dashboard = lastWeek) =>
  (await summarizePanel(vis(config), dashboard, resolveDataView)).layers;

describe('panel ES|QL', () => {
  it('sums a field over the dashboard time range', async () => {
    const [layer] = await queriesOf({
      type: 'metric',
      title: 'Sum of revenue',
      data_source: ECOMMERCE,
      metrics: [{ label: 'Sum of revenue', operation: 'sum', field: 'taxful_total_price' }],
    });

    expect(layer.esql).toBe(
      [
        'FROM kibana_sample_data_ecommerce',
        '| WHERE order_date >= NOW() - 7 days AND order_date <= NOW()',
        '| STATS `Sum of revenue` = SUM(taxful_total_price)',
      ].join('\n')
    );
    expect(layer.dimensions).toEqual(['Sum of revenue: sum(taxful_total_price)']);
  });

  it('ranks the top terms by a metric, over the panel’s own time range', async () => {
    const [layer] = await queriesOf({
      type: 'xy',
      time_range: { from: 'now-2w', to: 'now-1w' },
      layers: [
        {
          data_source: ECOMMERCE,
          type: 'bar_horizontal',
          y: [{ label: 'Items', operation: 'count' }],
          x: {
            operation: 'terms',
            fields: ['products.product_name.keyword'],
            limit: 5,
            rank_by: { type: 'metric', metric_index: 0, direction: 'desc' },
          },
        },
      ],
    });

    expect(layer.esql).toBe(
      [
        'FROM kibana_sample_data_ecommerce',
        '| WHERE order_date >= NOW() - 2 weeks AND order_date <= NOW() - 1 weeks',
        '| STATS Items = COUNT(*) BY products.product_name.keyword',
        '| SORT Items DESC',
        '| LIMIT 5',
      ].join('\n')
    );
  });

  it('filters a metric, and buckets by time with the suggested interval', async () => {
    const [layer] = await queriesOf({
      type: 'xy',
      layers: [
        {
          data_source: ECOMMERCE,
          y: [
            {
              label: 'Revenue Watches',
              operation: 'sum',
              field: 'taxful_total_price',
              filter: { language: 'lucene', expression: 'products.product_name:*watch*' },
            },
          ],
          x: { operation: 'date_histogram', field: 'order_date', suggested_interval: '12h' },
        },
      ],
    });

    expect(layer.esql).toContain(
      '| STATS `Revenue Watches` = SUM(taxful_total_price) WHERE QSTR("products.product_name:*watch*") BY order_date = DATE_TRUNC(12 hours, order_date)'
    );
    expect(layer.esql).toContain('| SORT order_date ASC');
  });

  it('turns a formula into an aggregation expression, with the time range length', async () => {
    expect(formulaToEsql('count() / (time_range() / 1000 / 60 / 60 / 24)', 604_800_000)).toBe(
      'COUNT(*) / (604800000.0 / 1000 / 60 / 60 / 24)'
    );
    expect(formulaToEsql('sum(taxful_total_price) / 10000 - 1', undefined)).toBe(
      'SUM(taxful_total_price) / 10000 - 1'
    );
    expect(() => formulaToEsql("sum(price) - sum(price, shift='1w')", undefined)).toThrow(
      'a time shift'
    );
  });

  it('gives time-shifted metrics a query over the shifted range', async () => {
    const layers = await queriesOf({
      type: 'xy',
      layers: [
        {
          data_source: ECOMMERCE,
          y: [
            { label: 'Transactions', operation: 'count' },
            { label: 'Tx. last week', operation: 'count', time_shift: '1w' },
          ],
          x: { operation: 'date_histogram', field: 'order_date', suggested_interval: '1d' },
        },
      ],
    });

    expect(layers).toHaveLength(2);
    expect(layers[0].esql).toContain('| STATS Transactions = COUNT(*) BY');
    expect(layers[1].esql).toContain(
      '| WHERE order_date >= NOW() - 14 days AND order_date <= NOW() - 7 days'
    );
    expect(layers[1].esql).toContain('`Tx. last week` = COUNT(*)');
    expect(layers[1].shiftedTimeRange).toEqual({ from: 'now-14d', to: 'now-7d' });
  });

  it('leaves out what ES|QL can’t express, and says so', async () => {
    const [layer] = await queriesOf({
      type: 'data_table',
      data_source: ECOMMERCE,
      metrics: [
        { label: 'This week', operation: 'sum', field: 'taxful_total_price' },
        {
          label: 'Difference',
          operation: 'formula',
          formula: "sum(taxful_total_price) - sum(taxful_total_price, shift='1w')",
        },
        { label: 'Trend', operation: 'moving_average', of: { operation: 'count' } },
      ],
    });

    expect(layer.esql).toContain('| STATS `This week` = SUM(taxful_total_price)');
    expect(layer.esql).not.toContain('Difference');
    expect(layer.notes).toEqual([
      expect.stringContaining('"Difference" is left out'),
      expect.stringContaining('"Trend" is left out'),
    ]);
  });

  it('adds the dashboard query unless the panel ignores it, and notes filters it can’t add', async () => {
    const dashboard = {
      ...lastWeek,
      query: { language: 'kql', expression: 'customer_gender : "FEMALE"' },
      filterCount: 1,
    };
    const config = {
      type: 'metric',
      data_source: ECOMMERCE,
      metrics: [{ operation: 'count' }],
    };

    const [withQuery] = await queriesOf(config, dashboard);
    const [ignoring] = await queriesOf({ ...config, ignore_global_filters: true }, dashboard);

    expect(withQuery.esql).toContain('AND KQL("customer_gender : \\"FEMALE\\"")');
    expect(withQuery.notes).toContain("The dashboard's 1 filter(s) are not included.");
    expect(ignoring.esql).not.toContain('KQL(');
  });

  it('uses a panel’s own ES|QL as it is', async () => {
    const [layer] = await queriesOf({
      type: 'metric',
      data_source: { type: 'esql', query: 'FROM logs | STATS c = COUNT(*)' },
      metrics: [{ operation: 'value', column: 'c' }],
    });

    expect(layer.esql).toBe('FROM logs | STATS c = COUNT(*)');
  });

  it('summarizes every panel, sections included, and shows panels without data as they are', async () => {
    const summaries = await summarizePanels(
      [
        { type: 'discover_session', id: '10', config: { ref_id: 'saved-search' } },
        {
          title: 'Revenue',
          panels: [
            vis(
              {
                type: 'metric',
                title: 'Median spending',
                data_source: ECOMMERCE,
                metrics: [{ operation: 'median', field: 'taxful_total_price' }],
              },
              '4'
            ),
          ],
        },
      ],
      lastWeek,
      resolveDataView
    );

    expect(summaries.map(({ id, section, layers }) => [id, section, layers.length])).toEqual([
      ['10', undefined, 0],
      ['4', 'Revenue', 1],
    ]);
    expect(renderPanel(summaries[1])).toContain(
      '```esql\nFROM kibana_sample_data_ecommerce\n| WHERE order_date >= NOW() - 7 days AND order_date <= NOW()\n| STATS median_taxful_total_price = MEDIAN(taxful_total_price)\n```'
    );
    expect(renderPanel(summaries[0])).toBe(
      '### Untitled discover_session panel (discover_session)\nTime range: now-7d to now'
    );
  });

  it('notes a data source it can’t resolve', async () => {
    const [layer] = await queriesOf({
      type: 'metric',
      data_source: { type: 'data_view_reference', ref_id: 'gone' },
      metrics: [{ operation: 'count' }],
    });

    expect(layer.esql).toBeUndefined();
    expect(layer.notes).toContain('Its data source could not be resolved.');
  });

  it('measures and shifts relative time ranges', () => {
    expect(timeRangeMs({ from: 'now-2w', to: 'now-1w' })).toBe(604_800_000);
    expect(shiftTimeRange({ from: 'now-7d', to: 'now' }, 'previous')).toEqual({
      from: 'now-14d',
      to: 'now-7d',
    });
    expect(shiftTimeRange({ from: '2026-10-01T00:00:00.000Z', to: 'now' }, '1d')).toEqual({
      from: '2026-09-30T00:00:00.000Z',
      to: 'now-1d',
    });
    expect(shiftTimeRange({ from: 'now-7d', to: 'now' }, 'soon')).toBeUndefined();
  });
});
