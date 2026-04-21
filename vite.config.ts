import netlify from "@netlify/vite-plugin-tanstack-start";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
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
