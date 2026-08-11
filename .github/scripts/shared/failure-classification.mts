import { hasE2eQualityGateFailure, type CheckAnnotation } from "./e2e-quality-gate.mts";

export type FailureCategory = "alwaysRetryable" | "retryableOnTransientError" | "optional";

export type FailureJob = {
  name: string;
};

export function partitionRetryableBlockerCascadeJobs({
  jobs,
  getCategory,
}: {
  jobs: FailureJob[];
  getCategory: (jobName: string) => FailureCategory;
}): {
  jobsToClassify: FailureJob[];
  jobsToCascade: FailureJob[];
} {
  return jobs.reduce<{
    jobsToClassify: FailureJob[];
    jobsToCascade: FailureJob[];
  }>(
    (partition, job) => {
      if (getCategory(job.name) === "alwaysRetryable") {
        partition.jobsToClassify.push(job);
      } else {
        partition.jobsToCascade.push(job);
      }
      return partition;
    },
    { jobsToClassify: [], jobsToCascade: [] },
  );
}

export function isAlwaysRetryableFailureRetryable(annotations: CheckAnnotation[]): boolean {
  return !hasE2eQualityGateFailure(annotations);
}
