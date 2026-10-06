import { app } from '@/app';
import { db, sql } from '@/database/client';
import { authAdmin, authUser } from '@/database/schema/auth.schema';
import { file } from '@/database/schema/file.schema';
import { profileCertificate, profileWorkExperience } from '@/database/schema/profile.schema';
import { quest, questAssignment } from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import { createAdminAuth } from '@/modules/auth/admin-auth.config';
import { createStudentAuth } from '@/modules/auth';
import { encodeCursor } from '@/shared/cursor';

import { Elysia } from 'elysia';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';

const adminEmail = `admin-member-profile-${crypto.randomUUID()}@example.com`;
const adminPassword = 'AdminMemberProfilePass1!';
const memberEmail = `admin-member-profile-${crypto.randomUUID()}@ku.th`;
const memberPassword = 'MemberProfilePass1!';
const targetMemberId = crypto.randomUUID();
const otherMemberId = crypto.randomUUID();
const emptyMemberId = crypto.randomUUID();
const workExperienceIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
const otherWorkExperienceId = crypto.randomUUID();
const certificateIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
const otherCertificateId = crypto.randomUUID();
const imageFileIds = [crypto.randomUUID(), crypto.randomUUID()];
const tagNames = Array.from(
  { length: 7 },
  (_, index) => `Admin profile Tag ${index} ${crypto.randomUUID()}`
);
const tagIds: string[] = [];
const questIds: string[] = [];

const memberTestAuth = createStudentAuth({
  emailAndPasswordEnabled: true,
  allowEmailSignUp: true,
  autoSignIn: false,
  provisionWalletOnCreate: false,
});
const memberAuthApp = new Elysia({ name: 'admin-member-profile-member-auth' }).mount(
  memberTestAuth.handler
);

let adminId = '';
let memberAuthUserId = '';
let adminCookie = '';
let memberCookie = '';

const adminGet = (path: string, cookie = adminCookie) =>
  app.handle(new Request(`http://localhost${path}`, cookie ? { headers: { cookie } } : undefined));

const profileCollectionPaths = {
  tags: `/api/v1/admin/members/${targetMemberId}/profile-tags`,
  workExperiences: `/api/v1/admin/members/${targetMemberId}/work-experiences`,
  certificates: `/api/v1/admin/members/${targetMemberId}/certificates`,
};

