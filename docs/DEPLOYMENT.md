# Deployment guide / 部署指南

This guide deploys one owner's Google Health account to one Cloudflare Worker. Keep the Google OAuth authorization and the MCP client's OAuth authorization separate: they protect different connections.

## 1. Prerequisites

- Node.js 22.18 or newer and Python 3.10 or newer.
- A Cloudflare account, a domain managed by Cloudflare, Workers and KV access, and Zero Trust Access.
- A Google Cloud project with the **Google Health API** enabled and eligible access to the data you want to use.
- A Google OAuth consent screen and a **Web application** OAuth client. Add `http://127.0.0.1:53682/callback` to its authorized redirect URIs. This callback is for the local authorization helper, not the MCP callback.

Follow Google's current [getting-started documentation](https://developers.google.com/health) and applicable developer/user-data policies. An OAuth consent screen left in Testing can issue short-lived refresh tokens; publishing status and verification requirements depend on your Google application. The MCP's 90-day refresh policy cannot extend an upstream Google token that Google revokes or expires.

```sh
npm ci
cp .dev.vars.example .dev.vars
npx wrangler login
```

## 2. Google permissions

Every suffix below has prefix `https://www.googleapis.com/auth/googlehealth.`.

| Feature | Google scope suffix | Helper option |
| --- | --- | --- |
| Activity, sleep, health measurements | `activity_and_fitness.readonly`, `sleep.readonly`, `health_metrics_and_measurements.readonly` | Included by default |
| Devices and account settings | `settings.readonly` | `--features devices` |
| Profile | `profile.readonly` | `--features profile` |
| Food and hydration reading | `nutrition.readonly` | `--features nutrition` |
| ECG | `ecg.readonly` | `--features ecg` |
| Irregular-rhythm notifications/profile | `irn.readonly` | `--features irn` |
| TCX with location | `location.readonly` plus activity scope | `--features location` |
| Food and hydration creation | `nutrition.writeonly` | `--writes nutrition` |
| Mood creation | `mindfulness.writeonly` | `--writes moods` |
| Symptom creation | `logged_symptoms.writeonly` | `--writes symptoms` |
| Menstrual-period creation | `reproductive_health.writeonly` | `--writes reproductive` |

Base access:

```sh
npm run authorize
```

All supported optional reads and writes:

```sh
python3 scripts/authorize.py --all-read --writes nutrition,moods,symptoms,reproductive
```

The helper requests PKCE and checks OAuth state, opens Google consent, and stores the client ID, client secret and refresh token in `.dev.vars` with mode `0600`. Existing credentials remain intact if authorization fails or required scopes are missing. It never prints tokens. `--print-scopes` shows the requested scope names without starting authorization. Choose only the groups you need; rerun with the full desired set when changing permissions.

If Google refuses a scope, confirm its availability for your project/account before proceeding. A successful local preview is not evidence that Google has granted write access.

## 3. OAuth KV and production configuration

```sh
npx wrangler kv namespace create OAUTH_KV
cp wrangler.jsonc wrangler.production.local.json
```

Edit `env.production` in the ignored local file:

- `name`: your Worker name.
- `routes[0].pattern`: your domain, for example `health-mcp.your-domain.tld`; keep `custom_domain: true`.
- `kv_namespaces[0].id`: the dedicated namespace ID from the creation command. Keep binding `OAUTH_KV`.
- `vars.PUBLIC_BASE_URL`: exactly `https://health-mcp.your-domain.tld`, no trailing slash or path.
- `vars.OWNER_EMAIL`: your exact email address.
- `vars.ACCESS_TEAM_DOMAIN` and `vars.ACCESS_AUD`: from the Access application in the next step.
- Keep `LOCAL_DEV_IDENTITY: "0"`, `workers_dev: false`, and `preview_urls: false`.
- Keep `DEBUG_TOOLS: "0"` and `LOG_MCP_PROTOCOL: "0"` unless actively diagnosing a problem.
- Add `ENABLE_WRITES: "1"` only if you want the write tool. Omission or `"0"` leaves it disabled.

Use a separate KV namespace for each deployment/environment. Do not replace an existing production namespace during an upgrade: it stores active MCP grants.

## 4. Owner-only Cloudflare Access

Create a self-hosted Access application for **`health-mcp.your-domain.tld/authorize`**. Add an Allow policy for your single owner email, with an identity provider or One-time PIN. Copy its application AUD and team domain into the local configuration.

Do **not** protect the entire domain with Access. OAuth discovery, `/register`, `/token`, `/mcp` and the optional `/webhooks/health` must remain reachable by protocol clients. `/mcp` has its own OAuth bearer authorization; the webhook has its own bearer/signature checks. The Worker independently verifies Access JWT issuer/audience and the exact owner email for authorization.

## 5. Deploy and upload secrets

```sh
node scripts/deploy.mjs --config wrangler.production.local.json --check
npm run typecheck
npm test
npm run deploy -- --config wrangler.production.local.json
python3 scripts/upload-secrets.py --config wrangler.production.local.json
```

