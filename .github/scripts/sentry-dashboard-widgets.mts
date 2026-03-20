export interface SentryDashboardQuery {
  name: string;
  fields: string[];
  aggregates: string[];
  columns: string[];
  fieldAliases: string[];
  conditions: string;
  orderby: string;
  limit?: number;
  isHidden: boolean;
}

export interface SentryDashboardWidget {
  title: string;
  displayType: 'table' | 'line' | 'area' | 'bar' | 'categorical_bar';
  interval: '5m' | '15m' | '1h' | '1d';
  limit?: number;
  datasetSource: 'user';
  widgetType: 'logs';
  queries: SentryDashboardQuery[];
  layout: {
    w: number;
    h: number;
    x: number;
    y: number;
    minH: number;
  };
}

export interface SentryDashboardPayload {
  title: string;
  widgets: SentryDashboardWidget[];
  projects: number[];
  period: string;
  environment: string[];
  filters: Record<string, string>;
  utc: boolean;
}

interface WidgetSpec {
  title: string;
  conditions: string;
  displayType?: SentryDashboardWidget['displayType'];
  interval?: SentryDashboardWidget['interval'];
  orderby?: string;
  columns?: string[];
  fieldAliases?: string[];
  limit?: number;
  y: number;
  x?: number;
  w?: number;
  h?: number;
}

function logWidget({
  title,
  displayType = 'table',
  interval = '5m',
  conditions,
  orderby = '-count()',
  columns = ['count()'],
  fieldAliases,
  limit,
  y,
  x = 0,
  w = 2,
  h = 2,
}: WidgetSpec): SentryDashboardWidget {
  return {
    title,
    displayType,
    interval,
    ...(limit !== undefined ? { limit } : {}),
    datasetSource: 'user',
    widgetType: 'logs',
    queries: [
      {
        name: '',
        fields: columns,
        aggregates: columns.filter((column) => column.includes('(')),
        columns: columns.filter((column) => !column.includes('(')),
        fieldAliases: fieldAliases ?? columns.map(() => ''),
        conditions,
        orderby,
        ...(limit !== undefined ? { limit } : {}),
        isHidden: false,
      },
    ],
    layout: {
      w,
      h,
      x,
      y,
      minH: 2,
    },
  };
}

function tableWidget(spec: WidgetSpec): SentryDashboardWidget {
  return logWidget({
    ...spec,
    displayType: 'table',
  });
}

function graphWidget(spec: WidgetSpec): SentryDashboardWidget {
  return logWidget({
    interval: '1d',
    ...spec,
    limit: spec.limit ?? 10,
  });
}

function stackedBarWidget({
  title,
  queries,
  y,
  x = 0,
  w = 6,
  h = 2,
}: {
  title: string;
  queries: { name: string; conditions: string }[];
  y: number;
  x?: number;
  w?: number;
  h?: number;
}): SentryDashboardWidget {
  return {
    title,
    displayType: 'area',
    interval: '1d',
    datasetSource: 'user',
    widgetType: 'logs',
    queries: queries.map(({ name, conditions }) => ({
      name,
      fields: ['count_unique(ci.retry.runId)'],
      aggregates: ['count_unique(ci.retry.runId)'],
      columns: [],
      fieldAliases: [''],
      conditions,
      orderby: '-count_unique(ci.retry.runId)',
      isHidden: false,
    })),
    layout: { w, h, x, y, minH: 2 },
  };
}

function categoricalDistributionWidget({
  groupBy,
  orderby = `-${groupBy}`,
  ...spec
}: WidgetSpec & { groupBy: string }): SentryDashboardWidget {
  return logWidget({
    ...spec,
    displayType: 'categorical_bar',
    columns: [groupBy, 'count_unique(ci.retry.runId)'],
    orderby,
    limit: spec.limit ?? 10,
  });
}

