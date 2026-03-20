export interface SentryDashboardQuery {
  name: string;
  fields: string[];
  aggregates: string[];
  columns: string[];
  fieldAliases: string[];
  conditions: string;
  orderby: string;
  isHidden: boolean;
}

export interface SentryDashboardWidget {
  title: string;
  displayType: 'table';
  interval: '5m';
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
  orderby?: string;
  columns?: string[];
  y: number;
  x?: number;
  w?: number;
  h?: number;
}

function tableWidget({
  title,
  conditions,
  orderby = '-count()',
  columns = ['count()'],
  y,
  x = 0,
  w = 2,
  h = 2,
}: WidgetSpec): SentryDashboardWidget {
  return {
    title,
    displayType: 'table',
    interval: '5m',
    datasetSource: 'user',
    widgetType: 'logs',
    queries: [
      {
        name: '',
        fields: columns,
        aggregates: columns.filter((column) => column.includes('(')),
        columns: columns.filter((column) => !column.includes('(')),
        fieldAliases: columns.map(() => ''),
        conditions,
        orderby,
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

export function buildCiRetryDashboardPayload({
  title,
  projectId,
  period = '14d',
}: {
  title: string;
  projectId: number;
  period?: string;
}): SentryDashboardPayload {
  const baseCondition = 'has:ci.retry.runId';
  const jobCondition = 'has:ci.retry.runId has:ci.job.name';

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
        columns: ['count()', 'ci.retry.decision'],
        orderby: '-count()',
        y: 0,
        x: 0,
      }),
      tableWidget({
        title: 'Retry Usage (Label-Gated)',
        conditions: `${baseCondition} has:ci.retry.willRetry`,
        columns: [
          'count()',
          'ci.retry.willRetryState',
          'ci.retry.hasRetryLabelState',
        ],
        orderby: '-count()',
        y: 0,
        x: 2,
      }),
      tableWidget({
        title: 'Unmatched Job Signals',
        conditions: `${baseCondition} ci.retry.unmatchedJobCount:>0`,
        columns: ['count()', 'ci.retry.unmatchedJobCount', 'ci.retry.runId'],
        orderby: '-ci.retry.unmatchedJobCount',
        y: 0,
        x: 4,
      }),
      tableWidget({
        title: 'Flakiest Jobs (Retryable)',
        conditions: `${jobCondition} ci.job.retryableState:true`,
        columns: ['count()', 'ci.job.name', 'ci.job.category'],
        orderby: '-count()',
        y: 2,
        x: 0,
      }),
      tableWidget({
        title: 'Deterministic Failures (Non-Retryable)',
        conditions: `${jobCondition} ci.job.retryableState:false`,
        columns: ['count()', 'ci.job.name', 'ci.job.category', 'ci.job.reason'],
        orderby: '-count()',
        y: 2,
        x: 2,
      }),
      tableWidget({
        title: 'Failure Categories',
        conditions: `${jobCondition} has:ci.job.category`,
        columns: ['count()', 'ci.job.category'],
        orderby: '-count()',
        y: 2,
        x: 4,
      }),
      tableWidget({
        title: 'Failures by Workflow Event',
        conditions: `${baseCondition} has:ci.retry.event`,
        columns: ['count()', 'ci.retry.event'],
        orderby: '-count()',
        y: 4,
        x: 0,
      }),
      tableWidget({
        title: 'Attempt Depth Distribution',
        conditions: `${baseCondition} has:ci.retry.attempt`,
        columns: ['count()', 'ci.retry.attempt'],
        orderby: '-count()',
        y: 4,
        x: 2,
      }),
      tableWidget({
        title: 'Cascade Blockers',
        conditions: `${baseCondition} has:ci.blockedBy`,
        columns: ['count()', 'ci.blockedBy'],
        orderby: '-count()',
        y: 4,
        x: 4,
      }),
      tableWidget({
        title: 'Most Recent Decisions',
        conditions: `${baseCondition} has:ci.retry.decision`,
        columns: [
          'timestamp',
          'ci.retry.decision',
          'ci.retry.event',
          'ci.retry.runId',
          'ci.retry.jobDrilldownUrl',
          'ci.prNumber',
          'ci.branch',
        ],
        orderby: '-timestamp',
        y: 6,
        x: 0,
        w: 6,
        h: 3,
      }),
    ],
  };
}
