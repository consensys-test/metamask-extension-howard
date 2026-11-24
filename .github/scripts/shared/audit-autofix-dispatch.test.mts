import {
  autofixEnabled,
  buildDispatchRequest,
} from './audit-autofix-dispatch.mts';

describe('buildDispatchRequest', () => {
  it('targets the autofix workflow for every open issue and a real run', () => {
    expect(buildDispatchRequest('o/r', 'main')).toStrictEqual({
      path: '/repos/o/r/actions/workflows/audit-autofix.yml/dispatches',
      body: { ref: 'main', inputs: { issues: 'open', 'dry-run': 'false' } },
    });
  });
});

describe('autofixEnabled', () => {
  it('is on only for the exact value true', () => {
    expect(autofixEnabled({ AUDIT_AUTOFIX_ENABLED: 'true' })).toBe(true);
    expect(autofixEnabled({ AUDIT_AUTOFIX_ENABLED: 'false' })).toBe(false);
    expect(autofixEnabled({ AUDIT_AUTOFIX_ENABLED: '' })).toBe(false);
    expect(autofixEnabled({})).toBe(false);
  });
});
