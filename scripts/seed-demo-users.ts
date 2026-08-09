import { env } from '@/config/env';
import { db, sql } from '@/database/client';
import { department, occupation } from '@/database/schema/academic.schema';
import { authUser } from '@/database/schema/auth.schema';
import { profileCertificate, profilePortfolioItem } from '@/database/schema/profile.schema';
import { defaultCookieAttributes } from '@/modules/auth/auth.config.shared';

import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { testUtils } from 'better-auth/plugins';
import { eq } from 'drizzle-orm';

import * as schema from '@/database/schema/auth.schema';

const DEMO_USERS = [
  { firstName: 'Nattapong', lastName: 'Srisawat', department: 'Software and Knowledge Engineering' },
  { firstName: 'Warisara', lastName: 'Boonmee', department: 'Marketing' },
  { firstName: 'Thanakrit', lastName: 'Chaiyasit', department: 'Economics' },
  { firstName: 'Supitcha', lastName: 'Wongsakul', department: 'Bachelor of Accountancy' },
  { firstName: 'Kritchapon', lastName: 'Phromma', department: 'Tropical Agriculture' },
  { firstName: 'Aphinya', lastName: 'Sukjai', department: 'Integrated Tourism Management' },
  { firstName: 'Pattarapon', lastName: 'Ruangrit', department: 'Business Administration' },
  { firstName: 'Chutimon', lastName: 'Thepsuriya', department: 'Communicative Thai Language for Foreigners' },
  { firstName: 'Ekkapop', lastName: 'Wattana', department: 'Entrepreneurial Economics' },
  { firstName: 'Nichakan', lastName: 'Kaewmanee', department: 'Marketing' },
] as const;

const CERTIFICATES = [
  { name: 'AWS Certified Cloud Practitioner', issuer: 'Amazon Web Services' },
  { name: 'Google Data Analytics', issuer: 'Google' },
  { name: 'Meta Front-End Developer', issuer: 'Meta' },
];

const PORTFOLIO_ITEMS = [
  { title: 'Campus Event Booking App', description: 'A React Native app for booking KU campus events.' },
  { title: 'Data Visualization Dashboard', description: 'Dashboard for analysing student club participation.' },
];

const seedAuth = betterAuth({
  appName: 'KUQuest',
  baseURL: env.betterAuthUrl || 'http://localhost:5000',
  secret: env.betterAuthSecret || 'seed-only-secret-not-used-in-production!',
  database: drizzleAdapter(db, { provider: 'pg', schema }),
  user: {
    modelName: 'authUser',
    fields: { name: 'firstName' },
    additionalFields: {
      firstName: { type: 'string', required: true },
      lastName: { type: 'string', required: true },
    },
  },
  session: { modelName: 'authSession' },
  account: { modelName: 'authAccount' },
  verification: { modelName: 'authVerification' },
  advanced: { defaultCookieAttributes },
  plugins: [testUtils()],
});

const main = async (): Promise<void> => {
  const departments = await db.select().from(department);
  const [studentOccupation] = await db
    .select()
    .from(occupation)
    .where(eq(occupation.name, 'Student'))
    .limit(1);

  if (!studentOccupation) throw new Error('Seed the academic options before running this script');

  const ctx = await seedAuth.$context;
  const results: { email: string; name: string; cookie: string }[] = [];

  for (const [index, demo] of DEMO_USERS.entries()) {
    const email = `${demo.firstName.toLowerCase()}.${demo.lastName.toLowerCase()}@ku.th`;
    const dept = departments.find((d) => d.name === demo.department);
    if (!dept) throw new Error(`No seeded department named "${demo.department}"`);
    const studentId = `65${String(1000000 + index).padStart(8, '0')}`;

    const [user] = await db
      .insert(authUser)
      .values({
        id: crypto.randomUUID(),
        email,
        emailVerified: true,
        firstName: demo.firstName,
        lastName: demo.lastName,
        bio: `Hi, I'm ${demo.firstName}, studying ${demo.department} at KU.`,
        telephone: `08${String(10000000 + index).padStart(8, '0')}`,
        studentId,
        departmentId: dept?.id,
        academicYear: 2565 + (index % 4),
        occupationId: studentOccupation.id,
        termsAcceptedAt: new Date(),
        termsVersion: '1.0',
      })
      .returning();

    if (!user) throw new Error(`Failed to insert demo user ${email}`);

    const certCount = 1 + (index % 3);
    for (let i = 0; i < certCount; i++) {
      const cert = CERTIFICATES[i % CERTIFICATES.length];
      if (!cert) continue;
      await db.insert(profileCertificate).values({
        userId: user.id,
        name: cert.name,
        issuer: cert.issuer,
        issuedAt: `202${2 + (i % 3)}-0${1 + (i % 9)}-01`,
      });
    }

    if (index % 2 === 0) {
      const item = PORTFOLIO_ITEMS[index % PORTFOLIO_ITEMS.length];
      if (item) {
        await db.insert(profilePortfolioItem).values({
          userId: user.id,
          title: item.title,
          description: item.description,
        });
      }
    }

    const headers = await ctx.test.getAuthHeaders({ userId: user.id });
    const cookie = headers.get('cookie') ?? '';

    results.push({ email, name: `${demo.firstName} ${demo.lastName}`, cookie });
  }

  console.log('Seeded demo users:\n');
  for (const r of results) {
    console.log(`${r.name} <${r.email}>`);
    console.log(`  Cookie: ${r.cookie}\n`);
  }
};

try {
  await main();
} finally {
  await sql.end();
}
