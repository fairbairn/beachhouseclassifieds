import { SiteFooter } from "@/components/SiteFooter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

type CommunityStarterHomeProps = {
  appName: string;
};

export function CommunityStarterHome({ appName }: CommunityStarterHomeProps) {
  return (
    <div className="space-y-8 pb-4">
      <section className="relative overflow-hidden rounded-2xl border border-slate-200 bg-linear-to-r from-slate-100 to-white p-8 dark:border-slate-800 dark:from-slate-900 dark:to-slate-950">
        <div className="space-y-4">
          <Badge>Community Starter</Badge>
          <h1 className="max-w-3xl text-3xl font-semibold tracking-tight md:text-4xl">
            Bring people together around shared interests in {appName}
          </h1>
          <p className="max-w-2xl text-slate-600 dark:text-slate-300">
            Great for forums, groups, newsletters, and event-driven community
            products.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button>Join Community</Button>
            <Button variant="secondary">Start a Group</Button>
            <Button variant="outline">Upcoming Events</Button>
          </div>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
        <Card className="space-y-4">
          <CardTitle>Trending Discussions</CardTitle>
          <CardDescription>
            Placeholder for top posts, comments, and activity feed.
          </CardDescription>
          <div className="space-y-3">
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
          </div>
        </Card>

        <Card className="space-y-4">
          <CardTitle>Upcoming Events</CardTitle>
          <CardDescription>
            Placeholder for webinars, meetups, or releases.
          </CardDescription>
          <div className="space-y-2">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        </Card>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        <Card className="space-y-2">
          <Badge>Onboarding</Badge>
          <CardTitle className="text-base">New Member Path</CardTitle>
          <CardDescription>
            Welcome sequence, starter guide, and first contribution prompts.
          </CardDescription>
        </Card>
        <Card className="space-y-2">
          <Badge>Engagement</Badge>
          <CardTitle className="text-base">Returning Member Path</CardTitle>
          <CardDescription>
            Personalized digest, saved topics, and event recommendations.
          </CardDescription>
        </Card>
        <Card className="space-y-2">
          <Badge>Leadership</Badge>
          <CardTitle className="text-base">Moderator / Host Path</CardTitle>
          <CardDescription>
            Tools for curation, conflict resolution, and announcement controls.
          </CardDescription>
        </Card>
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
        <Card className="space-y-4">
          <CardTitle>Resource Hub Placeholder</CardTitle>
          <CardDescription>
            Content pattern for guides, templates, and evergreen community
            resources.
          </CardDescription>
          <div className="grid gap-3 md:grid-cols-2">
            <Skeleton className="h-20" />
            <Skeleton className="h-20" />
            <Skeleton className="h-20" />
            <Skeleton className="h-20" />
          </div>
        </Card>

        <Card className="space-y-4">
          <CardTitle>Community Health Metrics</CardTitle>
          <CardDescription>
            Placeholder for sentiment, response time, and retention signals.
          </CardDescription>
          <div className="space-y-3">
            <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-900">
              <p className="text-xs tracking-wide text-slate-500 uppercase">
                Weekly Active Members
              </p>
              <p className="text-xl font-semibold">1,284</p>
            </div>
            <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-900">
              <p className="text-xs tracking-wide text-slate-500 uppercase">
                Avg First Reply
              </p>
              <p className="text-xl font-semibold">28 min</p>
            </div>
            <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-900">
              <p className="text-xs tracking-wide text-slate-500 uppercase">
                Monthly Retention
              </p>
              <p className="text-xl font-semibold">76%</p>
            </div>
          </div>
        </Card>
      </section>

      <SiteFooter appName={appName} />
    </div>
  );
}
