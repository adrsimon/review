import { useCallback, useState } from "react";

export type Theme = "light" | "dark";

function current(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/** The theme hangs off a `dark` class on <html>; index.html sets it before paint. */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(current);
  const toggle = useCallback(() => {
    const next: Theme = current() === "dark" ? "light" : "dark";
    document.documentElement.classList.toggle("dark", next === "dark");
    try {
      localStorage.setItem("review:theme", next);
    } catch {
      // Private browsing: the choice just does not persist.
    }
    setTheme(next);
  }, []);
  return [theme, toggle];
}
