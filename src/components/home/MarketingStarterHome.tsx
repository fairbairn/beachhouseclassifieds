import { SiteFooter } from "@/components/SiteFooter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";

type MarketingStarterHomeProps = {
  appName: string;
};

const stats = [
  { label: "Visitors / month", value: "120k" },
  { label: "Avg conversion", value: "4.8%" },
  { label: "Campaigns launched", value: "312" },
  { label: "Regions covered", value: "18" },
] as const;

export function MarketingStarterHome({ appName }: MarketingStarterHomeProps) {
  return (
    <div className="space-y-12 pb-4">
      <section className="relative pb-10 md:pb-14">
        <div
          className="relative isolate flex min-h-[68vh] items-center overflow-hidden rounded-3xl border border-slate-700 text-white shadow-2xl md:min-h-[76vh]"
          style={{
            backgroundImage:
              "linear-gradient(to top, rgb(2 6 23 / 0.86), rgb(2 6 23 / 0.52)), url('/hero-marketing-placeholder.svg')",
            backgroundSize: "cover",
            backgroundPosition: "center",
          }}
        >
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(56,189,248,0.16),transparent_46%)]" />
          <div className="pointer-events-none absolute inset-x-0 top-0 h-36 bg-linear-to-b from-black/45 to-transparent" />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-44 bg-linear-to-t from-black/65 to-transparent" />

          <div className="relative z-10 mx-auto flex w-full max-w-5xl flex-col items-center space-y-6 px-6 py-16 text-center md:space-y-8 md:px-10 md:py-24">
            <Badge className="border-white/30 bg-white/15 text-white">
              Marketing Landing Page Starter
            </Badge>
            <div className="space-y-4">
              <h1 className="text-4xl font-semibold tracking-tight text-balance md:text-6xl lg:text-7xl">
                Make the first 5 seconds count for {appName}
              </h1>
              <p className="mx-auto max-w-3xl text-base text-slate-100 md:text-xl">
                Lead with a bold promise, one clear action, and enough proof to
                pull people into your product story.
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <Button>Get Started</Button>
              <Button variant="secondary">View Product</Button>
              <Button variant="outline">See Pricing</Button>
            </div>
          </div>
        </div>

        <div className="relative z-20 mx-auto -mt-8 w-[calc(100%-1rem)] md:-mt-12 md:w-[calc(100%-2rem)]">
          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {stats.map((stat) => (
              <Card
                key={stat.label}
                className="space-y-1 border-slate-300/90 bg-white/96 shadow-lg backdrop-blur-sm dark:border-slate-700 dark:bg-slate-950/90"
              >
                <p className="text-xs tracking-[0.14em] text-slate-500 uppercase">
                  {stat.label}
                </p>
                <p className="text-3xl font-semibold tracking-tight">
                  {stat.value}
                </p>
              </Card>
            ))}
          </section>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.35fr_1fr]">
        <Card className="space-y-4">
          <CardTitle>Storytelling Layout Example</CardTitle>
          <CardDescription>
            This two-column region is useful for narrative copy + supporting
            visuals.
          </CardDescription>
          <div className="grid gap-4 md:grid-cols-[1.1fr_1fr]">
            <div className="space-y-3 text-sm text-slate-700 dark:text-slate-200">
              <p>
                Introduce the problem space, your perspective, and why your
                approach is different. Keep this section conversational and
                specific.
              </p>
              <p>
                Follow with proof snippets, customer outcomes, and links to
                deeper pages like pricing, docs, or vertical-specific offerings.
              </p>
              <Button variant="outline">Read Customer Story</Button>
            </div>
            <div className="space-y-3">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          </div>
        </Card>

        <Card className="space-y-4">
          <CardTitle>Conversion Modules</CardTitle>
          <CardDescription>
            Reusable blocks for offers, launch moments, or audience-specific
            messaging.
          </CardDescription>
          <div className="space-y-3">
            <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
              <p className="text-xs tracking-wide text-slate-500 uppercase">
                Module A
              </p>
              <p className="mt-1 font-medium">
                Primary value proposition + CTA
              </p>
            </div>
            <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
              <p className="text-xs tracking-wide text-slate-500 uppercase">
                Module B
              </p>
              <p className="mt-1 font-medium">
                Audience-specific use case card
              </p>
            </div>
            <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
              <p className="text-xs tracking-wide text-slate-500 uppercase">
                Module C
              </p>
              <p className="mt-1 font-medium">
                Trust signal strip or integration banner
              </p>
            </div>
          </div>
        </Card>
      </section>

      <section className="grid gap-4 lg:grid-cols-[1fr_1.2fr]">
        <Card className="space-y-4">
          <CardTitle>Social Proof Band</CardTitle>
          <CardDescription>
            Logos, testimonials, and analyst quotes fit well in this section.
          </CardDescription>
          <Separator />
          <div className="grid grid-cols-2 gap-3">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        </Card>

        <Card className="space-y-4">
          <CardTitle>Long-form Content Rail</CardTitle>
          <CardDescription>
            Example of a denser section below the fold for resource hubs,
            guides, and FAQs.
          </CardDescription>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-900">
              <p className="font-medium">Guide: Positioning Framework</p>
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                Audience, narrative, value ladder, and CTA sequencing.
              </p>
            </div>
            <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-900">
              <p className="font-medium">Guide: Launch Page Checklist</p>
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                Metadata, analytics, copy QA, and conversion tracking.
              </p>
            </div>
            <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-900">
              <p className="font-medium">Guide: Brand Voice Basics</p>
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                Tone, writing examples, and persona-specific variants.
              </p>
            </div>
            <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-900">
              <p className="font-medium">Guide: Lifecycle Messaging</p>
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                Awareness, consideration, conversion, and retention copy.
              </p>
            </div>
          </div>
        </Card>
      </section>

      <SiteFooter appName={appName} />
    </div>
  );
}
