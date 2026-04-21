import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";
import "./table-copy.css";

function tableToMarkdown(table: HTMLTableElement): string {
  const rowEls = Array.from(table.querySelectorAll("tr"));
  const rows = rowEls.map((tr) =>
    Array.from(tr.querySelectorAll("th,td")).map((cell) =>
      (cell.textContent || "")
        .replace(/\s+/g, " ")
        .replace(/\|/g, "\\|")
        .trim(),
    ),
  );

  if (rows.length === 0) {
    return "";
  }

  const colCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const normalized = rows.map((row) => {
    const next = row.slice();
    while (next.length < colCount) {
      next.push("");
    }
    return next;
  });

  const header = normalized[0];
  const body = normalized.slice(1);

  const colWidths = new Array(colCount).fill(3);
  for (const row of normalized) {
    for (let i = 0; i < colCount; i += 1) {
      colWidths[i] = Math.max(colWidths[i], row[i].length);
    }
  }

  const headerCells = Array.from(rowEls[0]?.querySelectorAll("th,td") || []);
  const alignments = new Array(colCount).fill("left").map((_, i) => {
    const cell = headerCells[i] as HTMLElement | undefined;
    const alignAttr = cell?.getAttribute("align") || "";
    const textAlign = (cell?.style?.textAlign || "").toLowerCase();
    const computed = cell ? window.getComputedStyle(cell).textAlign : "";
    const raw = (alignAttr || textAlign || computed || "").toLowerCase();
    if (raw.includes("right") || raw === "end") return "right";
    if (raw.includes("center")) return "center";
    return "left";
  });

  const formatCell = (value: string, width: number, align: string): string => {
    if (align === "right") {
      return value.padStart(width, " ");
    }
    if (align === "center") {
      const totalPad = Math.max(0, width - value.length);
      const left = Math.floor(totalPad / 2);
      const right = totalPad - left;
      return `${" ".repeat(left)}${value}${" ".repeat(right)}`;
    }
    return value.padEnd(width, " ");
  };

  const divider = colWidths.map((width, idx) => {
    const dashes = "-".repeat(Math.max(3, width));
    if (alignments[idx] === "right") return `${"-"}${dashes}:`;
    if (alignments[idx] === "center") return `:${dashes}:`;
    return `:${dashes}-`;
  });

  const out: string[] = [];
  out.push(
    `| ${header
      .map((cell, i) => formatCell(cell, colWidths[i], alignments[i]))
      .join(" | ")} |`,
  );
  out.push(`| ${divider.join(" | ")} |`);
  for (const row of body) {
    out.push(
      `| ${row
        .map((cell, i) => formatCell(cell, colWidths[i], alignments[i]))
        .join(" | ")} |`,
    );
  }

  return out.join("\n");
}

async function copyText(text: string): Promise<void> {
  if (!text) return;

  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  document.execCommand("copy");
  document.body.removeChild(ta);
}

function addCopyButton(table: HTMLTableElement, key: string): void {
  if (!table.parentElement) return;

  let wrap = table.parentElement;
  if (!wrap.classList.contains("doc-table-copy-wrap")) {
    const outer = document.createElement("div");
    outer.className = "doc-table-copy-wrap";
    wrap.insertBefore(outer, table);
    outer.appendChild(table);
    wrap = outer;
  }

  let toolbar = wrap.querySelector(":scope > .doc-table-copy-toolbar");
  if (!toolbar) {
    toolbar = document.createElement("div");
    toolbar.className = "doc-table-copy-toolbar";
    wrap.insertBefore(toolbar, table);
  }

  if (wrap.querySelector(`button[data-copy-key=\"${key}\"]`)) {
    return;
  }

  const button = document.createElement("button");
  button.type = "button";
  button.className = "doc-table-copy-btn";
  button.dataset.copyKey = key;
  button.title = "Copy table as Markdown";
  button.setAttribute("aria-label", "Copy table as Markdown");
  button.innerHTML =
    '<span class="doc-table-copy-btn-icon" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 2H3.75C3.336 2 3 2.336 3 2.75V11.25C3 11.664 3.336 12 3.75 12H10.25C10.664 12 11 11.664 11 11.25V9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M8.75 4H12.25C12.664 4 13 4.336 13 4.75V13.25C13 13.664 12.664 14 12.25 14H5.75C5.336 14 5 13.664 5 13.25V9.75" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span class="doc-table-copy-btn-label">Copy</span>';

  const labelEl = button.querySelector(
    ".doc-table-copy-btn-label",
  ) as HTMLSpanElement | null;

  const setLabel = (value: string): void => {
    if (labelEl) {
      labelEl.textContent = value;
      return;
    }
    button.textContent = value;
  };

  button.addEventListener("click", async () => {
    try {
      await copyText(tableToMarkdown(table));
      setLabel("Copied");
      window.setTimeout(() => {
        setLabel("Copy");
      }, 1200);
    } catch {
      setLabel("Error");
      window.setTimeout(() => {
        setLabel("Copy");
      }, 1200);
    }
  });

  toolbar.appendChild(button);
}

function installTableCopyButtons(): boolean {
  const pagePath = window.location.pathname;
  if (!pagePath.includes("/adapter-conformance-status")) {
    return false;
  }

  const doc = document.querySelector(".vp-doc");
  if (!doc) return false;

  const headings = Array.from(doc.querySelectorAll("h2"));

  const byTitle = (title: string): HTMLHeadingElement | undefined =>
    headings.find((h) => (h.textContent || "").trim().startsWith(title));

  const findNextTable = (
    heading?: HTMLHeadingElement,
  ): HTMLTableElement | null => {
    if (!heading) return null;

    let el: Element | null = heading.nextElementSibling;
    while (el) {
      if (el.tagName.toLowerCase() === "table") {
        return el as HTMLTableElement;
      }
      const nested = el.querySelector("table");
      if (nested) {
        return nested as HTMLTableElement;
      }
      el = el.nextElementSibling;
    }

    return null;
  };

  const conformanceTable = findNextTable(byTitle("Conformance Matrix"));
  const runtimeTable = findNextTable(byTitle("Quote Runtime Migration Ledger"));

  if (conformanceTable) addCopyButton(conformanceTable, "conformance");
  if (runtimeTable) addCopyButton(runtimeTable, "runtime");

  return Boolean(conformanceTable || runtimeTable);
}

function installTableCopyButtonsWithRetries(maxAttempts = 8): void {
  let attempt = 0;

  const run = () => {
    const found = installTableCopyButtons();
    if (found || attempt >= maxAttempts) {
      return;
    }
    attempt += 1;
    window.setTimeout(run, 120);
  };

  run();
}

const theme: Theme = {
  ...DefaultTheme,
  enhanceApp({ router }) {
    if (typeof window === "undefined") return;

    const run = () =>
      window.requestAnimationFrame(() => {
        window.setTimeout(() => {
          installTableCopyButtonsWithRetries();
        }, 0);
      });

    run();
    router.onAfterRouteChanged = () => {
      run();
    };
  },
};

export default theme;
