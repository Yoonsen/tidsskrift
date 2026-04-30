## Arkitektur: Korpus-forst app

Denne appen er laget som en liten korpusmotor med web-UI. Korpuset er hovedobjektet, mens appen er et tynt lag for datauthenting, telling og presentasjon.

### 1) Domene

- **Korpusmetadata**: lokal CSV med minst `year`, `title` og minst en av `sesamid` eller `urn`.
- **Sok**: NB `GET /catalog/v1/contentsearch/{sesamid|urn}/search?q=...`.
- **Visning**:
  - Konkordansvisning (teksttreff med markering)
  - Arstelling (kompakt minikurve i konkordansfanen)
  - Aggregert visning (grupper av termer, kurve + tabell + eksport)

### 2) Hovedmoduler

- **`src/App.tsx`**
  - Leser CSV via `papaparse`
  - Holder state for korpus, arsfilter, grupper, resultater og plot-parametre
  - Kaller NB `contentsearch` per bok (`sesamid` prioriteres, ellers `urn`)
  - Mapper `before/match/after` til intern `ConcordanceRow`
  - Lager NB-lenke fra `urn` eller `nettbiblioteket`
- **`src/App.css`**
  - Layout for faner, resultater, kurver, knapper og legend-boks
- **`app.manifest.json`**
  - Beskriver konfigurasjon og antagelser for instansen

### 3) Dataflyt

1. CSV leses lokalt i nettleser.
2. Korpus filtreres pa ar.
3. Sokekall sendes til NB `contentsearch` per dokument.
4. Treff transformeres:
   - `before/match/after` -> HTML-fragment med `<b>` markering
   - dokument-ID -> `bookId` for join med lokal metadata
5. Treff joins mot lokal metadata for ar og tittel.
6. Aggregert visning kjorer sok per gruppevariant, dedupliserer identiske treff og grupperer per ar.

### 4) UI-prinsipper

- **To faner**:
  - `Konkordans` for utforskning
  - `Aggregert` for analyse
- **Plot-parametre er lokale per figur**:
  - glatting
  - linjestil (farger / svart-hvitt / stiplet)
  - start/slutt-ar
- **Forskerflyt**:
  - Last ned/opp grupper
  - Last ned aggregert CSV
  - Last ned figurer (SVG + 300 dpi PNG)
  - Aggregert eksport inkluderer graf + legend i samme fil

### 5) Utskiftbare deler (for ny korpusapp)

- Bytt kun:
  - CSV-fil
  - default arsintervall
  - startgrupper (hvis onskelig)
  - appnavn/tittel
- Behold normalt:
  - NB contentsearch-integrasjon
  - gruppeparser
  - eksport/import-flyt
  - Actions/Pages-deploy

### 6) Driftsmodell

- Lokal utvikling: `npm run dev`
- Produksjonsbygg: `npm run build`
- Deploy: GitHub Actions -> GitHub Pages

### 7) Kvalitetsnotater

- Trefffragmenter rendres med `dangerouslySetInnerHTML` for a vise `<b>` markering.
- Innhold saniteres med enkel escaping for `before/match/after` for rendering.
- NB `contentsearch` har cap pa responsstorrelse, sa totaler for veldig hyppige ord kan trunceres.
