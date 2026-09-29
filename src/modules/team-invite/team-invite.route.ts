import { resolve } from 'node:path';

import { Elysia } from 'elysia';

import { env } from '@/config/env';

import type { TeamInviteAssociationConfig } from './team-invite.config';

const unavailableResponse = () =>
  Response.json(
    { error: 'Team invite app links are not configured on this Server.' },
    { status: 503, headers: { 'cache-control': 'no-store' } }
  );

export const createTeamInviteRoute = (config: TeamInviteAssociationConfig) =>
  new Elysia({ name: 'team-invite-route' })
    .get(
      '/invite/team',
      () =>
        new Response(Bun.file(resolve(process.cwd(), 'public/invite/team.html')), {
          headers: {
            'cache-control': 'no-store',
            'referrer-policy': 'no-referrer',
            'x-content-type-options': 'nosniff',
            'x-robots-tag': 'noindex, nofollow',
          },
        }),
      { detail: { hide: true } }
    )
    .get('/invite/team.css', () => Bun.file(resolve(process.cwd(), 'public/invite/team.css')), {
      detail: { hide: true },
    })
    .get('/invite/team.js', () => Bun.file(resolve(process.cwd(), 'public/invite/team.js')), {
      detail: { hide: true },
    })
    .get(
      '/.well-known/assetlinks.json',
      () => {
        if (!config.androidTargets?.length) return unavailableResponse();
        return Response.json(
          config.androidTargets.map((target) => ({
            relation: ['delegate_permission/common.handle_all_urls'],
            target: {
              namespace: 'android_app',
              package_name: target.packageName,
              sha256_cert_fingerprints: target.sha256CertFingerprints,
            },
          })),
          { headers: { 'cache-control': 'public, max-age=300' } }
        );
      },
      { detail: { hide: true } }
    )
    .get(
      '/.well-known/apple-app-site-association',
      () => {
        if (!config.appleAppIds?.length) return unavailableResponse();
        return Response.json(
          {
            applinks: {
              apps: [],
              details: config.appleAppIds.map((appID) => ({
                appID,
                paths: ['/invite/team'],
              })),
            },
          },
          { headers: { 'cache-control': 'public, max-age=300' } }
        );
      },
      { detail: { hide: true } }
    );

export const teamInviteRoute = createTeamInviteRoute({
  androidTargets: env.androidAppLinkTargets,
  appleAppIds: env.iosAppLinkAppIds,
});
