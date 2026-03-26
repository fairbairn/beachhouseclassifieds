import { SiteFooter } from "@/components/SiteFooter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

type SaasStarterHomeProps = {
  appName: string;
};

export function SaasStarterHome({ appName }: SaasStarterHomeProps) {
  return (
    <div className="space-y-8 pb-4">
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm md:p-10 dark:border-slate-800 dark:bg-slate-950">
        <div className="grid gap-8 lg:grid-cols-[1.2fr_1fr] lg:items-center">
          <div className="space-y-4">
            <Badge>SaaS Starter</Badge>
            <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">
              A clean launchpad for product-led growth in {appName}
            </h1>
            <p className="text-slate-600 dark:text-slate-300">
              Use this section for your product value proposition, onboarding
              callouts, and conversion-focused actions.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button>Start Free Trial</Button>
              <Button variant="outline">Watch Demo</Button>
            </div>
          </div>
          <Card className="space-y-3 bg-slate-50 dark:bg-slate-900">
            <CardTitle className="text-base">Product Snapshot</CardTitle>
            <CardDescription>
              Placeholder metrics for conversion-oriented hero side panel.
            </CardDescription>
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </Card>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardTitle>Activation</CardTitle>
          <CardDescription className="mt-2">
            Show first-session setup and onboarding milestones.
          </CardDescription>
        </Card>
        <Card>
          <CardTitle>Retention</CardTitle>
          <CardDescription className="mt-2">
            Highlight recurring value and engagement mechanics.
          </CardDescription>
        </Card>
        <Card>
          <CardTitle>Expansion</CardTitle>
          <CardDescription className="mt-2">
            Placeholder upsell/cross-sell messaging areas.
          </CardDescription>
        </Card>
      </section>

      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-semibold tracking-tight">
            Pricing Teaser Layout
          </h2>
          <Badge>Monetization Section</Badge>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          <Card className="space-y-3">
            <CardTitle>Starter</CardTitle>
            <CardDescription>
              For individuals and early validation.
            </CardDescription>
            <p className="text-3xl font-semibold">$0</p>
            <ul className="space-y-1 text-sm text-slate-600 dark:text-slate-300">
              <li>Up to 2 users</li>
              <li>Core workflows</li>
              <li>Email support</li>
            </ul>
            <Button variant="outline" className="w-full">
              Choose Starter
            </Button>
          </Card>
          <Card className="space-y-3 border-slate-400">
            <Badge>Most Popular</Badge>
            <CardTitle>Growth</CardTitle>
            <CardDescription>
              For scaling teams and recurring operations.
            </CardDescription>
            <p className="text-3xl font-semibold">$79</p>
            <ul className="space-y-1 text-sm text-slate-600 dark:text-slate-300">
              <li>Unlimited projects</li>
              <li>Automation rules</li>
              <li>Priority support</li>
            </ul>
            <Button className="w-full">Start 14-day Trial</Button>
          </Card>
          <Card className="space-y-3">
            <CardTitle>Enterprise</CardTitle>
            <CardDescription>
              For governance, controls, and scale.
            </CardDescription>
            <p className="text-3xl font-semibold">Custom</p>
            <ul className="space-y-1 text-sm text-slate-600 dark:text-slate-300">
              <li>SAML/SSO</li>
              <li>Audit & controls</li>
              <li>Dedicated success</li>
            </ul>
            <Button variant="secondary" className="w-full">
              Talk to Sales
            </Button>
          </Card>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.1fr_1fr]">
        <Card className="space-y-4">
          <CardTitle>Integration Grid Placeholder</CardTitle>
          <CardDescription>
            Add logos/connectors for tools customers already use.
          </CardDescription>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </div>
        </Card>

        <Card className="space-y-4">
          <CardTitle>Migration + Onboarding</CardTitle>
          <CardDescription>
            Include implementation options and expected time-to-value.
          </CardDescription>
          <div className="space-y-3 text-sm text-slate-700 dark:text-slate-200">
            <p className="rounded-lg bg-slate-50 p-3 dark:bg-slate-900">
              Self-serve quickstart for small teams.
            </p>
            <p className="rounded-lg bg-slate-50 p-3 dark:bg-slate-900">
              Guided rollout for cross-functional departments.
            </p>
            <p className="rounded-lg bg-slate-50 p-3 dark:bg-slate-900">
              Enterprise migration planning with phased cutover.
            </p>
          </div>
        </Card>
      </section>

      <SiteFooter appName={appName} />
    </div>
  );
}