beforeAll(async () => {
  await sql`select 1`;

  await db.insert(authUser).values([
    {
      id: targetMemberId,
      email: `${targetMemberId}@ku.th`,
      firstName: 'Target',
      lastName: 'Member',
    },
    {
      id: otherMemberId,
      email: `${otherMemberId}@ku.th`,
      firstName: 'Other',
      lastName: 'Member',
    },
    {
      id: emptyMemberId,
      email: `${emptyMemberId}@ku.th`,
      firstName: 'Empty',
      lastName: 'Member',
    },
  ]);

  const profileTags = await db
    .insert(tag)
    .values(tagNames.map((name) => ({ name })))
    .returning({ id: tag.id, name: tag.name });
  tagIds.push(...profileTags.map(({ id }) => id));
  const tagIdByName = Object.fromEntries(profileTags.map(({ id, name }) => [name, id]));
  const assignmentGroups: {
    tagIndex: number;
    count: number;
    questStatus: 'QUEST_COMPLETED' | 'QUEST_FAILED';
    assignmentStatus: 'ASSIGNMENT_COMPLETED' | 'ASSIGNMENT_INCOMPLETE';
    workerId: string;
  }[] = [
    {
      tagIndex: 0,
      count: 4,
      questStatus: 'QUEST_COMPLETED',
      assignmentStatus: 'ASSIGNMENT_COMPLETED',
      workerId: targetMemberId,
    },
    {
      tagIndex: 1,
      count: 3,
      questStatus: 'QUEST_COMPLETED',
      assignmentStatus: 'ASSIGNMENT_COMPLETED',
      workerId: targetMemberId,
    },
    {
      tagIndex: 2,
      count: 2,
      questStatus: 'QUEST_COMPLETED',
      assignmentStatus: 'ASSIGNMENT_COMPLETED',
      workerId: targetMemberId,
    },
    {
      tagIndex: 3,
      count: 1,
      questStatus: 'QUEST_COMPLETED',
      assignmentStatus: 'ASSIGNMENT_COMPLETED',
      workerId: targetMemberId,
    },
    {
      tagIndex: 4,
      count: 4,
      questStatus: 'QUEST_FAILED',
      assignmentStatus: 'ASSIGNMENT_COMPLETED',
      workerId: targetMemberId,
    },
    {
      tagIndex: 5,
      count: 4,
      questStatus: 'QUEST_COMPLETED',
      assignmentStatus: 'ASSIGNMENT_INCOMPLETE',
      workerId: targetMemberId,
    },
    {
      tagIndex: 6,
      count: 4,
      questStatus: 'QUEST_COMPLETED',
      assignmentStatus: 'ASSIGNMENT_COMPLETED',
      workerId: otherMemberId,
    },
  ];
  const questRows = assignmentGroups.flatMap((group) =>
    Array.from({ length: group.count }, () => {
      const id = crypto.randomUUID();
      return {
        id,
        workerId: group.workerId,
        assignmentStatus: group.assignmentStatus,
        quest: {
          id,
          hirerId: otherMemberId,
          title: `Admin profile Tag Quest ${crypto.randomUUID()}`,
          condition: 'Complete the test Quest',
          mode: 'NO_CANDIDATE' as const,
          participation: 'SOLO' as const,
          questStatus: group.questStatus,
          rewardSatang: 1_000,
          tagId: tagIdByName[tagNames[group.tagIndex]!]!,
          headcount: 1,
          startTime: new Date('2025-01-01T00:00:00.000Z'),
          dueAt: null,
          failedAt:
            group.questStatus === 'QUEST_FAILED' ? new Date('2025-01-02T00:00:00.000Z') : null,
        },
      };
    })
  );
  questIds.push(...questRows.map(({ id }) => id));
  await db.insert(quest).values(questRows.map(({ quest: questRow }) => questRow));
  await db.insert(questAssignment).values(
    questRows.map(({ id, workerId, assignmentStatus }) => ({
      questId: id,
      workerId,
      assignmentStatus,
    }))
  );

  const pageTimestamp = new Date('2025-05-05T00:00:00.000Z');
  await db.insert(profileWorkExperience).values([
    {
      id: workExperienceIds[0]!,
      userId: targetMemberId,
      title: 'Current Work Experience',
      employmentType: 'FULL_TIME',
      org: 'KUQuest Labs',
      description: 'Ongoing role',
      startedAt: '2022-01-01',
      endedAt: null,
      createdAt: pageTimestamp,
    },
    {
      id: workExperienceIds[1]!,
      userId: targetMemberId,
      title: 'Past Work Experience',
      employmentType: 'INTERNSHIP',
      org: null,
      description: null,
      startedAt: '2020-05-01',
      endedAt: '2021-04-30',
      createdAt: pageTimestamp,
    },
    {
      id: workExperienceIds[2]!,
      userId: targetMemberId,
      title: 'Other Work Experience',
      employmentType: 'PART_TIME',
      org: 'Other Org',
      description: 'Not owned by the target Member',
      startedAt: '2019-01-01',
      endedAt: '2019-12-31',
      createdAt: pageTimestamp,
    },
    {
      id: otherWorkExperienceId,
      userId: otherMemberId,
      title: 'Private Other Member Work Experience',
      employmentType: 'FULL_TIME',
      org: null,
      description: null,
      startedAt: '2018-01-01',
      endedAt: null,
      createdAt: pageTimestamp,
    },
  ]);

  await db.insert(file).values([
    {
      id: imageFileIds[0]!,
      bucket: 'private-certificate-bucket',
      objectKey: `private/certificate/${imageFileIds[0]}/storage-secret.png`,
      contentType: 'image/png',
      sizeBytes: 4096,
      uploadedByUserId: targetMemberId,
    },
    {
      id: imageFileIds[1]!,
      bucket: 'private-certificate-bucket',
      objectKey: `private/certificate/${imageFileIds[1]}/storage-secret.png`,
      contentType: 'image/png',
      sizeBytes: 4096,
      uploadedByUserId: targetMemberId,
      deletedAt: new Date(),
    },
  ]);
  await db.insert(profileCertificate).values([
    {
      id: certificateIds[0]!,
      userId: targetMemberId,
      name: 'Certificate with Image',
      issuer: 'KUQuest Institute',
      issuedAt: '2024-03-01',
      imageFileId: imageFileIds[0]!,
      createdAt: pageTimestamp,
    },
    {
      id: certificateIds[1]!,
      userId: targetMemberId,
      name: 'Certificate without Image',
      issuer: 'University of Kasetsart',
      issuedAt: '2023-02-01',
      imageFileId: null,
      createdAt: pageTimestamp,
    },
    {
      id: certificateIds[2]!,
      userId: targetMemberId,
      name: 'Certificate with Deleted Image',
      issuer: 'KU College',
      issuedAt: '2022-01-01',
      imageFileId: imageFileIds[1]!,
      createdAt: pageTimestamp,
    },
    {
      id: otherCertificateId,
      userId: otherMemberId,
      name: 'Private Other Member Certificate',
      issuer: 'Other issuer',
      issuedAt: '2024-03-01',
      imageFileId: null,
      createdAt: pageTimestamp,
    },
  ]);

  const memberSignUp = await memberTestAuth.api.signUpEmail({
    body: {
      email: memberEmail,
      password: memberPassword,
      name: 'Profile Member',
      firstName: 'Profile',
      lastName: 'Member',
    },
  });
  memberAuthUserId = memberSignUp.user.id;

  const adminAuth = createAdminAuth({
    allowSignUp: true,
    autoSignIn: false,
    markEmailVerified: true,
  });
  const signUp = await adminAuth.api.signUpEmail({
    body: {
      email: adminEmail,
      password: adminPassword,
      name: 'Profile Admin',
      firstName: 'Profile',
      lastName: 'Admin',
    },
  });
  adminId = signUp.user.id;

  const adminLogin = await app.handle(
    new Request('http://localhost/api/admin/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: adminEmail, password: adminPassword }),
    })
  );
  if (adminLogin.status !== 200) throw new Error('Profile Admin session was not created.');
  adminCookie = (adminLogin.headers.getSetCookie?.() ?? [])
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ');

  const memberLogin = await memberAuthApp.handle(
    new Request('http://localhost/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: memberEmail, password: memberPassword }),
    })
  );
  if (memberLogin.status !== 200) throw new Error('Profile Member session was not created.');
  memberCookie = (memberLogin.headers.getSetCookie?.() ?? [])
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ');
});

