import { Separator } from "@/components/ui/separator";

type SiteFooterProps = {
  appName: string;
};

const currentYear = new Date().getFullYear();

export function SiteFooter({ appName }: SiteFooterProps) {
  return (
    <footer className="mt-14" role="contentinfo">
      <Separator className="mb-6" />
      <div className="grid gap-6 pb-6 md:grid-cols-[2fr_1fr] md:items-end">
        <div>
          <p className="text-base font-semibold tracking-tight">{appName}</p>
          <p className="mt-2 max-w-xl text-sm text-slate-600 dark:text-slate-300">
            Boilerplate footer copy. Replace this section with trust messaging,
            company details, compliance badges, and support channels.
          </p>
        </div>

        <nav
          className="grid grid-cols-2 gap-2 text-sm md:justify-items-end"
          aria-label="Footer links"
        >
          <a
            className="hover:text-slate-900 dark:hover:text-slate-100"
            href="#"
          >
            Docs
          </a>
          <a
            className="hover:text-slate-900 dark:hover:text-slate-100"
            href="#"
          >
            Pricing
          </a>
          <a
            className="hover:text-slate-900 dark:hover:text-slate-100"
            href="#"
          >
            Privacy
          </a>
          <a
            className="hover:text-slate-900 dark:hover:text-slate-100"
            href="#"
          >
            Terms
          </a>
        </nav>
      </div>
      <p className="pb-2 text-xs text-slate-500 dark:text-slate-400">
        Copyright {currentYear} {appName}. All rights reserved.
      </p>
    </footer>
  );
}
