import { loadPromptLinesFromMarkdown } from "./prompt-markdown-loader";

const DEFAULT_SEO_BRAND_NAME = "30A Collections";

export const LISTING_REFINEMENT_PROMPT_BASE = loadPromptLinesFromMarkdown({
  fileName: "listing-refinement-system.md",
  templateValues: {
    SEO_BRAND_NAME: DEFAULT_SEO_BRAND_NAME,
  },
});

export function buildListingRefinementPrompt(input: {
  rebuildHelpfulHints?: boolean;
  seoBrandName?: string;
}): string {
  const promptBase = loadPromptLinesFromMarkdown({
    fileName: "listing-refinement-system.md",
    templateValues: {
      SEO_BRAND_NAME: input.seoBrandName?.trim() || DEFAULT_SEO_BRAND_NAME,
    },
  });

  return promptBase.join(" ");
}

export const LISTING_REFINEMENT_AUDIT_PROMPT_BASE = loadPromptLinesFromMarkdown(
  {
    fileName: "listing-refinement-audit.md",
  },
);

export function buildListingRefinementAuditPrompt(): string {
  return LISTING_REFINEMENT_AUDIT_PROMPT_BASE.join(" ");
}