afterAll(async () => {
  await db
    .delete(profileCertificate)
    .where(inArray(profileCertificate.id, [...certificateIds, otherCertificateId]));
  await db
    .delete(profileWorkExperience)
    .where(inArray(profileWorkExperience.id, [...workExperienceIds, otherWorkExperienceId]));
  await db.delete(file).where(inArray(file.id, imageFileIds));
  await db.delete(questAssignment).where(inArray(questAssignment.questId, questIds));
  await db.delete(quest).where(inArray(quest.id, questIds));
  await db.delete(tag).where(inArray(tag.id, tagIds));
  await db
    .delete(authUser)
    .where(inArray(authUser.id, [targetMemberId, otherMemberId, emptyMemberId]));
  if (adminId) await db.delete(authAdmin).where(eq(authAdmin.id, adminId));
  if (memberAuthUserId) {
    await db.delete(authUser).where(eq(authUser.id, memberAuthUserId));
  }
});

type ErrorBody = { success: false; error: { code: string; message: string } };
type MemberIdentity = { displayId: string };
type ProfileTagBody = {
  success: true;
  data: { member: MemberIdentity; tags: Array<{ name: string }> };
};
type CollectionBody<T> = {
  success: true;
  data: {
    member: MemberIdentity;
    items: T[];
    totalCount: number;
    nextCursor: string | null;
  };
};
type WorkExperienceItem = {
  title: string;
  employmentType: string;
  organization: string | null;
  description: string | null;
  startedAt: string;
  endedAt: string | null;
};
type CertificateItem = {
  name: string;
  issuer: string;
  issuedAt: string;
  image: { contentType: string; sizeBytes: number } | null;
};

