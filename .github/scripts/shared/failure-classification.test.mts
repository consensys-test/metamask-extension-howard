import {
  isAlwaysRetryableFailureRetryable,
  partitionRetryableBlockerCascadeJobs,
} from "./failure-classification.mts";
import { E2E_QUALITY_GATE_FAILURE_ANNOTATION_TITLE } from "./e2e-quality-gate.mts";

describe("partitionRetryableBlockerCascadeJobs", () => {
  it("classifies E2E jobs instead of cascading them after a retryable blocker", () => {
    const jobs = [
      { name: "e2e-chrome" },
      { name: "ci-status-gate / CI status gate (controls all-jobs-pass)" },
      { name: "build-dist-webpack" },
    ];

    const result = partitionRetryableBlockerCascadeJobs({
      jobs,
      getCategory: (jobName) => {
        if (jobName.startsWith("e2e-")) return "alwaysRetryable";
        if (jobName.startsWith("ci-status-gate")) return "optional";
        return "retryableOnTransientError";
      },
    });

    expect(result.jobsToClassify).toEqual([{ name: "e2e-chrome" }]);
    expect(result.jobsToCascade).toEqual([
      { name: "ci-status-gate / CI status gate (controls all-jobs-pass)" },
      { name: "build-dist-webpack" },
    ]);
  });
});

describe("isAlwaysRetryableFailureRetryable", () => {
  it("returns false for an E2E quality-gate failure annotation", () => {
    expect(
      isAlwaysRetryableFailureRetryable([{ title: E2E_QUALITY_GATE_FAILURE_ANNOTATION_TITLE }]),
    ).toStrictEqual(false);
  });
});
