/** Light and dark themes, and branding (spec UI-6, UI-6a). */

import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";

/** The theme in force: the remembered choice, or the system's. */
export function currentTheme(): Theme {
  const set = document.documentElement.getAttribute("data-theme");
  if (set === "light" || set === "dark") return set;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** Follows the system until the person picks a theme; the pick is remembered. */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(currentTheme);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: light)");
    if (!media?.addEventListener) return;
    const follow = (e: MediaQueryListEvent) => {
      let chosen: string | null = null;
      try {
        chosen = localStorage.getItem("apg-theme");
      } catch {
        // no storage: keep following the system
      }
      if (chosen !== "light" && chosen !== "dark") setTheme(e.matches ? "light" : "dark");
    };
    media.addEventListener("change", follow);
    return () => media.removeEventListener("change", follow);
  }, []);

  const toggle = useCallback(() => {
    setTheme((t) => {
      const next = t === "dark" ? "light" : "dark";
      try {
        localStorage.setItem("apg-theme", next);
      } catch {
        // applies for this visit only
      }
      return next;
    });
  }, []);
  return [theme, toggle];
}

/** Black or white, whichever reads better on `hex`. */
export function inkFor(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? "#0b0d12" : "#ffffff";
}

/** Applies the operator's name and accent colour. The colour is used as given in both themes. */
export function applyBrand(brand: { brand_name: string; primary_color: string | null }): void {
  document.title = brand.brand_name;
  const style = document.documentElement.style;
  if (brand.primary_color && /^#[0-9a-fA-F]{6}$/.test(brand.primary_color)) {
    style.setProperty("--accent", brand.primary_color);
    style.setProperty("--accent-dim", `color-mix(in oklch, ${brand.primary_color} 82%, black)`);
    style.setProperty("--accent-ink", inkFor(brand.primary_color));
  }
}
