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

  if (wrap.querySelector(`button[data-copy-key=\"${key}\"]`)) {
    return;
  }

  const button = document.createElement("button");
  button.type = "button";
  button.className = "doc-table-copy-btn";
  button.dataset.copyKey = key;
  button.title = "Copy table";
  button.setAttribute("aria-label", "Copy table");
  button.textContent = "📋";

  button.addEventListener("click", async () => {
    try {
      await copyText(tableToMarkdown(table));
      const prev = button.textContent;
      button.textContent = "✓";
      window.setTimeout(() => {
        button.textContent = prev || "📋";
      }, 1200);
    } catch {
      button.textContent = "!";
      window.setTimeout(() => {
        button.textContent = "📋";
      }, 1200);
    }
  });

  wrap.appendChild(button);
}

function installTableCopyButtons(): void {
  const pagePath = window.location.pathname;
  if (!pagePath.includes("/adapter-conformance-status")) {
    return;
  }

  const doc = document.querySelector(".vp-doc");
  if (!doc) return;

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
}

const theme: Theme = {
  ...DefaultTheme,
  enhanceApp({ router }) {
    if (typeof window === "undefined") return;

    const run = () => window.setTimeout(installTableCopyButtons, 0);

    run();
    router.onAfterRouteChanged = () => {
      run();
    };
  },
};

export default theme;
