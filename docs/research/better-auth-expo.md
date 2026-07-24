# Better Auth 1.6.23 and Expo

Research date: 2026-07-23

## Conclusion

Better Auth supports both Expo native applications and Expo web applications through
the official `@better-auth/expo` integration. The `better-auth` version locked by this
repository is `1.6.23`, and the official Expo package is also published at `1.6.23`, so
the matching package pair is available. The current Better Auth Expo guide targets Expo
SDK 55 and says that SDK 53+ has the Metro package-exports support that Better Auth
requires. [Better Auth Expo integration guide](https://better-auth.com/docs/integrations/expo)
and [`@better-auth/expo` 1.6.23 package](https://www.npmjs.com/package/%40better-auth/expo)

This repository is **not currently configured for Expo**, despite using a compatible
Better Auth version:

- `package.json` contains `better-auth` but not `@better-auth/expo`.
- `src/modules/auth/auth.config.ts` does not add the server-side `expo()` plugin.
- `trustedOrigins` contains only the CMS HTTP origin, not an Expo custom URL scheme.
- `src/plugins/cors.ts` permits only the CMS origin; an Expo web origin would also need
  to be allowed if the same API is used from Expo web.

No new session route is required. The existing mounted `auth.handler` continues to
provide Better Auth routes such as `get-session`; Expo changes how the native client
performs OAuth and persists/sends the session cookie.

## Required server changes

Install the Expo package alongside Better Auth, keeping their versions aligned:

```sh
bun add @better-auth/expo@1.6.23
```

Add its server plugin and trust the application's deep-link scheme:

```ts
import { expo } from '@better-auth/expo';

export const auth = betterAuth({
  // Existing KUQuest configuration...
  plugins: [expo()],
  trustedOrigins: [
    env.cmsOrigin || 'http://localhost:3000',
    'kuquest://',
  ],
});
```

The official integration requires `expo()` on the Better Auth server and requires the
app scheme to be included in `trustedOrigins`. Broad `exp://` wildcards are documented
only for development; production should trust the app's specific scheme.
[Server plugin and trusted-origin configuration](https://better-auth.com/docs/integrations/expo#add-the-expo-plugin-on-your-server)

The repository can keep its existing Elysia `auth.handler` mount. Better Auth supports
using a separate backend, so the auth server does not need to move into Expo API Routes.
[Backend choices](https://better-auth.com/docs/integrations/expo#configure-a-better-auth-backend)

If the Expo app also targets the web, its web origin must be added to both Better Auth's
trusted origins and the API's CORS allowlist. Native React Native traffic is not governed
by browser CORS, but Better Auth still validates OAuth callback origins/schemes.

## Required Expo client setup

The Expo application needs:

```sh
npx expo install better-auth @better-auth/expo expo-network expo-secure-store
npx expo install expo-linking expo-web-browser expo-constants
```

The final three packages are needed for social-provider browser flows when they are not
already supplied by the chosen Expo template. The official guide requires
`expo-network` and `expo-secure-store`, and identifies the linking, web-browser, and
constants packages for social authentication.
[Client dependencies](https://better-auth.com/docs/integrations/expo#install-client-dependencies)

Configure a stable app scheme:

```json
{
  "expo": {
    "scheme": "kuquest"
  }
}
```

Then create the Better Auth client:

```ts
import { expoClient } from '@better-auth/expo/client';
import { createAuthClient } from 'better-auth/react';
import * as SecureStore from 'expo-secure-store';

export const authClient = createAuthClient({
  baseURL: 'https://api.example.com',
  plugins: [
    expoClient({
      scheme: 'kuquest',
      storagePrefix: 'kuquest',
      storage: SecureStore,
    }),
  ],
});
```

`expoClient` handles the social-auth browser and callback flow, stores Better Auth
cookies securely, and attaches them to Better Auth client requests. Better Auth also
caches native session data in SecureStore by default; `disableCache: true` disables
that cache. [Client initialization and secure-cookie behavior](https://better-auth.com/docs/integrations/expo#initialize-better-auth-client)

For an installed development/production app, use a custom scheme/development build.
Expo advises using a development build with a custom scheme rather than Expo Go for
flows, such as authentication, that require a stable callback URL.
[Expo linking guidance](https://docs.expo.dev/linking/into-other-apps/)

## Google OAuth flow

The Expo client can use Better Auth's browser-based Google flow:

```ts
const { error } = await authClient.signIn.social({
  provider: 'google',
  callbackURL: '/dashboard',
});

if (!error) {
  router.replace('/dashboard');
}
```

On native, the Expo plugin converts the relative callback path to an app deep link,
opens and completes the browser flow, and resolves the call without navigating the
Expo Router automatically. The app performs its own navigation after the promise
resolves. [Better Auth social sign-in for Expo](https://better-auth.com/docs/integrations/expo#social-sign-in)

There are two different callback URLs in this flow:

1. Google redirects to the Better Auth backend, normally
   `https://api.example.com/api/auth/callback/google`. This remains the authorized
   redirect URI registered in Google Cloud.
2. After Better Auth finishes creating the session, it sends the browser back to the
   Expo deep link, for example `kuquest://dashboard`.

Better Auth documents `/api/auth/callback/google` as Google's default server callback,
constructed from `baseURL`. [Better Auth Google provider setup](https://better-auth.com/docs/authentication/google)

Alternatively, an Expo app may sign in with Google's native library and pass its ID
token to `authClient.signIn.social`. Better Auth 1.6 supports Google ID-token sign-in,
and its Expo guide provides an example using
`@react-native-google-signin/google-signin`. This route needs the platform-specific
Google client configuration, but no additional Better Auth server plugin beyond the
Expo setup above. [Expo ID-token sign-in example](https://better-auth.com/docs/integrations/expo#idtoken-sign-in)

The browser-based flow is the closest match to this repository's existing Google
OAuth configuration and requires fewer provider-specific native changes.

## Session usage in Expo

Use the Better Auth client to observe or fetch the current session:

```tsx
const { data: session, isPending, error } = authClient.useSession();
```

Better Auth stores the authoritative session in this repository's PostgreSQL session
table. On Expo native, the client plugin stores the session cookie and a session cache
in SecureStore, rather than relying on a browser-managed cookie jar. Therefore,
`credentials: 'include'` alone is not the correct pattern for arbitrary native
`fetch` calls.

Better Auth client calls such as `useSession()`/`getSession()` are handled by the Expo
client plugin. For a custom KUQuest business endpoint, obtain the cookie from the
client and set it explicitly:

```ts
const response = await fetch(`${API_URL}/api/quests`, {
  headers: {
    Cookie: authClient.getCookie(),
  },
  credentials: 'omit',
});
```

The official guide explicitly recommends manually adding `authClient.getCookie()` to
the `Cookie` header for custom authenticated server requests and using
`credentials: "omit"` because `include` can interfere with that explicit header.
[Authenticated native requests](https://better-auth.com/docs/integrations/expo#making-authenticated-requests-to-your-server)

The API must still validate this cookie on every protected business endpoint with the
same server-side session check it uses for web clients. SecureStore improves client-side
storage; it does not replace the database session or server authorization.

## Practical constraints

- Use a backend URL reachable from the phone/emulator. A physical device cannot reach
  a development server through the device's own `localhost`; use a LAN-reachable or
  public HTTPS development URL as appropriate.
- Keep Google secrets on the API server. Expo's authentication documentation warns
  that secret keys must not be embedded in application code.
  [Expo AuthSession security guidance](https://docs.expo.dev/versions/latest/sdk/auth-session/#security-considerations)
- Register the API's exact Better Auth Google callback URL in Google Cloud, and ensure
  `baseURL` is correct, or Google will reject it with `redirect_uri_mismatch`.
  [Better Auth Google redirect configuration](https://better-auth.com/docs/authentication/google)
- Use narrow production trusted origins (`kuquest://` or the production universal-link
  domain). Better Auth says `exp://` wildcard patterns are development-only.
  [Better Auth development-origin warning](https://better-auth.com/docs/integrations/expo#development-mode)
- For Expo SDK 53+, do not disable Metro package exports. The current official guide is
  specifically written for SDK 55 and the New Architecture.
  [Metro and Expo SDK compatibility](https://better-auth.com/docs/integrations/expo#configure-metro-bundler)

## Recommended implementation direction

Use the official `@better-auth/expo@1.6.23` server and client plugins, retain this
Elysia server and PostgreSQL session store, and initially use
`authClient.signIn.social({ provider: "google" })`. Add the Expo scheme to
`trustedOrigins`, configure the client with SecureStore, and attach
`authClient.getCookie()` to custom native API calls. This is the smallest change that
matches Better Auth's supported Expo path and the repository's existing Google OAuth
architecture.
