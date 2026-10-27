import { DAY, issueLegacySession, storedGrant, setTestGrantExpiry, revokeTestGrant } from './oauth-legacy-session.ts';
import { exports } from 'cloudflare:workers';
import { generateKeyPair, SignJWT } from 'jose';
import { describe, test } from 'vitest';
import { accessIssuer, verifyAccessJwt, requireOwner, isOwnerEmail, authenticateAccess } from '../src/access.ts';

const BASE = 'https://localhost:8787';
const RESOURCE = `${BASE}/mcp`;
const CALLBACK = 'http://127.0.0.1:6276/oauth/callback';
const EMAIL = 'owner@example.com';

type Json = Record<string, any>;

async function request(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(new Request(`${BASE}${path}`, init));
}

async function json(response: Response): Promise<Json> {
  return (await response.json()) as Json;
}

function form(values: Record<string, string>): URLSearchParams {
  return new URLSearchParams(values);
}

async function challenge(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  let binary = '';
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

async function registerClient(name = 'MCP Inspector test'): Promise<Json> {
  return json(
    await request('/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: name,
        redirect_uris: [CALLBACK],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        application_type: 'native',
      }),
    }),
  );
}

function authorizationPath(clientId: string, verifierChallenge: string, scopes: string): string {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CALLBACK,
    state: 'state-123',
    code_challenge: verifierChallenge,
    code_challenge_method: 'S256',
    resource: RESOURCE,
    scope: scopes,
  });
  return `/authorize?${query}`;
}

async function authorize(clientId: string, scopes = 'health:read offline_access') {
  const verifier = `verifier-${'x'.repeat(50)}`;
  const path = authorizationPath(clientId, await challenge(verifier), scopes);
  const consent = await request(path, { headers: { 'X-Local-Access-Email': EMAIL } });
  const html = await consent.text();
  const csrf = /name="csrf_token" value="([^"]+)"/.exec(html)?.[1];
  if (!csrf) throw new Error('Consent did not produce CSRF state');

  const approved = await request(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: BASE,
      'X-Local-Access-Email': EMAIL,
    },
    body: form({ csrf_token: csrf, decision: 'approve' }),
    redirect: 'manual',
  });
  const redirect = new URL(approved.headers.get('Location') ?? '');
  return { verifier, code: redirect.searchParams.get('code') ?? '', redirect, path };
}

async function exchangeCode(clientId: string, code: string, verifier: string): Promise<{ response: Response; body: Json }> {
  const response = await request('/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({
      grant_type: 'authorization_code',
      client_id: clientId,
      redirect_uri: CALLBACK,
      code,
      code_verifier: verifier,
      resource: RESOURCE,
    }),
  });
  return { response, body: await json(response) };
}

async function rpc(accessToken: string, method: string, params?: unknown): Promise<{ response: Response; body: Json }> {
  const response = await request('/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': '2026-07-28',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) }),
  });
  return { response, body: await json(response) };
}

async function refresh(clientId: string, refreshToken: string, scope = 'offline_access') {
  const response = await request('/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: refreshToken,
      resource: RESOURCE,
      scope,
    }),
  });
  return { response, body: await json(response) };
}

