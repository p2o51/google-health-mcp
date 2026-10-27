import {
  AuthorizationError,
  type AuthRequest,
  type OAuthHelpers,
} from '@cloudflare/workers-oauth-provider';
import {
  AccessAuthenticationError,
  authenticateAccess,
  type AccessEnv,
  type AccessIdentity,
} from './access.ts';
import { HEALTH_READ_SCOPE, HEALTH_WRITE_SCOPE } from './tools.ts';

export const OFFLINE_ACCESS_SCOPE = 'offline_access';
export const AUTHORIZATION_SCOPES = [HEALTH_READ_SCOPE, HEALTH_WRITE_SCOPE, OFFLINE_ACCESS_SCOPE] as const;
export const RESOURCE_SCOPES = [HEALTH_READ_SCOPE] as const;

export interface AuthorizationEnv extends AccessEnv {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
}

interface ConsentContext {
  oauth: AuthRequest;
  identity: AccessIdentity;
  clientName: string;
  scopes: string[];
}

const MAX_FORM_BYTES = 8_192;
const CONSENT_CSRF_TTL_SECONDS = 10 * 60;
const CONSENT_CSRF_PREFIX = 'health:oauth:consent-csrf:';

function htmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function randomToken(bytes = 32): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== 43 || b.length !== 43) return false;
  let diff = 0;
  for (let i = 0; i < 43; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  let binary = '';
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

async function consentBinding(context: ConsentContext): Promise<string> {
  return sha256Base64Url(
    JSON.stringify({
      issuer: context.identity.issuer,
      subject: context.identity.subject,
      clientId: context.oauth.clientId,
      redirectUri: context.oauth.redirectUri,
      state: context.oauth.state,
      codeChallenge: context.oauth.codeChallenge,
      codeChallengeMethod: context.oauth.codeChallengeMethod,
      resource: context.oauth.resource,
      scope: context.oauth.scope,
    }),
  );
}

async function consentCsrfKey(token: string): Promise<string> {
  return `${CONSENT_CSRF_PREFIX}${await sha256Base64Url(token)}`;
}

function oauthErrorRedirect(
  redirectUri: string,
  code: string,
  description: string,
  state?: string,
  issuer?: string,
): Response {
  const redirect = new URL(redirectUri);
  redirect.searchParams.set('error', code);
  redirect.searchParams.set('error_description', description);
  if (state) redirect.searchParams.set('state', state);
  if (issuer) redirect.searchParams.set('iss', issuer);
  return redirectResponse(redirect.toString());
}

function redirectResponse(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      'Cache-Control': 'no-store',
    },
  });
}

function authorizationError(error: AuthorizationError): Response {
  if (!error.redirectUri) {
    return text(error.description, 400);
  }
  return oauthErrorRedirect(error.redirectUri, error.code, error.description, error.state, error.issuer);
}

function text(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function requestedScopes(request: AuthRequest): string[] {
  const requested = request.scope.length ? request.scope : [HEALTH_READ_SCOPE];
  return requested.filter((scope) => (AUTHORIZATION_SCOPES as readonly string[]).includes(scope));
}

function enforceS256(oauth: AuthRequest): Response | null {
  if (oauth.codeChallenge && oauth.codeChallengeMethod === 'S256') return null;
  return oauthErrorRedirect(
    oauth.redirectUri,
    'invalid_request',
    'PKCE with code_challenge_method=S256 is required.',
    oauth.state,
    oauth.issuer,
  );
}

async function consentContext(request: Request, env: AuthorizationEnv): Promise<ConsentContext | Response> {
  let oauth: AuthRequest;
  try {
    oauth = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (error) {
    if (error instanceof AuthorizationError) return authorizationError(error);
    throw error;
  }

  const pkceError = enforceS256(oauth);
  if (pkceError) return pkceError;

  let identity: AccessIdentity;
  try {
    identity = await authenticateAccess(request, env);
  } catch (error) {
    if (error instanceof AccessAuthenticationError) return text('Cloudflare Access authentication required.', 401);
    throw error;
  }

  const client = await env.OAUTH_PROVIDER.lookupClient(oauth.clientId);
  if (!client) return text('Unknown OAuth client.', 400);
  return {
    oauth,
    identity,
    clientName: client.clientName?.trim() || 'Unnamed MCP client',
    scopes: requestedScopes(oauth),
  };
}

function scopeLabel(scope: string): string {
  switch (scope) {
    case HEALTH_READ_SCOPE:
      return 'Read your personal steps, sleep, workouts, heart rate and body measurements';
    case HEALTH_WRITE_SCOPE:
      return 'Create personal health logs when you explicitly confirm a write';
    case OFFLINE_ACCESS_SCOPE:
      return 'Stay connected using a rotating refresh token';
    default:
      return scope;
  }
}

async function consentPage(
  request: Request,
  env: AuthorizationEnv,
  context: ConsentContext,
  csrf: string,
): Promise<Response> {
  const url = new URL(request.url);
  await env.OAUTH_KV.put(await consentCsrfKey(csrf), await consentBinding(context), {
    expirationTtl: CONSENT_CSRF_TTL_SECONDS,
  });
  const nonce = randomToken(18);
  const scopeItems = context.scopes
    .map((scope) => `<li><code>${htmlEscape(scope)}</code> — ${htmlEscape(scopeLabel(scope))}</li>`)
    .join('');
  const action = htmlEscape(`${url.pathname}${url.search}`);
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize Google Health MCP</title>
<style nonce="${nonce}">body{font:16px system-ui,sans-serif;max-width:680px;margin:4rem auto;padding:0 1rem;line-height:1.5}main{border:1px solid #ddd;border-radius:12px;padding:1.5rem}button{font:inherit;padding:.65rem 1rem;margin-right:.5rem}code{background:#f3f3f3;padding:.1rem .3rem;border-radius:4px}.muted{color:#555}</style>
</head><body><main><h1>Authorize this MCP client?</h1>
<p><strong>${htmlEscape(context.clientName)}</strong> is requesting access to Google Health MCP.</p>
<p class="muted">Signed in through Cloudflare Access as ${htmlEscape(context.identity.email)}.</p>
<h2>Requested permissions</h2><ul>${scopeItems || '<li>No API permissions requested</li>'}</ul>
<form method="post" action="${action}">
<input type="hidden" name="csrf_token" value="${csrf}">
<button type="submit" name="decision" value="approve">Allow</button>
<button type="submit" name="decision" value="deny">Deny</button>
</form></main></body></html>`;

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      // Do not add form-action: Chrome applies it to the OAuth 302 redirect
      // chain and blocks registered callbacks. The action attribute is fixed to
      // this origin, while Origin + one-time CSRF protect the mutating POST.
      'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`,
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    },
  });
}

