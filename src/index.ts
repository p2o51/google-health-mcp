import { receiveWebhook } from './webhooks.ts';
import {
  OAuthProvider,
  type OAuthHelpers,
  type TokenSummary,
} from '@cloudflare/workers-oauth-provider';
import { handleAuthorization, AUTHORIZATION_SCOPES, RESOURCE_SCOPES } from './authorize.ts';
import { isOwnerEmail } from './access.ts';
import { McpServer, corsHeaders } from './mcp.ts';
import { SERVER_INSTRUCTIONS, buildTools, type Env as ToolEnv } from './tools.ts';

const SERVER_NAME = 'google-health';
const SERVER_TITLE = 'Google Health';
const SERVER_VERSION = '3.0.0';

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
// New grants last 90 days; every successful refresh starts another 90-day window.
const REFRESH_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;
const REFRESH_TOKEN_IDLE_TTL_SECONDS = 90 * 24 * 60 * 60;
const DCR_CLIENT_TTL_SECONDS = 365 * 24 * 60 * 60;

interface GrantProps {
  userId: string;
  accessSubject: string;
  accessIssuer: string;
  email: string;
}

export interface AppEnv extends ToolEnv {
  OAUTH_KV: KVNamespace;
  /** Injected by OAuthProvider into its delegated handlers. */
  OAUTH_PROVIDER: OAuthHelpers;
  PUBLIC_BASE_URL: string;
  OWNER_EMAIL: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  LOCAL_DEV_IDENTITY?: string;
  /** Staging-only, secret-safe JSON-RPC method/status diagnostics. */
  LOG_MCP_PROTOCOL?: string;
}

interface ProtocolTrace {
  method: string;
  idType: string;
  requestedProtocolVersion?: string;
  metaProtocolVersion?: string;
}

async function protocolTrace(request: Request): Promise<ProtocolTrace | null> {
  if (request.method !== 'POST') return null;
  try {
    const body = (await request.clone().json()) as {
      id?: unknown;
      method?: unknown;
      params?: { protocolVersion?: unknown };
    };
    if (typeof body.method !== 'string') return null;
    return {
      method: body.method,
      idType: body.id === null ? 'null' : typeof body.id,
      ...(typeof body.params?.protocolVersion === 'string'
        ? { requestedProtocolVersion: body.params.protocolVersion }
        : {}),
      ...(typeof (body.params as { _meta?: Record<string, unknown> } | undefined)?._meta?.[
        'io.modelcontextprotocol/protocolVersion'
      ] === 'string'
        ? {
            metaProtocolVersion: (body.params as { _meta: Record<string, string> })._meta[
              'io.modelcontextprotocol/protocolVersion'
            ],
          }
        : {}),
    };
  } catch {
    return null;
  }
}

function textResponse(body: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });
}

function canonicalBaseUrl(raw: string | undefined): URL {
  if (!raw?.trim()) throw new Error('PUBLIC_BASE_URL is required.');
  const url = new URL(raw);
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('PUBLIC_BASE_URL must use HTTPS (HTTP is allowed only on loopback).');
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('PUBLIC_BASE_URL must be an origin without credentials, path, query, or fragment.');
  }
  return new URL(url.origin);
}

function bearerToken(request: Request): string | null {
  const value = request.headers.get('Authorization') ?? '';
  const match = /^Bearer ([^\s]+)$/.exec(value);
  return match?.[1] ?? null;
}

function exactAudience(token: TokenSummary<GrantProps>, resource: string): boolean {
  const values = Array.isArray(token.audience) ? token.audience : token.audience ? [token.audience] : [];
  return values.length === 1 && values[0] === resource;
}

function internalError(error: unknown): Response {
  console.error('MCP request failed', error instanceof Error ? error.message : String(error));
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32603, message: 'Internal server error' },
    }),
    {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    },
  );
}

function tokenError(code: string, description: string): Response {
  return new Response(JSON.stringify({ error: code, error_description: description }), {
    status: 400,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
    },
  });
}

async function enforceCanonicalResource(request: Request, resource: string): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === '/authorize') {
    const resources = url.searchParams.getAll('resource');
    if (resources.length !== 1 || resources[0] !== resource) {
      // Do not redirect: client_id and redirect_uri have not yet been safely
      // validated. The provider performs that validation after this precheck.
      return textResponse('A single exact canonical resource parameter is required.', 400);
    }
    return null;
  }

  if (url.pathname !== '/token' || request.method !== 'POST') return null;
  if (!(request.headers.get('Content-Type') ?? '').toLowerCase().startsWith('application/x-www-form-urlencoded')) {
    return tokenError('invalid_request', 'The token endpoint requires form-urlencoded input.');
  }
  const length = Number(request.headers.get('Content-Length') ?? '0');
  if (Number.isFinite(length) && length > 16_384) return tokenError('invalid_request', 'Token request is too large.');
  const form = await request.clone().formData();
  const grantType = form.get('grant_type');
  if (typeof grantType !== 'string') return tokenError('invalid_request', 'grant_type is required.');
  if (grantType === 'authorization_code' || grantType === 'refresh_token') {
    const resources = form.getAll('resource');
    if (resources.length !== 1 || resources[0] !== resource || typeof resources[0] !== 'string') {
      return tokenError('invalid_target', 'A single exact canonical resource parameter is required.');
    }
  }
  return null;
}

