## Arkitektur: Korpus-først app

Denne appen er laget som en liten korpusmotor med web-UI. Poenget er at korpuset er hovedobjektet, mens appen er et tynt lag rundt datauthenting, telling og presentasjon.

### 1) Domene

- **Korpusmetadata**: lokal CSV med minst `dhlabid`, `urn`, `year`, `title`.
- **Søk**: DH-lab `POST /dhlab/conc` (FTS5 query).
- **Visning**:
  - Konkordansvisning (teksttreff med markering)
  - Årstelling (kompakt minikurve i konkordansfanen)
  - Aggregert visning (grupper av termer, kurve + tabell + eksport)

### 2) Hovedmoduler

- **`src/App.tsx`**
  - Leser CSV via `papaparse`
  - Holder all state (korpus, årsfilter, grupper, resultater)
  - Kaller `/dhlab/conc`
  - Mapper svarformatet `docid/urn/conc` til intern `ConcordanceRow`
  - Lager NB-lenke fra URN
- **`src/App.css`**
  - Layout for faner, resultater, kurver, knapper og legend-toggles
- **`app.manifest.json`**
  - Beskriver konfigurasjon og antagelser for denne instansen

### 3) Dataflyt

1. CSV leses lokalt i nettleser.
2. Korpus filtreres på år.
3. Søkeuttrykk sendes til `/dhlab/conc` med `dhlabids`.
4. Svar transformeres:
   - `docid` -> `bookId`
   - `conc` -> tekstfragment
   - `urn` -> lenkegrunnlag
5. Treff joins mot lokal metadata (`dhlabid`) for år og tittel.
6. Aggregert visning bygger FTS5-spørring per gruppe (OR mellom varianter), dedupliserer og grupperer per år.

### 4) UI-prinsipper

- **To faner**:
  - `Konkordans` for utforskning
  - `Aggregert` for analyse
- **Tydelige handlinger** i aggregert:
  - `+ Legg til rad`
  - Slett rad
  - `Kjør aggregert` som primærknapp
- **Forskerflyt**:
  - Last ned/opp grupper
  - Last ned aggregert CSV
  - Klikk til Nettbiblioteket for kontroll-lesing

### 5) Utskiftbare deler (for ny korpusapp)

- Bytt kun:
  - `corpus.metadataFile` i manifest
  - default årsspenn
  - startgrupper (hvis ønskelig)
  - appnavn/tittel
- Behold:
  - `/dhlab/conc`-integrasjon
  - gruppeparser
  - eksport/import-flyt
  - Actions/Pages-deploy

### 6) Driftsmodell

- Lokal utvikling: `npm run dev`
- Produksjonsbygg: `npm run build`
- Deploy: GitHub Actions -> GitHub Pages

### 7) Kvalitetsnotater

- HTML fra `conc` rendres med `dangerouslySetInnerHTML` for å vise `<b>` markering.
- Dette er akseptabelt her fordi innholdet kommer fra kjent API og brukes som konkordansvisning.
- Ved utvidelse til flere datakilder bør HTML sanitiseres før rendering.
