import {
  createFileRoute,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { logoutWithProxy } from "@/core/client/auth/auth-proxy";

export const Route = createFileRoute("/logout")({
  component: LogoutPage,
});

function LogoutPage() {
  const navigate = useNavigate();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      const result = await logoutWithProxy();

      if (cancelled) {
        return;
      }

      if (!result.ok && result.message) {
        setError(result.message);
      }

      await router.invalidate({ sync: true });
      router.clearCache();
      await navigate({ to: "/login", replace: true });
    }

    void run();

    return () => {
      cancelled = true;
    };
  }, [navigate, router]);

  return (
    <section className="card">
      <h1>Signing out...</h1>
      {error ? <p className="error-text">{error}</p> : null}
    </section>
  );
}
