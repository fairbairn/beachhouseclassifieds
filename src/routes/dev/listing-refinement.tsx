import { createFileRoute, notFound } from "@tanstack/react-router";

const CLI_COMMAND =
  "npm run refine:single -- --external-listing-id watercolor-family-thyme-1295-western-lake-drive-1180";

export const Route = createFileRoute("/dev/listing-refinement")({
  beforeLoad: () => {
    if (process.env.NODE_ENV === "production") {
      throw notFound();
    }
  },
  component: ListingRefinementDevPage,
});

function ListingRefinementDevPage() {
  return (
    <main className="app-main app-main-home">
      <section className="mx-auto w-full max-w-4xl space-y-4 p-6">
        <h1 className="text-2xl font-bold">Listing Refinement Is CLI-Only</h1>
        <p className="text-sm text-slate-700">
          AI enrichment and prompt-backed refinement are intentionally excluded
          from web routes and runtime bundles.
        </p>
        <div className="rounded-lg border border-slate-300 bg-slate-50 p-4">
          <p className="text-xs font-semibold tracking-[0.08em] text-slate-600 uppercase">
            Run via CLI
          </p>
          <pre className="mt-2 overflow-x-auto rounded bg-slate-900 p-3 text-xs text-slate-100">
            <code>{CLI_COMMAND}</code>
          </pre>
        </div>
      </section>
    </main>
  );
}
