# Gridwatch

Gridwatch is a full-stack web application for tracking and comparing published monthly electricity rates from distribution utilities (DUs). The initial roster covers the 21 DUs listed for Central Luzon (Region III) in the DOE 2023–2032 Distribution Development Plan. Regions, utilities, sources, effective months, customer classes, rates, and rate components are separate records so the application can grow beyond Region III.

The included historical seed contains 846 published residential totals for 20 Region III DUs from January 2023 through September 2026, sourced from TipidKuryente's public CSV credited to PRESYO-PH. The imported values are clearly labeled as third-party compiled data, not direct DU announcements. Months with no source value remain blank. For October 2026, the seed has seven totals checked against DU websites or rate schedules and five additional rounded totals from SmartEnergyPH, clearly labeled as third-party leads. Twelve of the 21 utilities therefore have an October figure; eight have September as their latest sourced month, and Subic EnerZone (SEZ) has no current public monthly residential figure verified. No missing rate is estimated.

The dashboard opens on the latest month with a published rate in the database (October 2026 in this data set), not the current calendar month when it has no rate yet. See [TipidKuryente's rate trends and data links](https://tipidkuryente.ph/electricity-rate-trends), [SmartEnergyPH's Region III rate table](https://smartenergyph.com/electricity/rates/), and the official source links stored with each rate. Verify third-party figures with the DU before relying on them as official announcements.

## Stack

- Node.js 22.5 or later. The app uses Node's built-in HTTP server and the Vercel Node.js Functions runtime.
- SQLite for local use; Supabase Postgres for the hosted website, where records persist across function restarts.
- Plain HTML, CSS, and browser JavaScript for the responsive UI. No front-end build step is required.
- `postgres` connects the server functions to Supabase through its serverless transaction pooler. `pdf-parse` handles text in public PDF announcements.

## Run locally

1. Install the packages with `npm install`.
2. Copy `.env.example` to `.env` and set a long random `GRIDWATCH_ADMIN_TOKEN`. Leave `POSTGRES_URL` blank for local SQLite use. The server loads `.env` with Node's built-in environment-file support; values already set by the host environment take precedence.
3. Start the application:

   ```sh
   node server.js
   ```

4. Open `http://localhost:3000`.

The first start creates `data/gridwatch.sqlite`, applies SQL migrations from `migrations/`, and seeds the Central Luzon roster, source registry, historical series, third-party snapshot, and checked October 2026 utility rates from `seed/`. Seed imports are idempotent, and later manual rate entries are preserved.

The app uses the Asia/Manila timezone for effective months. Set `PORT`, `HOST`, and `DATABASE_PATH` to match your local environment. Local data stays in SQLite; the hosted Vercel version uses Supabase Postgres.

## Scheduled ingestion

Ingestion checks sources that are both enabled and marked `ingest_enabled`. The Vercel Cron job in `vercel.json` calls the protected refresh route once a day at 00:00 UTC (08:00 in the Philippines). It checks the current effective month and retries daily through the month. Vercel Hobby permits one cron run per day.

The ingestor fetches public HTTP/HTTPS pages and PDF documents, records retrieval and parse failures in `source_checks`, and looks for a clearly labeled residential amount tied to the current month. Most matches become an **unreviewed candidate** for an administrator to compare with the original source. A failed fetch or missing rate never changes a rate record. Image-only PDFs are recorded as parse failures.

SmartEnergyPH DU profile pages are registered as **third-party leads** and checked with a table-specific parser. When it finds a clear current-month residential row and generation value with confidence at or above `INGEST_AUTO_PUBLISH_CONFIDENCE`, that figure can be published automatically as a labeled third-party lead. It is rounded to the source's two decimal places and is not presented as an official DU announcement. Set `INGEST_AUTO_PUBLISH_THIRD_PARTY=false` to require administrator approval instead. If the table does not match the expected columns, no number is published. Facebook references remain manual because this project does not use Meta's authenticated API.

For local use, run a refresh manually from the administrator page or use this command:

```sh
node server.js --ingest-once
```

The command checks the current Manila month. It is safe to rerun because candidate keys are unique by source, month, and customer class. GitHub's included workflow is also manual; Vercel handles the automatic daily schedule online.

### Manual refresh

Open **Sources and coverage → Administrator tools**, enter the configured admin token, then choose **Refresh registered sources**. The refresh checks the month currently selected on the page. Most findings are staged in the review queue; clear SmartEnergyPH table matches follow the auto-publish setting above.

The same action is available at `POST /api/admin/refresh` with `x-admin-token` set to `GRIDWATCH_ADMIN_TOKEN`; an optional JSON body can specify `{"month":"2026-11"}`.

### Deploy free with Vercel and Supabase

This setup is intended for a personal, non-commercial project and costs $0 while it stays within the providers' free limits. Vercel Hobby is for personal/non-commercial use, and its scheduled jobs run once per day on the free plan. Supabase Free includes a 500 MB database; inactive projects can be paused after a week of low database activity and must be resumed in the Supabase dashboard. Check the providers' current [Vercel plan details](https://vercel.com/docs/plans/hobby), [Vercel cron limits](https://vercel.com/docs/cron-jobs/manage-cron-jobs), [Supabase pricing](https://supabase.com/pricing), and [Supabase pause policy](https://supabase.com/docs/guides/platform/free-project-pausing).

1. Create a Supabase project and choose Singapore as its region. After it is ready, open **Connect**, choose **Transaction pooler**, and copy the URI. Keep the URI private. Add `&workaround=supabase-pooler.vercel` to the end of the URI (or `?workaround=supabase-pooler.vercel` if it has no query string). Supabase recommends its transaction pooler for serverless functions; the app uses a single pooled connection with prepared statements disabled. See [Supabase's serverless connection instructions](https://supabase.com/docs/guides/database/connecting-to-postgres/serverless-drivers).
2. In Vercel, choose **Add New → Project**, import `rcgames415/Gridwatch`, and deploy with the default settings. The repository's `vercel.json` sets Singapore as the function region, includes the database seed and migration files, and schedules the daily refresh at 08:00 Philippines time.
3. Before opening the live site, add these three **Production** environment variables in Vercel under **Project Settings → Environment Variables**:

   - `POSTGRES_URL`: the complete Supabase Transaction Pooler URI with the workaround parameter above.
   - `GRIDWATCH_ADMIN_TOKEN`: a private long random phrase used to unlock Administrator tools.
   - `CRON_SECRET`: a different private long random phrase used to protect the scheduled refresh.

   Do not put these values in GitHub or in a source file. Vercel sends the `CRON_SECRET` as a Bearer token to the scheduled route. After saving the variables, redeploy the project.

The first request to the site creates the Supabase tables, applies the migration, and imports the included roster and rate history. The Vercel daily job checks current-month sources and retries the missing DUs. Open the site's **Sources and coverage → Administrator tools** and enter `GRIDWATCH_ADMIN_TOKEN` to manage rates and sources. The free Supabase project does not include automatic database backups, so export a copy before making major data changes.

The included GitHub workflow remains available for a manual refresh. Do not enable a second daily schedule while Vercel Cron is active.

### Facebook announcements

The Region III source registry includes Facebook references where the DU's own site confirms the page, plus clearly labeled third-party leads where the link still needs confirmation. Facebook sources are available as citations for a person to review; they are deliberately excluded from automatic refresh. To enter a Facebook rate announcement, open the post, copy its direct URL, and use **Sources and coverage → Administrator tools → Enter or correct a rate**. Set the source type to **Official social media** only after confirming the page is controlled by the DU; otherwise leave it as a lead and verify it first. Then compare the post's month, class, published total, and components before saving.

Facebook pages often require login or load posts dynamically, so the public-page parser cannot reliably retrieve rate posts. The application does not scrape Facebook pages. Configure an authorized Meta API integration before enabling automated Facebook retrieval; Meta says automated data collection without permission violates its terms ([Meta: How we combat scraping](https://about.fb.com/news/2021/04/how-we-combat-scraping/)).

## Admin API

All `/api/admin/*` endpoints require `x-admin-token`. The Sources and coverage page provides forms for the common roster, source, candidate-review, and rate-entry actions. For scripts or integrations, the core endpoints are:

| Method and path | Purpose |
|---|---|
| `POST /api/admin/regions` | Add a region (`name`, `region_code`, optional `id`). |
| `PUT /api/admin/regions/:id` | Update a region's name, code, or country. |
| `POST /api/admin/dus` | Add a DU (`region_id`, `full_name`, `acronym`, `du_type`, optional service notes and identity URL). |
| `PUT /api/admin/dus/:id` | Edit region, name, acronym, type, service-area notes, identity source, or active state. |
| `POST /api/admin/sources` | Add a typed source link and opt it into ingestion when appropriate. |
| `PUT /api/admin/sources/:id` | Update a source link, type, notes, and ingestion setting. |
| `GET /api/admin/candidates` | List extraction candidates that need review. |
| `POST /api/admin/candidates/:id/approve` | Approve a reviewed candidate and create/update its rate. |
| `POST /api/admin/candidates/:id/reject` | Dismiss a candidate without publishing it. |
| `POST /api/admin/rates` | Enter a verified rate manually. `components` is an array and may be empty. |
| `PUT /api/admin/rates/:id` | Correct a rate; prior values are preserved in the audit log. |
| `GET /api/admin/audit` | Read recent roster, source, rate, and ingestion changes. |

Example manual rate payload:

```json
{
  "du_id": "aec",
  "effective_month": "2026-11",
  "customer_class_id": "residential",
  "published_total": "12.3456",
  "currency": "PHP",
  "unit": "kWh",
  "source_url": "https://example.org/official-rate-announcement",
  "source_type": "official_website",
  "publication_date": "2026-11-05",
  "review_status": "approved",
  "basis": "Published residential rate per kWh",
  "components": [
    { "normalized_category": "generation", "original_label": "Generation charge", "value": "6.1234", "value_state": "value" },
    { "normalized_category": "system_loss", "original_label": "System loss", "value": "0", "value_state": "zero" }
  ]
}
```

Component `value_state` can be `value`, `zero`, `missing`, or `not_published`. Only source-published components should be entered. The published total is stored independently and is not replaced by a sum of components.

## Data and status rules

- Public comparisons show only approved rates and default to the Residential class.
- Every rate keeps its DU, effective month, class, currency, unit, normalized and original published total, source URL/type, publication date, retrieval timestamp, extraction/review state, and comparison basis.
- Components keep the source's original label and formatted amount alongside a normalized value/category. Known categories include generation, transmission, distribution, system loss, supply, metering, universal charges, taxes, adjustments, and other charges.
- A candidate with unclear text or a low-confidence extraction remains in the admin review queue. It is not included in public totals or charts.
- Monthly DU coverage is `current`, `needs review`, `pending`, or `unavailable`. A missing announcement is pending. A retrieval or parsing failure is unavailable only when all enabled ingestion sources for that DU fail. Missing values are never backfilled.
- Rate, roster, and source changes are written to `audit_log`; approved rates are unique by utility, effective month, and customer class. A correction updates the current record while preserving the previous value in history.
- `source_type` distinguishes `official_website`, `official_social`, `regulatory_reference`, and `third_party_lead`. DOE/ERC references support identity and regulatory context; they are not presented as monthly DU announcements.

## API for read-only use

- `GET /api/bootstrap` returns regions, utilities, sources, approved rates with components, classes, latest available month, and current-month coverage.
- `GET /api/coverage?month=YYYY-MM` returns status for each active DU.
- `GET /api/rates?from=YYYY-MM&to=YYYY-MM&dus=aec,cedc&customer_class_id=residential` returns approved comparable rates.
- `GET /api/breakdown?month=YYYY-MM&dus=aec,cedc` returns the approved monthly records with components.

## Hosting notes

Vercel serves files from `public/` through its CDN and sends `/api/*` requests to the Node function. Vercel's function and Cron configuration is in `vercel.json`; the Cron schedule uses UTC, where 00:00 UTC equals 08:00 in the Philippines. The local `node server.js` command uses SQLite and does not start a background scheduler. The hosted instance uses `POSTGRES_URL` and the Vercel Cron route.

## Seed references

- [DOE 2023–2032 Distribution Development Plan](https://prod-cms.doe.gov.ph/documents/d/epimb/2023-2032-distribution-development-plan)
- [DOE electricity rates data reference](https://doe.gov.ph/data-and-prices/electricity)
- [ERC Region III distribution utility profiles](https://www.erc.gov.ph/Content-Singular/184)
- [ERC private utilities' latest approved rate schedules](https://www.erc.gov.ph/Content-Singular/181)

Per-DU public website and ERC reference records are seeded separately in the source registry. Confirmed Facebook pages are also registered for manual review; unconfirmed Facebook URLs remain labeled as third-party leads. Verify any source before enabling ingestion, especially a historical or third-party link.

## Git

The public source repository is [rcgames415/Gridwatch](https://github.com/rcgames415/Gridwatch). It excludes `.env`, generated SQLite files, logs, installed dependencies, and local output folders. Keep provider passwords and tokens in the Vercel environment settings only.

```sh
git init -b main
git add .
git commit -m "Initial Gridwatch application"
git remote add origin <your-repository-url>
git push -u origin main
```

To get updates in an existing local copy of the project, open its terminal and run `git pull` from the `main` branch.