const mcpHandler = {
  async fetch(request, env): Promise<Response> {
    const base = canonicalBaseUrl(env.PUBLIC_BASE_URL);
    const resource = new URL('/mcp', base).toString();
    const token = bearerToken(request);
    if (!token) return textResponse('Unauthorized', 401);

    // OAuthProvider has already validated the bearer token and its audience.
    // Unwrap it again to obtain the exact, possibly refresh-downscoped scope
    // set; grant props alone are not an effective authorization context.
    const summary = await env.OAUTH_PROVIDER.unwrapToken<GrantProps>(token);
    if (!summary || !exactAudience(summary, resource)) return textResponse('Unauthorized', 401);
    if (!isOwnerEmail(summary.grant.props?.email, env.OWNER_EMAIL)) return textResponse('Forbidden', 403);

    const server = new McpServer<ToolEnv>({
      name: SERVER_NAME,
      title: SERVER_TITLE,
      version: SERVER_VERSION,
      instructions: SERVER_INSTRUCTIONS,
      tools: buildTools(env, {
        scopes: new Set(summary.scope),
        resourceMetadataUrl: new URL('/.well-known/oauth-protected-resource/mcp', base).toString(),
      }),
    });

    try {
      const trace = env.LOG_MCP_PROTOCOL === '1' ? await protocolTrace(request) : null;
      if (trace) {
        console.log('MCP protocol request', {
          ...trace,
          declaredProtocolVersion: request.headers.get('MCP-Protocol-Version') ?? undefined,
          mcpMethod: request.headers.get('Mcp-Method') ?? undefined,
          mcpName: request.headers.get('Mcp-Name') ?? undefined,
          accept: request.headers.get('Accept') ?? undefined,
          contentType: request.headers.get('Content-Type') ?? undefined,
        });
      }
      const response = await server.handle(request, env);
      if (trace) {
        console.log('MCP protocol response', {
          method: trace.method,
          status: response.status,
          contentType: response.headers.get('Content-Type') ?? undefined,
          negotiatedProtocolVersion: response.headers.get('MCP-Protocol-Version') ?? undefined,
        });
      }
      return response;
    } catch (error) {
      return internalError(error);
    }
  },
} satisfies ExportedHandler<AppEnv>;

const publicHandler = {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/authorize') return handleAuthorization(request, env);
    if (url.pathname === '/health' && request.method === 'GET') return textResponse('ok', 200);
    if (url.pathname === '/' && request.method === 'GET') {
      return textResponse(
        [
          `${SERVER_TITLE} — OAuth-protected remote MCP server`,
          '',
          `MCP endpoint: ${new URL('/mcp', canonicalBaseUrl(env.PUBLIC_BASE_URL))}`,
          'Authentication: OAuth 2.1 authorization code + PKCE S256',
          'Human identity: Cloudflare Access (email one-time PIN + exact-email allowlist)',
        ].join('\n'),
        200,
      );
    }
    return textResponse('Not Found', 404);
  },
} satisfies ExportedHandler<AppEnv>;

function providerFor(env: AppEnv): OAuthProvider<AppEnv> {
  const base = canonicalBaseUrl(env.PUBLIC_BASE_URL);
  const issuer = base.origin;
  const resource = new URL('/mcp', base).toString();
  return new OAuthProvider<AppEnv>({
    apiRoute: '/mcp',
    apiHandler: mcpHandler,
    defaultHandler: publicHandler,
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/token',
    clientRegistrationEndpoint: '/register',
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: [...AUTHORIZATION_SCOPES],
    requiredScopes: [...RESOURCE_SCOPES],
    resourceMetadata: {
      resource,
      authorization_servers: [issuer],
      bearer_methods_supported: ['header'],
      resource_name: SERVER_TITLE,
    },
    disallowPublicClientRegistration: false,
    clientRegistrationCallback: ({ clientMetadata }) => {
      // This deployment does not verify software-statement JWTs. Reject one
      // explicitly instead of storing metadata that might appear attested.
      if ('software_statement' in clientMetadata) {
        return {
          code: 'invalid_client_metadata',
          description: 'software_statement is not supported by this authorization server.',
        };
      }
    },
    accessTokenTTL: ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTTL: REFRESH_TOKEN_TTL_SECONDS,
    refreshTokenIdleTTL: REFRESH_TOKEN_IDLE_TTL_SECONDS,
    clientRegistrationTTL: DCR_CLIENT_TTL_SECONDS,
  });
}

export default {
  async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    let base: URL;
    try {
      base = canonicalBaseUrl(env.PUBLIC_BASE_URL);
    } catch (error) {
      console.error('Invalid OAuth canonical URL', error instanceof Error ? error.message : String(error));
      return textResponse('Server configuration error.', 503);
    }

    const url = new URL(request.url);
    if (url.origin !== base.origin) return textResponse('Misdirected Request', 421);

    if (url.pathname === '/webhooks/health') return receiveWebhook(request, env);

    // The old /mcp/<shared-token> fallback must never reappear. It leaks bearer
    // credentials into platform URL logs and is not part of the canonical MCP
    // resource audience.
    if (url.pathname !== '/mcp' && url.pathname.startsWith('/mcp')) return textResponse('Not Found', 404);

    const resourceError = await enforceCanonicalResource(request, new URL('/mcp', base).toString());
    if (resourceError) return resourceError;

    return providerFor(env).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<AppEnv>;
