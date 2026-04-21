import netlify from "@netlify/vite-plugin-tanstack-start";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { isAbsolute } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { visualizer } from "rollup-plugin-visualizer";
import { defineConfig } from "vite";
import viteTsConfigPaths from "vite-tsconfig-paths";

const ignoredWarningPathParts = [
  "node_modules/@tanstack/start-server-core/",
  "node_modules/@tanstack/start-client-core/",
  "node_modules/better-auth/",
];

const isIgnoredUnusedExternalImportWarning = (warning: {
  code?: string;
  id?: string;
  message?: string;
}) => {
  if (warning.code !== "UNUSED_EXTERNAL_IMPORT") {
    return false;
  }

  const fromKnownDependency =
    typeof warning.id === "string" &&
    ignoredWarningPathParts.some((pathPart) => warning.id?.includes(pathPart));

  if (fromKnownDependency) {
    return true;
  }

  return (
    typeof warning.message === "string" &&
    ignoredWarningPathParts.some((pathPart) =>
      warning.message?.includes(pathPart),
    )
  );
};

const toPosixPath = (value: string): string => value.replace(/\\/g, "/");

const containsForbiddenClientDomainSegment = (value: string): boolean => {
  const normalized = toPosixPath(value);
  return (
    normalized.includes("/server/") ||
    normalized.includes("/cli/") ||
    normalized.includes("/src/lib/scripts/") ||
    normalized.includes("/src/core/server/") ||
    normalized.includes("/src/lib/listings/refinement/") ||
    normalized.includes("/src/lib/listings/enrichment/") ||
    normalized.includes(".server.") ||
    normalized.endsWith(".server") ||
    normalized.includes(".cli.") ||
    normalized.endsWith(".cli")
  );
};

const containsForbiddenSsrDomainSegment = (value: string): boolean => {
  const normalized = toPosixPath(value);
  return (
    normalized.includes("/cli/") ||
    normalized.includes("/src/lib/scripts/") ||
    normalized.includes("/src/lib/listings/refinement/") ||
    normalized.includes("/src/lib/listings/enrichment/") ||
    normalized.includes(".cli.") ||
    normalized.endsWith(".cli")
  );
};

const isForbiddenAliasImport = (source: string): boolean => {
  return source.startsWith("@server") || source.startsWith("@cli");
};

function forbidNonWebImports() {
  return {
    name: "forbid-non-web-imports",
    enforce: "pre" as const,
    async resolveId(
      source: string,
      importer: string | undefined,
      options: { ssr?: boolean } | undefined,
    ) {
      const isClientBuild = options?.ssr !== true;
      const isSsrBuild = options?.ssr === true;

      const violatesAliasRule = isForbiddenAliasImport(source);
      const violatesDomainRule = isClientBuild
        ? containsForbiddenClientDomainSegment(source)
        : isSsrBuild
          ? containsForbiddenSsrDomainSegment(source)
          : false;

      if (violatesAliasRule || violatesDomainRule) {
        throw new Error(
          [
            isClientBuild
              ? "BUILD FAILED: Forbidden module imported into client bundle."
              : "BUILD FAILED: Forbidden module imported into SSR server bundle.",
            `Importer: ${importer ?? "<entry>"}`,
            `Source: ${source}`,
            isClientBuild
              ? "Client bundles must not include CLI/server/internal-processing modules."
              : "SSR bundles must not include CLI/data-enrichment/internal-processing modules.",
          ].join("\n"),
        );
      }

      if (!importer) {
        return null;
      }

      const resolved = await this.resolve(source, importer, {
        ...options,
        skipSelf: true,
      });

      const resolvedId = resolved?.id;
      if (!resolvedId || resolvedId.startsWith("\0")) {
        return null;
      }

      const normalizedResolvedId = toPosixPath(resolvedId);
      if (!isAbsolute(normalizedResolvedId)) {
        return null;
      }

      const violatesResolvedDomainRule = isClientBuild
        ? containsForbiddenClientDomainSegment(normalizedResolvedId)
        : isSsrBuild
          ? containsForbiddenSsrDomainSegment(normalizedResolvedId)
          : false;

      if (violatesResolvedDomainRule) {
        throw new Error(
          [
            isClientBuild
              ? "BUILD FAILED: Forbidden module resolved into client bundle."
              : "BUILD FAILED: Forbidden module resolved into SSR server bundle.",
            `Importer: ${importer}`,
            `Source: ${source}`,
            `Resolved: ${normalizedResolvedId}`,
            isClientBuild
              ? "Client bundles must not include CLI/server/internal-processing modules."
              : "SSR bundles must not include CLI/data-enrichment/internal-processing modules.",
          ].join("\n"),
        );
      }

      return null;
    },
  };
}

const config = defineConfig(({ mode }) => {
  const isAnalyzeBuild = mode === "analyze";
  const enableTanStackDevtools =
    process.env.VITE_TANSTACK_DEVTOOLS?.trim() === "1";

  return {
    envPrefix: ["VITE_", "GOOGLE_MAPS_API_KEY", "GOOGLE_MAPS_JS_KEY"],
    server: {
      watch: {
        ignored: ["**/src/lib/data/external-sources/**"],
      },
    },
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    build: {
      rollupOptions: {
        plugins: isAnalyzeBuild
          ? [
              visualizer({
                filename: "dist/stats.html",
                open: true,
                gzipSize: true,
                brotliSize: true,
              }),
            ]
          : [],
        onLog(level, log, handler) {
          if (
            level === "warn" &&
            isIgnoredUnusedExternalImportWarning({
              code: log.code,
              id: "id" in log ? log.id : undefined,
              message: log.message,
            })
          ) {
            return;
          }

          handler(level, log);
        },
        onwarn(warning, warn) {
          if (isIgnoredUnusedExternalImportWarning(warning)) {
            return;
          }

          warn(warning);
        },
      },
    },
    plugins: [
      forbidNonWebImports(),
      ...(enableTanStackDevtools ? [devtools()] : []),
      netlify(),
      // this is the plugin that enables path aliases
      viteTsConfigPaths({
        projects: ["./tsconfig.json"],
      }),
      tailwindcss(),
      tanstackStart(),
      viteReact({
        babel: {
          plugins: ["babel-plugin-react-compiler"],
        },
      }),
    ],
  };
});

export default config;
