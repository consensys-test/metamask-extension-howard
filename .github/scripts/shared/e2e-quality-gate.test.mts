import {
  E2E_QUALITY_GATE_FAILURE_ANNOTATION_TITLE,
  getE2eQualityGateFailurePaths,
  hasE2eQualityGateFailure,
} from './e2e-quality-gate.mts';

describe('E2E quality gate failures', () => {
  it('returns only changed or new tests that actually failed', () => {
    expect(
      getE2eQualityGateFailurePaths({
        changedOrNewTests: [
          'test/e2e/tests/changed.spec.ts',
          'test/e2e/tests/passed.spec.ts',
        ],
        failedTests: [
          'test/e2e/tests/changed.spec.ts',
          'test/e2e/tests/ordinary.spec.ts',
        ],
      }),
    ).toStrictEqual(['test/e2e/tests/changed.spec.ts']);
  });

  it('does not signal failures when the quality gate is skipped', () => {
    expect(
      getE2eQualityGateFailurePaths({
        changedOrNewTests: [],
        failedTests: ['test/e2e/tests/changed.spec.ts'],
      }),
    ).toStrictEqual([]);
  });

  it('detects the exact quality-gate annotation title', () => {
    expect(
      hasE2eQualityGateFailure(
        [{ title: E2E_QUALITY_GATE_FAILURE_ANNOTATION_TITLE }],
      ),
    ).toBe(true);
  });

  it('does not match arbitrary annotation text', () => {
    expect(
      hasE2eQualityGateFailure([
        { title: 'E2E quality gate failure: test/e2e/tests/changed.spec.ts' },
        { title: 'Ordinary E2E failure' },
      ]),
    ).toBe(false);
  });
});
