export type JobStatus =
  | 'OPEN'
  | 'ASSIGNED'
  | 'OVERDUE'
  | 'IN_REVIEW'
  | 'DISPUTED'
  | 'SETTLED'
  | 'RETURNED'
  | 'CANCELLED'
  | 'EXPIRED';

export type JobApplicationStatus =
  | 'PENDING'
  | 'SELECTED'
  | 'WITHDRAWN'
  | 'REJECTED'
  | 'REMOVED_WORKER_ENGAGED';

export interface FundedJob {
  id: string;
  employer_user_id: string;
  intended_payee_user_id: string | null;
  title: string;
  description: string;
  status: JobStatus;
  job_amount: number;
  platform_fee_rate_bps: number;
  platform_fee_amount: number;
  worker_net_amount: number;
  currency: 'THB';
  application_deadline: string;
  work_deadline: string;
  review_deadline: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobApplication {
  id: string;
  job_id: string;
  worker_user_id: string;
  status: JobApplicationStatus;
  message: string;
  created_at: string;
  updated_at: string;
}

export interface WorkSubmission {
  id: string;
  job_id: string;
  worker_user_id: string;
  status: 'SUBMITTED' | 'APPROVED' | 'AUTO_APPROVED' | 'DISPUTED';
  summary: string;
  review_deadline: string;
  created_at: string;
}

export interface JobPage {
  items: FundedJob[];
  next_cursor: string | null;
}

export interface JobApplicationPage {
  items: JobApplication[];
  next_cursor: string | null;
}

export interface IdempotentCommand {
  userId: string;
  idempotencyKey: string;
  requestHash: string;
}

export interface CreateFundedJobCommand extends IdempotentCommand {
  title: string;
  description: string;
  amount: number;
  applicationDeadline: string;
  workDeadline: string;
}

export interface JobCommand extends IdempotentCommand {
  jobId: string;
}

export interface CreateApplicationCommand extends JobCommand {
  message: string;
}

export interface SelectWorkerCommand extends JobCommand {
  applicationId: string;
}

export interface SubmitWorkCommand extends JobCommand {
  summary: string;
}

export interface ListJobsQuery {
  scope: 'marketplace' | 'mine' | 'assigned';
  status?: JobStatus;
  cursor?: string;
  limit: number;
}

export interface PageQuery {
  cursor?: string;
  limit: number;
}

export interface JobRepository {
  listJobs(userId: string, query: ListJobsQuery): Promise<JobPage>;
  getJob(userId: string, jobId: string): Promise<FundedJob>;
  createFundedJob(command: CreateFundedJobCommand): Promise<FundedJob>;
  cancelJob(command: JobCommand): Promise<FundedJob>;
  createApplication(command: CreateApplicationCommand): Promise<JobApplication>;
  listApplications(userId: string, jobId: string, query: PageQuery): Promise<JobApplicationPage>;
  getMyApplication(userId: string, jobId: string): Promise<JobApplication | null>;
  getSubmission(userId: string, jobId: string): Promise<WorkSubmission | null>;
  selectWorker(command: SelectWorkerCommand): Promise<FundedJob>;
  submitWork(command: SubmitWorkCommand): Promise<FundedJob>;
  approveWork(command: JobCommand): Promise<FundedJob>;
}
