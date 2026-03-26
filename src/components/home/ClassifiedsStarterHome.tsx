import { SiteFooter } from "@/components/SiteFooter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";

type ClassifiedsStarterHomeProps = {
  appName: string;
};

const topCategories = [
  "Vehicles",
  "Housing",
  "Jobs",
  "Electronics",
  "Services",
  "Community",
] as const;

const quickFacetFilters = [
  "Has photo",
  "Price reduced",
  "Posted today",
  "Nearby only",
  "Verified seller",
] as const;

const facetGroups = [
  {
    title: "Price",
    options: ["Under $250", "$250-$1k", "$1k-$5k", "$5k+"] as const,
  },
  {
    title: "Condition",
    options: ["New", "Like new", "Used", "For parts"] as const,
  },
  {
    title: "Seller",
    options: ["Owner", "Dealer", "Business"] as const,
  },
] as const;

const recentAds = [
  {
    title: "2018 Hybrid SUV - clean title",
    price: "$18,400",
    location: "North District",
    badge: "Vehicles",
  },
  {
    title: "Modern 2BR loft near downtown",
    price: "$2,150/mo",
    location: "Riverfront",
    badge: "Housing",
  },
  {
    title: "Freelance product photographer",
    price: "$90/hr",
    location: "Remote",
    badge: "Services",
  },
  {
    title: "Gaming laptop RTX series",
    price: "$1,050",
    location: "Westside",
    badge: "Electronics",
  },
  {
    title: "Local delivery driver - evenings",
    price: "$22/hr",
    location: "Central",
    badge: "Jobs",
  },
  {
    title: "Vintage road bike, tuned",
    price: "$460",
    location: "Old Town",
    badge: "Community",
  },
  {
    title: "Standing desk (walnut)",
    price: "$310",
    location: "South Hills",
    badge: "Electronics",
  },
  {
    title: "Pet-friendly studio apartment",
    price: "$1,420/mo",
    location: "East Park",
    badge: "Housing",
  },
] as const;

