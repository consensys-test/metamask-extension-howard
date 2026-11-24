import { buildDispatchRequest } from './audit-autofix-dispatch.mts';

describe('buildDispatchRequest', () => {
  it('targets the autofix workflow for every open issue and a real run', () => {
    expect(buildDispatchRequest('o/r', 'main')).toStrictEqual({
      path: '/repos/o/r/actions/workflows/audit-autofix.yml/dispatches',
      body: { ref: 'main', inputs: { issues: 'open', 'dry-run': 'false' } },
    });
  });
});
