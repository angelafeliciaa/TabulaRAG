import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { type ValueMode } from "./valueMode";

export type AppUiContextValue = {
  sessionRev: number;
  bumpSession: () => void;
  theme: "dark" | "light";
  setTheme: (t: "dark" | "light") => void;
  valueMode: ValueMode;
  setValueMode: (v: ValueMode) => void;
};

const AppUiContext = createContext<AppUiContextValue | null>(null);

export function AppUiProvider({ children }: { children: ReactNode }) {
  const [sessionRev, setSessionRev] = useState(0);
  const bumpSession = useCallback(() => setSessionRev((r) => r + 1), []);

  const [theme, setTheme] = useState<"dark" | "light">(() => {
    const stored = window.localStorage.getItem("theme");
    if (stored === "light" || stored === "dark") return stored;
    return "light";
  });
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    window.localStorage.setItem("theme", theme);
  }, [theme]);

  const [valueMode, setValueMode] = useState<ValueMode>(() => {
    const stored = window.localStorage.getItem("valueMode");
    if (stored === "normalized" || stored === "original") return stored;
    return "normalized";
  });
  useEffect(() => {
    window.localStorage.setItem("valueMode", valueMode);
  }, [valueMode]);

  const value = useMemo(
    () => ({
      sessionRev,
      bumpSession,
      theme,
      setTheme,
      valueMode,
      setValueMode,
    }),
    [sessionRev, bumpSession, theme, valueMode],
  );

  return <AppUiContext.Provider value={value}>{children}</AppUiContext.Provider>;
}

export function useAppUi(): AppUiContextValue {
  const ctx = useContext(AppUiContext);
  if (!ctx) {
    throw new Error("useAppUi must be used within AppUiProvider");
  }
  return ctx;
}
