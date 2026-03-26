import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { APP_CONTAINER_CLASS } from "@/core/ui/layout";

type AppHeaderProps = {
  appName: string;
  userName: string | null | undefined;
};

const starterNavItems = ["Overview", "Features", "Pricing", "Docs"] as const;

function initialsFromName(name: string | null | undefined) {
  const trimmed = name?.trim();

  if (!trimmed) {
    return "U";
  }

  const parts = trimmed.split(/\s+/).filter(Boolean);
  const initials = parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "");
  return initials.join("") || "U";
}

function MoonIcon() {
  return (
    <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M21 12.79A9 9 0 1 1 11.21 3c-.02.26-.03.52-.03.79A8 8 0 0 0 19.21 11.8c.27 0 .53-.01.79-.03Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg className="icon-svg" viewBox="0 0 24 24" aria-hidden="true">
      <circle
        cx="12"
        cy="12"
        r="4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function AppHeader({ appName, userName }: AppHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }

    const root = document.documentElement;
    const storedTheme = localStorage.getItem("theme");

    return storedTheme === "dark"
      ? true
      : storedTheme === "light"
        ? false
        : root.classList.contains("dark") ||
          window.matchMedia("(prefers-color-scheme: dark)").matches;
  });
  const menuRef = useRef<HTMLDivElement | null>(null);
  const displayName = userName?.trim() || "User";

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const root = document.documentElement;
    root.classList.toggle("dark", isDarkMode);
    root.style.colorScheme = isDarkMode ? "dark" : "light";
    localStorage.setItem("theme", isDarkMode ? "dark" : "light");
  }, [isDarkMode]);

  useEffect(() => {
    const onDocumentClick = (event: MouseEvent) => {
      if (!menuRef.current) {
        return;
      }

      if (!menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };

    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", onDocumentClick);
    document.addEventListener("keydown", onEscape);

    return () => {
      document.removeEventListener("mousedown", onDocumentClick);
      document.removeEventListener("keydown", onEscape);
    };
  }, []);

  const toggleTheme = () => {
    setIsDarkMode((previous) => !previous);
  };

  return (
    <header className="app-header">
      <div className={`${APP_CONTAINER_CLASS} app-header-inner`}>
        <div className="app-header-title">
          <Link to="/home">{appName}</Link>
        </div>

        <nav className="starter-nav" aria-label="Primary">
          {starterNavItems.map((item) => (
            <a key={item} href="#" className="starter-nav-link">
              {item}
            </a>
          ))}
        </nav>

        <div className="action-row">
          <div className="user-chip">
            <span>Signed in as {displayName}</span>
          </div>

          <button
            type="button"
            className="icon-button"
            aria-label={
              isDarkMode ? "Switch to light mode" : "Switch to dark mode"
            }
            title={isDarkMode ? "Switch to light mode" : "Switch to dark mode"}
            onClick={toggleTheme}
          >
            {isDarkMode ? <SunIcon /> : <MoonIcon />}
          </button>

          <div className="menu-root" ref={menuRef}>
            <button
              type="button"
              className="avatar-button"
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              aria-label="Open user menu"
              onClick={() => setMenuOpen((prev) => !prev)}
            >
              <span className="avatar">{initialsFromName(displayName)}</span>
            </button>

            <div
              className={`menu-popover ${menuOpen ? "is-open" : ""}`}
              role="menu"
            >
              <div className="menu-label">{displayName}</div>
              <Link
                className="menu-item"
                to="/logout"
                onClick={() => setMenuOpen(false)}
              >
                Sign out
              </Link>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
