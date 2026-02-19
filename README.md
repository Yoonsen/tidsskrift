## Nylaende Concordance App

React + Vite app for DH-lab concordance search against the `Nylænde.csv` corpus.

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
- Calls `https://api.nb.no/dhlab/imag/concordance`
- Shows concordance hits and simple counts per year

GitHub Actions workflow for build verification is in `.github/workflows/vite-build.yml`.

The workflow now builds and deploys to GitHub Pages on `main`.
