import * as React from "react";

type Theme = "dark" | "light" | "system";
type ResolvedTheme = Exclude<Theme, "system">;

type ThemeProviderState = {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
};

const storageKey = "paire-ui-theme";

const ThemeProviderContext = React.createContext<ThemeProviderState>({
  theme: "system",
  resolvedTheme: "light",
  setTheme: () => null,
});

function isTheme(value: string | null): value is Theme {
  return value === "dark" || value === "light" || value === "system";
}

function resolveTheme(theme: Theme): ResolvedTheme {
  if (theme !== "system") return theme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function applyTheme(theme: Theme) {
  const root = window.document.documentElement;
  const resolvedTheme = resolveTheme(theme);

  root.classList.remove("light", "dark");
  root.classList.add(resolvedTheme);
  root.style.colorScheme = resolvedTheme;
}

function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = React.useState<Theme>(() => {
    if (typeof window === "undefined") return "system";
    const storedTheme = window.localStorage.getItem(storageKey);
    return isTheme(storedTheme) ? storedTheme : "system";
  });
  const [resolvedTheme, setResolvedTheme] = React.useState<ResolvedTheme>(() => {
    if (typeof window === "undefined") return "light";
    return resolveTheme(theme);
  });

  React.useEffect(() => {
    applyTheme(theme);
    setResolvedTheme(resolveTheme(theme));
  }, [theme]);

  React.useEffect(() => {
    if (theme !== "system") return;

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => {
      applyTheme("system");
      setResolvedTheme(resolveTheme("system"));
    };
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, [theme]);

  const value = React.useMemo<ThemeProviderState>(
    () => ({
      theme,
      resolvedTheme,
      setTheme: (nextTheme) => {
        window.localStorage.setItem(storageKey, nextTheme);
        setThemeState(nextTheme);
      },
    }),
    [resolvedTheme, theme],
  );

  return (
    <ThemeProviderContext.Provider value={value}>
      {children}
    </ThemeProviderContext.Provider>
  );
}

function useTheme() {
  const context = React.useContext(ThemeProviderContext);
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return context;
}

export { ThemeProvider, useTheme, storageKey };
export type { ResolvedTheme, Theme };
