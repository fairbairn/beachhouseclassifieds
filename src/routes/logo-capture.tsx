import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/logo-capture")({
  head: () => ({
    links: [
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      {
        rel: "preconnect",
        href: "https://fonts.gstatic.com",
        crossOrigin: "anonymous",
      },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&display=swap",
      },
    ],
  }),
  component: LogoCapturePage,
});

function LogoCapturePage() {
  return (
    <div className="flex min-h-screen w-full flex-col items-center justify-center bg-white px-6 py-10">
      <div className="mb-5 text-center text-sm tracking-wide text-slate-500">
        Capture only inside the solid border.
      </div>

      <div className="relative h-180 w-180 border-2 border-slate-900 bg-white shadow-[0_24px_80px_-38px_rgba(15,23,42,0.28)]">
        <span
          className="pointer-events-none absolute top-1/2 left-1/2 block -translate-x-1/2 -translate-y-1/2 text-[320px] leading-none tracking-[0.01em] text-[#1f242b] select-none"
          style={{ fontFamily: "'Playfair Display', serif" }}
        >
          30<span className="text-[#2dd4bf]">A</span>
        </span>
      </div>
    </div>
  );
}
