/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { SmlContext } from '@kbn/agent-builder-sml-plugin/server';
import type { DashboardState } from '@kbn/as-code-dashboard-schema';
import {
  summarizePanels,
  type DashboardQueryContext,
  type PanelDataSource,
  type PanelSummary,
  type ResolveDataView,
} from './panel_esql';

/** Looks data views up by id, once each. */
export const createDataViewResolver = (context: SmlContext): ResolveDataView => {
  const cache = new Map<string, Promise<PanelDataSource | undefined>>();
  return (refId) => {
    if (!cache.has(refId)) {
      cache.set(
        refId,
        context.savedObjectsClient
          .get<{ title?: string; timeFieldName?: string }>('index-pattern', refId)
          .then(({ attributes }) =>
            attributes.title
              ? {
                  indexPattern: attributes.title,
                  ...(attributes.timeFieldName && { timeField: attributes.timeFieldName }),
                }
              : undefined
          )
          .catch(() => undefined)
      );
    }
    return cache.get(refId)!;
  };
};

const dashboardQueryContext = (state: DashboardState): DashboardQueryContext => {
  const {
    time_range: timeRange,
    query,
    filters,
  } = state as DashboardState & {
    time_range?: { from?: string; to?: string };
    query?: { expression?: string; language?: string };
    filters?: unknown[];
  };
  return {
    ...(timeRange?.from &&
      timeRange.to && { timeRange: { from: timeRange.from, to: timeRange.to } }),
    ...(query && { query }),
    filterCount: filters?.length ?? 0,
  };
};

/**
 * Runs each query with `LIMIT 0`, so only queries that parse and resolve their fields are kept.
 * A query that fails is dropped and the reason noted.
 */
const keepRunnableQueries = async (
  summaries: PanelSummary[],
  context: SmlContext
): Promise<PanelSummary[]> => {
  for (const summary of summaries) {
    for (const layer of summary.layers) {
      if (!layer.esql) {
        continue;
      }
      try {
        await context.esClient.esql.query({ query: `${layer.esql}\n| LIMIT 0` });
      } catch (error) {
        const reason = (error as Error).message.split('\n')[0].slice(0, 300);
        context.logger.debug(`SML dashboard: dropping a panel query that does not run: ${reason}`);
        layer.notes.push(`A query was built but does not run, so it is left out: ${reason}`);
        delete layer.esql;
      }
    }
  }
  return summaries;
};

/** The dashboard's panels, each with the ES|QL behind it, checked against the cluster. */
export const summarizeDashboardPanels = async (
  state: DashboardState,
  context: SmlContext,
  resolveDataView: ResolveDataView = createDataViewResolver(context)
): Promise<PanelSummary[]> =>
  keepRunnableQueries(
    await summarizePanels(
      (state.panels ?? []) as unknown[],
      dashboardQueryContext(state),
      resolveDataView
    ),
    context
  );

/** The runnable queries of some panels, without repeats. */
export const queriesOf = (summaries: PanelSummary[]): string[] => [
  ...new Set(summaries.flatMap(({ layers }) => layers.flatMap(({ esql }) => (esql ? [esql] : [])))),
];

/** The index patterns some panels read, without repeats. */
export const indexPatternsOf = (summaries: PanelSummary[]): string[] => [
  ...new Set(
    summaries.flatMap(({ layers }) =>
      layers.flatMap(({ indexPattern }) => (indexPattern ? [indexPattern] : []))
    )
  ),
];
