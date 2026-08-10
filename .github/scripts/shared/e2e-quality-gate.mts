export const E2E_QUALITY_GATE_FAILURE_MARKER =
  'E2E_CHANGED_OR_NEW_TEST_FAILURE';

export function formatE2eQualityGateFailureMarker(testPath: string): string {
  return `${E2E_QUALITY_GATE_FAILURE_MARKER}: ${testPath}`;
}

export function hasE2eQualityGateFailure(logs: string): boolean {
  return logs.includes(E2E_QUALITY_GATE_FAILURE_MARKER);
}
