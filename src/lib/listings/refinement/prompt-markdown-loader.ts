import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const promptCache = new Map<string, string[]>();

function normalizePromptLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) {
    return "";
  }

  if (trimmed.startsWith("#")) {
    return "";
  }

  const withoutListPrefix = trimmed
    .replace(/^[-*]\s+/, "")
    .replace(/^\d+\.\s+/, "");
  return withoutListPrefix.trim();
}

function applyTemplateValues(
  line: string,
  templateValues: Record<string, string>,
): string {
  let output = line;
  for (const [key, value] of Object.entries(templateValues)) {
    output = output.replaceAll(`{{${key}}}`, value);
  }
  return output;
}

export function loadPromptLinesFromMarkdown(input: {
  fileName: string;
  templateValues?: Record<string, string>;
}): string[] {
  const promptUrl = new URL(`./prompts/${input.fileName}`, import.meta.url);
  const promptPath = fileURLToPath(promptUrl);
  const cacheKey = promptPath;

  if (!promptCache.has(cacheKey)) {
    const raw = readFileSync(promptPath, "utf8");
    const normalizedLines = raw
      .split(/\r?\n/)
      .map(normalizePromptLine)
      .filter((line) => line.length > 0);
    promptCache.set(cacheKey, normalizedLines);
  }

  const templateValues = input.templateValues ?? {};
  return (promptCache.get(cacheKey) ?? []).map((line) =>
    applyTemplateValues(line, templateValues),
  );
}

export function loadPromptFromMarkdown(input: {
  fileName: string;
  templateValues?: Record<string, string>;
}): string {
  return loadPromptLinesFromMarkdown(input).join(" ");
}
