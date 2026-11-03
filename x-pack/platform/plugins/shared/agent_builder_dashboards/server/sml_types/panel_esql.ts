/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/**
 * Turns the panels of a dashboard, as the dashboard API returns them (`config` in the as-code Lens
 * shape), into ES|QL an agent can run to get the same numbers: one query per data layer, with the
 * panel's or the dashboard's time range, the dashboard query, and the panel's metrics and
 * breakdowns. What ES|QL can't express (a time shift, a moving average) is left out and noted.
 */

type Loose = Record<string, unknown>;

/** Where a panel layer reads its data. */
export interface PanelDataSource {
  indexPattern: string;
  timeField?: string;
}

/** Resolves a data view reference (`ref_id`) to its index pattern and time field. */
export type ResolveDataView = (refId: string) => Promise<PanelDataSource | undefined>;

export interface TimeRange {
  from: string;
  to: string;
}

export interface DashboardQueryContext {
  timeRange?: TimeRange;
  /** The dashboard's KQL or Lucene query. */
  query?: { expression?: string; language?: string };
  /** How many dashboard filters there are; they aren't translated. */
  filterCount?: number;
}

export interface PanelLayerQuery {
  /** The ES|QL for this layer, or none when it couldn't be built. */
  esql?: string;
  /** Set when the query reads a shifted time range, for metrics such as "last week". */
  shiftedTimeRange?: TimeRange;
  indexPattern?: string;
  timeField?: string;
  /** Human-readable metrics and breakdowns, such as `Sum of revenue: sum(taxful_total_price)`. */
  dimensions: string[];
  /** What the query leaves out or approximates. */
  notes: string[];
}

export interface PanelSummary {
  id?: string;
  title?: string;
  /** The embeddable type, such as `vis` or `discover_session`. */
  panelType: string;
  /** The chart type for a visualization, such as `metric` or `xy`. */
  chartType?: string;
  /** The section the panel sits in, if any. */
  section?: string;
  timeRange?: TimeRange;
  layers: PanelLayerQuery[];
}

const isObject = (value: unknown): value is Loose =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

/** A field or alias name, in backticks unless it is a plain dotted name. */
export const quoteName = (name: string): string =>
  /^[A-Za-z_@][\w.@]*$/.test(name) ? name : `\`${name.replace(/`/g, '``')}\``;

const quoteString = (value: string): string => JSON.stringify(value);

const DATE_MATH_UNITS: Record<string, { word: string; ms: number }> = {
  s: { word: 'seconds', ms: 1000 },
  m: { word: 'minutes', ms: 60_000 },
  h: { word: 'hours', ms: 3_600_000 },
  d: { word: 'days', ms: 86_400_000 },
  w: { word: 'weeks', ms: 604_800_000 },
  M: { word: 'months', ms: 2_592_000_000 },
  y: { word: 'years', ms: 31_536_000_000 },
};

const RELATIVE_DATE = /^now(?:([+-])(\d+)([smhdwMy]))?(?:\/[smhdwMy])?$/;

/** A date-math bound as an ES|QL expression, and its offset from now in ms when relative. */
const dateBound = (value: string): { esql: string; offsetMs?: number } | undefined => {
  const relative = RELATIVE_DATE.exec(value.trim());
  if (relative) {
    const [, sign, amount, unit] = relative;
    if (!sign) {
      return { esql: 'NOW()', offsetMs: 0 };
    }
    const { word, ms } = DATE_MATH_UNITS[unit];
    return {
      esql: `NOW() ${sign} ${amount} ${word}`,
      offsetMs: (sign === '-' ? -1 : 1) * Number(amount) * ms,
    };
  }
  return Number.isNaN(Date.parse(value))
    ? undefined
    : { esql: `TO_DATETIME(${quoteString(value)})`, offsetMs: undefined };
};

