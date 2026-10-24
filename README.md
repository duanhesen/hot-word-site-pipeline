# One photo → AI video: the pipeline behind a hot-word site

Notes and tools from building and shipping several "one photo in, one short
video out" sites on Cloudflare Workers — plus two evergreen photo→tattoo tools.

Live sites built with the same approach:

| Site | What it does |
|---|---|
| [ozilai.ink](https://ozilai.ink) | one photo → a football goal clip |
| [talkdirty.ink](https://talkdirty.ink) | one photo → a dance clip |
| [imsorryilied.ink](https://imsorryilied.ink) | an old photo → a moving confession clip |
| [tattoostencil.ink](https://tattoostencil.ink) | a photo → a 300 DPI tattoo stencil |
| [tattoofromphoto.ink](https://tattoofromphoto.ink) | a photo → tattoo line art |

## Tools in this repo

### `tools/media-pipeline.mjs`

Turns a folder of reference clips into the assets a gallery needs, without a
video editor:

- extracts a poster frame with Chromium and encodes it to WebP (~9 KB)
- computes the dominant colour (used as the placeholder before the image loads)
- reads duration and resolution
- uploads to R2 (remote **and** local, so `wrangler dev` sees the same files)
- writes a typed manifest the site imports at build time

```bash
node tools/media-pipeline.mjs --upload
```

The point: **no video decoding at request time**. The page ships a 9 KB poster
and only attaches a `<video>` when a visitor taps play.

### `tools/aeo-check.mjs`

A self-check for whether AI crawlers can actually read and quote a site:

- robots.txt is not blocking
- `/llms.txt` exists and contains concrete facts (price, specs)
- GPTBot / OAI-SearchBot / ChatGPT-User / PerplexityBot / ClaudeBot all get 200
- JSON-LD contains `SoftwareApplication` and a `FAQPage` with enough Q&A
- sitemap is reachable

```bash
node tools/aeo-check.mjs example.com
```

## What the production template does

The full template stays private, but these are the parts that mattered:

- **Credits are a ledger, not a counter.** Every movement is a row with an
  idempotency key derived from the business object (`order:<id>`,
  `generation:<id>`). Webhooks retry; users double-click. A failed render
  refunds through `generation_refund:<id>`, so a replay is a no-op.
- **Payments normalise to one event.** Every provider adapter (Dodo, Waffo,
  mock) emits the same `PaymentEvent`, and exactly one function writes it to
  the database.
- **The video job is a queue, not a request.** Submit, store the provider
  request id, poll, and let a cron reconcile anything stuck past the deadline.
- **Content is data.** Copy lives in per-locale modules that take the site
  config as an argument, so changing the keyword or the price updates every
  page — including `/llms.txt` and the structured data.
- **Ship the boring parts.** The interesting part of this product is five
  minutes of model time; the other 95% is refunds, retries and deletion.

## Licence

MIT