export function buildCiRetryDashboardPayload({
  title,
  projectId,
  period = '14d',
}: {
  title: string;
  projectId: number;
  period?: string;
}): SentryDashboardPayload {
  const baseCondition = 'has:ci.retry.runId has:ci.retry.date';
  const jobCondition =
    'has:ci.retry.runId has:ci.retry.date has:ci.job.name !ci.job.name:"CI status gate (controls all-jobs-pass)"';

  return {
    title,
    projects: [projectId],
    period,
    environment: [],
    filters: {},
    utc: true,
    widgets: [
      tableWidget({
        title: 'Decision Distribution',
        conditions: `${baseCondition} has:ci.retry.decision`,
        columns: ['count_unique(ci.retry.runId)', 'ci.retry.decision'],
        fieldAliases: ['Count', 'Decision'],
        orderby: 'ci.retry.decision',
        y: 0,
        x: 0,
      }),
      tableWidget({
        title: 'Retry Usage (Label-Gated)',
        conditions: `${baseCondition} has:ci.retry.willRetry has:ci.retry.hasRetryLabel`,
        columns: ['count()', 'ci.retry.willRetry', 'ci.retry.hasRetryLabel'],
        fieldAliases: ['Count', 'Will Retry', 'Has Retry Label'],
        orderby: '-count()',
        y: 0,
        x: 2,
      }),
      tableWidget({
        title: 'Unmatched Failures ("No results" = healthy)',
        conditions: `${baseCondition} has:ci.retry.unmatchedJobCount`,
        columns: ['count()', 'ci.retry.unmatchedJobCount', 'ci.retry.runId'],
        fieldAliases: ['Count', 'Unmatched Job Count', 'Run ID'],
        orderby: '-ci.retry.unmatchedJobCount',
        y: 0,
        x: 4,
      }),
      tableWidget({
        title: 'Flakiest Jobs (Retryable)',
        conditions: `${jobCondition} ci.job.retryable:true`,
        columns: ['count()', 'ci.job.name', 'ci.job.category'],
        fieldAliases: ['Count', 'Job Name', 'Job Category'],
        orderby: '-count()',
        y: 2,
        x: 0,
      }),
      tableWidget({
        title: 'Deterministic Failures (Non-Retryable)',
        conditions: `${jobCondition} ci.job.retryable:false`,
        columns: ['count()', 'ci.job.name', 'ci.job.category', 'ci.job.reason'],
        fieldAliases: ['Count', 'Job Name', 'Job Category', 'Failure Reason'],
        orderby: '-count()',
        y: 2,
        x: 2,
      }),
      tableWidget({
        title: 'Failure Categories',
        conditions: `${jobCondition} has:ci.job.category`,
        columns: ['count()', 'ci.job.category'],
        fieldAliases: ['Count', 'Job Category'],
        orderby: '-count()',
        y: 2,
        x: 4,
      }),
      categoricalDistributionWidget({
        title: 'Failures by Workflow Event',
        groupBy: 'ci.retry.event',
        conditions: `${baseCondition} has:ci.retry.event`,
        y: 4,
        x: 0,
      }),
      categoricalDistributionWidget({
        title: 'Attempt Depth Distribution',
        groupBy: 'ci.retry.attempt',
        conditions: `${baseCondition} has:ci.retry.attempt`,
        orderby: '-count_unique(ci.retry.runId)',
        y: 4,
        x: 2,
      }),
      tableWidget({
        title: 'Cascade Blockers',
        conditions: `${baseCondition} has:ci.blockedBy`,
        columns: ['count()', 'ci.blockedBy'],
        fieldAliases: ['Count', 'Blocked By'],
        orderby: '-count()',
        y: 4,
        x: 4,
      }),
      tableWidget({
        title: 'Most Recent Decisions',
        conditions: `${baseCondition} has:ci.retry.decision has:ci.retry.jobDrilldownUrl`,
        columns: [
          'timestamp',
          'ci.retry.decision',
          'ci.retry.event',
          'ci.retry.runId',
          'ci.retry.jobDrilldownUrl',
          'ci.prNumber',
          'ci.targetBranch',
        ],
        fieldAliases: [
          'Timestamp',
          'Decision',
          'Workflow Event',
          'Run ID',
          'Job Drilldown URL',
          'PR Number',
          'Target Branch',
        ],
        orderby: '-timestamp',
        y: 6,
        x: 0,
        w: 6,
        h: 3,
      }),
      graphWidget({
        title: 'Unmatched Runs Trend',
        displayType: 'line',
        conditions: `${baseCondition} ci.retry.hasUnmatched:true`,
        columns: ['count_unique(ci.retry.runId)'],
        orderby: '-count_unique(ci.retry.runId)',
        y: 9,
        x: 0,
        w: 3,
      }),
      graphWidget({
        title: 'Cascade Blocker Runs Trend',
        displayType: 'line',
        conditions: `${baseCondition} has:ci.blockedBy`,
        columns: ['count_unique(ci.retry.runId)'],
        orderby: '-count_unique(ci.retry.runId)',
        y: 9,
        x: 3,
        w: 3,
      }),
      stackedBarWidget({
        title: 'Decision Actionability Trend',
        queries: [
          'will-retry',
          'retryable-no-label',
          'not-retryable-has-label',
          'not-retryable-no-label',
        ].map((decision) => ({
          name: decision,
          conditions: `${baseCondition} ci.retry.decision:${decision}`,
        })),
        y: 11,
        x: 0,
        w: 6,
        h: 2,
      }),
      stackedBarWidget({
        title: 'Decision Trend (Stacked)',
        queries: [
          'will-retry',
          'retryable-no-label',
          'retryable-no-pr',
          'not-retryable-has-label',
          'not-retryable-no-label',
          'not-retryable-no-pr',
        ].map((decision) => ({
          name: decision,
          conditions: `${baseCondition} ci.retry.decision:${decision}`,
        })),
        y: 13,
        x: 0,
        w: 6,
        h: 3,
      }),
    ],
  };
}
