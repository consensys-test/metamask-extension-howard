export type FailureCategory = "alwaysRetryable" | "retryableOnTransientError" | "optional";

export type FailureJob = {
  name: string;
};

export function partitionRetryableBlockerCascadeJobs<JobType extends FailureJob>({
  jobs,
  getCategory,
}: {
  jobs: JobType[];
  getCategory: (jobName: string) => FailureCategory;
}): {
  jobsToClassify: JobType[];
  jobsToCascade: JobType[];
} {
  return jobs.reduce<{
    jobsToClassify: JobType[];
    jobsToCascade: JobType[];
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
