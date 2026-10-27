# Tool reference

The server advertises 15 read tools and, when enabled, one write tool. `health_diagnostics` is an additional debug-only tool and is disabled in the public template. Exact JSON schemas are returned by MCP `tools/list`.

| Tool | Purpose |
| --- | --- |
| `get_health_summary` | Daily activity, sleep and health overview |
| `get_steps_by_day` | Daily step totals using Google's daily rollup |
| `get_sleep` | Sleep sessions, stages and timing |
| `get_workouts` | Exercise sessions and recorded metrics |
| `get_body_metrics` | Weight and other supported body measurements |
| `list_health_data_types` | 38 supported read types, filters, operations and scope names |
| `query_health_data` | One raw/reconciled page, provenance and opaque `record_id` when available |
| `aggregate_health_data` | Supported daily/physical-time rollups |
| `get_health_report` | 1–31 local days, previous equal-length period, sleep regularity and coverage |
| `get_nutrition_summary` | Recorded calories, protein/carbohydrates/fat and water by local date |
| `get_workout_details` | One workout, recorded events and lap/split metrics |
| `export_workout_tcx` | TCX XML, including recorded location, up to 1 MB |
| `get_health_devices` | Device battery, last sync and features; no MAC addresses |
| `get_health_account` | `settings`, `profile` or `irnProfile` |
| `get_health_connection_status` | Granted scope names, deployment capabilities and webhook marker |
| `log_health_record` | Optional preview/create for five log types; requires `health:write` |

## Reports and queries

```json
{"start_date":"2026-10-20","end_date":"2026-10-26","compare_previous":true}
```

Pass this to `get_health_report`. Calendar bounds are inclusive. The baseline is the immediately preceding period of equal length. Reports reconcile sleep/exercise/daily health data and use daily rollups for steps. Each type is limited to two pages per period; `truncated` identifies incomplete retrieval. `errors` identifies failed types. Comparison reliability requires at least 70% coverage on both sides and no truncation; numerical deltas remain descriptive.

Sleep belongs to its local end date; the longest session on each date supplies the bedtime. Bedtimes are anchored at noon so 23:50 and 00:10 differ by 20 minutes. This method is intended for predominantly nighttime sleep, not a clinical assessment of shift work. Missing days are excluded rather than assigned zero. `complete` describes successful, untruncated queries, not proof that the device recorded every day.

`get_nutrition_summary` takes `start_date` and `end_date`, up to 31 days, with up to three pages per type. It returns kcal, grams and milliliters only for logged values. Missing values are `null`; real zero is retained. Totals with partial errors or truncated pages must not be described as a complete daily intake.

For other reads, inspect the catalog and tool schemas. Opaque continuation tokens must be reused with the same query. Upstream quantities can be numeric strings. Raw payloads preserve Google's units; convenience tools label converted units. ECG currently supports physical start-time filtering, not civil-date filtering. IRN reads conservatively expose unfiltered pages; no undocumented date filter is constructed.

Use `query_health_data` with `data_type: "exercise"` to get a `record_id`, then pass it to `get_workout_details`. TCX export also requires `include_without_gps` (`true`, `false` or `null`); default false requests a full export. Never pass full resource paths or URLs as record IDs. No file is uploaded by this server: the TCX tool returns XML text.

`get_health_devices` requires `page_token: null` for the first page. New tools use closed schemas with all declared keys present; nullable options should be sent as `null` when not specified. Existing tools retain their published schema contracts.

## Creating records

Prerequisites: `ENABLE_WRITES=1`, MCP `health:write`, and the corresponding Google write scope described in [Deployment](DEPLOYMENT.md#google-permissions).

Call `log_health_record` with three arguments:

```json
{
  "data_type":"nutrition-log",
  "record_json":"{\"interval\":{\"startTime\":\"2026-10-27T12:00:00+09:00\",\"endTime\":\"2026-10-27T12:20:00+09:00\"},\"foodDisplayName\":\"Tofu salad\",\"mealType\":\"LUNCH\",\"energy\":{\"kcal\":320}}",
  "confirm":false
}
```

Show the validated preview to the user. Only repeat with `confirm: true` after the user approves that exact entry. `record_json` is a JSON **string containing the payload**, without a DataPoint wrapper, owner, source or resource name. This generic API is intended to be called by an MCP client; users can describe the food naturally to that client.

The server accepts up to 16 KiB of JSON, validates supported fields/enums, and fills absent UTC offset fields from the RFC3339 timestamps. Explicit offsets use Google duration notation such as `"32400s"` for UTC+09:00. Never fabricate unknown calories or nutrients; omit them or clearly identify user-approved estimates before saving.

Examples below show the inner payload before JSON-string encoding. They are synthetic documentation examples, not records to submit to a real account automatically.

### Food (`nutrition-log`)

```json
{
  "interval":{"startTime":"2026-10-27T12:00:00+09:00","endTime":"2026-10-27T12:20:00+09:00"},
  "foodDisplayName":"Tofu salad",
  "mealType":"LUNCH",
  "energy":{"kcal":320},
  "totalCarbohydrate":{"grams":18},
  "totalFat":{"grams":17},
  "nutrients":[{"nutrient":"PROTEIN","quantity":{"grams":22}}],
  "serving":{"amount":1}
}
```

Only the interval and nonempty display name are required by this tool. Calories, meal type, macros and serving are optional. Standard meal categories include `BREAKFAST`, `LUNCH`, `DINNER`, `SNACK`, `ANYTIME`; the supported enum is in `src/write-schemas.ts`. Nutrient quantities use **grams**, including micronutrients: 74 mg sodium is `0.074` grams. This release supports anonymous foods, not identified food-database references. Google does not allow editing anonymous food entries after creation.

### Water (`hydration-log`)

```json
{"interval":{"startTime":"2026-10-27T10:00:00+09:00","endTime":"2026-10-27T10:00:00+09:00"},"amountConsumed":{"milliliters":250}}
```

### Mood (`moods`)

```json
{"sampleTime":{"physicalTime":"2026-10-27T19:00:00+09:00"},"moods":["CALM","CONTENT"],"valences":["PLEASANT"]}
```

### Symptoms (`symptoms`)

```json
{"sampleTime":{"physicalTime":"2026-10-27T19:00:00+09:00"},"symptoms":["HEADACHE"]}
```

Use Google's supported enum values in `src/write-schemas.ts`; free-form mood/symptom names are not accepted. Saving a symptom is not a diagnosis.

### Menstrual period (`menstrual-period`)

```json
{"interval":{"startTime":"2026-10-20T08:00:00+09:00","endTime":"2026-10-24T20:00:00+09:00"},"notes":"User-confirmed period"}
```

Start and end must be supplied. This release creates records only; it does not implement subsequent update/delete or full-history retrieval for moods, symptoms and periods.

### Completion and retry behavior

Writes make one upstream POST with no automatic retry. `completed: true` means Google returned a completed operation without an operation error. An accepted but unfinished operation is explicitly marked unconfirmed. If a request times out, verify the destination before resubmitting: the first write may already exist. The tool is non-idempotent, and the MCP annotations reflect that. A preview does not contact Google or prove that the upstream write will succeed.