The upload helper sends only the three Google credentials through Wrangler's stdin, not command-line arguments or logs. Optional `--webhook` additionally uploads the two webhook secrets. It does not upload unrelated `.dev.vars` entries.

The deployment command validates the production owner, domain, Access configuration and KV before invoking Wrangler. The public template intentionally fails these checks until configured. Changing Google credentials does not require deleting MCP grants.

## 6. Connect an MCP client

Add `https://health-mcp.your-domain.tld/mcp` as a remote Streamable HTTP MCP server. Choose OAuth authentication. The client registers its callback, opens `/authorize`, you sign in through Access, and approve the requested MCP permissions.

- `health:read`: read tools.
- `health:write`: the optional log tool. An old read-only grant cannot use it.
- `offline_access`: refresh access without repeating login for every one-hour access token.

After enabling writes, reconnect/re-authorize the MCP client so it can request `health:write`; also complete Google consent for the matching write scopes. These are two independent requirements. Some clients require refreshing the tool list after a deployment. Existing read-only clients keep working.

Refresh grants start with 90 days of validity. Each successful refresh extends the idle deadline to 90 days from that refresh. Revocation, loss of KV data, account policy or an upstream Google token failure can still require reconnecting. This is not a promise that every connector stays logged in forever.

Smoke checks:

```sh
curl -i https://health-mcp.your-domain.tld/health
curl -i https://health-mcp.your-domain.tld/.well-known/oauth-protected-resource/mcp
curl -i https://health-mcp.your-domain.tld/.well-known/oauth-authorization-server
curl -i https://health-mcp.your-domain.tld/mcp
```

Expect successful health/discovery responses and **401** for unauthenticated MCP requests. Then test `get_health_connection_status`, one real read, and `log_health_record` with `confirm: false`. Only test a confirmed live write with an actual record you intend to save. A timeout after submission can mean it succeeded: do not blindly retry.

## 7. Optional webhooks

The receiver is available at `/webhooks/health` only when both secrets are configured:

- `WEBHOOK_SECRET`: a cryptographically random string of at least 32 characters.
- `WEBHOOK_HEALTH_USER_ID`: your Google Health user ID, obtained using the authorized Google Health `users/me/identity` endpoint. This is not your email or Google Cloud project ID.

Store these privately in `.dev.vars`, upload with `scripts/upload-secrets.py --webhook`, and create a Google Health subscriber using the [official webhook setup](https://developers.google.com/health/webhooks). Subscriber administration uses Google Cloud project permissions; use the numeric **project number** in its resource path. Configure the endpoint authorization secret as the complete header value `Bearer YOUR_WEBHOOK_SECRET` and select supported data types. Use Google's subscriber configuration/subscription flow for your project; API enablement alone does not create subscriptions.

The receiver supports Google's authorized/unauthorized verification requests. For notifications it verifies the bearer, exact raw-body ECDSA signature with Google's published Tink keys, and the owning Health user ID before storing a marker. Key retrieval errors return 503 for retry. Invalid signatures return 401. Bodies are limited to 256 KiB and batches to 99 notifications.

KV retains deduplication markers for seven days and the last change marker for 30 days. The marker contains only receipt time, changed type names and operations. It contains no health values or raw notifications. It appears in `get_health_connection_status`; reads always fetch current data. KV deduplication is best effort under concurrent delivery; repeated marker writes are harmless. This release does not push messages or schedule background reports.

Webhook setup is optional and must be verified using a real change after subscription creation. Passing signature unit tests does not prove Google delivery is configured.

## Local development

`npm run dev` uses HTTPS loopback and local KV. The local identity shortcut requires loopback and `X-Local-Access-Email` matching `OWNER_EMAIL`; it is not accepted on production hosts. Synthetic test hooks are for tests only. The test suite uses mocked Google requests and generated webhook signatures; do not put live health exports into test fixtures.

## Troubleshooting and upgrades

| Symptom | Check |
| --- | --- |
| Google 403 | API enablement, requested Google scopes and project/account eligibility. MCP reauthorization alone does not add Google scopes. |
| Empty data | Date/timezone, device sync, actual record availability, data-source selection and pagination. A permission error is not an empty result. |
| Write tool absent | `ENABLE_WRITES=1` and refreshed client tool discovery. |
| Write permission error | MCP grant must contain `health:write`; Google token needs the specific write scope. |
| Repeated OAuth login | Preserve KV; inspect refresh failure and upstream token validity. Access login lifetime is separate from MCP refresh lifetime. |
| Reports show partial data | Inspect `errors`, `truncated`, and coverage. Narrow the date range or use paginated raw queries. |
| TCX denied/empty | Requires both location and activity scopes, a supported workout and recorded location, or explicit partial export. |

Before upgrades, retain your private configuration and current Worker version ID. Run typecheck/tests, deploy against the same name/domain/KV, and verify both discovery and an authenticated read. To roll back, use Cloudflare's Worker version rollback for your deployment; do not delete the KV namespace or Google credentials.
