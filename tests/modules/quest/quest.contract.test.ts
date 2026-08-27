import {
  applicationStatuses,
  assignmentStatuses,
  editRequestStatuses,
  editResponseDecisions,
  invitationStatuses,
  proofStatuses,
  questModes,
  questParticipations,
  questStatuses,
  teamStatuses,
} from '@/modules/quest/quest.contract';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

const questEdr = readFileSync(
  join(import.meta.dir, '..', '..', '..', 'docs', 'db', 'edr', '05-quest.sql'),
  'utf8',
);

const parseValueList = (list: string) =>
  list.split(',').map((value) => value.trim().replace(/^'|'$/g, ''));

const enumTypeToVocabulary = {
  quest_mode: questModes,
  quest_participation: questParticipations,
  quest_status: questStatuses,
} as const;

const statusColumnToVocabulary = {
  team_status: teamStatuses,
  application_status: applicationStatuses,
  assignment_status: assignmentStatuses,
  submission_status: proofStatuses,
  request_status: editRequestStatuses,
  decision: editResponseDecisions,
  invitation_status: invitationStatuses,
} as const;

describe('Quest domain contract', () => {
  it('keeps the Quest mode and participation vocabularies', () => {
    expect(questModes).toEqual(['NO_CANDIDATE', 'CANDIDATE']);
    expect(questParticipations).toEqual(['SOLO', 'GROUP']);
  });

  it('uses Hirer/Worker identity names, not Giver/Hunter', () => {
    expect(questStatuses).not.toContain('GIVER' as never);
    expect(applicationStatuses).toEqual([
      'APPLICATION_APPLIED',
      'APPLICATION_SELECTED',
      'APPLICATION_REJECTED',
      'APPLICATION_WITHDRAWN',
    ]);
  });

  it('entity-prefixes every Quest lifecycle status', () => {
    expect(questStatuses).toEqual([
      'QUEST_DRAFT',
      'QUEST_OPEN',
      'QUEST_AWAITING_CONSENT',
      'QUEST_ASSIGNED',
      'QUEST_IN_PROGRESS',
      'QUEST_SUBMITTED',
      'QUEST_APPROVED',
      'QUEST_REWORK',
      'QUEST_COMPLETED',
      'QUEST_CANCELLED',
      'QUEST_DISPUTED',
      'QUEST_HIDDEN',
    ]);
  });

  it('entity-prefixes every subordinate status vocabulary', () => {
    expect(teamStatuses).toEqual([
      'TEAM_FORMING',
      'TEAM_SUBMITTED',
      'TEAM_SELECTED',
      'TEAM_REJECTED',
      'TEAM_DISBANDED',
    ]);
    expect(assignmentStatuses).toEqual([
      'ASSIGNMENT_ACTIVE',
      'ASSIGNMENT_COMPLETED',
      'ASSIGNMENT_INCOMPLETE',
      'ASSIGNMENT_CANCELLED',
    ]);
    expect(proofStatuses).toEqual([
      'PROOF_PENDING',
      'PROOF_APPROVED',
      'PROOF_REJECTED',
      'PROOF_AUTO_APPROVED',
    ]);
    expect(editRequestStatuses).toEqual([
      'EDIT_REQUEST_PENDING',
      'EDIT_REQUEST_APPROVED',
      'EDIT_REQUEST_REJECTED',
    ]);
    expect(editResponseDecisions).toEqual([
      'EDIT_RESPONSE_APPROVED',
      'EDIT_RESPONSE_REJECTED',
    ]);
    expect(invitationStatuses).toEqual([
      'INVITATION_PENDING',
      'INVITATION_ACCEPTED',
      'INVITATION_DECLINED',
      'INVITATION_EXPIRED',
      'INVITATION_REVOKED',
    ]);
  });
});

describe('Quest EDR parity (docs/db/edr/05-quest.sql)', () => {
  it('matches every native ENUM vocabulary', () => {
    for (const [typeName, vocabulary] of Object.entries(enumTypeToVocabulary)) {
      const match = questEdr.match(
        new RegExp(`CREATE TYPE ${typeName} AS ENUM \\(([^)]*)\\)`),
      );
      expect(match, `CREATE TYPE ${typeName} is missing from the EDR`).not.toBeNull();
      expect(parseValueList(match![1]!)).toEqual([...vocabulary]);
    }
  });

  it('matches every VARCHAR+CHECK status vocabulary', () => {
    const checks = [...questEdr.matchAll(/CHECK \(\s*(\w+) IN \(([^)]*)\)\s*\)/g)];
    for (const [column, vocabulary] of Object.entries(statusColumnToVocabulary)) {
      const match = checks.find(([, capturedColumn]) => capturedColumn!.trim() === column);
      expect(match, `CHECK ${column} IN (...) is missing from the EDR`).toBeDefined();
      expect(parseValueList(match![2]!)).toEqual([...vocabulary]);
    }
  });

  it('uses hirer_id/worker_id actor columns, not giver_id/hunter_id', () => {
    expect(questEdr).not.toMatch(/\bgiver_id\b/);
    expect(questEdr).not.toMatch(/\bhunter_id\b/);
    expect(questEdr).toMatch(/hirer_id\s+UUID NOT NULL REFERENCES auth_user\(id\)/);
    expect(questEdr).toMatch(/worker_id\s+UUID NOT NULL REFERENCES auth_user\(id\)/);
  });

  it('keeps quest_location label-only with a nullable label', () => {
    expect(questEdr.match(/^ {2}label\s+VARCHAR\(100\),?$/m)).not.toBeNull();
    const locationBlock = questEdr.match(/CREATE TABLE quest_location \([\s\S]*?\);/)![0];
    expect(locationBlock).not.toMatch(/address|\blat\b|\blng\b/);
  });
});
