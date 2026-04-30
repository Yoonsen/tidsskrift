## Nylænde Concordance App

React + Vite app for NB contentsearch against the `Nylænde.csv` corpus.

### Local development

```bash
npm install
npm run dev
```

### Build

```bash
npm run build
```

For GitHub Pages under a repository path, set `BASE_PATH` during build.

```bash
BASE_PATH=/nylende/ npm run build
```

### Current scope

- Loads corpus metadata from `Nylænde.csv`
- Filters corpus by year range (default 1887-1920)
- Calls `https://api.nb.no/catalog/v1/contentsearch/{sesamid|urn}/search`
- Shows concordance hits, year trends, and grouped aggregation
- Supports group import/export, aggregated CSV download, and figure export (SVG + 300 dpi PNG)

GitHub Actions workflow for build verification is in `.github/workflows/vite-build.yml`.

The workflow now builds and deploys to GitHub Pages on `main`.

### Reusable manifest and architecture

- Manifest: `app.manifest.json`
- Architecture: `docs/ARCHITECTURE.md`
- Template guide: `docs/TEMPLATE_GUIDE.md`
