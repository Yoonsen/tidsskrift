## Malguide for nye korpus

Bruk denne appen som base når du lager en ny korpusbasert miniapp.

### Hurtigoppskrift

1. Kopier repo.
2. Legg inn ny korpusfil (`.csv`) i rot.
3. Oppdater `app.manifest.json`.
4. Oppdater startverdier i `src/App.tsx`:
   - appnavn/tittel
   - default årsspenn
   - eventuelle startgrupper
5. Kjør lokalt:
   - `npm install`
   - `npm run dev`
6. Push til GitHub og deploy via Actions.

### Minimumskrav til CSV

CSV må minst ha disse feltene:

- `urn` eller `sesamid` (helst begge)
- `year`
- `title`

Anbefalte felter utover minimum:

- `nettbiblioteket` (for stabile lenker i UI)
- `dhlabid` eller annen numerisk ID (intern nøkkel i appen)

### Gruppeformat (forsker-vennlig)

Anbefalt tekstformat for import:

```text
Amerika: Amerika | De forenede stater | U.S.A. | sambandsstatene
England: England | Storbritannia
```

Støttet JSON-format:

- Array:
```json
[
  { "group": "Amerika", "variants": ["Amerika", "U.S.A."] }
]
```

- Objekt:
```json
{
  "Amerika": ["Amerika", "U.S.A."],
  "England": ["England", "Storbritannia"]
}
```

### Hva som vanligvis tunes

- Default årsintervall
- Gruppeforslag
- Sokehints i UI
- Små språkjusteringer i labels

### Hva som normalt ikke røres

- NB contentsearch-kall per dokument (`sesamid`/`urn`)
- Join mellom treff og lokal metadata-ID
- Eksport/import-flyt
- Deploy-workflow