async function readForm(request: Request): Promise<URLSearchParams | null> {
  const declared = Number(request.headers.get('Content-Length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_FORM_BYTES) return null;
  const data = await request.formData();
  const params = new URLSearchParams();
  let size = 0;
  for (const [key, value] of data) {
    if (typeof value !== 'string') return null;
    size += new TextEncoder().encode(key).length + new TextEncoder().encode(value).length;
    if (size > MAX_FORM_BYTES) return null;
    params.append(key, value);
  }
  return params;
}

function validConsentOrigin(request: Request, expectedOrigin: string): boolean {
  const origin = request.headers.get('Origin');
  if (origin === expectedOrigin) return true;
  if (origin !== null && origin !== 'null') return false;
  return (
    request.headers.get('Sec-Fetch-Site') === 'same-origin' &&
    request.headers.get('Sec-Fetch-Mode') === 'navigate' &&
    request.headers.get('Sec-Fetch-Dest') === 'document'
  );
}

async function opaqueUserId(identity: AccessIdentity): Promise<string> {
  // Email is the allowlist identity and makes administrative offboarding
  // deterministic without storing a plaintext account/password record.
  const bytes = new TextEncoder().encode(`${identity.issuer}\u0000${identity.email}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let binary = '';
  for (const byte of digest) binary += String.fromCharCode(byte);
  return `access_${btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')}`;
}

async function finishConsent(request: Request, env: AuthorizationEnv, context: ConsentContext): Promise<Response> {
  const form = await readForm(request);
  if (!form) return text('Invalid consent form.', 400);

  const submitted = form.get('csrf_token') ?? '';
  if (submitted.length !== 43) return text('Invalid or expired consent request.', 403);
  const key = await consentCsrfKey(submitted);
  const storedBinding = await env.OAUTH_KV.get(key);
  if (!storedBinding) return text('Invalid or expired consent request.', 403);
  await env.OAUTH_KV.delete(key);
  if (!constantTimeEqual(storedBinding, await consentBinding(context))) {
    return text('Invalid or expired consent request.', 403);
  }

  if (form.get('decision') === 'deny') {
    const redirect = new URL(context.oauth.redirectUri);
    redirect.searchParams.set('error', 'access_denied');
    redirect.searchParams.set('error_description', 'The user denied this authorization request.');
    if (context.oauth.state) redirect.searchParams.set('state', context.oauth.state);
    if (context.oauth.issuer) redirect.searchParams.set('iss', context.oauth.issuer);
    return redirectResponse(redirect.toString());
  }
  if (form.get('decision') !== 'approve') return text('Invalid consent decision.', 400);

  const userId = await opaqueUserId(context.identity);
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: context.oauth,
    userId,
    // Grant metadata is visible in KV, so keep the email only in encrypted props.
    metadata: { clientName: context.clientName },
    scope: context.scopes,
    props: {
      userId,
      accessSubject: context.identity.subject,
      accessIssuer: context.identity.issuer,
      email: context.identity.email,
    },
  });
  return redirectResponse(redirectTo);
}

export async function handleAuthorization(request: Request, env: AuthorizationEnv): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, POST' } });
  }

  let consentSubmission = false;
  if (request.method === 'POST') {
    const form = await readForm(request.clone());
    if (!form) return text('Invalid consent form.', 400);
    consentSubmission = form.has('csrf_token') || form.has('decision');
    if (consentSubmission && !validConsentOrigin(request, new URL(env.PUBLIC_BASE_URL).origin)) {
      return text('Invalid consent origin.', 403);
    }
  }

  const context = await consentContext(request, env);
  if (context instanceof Response) return context;

  // Access may return from its browser login with a cross-site POST. It has no
  // consent fields and must never complete a grant, so turn it into a fresh
  // confirmation page. Only a later same-origin POST carrying the one-time,
  // identity-and-request-bound CSRF token can mutate authorization.
  if (request.method === 'GET' || !consentSubmission) {
    return consentPage(request, env, context, randomToken());
  }
  return finishConsent(request, env, context);
}