export function ClassifiedsStarterHome({
  appName,
}: ClassifiedsStarterHomeProps) {
  return (
    <div className="space-y-8 pb-4">
      <section className="relative overflow-hidden rounded-2xl border border-slate-200 bg-linear-to-r from-slate-900 via-slate-800 to-slate-700 px-6 py-10 text-white shadow-md md:px-10 dark:border-slate-700">
        <div className="absolute -top-14 -right-14 h-52 w-52 rounded-full bg-white/10 blur-3xl" />
        <div className="relative space-y-5">
          <Badge className="border-white/30 bg-white/15 text-white">
            Classifieds Starter
          </Badge>
          <div className="max-w-3xl space-y-3">
            <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">
              Buy, sell, and discover great local finds with {appName}
            </h1>
            <p className="text-sm text-slate-100 md:text-base">
              This starter home is designed for classifieds marketplaces. Start
              with search-first UX, category browsing, featured listings, and
              trust messaging.
            </p>
          </div>

          <div className="grid gap-3 rounded-xl bg-white/10 p-3 backdrop-blur md:grid-cols-[2fr_1fr_1fr_auto]">
            <input
              type="text"
              placeholder="What are you looking for?"
              aria-label="Listing keyword"
            />
            <input
              type="text"
              placeholder="City or ZIP"
              aria-label="Location"
            />
            <input type="text" placeholder="Category" aria-label="Category" />
            <Button className="h-10.5">Search</Button>
          </div>

          <div className="flex flex-wrap gap-3">
            <Button variant="secondary">Post an Ad</Button>
            <Button variant="outline">Browse Listings</Button>
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold tracking-tight">
            Top Categories
          </h2>
          <a className="text-sm text-slate-600 dark:text-slate-300" href="#">
            View all
          </a>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          {topCategories.map((category) => (
            <Card key={category} className="p-4">
              <CardTitle className="text-base">{category}</CardTitle>
              <CardDescription className="mt-1">
                Placeholder volume and recent activity.
              </CardDescription>
            </Card>
          ))}
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-[280px_1fr]">
        <Card className="space-y-5 lg:sticky lg:top-4 lg:self-start">
          <div>
            <CardTitle>Browse & Filter</CardTitle>
            <CardDescription className="mt-1">
              Category navigation and faceting controls for discovery-heavy
              marketplaces.
            </CardDescription>
          </div>
          <div className="space-y-3">
            <p className="text-xs tracking-[0.12em] text-slate-500 uppercase">
              Categories
            </p>
            <div className="space-y-2">
              {topCategories.map((category) => (
                <button
                  key={category}
                  type="button"
                  className="flex w-full items-center justify-between rounded-md border border-slate-200 px-3 py-2 text-left text-sm hover:bg-slate-100 dark:border-slate-800 dark:hover:bg-slate-900"
                >
                  <span>{category}</span>
                  <span className="text-xs text-slate-500">128</span>
                </button>
              ))}
            </div>
          </div>

          <Separator />

          <div className="space-y-2">
            <p className="text-xs tracking-[0.12em] text-slate-500 uppercase">
              Quick facets
            </p>
            <div className="flex flex-wrap gap-2">
              {quickFacetFilters.map((facet) => (
                <Badge key={facet}>{facet}</Badge>
              ))}
            </div>
          </div>

          <Separator />

          <div className="space-y-4">
            {facetGroups.map((group) => (
              <div key={group.title} className="space-y-2">
                <p className="text-xs tracking-[0.12em] text-slate-500 uppercase">
                  {group.title}
                </p>
                <div className="space-y-1.5">
                  {group.options.map((option) => (
                    <label
                      key={option}
                      className="flex w-full min-w-0 items-start gap-2 text-sm text-slate-700 dark:text-slate-200"
                    >
                      <input
                        type="checkbox"
                        aria-label={option}
                        className="mt-0.5 h-4 w-4 shrink-0 grow-0 p-0"
                        style={{
                          marginTop: "0.125rem",
                          width: "1rem",
                          padding: 0,
                        }}
                      />
                      <span className="min-w-0 leading-snug wrap-break-word">
                        {option}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Card>

        <div className="space-y-4">
          <Card className="space-y-4">
            <div className="flex items-center justify-between">
              <CardTitle>Recent Ads</CardTitle>
              <Badge>Live Feed Slot</Badge>
            </div>
            <CardDescription>
              Multi-row ad panels with strong scanability. Keep at least two
              lines of cards visible.
            </CardDescription>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {recentAds.map((listing) => (
                <article
                  key={`${listing.title}-${listing.location}`}
                  className="rounded-lg border border-slate-200 p-3 dark:border-slate-800"
                >
                  <Skeleton className="mb-3 h-28 w-full" />
                  <div className="flex items-center justify-between gap-2">
                    <Badge>{listing.badge}</Badge>
                    <p className="text-sm font-semibold">{listing.price}</p>
                  </div>
                  <p className="mt-2 line-clamp-2 text-sm font-medium">
                    {listing.title}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    {listing.location}
                  </p>
                </article>
              ))}
            </div>
          </Card>

          <Card className="space-y-4">
            <CardTitle>Safety & Trust</CardTitle>
            <CardDescription>
              Use this area for moderation policy, verified profiles, scam
              prevention, and reporting.
            </CardDescription>
            <Separator />
            <ul className="space-y-3 text-sm text-slate-700 dark:text-slate-200">
              <li>
                Verified user identities and flagged-account review queue.
              </li>
              <li>
                In-app messaging with suspicious-link detection placeholder.
              </li>
              <li>
                Meetup safety checklist and dispute-resolution entry points.
              </li>
            </ul>
          </Card>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        <Card className="space-y-3 lg:col-span-2">
          <div className="flex items-center justify-between">
            <CardTitle>How It Works (Buyer Journey)</CardTitle>
            <Badge>Flow Pattern</Badge>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
              <p className="text-xs tracking-wide text-slate-500 uppercase">
                Step 1
              </p>
              <p className="mt-1 font-medium">Search + Filter</p>
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                Find nearby items by category, price, and distance.
              </p>
            </div>
            <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
              <p className="text-xs tracking-wide text-slate-500 uppercase">
                Step 2
              </p>
              <p className="mt-1 font-medium">Contact Seller</p>
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                Use secure messaging to ask questions and negotiate.
              </p>
            </div>
            <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
              <p className="text-xs tracking-wide text-slate-500 uppercase">
                Step 3
              </p>
              <p className="mt-1 font-medium">Close Safely</p>
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                Coordinate meetup or shipping with built-in safety guidance.
              </p>
            </div>
          </div>
        </Card>

        <Card className="space-y-3">
          <CardTitle>Seller Tools Preview</CardTitle>
          <CardDescription>
            Show listing insights, bump credits, and response-rate nudges.
          </CardDescription>
          <Skeleton className="h-24" />
          <Skeleton className="h-6 w-3/4" />
          <Skeleton className="h-6 w-2/3" />
        </Card>
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card className="space-y-2">
          <CardTitle className="text-base">Trust Center</CardTitle>
          <CardDescription>
            Policy links, suspicious behavior reporting, and moderation docs.
          </CardDescription>
        </Card>
        <Card className="space-y-2">
          <CardTitle className="text-base">Neighborhood Activity</CardTitle>
          <CardDescription>
            Recent listings and sold trends by district or postal code.
          </CardDescription>
        </Card>
        <Card className="space-y-2">
          <CardTitle className="text-base">Deal Alerts</CardTitle>
          <CardDescription>
            Email or push subscription blocks for saved searches.
          </CardDescription>
        </Card>
        <Card className="space-y-2">
          <CardTitle className="text-base">Mobile App CTA</CardTitle>
          <CardDescription>
            QR/download area for high-frequency marketplace users.
          </CardDescription>
        </Card>
      </section>

      <SiteFooter appName={appName} />
    </div>
  );
}
