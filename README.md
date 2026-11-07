# Gridwatch

Gridwatch is a full-stack web application for tracking and comparing published monthly electricity rates from distribution utilities (DUs). The initial roster covers the 21 DUs listed for Central Luzon (Region III) in the DOE 2023–2032 Distribution Development Plan. Regions, utilities, sources, effective months, customer classes, rates, and rate components are separate records so the application can grow beyond Region III.

The included historical seed contains 846 published residential totals for 20 Region III DUs from January 2023 through September 2026, sourced from TipidKuryente's public CSV credited to PRESYO-PH. The imported values are clearly labeled as third-party compiled data, not direct DU announcements. Months with no source value remain blank. For October 2026, the seed has seven totals checked against DU websites or rate schedules and five additional rounded totals from SmartEnergyPH, clearly labeled as third-party leads. Twelve of the 21 utilities therefore have an October figure; eight have September as their latest sourced month, and Subic EnerZone (SEZ) has no current public monthly residential figure verified. No missing rate is estimated.

The dashboard opens on the latest month with a published rate in the database (October 2026 in this data set), not the current calendar month when it has no rate yet. See [TipidKuryente's rate trends and data links](https://tipidkuryente.ph/electricity-rate-trends), [SmartEnergyPH's Region III rate table](https://smartenergyph.com/electricity/rates/), and the official source links stored with each rate. Verify third-party figures with the DU before relying on them as official announcements.

## Stack

- Node.js 22.5 or later. The app uses Node's built-in HTTP server and `node:sqlite`.
- SQLite for persistent structured records, migrations, and audit history.
- Plain HTML, CSS, and browser JavaScript for the responsive UI. No package installation or build step is required.
- `pdftotext` (Poppler) is optional for extracting text from public PDF announcements. HTML pages and plain text are handled directly.

## Run locally

1. Copy `.env.example` to `.env` and set a long random `GRIDWATCH_ADMIN_TOKEN`. The server loads `.env` with Node's built-in environment-file support; values already set by the host environment take precedence.
2. Start the application:

   ```sh
   node server.js
   ```

3. Open `http://localhost:3000`.

The first start creates `data/gridwatch.sqlite`, applies SQL migrations from `migrations/`, and seeds the Central Luzon roster, source registry, 846-row historical series, third-party snapshot, and checked October 2026 utility rates from the files in `seed/`. Rate seed imports are idempotent; official October corrections replace only the matching initial seeded third-party row, and all replacements are written to the audit history. Later manual rate entries are preserved.

The app uses the Asia/Manila timezone for the current effective month and the scheduler. Set `PORT`, `HOST`, and `DATABASE_PATH` to match your environment. Keep the database on persistent storage in production.

## Scheduled ingestion

Ingestion checks sources that are both enabled and marked `ingest_enabled`. The built-in scheduler runs daily at `INGEST_HOUR_MANILA` (default `08`, 24-hour time) in `Asia/Manila`. It checks the current effective month and retries daily through the month. Set `INGEST_ENABLED=false` to disable the in-process scheduler.

The ingestor fetches public HTTP/HTTPS pages and PDF documents, records retrieval and parse failures in `source_checks`, and looks for a clearly labeled residential amount tied to the current month. Most matches become an **unreviewed candidate** for an administrator to compare with the original source. A failed fetch or missing rate never changes a rate record. Unsupported or image-only PDFs are recorded as parse failures; install Poppler (`pdftotext`) on the server to process text PDFs.

SmartEnergyPH DU profile pages are registered as **third-party leads** and checked with a table-specific parser. When it finds a clear current-month residential row and generation value with confidence at or above `INGEST_AUTO_PUBLISH_CONFIDENCE`, that figure can be published automatically as a labeled third-party lead. It is rounded to the source's two decimal places and is not presented as an official DU announcement. Set `INGEST_AUTO_PUBLISH_THIRD_PARTY=false` to require administrator approval instead. If the table does not match the expected columns, no number is published. Facebook references remain manual because this project does not use Meta's authenticated API.

The in-process scheduler retries once daily through the month while the web service remains running. The included `.github/workflows/refresh-rates.yml` is manual by default so it does not duplicate the Render scheduler. For a host that sleeps or cannot run a background timer, enable its `schedule` trigger and configure these GitHub settings:

- Repository variable `GRIDWATCH_BASE_URL`: the public HTTPS URL of the deployed Gridwatch site.
- Repository secret `GRIDWATCH_ADMIN_TOKEN`: the same token configured in the deployed app's environment.

When you enable the schedule, the workflow calls the app at 08:15 Asia/Manila every day and can also be started with GitHub's **Run workflow** button. Set `INGEST_ENABLED=false` on the web service so only one scheduler runs. The source check still will not fill a missing month with an estimate.

For a deployment that cannot keep one web process alive and does not use the included GitHub workflow, disable the in-process scheduler and schedule this command daily in the Asia/Manila timezone:

```sh
node server.js --ingest-once
```

The command checks the current Manila month, and is safe to rerun: candidate keys are unique by source, month, and customer class. Use a single daily job (for example, 08:00 Asia/Manila) to retry throughout the month. Do not run a production scheduler against an ephemeral database.

### Manual refresh

Open **Sources and coverage → Administrator tools**, enter the configured admin token, then choose **Refresh registered sources**. The refresh checks the month currently selected on the page. Most findings are staged in the review queue; clear SmartEnergyPH table matches follow the auto-publish setting above.

The same action is available at `POST /api/admin/refresh` with `x-admin-token` set to `GRIDWATCH_ADMIN_TOKEN`; an optional JSON body can specify `{"month":"2026-11"}`.

### Deploy on Render

The repository includes `render.yaml` for a Node.js web service in Singapore. It attaches a 1 GB persistent disk at `/var/data` and points SQLite there, so rate records survive restarts and deploys. Render's free web services cannot attach persistent disks; the current smallest always-on web service plan is $7 per month and a 1 GB disk adds $0.25 per month. The Hobby workspace plan is free and includes 5 GB monthly bandwidth; usage above that is currently $0.15 per GB. This makes the expected starting cost about **$7.25/month**, plus any bandwidth overage or applicable taxes. See [Render's current pricing](https://render.com/pricing).

To deploy, push the repository to GitHub, open the Render Dashboard, select **New → Blueprint**, connect the repository, and apply the `render.yaml` plan. Render generates the administrator token as a secret environment variable. After the first deploy, find `GRIDWATCH_ADMIN_TOKEN` under the service's Environment settings and use it to unlock Administrator tools. The app's built-in scheduler checks sources daily at 08:00 Asia/Manila while the service is running. A disk-backed service uses one instance and has a brief interruption during deploys.

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

## Deployment

Run `node server.js` as the web process and expose the configured `PORT`. Set `GRIDWATCH_ADMIN_TOKEN`, `DATABASE_PATH`, scheduler variables, and persistent storage in the host's environment. Configure a health check against `/api/bootstrap`. For a single always-on instance, keep the built-in daily scheduler enabled. For a sleeping web service, use the included GitHub workflow with the deployed site URL and admin token; set `INGEST_ENABLED=false` on the web service so only the workflow schedules checks. A separate cron job can instead run `node server.js --ingest-once` daily with the same persistent database and environment. Only one scheduler should run for a given database.

The interface can also be served behind a reverse proxy, but API paths must be forwarded to the Node service. Keep the admin token out of source control and restrict write endpoints at the host boundary when exposing the app publicly.

## Seed references

- [DOE 2023–2032 Distribution Development Plan](https://prod-cms.doe.gov.ph/documents/d/epimb/2023-2032-distribution-development-plan)
- [DOE electricity rates data reference](https://doe.gov.ph/data-and-prices/electricity)
- [ERC Region III distribution utility profiles](https://www.erc.gov.ph/Content-Singular/184)
- [ERC private utilities' latest approved rate schedules](https://www.erc.gov.ph/Content-Singular/181)

Per-DU public website and ERC reference records are seeded separately in the source registry. Confirmed Facebook pages are also registered for manual review; unconfirmed Facebook URLs remain labeled as third-party leads. Verify any source before enabling ingestion, especially a historical or third-party link.

## Git

The repository excludes `.env`, generated SQLite files, logs, installed dependencies, and local output folders. From the extracted project directory, create a local commit and connect the empty repository you created with your Git host:

```sh
git init -b main
git add .
git commit -m "Initial Gridwatch application"
git remote add origin <your-repository-url>
git push -u origin main
```

Set deployment environment variables and persistent database storage on the hosting platform before launching a public instance. This project bundle has no remote configured and has not been pushed or published.
