/* eslint-disable react-refresh/only-export-components */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { getUser } from "./api";
import { type ValueMode } from "./valueMode";

const VALUE_MODE_STORAGE_KEY = "valueMode";

function readGlobalValueMode(): ValueMode | null {
  const stored = window.localStorage.getItem(VALUE_MODE_STORAGE_KEY);
  if (stored === "normalized" || stored === "original") return stored;
  return null;
}

export type AppUiContextValue = {
  sessionRev: number;
  bumpSession: () => void;
  theme: "dark" | "light";
  setTheme: (t: "dark" | "light") => void;
  valueMode: ValueMode;
  setValueMode: (v: ValueMode) => void;
  headerNotice: { label: string; text: string } | null;
  setHeaderNotice: (notice: { label: string; text: string } | null) => void;
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

  const [valueMode, setValueMode] = useState<ValueMode>(() => readGlobalValueMode() ?? "normalized");
  const [headerNotice, setHeaderNotice] = useState<{ label: string; text: string } | null>(null);

  useEffect(() => {
    const fromGlobal = readGlobalValueMode();
    if (fromGlobal != null) return;
    const eid = getUser()?.enterprise_id;
    if (eid == null || !Number.isFinite(eid)) return;
    const legacy = window.localStorage.getItem(`${VALUE_MODE_STORAGE_KEY}:${eid}`);
    if (legacy === "normalized" || legacy === "original") {
      window.localStorage.setItem(VALUE_MODE_STORAGE_KEY, legacy);
      queueMicrotask(() => setValueMode(legacy));
    }
  }, [sessionRev]);

  useEffect(() => {
    window.localStorage.setItem(VALUE_MODE_STORAGE_KEY, valueMode);
  }, [valueMode]);

  const value = useMemo(
    () => ({
      sessionRev,
      bumpSession,
      theme,
      setTheme,
      valueMode,
      setValueMode,
      headerNotice,
      setHeaderNotice,
    }),
    [sessionRev, bumpSession, theme, valueMode, headerNotice],
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
