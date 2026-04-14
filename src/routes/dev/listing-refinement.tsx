import { createFileRoute, notFound } from "@tanstack/react-router";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const BRAND_FONT_BODY =
  '"Manrope", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
const BRAND_FONT_EDITORIAL =
  '"Playfair Display", "Times New Roman", Georgia, serif';

const REFINEMENT_SAMPLE = {
  externalListingId: "watercolor-family-thyme-1295-western-lake-drive-1180",
};

type Snapshot = {
  listing_id: string;
  slug: string;
  canonical_name: string;
  property_type: string | null;
  bedrooms: number | null;
  bathrooms: string | null;
  sleeps: number | null;
  adapter_key: string | null;
  source_content_hash: string | null;
  source_description_original: string | null;
  source_meta_description_original: string | null;
  source_amenities_original: string[];
  source_amenities_categories: Record<string, string[]>;
  description_markdown: string | null;
  description_short_plain: string | null;
  seo_meta_title: string | null;
  seo_meta_description: string | null;
  seo_hidden_summary_plain: string | null;
  highlights: unknown;
  helpful_hints: unknown;
  sleeping_arrangements: unknown;
  sleeping_rollups: unknown;
  amenities_normalized: unknown;
  ai_refinement: Record<string, unknown> | null;
};

type ApiResponse = {
  snapshot: Snapshot;
  dryRun?: boolean;
  result?: unknown;
  saveTarget?: string;
  run_metrics?: {
    model?: string;
    audit_model?: string;
    usage_by_model?: Array<{
      model?: string;
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
    }>;
    duration_ms?: number;
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    estimated_cost_usd?: number | null;
    estimated_cost_note?: string | null;
  };
};

type RefinementOutputView = {
  description_markdown?: unknown;
  description_short_plain?: unknown;
  highlights?: unknown;
  helpful_hints?: unknown;
  amenities_normalized?: unknown;
  amenities_evidence?: unknown;
  sleeping_arrangements?: unknown;
  sleeping_rollups?: unknown;
  sleeping_ux_summary?: unknown;
  seo_meta_title?: unknown;
  seo_meta_description?: unknown;
  seo_hidden_summary_plain?: unknown;
};

type RefinementAuditView = {
  accuracy_score?: unknown;
  retry_recommended?: unknown;
  retry_performed?: unknown;
  issues?: unknown;
};

type RefinementAuditDecisionView = {
  performed?: unknown;
  trigger_reasons?: unknown;
  skipped_reason?: unknown;
};

function asRefinementOutput(value: unknown): RefinementOutputView {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const root = value as Record<string, unknown>;
  const output = root.output;
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return {};
  }

  return output as RefinementOutputView;
}

function asRefinementAudit(value: unknown): RefinementAuditView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const root = value as Record<string, unknown>;
  const audit = root.audit;
  if (!audit || typeof audit !== "object" || Array.isArray(audit)) {
    return null;
  }

  return audit as RefinementAuditView;
}

function asRefinementAuditDecision(
  value: unknown,
): RefinementAuditDecisionView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const root = value as Record<string, unknown>;
  const decision = root.audit_decision;
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
    return null;
  }

  return decision as RefinementAuditDecisionView;
}

function asOptionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function asNonNegativeNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.round(value));
}

async function parseApiResponse<T>(response: Response): Promise<T> {
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();

  if (!contentType.toLowerCase().includes("application/json")) {
    const preview = text.slice(0, 180).replace(/\s+/g, " ").trim();
    throw new Error(
      `API did not return JSON (status ${response.status}). Response starts with: ${preview}`,
    );
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    const preview = text.slice(0, 180).replace(/\s+/g, " ").trim();
    throw new Error(
      `Invalid JSON from API (status ${response.status}). Response starts with: ${preview}`,
    );
  }
}

