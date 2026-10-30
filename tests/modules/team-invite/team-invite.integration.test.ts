import {
  parseAndroidAppLinkTargets,
  parseAppleAppLinkIds,
} from '@/modules/team-invite/team-invite.config';
import { createTeamInviteRoute } from '@/modules/team-invite/team-invite.route';

import { describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';

const configuredApp = new Elysia().use(
  createTeamInviteRoute({
    androidTargets: [
      {
        packageName: 'com.kuquest.mobile.staging',
        sha256CertFingerprints: [
          'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
        ],
      },
    ],
    appleAppIds: ['ABCDEF1234.com.kuquest.mobile.staging'],
  })
);

const unconfiguredApp = new Elysia().use(
  createTeamInviteRoute({ androidTargets: null, appleAppIds: null })
);

describe('Candidate Team invite links', () => {
  it('serves a safe browser fallback and its assets without reflecting invite parameters', async () => {
    const response = await configuredApp.handle(
      new Request('https://localhost/invite/team?code=%3Cscript%3E')
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(html).toContain('You’re invited to join a Candidate Team');
    expect(html).not.toContain('<script>');

    const assets = await Promise.all(
      ['/invite/team.css', '/invite/team.js'].map((path) =>
        configuredApp.handle(new Request(`https://localhost${path}`))
      )
    );
    expect(assets.map((asset) => asset.status)).toEqual([200, 200]);
    expect(assets.map((asset) => asset.headers.get('content-type'))).toEqual([
      expect.stringContaining('text/css'),
      expect.stringContaining('javascript'),
    ]);
  });

  it('serves Android and Apple association documents for configured app signatures', async () => {
    const [android, apple] = await Promise.all([
      configuredApp.handle(new Request('https://localhost/.well-known/assetlinks.json')),
      configuredApp.handle(new Request('https://localhost/.well-known/apple-app-site-association')),
    ]);

    expect(android.status).toBe(200);
    expect(android.headers.get('content-type')).toContain('application/json');
    expect(await android.json()).toEqual([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: 'com.kuquest.mobile.staging',
          sha256_cert_fingerprints: [
            'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
          ],
        },
      },
    ]);

    expect(apple.status).toBe(200);
    expect(apple.headers.get('content-type')).toContain('application/json');
    expect(await apple.json()).toEqual({
      applinks: {
        apps: [],
        details: [
          {
            appID: 'ABCDEF1234.com.kuquest.mobile.staging',
            paths: ['/invite/team'],
          },
        ],
      },
    });
  });

  it('does not publish incomplete association documents', async () => {
    const [android, apple] = await Promise.all([
      unconfiguredApp.handle(new Request('https://localhost/.well-known/assetlinks.json')),
      unconfiguredApp.handle(
        new Request('https://localhost/.well-known/apple-app-site-association')
      ),
    ]);

    expect(android.status).toBe(503);
    expect(apple.status).toBe(503);
    expect(android.headers.get('cache-control')).toBe('no-store');
  });

  it('accepts only complete Android certificates and Apple application identifiers', () => {
    expect(
      parseAndroidAppLinkTargets(
        '[{"packageName":"com.kuquest.mobile.debug","sha256CertFingerprints":["AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99"]}]'
      )
    ).toHaveLength(1);
    expect(
      parseAndroidAppLinkTargets(
        '[{"packageName":"com.kuquest.mobile.debug","sha256CertFingerprints":["debug"]}]'
      )
    ).toBeNull();
    expect(parseAppleAppLinkIds('ABCDEF1234.com.kuquest.mobile')).toEqual([
      'ABCDEF1234.com.kuquest.mobile',
    ]);
    expect(parseAppleAppLinkIds('TEAMID.com.kuquest.mobile')).toBeNull();
  });
});