describe.sequential('OAuth 2.1 Worker integration', () => {
  test('OAuth write grant can preview but read-only grants cannot write', async ({ expect }) => {
    const client = await registerClient('write permission test');
    const auth = await authorize(client.client_id, 'health:write offline_access');
    const token = await exchangeCode(client.client_id, auth.code, auth.verifier);
    expect(token.response.status).toBe(200);
    const preview = await rpc(token.body.access_token, 'tools/call', { name: 'log_health_record', arguments: {
      data_type: 'hydration-log', confirm: false,
      record_json: JSON.stringify({ interval: { startTime: '2026-10-20T10:00:00Z', endTime: '2026-10-20T10:00:00Z' }, amountConsumed: { milliliters: 250 } }),
    } });
    expect(preview.body.result.structuredContent.preview).toBe(true);
    const read = await rpc(token.body.access_token, 'tools/call', { name: 'list_health_data_types', arguments: {} });
    expect(read.body.result.isError).toBe(true);
    expect(read.body.result.structuredContent.required_scope).toBe('health:read');
  });


  test('issues a 90-day grant and renews its record and KV lifetime for 90 days', async ({ expect }) => {
    const client = await registerClient('90-day lifetime');
    const auth = await authorize(client.client_id);
    const token = await exchangeCode(client.client_id, auth.code, auth.verifier);
    expect(token.response.status).toBe(200);
    const initial = await storedGrant(client.client_id);
    expect(initial.grant.expiresAt - Math.floor(Date.now() / 1000)).toBeCloseTo(90 * DAY, -1);
    expect(initial.key.expiration).toBe(initial.grant.expiresAt);

    // A successful refresh must renew both logical expiry and physical KV TTL.
    await setTestGrantExpiry(client.client_id, Math.floor(Date.now() / 1000) + DAY);
    const rotated = await refresh(client.client_id, token.body.refresh_token, 'health:read offline_access');
    expect(rotated.response.status).toBe(200);
    expect(rotated.body.expires_in).toBe(3600);
    expect(rotated.body.refresh_token).not.toBe(token.body.refresh_token);
    const renewed = await storedGrant(client.client_id);
    expect(renewed.grant.expiresAt - Math.floor(Date.now() / 1000)).toBeCloseTo(90 * DAY, -1);
    expect(renewed.key.expiration).toBe(renewed.grant.expiresAt);
    expect((await rpc(rotated.body.access_token, 'tools/list')).response.status).toBe(200);
  });

  test('keeps 0.10.3 access/refresh tokens usable and upgrades their fixed expiry on refresh', async ({ expect }) => {
    const old = await issueLegacySession('health:read offline_access', EMAIL);
    const initial = await storedGrant(old.clientId);
    expect(initial.grant.expiresAt - Math.floor(Date.now() / 1000)).toBeCloseTo(30 * DAY, -1);
    expect((await rpc(old.access_token, 'tools/list')).response.status).toBe(200);
    await setTestGrantExpiry(old.clientId, Math.floor(Date.now() / 1000) + DAY);
    const rotated = await refresh(old.clientId, old.refresh_token, 'health:read offline_access');
    expect(rotated.response.status).toBe(200);
    const migrated = await storedGrant(old.clientId);
    expect(migrated.key.name).toBe(initial.key.name);
    expect(migrated.grant.expiresAt - Math.floor(Date.now() / 1000)).toBeCloseTo(90 * DAY, -1);
    expect(migrated.key.expiration).toBe(migrated.grant.expiresAt);
    expect((await rpc(rotated.body.access_token, 'tools/list')).response.status).toBe(200);

    // Renew again: the 90 days are not an absolute cap on the original grant.
    await setTestGrantExpiry(old.clientId, Math.floor(Date.now() / 1000) + 2 * DAY);
    const again = await refresh(old.clientId, rotated.body.refresh_token, 'health:read offline_access');
    expect(again.response.status).toBe(200);
    const renewed = await storedGrant(old.clientId);
    expect(renewed.grant.expiresAt - Math.floor(Date.now() / 1000)).toBeCloseTo(90 * DAY, -1);
    expect(renewed.key.expiration).toBe(renewed.grant.expiresAt);
  });

  test('sliding expiry never revives expired or revoked legacy grants', async ({ expect }) => {
    for (const state of ['expired', 'revoked']) {
      const old = await issueLegacySession('health:read offline_access', EMAIL);
      if (state === 'expired') await setTestGrantExpiry(old.clientId, Math.floor(Date.now() / 1000) - 1);
      else await revokeTestGrant(old.clientId);
      const rejected = await refresh(old.clientId, old.refresh_token, 'health:read offline_access');
      expect(rejected.response.status).toBe(400);
      expect(rejected.body.error).toBe('invalid_grant');
    }
  });

  test('publishes RFC 8414, RFC 9728, CIMD, DCR, S256, and refresh metadata', async ({ expect }) => {
    const as = await json(await request('/.well-known/oauth-authorization-server'));
    expect(as.issuer).toBe(BASE);
    expect(as.authorization_endpoint).toBe(`${BASE}/authorize`);
    expect(as.token_endpoint).toBe(`${BASE}/token`);
    expect(as.registration_endpoint).toBe(`${BASE}/register`);
    expect(as.code_challenge_methods_supported).toEqual(['S256']);
    expect(as.client_id_metadata_document_supported).toBe(true);
    expect(as.grant_types_supported).toContain('refresh_token');
    expect(as.scopes_supported).toContain('offline_access');
    expect(as.authorization_response_iss_parameter_supported).toBe(true);

    // RFC 9728 metadata identifies the canonical /mcp resource, not the origin.
    expect((await request('/.well-known/oauth-protected-resource')).status).toBe(404);
    for (const path of ['/.well-known/oauth-protected-resource/mcp']) {
      const metadata = await json(await request(path));
      expect(metadata.resource).toBe(RESOURCE);
      expect(metadata.authorization_servers).toEqual([BASE]);
      expect(metadata.scopes_supported).toEqual(['health:read']);
      expect(metadata.scopes_supported).not.toContain('offline_access');
      expect(metadata.bearer_methods_supported).toEqual(['header']);
    }
  });

  test('unauthenticated MCP discovers OAuth and old path tokens stay disabled', async ({ expect }) => {
    const response = await request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toContain(
      'resource_metadata="https://localhost:8787/.well-known/oauth-protected-resource/mcp"',
    );
    expect((await request('/mcp/old-shared-token', { method: 'POST' })).status).toBe(404);
    expect((await request('/mcp-other', { method: 'POST' })).status).toBe(404);
    expect((await request('/mcp?access_token=old-shared-token', { method: 'POST' })).status).toBe(401);
    expect((await exports.default.fetch(new Request('http://alternate.test/health'))).status).toBe(421);
  });

  test('runs DCR → Access identity → consent → code+S256 → token → MCP → refresh end to end', async ({ expect }) => {
    const client = await registerClient();
    expect(client.client_id).toBeTypeOf('string');
    expect(client.token_endpoint_auth_method).toBe('none');
    expect(client.client_secret).toBeUndefined();

    const auth = await authorize(client.client_id);
    expect(auth.redirect.origin + auth.redirect.pathname).toBe(CALLBACK);
    expect(auth.redirect.searchParams.get('state')).toBe('state-123');
    expect(auth.redirect.searchParams.get('iss')).toBe(BASE);
    expect(auth.code).not.toBe('');

    const token = await exchangeCode(client.client_id, auth.code, auth.verifier);
    expect(token.response.status).toBe(200);
    expect(token.body.token_type).toBe('bearer');
    expect(token.body.expires_in).toBe(3600);
    expect(token.body.resource).toBe(RESOURCE);
    expect(token.body.refresh_token).toBeTypeOf('string');

    const initialized = await rpc(token.body.access_token, 'initialize', { protocolVersion: '2026-07-28' });
    expect(initialized.response.status).toBe(200);
    expect(initialized.body.result.protocolVersion).toBe('2026-07-28');

    const listed = await rpc(token.body.access_token, 'tools/list');
    expect(listed.body.result.tools.map((tool: Json) => tool.name)).toEqual([
      'get_health_summary',
      'get_steps_by_day',
      'get_sleep',
      'get_workouts',
      'get_body_metrics',
      'list_health_data_types',
      'query_health_data',
      'aggregate_health_data',
      'get_health_report', 'get_nutrition_summary', 'get_workout_details', 'export_workout_tcx',
      'get_health_devices', 'get_health_account', 'get_health_connection_status', 'log_health_record',
    ]);
    const search = listed.body.result.tools[0];
    expect(search.securitySchemes).toEqual([{ type: 'oauth2', scopes: ['health:read'] }]);
    expect(search._meta.securitySchemes).toEqual(search.securitySchemes);

    const firstRefresh = await refresh(client.client_id, token.body.refresh_token);
    const refreshed = firstRefresh.body;
    expect(firstRefresh.response.status).toBe(200);
    expect(refreshed.refresh_token).toBeTypeOf('string');
    expect(refreshed.refresh_token).not.toBe(token.body.refresh_token);

    const denied = await rpc(refreshed.access_token, 'tools/call', {
      name: 'get_health_summary',
      arguments: { date: '2026-07-25' },
    });
    expect(denied.body.result.isError).toBe(true);
    expect(denied.body.result.structuredContent.required_scope).toBe('health:read');
    expect(denied.body.result._meta['mcp/www_authenticate']).toContain('error="insufficient_scope"');

    // The provider intentionally accepts one retry of the immediately previous
    // refresh token until its replacement is first used. This is a response-loss
    // recovery window, not an absolute single-use guarantee.
    const retryRefresh = await refresh(client.client_id, token.body.refresh_token);
    expect(retryRefresh.response.status).toBe(200);
    const secondRefresh = await refresh(client.client_id, retryRefresh.body.refresh_token);
    expect(secondRefresh.response.status).toBe(200);
    expect((await refresh(client.client_id, token.body.refresh_token)).response.status).toBe(400);
  });

  test('rejects missing/wrong resource, missing identity, wrong origin, CSRF, redirect, PKCE, and code replay', async ({ expect }) => {
    const client = await registerClient('negative cases');
    const verifier = `verifier-${'y'.repeat(50)}`;
    const goodChallenge = await challenge(verifier);
    const goodPath = authorizationPath(client.client_id, goodChallenge, 'health:read');

    const missingResource = goodPath.replace(`&resource=${encodeURIComponent(RESOURCE)}`, '');
    expect((await request(missingResource, { headers: { 'X-Local-Access-Email': EMAIL } })).status).toBe(400);
    const wrongResource = goodPath.replace(encodeURIComponent(RESOURCE), encodeURIComponent(`${BASE}/other`));
    expect((await request(wrongResource, { headers: { 'X-Local-Access-Email': EMAIL } })).status).toBe(400);
    expect((await request(goodPath)).status).toBe(401);
    expect((await request(goodPath, { headers: { 'X-Local-Access-Email': 'someone-else@example.com' } })).status).toBe(401);

    const badRedirect = goodPath.replace(encodeURIComponent(CALLBACK), encodeURIComponent('https://evil.example/cb'));
    expect((await request(badRedirect, { headers: { 'X-Local-Access-Email': EMAIL } })).status).toBe(400);

    const plain = goodPath.replace('code_challenge_method=S256', 'code_challenge_method=plain');
    const plainResponse = await request(plain, { headers: { 'X-Local-Access-Email': EMAIL }, redirect: 'manual' });
    expect(plainResponse.status).toBe(302);
    expect(new URL(plainResponse.headers.get('Location') ?? '').searchParams.get('error')).toBe('invalid_request');

    const consent = await request(goodPath, { headers: { 'X-Local-Access-Email': EMAIL } });
    const html = await consent.text();
    const csrf = /name="csrf_token" value="([^"]+)"/.exec(html)?.[1] ?? '';
    expect(consent.headers.get('Content-Security-Policy')).not.toContain('form-action');

    const accessLoginReturn = await request(goodPath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: 'https://team.cloudflareaccess.com',
        'X-Local-Access-Email': EMAIL,
      },
      body: form({ access_login_return: 'ignored' }),
    });
    expect(accessLoginReturn.status).toBe(200);
    expect(await accessLoginReturn.text()).toContain('Authorize this MCP client?');

    expect(
      (
        await request(goodPath, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Origin: 'http://evil.example',
            'X-Local-Access-Email': EMAIL,
          },
          body: form({ csrf_token: csrf, decision: 'approve' }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(goodPath, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Origin: BASE,
            'X-Local-Access-Email': EMAIL,
          },
          body: form({ csrf_token: 'wrong', decision: 'approve' }),
        })
      ).status,
    ).toBe(403);

    const consumed = await request(goodPath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: BASE,
        'X-Local-Access-Email': EMAIL,
      },
      body: form({ csrf_token: csrf, decision: 'invalid' }),
    });
    expect(consumed.status).toBe(400);
    const replayedConsent = await request(goodPath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: BASE,
        'X-Local-Access-Email': EMAIL,
      },
      body: form({ csrf_token: csrf, decision: 'approve' }),
    });
    expect(replayedConsent.status).toBe(403);

    const fallbackConsent = await request(goodPath, { headers: { 'X-Local-Access-Email': EMAIL } });
    const fallbackHtml = await fallbackConsent.text();
    const fallbackCsrf = /name="csrf_token" value="([^"]+)"/.exec(fallbackHtml)?.[1] ?? '';
    const browserWithoutOrigin = await request(goodPath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Dest': 'document',
        'X-Local-Access-Email': EMAIL,
      },
      body: form({ csrf_token: fallbackCsrf, decision: 'deny' }),
      redirect: 'manual',
    });
    expect(browserWithoutOrigin.status).toBe(302);
    expect(new URL(browserWithoutOrigin.headers.get('Location') ?? '').searchParams.get('error')).toBe(
      'access_denied',
    );

    const auth = await authorize(client.client_id, 'health:read');
    const wrongVerifier = await exchangeCode(client.client_id, auth.code, `wrong-${'z'.repeat(50)}`);
    expect(wrongVerifier.response.status).toBe(400);
    expect(wrongVerifier.body.error).toBe('invalid_grant');
    const valid = await exchangeCode(client.client_id, auth.code, auth.verifier);
    expect(valid.response.status).toBe(200);
    const replay = await exchangeCode(client.client_id, auth.code, auth.verifier);
    expect(replay.response.status).toBe(400);
    expect(replay.body.error).toBe('invalid_grant');

    const noResource = await request('/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: valid.body.refresh_token }),
    });
    expect(noResource.status).toBe(400);
    expect((await json(noResource)).error).toBe('invalid_target');
  });

  test('escapes untrusted client metadata and returns a safe consent denial', async ({ expect }) => {
    const client = await registerClient('<img src=x onerror=alert(1)>');
    const verifier = `verifier-${'q'.repeat(50)}`;
    const path = authorizationPath(client.client_id, await challenge(verifier), 'health:read');
    const consent = await request(path, { headers: { 'X-Local-Access-Email': EMAIL } });
    const html = await consent.text();
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    const csrf = /name="csrf_token" value="([^"]+)"/.exec(html)?.[1] ?? '';
    const denied = await request(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: BASE,
        'X-Local-Access-Email': EMAIL,
      },
      body: form({ csrf_token: csrf, decision: 'deny' }),
      redirect: 'manual',
    });
    const location = new URL(denied.headers.get('Location') ?? '');
    expect(location.origin + location.pathname).toBe(CALLBACK);
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.get('state')).toBe('state-123');
    expect(location.searchParams.get('iss')).toBe(BASE);
  });
});

