/**
 * A minimal, dependency-free MCP server over the Streamable HTTP transport.
 *
 * Scoped deliberately to what this server needs: tools only — no resources, no
 * prompts, no server-initiated messages. That keeps it stateless, so a single
 * POST endpoint suffices with no session store, no KV and no Durable Objects.
 *
 * Two consequences of never initiating messages, both spec-sanctioned:
 *   - GET /mcp answers 405 ("the server does not offer an SSE stream at this
 *     endpoint"), so we never emit SSE.
 *   - We never mint an Mcp-Session-Id, which means the "400 on missing session
 *     header" rule cannot apply to us.
 *
 * This protocol core deliberately stays small. OAuth is handled by the outer
 * Worker layer, while this class remains a stateless JSON-RPC dispatcher.
 */

/**
 * Protocol revisions we accept, newest first. Keep older entries because real
 * clients do not all upgrade in lockstep.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = [
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
  '2024-10-07',
] as const;

export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

/** What to assume when a client omits the MCP-Protocol-Version header. */
export const DEFAULT_NEGOTIATED_VERSION = '2025-03-26';

export const JSONRPC_VERSION = '2.0';

// Standard JSON-RPC error codes.
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

type Id = string | number;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: Id | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDefinition<Env = unknown> {
  name: string;
  /** Short human label for client UIs. */
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: ToolAnnotations;
  /** MCP authorization requirements for this operation. */
  securitySchemes?: Array<Record<string, unknown>>;
  handler: (args: Record<string, unknown>, ctx: ToolContext<Env>) => Promise<ToolResult>;
}

export interface ToolContext<Env = unknown> {
  env: Env;
  headers: Headers;
  signal?: AbortSignal;
}

export interface ToolResult {
  /** Text returned to the model. Always at least one block on the wire. */
  text: string;
  isError?: boolean;
  /** Small machine-readable payload. Omit for large content — it doubles CPU. */
  structured?: Record<string, unknown>;
  /** Protocol metadata such as an operation-specific OAuth challenge. */
  meta?: Record<string, unknown>;
}

/**
 * A tool failure the model should see and can recover from.
 *
 * Per spec these travel as a successful result with `isError: true`, not as a
 * JSON-RPC error: clients SHOULD hand them back to the model for
 * self-correction, whereas protocol errors are "less likely to result in
 * successful recovery".
 */
export class ToolError extends Error {
  readonly structured?: Record<string, unknown>;
  readonly meta?: Record<string, unknown>;

  constructor(message: string, structured?: Record<string, unknown>, meta?: Record<string, unknown>) {
    super(message);
    this.name = 'ToolError';
    this.structured = structured;
    this.meta = meta;
  }
}

export interface McpServerOptions<Env> {
  name: string;
  title?: string;
  version: string;
  /** Surfaced to the model by clients that support it. */
  instructions?: string;
  tools: Array<ToolDefinition<Env>>;
}

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

export function corsHeaders(): Record<string, string> {
  return {
    // MCP clients are normally native/server-side. `*` is safe here because
    // credentials are bearer headers and Access-Control-Allow-Credentials is
    // intentionally absent.
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Last-Event-ID',
    'Access-Control-Expose-Headers': 'MCP-Protocol-Version',
    'Access-Control-Max-Age': '86400',
  };
}

export class McpServer<Env = unknown> {
  private readonly tools: Map<string, ToolDefinition<Env>>;
  private readonly opts: McpServerOptions<Env>;

  constructor(opts: McpServerOptions<Env>) {
    this.opts = opts;
    this.tools = new Map(opts.tools.map((t) => [t.name, t]));
  }