/** The length of a time range in ms, when both ends are relative to now or absolute. */
export const timeRangeMs = (range: TimeRange | undefined): number | undefined => {
  if (!range) {
    return undefined;
  }
  const from = dateBound(range.from);
  const to = dateBound(range.to);
  if (from?.offsetMs !== undefined && to?.offsetMs !== undefined) {
    return to.offsetMs - from.offsetMs;
  }
  const fromMs = Date.parse(range.from);
  const toMs = Date.parse(range.to);
  return Number.isNaN(fromMs) || Number.isNaN(toMs) ? undefined : toMs - fromMs;
};

const SHIFT = /^(\d+)([smhdwMy])$/;

/** How far back a Lens time shift (`1w`, `previous`) moves the range, in ms. */
const shiftMs = (shift: string, rangeMs: number | undefined): number | undefined => {
  if (shift === 'previous') {
    return rangeMs;
  }
  const match = SHIFT.exec(shift);
  return match ? Number(match[1]) * DATE_MATH_UNITS[match[2]].ms : undefined;
};

const EXACT_UNITS: Array<[string, number]> = [
  ['d', 86_400_000],
  ['h', 3_600_000],
  ['m', 60_000],
  ['s', 1000],
];

/** A bound moved `ms` earlier, as date math or an ISO date. */
const shiftBound = (value: string, ms: number): string | undefined => {
  const bound = dateBound(value);
  if (bound?.offsetMs !== undefined) {
    const offset = bound.offsetMs - ms;
    if (offset === 0) {
      return 'now';
    }
    const [unit, unitMs] = EXACT_UNITS.find(([, size]) => offset % size === 0) ?? ['s', 1000];
    return `now${offset < 0 ? '-' : '+'}${Math.abs(offset / unitMs)}${unit}`;
  }
  const absolute = Date.parse(value);
  return Number.isNaN(absolute) ? undefined : new Date(absolute - ms).toISOString();
};

/** The time range a shifted metric reads. */
export const shiftTimeRange = (range: TimeRange, shift: string): TimeRange | undefined => {
  const ms = shiftMs(shift, timeRangeMs(range));
  if (ms === undefined) {
    return undefined;
  }
  const from = shiftBound(range.from, ms);
  const to = shiftBound(range.to, ms);
  return from && to ? { from, to } : undefined;
};

const timeCondition = (timeField: string, range: TimeRange): string | undefined => {
  const from = dateBound(range.from);
  const to = dateBound(range.to);
  if (!from || !to) {
    return undefined;
  }
  const field = quoteName(timeField);
  return `${field} >= ${from.esql} AND ${field} <= ${to.esql}`;
};

/** A KQL or Lucene query as an ES|QL condition. */
const searchCondition = (query: unknown): string | undefined => {
  if (!isObject(query)) {
    return undefined;
  }
  const expression = asString(query.expression) ?? asString(query.query);
  if (!expression) {
    return undefined;
  }
  return query.language === 'lucene'
    ? `QSTR(${quoteString(expression)})`
    : `KQL(${quoteString(expression)})`;
};

const INTERVALS: Array<{ ms: number; esql: string }> = [
  { ms: 60_000, esql: '1 minute' },
  { ms: 300_000, esql: '5 minutes' },
  { ms: 600_000, esql: '10 minutes' },
  { ms: 1_800_000, esql: '30 minutes' },
  { ms: 3_600_000, esql: '1 hour' },
  { ms: 10_800_000, esql: '3 hours' },
  { ms: 43_200_000, esql: '12 hours' },
  { ms: 86_400_000, esql: '1 day' },
  { ms: 604_800_000, esql: '1 week' },
  { ms: 2_592_000_000, esql: '1 month' },
  { ms: 31_536_000_000, esql: '1 year' },
];

/** About 75 buckets over the range, as Lens's automatic interval does. */
const AUTO_BUCKETS = 75;

