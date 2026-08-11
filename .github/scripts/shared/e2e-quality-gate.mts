export const E2E_QUALITY_GATE_FAILURE_ANNOTATION_TITLE =
  'E2E quality gate failure';

export type CheckAnnotation = {
  title?: string;
};

export function getE2eQualityGateFailurePaths({
  changedOrNewTests,
  failedTests,
}: {
  changedOrNewTests: string[];
  failedTests: string[];
}): string[] {
  const failedTestPaths = new Set(failedTests);
  return changedOrNewTests.filter((testPath) => failedTestPaths.has(testPath));
}

export function hasE2eQualityGateFailure(
  annotations: CheckAnnotation[],
): boolean {
  return annotations.some(
    (annotation) =>
      annotation.title === E2E_QUALITY_GATE_FAILURE_ANNOTATION_TITLE,
  );
}
