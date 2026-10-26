import { extractTestResults } from './extract-test-results.mts';
import {
  E2E_QUALITY_GATE_FAILURE_ANNOTATION_TITLE,
  getE2eQualityGateFailurePaths,
} from './shared/e2e-quality-gate.mts';
import {
  readChangedAndFilterE2eChangedFiles,
  shouldE2eQualityGateBeSkipped,
} from '../../test/e2e/changedFilesUtil.js';

async function main(): Promise<void> {
  if (shouldE2eQualityGateBeSkipped()) {
    console.log('E2E quality gate is skipped; no annotations emitted.');
    return;
  }

  const { failed } = await extractTestResults('test/test-results/e2e');
  const changedOrNewTests = [
    ...readChangedAndFilterE2eChangedFiles(),
    ...readChangedAndFilterE2eChangedFiles({ playwrightOnly: true }),
  ];
  const failedQualityGateTests = getE2eQualityGateFailurePaths({
    changedOrNewTests,
    failedTests: failed,
  });

  for (const testPath of failedQualityGateTests) {
    console.log(
      `::error title=${E2E_QUALITY_GATE_FAILURE_ANNOTATION_TITLE},file=${testPath}::Changed/new quality-gate test failed.`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
