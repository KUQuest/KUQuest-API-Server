import { expect, test } from 'bun:test';

import { createDemoFrontendSeedPlan } from '../../scripts/seed-demo-frontend';

const countBy = <T extends string>(values: readonly T[]): Record<T, number> => {
  const counts = {} as Record<T, number>;
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
};

test('frontend demo seed plan covers every required Quest and Admin status', () => {
  const plan = createDemoFrontendSeedPlan();

  expect(plan.quests).toHaveLength(50);
  expect(countBy(plan.quests.map(({ status }) => status))).toEqual({
    QUEST_DRAFT: 5,
    QUEST_OPEN: 20,
    QUEST_ASSIGNED: 5,
    QUEST_IN_PROGRESS: 5,
    QUEST_COMPLETED: 5,
    QUEST_CANCELLED: 5,
    QUEST_FAILED: 5,
  });

  expect(plan.reportCases).toHaveLength(20);
  expect(countBy(plan.reportCases.map(({ status }) => status))).toEqual({
    REPORT_CASE_PENDING: 5,
    REPORT_CASE_DISMISSED: 5,
    REPORT_CASE_HIDDEN: 5,
    REPORT_CASE_RESTORED: 5,
  });
  expect(new Set(plan.reportCases.map(({ reason }) => reason))).toEqual(
    new Set([
      'REPORT_ABUSIVE_OR_HARASSMENT',
      'REPORT_SPAM',
      'REPORT_INAPPROPRIATE_CONTENT',
      'REPORT_DANGER_OR_THREAT',
      'REPORT_OTHER',
    ])
  );

  expect(plan.conductReports).toHaveLength(15);
  expect(countBy(plan.conductReports.map(({ status }) => status))).toEqual({
    CONDUCT_REPORT_PENDING: 5,
    CONDUCT_REPORT_UPHELD: 5,
    CONDUCT_REPORT_DISMISSED: 5,
  });
  expect(countBy(plan.conductReports.map(({ reason }) => reason))).toEqual({
    CONDUCT_ABANDONED: 5,
    CONDUCT_OUT_OF_SCOPE: 5,
    CONDUCT_NO_SHOW: 5,
  });

  expect(plan.disputeCases).toHaveLength(15);
  expect(countBy(plan.disputeCases.map(({ status }) => status))).toEqual({
    DISPUTE_CASE_PENDING: 5,
    DISPUTE_CASE_DISMISSED: 5,
    DISPUTE_CASE_RESOLVED: 5,
  });
  expect(plan.walletStatuses).toEqual(['ACTIVE', 'FROZEN', 'SUSPENDED', 'CLOSED']);
  expect(plan.occupations).toEqual(['Student', 'Staff', 'Lecturer']);
});
