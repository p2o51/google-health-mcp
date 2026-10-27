# Changelog

## 3.0.0 — 2026-10-27

- Added equal-period reports, sleep timing variation and nutrition/hydration daily summaries, with missing data and partial failures preserved.
- Added workout details/laps/events, TCX export, paired devices, account resources and connection status.
- Extended the read catalog to 38 types with nutrition, hydration, ECG and irregular-rhythm notifications.
- Added optional creation of food, water, moods, symptoms and menstrual-period records, with separate MCP write authorization and local payload previews.
- Added optional signed Google webhook reception and minimal change markers.
- Retained owner-only Access/OAuth, canonical resource metadata, 90-day rolling refresh and old refresh-token compatibility.
- Added configurable Google authorization, safe secret upload, deployment checks, documentation and CI.

Tests use synthetic records and do not write test health data to live accounts. Optional endpoints still require the relevant Google scopes and account eligibility. Webhooks require separately configured Google subscriptions. Food-database search and record update/delete are not included.
