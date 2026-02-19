import { useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";
import corpusCsvUrl from "../Nylænde.csv?url";

type CorpusEntry = {
  id: number;
  urn: string;
  title: string;
  year: number | null;
  link: string;
};

type ConcordanceRow = {
  bookId: number;
  pos: number;
  frag: string;
  urn?: string;
};

type ConcTableResponse = {
  docid?: Record<string, number | string>;
  urn?: Record<string, string>;
  conc?: Record<string, string>;
};

type GroupEditorRow = {
  key: string;
  group: string;
  variants: string;
};

type GroupResult = {
  group: string;
  total: number;
  byYear: Array<[number, number]>;
  sampleRows: ConcordanceRow[];
};

const DEFAULT_MIN_YEAR = 1887;
const DEFAULT_MAX_YEAR = 1920;
const FTS_WINDOW = 25;
const FTS_LIMIT = 1000;
const LINE_COLORS = ["#1d4ed8", "#047857", "#be185d", "#b45309", "#4338ca", "#0369a1"];
const API_BASE = "https://api.nb.no/dhlab";

function parseYear(rawYear: string | undefined): number | null {
  if (!rawYear) return null;
  const match = rawYear.match(/\d{4}/);
  if (!match) return null;
  return Number(match[0]);
}

function normalizeVariants(raw: string): string[] {
  return raw
    .split(/[\n,;]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function serializeGroupsAsText(rows: GroupEditorRow[]): string {
  return rows
    .map((row) => ({
      group: row.group.trim(),
      variants: normalizeVariants(row.variants)
    }))
    .filter((row) => row.group && row.variants.length > 0)
    .map((row) => `${row.group}: ${row.variants.join(" | ")}`)
    .join("\n");
}

function parseGroupsFromText(raw: string): Array<{ group: string; variants: string[] }> {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  return lines
    .map((line) => {
      const [groupPart, ...rest] = line.split(":");
      const group = (groupPart ?? "").trim();
      const variantsRaw = rest.join(":").trim();
      const variants = variantsRaw
        .split(/[|,;]+/g)
        .map((item) => item.trim())
        .filter(Boolean);
      return { group, variants };
    })
    .filter((row) => row.group.length > 0 && row.variants.length > 0);
}

function parseGroupsFromJson(raw: string): Array<{ group: string; variants: string[] }> {
  const parsed = JSON.parse(raw) as unknown;

  if (Array.isArray(parsed)) {
    return parsed
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const obj = item as Record<string, unknown>;
        const group = String(obj.group ?? "").trim();
        const variants = Array.isArray(obj.variants)
          ? obj.variants.map((v) => String(v).trim()).filter(Boolean)
          : [];
        if (!group || variants.length === 0) return null;
        return { group, variants };
      })
      .filter((row): row is { group: string; variants: string[] } => !!row);
  }

  if (parsed && typeof parsed === "object") {
    return Object.entries(parsed as Record<string, unknown>)
      .map(([group, value]) => {
        const variants = Array.isArray(value)
          ? value.map((v) => String(v).trim()).filter(Boolean)
          : [];
        if (!group.trim() || variants.length === 0) return null;
        return { group: group.trim(), variants };
      })
      .filter((row): row is { group: string; variants: string[] } => !!row);
  }

  return [];
}

function App() {
  const [corpus, setCorpus] = useState<CorpusEntry[]>([]);
  const [activeTab, setActiveTab] = useState<"conc" | "agg">("conc");
  const [query, setQuery] = useState("");
  const [minYear, setMinYear] = useState(DEFAULT_MIN_YEAR);
  const [maxYear, setMaxYear] = useState(DEFAULT_MAX_YEAR);
  const [status, setStatus] = useState("Laster korpus …");
  const [isLoading, setIsLoading] = useState(false);
  const [rows, setRows] = useState<ConcordanceRow[]>([]);
  const [groupRows, setGroupRows] = useState<GroupEditorRow[]>([
    { key: crypto.randomUUID(), group: "Amerika", variants: "Amerika, De forenede stater, U.S.A., sambandsstatene" },
    { key: crypto.randomUUID(), group: "England", variants: "England, Storbritannia" },
    { key: crypto.randomUUID(), group: "Frankrike", variants: "Frankrig, Frankrige, Frankrike" },
    { key: crypto.randomUUID(), group: "Sverige", variants: "Sverige" }
  ]);
  const [groupResults, setGroupResults] = useState<GroupResult[]>([]);
  const [groupStatus, setGroupStatus] = useState("Ingen aggregert kjøring ennå.");
  const [groupLoading, setGroupLoading] = useState(false);
  const [hiddenGroups, setHiddenGroups] = useState<string[]>([]);
  const groupFileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    Papa.parse<Record<string, string>>(corpusCsvUrl, {
      download: true,
      header: true,
      skipEmptyLines: true,
      complete: (result) => {
        const byId = new Map<number, CorpusEntry>();

        for (const row of result.data) {
          const rawId = row.dhlabid ?? row.id;
          const id = Number(rawId);
          if (!Number.isFinite(id)) continue;

          const urn = (row.urn ?? "").trim();
          if (!urn) continue;

          const year = parseYear(row.year);
          const link = (row.nettbiblioteket ?? "").trim();
          const title = (row.title ?? "").trim();

          if (!byId.has(id)) {
            byId.set(id, { id, urn, title, year, link });
          }
        }

        const parsed = Array.from(byId.values()).sort(
          (a, b) => (a.year ?? 9999) - (b.year ?? 9999)
        );

        setCorpus(parsed);
        setStatus(`Korpus lastet: ${parsed.length} dokumenter.`);
      },
      error: (error) => {
        setStatus(`Feil ved lasting av CSV: ${error.message}`);
      }
    });
  }, []);

  const filteredCorpus = useMemo(
    () =>
      corpus.filter((entry) => {
        if (entry.year === null) return false;
        return entry.year >= minYear && entry.year <= maxYear;
      }),
    [corpus, minYear, maxYear]
  );

  const metadataById = useMemo(() => new Map(corpus.map((entry) => [entry.id, entry])), [corpus]);

  const countsByYear = useMemo(() => {
    const counts = new Map<number, number>();
    for (const row of rows) {
      const year = metadataById.get(row.bookId)?.year;
      if (!year) continue;
      counts.set(year, (counts.get(year) ?? 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => a[0] - b[0]);
  }, [rows, metadataById]);

  async function fetchConcordanceRowsForQuery(
    searchQuery: string,
    filteredEntries: CorpusEntry[]
  ): Promise<ConcordanceRow[]> {
    const dhlabids = filteredEntries.map((entry) => entry.id);
    const payload = {
      query: searchQuery,
      html_formatting: true,
      trigram_index: false,
      window: FTS_WINDOW,
      limit: FTS_LIMIT,
      dhlabids
    };

    const response = await fetch(`${API_BASE}/conc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(`HTTP ${response.status}: ${message}`);
    }

    const data: ConcTableResponse = await response.json();
    const docid = data.docid ?? {};
    const conc = data.conc ?? {};
    const urn = data.urn ?? {};
    const indices = Object.keys(conc);

    return indices
      .map((idx, pos) => {
        const id = Number(docid[idx]);
        const frag = String(conc[idx] ?? "");
        if (!Number.isFinite(id) || !frag) return null;
        return {
          bookId: id,
          pos,
          frag,
          urn: urn[idx]
        } as ConcordanceRow;
      })
      .filter((row): row is ConcordanceRow => !!row);
  }

  async function searchConcordance() {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      setStatus("Skriv inn søkeord.");
      return;
    }
    if (filteredCorpus.length === 0) {
      setStatus("Ingen dokumenter matcher valgt årsintervall.");
      return;
    }

    setIsLoading(true);
    setRows([]);
    setStatus("Søker i konkordans...");

    try {
      const resultRows = await fetchConcordanceRowsForQuery(trimmedQuery, filteredCorpus);

      setRows(resultRows);
      setStatus(
        `Fant ${resultRows.length} konkordanser for "${trimmedQuery}" i ${minYear}-${maxYear}.`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Ukjent feil";
      setStatus(`Søk feilet: ${message}`);
    } finally {
      setIsLoading(false);
    }
  }

  function updateGroupRow(key: string, field: "group" | "variants", value: string) {
    setGroupRows((current) =>
      current.map((row) => (row.key === key ? { ...row, [field]: value } : row))
    );
  }

  async function runGroupedAggregation() {
    const cleanGroups = groupRows
      .map((row) => ({
        group: row.group.trim(),
        variants: normalizeVariants(row.variants)
      }))
      .filter((row) => row.group.length > 0 && row.variants.length > 0);

    if (cleanGroups.length === 0) {
      setGroupStatus("Legg inn minst en gruppe med minst en variant.");
      return;
    }
    if (filteredCorpus.length === 0) {
      setGroupStatus("Ingen dokumenter matcher valgt årsintervall.");
      return;
    }

    setGroupLoading(true);
    setGroupResults([]);
    setGroupStatus("Kjører aggregert konkordanstelling …");

    try {
      const allResults: GroupResult[] = [];

      for (const group of cleanGroups) {
        const queryExpr = group.variants
          .map((variant) => `"${variant.replace(/"/g, '""')}"`)
          .join(" OR ");
        const groupRowsRaw = await fetchConcordanceRowsForQuery(queryExpr, filteredCorpus);

        // Deduplicate identical hits so one paragraph match is counted once per group.
        const uniqueHits = Array.from(
          new Map(
            groupRowsRaw.map((row) => [`${row.bookId}-${row.frag}`, row] as const)
          ).values()
        );

        const byYearMap = new Map<number, number>();
        for (const hit of uniqueHits) {
          const year = metadataById.get(hit.bookId)?.year;
          if (!year) continue;
          byYearMap.set(year, (byYearMap.get(year) ?? 0) + 1);
        }

        allResults.push({
          group: group.group,
          total: uniqueHits.length,
          byYear: Array.from(byYearMap.entries()).sort((a, b) => a[0] - b[0]),
          sampleRows: uniqueHits.slice(0, 40)
        });
      }

      setGroupResults(allResults);
      setGroupStatus(`Ferdig: ${allResults.length} grupper analysert for ${minYear}-${maxYear}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Ukjent feil";
      setGroupStatus(`Aggregert kjøring feilet: ${message}`);
    } finally {
      setGroupLoading(false);
    }
  }

  function downloadFile(filename: string, content: string, mimeType: string) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function handleDownloadGroupTemplate() {
    const text = serializeGroupsAsText(groupRows);
    const content = text.length > 0 ? text : "Amerika: Amerika | De forenede stater | U.S.A.";
    downloadFile("aggregert-grupper.txt", content, "text/plain;charset=utf-8");
  }

  function handleUploadGroupTemplateClick() {
    groupFileInputRef.current?.click();
  }

  async function handleUploadGroupTemplate(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const raw = await file.text();
      const trimmed = raw.trim();
      if (!trimmed) throw new Error("Filen er tom.");

      let parsedRows: Array<{ group: string; variants: string[] }> = [];
      try {
        parsedRows = parseGroupsFromJson(trimmed);
      } catch {
        parsedRows = parseGroupsFromText(trimmed);
      }

      if (parsedRows.length === 0) {
        throw new Error("Fant ingen gyldige grupper. Bruk formatet 'Gruppe: variant | variant'.");
      }

      setGroupRows(
        parsedRows.map((row) => ({
          key: crypto.randomUUID(),
          group: row.group,
          variants: row.variants.join(", ")
        }))
      );
      setGroupStatus(`Lastet ${parsedRows.length} grupper fra fil.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Ukjent feil";
      setGroupStatus(`Kunne ikke laste grupper: ${message}`);
    } finally {
      event.target.value = "";
    }
  }

  function handleDownloadAggregatedCsv() {
    if (groupResults.length === 0) {
      setGroupStatus("Ingen aggregerte data å laste ned ennå.");
      return;
    }

    const lines = ["group,year,count,total"];
    groupResults.forEach((group) => {
      if (group.byYear.length === 0) {
        lines.push(`"${group.group.replace(/"/g, '""')}",,0,${group.total}`);
        return;
      }
      group.byYear.forEach(([year, count]) => {
        lines.push(`"${group.group.replace(/"/g, '""')}",${year},${count},${group.total}`);
      });
    });

    downloadFile("aggregert-data.csv", lines.join("\n"), "text/csv;charset=utf-8");
  }

  const fullYearRange = useMemo(() => {
    const years: number[] = [];
    for (let year = minYear; year <= maxYear; year += 1) {
      years.push(year);
    }
    return years;
  }, [minYear, maxYear]);

  const chartSeries = useMemo(
    () =>
      groupResults.map((group, index) => {
        const yearMap = new Map(group.byYear);
        return {
          group: group.group,
          color: LINE_COLORS[index % LINE_COLORS.length],
          points: fullYearRange.map((year) => ({ year, value: yearMap.get(year) ?? 0 }))
        };
      }),
    [groupResults, fullYearRange]
  );

  useEffect(() => {
    setHiddenGroups((current) =>
      current.filter((groupName) => chartSeries.some((series) => series.group === groupName))
    );
  }, [chartSeries]);

  const visibleChartSeries = useMemo(
    () => chartSeries.filter((series) => !hiddenGroups.includes(series.group)),
    [chartSeries, hiddenGroups]
  );

  const maxChartValue = useMemo(() => {
    let maxValue = 0;
    for (const series of visibleChartSeries) {
      for (const point of series.points) {
        if (point.value > maxValue) maxValue = point.value;
      }
    }
    return Math.max(maxValue, 1);
  }, [visibleChartSeries]);

  const xAxisTicks = useMemo(() => {
    if (fullYearRange.length === 0) return [] as Array<{ index: number; year: number }>;
    const desiredTickCount = 6;
    const step = Math.max(1, Math.floor((fullYearRange.length - 1) / desiredTickCount));
    const indices: number[] = [];
    for (let i = 0; i < fullYearRange.length; i += step) indices.push(i);
    if (indices[indices.length - 1] !== fullYearRange.length - 1) {
      indices.push(fullYearRange.length - 1);
    }
    return indices.map((index) => ({ index, year: fullYearRange[index] }));
  }, [fullYearRange]);

  return (
    <main className="page">
      <h1>Nylænde - konkordanser</h1>
      <p className="subtle">
        Kilde: DH-lab concordance + korpus fra <code>Nylænde.csv</code>.
      </p>

      <section className="controls">
        <h2>Korpus og søkeparametre</h2>
        <div className="year-row">
          <label>
            Fra år
            <input
              type="number"
              value={minYear}
              onChange={(event) => setMinYear(Number(event.target.value))}
            />
          </label>
          <label>
            Til år
            <input
              type="number"
              value={maxYear}
              onChange={(event) => setMaxYear(Number(event.target.value))}
            />
          </label>
        </div>
        <div className="grid">
          <div className="subtle">
            FTS5-parametre: <code>window={FTS_WINDOW}</code>, <code>limit={FTS_LIMIT}</code>
          </div>
        </div>
        <p className="subtle">Dokumenter i valgt årsområde: {filteredCorpus.length}</p>
      </section>

      <section className="tabs">
        <button
          type="button"
          className={activeTab === "conc" ? "tab active" : "tab"}
          onClick={() => setActiveTab("conc")}
        >
          Konkordans
        </button>
        <button
          type="button"
          className={activeTab === "agg" ? "tab active" : "tab"}
          onClick={() => setActiveTab("agg")}
        >
          Aggregert
        </button>
      </section>

      {activeTab === "conc" ? (
        <>
          <section className="controls">
            <h2>Konkordansvisning</h2>
            <label>
              Søk
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    void searchConcordance();
                  }
                }}
                placeholder="f.eks. Amerika"
              />
            </label>
            <button onClick={() => void searchConcordance()} disabled={isLoading}>
              {isLoading ? "Søker …" : "Kjør konkordans"}
            </button>
            <p className="status">{status}</p>
          </section>

          <section className="counts">
            <h2>Telling av konkordanser per år</h2>
            {countsByYear.length === 0 ? (
              <p className="subtle">Ingen treff ennå.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Ar</th>
                    <th>Treff</th>
                  </tr>
                </thead>
                <tbody>
                  {countsByYear.map(([year, count]) => (
                    <tr key={year}>
                      <td>{year}</td>
                      <td>{count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="results results-pane">
            <h2>Konkordanser ({rows.length})</h2>
            {rows.length === 0 ? (
              <p className="subtle">Ingen resultater å vise.</p>
            ) : (
              rows.map((row, index) => {
                const meta = metadataById.get(row.bookId);
                const label = [meta?.year, meta?.title].filter(Boolean).join(" - ");
                const resolvedUrn = row.urn || meta?.urn || "";
                const link = resolvedUrn
                  ? `https://www.nb.no/items/${resolvedUrn}?searchText=${encodeURIComponent(query.trim())}`
                  : "";
                return (
                  <article key={`${row.bookId}-${row.pos}-${index}`} className="hit">
                    <p>{row.frag}</p>
                    <p className="meta">
                      {label || `dhlabid ${row.bookId}`}
                      {link ? (
                        <>
                          {" "}
                          -{" "}
                          <a href={link} target="_blank" rel="noreferrer">
                            Vis i NB
                          </a>
                        </>
                      ) : null}
                    </p>
                  </article>
                );
              })
            )}
          </section>
        </>
      ) : (
        <>
          <section className="controls">
            <h2>Aggregert visning (gruppe + realiseringer)</h2>
            <p className="subtle">
              Legg inn en gruppe per rad. I kolonnen "Realiseringer" kan du bruke komma, semikolon
              eller linjeskift.
            </p>
            {groupRows.map((row) => (
              <div key={row.key} className="two-col">
                <input
                  value={row.group}
                  onChange={(event) => updateGroupRow(row.key, "group", event.target.value)}
                  placeholder="Gruppe, f.eks. Amerika"
                />
                <textarea
                  value={row.variants}
                  onChange={(event) => updateGroupRow(row.key, "variants", event.target.value)}
                  placeholder="Varianter, f.eks. Amerika, De forenede stater, U.S.A."
                  rows={2}
                />
              </div>
            ))}

            <div className="button-row">
              <button
                type="button"
                onClick={() =>
                  setGroupRows((current) => [
                    ...current,
                    { key: crypto.randomUUID(), group: "", variants: "" }
                  ])
                }
              >
                Legg til rad
              </button>
              <button type="button" onClick={() => void runGroupedAggregation()} disabled={groupLoading}>
                {groupLoading ? "Kjører …" : "Kjør aggregert"}
              </button>
              <button type="button" onClick={handleDownloadGroupTemplate}>
                Last ned grupper
              </button>
              <button type="button" onClick={handleUploadGroupTemplateClick}>
                Last opp grupper
              </button>
              <button type="button" onClick={handleDownloadAggregatedCsv}>
                Last ned aggregert CSV
              </button>
            </div>
            <input
              ref={groupFileInputRef}
              type="file"
              accept=".txt,.json"
              style={{ display: "none" }}
              onChange={handleUploadGroupTemplate}
            />
            <p className="status">{groupStatus}</p>
          </section>

          <section className="counts">
            <h2>Aggregert kurve per gruppe</h2>
            {chartSeries.length === 0 ? (
              <p className="subtle">Ingen aggregert kurve ennå.</p>
            ) : (
              <>
                <svg viewBox="0 0 960 300" className="chart">
                  <line x1="40" y1="260" x2="920" y2="260" stroke="#cbd5e1" />
                  <line x1="40" y1="20" x2="40" y2="260" stroke="#cbd5e1" />
                  {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
                    const y = 260 - 240 * ratio;
                    const value = Math.round(maxChartValue * ratio);
                    return (
                      <g key={`y-${ratio}`}>
                        <line x1="40" y1={y} x2="920" y2={y} stroke="#f1f5f9" />
                        <text x="34" y={y + 4} textAnchor="end" className="axis-text">
                          {value}
                        </text>
                      </g>
                    );
                  })}
                  {xAxisTicks.map((tick) => {
                    const x = 40 + (880 * tick.index) / Math.max(fullYearRange.length - 1, 1);
                    return (
                      <g key={`x-${tick.year}`}>
                        <line x1={x} y1="260" x2={x} y2="264" stroke="#94a3b8" />
                        <text x={x} y="278" textAnchor="middle" className="axis-text">
                          {tick.year}
                        </text>
                      </g>
                    );
                  })}
                  {visibleChartSeries.map((series) => {
                    const polyline = series.points
                      .map((point, index) => {
                        const x = 40 + (880 * index) / Math.max(series.points.length - 1, 1);
                        const y = 260 - (240 * point.value) / maxChartValue;
                        return `${x},${y}`;
                      })
                      .join(" ");
                    return (
                      <polyline
                        key={series.group}
                        fill="none"
                        stroke={series.color}
                        strokeWidth="2.5"
                        points={polyline}
                      />
                    );
                  })}
                </svg>
                <div className="legend">
                  {chartSeries.map((series) => (
                    <button
                      key={series.group}
                      type="button"
                      className={hiddenGroups.includes(series.group) ? "legend-toggle off" : "legend-toggle"}
                      onClick={() =>
                        setHiddenGroups((current) =>
                          current.includes(series.group)
                            ? current.filter((name) => name !== series.group)
                            : [...current, series.group]
                        )
                      }
                      title="Klikk for å slå kurve av/på"
                    >
                      <i style={{ backgroundColor: series.color }} /> {series.group}
                    </button>
                  ))}
                </div>
              </>
            )}
          </section>

          <section className="counts">
            <h2>Aggregert tabell per gruppe</h2>
            {groupResults.length === 0 ? (
              <p className="subtle">Ingen aggregerte resultater ennå.</p>
            ) : (
              groupResults.map((group) => (
                <div key={group.group} className="group-block">
                  <h3>
                    {group.group} (totalt {group.total})
                  </h3>
                  <table>
                    <thead>
                      <tr>
                        <th>Ar</th>
                        <th>Treff</th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.byYear.map(([year, count]) => (
                        <tr key={`${group.group}-${year}`}>
                          <td>{year}</td>
                          <td>{count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <details>
                    <summary>Vis eksempel-konkordanser ({group.sampleRows.length})</summary>
                    {group.sampleRows.map((row, idx) => {
                      const meta = metadataById.get(row.bookId);
                      return (
                        <p key={`${group.group}-${row.bookId}-${row.pos}-${idx}`} className="meta">
                          {meta?.year ?? "?"}: {row.frag}
                        </p>
                      );
                    })}
                  </details>
                </div>
              ))
            )}
          </section>
        </>
      )}
    </main>
  );
}

export default App;
