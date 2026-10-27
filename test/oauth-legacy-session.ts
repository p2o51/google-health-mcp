import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { OAuthProvider, type OAuthHelpers } from '@cloudflare/workers-oauth-provider-legacy';

const BASE = 'https://localhost:8787';
const RESOURCE = `${BASE}/mcp`;
const CALLBACK = 'http://127.0.0.1:6276/oauth/callback';
export const DAY = 86_400;

interface LegacyEnv {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
}

/** Real 0.10.3 tokens in Miniflare's isolated KV; no production data or credentials. */
export async function issueLegacySession(scope: string, email: string) {
  const provider = new OAuthProvider<LegacyEnv>({
    apiRoute: '/mcp',
    apiHandler: { fetch: async () => new Response('ok') },
    defaultHandler: {
      async fetch(request, testEnv) {
        const auth = await testEnv.OAUTH_PROVIDER.parseAuthRequest(request);
        const userId = `legacy-test-${crypto.randomUUID()}`;
        const { redirectTo } = await testEnv.OAUTH_PROVIDER.completeAuthorization({
          request: auth,
          userId,
          metadata: { clientName: '0.10.3 migration test' },
          scope: scope.split(' '),
          props: { userId, email, accessSubject: userId, accessIssuer: 'test' },
        });
        return new Response(null, { status: 302, headers: { Location: redirectTo } });
      },
    },
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/token',
    clientRegistrationEndpoint: '/register',
    resourceMetadata: { resource: RESOURCE },
    allowPlainPKCE: false,
    allowImplicitFlow: false,
    accessTokenTTL: 3600,
    refreshTokenTTL: 30 * DAY,
    clientRegistrationTTL: 365 * DAY,
  });
  const testEnv = { OAUTH_KV: env.OAUTH_KV } as LegacyEnv;
  async function legacyRequest(path: string, init?: RequestInit) {
    const ctx = createExecutionContext();
    const response = await provider.fetch(new Request(`${BASE}${path}`, init), testEnv, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  }
  const registered = await legacyRequest('/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: '0.10.3 migration test', redirect_uris: [CALLBACK],
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  const client = await registered.json() as { client_id: string };
  const verifier = 'migration-verifier-'.padEnd(64, 'x');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const challenge = btoa(String.fromCharCode(...digest)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  const consent = await legacyRequest(`/authorize?${new URLSearchParams({
    response_type: 'code', client_id: client.client_id, redirect_uri: CALLBACK,
    state: 'migration-state', code_challenge: challenge, code_challenge_method: 'S256',
    resource: RESOURCE, scope,
  })}`);
  const code = new URL(consent.headers.get('Location')!).searchParams.get('code')!;
  const exchanged = await legacyRequest('/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', client_id: client.client_id, redirect_uri: CALLBACK,
      code, code_verifier: verifier, resource: RESOURCE,
    }),
  });
  if (exchanged.status !== 200) throw new Error(`Legacy token issuance failed: ${exchanged.status}`);
  return { clientId: client.client_id, ...await exchanged.json() as { access_token: string; refresh_token: string } };
}

export async function storedGrant(clientId: string) {
  const listed = await env.OAUTH_KV.list({ prefix: 'grant:' });
  for (const key of listed.keys) {
    const grant = await env.OAUTH_KV.get<Record<string, any>>(key.name, 'json');
    if (grant?.clientId === clientId) return { key, grant };
  }
  throw new Error('Test grant was not found');
}

/** Emulates an old/expired grant in the test-only KV without waiting days. */
export async function setTestGrantExpiry(clientId: string, expiresAt: number) {
  const { key, grant } = await storedGrant(clientId);
  await env.OAUTH_KV.put(key.name, JSON.stringify({ ...grant, expiresAt }), { expirationTtl: 600 });
}

export async function revokeTestGrant(clientId: string) {
  const { key } = await storedGrant(clientId);
  await env.OAUTH_KV.delete(key.name);
}
