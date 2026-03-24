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
  description?: string;
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
  environment: string[];
  filters: Record<string, string>;
  utc: boolean;
}

interface WidgetSpec {
  title: string;
  description?: string;
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
  description,
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
    ...(description ? { description } : {}),
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
  description,
  queries,
  y,
  x = 0,
  w = 6,
  h = 2,
}: {
  title: string;
  description?: string;
  queries: { name: string; conditions: string }[];
  y: number;
  x?: number;
  w?: number;
  h?: number;
}): SentryDashboardWidget {
  return {
    title,
    ...(description ? { description } : {}),
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

function multiSeriesMetricGraphWidget({
  title,
  description,
  queries,
  y,
  x = 0,
  w = 6,
  h = 2,
  displayType = 'line',
}: {
  title: string;
  description?: string;
  queries: { name: string; conditions: string; metric: string }[];
  y: number;
  x?: number;
  w?: number;
  h?: number;
  displayType?: SentryDashboardWidget['displayType'];
}): SentryDashboardWidget {
  return {
    title,
    ...(description ? { description } : {}),
    displayType,
    interval: '1d',
    datasetSource: 'user',
    widgetType: 'logs',
    queries: queries.map(({ name, conditions, metric }) => ({
      name,
      fields: [metric],
      aggregates: [metric],
      columns: [],
      fieldAliases: [''],
      conditions,
      orderby: `-${metric}`,
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
  const baseCondition = '';
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
      // ── Row 0: Hero metric ────────────────────────────────────
      multiSeriesMetricGraphWidget({
        title: 'Merge queue: merged vs ejected',
        description:
          'Every merge_group entry on attempt 1. Merged = all jobs passed. Ejected = one or more jobs failed. Ejected includes both flakes and real failures.',
        displayType: 'area',
        queries: [
          {
            name: 'Merged',
            conditions: `${baseCondition} ci.mergeQueue.event:outcome ci.mergeQueue.outcome:merged`,
            metric: 'count_unique(ci.retry.runId)',
          },
          {
            name: 'Ejected',
            conditions: `${baseCondition} ci.mergeQueue.event:outcome ci.mergeQueue.outcome:ejected`,
            metric: 'count_unique(ci.retry.runId)',
          },
        ],
        y: 0,
        x: 0,
        w: 6,
      }),
      // ── Row 2: Retryable ratio ────────────────────────────────────────
      {
        title: 'What ratio of failed workflows are retryable?',
        description:
          'Each failed workflow run is classified: what fraction of its failed jobs are retryable (flakes) vs non-retryable (real failures)? Lines converging at 1.0 means most failures are flakes.',
        displayType: 'line' as const,
        interval: '1d',
        datasetSource: 'user' as const,
        widgetType: 'logs' as const,
        queries: [
          {
            name: '',
            fields: [
              'avg(tags[ci.retry.retryableRatio,number])',
              'avg(tags[ci.retry.nonRetryableRatio,number])',
            ],
            aggregates: [
              'avg(tags[ci.retry.retryableRatio,number])',
              'avg(tags[ci.retry.nonRetryableRatio,number])',
            ],
            columns: [],
            fieldAliases: ['retryable', 'non-retryable'],
            conditions: '', // no filter needed — ratio fields only exist on summary events
            orderby: '-avg(tags[ci.retry.retryableRatio,number])',
            isHidden: false,
          },
        ],
        layout: { w: 6, h: 2, x: 0, y: 2, minH: 2 },
      },
      // ── Row 4: Decision breakdown charts ──────────────────────────
      stackedBarWidget({
        title: 'Were retryable runs retried?',
        queries: [
          { decision: 'will-retry', name: 'Auto-retried' },
          { decision: 'retryable-no-label', name: 'Retryable (but no label)' },
          { decision: 'retryable-no-pr', name: 'Retryable (but no PR)' },
        ].map(({ decision, name }) => ({
          name,
          conditions: `${baseCondition} ci.retry.decision:${decision}`,
        })),
        y: 4,
        x: 0,
        w: 3,
        h: 3,
      }),
      stackedBarWidget({
        title: 'Did people put the label on non-retryable runs?',
        queries: [
          { decision: 'not-retryable-has-label', name: 'Has label' },
          { decision: 'not-retryable-no-label', name: 'No label' },
          { decision: 'not-retryable-no-pr', name: 'No PR' },
        ].map(({ decision, name }) => ({
          name,
          conditions: `${baseCondition} ci.retry.decision:${decision}`,
        })),
        y: 4,
        x: 3,
        w: 3,
        h: 3,
      }),
      // ── Row 7: Job-level tables ───────────────────────────────────
      tableWidget({
        title: 'Flakiest Jobs (Retryable)',
        conditions: `${jobCondition} ci.job.retryable:true`,
        columns: [
          'count()',
          'ci.job.name',
          'ci.job.category',
          'ci.job.errorSnippet',
        ],
        fieldAliases: ['Count', 'Job Name', 'Job Category', 'Error Snippet'],
        orderby: '-count()',
        y: 7,
        x: 0,
      }),
      tableWidget({
        title: 'Frequent Deterministic Failures (Non-Retryable)',
        conditions: `${jobCondition} ci.job.retryable:false !ci.job.category:optional`,
        columns: ['count()', 'ci.job.name', 'ci.job.category', 'ci.job.reason'],
        fieldAliases: ['Count', 'Job Name', 'Job Category', 'Failure Reason'],
        orderby: '-count()',
        y: 7,
        x: 2,
      }),
      tableWidget({
        title: 'Failure Categories',
        conditions: `${jobCondition} has:ci.job.category`,
        columns: ['count()', 'ci.job.category'],
        fieldAliases: ['Count', 'Job Category'],
        orderby: '-count()',
        y: 7,
        x: 4,
      }),
      // ── Row 9: Retry attempts trend ───────────────────────────────
      stackedBarWidget({
        title: 'When we retried, how many tries did it take?',
        description:
          'Only counts runs that eventually succeeded (resolved). Attempt 2 = fixed on first retry. Attempt 3+ = needed multiple retries. Emitted by ci-status-gate when run_attempt > 1 and all jobs pass.',
        queries: ['2', '3', '4'].map((attempt) => ({
          name: `Attempt ${attempt}`,
          conditions: `${baseCondition} ci.retry.event:resolved ci.retry.resolvedAtAttempt:${attempt}`,
        })),
        y: 9,
        x: 0,
        w: 6,
        h: 2,
      }),
      // ── Row 11: Unmatched + pattern gap trends ────────────────────
      graphWidget({
        title: 'How many workflows hit an unmatched error type?',
        description:
          "Unmatched = a job failed but didn't match any known category in retry-config.jsonc. Rising trend means new failure patterns need to be added to the classifier.",
        displayType: 'line',
        conditions: `${baseCondition} tags[ci.retry.unmatchedJobCount,number]:>0`,
        columns: ['count_unique(ci.retry.runId)'],
        orderby: '-count_unique(ci.retry.runId)',
        y: 11,
        x: 0,
        w: 3,
      }),
      tableWidget({
        title: 'Unmatched Failures ("No results" = healthy)',
        description:
          "Jobs that failed but didn't match any category in retry-config.jsonc. Empty table means every failure type is accounted for. New entries here mean you need to add a pattern to the classifier.",
        conditions: `${jobCondition} ci.job.unmatched:true`,
        columns: ['count()', 'ci.job.name', 'ci.job.reason', 'ci.retry.runId'],
        fieldAliases: ['Count', 'Job Name', 'Reason', 'Run ID'],
        orderby: '-count()',
        y: 11,
        x: 3,
        w: 3,
      }),
      tableWidget({
        title: 'Pattern Gap: Errors to Consider Adding',
        description:
          'Jobs in the retryableOnTransientError category that failed without matching any transient pattern. These are candidates for new entries in retry-config.jsonc transientErrorPatterns.',
        conditions: `${jobCondition} ci.job.category:retryableOnTransientError ci.job.retryable:false`,
        columns: ['count()', 'ci.job.name', 'ci.job.errorSnippet'],
        fieldAliases: ['Count', 'Job Name', 'Error Snippet'],
        orderby: '-count()',
        y: 13,
        x: 0,
        w: 6,
      }),
      // ── Row 15: Cascade blockers ──────────────────────────────────
      graphWidget({
        title: 'How many workflows hit a cascade retry blocker?',
        description:
          'Blocker jobs (Get workflow, Prepare dependencies, etc.) gate all downstream jobs. If a blocker fails non-transiently, the entire run is marked non-retryable regardless of other jobs.',
        displayType: 'line',
        conditions: `${baseCondition} has:ci.blockedBy`,
        columns: ['count_unique(ci.retry.runId)'],
        orderby: '-count_unique(ci.retry.runId)',
        y: 15,
        x: 0,
        w: 3,
      }),
      tableWidget({
        title: 'Most frequent Cascade Blockers',
        conditions: `${baseCondition} has:ci.blockedBy`,
        columns: ['count()', 'ci.blockedBy'],
        fieldAliases: ['Count', 'Blocker'],
        orderby: '-count()',
        y: 15,
        x: 3,
        w: 3,
      }),
      // ── Row 17: Reference tables ──────────────────────────────────
      tableWidget({
        title: 'Decision Distribution',
        conditions: `${baseCondition} has:ci.retry.decision`,
        columns: ['count_unique(ci.retry.runId)', 'ci.retry.decision'],
        fieldAliases: ['Count', 'Decision'],
        orderby: 'ci.retry.decision',
        y: 17,
        x: 0,
      }),
      categoricalDistributionWidget({
        title: 'Failures by Workflow Event',
        groupBy: 'ci.retry.event',
        conditions: `${baseCondition} has:ci.retry.event`,
        y: 17,
        x: 2,
      }),
      // ── Row 19: Recent decisions log ──────────────────────────────
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
        y: 19,
        x: 0,
        w: 6,
        h: 3,
      }),
      // ── Row 22: Failed job count trend ────────────────────────────
      graphWidget({
        title: 'How many jobs failed per workflow run?',
        description:
          'Average failed jobs per run. Low (1-2) = isolated flakes. High (5+) = infra outage or blocker cascade. Helps decide whether retry strategy should target individual jobs vs whole workflows.',
        displayType: 'line',
        conditions: `${baseCondition} has:ci.retry.failedJobCount`,
        columns: ['avg(tags[ci.retry.failedJobCount,number])'],
        fieldAliases: ['Avg failed jobs'],
        orderby: '-avg(tags[ci.retry.failedJobCount,number])',
        y: 22,
        x: 0,
        w: 3,
      }),
      // ── Row 22 (right): Failed job count distribution ─────────────
      categoricalDistributionWidget({
        title: 'How many jobs fail per run?',
        description:
          'Distribution of failed job counts across runs. Mostly 1 = isolated flakes. Spikes at 5+ = infra outage or blocker cascade.',
        groupBy: 'ci.retry.failedJobCount',
        conditions: `${baseCondition} has:ci.retry.failedJobCount`,
        orderby: 'ci.retry.failedJobCount',
        y: 22,
        x: 3,
        w: 3,
      }),
      // ── Row 24: Branch targets ────────────────────────────────────
      multiSeriesMetricGraphWidget({
        title: 'Which branch targets are failing?',
        description:
          'Breaks down failures by branch and trigger event. main gets three series (PRs, merge queue, pushes) since they have different retry policies. stable and release/* are separate tracks.',
        displayType: 'area',
        queries: [
          {
            name: 'PRs → main',
            conditions: `${baseCondition} ci.targetBranch:main ci.retry.event:pull_request`,
            metric: 'count_unique(ci.retry.runId)',
          },
          {
            name: 'Merge Queue → main',
            conditions: `${baseCondition} ci.targetBranch:main ci.retry.event:merge_group`,
            metric: 'count_unique(ci.retry.runId)',
          },
          {
            name: 'Pushes → main',
            conditions: `${baseCondition} ci.targetBranch:main ci.retry.event:push`,
            metric: 'count_unique(ci.retry.runId)',
          },
          {
            name: 'stable',
            conditions: `${baseCondition} ci.targetBranch:stable`,
            metric: 'count_unique(ci.retry.runId)',
          },
          {
            name: 'release/*',
            conditions: `${baseCondition} ci.targetBranch:release/*`,
            metric: 'count_unique(ci.retry.runId)',
          },
        ],
        y: 24,
        x: 0,
        w: 6,
      }),
      // ── Row 26: Retry outcomes ────────────────────────────────────
      // The gap between "Retried" and "Resolved+Cancelled" = runs
      // still in-flight or stuck.
      multiSeriesMetricGraphWidget({
        title: 'Did retries actually fix things?',
        description:
          'Retried = auto-retried by triage (will-retry). Resolved = later attempt succeeded. Cancelled = retry was preempted (e.g. new merge-queue entry). Gap = retries still in-flight or stuck.',
        displayType: 'line',
        queries: [
          {
            name: 'Retried',
            conditions: `${baseCondition} ci.retry.decision:will-retry`,
            metric: 'count_unique(ci.retry.runId)',
          },
          {
            name: 'Resolved',
            conditions: `${baseCondition} ci.retry.event:resolved`,
            metric: 'count_unique(ci.retry.runId)',
          },
          {
            name: 'Cancelled',
            conditions: `${baseCondition} ci.retry.decision:cancelled`,
            metric: 'count_unique(ci.retry.runId)',
          },
        ],
        y: 28,
        x: 0,
        w: 6,
      }),
    ],
  };
}
