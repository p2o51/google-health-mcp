import { createRemoteJWKSet, jwtVerify } from 'jose';

export interface AccessEnv {
  /** Cloudflare Access team hostname, for example `example.cloudflareaccess.com`. */
  ACCESS_TEAM_DOMAIN?: string;
  /** Audience tag of the path-scoped Access application protecting /authorize. */
  ACCESS_AUD?: string;
  /** Local-only identity bridge. Rejected unless PUBLIC_BASE_URL is loopback. */
  LOCAL_DEV_IDENTITY?: string;
  PUBLIC_BASE_URL: string;
  OWNER_EMAIL: string;
}

export interface AccessIdentity {
  subject: string;
  email: string;
  issuer: string;
}

export type AccessVerificationKey = Parameters<typeof jwtVerify>[1];

export class AccessAuthenticationError extends Error {
  constructor(message = 'Cloudflare Access authentication is required.') {
    super(message);
    this.name = 'AccessAuthenticationError';
  }
}

const remoteKeySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function loopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

export function accessIssuer(teamDomain: string): string {
  const raw = teamDomain.trim();
  if (!raw) throw new AccessAuthenticationError('ACCESS_TEAM_DOMAIN is not configured.');

  let hostname: string;
  try {
    hostname = raw.includes('://') ? new URL(raw).hostname : new URL(`https://${raw}`).hostname;
  } catch {
    throw new AccessAuthenticationError('ACCESS_TEAM_DOMAIN is invalid.');
  }
  if (!hostname.endsWith('.cloudflareaccess.com')) {
    throw new AccessAuthenticationError('ACCESS_TEAM_DOMAIN must be a cloudflareaccess.com hostname.');
  }
  return `https://${hostname}`;
}

/**
 * Verify the assertion at the Worker as well as at the Access edge. This
 * prevents a route-policy mistake from silently turning into an auth bypass.
 */
export async function verifyAccessJwt(
  token: string,
  issuer: string,
  audience: string,
  key: AccessVerificationKey,
): Promise<AccessIdentity> {
  if (!token || token.length > 16_384) throw new AccessAuthenticationError();

  let payload: Awaited<ReturnType<typeof jwtVerify>>['payload'];
  try {
    ({ payload } = await jwtVerify(token, key, {
      issuer,
      audience,
      algorithms: ['RS256'],
    }));
  } catch {
    throw new AccessAuthenticationError();
  }

  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
  const subject = typeof payload.sub === 'string' ? payload.sub.trim() : '';
  if (payload.type !== 'app' || !email || !subject) throw new AccessAuthenticationError();
  return { subject, email, issuer };
}

export function isOwnerEmail(email: unknown, ownerEmail: string | undefined): boolean {
  const owner = ownerEmail?.trim().toLowerCase();
  return Boolean(owner && owner.includes('@') && typeof email === 'string' && email.trim().toLowerCase() === owner);
}

export function requireOwner(identity: AccessIdentity, env: Pick<AccessEnv, 'OWNER_EMAIL'>): AccessIdentity {
  if (!isOwnerEmail(identity.email, env.OWNER_EMAIL)) throw new AccessAuthenticationError('This account is not allowed.');
  return identity;
}

export async function authenticateAccess(request: Request, env: AccessEnv): Promise<AccessIdentity> {
  const canonical = new URL(env.PUBLIC_BASE_URL);
  const requestUrl = new URL(request.url);

  // Local tests need a deterministic human identity without an Access tenant.
  // This branch is impossible on a public hostname, even if the flag is set by
  // mistake during deployment.
  if (
    env.LOCAL_DEV_IDENTITY === '1' &&
    loopbackHostname(canonical.hostname) &&
    loopbackHostname(requestUrl.hostname)
  ) {
    const email = request.headers.get('X-Local-Access-Email')?.trim().toLowerCase();
    if (!email || !email.includes('@')) throw new AccessAuthenticationError('Local test identity is missing.');
    return requireOwner({ subject: `local:${email}`, email, issuer: canonical.origin }, env);
  }

  const audience = env.ACCESS_AUD?.trim();
  if (!audience) throw new AccessAuthenticationError('ACCESS_AUD is not configured.');
  const issuer = accessIssuer(env.ACCESS_TEAM_DOMAIN ?? '');
  const token = request.headers.get('Cf-Access-Jwt-Assertion') ?? '';
  let keySet = remoteKeySets.get(issuer);
  if (!keySet) {
    keySet = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    remoteKeySets.set(issuer, keySet);
  }
  return requireOwner(await verifyAccessJwt(token, issuer, audience, keySet), env);
}
