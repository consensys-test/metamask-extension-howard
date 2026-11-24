import {
  autofixEnabled,
  buildDispatchRequest,
} from './audit-autofix-dispatch.mts';

describe('buildDispatchRequest', () => {
  it('targets the autofix workflow with the issue and a real run', () => {
    expect(buildDispatchRequest('o/r', 'main', 159)).toStrictEqual({
      path: '/repos/o/r/actions/workflows/audit-autofix.yml/dispatches',
      body: { ref: 'main', inputs: { issues: '159', 'dry-run': 'false' } },
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