const dateInterval = (suggested: unknown, rangeMs: number | undefined): string => {
  const explicit = typeof suggested === 'string' ? /^(\d+)([smhdwMy])$/.exec(suggested) : null;
  if (explicit) {
    const [, amount, unit] = explicit;
    const { word } = DATE_MATH_UNITS[unit];
    return `${amount} ${Number(amount) === 1 ? word.replace(/s$/, '') : word}`;
  }
  const target = rangeMs !== undefined ? rangeMs / AUTO_BUCKETS : 86_400_000;
  return (INTERVALS.find(({ ms }) => ms >= target) ?? INTERVALS[INTERVALS.length - 1]).esql;
};

const FIELD_AGGREGATIONS: Record<string, string> = {
  sum: 'SUM',
  average: 'AVG',
  min: 'MIN',
  max: 'MAX',
  median: 'MEDIAN',
  standard_deviation: 'STD_DEV',
  unique_count: 'COUNT_DISTINCT',
};

const BUCKET_OPERATIONS = new Set(['date_histogram', 'terms', 'histogram', 'range', 'filters']);

interface BuiltMetric {
  alias: string;
  expression?: string;
  description: string;
  notes: string[];
}

class Unsupported extends Error {}

/** Translates a Lens formula to an ES|QL aggregation expression. */
export const formulaToEsql = (formula: string, rangeMs: number | undefined): string => {
  let expression = formula.replace(/\btime_range\(\)/g, () => {
    if (rangeMs === undefined) {
      throw new Unsupported('time_range() needs a known time range');
    }
    return `${rangeMs}.0`;
  });
  expression = expression.replace(
    /\b([a-z_]+)\(([^()]*)\)/g,
    (match, name: string, args: string) => {
      const parts = args
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
      const named = parts.filter((part) => part.includes('='));
      const positional = parts.filter((part) => !part.includes('='));
      const namedArgs = Object.fromEntries(
        named.map((part) => {
          const [key, ...rest] = part.split('=');
          return [
            key.trim(),
            rest
              .join('=')
              .trim()
              .replace(/^['"]|['"]$/g, ''),
          ];
        })
      );
      if (namedArgs.shift !== undefined) {
        throw new Unsupported(`a time shift (${match})`);
      }
      if (namedArgs.kql !== undefined || namedArgs.lucene !== undefined) {
        throw new Unsupported(`a filter inside a formula (${match})`);
      }
      const [field] = positional;
      if (name === 'count') {
        return field ? `COUNT(${quoteName(field)})` : 'COUNT(*)';
      }
      if (name === 'percentile' && field) {
        return `PERCENTILE(${quoteName(field)}, ${namedArgs.percentile ?? 50})`;
      }
      const aggregation = FIELD_AGGREGATIONS[name];
      if (aggregation && field) {
        return `${aggregation}(${quoteName(field)})`;
      }
      throw new Unsupported(`${name}()`);
    }
  );
  if (/\b[a-z_]+\(/.test(expression)) {
    throw new Unsupported(`part of the formula: ${formula}`);
  }
  return expression;
};

const defaultLabel = (metric: Loose): string => {
  const operation = String(metric.operation);
  const field = asString(metric.field);
  if (operation === 'formula') {
    return asString(metric.formula) ?? 'formula';
  }
  return field ? `${operation}(${field})` : `${operation}()`;
};

const buildMetric = (metric: Loose, index: number, rangeMs: number | undefined): BuiltMetric => {
  const operation = String(metric.operation);
  const label = asString(metric.label);
  const description = `${label ? `${label}: ` : ''}${defaultLabel(metric)}`;
  const field0 = asString(metric.field);
  const alias =
    label ??
    (operation === 'formula' ? `formula_${index}` : field0 ? `${operation}_${field0}` : operation);
  const notes: string[] = [];
  const field = asString(metric.field);
  let expression: string | undefined;
  try {
    if (operation === 'count') {
      expression = field ? `COUNT(${quoteName(field)})` : 'COUNT(*)';
    } else if (operation === 'percentile' && field) {
      expression = `PERCENTILE(${quoteName(field)}, ${metric.percentile ?? 50})`;
    } else if (FIELD_AGGREGATIONS[operation] && field) {
      expression = `${FIELD_AGGREGATIONS[operation]}(${quoteName(field)})`;
    } else if (operation === 'formula' && asString(metric.formula)) {
      expression = formulaToEsql(String(metric.formula), rangeMs);
    } else if (operation === 'static_value') {
      notes.push(`"${alias}" is the constant ${metric.value}.`);
    } else {
      throw new Unsupported(`the ${operation} operation`);
    }
  } catch (error) {
    if (!(error instanceof Unsupported)) {
      throw error;
    }
    notes.push(`"${alias}" is left out: ES|QL can't express ${error.message}.`);
    expression = undefined;
  }
  const filter = searchCondition(metric.filter);
  if (expression && filter) {
    expression = `${expression} WHERE ${filter}`;
  }
  return { alias, expression, description, notes };
};

interface BuiltBucket {
  alias: string;
  /** The `BY` term. */
  by?: string;
  description: string;
  sort?: string;
  limit?: number;
  notes: string[];
}

const buildBucket = (
  bucket: Loose,
  metrics: BuiltMetric[],
  rangeMs: number | undefined,
  isNested: boolean
): BuiltBucket => {
  const operation = String(bucket.operation);
  const label = asString(bucket.label);
  const notes: string[] = [];
  if (operation === 'date_histogram' && asString(bucket.field)) {
    const field = String(bucket.field);
    const interval = dateInterval(bucket.suggested_interval, rangeMs);
    const alias = label ?? field;
    return {
      alias,
      by: `${quoteName(alias)} = DATE_TRUNC(${interval}, ${quoteName(field)})`,
      description: `${alias}: ${field} per ${interval}`,
      sort: `${quoteName(alias)} ASC`,
      notes,
    };
  }
  if (operation === 'terms') {
    const fields = (Array.isArray(bucket.fields) ? bucket.fields : [bucket.field]).filter(
      (field): field is string => typeof field === 'string'
    );
    const limit = typeof bucket.limit === 'number' ? bucket.limit : undefined;
    const rankBy = isObject(bucket.rank_by) ? bucket.rank_by : undefined;
    const ranked =
      rankBy?.type === 'metric' && typeof rankBy.metric_index === 'number'
        ? metrics[rankBy.metric_index]
        : undefined;
    const direction = rankBy?.direction === 'asc' ? 'ASC' : 'DESC';
    if (isNested && limit !== undefined) {
      notes.push(
        `Lens keeps the top ${limit} ${fields.join(', ')} values; this query returns every value.`
      );
    }
    if (isObject(bucket.other_bucket)) {
      notes.push('Lens groups the remaining values as "Other"; this query does not.');
    }
    return {
      alias: label ?? fields.join(', '),
      by: fields.map(quoteName).join(', '),
      description: `${label ? `${label}: ` : ''}top ${limit ?? ''} ${fields.join(', ')}`.replace(
        /\s+/g,
        ' '
      ),
      ...(ranked?.expression && { sort: `${quoteName(ranked.alias)} ${direction}` }),
      ...(rankBy?.type === 'alphabetical' && {
        sort: `${quoteName(fields[0])} ${direction}`,
      }),
      ...(!isNested && limit !== undefined && { limit }),
      notes,
    };
  }
  if (
    operation === 'histogram' &&
    asString(bucket.field) &&
    typeof bucket.granularity === 'number'
  ) {
    const field = String(bucket.field);
    const alias = label ?? field;
    return {
      alias,
      by: `${quoteName(alias)} = BUCKET(${quoteName(field)}, ${bucket.granularity})`,
      description: `${alias}: ${field} in steps of ${bucket.granularity}`,
      sort: `${quoteName(alias)} ASC`,
      notes,
    };
  }
  if (operation === 'range' && asString(bucket.field) && Array.isArray(bucket.ranges)) {
    const field = quoteName(String(bucket.field));
    const alias = label ?? String(bucket.field);
    const cases = bucket.ranges.filter(isObject).map((range) => {
      const conditions = [
        typeof range.gte === 'number' ? `${field} >= ${range.gte}` : undefined,
        typeof range.lt === 'number' ? `${field} < ${range.lt}` : undefined,
      ].filter(Boolean);
      const name = asString(range.label) ?? `${range.gte ?? '-∞'} - ${range.lt ?? '+∞'}`;
      return `${conditions.join(' AND ') || 'true'}, ${quoteString(name)}`;
    });
    return {
      alias,
      by: `${quoteName(alias)} = CASE(${cases.join(', ')})`,
      description: `${alias}: ranges of ${bucket.field}`,
      notes,
    };
  }
  notes.push(
    `The "${label ?? operation}" breakdown is left out: ES|QL can't group by ${operation}.`
  );
  return { alias: label ?? operation, description: label ?? operation, notes };
};

/** The metrics and buckets of a layer, in the order Lens shows them. */
const dimensionsOf = (layer: Loose): { metrics: Loose[]; buckets: Loose[] } => {
  const metrics: Loose[] = [];
  const buckets: Loose[] = [];
  for (const [key, value] of Object.entries(layer)) {
    if (key === 'data_source' || key === 'filters') {
      continue;
    }
    for (const item of Array.isArray(value) ? value : [value]) {
      if (!isObject(item) || typeof item.operation !== 'string') {
        continue;
      }
      (BUCKET_OPERATIONS.has(item.operation) ? buckets : metrics).push(item);
    }
  }
  // Time first, so a breakdown nests inside it as Lens draws it.
  buckets.sort(
    (a, b) => Number(b.operation === 'date_histogram') - Number(a.operation === 'date_histogram')
  );
  return { metrics, buckets };
};

const resolveSource = async (
  dataSource: unknown,
  resolveDataView: ResolveDataView
): Promise<PanelDataSource | { esql: string } | undefined> => {
  if (!isObject(dataSource)) {
    return undefined;
  }
  if (dataSource.type === 'esql' && asString(dataSource.query)) {
    return { esql: String(dataSource.query) };
  }
  if (asString(dataSource.ref_id)) {
    return resolveDataView(String(dataSource.ref_id));
  }
  const indexPattern = asString(dataSource.index_pattern) ?? asString(dataSource.index);
  return indexPattern
    ? {
        indexPattern,
        ...(asString(dataSource.time_field) && { timeField: String(dataSource.time_field) }),
      }
    : undefined;
};

const NON_DATA_LAYER_TYPES = new Set(['annotations', 'annotation_group', 'reference_lines']);

interface QueryParts {
  source: PanelDataSource;
  timeRange?: TimeRange;
  context: DashboardQueryContext & { ignoreGlobalFilters: boolean };
  layer: Loose;
  metrics: BuiltMetric[];
  buckets: BuiltBucket[];
  notes: string[];
}

const assembleQuery = ({
  source,
  timeRange,
  context,
  layer,
  metrics,
  buckets,
  notes,
}: QueryParts): string => {
  const where: string[] = [];
  if (source.timeField && timeRange) {
    const condition = timeCondition(source.timeField, timeRange);
    if (condition) {
      where.push(condition);
    }
  }
  if (!context.ignoreGlobalFilters) {
    const search = searchCondition(context.query);
    if (search) {
      where.push(search);
    }
    if (context.filterCount) {
      notes.push(`The dashboard's ${context.filterCount} filter(s) are not included.`);
    }
  }
  const layerFilter = searchCondition(layer.filter ?? layer.query);
  if (layerFilter) {
    where.push(layerFilter);
  }

  const aliases = new Set(metrics.map(({ alias }) => quoteName(alias)));
  const stats = metrics.map((metric) => `${quoteName(metric.alias)} = ${metric.expression}`);
  const by = buckets.flatMap((bucket) => (bucket.by ? [bucket.by] : []));
  const sortable = buckets.filter(
    (bucket) => bucket.sort && (!bucket.limit || aliases.has(bucket.sort.split(' ')[0]))
  );
  const sort = (sortable.find((bucket) => bucket.limit !== undefined) ?? sortable[0])?.sort;
  const limit = buckets.find((bucket) => bucket.limit !== undefined)?.limit;

  const lines = [`FROM ${source.indexPattern}`];
  if (where.length > 0) {
    lines.push(`| WHERE ${where.join(' AND ')}`);
  }
  lines.push(
    `| STATS ${stats.length > 0 ? stats.join(', ') : '`count` = COUNT(*)'}${
      by.length > 0 ? ` BY ${by.join(', ')}` : ''
    }`
  );
  if (sort) {
    lines.push(`| SORT ${sort}`);
  }
  if (limit !== undefined) {
    lines.push(`| LIMIT ${limit}`);
  }
  return lines.join('\n');
};

/**
 * The queries for one data layer: one for its metrics over the panel's time range, and one more
 * for each time shift, since a shifted metric reads another range.
 */
const buildLayerQueries = async (
  layer: Loose,
  dataSource: unknown,
  context: DashboardQueryContext & { ignoreGlobalFilters: boolean },
  resolveDataView: ResolveDataView
): Promise<PanelLayerQuery[]> => {
  const { metrics: metricConfigs, buckets: bucketConfigs } = dimensionsOf(layer);
  if (metricConfigs.length === 0 && bucketConfigs.length === 0) {
    return [];
  }
  const source = await resolveSource(dataSource, resolveDataView);
  const rangeMs = timeRangeMs(context.timeRange);
  const metrics = metricConfigs.map((metric, index) => buildMetric(metric, index, rangeMs));
  const buckets = bucketConfigs.map((bucket, index) =>
    buildBucket(bucket, metrics, rangeMs, index > 0 || bucketConfigs.length > 1)
  );
  const notes = [...metrics, ...buckets].flatMap((dimension) => dimension.notes);
  const dimensions = [...metrics, ...buckets].map(({ description }) => description);

  if (!source) {
    return [{ dimensions, notes: [...notes, 'Its data source could not be resolved.'] }];
  }
  if ('esql' in source) {
    return [{ esql: source.esql, dimensions, notes }];
  }

  const shiftOf = (index: number) => asString(metricConfigs[index].time_shift) ?? '';
  const shifts = [...new Set(metricConfigs.map((_, index) => shiftOf(index)))];
  const queries: PanelLayerQuery[] = [];
  for (const shift of shifts.length > 0 ? shifts : ['']) {
    const inGroup = metrics.filter(
      (metric, index) => metric.expression && shiftOf(index) === shift
    );
    if (metrics.length > 0 && inGroup.length === 0) {
      continue;
    }
    const groupNotes = queries.length === 0 ? notes : [];
    let timeRange = context.timeRange;
    if (shift) {
      const shifted = context.timeRange ? shiftTimeRange(context.timeRange, shift) : undefined;
      if (!shifted) {
        notes.push(
          `${inGroup
            .map(({ alias }) => `"${alias}"`)
            .join(', ')} is left out: its time shift (${shift}) can't be applied.`
        );
        continue;
      }
      timeRange = shifted;
    }
    queries.push({
      esql: assembleQuery({
        source,
        timeRange,
        context,
        layer,
        metrics: inGroup,
        buckets,
        notes: groupNotes,
      }),
      ...(shift && timeRange && { shiftedTimeRange: timeRange }),
      indexPattern: source.indexPattern,
      ...(source.timeField && { timeField: source.timeField }),
      dimensions: shift
        ? [
            ...inGroup.map(({ description }) => description),
            ...buckets.map(({ description }) => description),
          ]
        : dimensions.filter(
            (description) =>
              !metrics.some(
                (metric, index) => shiftOf(index) !== '' && metric.description === description
              )
          ),
      notes: shift
        ? [
            `Shifted back ${shift}: these metrics compare against ${timeRange?.from} to ${timeRange?.to}.`,
          ]
        : groupNotes,
    });
  }
  return queries;
};

const panelTitle = (config: Loose): string | undefined =>
  asString(config.title) ??
  (isObject(config.attributes) ? asString(config.attributes.title) : undefined);

/** One panel of a dashboard, with a query per data layer. */
export const summarizePanel = async (
  panel: Loose,
  dashboard: DashboardQueryContext,
  resolveDataView: ResolveDataView,
  section?: string
): Promise<PanelSummary> => {
  const config = isObject(panel.config) ? panel.config : {};
  const panelType = String(panel.type ?? 'unknown');
  const timeRange =
    isObject(config.time_range) &&
    asString(config.time_range.from) &&
    asString(config.time_range.to)
      ? { from: String(config.time_range.from), to: String(config.time_range.to) }
      : dashboard.timeRange;
  const summary: PanelSummary = {
    ...(asString(panel.id) && { id: String(panel.id) }),
    ...(panelTitle(config) && { title: panelTitle(config) }),
    panelType,
    ...(asString(config.type) && { chartType: String(config.type) }),
    ...(section && { section }),
    ...(timeRange && { timeRange }),
    layers: [],
  };
  if (panelType !== 'vis' && panelType !== 'lens') {
    return summary;
  }
  const context = {
    ...dashboard,
    timeRange,
    ignoreGlobalFilters: config.ignore_global_filters === true,
  };
  const layers = Array.isArray(config.layers)
    ? config.layers.filter(
        (layer): layer is Loose => isObject(layer) && !NON_DATA_LAYER_TYPES.has(String(layer.type))
      )
    : [config];
  for (const layer of layers) {
    summary.layers.push(
      ...(await buildLayerQueries(
        layer,
        layer.data_source ?? config.data_source,
        context,
        resolveDataView
      ))
    );
  }
  return summary;
};

/** Every panel of a dashboard, sections included, in order. */
export const summarizePanels = async (
  panels: unknown[],
  dashboard: DashboardQueryContext,
  resolveDataView: ResolveDataView
): Promise<PanelSummary[]> => {
  const summaries: PanelSummary[] = [];
  for (const panel of panels) {
    if (!isObject(panel)) {
      continue;
    }
    if (Array.isArray(panel.panels)) {
      for (const inner of panel.panels) {
        if (isObject(inner)) {
          summaries.push(
            await summarizePanel(inner, dashboard, resolveDataView, asString(panel.title))
          );
        }
      }
      continue;
    }
    summaries.push(await summarizePanel(panel, dashboard, resolveDataView));
  }
  return summaries;
};

/** A panel as markdown: what it shows, then its queries in `esql` blocks. */
export const renderPanel = (summary: PanelSummary): string => {
  const heading = `### ${summary.title ?? `Untitled ${summary.panelType} panel`} (${
    summary.chartType ?? summary.panelType
  })`;
  const lines = [heading];
  if (summary.section) {
    lines.push(`Section: ${summary.section}`);
  }
  if (summary.timeRange) {
    lines.push(`Time range: ${summary.timeRange.from} to ${summary.timeRange.to}`);
  }
  for (const layer of summary.layers) {
    if (layer.shiftedTimeRange) {
      lines.push(`Compared with: ${layer.shiftedTimeRange.from} to ${layer.shiftedTimeRange.to}`);
    }
    if (layer.indexPattern) {
      lines.push(
        `Data: ${layer.indexPattern}${layer.timeField ? ` (time field ${layer.timeField})` : ''}`
      );
    }
    lines.push(...layer.dimensions.map((dimension) => `- ${dimension}`));
    if (layer.esql) {
      lines.push('```esql', layer.esql, '```');
    }
    lines.push(...layer.notes.map((note) => `Note: ${note}`));
  }
  return lines.join('\n');
};
