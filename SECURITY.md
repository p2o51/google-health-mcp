# Security and data handling

This Worker is for a **single owner**. Every authenticated MCP client acts on that owner's Google Health account. It is not safe to turn it into a public multi-user API by relaxing the owner check.

- Cloudflare Access verifies the owner's login on `/authorize`; MCP requests use OAuth bearer tokens with separate read/write scopes.
- Google refresh credentials belong in Worker secrets. Local `.dev.vars` and `*.local.json` are ignored and must not be published.
- Writes are disabled by default. When enabled, a write-scoped client can submit a record with `confirm: true`. Preview/confirmation is a client interaction contract, not an independent server-side human-approval ceremony. Only grant write access to clients you trust.
- Health queries are returned to the requesting MCP client and thus its model/provider. The Worker does not persist measurement payloads. Cloudflare KV stores OAuth state and optional webhook change/deduplication markers.
- Do not log raw tool arguments, responses, tokens or exports. Keep diagnostics off in normal production operation. TCX may contain location data.
- Server errors redact credentials; they do not make arbitrary user-controlled output safe to publish. Review logs before sharing.
- Disconnect clients, revoke Google authorization and rotate affected credentials if compromised. Retain KV for ordinary upgrades; remove grants deliberately when revoking clients.

Report suspected vulnerabilities privately through GitHub private vulnerability reporting if enabled on this repository. Never post tokens, personal health records or full request captures in public issues.