  /**
   * Echo the client's requested revision when we know it, otherwise answer with
   * our latest. Deliberately never an error: the normative requirement is to
   * respond with a version we support and let the client decide.
   */
  private negotiate(requested: unknown): string {
    if (typeof requested === 'string' && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)) {
      return requested;
    }
    return LATEST_PROTOCOL_VERSION;
  }

  private serverInfo() {
    return {
      name: this.opts.name,
      ...(this.opts.title ? { title: this.opts.title } : {}),
      version: this.opts.version,
    };
  }

  private toolList() {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      ...(t.title ? { title: t.title } : {}),
      description: t.description,
      inputSchema: t.inputSchema,
      ...(t.annotations ? { annotations: t.annotations } : {}),
      ...(t.securitySchemes
        ? {
            securitySchemes: t.securitySchemes,
            // Kept in _meta for clients that implemented the earlier MCP Apps
            // convention before securitySchemes became a first-class field.
            _meta: { securitySchemes: t.securitySchemes },
          }
        : {}),
    }));
  }

  /** Add fields required on every successful result in the modern era. */
  private ok(id: Id | null, result: Record<string, unknown>, modern: boolean): Record<string, unknown> {
    if (!modern) return okObj(id, result);
    const existingMeta =
      typeof result._meta === 'object' && result._meta !== null && !Array.isArray(result._meta)
        ? (result._meta as Record<string, unknown>)
        : {};
    return okObj(id, {
      resultType: 'complete',
      ...result,
      _meta: {
        ...existingMeta,
        'io.modelcontextprotocol/serverInfo': this.serverInfo(),
      },
    });
  }

  async handle(request: Request, env: Env, signal?: AbortSignal): Promise<Response> {
    const cors = corsHeaders();

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // Nothing to stream and no session to delete.
    if (request.method === 'GET' || request.method === 'DELETE') {
      return json(
        errObj(null, METHOD_NOT_FOUND, 'This server only supports POST to /mcp.'),
        405,
        { ...cors, Allow: 'POST, OPTIONS' },
      );
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: { ...cors, Allow: 'POST, OPTIONS' },
      });
    }

    // Reject only versions we've never heard of; absent is fine and common.
    const declared = request.headers.get('MCP-Protocol-Version');
    if (declared && !(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(declared)) {
      return json(
        errObj(
          null,
          INVALID_REQUEST,
          `Unsupported MCP-Protocol-Version: ${declared}. Supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}`,
        ),
        400,
        cors,
      );
    }

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return json(errObj(null, PARSE_ERROR, 'Invalid JSON body'), 400, cors);
    }

    // JSON-RPC batching was removed from the transport; a single object only.
    if (Array.isArray(payload)) {
      return json(
        errObj(null, INVALID_REQUEST, 'Batched requests are not supported; send a single JSON-RPC object.'),
        400,
        cors,
      );
    }

    const out = await this.dispatch(payload, env, request, signal);
    // Notifications take no reply.
    if (!out) return new Response(null, { status: 202, headers: cors });
    return json(out, 200, {
      ...cors,
      'MCP-Protocol-Version': declared ?? DEFAULT_NEGOTIATED_VERSION,
    });
  }

  /**
   * Handle one JSON-RPC message. Returns the response object, or `null` for a
   * notification.
   */
  private async dispatch(
    msg: unknown,
    env: Env,
    request: Request,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown> | null> {
    if (typeof msg !== 'object' || msg === null) {
      return errObj(null, INVALID_REQUEST, 'Request must be a JSON object');
    }
    const req = msg as JsonRpcRequest;
    const modern = request.headers.get('MCP-Protocol-Version') === LATEST_PROTOCOL_VERSION;

    // A request has an id of string|number. Anything else — absent or null — is
    // a notification. Preserve the id's original type in the reply.
    const hasId = typeof req.id === 'string' || typeof req.id === 'number';
    const id: Id | null = hasId ? (req.id as Id) : null;
    const method = req.method;

    if (typeof method !== 'string') {
      return hasId ? errObj(id, INVALID_REQUEST, 'Missing "method"') : null;
    }

    switch (method) {
      case 'initialize':
        return this.ok(id, {
          protocolVersion: this.negotiate(req.params?.protocolVersion),
          // Exactly `{}`: a stateless JSON-only server cannot send
          // notifications/tools/list_changed, so it must not advertise it.
          capabilities: { tools: {} },
          serverInfo: this.serverInfo(),
          ...(this.opts.instructions ? { instructions: this.opts.instructions } : {}),
        }, modern);

      /**
       * Forward-compat with the handshake-less "modern era" revision, where
       * discovery replaces initialize. Free to support while stateless.
       */
      case 'server/discover':
        return this.ok(id, {
          supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
          capabilities: { tools: {} },
          ...(this.opts.instructions ? { instructions: this.opts.instructions } : {}),
        }, true);

      case 'ping':
        return this.ok(id, {}, modern);

      case 'tools/list':
        // Single page; no cursor, no nextCursor.
        return this.ok(id, { tools: this.toolList() }, modern);

      // Declared unsupported, but answered with empty lists rather than an
      // error — clients probe these regardless of advertised capabilities.
      case 'resources/list':
        return this.ok(id, { resources: [] }, modern);
      case 'resources/templates/list':
        return this.ok(id, { resourceTemplates: [] }, modern);
      case 'prompts/list':
        return this.ok(id, { prompts: [] }, modern);

      case 'tools/call': {
        const name = req.params?.name;
        if (typeof name !== 'string') {
          return errObj(id, INVALID_PARAMS, 'tools/call requires a string "name"');
        }
        const tool = this.tools.get(name);
        if (!tool) {
          const known = [...this.tools.keys()].join(', ');
          return errObj(id, INVALID_PARAMS, `Unknown tool: ${name}. Available: ${known}`);
        }
        const rawArgs = req.params?.arguments;
        const args =
          typeof rawArgs === 'object' && rawArgs !== null && !Array.isArray(rawArgs)
            ? (rawArgs as Record<string, unknown>)
            : {};
        try {
          return this.ok(id, payloadFor(await tool.handler(args, { env, headers: request.headers, signal })), modern);
        } catch (err) {
          // Execution failures are results, not protocol errors, so the model
          // can read them and try something else.
          const message = err instanceof Error ? err.message : String(err);
          const structured = err instanceof ToolError ? err.structured : undefined;
          const meta = err instanceof ToolError ? err.meta : undefined;
          return this.ok(id, payloadFor({ text: message, isError: true, structured, meta }), modern);
        }
      }

      default:
        if (method.startsWith('notifications/')) return null;
        return hasId ? errObj(id, METHOD_NOT_FOUND, `Method not found: ${method}`) : null;
    }
  }
}

function payloadFor(result: ToolResult): Record<string, unknown> {
  return {
    // `content` is required — always at least one block.
    content: [{ type: 'text', text: result.text }],
    ...(result.structured ? { structuredContent: result.structured } : {}),
    ...(result.isError ? { isError: true } : {}),
    ...(result.meta ? { _meta: result.meta } : {}),
  };
}

function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...extra },
  });
}

function okObj(id: Id | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

function errObj(id: Id | null, code: number, message: string, data?: unknown): Record<string, unknown> {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}
