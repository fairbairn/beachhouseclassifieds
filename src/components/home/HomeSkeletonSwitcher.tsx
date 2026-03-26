type HomeStarterVariant =
  | "services"
  | "classifieds"
  | "saas"
  | "community"
  | "marketing";

type HomeSkeletonSwitcherProps = {
  value: HomeStarterVariant;
  onChange: (nextValue: HomeStarterVariant) => void;
  onReset: () => void;
};

const variantOptions: Array<{ value: HomeStarterVariant; label: string }> = [
  { value: "services", label: "Services Company" },
  { value: "classifieds", label: "Classifieds Marketplace" },
  { value: "saas", label: "SaaS Product" },
  { value: "community", label: "Community Platform" },
  { value: "marketing", label: "Marketing Website" },
];

export function HomeSkeletonSwitcher({
  value,
  onChange,
  onReset,
}: HomeSkeletonSwitcherProps) {
  return (
    <aside className="fixed right-4 bottom-4 z-50 w-72 rounded-xl border border-slate-300 bg-white/95 p-3 shadow-lg backdrop-blur dark:border-slate-700 dark:bg-slate-950/90">
      <p className="text-xs font-semibold tracking-[0.14em] text-slate-500 uppercase dark:text-slate-400">
        Home Layout Preview
      </p>
      <label
        className="mt-2 block text-xs text-slate-600 dark:text-slate-300"
        htmlFor="home-skeleton-selector"
      >
        Starter variant
      </label>
      <select
        id="home-skeleton-selector"
        className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
        value={value}
        onChange={(event) => onChange(event.target.value as HomeStarterVariant)}
      >
        {variantOptions.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
        Dev helper. Remove or disable once a final home design is chosen.
      </p>
      <button
        type="button"
        className="mt-3 inline-flex h-8 items-center rounded-md border border-slate-300 px-3 text-xs font-medium text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
        onClick={onReset}
      >
        Reset To Default
      </button>
    </aside>
  );
}
