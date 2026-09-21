import { db, sql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { file } from '@/database/schema/file.schema';
import { profilePortfolioItem } from '@/database/schema/profile.schema';
import {
  createPortfolio,
  deletePortfolio,
  listPortfolio,
  markPortfolioImageDeleted,
  updatePortfolio,
} from '@/modules/portfolio/portfolio.service';

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';

const studentA = `test-portfolio-a-${randomUUID()}`;
const studentB = `test-portfolio-b-${randomUUID()}`;

const storedImage = (suffix: string) => ({
  bucket: 'kuquest-test',
  objectKey: `portfolio/${studentA}/${suffix}.png`,
  contentType: 'image/png' as const,
  sizeBytes: 1024,
});

beforeAll(async () => {
  try {
    await sql`select 1`;
  } catch (cause) {
    throw new Error(
      'These tests need PostgreSQL. Start it with `docker compose up -d postgres`, then apply the schema with `bun run db:migrate`.',
      { cause },
    );
  }

  await db.insert(authUser).values([
    { id: studentA, email: `${studentA}@ku.th`, firstName: 'Student', lastName: 'A' },
    { id: studentB, email: `${studentB}@ku.th`, firstName: 'Student', lastName: 'B' },
  ]);
});

afterAll(async () => {
  // Deleting the portfolio items cascades their image junction rows; the file rows
  // they pointed at are only referenced from there, so they can go afterwards.
  await db.delete(profilePortfolioItem).where(
    inArray(profilePortfolioItem.userId, [studentA, studentB]),
  );
  await db.delete(file).where(inArray(file.uploadedByUserId, [studentA, studentB]));
  await db.delete(authUser).where(inArray(authUser.id, [studentA, studentB]));
});

describe('creating a portfolio entry', () => {
  it('stores the item with its images in submitted order', async () => {
    const created = await createPortfolio(studentA, {
      title: 'Capstone project',
      description: 'A short description',
      images: [storedImage('first'), storedImage('second')],
    });

    const [items] = await listPortfolio(studentA);

    expect(items?.id).toBe(created.id);
    expect(items?.title).toBe('Capstone project');
    expect(items?.description).toBe('A short description');
    expect(items?.images.map((image) => image.position)).toEqual([0, 1]);
    expect(items?.images.map((image) => image.objectKey)).toEqual([
      `portfolio/${studentA}/first.png`,
      `portfolio/${studentA}/second.png`,
    ]);
  });

  it('accepts an entry with no images', async () => {
    const created = await createPortfolio(studentA, { title: 'No images', images: [] });

    const items = await listPortfolio(studentA);
    const item = items.find((candidate) => candidate.id === created.id);

    expect(item?.images).toEqual([]);
  });

  it('stores no description when none is given', async () => {
    const created = await createPortfolio(studentA, { title: 'Untitled work', images: [] });

    const items = await listPortfolio(studentA);
    const item = items.find((candidate) => candidate.id === created.id);

    expect(item?.description).toBeNull();
  });
});

describe('listing a portfolio', () => {
  it('returns entries ordered by creation, oldest first', async () => {
    const first = await createPortfolio(studentB, { title: 'Older', images: [] });
    const second = await createPortfolio(studentB, { title: 'Newer', images: [] });

    const items = await listPortfolio(studentB);

    expect(items.map((item) => item.id)).toEqual([first.id, second.id]);
  });

  it('never returns another student entry', async () => {
    const items = await listPortfolio(studentB);

    expect(items.every((item) => item.title !== 'Capstone project')).toBe(true);
  });

  it('returns nothing for a student with no entries', async () => {
    expect(await listPortfolio(randomUUID())).toEqual([]);
  });
});

describe('updating a portfolio entry', () => {
  it('changes only the fields included in the request', async () => {
    const created = await createPortfolio(studentA, {
      title: 'Original title',
      description: 'Original description',
      images: [],
    });

    expect(await updatePortfolio(studentA, created.id, { title: 'Updated title' })).toBe(
      'updated',
    );

    const item = (await listPortfolio(studentA)).find((candidate) => candidate.id === created.id);
    expect(item?.title).toBe('Updated title');
    expect(item?.description).toBe('Original description');
  });

  it('reports success without changing anything when the body is empty', async () => {
    const created = await createPortfolio(studentA, { title: 'Untouched', images: [] });

    expect(await updatePortfolio(studentA, created.id, {})).toBe('updated');

    const item = (await listPortfolio(studentA)).find((candidate) => candidate.id === created.id);
    expect(item?.title).toBe('Untouched');
  });

  it('refuses to update an entry owned by someone else', async () => {
    const created = await createPortfolio(studentA, { title: 'Owned by A', images: [] });

    expect(await updatePortfolio(studentB, created.id, { title: 'Hijacked' })).toBe('not-found');

    const item = (await listPortfolio(studentA)).find((candidate) => candidate.id === created.id);
    expect(item?.title).toBe('Owned by A');
  });

  it('reports not found for an entry that does not exist', async () => {
    expect(await updatePortfolio(studentA, randomUUID(), { title: 'Ghost' })).toBe('not-found');
  });
});

describe('deleting a portfolio entry', () => {
  it('removes the entry and returns its images for storage cleanup', async () => {
    const created = await createPortfolio(studentA, {
      title: 'To be deleted',
      images: [storedImage('to-delete')],
    });

    const result = await deletePortfolio(studentA, created.id);

    expect(result.outcome).toBe('deleted');
    expect(result.outcome === 'deleted' && result.images).toEqual([
      expect.objectContaining({ objectKey: `portfolio/${studentA}/to-delete.png` }),
    ]);

    const items = await listPortfolio(studentA);
    expect(items.some((item) => item.id === created.id)).toBe(false);
  });

  it('refuses to delete an entry owned by someone else', async () => {
    const created = await createPortfolio(studentA, { title: 'Owned by A again', images: [] });

    expect(await deletePortfolio(studentB, created.id)).toEqual({ outcome: 'not-found' });

    const items = await listPortfolio(studentA);
    expect(items.some((item) => item.id === created.id)).toBe(true);
  });

  it('reports not found for an entry that no longer exists', async () => {
    const created = await createPortfolio(studentA, { title: 'Deleted twice', images: [] });

    await deletePortfolio(studentA, created.id);

    expect(await deletePortfolio(studentA, created.id)).toEqual({ outcome: 'not-found' });
  });
});

describe('marking a portfolio image deleted', () => {
  it('tombstones only a file uploaded by the requesting student', async () => {
    const created = await createPortfolio(studentA, {
      title: 'With an image to tombstone',
      images: [storedImage('tombstone')],
    });
    const items = await listPortfolio(studentA);
    const image = items.find((item) => item.id === created.id)?.images[0];

    await markPortfolioImageDeleted(studentB, image!.fileId);
    let [row] = await db
      .select({ deletedAt: file.deletedAt })
      .from(file)
      .where(eq(file.id, image!.fileId));
    expect(row?.deletedAt).toBeNull();

    await markPortfolioImageDeleted(studentA, image!.fileId);
    [row] = await db.select({ deletedAt: file.deletedAt }).from(file).where(eq(file.id, image!.fileId));
    expect(row?.deletedAt).not.toBeNull();
  });
});
