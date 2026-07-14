import { describe, expect, it } from 'bun:test';

import {
  findUserByIdentifier,
  isSelectedWorker,
  selectedWorkerIdentifier,
  userIdentifier,
} from '../../web/src/job-flow';

describe('job flow UI role selection', () => {
  const worker = { id: 'worker-1', user_id: 'worker-1', name: 'Worker Test' };

  it('recognizes the selected worker returned by the public job API', () => {
    const selectedJob = { intended_payee_user_id: 'worker-1' };

    expect(selectedWorkerIdentifier(selectedJob)).toBe('worker-1');
    expect(isSelectedWorker(selectedJob, worker)).toBe(true);
    expect(isSelectedWorker(selectedJob, { id: 'employer-1' })).toBe(false);
  });

  it('accepts the database-style worker field during a rolling contract change', () => {
    expect(isSelectedWorker({ selected_worker_user_id: 'worker-1' }, worker)).toBe(true);
  });

  it('does not treat an unassigned job or missing user as a worker match', () => {
    expect(isSelectedWorker({ intended_payee_user_id: null }, worker)).toBe(false);
    expect(isSelectedWorker({ intended_payee_user_id: 'worker-1' }, null)).toBe(false);
  });

  it('finds users consistently whether their payload uses id or user_id', () => {
    const root = { id: 'employer-1', name: 'Employer' };

    expect(userIdentifier(worker)).toBe('worker-1');
    expect(findUserByIdentifier([root, worker], 'worker-1')).toBe(worker);
  });
});
