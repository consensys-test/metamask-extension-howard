import {
  E2E_QUALITY_GATE_FAILURE_MARKER,
  formatE2eQualityGateFailureMarker,
  hasE2eQualityGateFailure,
} from './e2e-quality-gate.mts';

describe('E2E quality gate failure marker', () => {
  it('formats a stable marker with the changed test path', () => {
    expect(
      formatE2eQualityGateFailureMarker(
        'test/e2e/tests/example/example.spec.ts',
      ),
    ).toBe(
      `${E2E_QUALITY_GATE_FAILURE_MARKER}: test/e2e/tests/example/example.spec.ts`,
    );
  });

  it('detects a changed or new test failure in job logs', () => {
    expect(
      hasE2eQualityGateFailure(
        `Failure on testcase\n${E2E_QUALITY_GATE_FAILURE_MARKER}: test/e2e/tests/example/example.spec.ts`,
      ),
    ).toBe(true);
  });

  it('does not flag an ordinary E2E failure', () => {
    expect(
      hasE2eQualityGateFailure('Failure on testcase: existing flaky test'),
    ).toBe(false);
  });
});
