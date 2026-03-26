import { SiteFooter } from "@/components/SiteFooter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";

type ServicesStarterHomeProps = {
  appName: string;
};

export function ServicesStarterHome({ appName }: ServicesStarterHomeProps) {
  return (
    <div className="space-y-8 pb-4">
      <section className="relative overflow-hidden rounded-2xl border border-slate-200 bg-linear-to-br from-slate-50 via-white to-slate-100 px-6 py-10 shadow-sm md:px-10 dark:border-slate-800 dark:from-slate-950 dark:via-slate-950 dark:to-slate-900">
        <div className="absolute top-0 right-0 h-36 w-36 rounded-full bg-slate-200/40 blur-3xl dark:bg-slate-700/30" />
        <div className="relative space-y-5">
          <Badge>Starter Home</Badge>
          <div className="max-w-2xl space-y-3">
            <h1 className="text-3xl font-semibold tracking-tight text-slate-900 md:text-4xl dark:text-slate-100">
              Build your next product from {appName}
            </h1>
            <p className="text-base text-slate-600 md:text-lg dark:text-slate-300">
              This is a marketing-plus-app placeholder designed for modern
              product sites. Replace this copy with your headline, category
              positioning, and value proposition.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button>Start Setup</Button>
            <Button variant="outline">View Docs</Button>
            <Button variant="secondary">Contact Sales</Button>
          </div>
          <p className="text-xs tracking-[0.16em] text-slate-500 uppercase dark:text-slate-400">
            Trusted by teams shipping internal tools, SaaS products, and
            operational workflows
          </p>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardTitle>What You Offer</CardTitle>
          <CardDescription className="mt-2">
            Summarize your core capability and differentiator in one short
            paragraph.
          </CardDescription>
        </Card>
        <Card>
          <CardTitle>Who It Is For</CardTitle>
          <CardDescription className="mt-2">
            Describe your ideal audience, team size, and usage context.
          </CardDescription>
        </Card>
        <Card>
          <CardTitle>Why It Matters</CardTitle>
          <CardDescription className="mt-2">
            Explain measurable outcomes: time saved, accuracy, visibility, or
            control.
          </CardDescription>
        </Card>
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Card className="space-y-4">
          <div className="flex items-center justify-between">
            <CardTitle>Placeholder Content Skeleton</CardTitle>
            <Badge>CMS Slot</Badge>
          </div>
          <CardDescription>
            Wire this section to your blog, changelog, release feed, or
            onboarding docs.
          </CardDescription>
          <div className="space-y-3">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-11/12" />
            <Skeleton className="h-4 w-2/3" />
          </div>
          <Separator />
          <div className="grid gap-3 md:grid-cols-3">
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </div>
        </Card>

        <Card className="space-y-4">
          <CardTitle>Roadmap / FAQ</CardTitle>
          <CardDescription>
            Useful for launch checklist, frequently asked questions, and
            integration notes.
          </CardDescription>
          <div className="space-y-3">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        </Card>
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
        <Card className="space-y-4">
          <div className="flex items-center justify-between">
            <CardTitle>Delivery Playbook Example</CardTitle>
            <Badge>Process Section</Badge>
          </div>
          <CardDescription>
            Demonstrates a practical section pattern for outlining how your team
            executes.
          </CardDescription>
          <ol className="grid gap-3 text-sm text-slate-700 dark:text-slate-200">
            <li className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
              <strong>1. Discover:</strong> Scope business goals, data
              constraints, and success criteria.
            </li>
            <li className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
              <strong>2. Design:</strong> Map workflows, define UX direction,
              and align technical approach.
            </li>
            <li className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
              <strong>3. Deliver:</strong> Build in milestones, validate, and
              hand off with docs + support.
            </li>
          </ol>
        </Card>

        <Card className="space-y-4">
          <CardTitle>Case Study Snapshot</CardTitle>
          <CardDescription>
            Use this card for quick proof points and measurable outcomes.
          </CardDescription>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
            <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-900">
              <p className="text-xs tracking-wide text-slate-500 uppercase">
                Cycle Time
              </p>
              <p className="text-2xl font-semibold">-42%</p>
            </div>
            <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-900">
              <p className="text-xs tracking-wide text-slate-500 uppercase">
                Manual Work
              </p>
              <p className="text-2xl font-semibold">-18 hrs/wk</p>
            </div>
            <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-900">
              <p className="text-xs tracking-wide text-slate-500 uppercase">
                Adoption
              </p>
              <p className="text-2xl font-semibold">93%</p>
            </div>
          </div>
        </Card>
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card className="space-y-2">
          <CardTitle className="text-base">FAQ: Engagement Models</CardTitle>
          <CardDescription>
            Project, retainer, embedded squad, or advisory structure.
          </CardDescription>
        </Card>
        <Card className="space-y-2">
          <CardTitle className="text-base">FAQ: Typical Timeline</CardTitle>
          <CardDescription>
            Discovery to release samples for small, medium, and enterprise
            scopes.
          </CardDescription>
        </Card>
        <Card className="space-y-2">
          <CardTitle className="text-base">FAQ: Stack Coverage</CardTitle>
          <CardDescription>
            Frontend, backend, data, infra, observability, and automation notes.
          </CardDescription>
        </Card>
        <Card className="space-y-2">
          <CardTitle className="text-base">FAQ: Team Structure</CardTitle>
          <CardDescription>
            Roles, communication rhythm, and ownership expectations by phase.
          </CardDescription>
        </Card>
      </section>

      <SiteFooter appName={appName} />
    </div>
  );
}
