import { useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";
import corpusCsvUrl from "../Nylænde.csv?url";

type CorpusEntry = {
  id: number;
  urn: string;
  sesamid: string;
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

type NbContentSearchHit = {
  before?: string;
  match?: string;
  after?: string;
};

type NbContentSearchResponse = {
  hits?: NbContentSearchHit[];
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

type ChartStyleMode = "color" | "bw" | "bw-dashed";

const DEFAULT_MIN_YEAR = 1887;
const DEFAULT_MAX_YEAR = 1920;
const LINE_COLORS = ["#1d4ed8", "#047857", "#be185d", "#b45309", "#4338ca", "#0369a1"];
const DASH_PATTERNS = ["0", "8 4", "2 3", "10 3 2 3", "12 4", "3 3"];
const NB_CONTENTSEARCH_API_BASE = "https://api.nb.no/catalog/v1/contentsearch";

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

function renderConcordanceHtml(fragment: string): { __html: string } {
  return { __html: fragment };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildSearchTargetId(entry: CorpusEntry): string {
  if (entry.sesamid) return entry.sesamid;
  if (entry.urn) return entry.urn;
  return String(entry.id);
}

function buildNbHitFragment(hit: NbContentSearchHit): string {
  const before = escapeHtml(hit.before ?? "");
  const match = escapeHtml(hit.match ?? "");
  const after = escapeHtml(hit.after ?? "");
  if (match.length === 0) return `${before}${after}`;
  return `${before}<b>${match}</b>${after}`;
}

function smoothPoints(points: Array<{ year: number; value: number }>, windowSize: number) {
  if (windowSize <= 1 || points.length <= 1) return points;

  const radius = Math.floor(windowSize / 2);
  return points.map((point, index) => {
    let sum = 0;
    let count = 0;
    const start = Math.max(0, index - radius);
    const end = Math.min(points.length - 1, index + radius);
    for (let i = start; i <= end; i += 1) {
      sum += points[i].value;
      count += 1;
    }
    return { year: point.year, value: sum / count };
  });
}

function buildYearRange(startYear: number, endYear: number): number[] {
  const years: number[] = [];
  for (let year = startYear; year <= endYear; year += 1) {
    years.push(year);
  }
  return years;
}

function buildFiveYearTicks(yearRange: number[]): Array<{ index: number; year: number }> {
  const ticks: Array<{ index: number; year: number }> = [];
  yearRange.forEach((year, index) => {
    if (year % 5 === 0) {
      ticks.push({ index, year });
    }
  });
  return ticks;
}

function App() {
  const [corpus, setCorpus] = useState<CorpusEntry[]>([]);
  const [activeTab, setActiveTab] = useState<"conc" | "agg">("conc");
  const [query, setQuery] = useState("");
  const [minYear, setMinYear] = useState(DEFAULT_MIN_YEAR);
  const [maxYear, setMaxYear] = useState(DEFAULT_MAX_YEAR);
  const [concPlotStartYear, setConcPlotStartYear] = useState(DEFAULT_MIN_YEAR);
  const [concPlotEndYear, setConcPlotEndYear] = useState(DEFAULT_MAX_YEAR);
  const [concSmoothingWindow, setConcSmoothingWindow] = useState(1);
  const [concChartStyleMode, setConcChartStyleMode] = useState<ChartStyleMode>("color");
  const [concPlotPanelOpen, setConcPlotPanelOpen] = useState(false);
  const [aggPlotStartYear, setAggPlotStartYear] = useState(DEFAULT_MIN_YEAR);
  const [aggPlotEndYear, setAggPlotEndYear] = useState(DEFAULT_MAX_YEAR);
  const [aggSmoothingWindow, setAggSmoothingWindow] = useState(1);
  const [aggChartStyleMode, setAggChartStyleMode] = useState<ChartStyleMode>("color");
  const [aggPlotPanelOpen, setAggPlotPanelOpen] = useState(false);
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
  const [aggProgress, setAggProgress] = useState<{ done: number; total: number; currentGroup: string }>({
    done: 0,
    total: 0,
    currentGroup: ""
  });
  const [hiddenGroups, setHiddenGroups] = useState<string[]>([]);
  const groupFileInputRef = useRef<HTMLInputElement>(null);
  const concChartRef = useRef<SVGSVGElement>(null);
  const aggChartRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    Papa.parse<Record<string, string>>(corpusCsvUrl, {
      download: true,
      header: true,
      skipEmptyLines: true,
      complete: (result) => {
        const parsed = result.data
          .map((row) => {
            const rawId = row.dhlabid ?? row.id;
            const id = Number(rawId);
            if (!Number.isFinite(id)) return null;

            const urn = (row.urn ?? "").trim();
            const sesamid = (row.sesamid ?? "").trim();
            if (!urn && !sesamid) return null;
            const year = parseYear(row.year);
            const link = (row.nettbiblioteket ?? "").trim();
            const title = (row.title ?? "").trim();

            return { id, urn, sesamid, title, year, link } as CorpusEntry;
          })
          .filter((entry): entry is CorpusEntry => !!entry)
          .sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999));

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
    const rowsPerEntry = await Promise.all(
      filteredEntries.map(async (entry) => {
        const targetId = buildSearchTargetId(entry);
        if (!targetId) return [] as ConcordanceRow[];

        const endpoint = `${NB_CONTENTSEARCH_API_BASE}/${encodeURIComponent(targetId)}/search?q=${encodeURIComponent(searchQuery)}`;
        const response = await fetch(endpoint, { method: "GET", credentials: "include" });
        if (!response.ok) {
          const message = await response.text();
          throw new Error(`HTTP ${response.status} (${targetId}): ${message}`);
        }

        const data: NbContentSearchResponse = await response.json();
        const hits = data.hits ?? [];

        return hits
          .map((hit, index) => {
            const frag = buildNbHitFragment(hit);
            if (!frag) return null;
            return {
              bookId: entry.id,
              pos: index,
              frag,
              urn: entry.urn || undefined
            } as ConcordanceRow;
          })
          .filter((row): row is ConcordanceRow => !!row);
      })
    );

    const mergedRows: ConcordanceRow[] = [];
    rowsPerEntry.forEach((entryRows) => {
      entryRows.forEach((row) => {
        mergedRows.push(row);
      });
    });
    return mergedRows.map((row, index) => ({ ...row, pos: index }));
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
    setStatus("Søker i Nettbiblioteket ...");

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

  function removeGroupRow(key: string) {
    setGroupRows((current) => {
      if (current.length <= 1) return current;
      return current.filter((row) => row.key !== key);
    });
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
    setAggProgress({ done: 0, total: cleanGroups.length, currentGroup: "" });
    setGroupStatus("Kjører aggregert konkordanstelling …");

    try {
      const allResults: GroupResult[] = [];

      for (let i = 0; i < cleanGroups.length; i += 1) {
        const group = cleanGroups[i];
        setAggProgress({ done: i, total: cleanGroups.length, currentGroup: group.group });
        const hitsPerVariant = await Promise.all(
          group.variants.map((variant) => fetchConcordanceRowsForQuery(variant, filteredCorpus))
        );
        const groupRowsRaw: ConcordanceRow[] = [];
        hitsPerVariant.forEach((variantRows) => {
          variantRows.forEach((row) => {
            groupRowsRaw.push(row);
          });
        });

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
        setAggProgress({ done: i + 1, total: cleanGroups.length, currentGroup: group.group });
      }

      setGroupResults(allResults);
      setGroupStatus(`Ferdig: ${allResults.length} grupper analysert for ${minYear}-${maxYear}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Ukjent feil";
      setGroupStatus(`Aggregert kjøring feilet: ${message}`);
    } finally {
      setGroupLoading(false);
      setAggProgress((current) => ({ ...current, currentGroup: "" }));
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

  function getSvgSize(svg: SVGSVGElement) {
    if (svg.clientWidth > 0 && svg.clientHeight > 0) {
      return { width: svg.clientWidth, height: svg.clientHeight };
    }

    const viewBox = svg.getAttribute("viewBox");
    if (viewBox) {
      const parts = viewBox
        .trim()
        .split(/[\s,]+/g)
        .map((value) => Number(value));
      if (parts.length === 4 && Number.isFinite(parts[2]) && Number.isFinite(parts[3])) {
        return { width: Math.abs(parts[2]), height: Math.abs(parts[3]) };
      }
    }
    return {
      width: Math.max(svg.clientWidth, 1),
      height: Math.max(svg.clientHeight, 1)
    };
  }

  function serializeSvg(svg: SVGSVGElement) {
    const cloned = svg.cloneNode(true) as SVGSVGElement;
    if (!cloned.getAttribute("xmlns")) {
      cloned.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    }
    if (!cloned.getAttribute("xmlns:xlink")) {
      cloned.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
    }
    return new XMLSerializer().serializeToString(cloned);
  }

  function downloadSvgFigure(svg: SVGSVGElement, filename: string) {
    downloadFile(filename, serializeSvg(svg), "image/svg+xml;charset=utf-8");
  }

  async function downloadPngFigure(svg: SVGSVGElement, filename: string) {
    const svgText = serializeSvg(svg);
    const svgBlob = new Blob([svgText], { type: "image/svg+xml;charset=utf-8" });
    const svgUrl = URL.createObjectURL(svgBlob);

    try {
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("Kunne ikke lese SVG for PNG-eksport."));
        img.src = svgUrl;
      });

      const { width, height } = getSvgSize(svg);
      const scale300Dpi = 300 / 96;
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale300Dpi));
      canvas.height = Math.max(1, Math.round(height * scale300Dpi));

      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Kunne ikke opprette canvas-kontekst.");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

      const pngBlob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => {
          if (blob) resolve(blob);
          else reject(new Error("Kunne ikke lage PNG-fil."));
        }, "image/png");
      });

      const pngUrl = URL.createObjectURL(pngBlob);
      const link = document.createElement("a");
      link.href = pngUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(pngUrl);
    } finally {
      URL.revokeObjectURL(svgUrl);
    }
  }

  function handleDownloadConcSvg() {
    if (!concChartRef.current) {
      setStatus("Fant ikke konkordansfigur for nedlasting.");
      return;
    }
    downloadSvgFigure(concChartRef.current, "konkordans-per-aar.svg");
    setStatus("Konkordansfigur lastet ned (SVG).");
  }

  async function handleDownloadConcPng() {
    if (!concChartRef.current) {
      setStatus("Fant ikke konkordansfigur for nedlasting.");
      return;
    }
    try {
      await downloadPngFigure(concChartRef.current, "konkordans-per-aar-300dpi.png");
      setStatus("Konkordansfigur lastet ned (PNG 300 dpi).");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Ukjent feil";
      setStatus(`Nedlasting feilet: ${message}`);
    }
  }

  function handleDownloadAggSvg() {
    if (!aggChartRef.current) {
      setGroupStatus("Fant ikke aggregert figur for nedlasting.");
      return;
    }
    downloadSvgFigure(aggChartRef.current, "aggregert-kurve.svg");
    setGroupStatus("Aggregert figur lastet ned (SVG).");
  }

  async function handleDownloadAggPng() {
    if (!aggChartRef.current) {
      setGroupStatus("Fant ikke aggregert figur for nedlasting.");
      return;
    }
    try {
      await downloadPngFigure(aggChartRef.current, "aggregert-kurve-300dpi.png");
      setGroupStatus("Aggregert figur lastet ned (PNG 300 dpi).");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Ukjent feil";
      setGroupStatus(`Nedlasting feilet: ${message}`);
    }
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

  const corpusYearBounds = useMemo(() => {
    const years = corpus.map((entry) => entry.year).filter((year): year is number => year !== null);
    if (years.length === 0) return { min: minYear, max: maxYear };
    return { min: Math.min(...years), max: Math.max(...years) };
  }, [corpus, minYear, maxYear]);

  const concYearBounds = useMemo(() => {
    const years = countsByYear.map(([year]) => year);
    if (years.length === 0) return corpusYearBounds;
    return { min: Math.min(...years), max: Math.max(...years) };
  }, [countsByYear, corpusYearBounds]);

  const aggYearBounds = useMemo(() => {
    const years: number[] = [];
    groupResults.forEach((group) => {
      group.byYear.forEach(([year]) => years.push(year));
    });
    if (years.length === 0) return corpusYearBounds;
    return { min: Math.min(...years), max: Math.max(...years) };
  }, [groupResults, corpusYearBounds]);

  useEffect(() => {
    setConcPlotStartYear((current) => {
      const clamped = Math.max(concYearBounds.min, Math.min(current, concYearBounds.max));
      return clamped;
    });
    setConcPlotEndYear((current) => {
      const clamped = Math.max(concYearBounds.min, Math.min(current, concYearBounds.max));
      return clamped;
    });
  }, [concYearBounds]);

  useEffect(() => {
    setAggPlotStartYear((current) => {
      const clamped = Math.max(aggYearBounds.min, Math.min(current, aggYearBounds.max));
      return clamped;
    });
    setAggPlotEndYear((current) => {
      const clamped = Math.max(aggYearBounds.min, Math.min(current, aggYearBounds.max));
      return clamped;
    });
  }, [aggYearBounds]);

  const concYearRange = useMemo(() => {
    const fromYear = Math.max(concYearBounds.min, Math.min(concPlotStartYear, concPlotEndYear));
    const toYear = Math.min(concYearBounds.max, Math.max(concPlotStartYear, concPlotEndYear));
    return buildYearRange(fromYear, toYear);
  }, [concYearBounds, concPlotStartYear, concPlotEndYear]);

  const aggYearRange = useMemo(() => {
    const fromYear = Math.max(aggYearBounds.min, Math.min(aggPlotStartYear, aggPlotEndYear));
    const toYear = Math.min(aggYearBounds.max, Math.max(aggPlotStartYear, aggPlotEndYear));
    return buildYearRange(fromYear, toYear);
  }, [aggYearBounds, aggPlotStartYear, aggPlotEndYear]);

  const concSeriesPoints = useMemo(() => {
    const yearMap = new Map(countsByYear);
    const rawPoints = concYearRange.map((year) => ({ year, value: yearMap.get(year) ?? 0 }));
    return smoothPoints(rawPoints, concSmoothingWindow);
  }, [countsByYear, concYearRange, concSmoothingWindow]);

  const concMaxValue = useMemo(() => {
    let maxValue = 0;
    for (const point of concSeriesPoints) {
      if (point.value > maxValue) maxValue = point.value;
    }
    return Math.max(maxValue, 1);
  }, [concSeriesPoints]);

  const concXAxisTicks = useMemo(() => {
    return buildFiveYearTicks(concYearRange);
  }, [concYearRange]);

  const chartSeries = useMemo(
    () =>
      groupResults.map((group, index) => {
        const yearMap = new Map(group.byYear);
        const rawPoints = aggYearRange.map((year) => ({ year, value: yearMap.get(year) ?? 0 }));
        return {
          group: group.group,
          color: LINE_COLORS[index % LINE_COLORS.length],
          points: smoothPoints(rawPoints, aggSmoothingWindow)
        };
      }),
    [groupResults, aggYearRange, aggSmoothingWindow]
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
    return buildFiveYearTicks(aggYearRange);
  }, [aggYearRange]);

  const aggProgressPercent =
    aggProgress.total > 0 ? Math.round((aggProgress.done / aggProgress.total) * 100) : 0;

  const concUseBw = concChartStyleMode === "bw" || concChartStyleMode === "bw-dashed";
  const concUseDashed = concChartStyleMode === "bw-dashed";
  const aggUseBw = aggChartStyleMode === "bw" || aggChartStyleMode === "bw-dashed";
  const aggUseDashed = aggChartStyleMode === "bw-dashed";

  return (
    <main className="page">
      <h1>Nylænde - konkordanser</h1>
      <p className="subtle">
        Kilde: NB contentsearch + korpus fra <code>Nylænde.csv</code>.
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
            Backend: <code>api.nb.no/catalog/v1/contentsearch</code> med <code>sesamid</code> / <code>urn</code>.
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
            <p className="subtle">
              Søketips: prøv frase med anførselstegn, f.eks. <code>"de forenede stater"</code>.
            </p>
            <button onClick={() => void searchConcordance()} disabled={isLoading}>
              {isLoading ? "Søker …" : "Kjør konkordans"}
            </button>
            <p className="status">{status}</p>
          </section>

          <section className="counts">
            <h2>Telling av konkordanser per år</h2>
            <div className="button-row utility-row">
              <button
                type="button"
                className="chip-btn"
                onClick={() => setConcPlotPanelOpen((open) => !open)}
              >
                Plot-parametre
              </button>
              <button type="button" onClick={handleDownloadConcSvg} disabled={countsByYear.length === 0}>
                Last ned figur (SVG)
              </button>
              <button type="button" onClick={() => void handleDownloadConcPng()} disabled={countsByYear.length === 0}>
                Last ned figur (PNG 300 dpi)
              </button>
            </div>
            {concPlotPanelOpen ? (
              <div className="plot-popover">
                <div className="year-row">
                  <label>
                    Glatting (punkter)
                    <input
                      type="number"
                      min={1}
                      max={15}
                      step={1}
                      value={concSmoothingWindow}
                      onChange={(event) => {
                        const next = Number(event.target.value);
                        if (!Number.isFinite(next)) return;
                        setConcSmoothingWindow(Math.max(1, Math.min(15, Math.round(next))));
                      }}
                    />
                  </label>
                  <label>
                    Linjestil
                    <select
                      value={concChartStyleMode}
                      onChange={(event) => setConcChartStyleMode(event.target.value as ChartStyleMode)}
                    >
                      <option value="color">Farger</option>
                      <option value="bw">Svart-hvitt</option>
                      <option value="bw-dashed">Svart-hvitt (stiplede linjer)</option>
                    </select>
                  </label>
                </div>
                <div className="year-row">
                  <label>
                    Startår
                    <input
                      type="number"
                      value={concPlotStartYear}
                      onChange={(event) => {
                        const next = Number(event.target.value);
                        if (!Number.isFinite(next)) return;
                        const bounded = Math.max(concYearBounds.min, Math.min(next, concYearBounds.max));
                        setConcPlotStartYear(bounded);
                        setConcPlotEndYear((current) => Math.max(current, bounded));
                      }}
                    />
                  </label>
                  <label>
                    Sluttår
                    <input
                      type="number"
                      value={concPlotEndYear}
                      onChange={(event) => {
                        const next = Number(event.target.value);
                        if (!Number.isFinite(next)) return;
                        const bounded = Math.max(concYearBounds.min, Math.min(next, concYearBounds.max));
                        setConcPlotEndYear(bounded);
                        setConcPlotStartYear((current) => Math.min(current, bounded));
                      }}
                    />
                  </label>
                </div>
                <p className="subtle">
                  Visning:{" "}
                  {concYearRange.length > 0
                    ? `${concYearRange[0]}-${concYearRange[concYearRange.length - 1]}`
                    : "ingen år i valgt intervall"}
                </p>
              </div>
            ) : null}
            {countsByYear.length === 0 ? (
              <p className="subtle">Ingen treff ennå.</p>
            ) : (
              <div className="chart-resizable compact">
                <svg
                  ref={concChartRef}
                  viewBox="0 0 960 180"
                  preserveAspectRatio="none"
                  className="chart chart-compact"
                >
                  <line x1="40" y1="140" x2="920" y2="140" stroke="#cbd5e1" />
                  <line x1="40" y1="20" x2="40" y2="140" stroke="#cbd5e1" />
                  {[0, 0.5, 1].map((ratio) => {
                    const y = 140 - 120 * ratio;
                    const value = Math.round(concMaxValue * ratio);
                    return (
                      <g key={`conc-y-${ratio}`}>
                        <line x1="40" y1={y} x2="920" y2={y} stroke="#f1f5f9" />
                        <text x="34" y={y + 4} textAnchor="end" className="axis-text">
                          {value}
                        </text>
                      </g>
                    );
                  })}
                  {concXAxisTicks.map((tick) => {
                    const x = 40 + (880 * tick.index) / Math.max(concYearRange.length - 1, 1);
                    return (
                      <g key={`conc-x-${tick.year}`}>
                        <line x1={x} y1="140" x2={x} y2="144" stroke="#94a3b8" />
                        <text x={x} y="160" textAnchor="middle" className="axis-text">
                          {tick.year}
                        </text>
                      </g>
                    );
                  })}
                  <polyline
                    fill="none"
                    stroke={concUseBw ? "#111827" : "#1d4ed8"}
                    strokeWidth="2.5"
                    strokeDasharray={concUseDashed ? "6 4" : undefined}
                    points={concSeriesPoints
                      .map((point, index) => {
                        const x = 40 + (880 * index) / Math.max(concSeriesPoints.length - 1, 1);
                        const y = 140 - (120 * point.value) / concMaxValue;
                        return `${x},${y}`;
                      })
                      .join(" ")}
                  />
                  {concSeriesPoints.length === 1 ? (
                    <circle
                      cx={40}
                      cy={140 - (120 * concSeriesPoints[0].value) / concMaxValue}
                      r="4"
                      fill={concUseBw ? "#111827" : "#1d4ed8"}
                    />
                  ) : null}
                </svg>
              </div>
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
                  : meta?.link || "";
                return (
                  <article key={`${row.bookId}-${row.pos}-${index}`} className="hit">
                    <p dangerouslySetInnerHTML={renderConcordanceHtml(row.frag)} />
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
                <button
                  type="button"
                  className="btn-row-delete"
                  onClick={() => removeGroupRow(row.key)}
                  disabled={groupRows.length <= 1}
                  title="Slett rad"
                >
                  ✕
                </button>
              </div>
            ))}

            <div className="button-row utility-row">
              <button
                type="button"
                onClick={() =>
                  setGroupRows((current) => [
                    ...current,
                    { key: crypto.randomUUID(), group: "", variants: "" }
                  ])
                }
              >
                + Legg til rad
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
            <div className="button-row">
              <button
                type="button"
                className="btn-run-agg"
                onClick={() => void runGroupedAggregation()}
                disabled={groupLoading}
              >
                {groupLoading ? "Kjører …" : "Kjør aggregert"}
              </button>
            </div>
            <input
              ref={groupFileInputRef}
              type="file"
              accept=".txt,.json"
              style={{ display: "none" }}
              onChange={handleUploadGroupTemplate}
            />
            {groupLoading && aggProgress.total > 0 ? (
              <div className="progress-wrap" aria-live="polite">
                <div className="progress-label">
                  <span>
                    Fremdrift: {aggProgress.done}/{aggProgress.total} ({aggProgressPercent}%)
                  </span>
                  {aggProgress.currentGroup ? <span>Gruppe: {aggProgress.currentGroup}</span> : null}
                </div>
                <div className="progress-track">
                  <div className="progress-fill" style={{ width: `${aggProgressPercent}%` }} />
                </div>
              </div>
            ) : null}
            <p className="status">{groupStatus}</p>
          </section>

          <section className="counts">
            <h2>Aggregert kurve per gruppe</h2>
            <div className="button-row utility-row">
              <button
                type="button"
                className="chip-btn"
                onClick={() => setAggPlotPanelOpen((open) => !open)}
              >
                Plot-parametre
              </button>
              <button type="button" onClick={handleDownloadAggSvg} disabled={chartSeries.length === 0}>
                Last ned figur (SVG)
              </button>
              <button type="button" onClick={() => void handleDownloadAggPng()} disabled={chartSeries.length === 0}>
                Last ned figur (PNG 300 dpi)
              </button>
            </div>
            {aggPlotPanelOpen ? (
              <div className="plot-popover">
                <div className="year-row">
                  <label>
                    Glatting (punkter)
                    <input
                      type="number"
                      min={1}
                      max={15}
                      step={1}
                      value={aggSmoothingWindow}
                      onChange={(event) => {
                        const next = Number(event.target.value);
                        if (!Number.isFinite(next)) return;
                        setAggSmoothingWindow(Math.max(1, Math.min(15, Math.round(next))));
                      }}
                    />
                  </label>
                  <label>
                    Linjestil
                    <select
                      value={aggChartStyleMode}
                      onChange={(event) => setAggChartStyleMode(event.target.value as ChartStyleMode)}
                    >
                      <option value="color">Farger</option>
                      <option value="bw">Svart-hvitt</option>
                      <option value="bw-dashed">Svart-hvitt (stiplede linjer)</option>
                    </select>
                  </label>
                </div>
                <div className="year-row">
                  <label>
                    Startår
                    <input
                      type="number"
                      value={aggPlotStartYear}
                      onChange={(event) => {
                        const next = Number(event.target.value);
                        if (!Number.isFinite(next)) return;
                        const bounded = Math.max(aggYearBounds.min, Math.min(next, aggYearBounds.max));
                        setAggPlotStartYear(bounded);
                        setAggPlotEndYear((current) => Math.max(current, bounded));
                      }}
                    />
                  </label>
                  <label>
                    Sluttår
                    <input
                      type="number"
                      value={aggPlotEndYear}
                      onChange={(event) => {
                        const next = Number(event.target.value);
                        if (!Number.isFinite(next)) return;
                        const bounded = Math.max(aggYearBounds.min, Math.min(next, aggYearBounds.max));
                        setAggPlotEndYear(bounded);
                        setAggPlotStartYear((current) => Math.min(current, bounded));
                      }}
                    />
                  </label>
                </div>
                <p className="subtle">
                  Visning:{" "}
                  {aggYearRange.length > 0
                    ? `${aggYearRange[0]}-${aggYearRange[aggYearRange.length - 1]}`
                    : "ingen år i valgt intervall"}
                </p>
              </div>
            ) : null}
            {chartSeries.length === 0 ? (
              <p className="subtle">Ingen aggregert kurve ennå.</p>
            ) : (
              <>
                <div className="chart-and-legend">
                  <div className="chart-resizable">
                    <svg
                      ref={aggChartRef}
                      viewBox="0 0 960 300"
                      preserveAspectRatio="none"
                      className="chart"
                    >
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
                        const x = 40 + (880 * tick.index) / Math.max(aggYearRange.length - 1, 1);
                        return (
                          <g key={`x-${tick.year}`}>
                            <line x1={x} y1="260" x2={x} y2="264" stroke="#94a3b8" />
                            <text x={x} y="278" textAnchor="middle" className="axis-text">
                              {tick.year}
                            </text>
                          </g>
                        );
                      })}
                      {visibleChartSeries.map((series, seriesIndex) => {
                        const polyline = series.points
                          .map((point, pointIndex) => {
                            const x = 40 + (880 * pointIndex) / Math.max(series.points.length - 1, 1);
                            const y = 260 - (240 * point.value) / maxChartValue;
                            return `${x},${y}`;
                          })
                          .join(" ");
                        return (
                          <g key={series.group}>
                            <polyline
                              fill="none"
                              stroke={aggUseBw ? "#111827" : series.color}
                              strokeWidth="2.5"
                              strokeDasharray={aggUseDashed ? DASH_PATTERNS[seriesIndex % DASH_PATTERNS.length] : undefined}
                              points={polyline}
                            />
                            {series.points.length === 1 ? (
                              <circle
                                cx={40}
                                cy={260 - (240 * series.points[0].value) / maxChartValue}
                                r="4"
                                fill={aggUseBw ? "#111827" : series.color}
                              />
                            ) : null}
                          </g>
                        );
                      })}
                    </svg>
                  </div>
                  <div className="legend legend-right">
                    {chartSeries.map((series, seriesIndex) => (
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
                        <svg className="legend-line-swatch" viewBox="0 0 28 12" aria-hidden="true">
                          <line
                            x1="1"
                            y1="6"
                            x2="27"
                            y2="6"
                            stroke={aggUseBw ? "#111827" : series.color}
                            strokeWidth="3"
                            strokeDasharray={aggUseDashed ? DASH_PATTERNS[seriesIndex % DASH_PATTERNS.length] : undefined}
                          />
                        </svg>{" "}
                        {series.group}
                      </button>
                    ))}
                  </div>
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
                          {meta?.year ?? "?"}:{" "}
                          <span dangerouslySetInnerHTML={renderConcordanceHtml(row.frag)} />
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