describe('Admin Member Profile collection reads', () => {
  it('publishes the guarded collection paths and response error contracts in OpenAPI', async () => {
    const response = await app.handle(new Request('http://localhost/openapi/json'));
    const document = (await response.json()) as {
      paths: Record<
        string,
        {
          get?: {
            security?: unknown[];
            responses?: Record<string, unknown>;
          };
        }
      >;
    };

    expect(response.status).toBe(200);
    for (const path of [
      '/api/v1/admin/members/{id}/profile-tags',
      '/api/v1/admin/members/{id}/work-experiences',
      '/api/v1/admin/members/{id}/certificates',
    ]) {
      const operation = document.paths[path]?.get;
      expect(operation).toBeDefined();
      expect(operation?.security?.length).toBeGreaterThan(0);
      expect(Object.keys(operation?.responses ?? {})).toEqual(
        expect.arrayContaining(['200', '400', '401', '403', '404', '500'])
      );
    }
  });

  it('requires an enabled Admin Session and rejects anonymous and Member Sessions', async () => {
    for (const path of Object.values(profileCollectionPaths)) {
      // eslint-disable-next-line no-await-in-loop
      const anonymous = await adminGet(path, '');
      expect(anonymous.status).toBe(401);

      // eslint-disable-next-line no-await-in-loop
      const member = await adminGet(path, memberCookie);
      expect([401, 403]).toContain(member.status);

      // eslint-disable-next-line no-await-in-loop
      const admin = await adminGet(path);
      expect(admin.status).toBe(200);
    }

    await db.update(authAdmin).set({ disabledAt: new Date() }).where(eq(authAdmin.id, adminId));
    try {
      for (const path of Object.values(profileCollectionPaths)) {
        // eslint-disable-next-line no-await-in-loop
        const disabledAdmin = await adminGet(path);
        expect(disabledAdmin.status).toBe(403);
      }
    } finally {
      await db.update(authAdmin).set({ disabledAt: null }).where(eq(authAdmin.id, adminId));
    }
  });

  it('returns only the three most frequent completed Worker Quest Tags', async () => {
    const response = await adminGet(profileCollectionPaths.tags);
    expect(response.status).toBe(200);
    const body = (await response.json()) as ProfileTagBody;

    expect(body.data.member.displayId).toMatch(/^MEM-[0-9]{6,}$/);
    expect(body.data.tags.map(({ name }) => name)).toEqual(tagNames.slice(0, 3));
    expect(body.data.tags).toHaveLength(3);
    expect(JSON.stringify(body)).not.toContain(targetMemberId);
    expect(JSON.stringify(body)).not.toContain(otherMemberId);
  });

  it('returns Work Experience pages with an authoritative total and preserves ongoing dates', async () => {
    const items: WorkExperienceItem[] = [];
    let cursor: string | null = null;
    let totalCount = 0;
    let displayId = '';

    for (let pageNumber = 0; pageNumber < 3; pageNumber += 1) {
      const query = new URLSearchParams({ limit: '1' });
      if (cursor) query.set('cursor', cursor);
      // eslint-disable-next-line no-await-in-loop
      const response = await adminGet(`${profileCollectionPaths.workExperiences}?${query}`);
      expect(response.status).toBe(200);
      // eslint-disable-next-line no-await-in-loop
      const body = (await response.json()) as CollectionBody<WorkExperienceItem>;
      expect(body.data.member.displayId).toMatch(/^MEM-[0-9]{6,}$/);
      expect(body.data.totalCount).toBe(3);
      expect(JSON.stringify(body)).not.toContain(targetMemberId);
      expect(JSON.stringify(body)).not.toContain(otherMemberId);
      displayId = body.data.member.displayId;
      totalCount = body.data.totalCount;
      expect(body.data.items).toHaveLength(1);
      items.push(...body.data.items);
      cursor = body.data.nextCursor;
    }

    expect(displayId).toMatch(/^MEM-[0-9]{6,}$/);
    expect(totalCount).toBe(3);
    expect(cursor).toBeNull();
    expect(items.map(({ title }) => title).sort()).toEqual(
      ['Current Work Experience', 'Past Work Experience', 'Other Work Experience'].sort()
    );
    expect(items).toContainEqual({
      title: 'Current Work Experience',
      employmentType: 'FULL_TIME',
      organization: 'KUQuest Labs',
      description: 'Ongoing role',
      startedAt: '2022-01-01',
      endedAt: null,
    });
    expect(items).toContainEqual({
      title: 'Past Work Experience',
      employmentType: 'INTERNSHIP',
      organization: null,
      description: null,
      startedAt: '2020-05-01',
      endedAt: '2021-04-30',
    });
    expect(JSON.stringify(items)).not.toContain(targetMemberId);
    expect(JSON.stringify(items)).not.toContain(otherMemberId);
    expect(JSON.stringify(items)).not.toContain('Private Other Member');
  });

  it('returns Certificate pages without storage locations or deleted image data', async () => {
    const items: CertificateItem[] = [];
    let cursor: string | null = null;
    let totalCount = 0;
    let displayId = '';

    for (let pageNumber = 0; pageNumber < 3; pageNumber += 1) {
      const query = new URLSearchParams({ limit: '1' });
      if (cursor) query.set('cursor', cursor);
      // eslint-disable-next-line no-await-in-loop
      const response = await adminGet(`${profileCollectionPaths.certificates}?${query}`);
      expect(response.status).toBe(200);
      // eslint-disable-next-line no-await-in-loop
      const body = (await response.json()) as CollectionBody<CertificateItem>;
      expect(body.data.member.displayId).toMatch(/^MEM-[0-9]{6,}$/);
      expect(body.data.totalCount).toBe(3);
      expect(JSON.stringify(body)).not.toContain(targetMemberId);
      expect(JSON.stringify(body)).not.toContain(otherMemberId);
      displayId = body.data.member.displayId;
      totalCount = body.data.totalCount;
      expect(body.data.items).toHaveLength(1);
      items.push(...body.data.items);
      cursor = body.data.nextCursor;
    }

    expect(displayId).toMatch(/^MEM-[0-9]{6,}$/);
    expect(totalCount).toBe(3);
    expect(cursor).toBeNull();
    expect(items.map(({ name }) => name).sort()).toEqual(
      [
        'Certificate with Image',
        'Certificate without Image',
        'Certificate with Deleted Image',
      ].sort()
    );
    expect(items).toContainEqual({
      name: 'Certificate with Image',
      issuer: 'KUQuest Institute',
      issuedAt: '2024-03-01',
      image: { contentType: 'image/png', sizeBytes: 4096 },
    });
    expect(items).toContainEqual({
      name: 'Certificate without Image',
      issuer: 'University of Kasetsart',
      issuedAt: '2023-02-01',
      image: null,
    });
    expect(items).toContainEqual({
      name: 'Certificate with Deleted Image',
      issuer: 'KU College',
      issuedAt: '2022-01-01',
      image: null,
    });
    const serialized = JSON.stringify(items);
    expect(serialized).not.toContain('private-certificate-bucket');
    expect(serialized).not.toContain('storage-secret.png');
    expect(serialized).not.toContain('https://');
    expect(serialized).not.toContain(targetMemberId);
    expect(serialized).not.toContain(otherMemberId);
    expect(serialized).not.toContain('Private Other Member');
  });
  it('rejects Work Experience and Certificate cursors from another Member', async () => {
    const experienceFirstPageResponse = await adminGet(
      `${profileCollectionPaths.workExperiences}?limit=1`
    );
    expect(experienceFirstPageResponse.status).toBe(200);
    const experienceFirstPage =
      (await experienceFirstPageResponse.json()) as CollectionBody<WorkExperienceItem>;
    const experienceCursor = experienceFirstPage.data.nextCursor;
    if (!experienceCursor) throw new Error('The Work Experience fixture needs another page.');

    const crossMemberExperienceQuery = new URLSearchParams({ cursor: experienceCursor });
    const crossMemberExperience = await adminGet(
      `/api/v1/admin/members/${otherMemberId}/work-experiences?${crossMemberExperienceQuery}`
    );
    expect(crossMemberExperience.status).toBe(400);
    expect(((await crossMemberExperience.json()) as ErrorBody).error.code).toBe('INVALID_CURSOR');

    const certificateFirstPageResponse = await adminGet(
      `${profileCollectionPaths.certificates}?limit=1`
    );
    expect(certificateFirstPageResponse.status).toBe(200);
    const certificateFirstPage =
      (await certificateFirstPageResponse.json()) as CollectionBody<CertificateItem>;
    const certificateCursor = certificateFirstPage.data.nextCursor;
    if (!certificateCursor) throw new Error('The Certificate fixture needs another page.');

    const crossMemberCertificateQuery = new URLSearchParams({ cursor: certificateCursor });
    const crossMemberCertificate = await adminGet(
      `/api/v1/admin/members/${otherMemberId}/certificates?${crossMemberCertificateQuery}`
    );
    expect(crossMemberCertificate.status).toBe(400);
    expect(((await crossMemberCertificate.json()) as ErrorBody).error.code).toBe('INVALID_CURSOR');
  });

  it('returns successful empty collections and errors for missing Members or invalid cursors', async () => {
    const tagsResponse = await adminGet(`/api/v1/admin/members/${emptyMemberId}/profile-tags`);
    expect(tagsResponse.status).toBe(200);
    const tagsBody = (await tagsResponse.json()) as ProfileTagBody;
    expect(tagsBody.data.tags).toEqual([]);

    for (const resource of ['work-experiences', 'certificates']) {
      const path = `/api/v1/admin/members/${emptyMemberId}/${resource}`;
      // eslint-disable-next-line no-await-in-loop
      const emptyResponse = await adminGet(path);
      expect(emptyResponse.status).toBe(200);
      // eslint-disable-next-line no-await-in-loop
      const emptyBody = (await emptyResponse.json()) as CollectionBody<unknown>;
      expect(emptyBody.data.items).toEqual([]);
      expect(emptyBody.data.totalCount).toBe(0);
      expect(emptyBody.data.nextCursor).toBeNull();

      // eslint-disable-next-line no-await-in-loop
      const missingMemberResponse = await adminGet(
        `/api/v1/admin/members/${crypto.randomUUID()}/${resource}`
      );
      expect(missingMemberResponse.status).toBe(404);
      // eslint-disable-next-line no-await-in-loop
      expect(((await missingMemberResponse.json()) as ErrorBody).error.code).toBe(
        'MEMBER_NOT_FOUND'
      );

      const invalidCursor = encodeCursor({
        id: crypto.randomUUID(),
        startTime: '2025-05-05T00:00:00.000Z',
      });
      // eslint-disable-next-line no-await-in-loop
      const invalidCursorResponse = await adminGet(`${path}?cursor=${invalidCursor}`);
      expect(invalidCursorResponse.status).toBe(400);
      // eslint-disable-next-line no-await-in-loop
      expect(((await invalidCursorResponse.json()) as ErrorBody).error.code).toBe('INVALID_CURSOR');
    }

    const missingTagMember = await adminGet(
      `/api/v1/admin/members/${crypto.randomUUID()}/profile-tags`
    );
    expect(missingTagMember.status).toBe(404);
    expect(((await missingTagMember.json()) as ErrorBody).error.code).toBe('MEMBER_NOT_FOUND');
  });
});
