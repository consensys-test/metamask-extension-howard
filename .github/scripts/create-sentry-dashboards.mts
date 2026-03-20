import { parseArgs } from 'node:util';
import {
  buildCiRetryDashboardPayload,
  type SentryDashboardPayload,
} from './sentry-dashboard-widgets.mts';

interface SentryDashboardSummary {
  id: string;
  title: string;
}

interface SentryDashboardResponse {
  id: string;
  title: string;
}

const { values } = parseArgs({
  options: {
    token: { type: 'string', short: 't' },
    org: { type: 'string', short: 'o' },
    projectId: { type: 'string', short: 'p' },
    title: { type: 'string' },
    period: { type: 'string' },
    baseUrl: { type: 'string' },
    dryRun: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help) {
  console.log(
    [
      'Usage: node .github/scripts/create-sentry-dashboards.mts [options]',
      '',
      'Options:',
      '  -t, --token      Sentry personal token (or SENTRY_AUTH_TOKEN env var)',
      '  -o, --org        Sentry organization slug (default: metamask)',
      '  -p, --projectId  Sentry project ID (default: 4510302346608640)',
      '      --title      Dashboard title (default: Main CI Retry Triage)',
      '      --period     Relative period for dashboard (default: 14d)',
      '      --baseUrl    Sentry base URL (default: https://sentry.io)',
      '      --dryRun     Print payload only; do not call API',
    ].join('\n'),
  );
  process.exit(0);
}

const token = values.token || process.env.SENTRY_AUTH_TOKEN || '';
const org = values.org || process.env.SENTRY_ORG || 'metamask';
const projectIdRaw =
  values.projectId || process.env.SENTRY_PROJECT_ID || '4510302346608640';
const dashboardTitle = values.title || 'Main CI Retry Triage';
const period = values.period || '14d';
const baseUrl = (values.baseUrl || 'https://sentry.io').replace(/\/+$/, '');
const dryRun = values.dryRun ?? false;

const projectId = Number(projectIdRaw);
if (!Number.isFinite(projectId) || projectId <= 0) {
  console.error(`Invalid project ID: ${projectIdRaw}`);
  process.exit(1);
}

if (!token && !dryRun) {
  console.error('Missing Sentry auth token. Set --token or SENTRY_AUTH_TOKEN.');
  process.exit(1);
}

const payload = buildCiRetryDashboardPayload({
  title: dashboardTitle,
  projectId,
  period,
});

if (dryRun) {
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

const authHeaders = {
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
};

async function sentryRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...authHeaders,
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Sentry API ${response.status} ${response.statusText}: ${text}`,
    );
  }

  return (await response.json()) as T;
}

async function listDashboards(): Promise<SentryDashboardSummary[]> {
  return sentryRequest<SentryDashboardSummary[]>(
    `/api/0/organizations/${org}/dashboards/`,
  );
}

async function createDashboard(
  body: SentryDashboardPayload,
): Promise<SentryDashboardResponse> {
  return sentryRequest<SentryDashboardResponse>(
    `/api/0/organizations/${org}/dashboards/`,
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
  );
}

async function updateDashboard(
  dashboardId: string,
  body: SentryDashboardPayload,
): Promise<SentryDashboardResponse> {
  return sentryRequest<SentryDashboardResponse>(
    `/api/0/organizations/${org}/dashboards/${dashboardId}/`,
    {
      method: 'PUT',
      body: JSON.stringify(body),
    },
  );
}

async function main(): Promise<void> {
  const dashboards = await listDashboards();
  const existing = dashboards.find(
    (dashboard) => dashboard.title === dashboardTitle,
  );

  if (existing) {
    const updated = await updateDashboard(existing.id, payload);
    console.log(
      `Updated dashboard: ${updated.title} (${baseUrl}/organizations/${org}/dashboards/${updated.id}/)`,
    );
    return;
  }

  const created = await createDashboard(payload);
  console.log(
    `Created dashboard: ${created.title} (${baseUrl}/organizations/${org}/dashboards/${created.id}/)`,
  );
}

await main();
