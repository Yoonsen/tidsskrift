# Agent Notes for `nylende`

## Project Snapshot

- Frontend: React + Vite + TypeScript.
- Main app file: `src/App.tsx`.
- Styling: `src/App.css`.
- Corpus file: `Nylænde.csv`.

## Current Backend Strategy

- Use NB contentsearch per document:
  - `GET https://api.nb.no/catalog/v1/contentsearch/{sesamid|urn}/search?q=...`
- Prefer `sesamid` when available, fallback to `urn`.
- Treat very large hit sets as capped/truncated by endpoint behavior.

## Data Expectations

- CSV should include at least:
  - `year`
  - `title`
  - `sesamid` or `urn` (prefer both)
- Keep a stable numeric ID field for internal joins (currently `dhlabid`).

## Figure/Export Requirements

- Research-facing output must be print-friendly.
- Keep support for:
  - local plot controls per figure (smoothing, year range, style),
  - 5-year axis ticks (years ending in 0 or 5),
  - export to SVG and 300 dpi PNG.
- Aggregated export should include chart + legend in same output.

## Workflow Preferences

- When docs and code diverge, update docs in same pass:
  - `README.md`
  - `docs/ARCHITECTURE.md`
  - `docs/TEMPLATE_GUIDE.md`
- Before finalizing, always run:
  - `npm run build`
