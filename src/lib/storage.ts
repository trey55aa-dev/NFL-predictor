/**
 * The site's database: browser localStorage under `nflp.*` keys, with JSON
 * export/import so the whole history (weights, per-game reads, graded picks)
 * can be backed up or moved between devices. No account, no server.
 */

import { useEffect, useState } from "react";
import { NFL_INPUTS_KEY, NFL_WEIGHTS_KEY } from "./predictor";

export function useLocalStorage<T>(key: string, initialValue: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initialValue;
    } catch {
      return initialValue;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage full/blocked — keep running in-memory */
    }
  }, [key, value]);

  return [value, setValue] as const;
}

const DB_KEYS = [NFL_WEIGHTS_KEY, NFL_INPUTS_KEY];

/** Serialize the whole database to a downloadable JSON blob. */
export function exportDatabase(): string {
  const out: Record<string, unknown> = { exportedAt: new Date().toISOString() };
  for (const key of DB_KEYS) {
    try {
      const raw = localStorage.getItem(key);
      if (raw) out[key] = JSON.parse(raw);
    } catch {
      /* skip unreadable keys */
    }
  }
  return JSON.stringify(out, null, 2);
}

/**
 * Restore a previously exported database. Returns the number of keys
 * imported, or throws if the file isn't a recognizable export.
 */
export function importDatabase(json: string): number {
  const data = JSON.parse(json) as Record<string, unknown>;
  const keys = DB_KEYS.filter((k) => k in data);
  if (keys.length === 0) throw new Error("Not an NFL Predictor export file");
  for (const key of keys) localStorage.setItem(key, JSON.stringify(data[key]));
  return keys.length;
}

export function downloadDatabase() {
  const blob = new Blob([exportDatabase()], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `nfl-predictor-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
