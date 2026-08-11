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
