# Google Health MCP

A self-hosted, single-owner MCP server for Google Health, deployed on Cloudflare Workers. Read personal activity, sleep and health measurements; compare weekly trends; and optionally **save food, water, mood, symptom and menstrual-period records to Google Health**.

[部署指南 / Deployment](docs/DEPLOYMENT.md) · [Tool reference](docs/TOOLS.md) · [Security](SECURITY.md) · [Changelog](docs/CHANGELOG.md)

## Features

- **38 data types** in a discoverable catalog, with supported filters, reconciliation, pagination and daily/physical-time aggregation. Skin-temperature sensors use the Google `v4beta` endpoint.
- **15 read tools**: daily summaries, steps, sleep, workouts, body metrics, generic queries, aggregation, reports, nutrition summaries, workout details, TCX exports, devices, account resources and connection status.
- Weekly/monthly reports compare equal-length periods, show coverage, and calculate sleep timing variation. Missing observations stay missing; failed queries and truncated results remain visible.
- Optional `log_health_record` creates food, hydration, mood, symptom or menstrual-period entries. It validates and previews the payload before an explicitly confirmed submission. Unknown calories can be omitted; the server does not invent nutrition facts.
- Optional Google-signed webhooks record change markers without retaining measurement payloads.
- Owner-only Cloudflare Access login, OAuth consent, DCR and PKCE. One-hour access tokens; initial refresh grant lifetime of 90 days, renewed to a 90-day idle window on successful refresh.

这是可以实际写入 Google Health 的 MCP，饮食记录不只保存在聊天里。写入默认关闭，需要开启部署开关，并分别授予 Google 写入权限和 MCP `health:write` 权限。现有只读授权不会自动获得写权限。

## Quick start

Requirements: Node.js **22.18+**, Python **3.10+**, a Cloudflare account/domain, and a Google Cloud project enabled for Google Health API.

```sh
git clone https://github.com/p2o51/google-health-mcp.git
cd google-health-mcp
npm ci
cp .dev.vars.example .dev.vars
npm run authorize
npm run dev
```

Local development uses an isolated loopback identity shortcut. Production requires a configured custom domain, a dedicated OAuth KV namespace, and Cloudflare Access protecting **only `/authorize`**. Complete the [deployment guide](docs/DEPLOYMENT.md) before using a hosted client.

Examples of requests to your MCP client:

- “Compare my last seven days with the previous seven days and show missing data.”
- “Show my logged calories and water for yesterday.”
- “Show the laps in my last run and export its TCX.”
- “Log this lunch: tofu salad, 320 kcal and 22 g protein. Show me the entry first.”

## Permissions and limits

Base Google scopes cover activity, sleep and health metrics. Nutrition, ECG, irregular-rhythm notifications, profile/settings and location exports require additional Google consent. Account/device availability still determines what data Google returns. See the [scope matrix](docs/DEPLOYMENT.md#google-permissions).

Food logging currently creates **anonymous food entries** with a display name and optional nutrition values. Google does not support editing those entries after creation. This MCP does not yet implement food-database search, update or delete tools. Mood/symptom/menstrual-period creation is supported; full-history reading for those types is not promised.

Reports are descriptive calculations from returned records, not Google/Fitbit proprietary readiness, sleep or stress scores. A webhook marks data changes; it does not send messages or run scheduled reports. This is a personal, single-account deployment, not a multi-tenant service.

## Development

```sh
npm run typecheck
npm test
python3 scripts/authorize.py --all-read --writes nutrition,moods,symptoms,reproductive --print-scopes
```

Tests use synthetic health data and credentials. They cover protocol contracts, query limits, unit conversion, partial reports, write authorization, write previews, signed webhooks and OAuth refresh migration. No live health writes are required for the suite. Live API access and real-client OAuth consent must be verified separately on your own deployment.

The public configuration contains placeholders. `.dev.vars`, `*.local.json`, caches and build output are ignored. Never commit credentials, exported health records or your private deployment configuration.

## References

- [Google Health API](https://developers.google.com/health/reference/rest)
- [Supported data types](https://developers.google.com/health/data-types)
- [Nutrition and hydration](https://developers.google.com/health/data-types/nutrition)
- [Webhook subscriptions](https://developers.google.com/health/webhooks)
- [Cloudflare Workers OAuth provider](https://github.com/cloudflare/workers-oauth-provider)

Unofficial project; not affiliated with Google, Fitbit or Cloudflare. MIT licensed.