describe('Cloudflare Access assertion validation', () => {
  test('accepts only an app JWT with exact issuer, audience, subject, and email', async ({ expect }) => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const issuer = 'https://team.cloudflareaccess.com';
    const audience = 'access-app-aud';
    const token = await new SignJWT({ email: 'Owner@Example.com', type: 'app' })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject('access-user-123')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);

    await expect(verifyAccessJwt(token, issuer, audience, publicKey)).resolves.toEqual({
      subject: 'access-user-123',
      email: 'owner@example.com',
      issuer,
    });
    await expect(verifyAccessJwt(token, issuer, 'wrong-audience', publicKey)).rejects.toThrow();

    const serviceToken = await new SignJWT({ type: 'service' })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject('service')
      .setExpirationTime('5m')
      .sign(privateKey);
    await expect(verifyAccessJwt(serviceToken, issuer, audience, publicKey)).rejects.toThrow();
    expect(accessIssuer('team.cloudflareaccess.com')).toBe(issuer);
    expect(() => accessIssuer('evil.example')).toThrow();
  });
});


describe('Owner-only health access', () => {
  test('fails closed for missing owner and rejects other identities', async ({ expect }) => {
    const identity = { subject: 'owner', email: 'owner@example.com', issuer: BASE };
    expect(requireOwner(identity, { OWNER_EMAIL: 'Owner@Example.com' })).toBe(identity);
    expect(() => requireOwner(identity, { OWNER_EMAIL: '' })).toThrow();
    expect(() => requireOwner({ ...identity, email: 'attacker@example.com' }, { OWNER_EMAIL: identity.email })).toThrow();
    expect(isOwnerEmail('owner@example.com.evil', identity.email)).toBe(false);
    expect(isOwnerEmail(undefined, identity.email)).toBe(false);
    await expect(authenticateAccess(new Request('https://public.example/authorize', {
      headers: { 'X-Local-Access-Email': identity.email },
    }), { PUBLIC_BASE_URL: 'https://public.example', LOCAL_DEV_IDENTITY: '1', OWNER_EMAIL: identity.email })).rejects.toThrow();
  });
});