export const Route = createFileRoute("/dev/listing-refinement")({
  beforeLoad: ({ location }) => {
    if (process.env.NODE_ENV === "production") {
      throw notFound();
    }

    const href =
      (location as { href?: string } | undefined)?.href ??
      (location as { pathname?: string } | undefined)?.pathname ??
      "";

    let hostname: string | null = null;
    if (href.startsWith("http://") || href.startsWith("https://")) {
      try {
        hostname = new URL(href).hostname.toLowerCase();
      } catch {
        hostname = null;
      }
    }

    if (!hostname && typeof window !== "undefined") {
      hostname = window.location.hostname.toLowerCase();
    }

    const isLocalHost =
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1";

    if (hostname && !isLocalHost) {
      throw notFound();
    }
  },
  component: ListingRefinementDevPage,
});

function ListingRefinementDevPage() {
  const [listingKey, setListingKey] = useState(
    REFINEMENT_SAMPLE.externalListingId,
  );
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [result, setResult] = useState<unknown>(null);
  const [lastDryRun, setLastDryRun] = useState<boolean | null>(null);
  const [saveTarget, setSaveTarget] = useState<string | null>(null);
  const [runMetrics, setRunMetrics] = useState<
    ApiResponse["run_metrics"] | null
  >(null);
  const [showMarkdownPreview, setShowMarkdownPreview] = useState(false);
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generatedOutput = asRefinementOutput(result);
  const auditView = asRefinementAudit(result);
  const auditDecisionView = asRefinementAuditDecision(result);
  const auditTriggeredReasons = asStringArray(
    auditDecisionView?.trigger_reasons,
  );
  const auditSkippedReason = asOptionalString(
    auditDecisionView?.skipped_reason,
  );
  const auditPerformed = Boolean(auditDecisionView?.performed);
  const auditAccuracyScore =
    typeof auditView?.accuracy_score === "number"
      ? Math.max(0, Math.min(1, auditView.accuracy_score))
      : null;
  const retryRecommended = Boolean(auditView?.retry_recommended);
  const retryPerformed = Boolean(auditView?.retry_performed);
  const markdownToRender =
    asOptionalString(generatedOutput.description_markdown) ??
    snapshot?.description_markdown ??
    "(empty)";
  const generatedHighlights = asStringArray(generatedOutput.highlights);
  const snapshotHighlights = asStringArray(snapshot?.highlights);
  const highlightsToRender =
    generatedHighlights.length > 0 ? generatedHighlights : snapshotHighlights;
  const generatedHints = asStringArray(generatedOutput.helpful_hints);
  const snapshotHints = asStringArray(snapshot?.helpful_hints);
  const hintsToRender =
    generatedHints.length > 0 ? generatedHints : snapshotHints;
  const composedMarkdownPreview = [
    markdownToRender,
    highlightsToRender.length > 0
      ? `## What Makes It Special\n${highlightsToRender
          .map((entry) => `- ${entry}`)
          .join("\n")}`
      : "",
    hintsToRender.length > 0
      ? `## Helpful Hints\n${hintsToRender
          .map((entry) => `- ${entry}`)
          .join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const sleepingUxSummary = asObject(generatedOutput.sleeping_ux_summary);
  const sleepingUxCards = [
    {
      label: "King Beds",
      value: asNonNegativeNumber(sleepingUxSummary.count_king),
    },
    {
      label: "Queen Beds",
      value: asNonNegativeNumber(sleepingUxSummary.count_queen),
    },
    {
      label: "Full Beds",
      value: asNonNegativeNumber(sleepingUxSummary.count_full),
    },
    {
      label: "Twin Beds",
      value: asNonNegativeNumber(sleepingUxSummary.count_twin_standalone),
    },
    {
      label: "Bunk Units",
      value: asNonNegativeNumber(sleepingUxSummary.count_bunk_units),
    },
    {
      label: "Bunk Sleeps",
      value: asNonNegativeNumber(sleepingUxSummary.count_bunk_sleeps_total),
    },
  ];
  const capacityFromRollups = asNonNegativeNumber(
    sleepingUxSummary.sleep_capacity_from_rollups,
  );
  const capacityTarget = asNonNegativeNumber(
    sleepingUxSummary.sleep_capacity_target,
  );
  const capacityAligned = Boolean(sleepingUxSummary.sleep_capacity_aligned);

  const modelInputPreview = snapshot
    ? {
        listing: {
          h1: snapshot.canonical_name,
          id: snapshot.listing_id,
          slug: snapshot.slug,
          canonical_name: snapshot.canonical_name,
          property_type: snapshot.property_type,
          bedrooms: snapshot.bedrooms,
          bathrooms: snapshot.bathrooms,
          sleeps: snapshot.sleeps,
          adapter_key: snapshot.adapter_key,
        },
        source: {
          h1: snapshot.canonical_name,
          meta_description: snapshot.source_meta_description_original,
          description_expanded: snapshot.source_description_original,
          amenities: {
            all: snapshot.source_amenities_original,
            categories: snapshot.source_amenities_categories,
          },
          property_profile: {
            property_type: snapshot.property_type,
            bedrooms: snapshot.bedrooms,
            bathrooms: snapshot.bathrooms,
            sleeps: snapshot.sleeps,
          },
        },
      }
    : null;

  const loadSnapshot = async () => {
    setLoading(true);
    setActiveAction("Loading source snapshot...");
    setError(null);
    setResult(null);
    setLastDryRun(null);
    setSaveTarget(null);
    setRunMetrics(null);

    try {
      const params = new URLSearchParams();
      if (listingKey.startsWith("lst_")) {
        params.set("listingId", listingKey);
      } else if (listingKey === REFINEMENT_SAMPLE.externalListingId) {
        params.set("externalListingId", listingKey);
      } else {
        params.set("slug", listingKey);
      }

      const response = await fetch(
        `/api/dev/listing-refinement?${params.toString()}`,
      );
      const json = await parseApiResponse<ApiResponse | { error: string }>(
        response,
      );

      if (!response.ok) {
        throw new Error((json as { error?: string }).error ?? "Load failed.");
      }

      setSnapshot((json as ApiResponse).snapshot);
    } catch (loadError) {
      const message =
        loadError instanceof Error ? loadError.message : String(loadError);
      setError(message);
    } finally {
      setLoading(false);
      setActiveAction(null);
    }
  };

  const runRefinement = async (dryRun: boolean) => {
    setLoading(true);
    setActiveAction("Running generation and factual audit...");
    setError(null);

    try {
      const body: Record<string, unknown> = { dryRun };
      if (listingKey.startsWith("lst_")) {
        body.listingId = listingKey;
      } else if (listingKey === REFINEMENT_SAMPLE.externalListingId) {
        body.externalListingId = listingKey;
      } else {
        body.slug = listingKey;
      }

      const response = await fetch("/api/dev/listing-refinement", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      const json = await parseApiResponse<ApiResponse | { error: string }>(
        response,
      );
      if (!response.ok) {
        throw new Error(
          (json as { error?: string }).error ?? "Refinement failed.",
        );
      }

      const payload = json as ApiResponse;
      setSnapshot(payload.snapshot);
      setResult(payload.result ?? null);
      setLastDryRun(Boolean(payload.dryRun));
      setSaveTarget(payload.saveTarget ?? null);
      setRunMetrics(payload.run_metrics ?? null);
    } catch (runError) {
      const message =
        runError instanceof Error ? runError.message : String(runError);
      setError(message);
    } finally {
      setLoading(false);
      setActiveAction(null);
    }
  };

  return (
    <main className="app-main app-main-home">
      <section className="mx-auto w-full max-w-6xl space-y-6 p-6">
        <h1 className="text-3xl font-bold">Listing Refinement Sandbox (Dev)</h1>
        <p className="text-sm opacity-80">
          Single-sample workflow for iterative refinement. Compare source before
          content against generated after fields.
        </p>

        <div className="flex flex-wrap gap-3">
          <div className="rounded border bg-slate-50 px-3 py-2 text-sm">
            <div>
              <strong>Sample External Listing Id:</strong>{" "}
              {REFINEMENT_SAMPLE.externalListingId}
            </div>
          </div>
          <button
            type="button"
            className="rounded bg-slate-800 px-4 py-2 text-white disabled:opacity-50"
            onClick={() => {
              setListingKey(REFINEMENT_SAMPLE.externalListingId);
              void loadSnapshot();
            }}
            disabled={loading}
          >
            Load Sample
          </button>
          <button
            type="button"
            className="rounded bg-amber-700 px-4 py-2 text-white disabled:opacity-50"
            onClick={() => runRefinement(true)}
            disabled={loading}
          >
            Run Dry
          </button>
          <button
            type="button"
            className="rounded bg-emerald-700 px-4 py-2 text-white disabled:opacity-50"
            onClick={() => runRefinement(false)}
            disabled={loading}
          >
            Run + Save
          </button>
        </div>

        {result ? (
          <div className="space-y-1 text-sm opacity-80">
            <p>
              Latest run mode:{" "}
              <strong>{lastDryRun ? "Dry Run" : "Run + Save"}</strong>
              {saveTarget ? (
                <>
                  {" "}
                  | Save target: <strong>{saveTarget}</strong>
                </>
              ) : null}
            </p>
            {runMetrics ? (
              <p>
                Models: <strong>{runMetrics.model ?? "n/a"}</strong>
                {runMetrics.audit_model ? (
                  <>
                    {" "}
                    (audit: <strong>{runMetrics.audit_model}</strong>)
                  </>
                ) : null}{" "}
                | Runtime: <strong>{runMetrics.duration_ms ?? 0} ms</strong> |
                Tokens: in <strong>{runMetrics.input_tokens ?? 0}</strong>, out{" "}
                <strong>{runMetrics.output_tokens ?? 0}</strong>, total{" "}
                <strong>{runMetrics.total_tokens ?? 0}</strong> | Estimated
                Cost:{" "}
                <strong>
                  {typeof runMetrics.estimated_cost_usd === "number"
                    ? `$${runMetrics.estimated_cost_usd.toFixed(6)}`
                    : "n/a"}
                </strong>
              </p>
            ) : null}
            {runMetrics?.estimated_cost_note ? (
              <p>
                Cost note: <strong>{runMetrics.estimated_cost_note}</strong>
              </p>
            ) : null}
            {auditDecisionView ? (
              <p>
                Audit call:{" "}
                <strong>{auditPerformed ? "performed" : "skipped"}</strong>
                {auditSkippedReason ? (
                  <>
                    {" "}
                    | Reason: <strong>{auditSkippedReason}</strong>
                  </>
                ) : null}
                {auditTriggeredReasons.length > 0 ? (
                  <>
                    {" "}
                    | Triggers:{" "}
                    <strong>{auditTriggeredReasons.join(" | ")}</strong>
                  </>
                ) : null}
              </p>
            ) : null}
          </div>
        ) : null}

        {loading && activeAction ? (
          <p className="rounded bg-sky-50 p-3 text-sm text-sky-900">
            {activeAction}
          </p>
        ) : null}

        {auditView ? (
          <section className="rounded border bg-slate-50 p-4 text-sm">
            <h2 className="text-base font-semibold">Factual Audit</h2>
            <p className="mt-2">
              Accuracy Score:{" "}
              <strong>
                {auditAccuracyScore !== null
                  ? `${Math.round(auditAccuracyScore * 100)}%`
                  : "n/a"}
              </strong>
            </p>
            <p>
              Retry Recommended:{" "}
              <strong>{retryRecommended ? "Yes" : "No"}</strong> | Retry
              Performed: <strong>{retryPerformed ? "Yes" : "No"}</strong>
            </p>
          </section>
        ) : null}

        {error ? (
          <p className="rounded bg-red-100 p-3 text-red-800">{error}</p>
        ) : null}

        {snapshot ? (
          <div className="grid gap-6 md:grid-cols-2">
            <article className="space-y-3 rounded border p-4">
              <h2 className="text-xl font-semibold">Before (Source)</h2>
              <p className="text-sm">
                <strong>Listing:</strong> {snapshot.canonical_name} (
                {snapshot.slug})
              </p>
              <p className="text-sm">
                <strong>Adapter:</strong> {snapshot.adapter_key ?? "n/a"}
              </p>
              <p className="text-sm">
                <strong>Property Type:</strong>{" "}
                {snapshot.property_type ?? "n/a"}
              </p>
              <p className="text-sm">
                <strong>Property Profile:</strong> beds{" "}
                {snapshot.bedrooms ?? "n/a"} | baths{" "}
                {snapshot.bathrooms ?? "n/a"} | sleeps{" "}
                {snapshot.sleeps ?? "n/a"}
              </p>
              <p className="text-sm">
                <strong>Source Hash:</strong>{" "}
                {snapshot.source_content_hash ?? "n/a"}
              </p>
              <pre className="h-56 overflow-auto rounded bg-slate-50 p-3 text-xs whitespace-pre-wrap">
                {JSON.stringify(modelInputPreview, null, 2)}
              </pre>
              <pre className="h-96 overflow-auto rounded bg-slate-50 p-3 text-xs whitespace-pre-wrap">
                {snapshot.source_description_original ?? "(empty)"}
              </pre>
              <pre className="h-56 overflow-auto rounded bg-slate-50 p-3 text-xs whitespace-pre-wrap">
                {JSON.stringify(snapshot.source_amenities_original, null, 2)}
              </pre>
            </article>

            <article className="space-y-3 rounded border p-4">
              <h2 className="text-xl font-semibold">
                {result
                  ? lastDryRun
                    ? "After (Generated Preview - Dry Run)"
                    : "After (Generated Output)"
                  : "After (Current Canonical)"}
              </h2>
              <button
                type="button"
                className="rounded bg-slate-700 px-3 py-2 text-xs text-white disabled:opacity-50"
                onClick={() => setShowMarkdownPreview(true)}
                disabled={!snapshot}
              >
                Open Full Markdown Preview
              </button>
              <pre className="h-96 overflow-auto rounded bg-slate-50 p-3 text-xs whitespace-pre-wrap">
                <div className="text-sm leading-7">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      h1: ({ children }) => (
                        <h3 className="mb-3 text-lg font-semibold">
                          {children}
                        </h3>
                      ),
                      h2: ({ children }) => (
                        <h4 className="mb-2 text-base font-semibold">
                          {children}
                        </h4>
                      ),
                      p: ({ children }) => <p className="mb-3">{children}</p>,
                      ul: ({ children }) => (
                        <ul className="mb-3 list-disc space-y-1 pl-5">
                          {children}
                        </ul>
                      ),
                      ol: ({ children }) => (
                        <ol className="mb-3 list-decimal space-y-1 pl-5">
                          {children}
                        </ol>
                      ),
                      li: ({ children }) => <li>{children}</li>,
                      strong: ({ children }) => (
                        <strong className="font-semibold">{children}</strong>
                      ),
                      em: ({ children }) => (
                        <em className="italic">{children}</em>
                      ),
                    }}
                  >
                    {markdownToRender}
                  </ReactMarkdown>
                </div>
              </pre>
              <pre className="h-56 overflow-auto rounded bg-slate-50 p-3 text-xs whitespace-pre-wrap">
                {asOptionalString(generatedOutput.description_short_plain) ??
                  snapshot.description_short_plain ??
                  "(empty)"}
              </pre>
              <div className="rounded bg-slate-50 p-3 text-xs">
                <strong>Highlights</strong>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  {highlightsToRender.length > 0 ? (
                    highlightsToRender.map((highlight, index) => (
                      <li key={`${highlight}-${index}`}>{highlight}</li>
                    ))
                  ) : (
                    <li>(none)</li>
                  )}
                </ul>
              </div>
              <div className="rounded bg-slate-50 p-3 text-xs">
                <strong>Helpful Hints</strong>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  {hintsToRender.length > 0 ? (
                    hintsToRender.map((hint, index) => (
                      <li key={`${hint}-${index}`}>{hint}</li>
                    ))
                  ) : (
                    <li>(none)</li>
                  )}
                </ul>
              </div>
              <pre className="max-h-24 overflow-auto rounded bg-slate-50 p-3 text-xs whitespace-pre-wrap">
                SEO Title:{" "}
                {asOptionalString(generatedOutput.seo_meta_title) ??
                  snapshot.seo_meta_title ??
                  "(empty)"}
                {"\n"}
                SEO Description:{" "}
                {asOptionalString(generatedOutput.seo_meta_description) ??
                  snapshot.seo_meta_description ??
                  "(empty)"}
                {"\n"}
                SEO Hidden Summary:{" "}
                {asOptionalString(generatedOutput.seo_hidden_summary_plain) ??
                  snapshot.seo_hidden_summary_plain ??
                  "(empty)"}
              </pre>
              <pre className="max-h-40 overflow-auto rounded bg-slate-50 p-3 text-xs whitespace-pre-wrap">
                {JSON.stringify(
                  generatedOutput.sleeping_arrangements ??
                    snapshot.sleeping_arrangements,
                  null,
                  2,
                )}
              </pre>
              <div className="rounded bg-slate-50 p-3 text-xs">
                <strong>Sleeping UX Summary</strong>
                <pre className="mt-2 max-h-40 overflow-auto rounded bg-white p-3 whitespace-pre-wrap">
                  {JSON.stringify(
                    asObject(generatedOutput.sleeping_ux_summary),
                    null,
                    2,
                  )}
                </pre>
              </div>
              <pre className="max-h-40 overflow-auto rounded bg-slate-50 p-3 text-xs whitespace-pre-wrap">
                {JSON.stringify(
                  generatedOutput.amenities_normalized ??
                    snapshot.amenities_normalized,
                  null,
                  2,
                )}
              </pre>
            </article>
          </div>
        ) : null}

        {result ? (
          <section className="rounded border p-4">
            <h2 className="mb-2 text-lg font-semibold">
              Latest Generation Payload
            </h2>
            <p className="mb-3 text-sm opacity-80">
              Expand each section to inspect grouped JSON output.
            </p>

            <div className="space-y-3">
              <details className="rounded border bg-slate-50 p-3" open>
                <summary className="cursor-pointer font-medium">
                  Descriptions JSON
                </summary>
                <pre className="mt-2 max-h-80 overflow-auto rounded bg-white p-3 text-xs whitespace-pre-wrap">
                  {JSON.stringify(
                    {
                      description_markdown:
                        generatedOutput.description_markdown ?? null,
                      description_short_plain:
                        generatedOutput.description_short_plain ?? null,
                      highlights: generatedOutput.highlights ?? [],
                      helpful_hints: generatedOutput.helpful_hints ?? [],
                    },
                    null,
                    2,
                  )}
                </pre>
                <details className="mt-2 rounded border bg-white p-2">
                  <summary className="cursor-pointer text-xs font-medium opacity-80">
                    Raw Markdown Text
                  </summary>
                  <pre className="mt-2 max-h-72 overflow-auto rounded bg-slate-50 p-3 text-xs whitespace-pre-wrap">
                    {markdownToRender}
                  </pre>
                </details>
              </details>

              <details className="rounded border bg-slate-50 p-3">
                <summary className="cursor-pointer font-medium">
                  Amenities JSON
                </summary>
                <pre className="mt-2 max-h-80 overflow-auto rounded bg-white p-3 text-xs whitespace-pre-wrap">
                  {JSON.stringify(
                    {
                      amenities_normalized:
                        generatedOutput.amenities_normalized ?? [],
                      amenities_evidence:
                        generatedOutput.amenities_evidence ?? [],
                    },
                    null,
                    2,
                  )}
                </pre>
              </details>

              <details className="rounded border bg-slate-50 p-3">
                <summary className="cursor-pointer font-medium">
                  Sleeping Arrangements JSON
                </summary>
                <pre className="mt-2 max-h-80 overflow-auto rounded bg-white p-3 text-xs whitespace-pre-wrap">
                  {JSON.stringify(
                    {
                      sleeping_arrangements:
                        generatedOutput.sleeping_arrangements ?? [],
                      sleeping_rollups: generatedOutput.sleeping_rollups ?? {},
                      sleeping_ux_summary:
                        generatedOutput.sleeping_ux_summary ?? {},
                    },
                    null,
                    2,
                  )}
                </pre>
              </details>

              <details className="rounded border bg-slate-50 p-3">
                <summary className="cursor-pointer font-medium">
                  SEO JSON
                </summary>
                <pre className="mt-2 max-h-80 overflow-auto rounded bg-white p-3 text-xs whitespace-pre-wrap">
                  {JSON.stringify(
                    {
                      seo_meta_title: generatedOutput.seo_meta_title ?? null,
                      seo_meta_description:
                        generatedOutput.seo_meta_description ?? null,
                      seo_hidden_summary_plain:
                        generatedOutput.seo_hidden_summary_plain ?? null,
                    },
                    null,
                    2,
                  )}
                </pre>
              </details>

              <details className="rounded border bg-slate-50 p-3">
                <summary className="cursor-pointer font-medium">
                  Raw Payload JSON
                </summary>
                <pre className="mt-2 max-h-96 overflow-auto rounded bg-white p-3 text-xs whitespace-pre-wrap">
                  {JSON.stringify(result, null, 2)}
                </pre>
              </details>
            </div>
          </section>
        ) : null}

        {showMarkdownPreview ? (
          <div className="fixed inset-0 z-50 bg-black/60 p-4">
            <div className="mx-auto flex h-full w-full max-w-5xl flex-col rounded bg-white shadow-2xl">
              <div className="flex items-center justify-between border-b px-4 py-3">
                <h2
                  className="text-lg font-semibold"
                  style={{ fontFamily: BRAND_FONT_EDITORIAL }}
                >
                  Rendered Markdown Preview
                </h2>
                <button
                  type="button"
                  className="rounded bg-slate-800 px-3 py-2 text-xs text-white"
                  onClick={() => setShowMarkdownPreview(false)}
                >
                  Close
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
                <section className="mb-5 rounded border bg-slate-50 p-4">
                  <h3 className="mb-3 text-base font-semibold">
                    Sleeping Overview (UX Preview)
                  </h3>
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {sleepingUxCards.map((card) => (
                      <div
                        key={card.label}
                        className="rounded border bg-white px-3 py-2"
                      >
                        <p className="text-[11px] tracking-wide text-slate-500 uppercase">
                          {card.label}
                        </p>
                        <p className="text-lg font-semibold">{card.value}</p>
                      </div>
                    ))}
                  </div>
                  <p className="mt-3 text-xs text-slate-700">
                    Capacity Check: <strong>{capacityFromRollups}</strong>{" "}
                    derived from beds vs <strong>{capacityTarget}</strong>{" "}
                    advertised sleeps{" "}
                    <strong>
                      ({capacityAligned ? "aligned" : "not aligned"})
                    </strong>
                  </p>
                </section>
                <article
                  className="prose prose-slate max-w-none text-sm leading-7"
                  style={{ fontFamily: BRAND_FONT_BODY }}
                >
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      h1: ({ children }) => (
                        <h2
                          className="mb-3 text-2xl font-semibold"
                          style={{ fontFamily: BRAND_FONT_EDITORIAL }}
                        >
                          {children}
                        </h2>
                      ),
                      h2: ({ children }) => (
                        <h3
                          className="mb-2 text-xl font-semibold"
                          style={{ fontFamily: BRAND_FONT_EDITORIAL }}
                        >
                          {children}
                        </h3>
                      ),
                      p: ({ children }) => <p className="mb-4">{children}</p>,
                      ul: ({ children }) => (
                        <ul className="mb-4 list-disc space-y-1 pl-5">
                          {children}
                        </ul>
                      ),
                      ol: ({ children }) => (
                        <ol className="mb-4 list-decimal space-y-1 pl-5">
                          {children}
                        </ol>
                      ),
                      li: ({ children }) => <li>{children}</li>,
                    }}
                  >
                    {composedMarkdownPreview}
                  </ReactMarkdown>
                </article>
              </div>
            </div>
          </div>
        ) : null}
      </section>
    </main>
  );
}
