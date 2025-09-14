// packages/governance-core/src/ato/index.ts
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_ATO_PROFILES } from "./defaults";
import type { AtoProfiles, AtoProfile, AtoRule } from "./types";

let LOADED: AtoProfiles | null = null;

function readJsonIfExists(p: string): any | undefined {
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch { /* ignore */ }
  return undefined;
}

/**
 * Loads ATO profiles into memory.
 * Priority:
 *  1) ATO_PROFILES_PATH (JSON)
 *  2) ${GOV_POL_DIR}/ato.json (JSON)
 *  3) built-in DEFAULT_ATO_PROFILES
 */
export function ensureAtoLoaded(): void {
  if (LOADED) return;
  const envPath = process.env.ATO_PROFILES_PATH?.trim();
  const dir = process.env.GOV_POL_DIR?.trim();
  const fromEnv = envPath ? readJsonIfExists(envPath) : undefined;
  const fromDir = !fromEnv && dir ? readJsonIfExists(path.join(dir, "ato.json")) : undefined;

  LOADED = (fromEnv || fromDir || DEFAULT_ATO_PROFILES) as AtoProfiles;
}

/** Return true if a profile exists (after ensureAtoLoaded) */
export function hasAtoProfile(name: string): boolean {
  ensureAtoLoaded();
  return !!LOADED![name];
}

/** Get a full profile (defaults to "default") */
export function getAtoProfile(name = "default"): AtoProfile {
  ensureAtoLoaded();
  return LOADED![name] || {};
}

/** Get a single rule by kind (e.g. "webapp") and code (e.g. "APP_TLS_MIN_BELOW_1_2") */
export function getAtoRule(profile = "default", kind: keyof AtoProfile, code: string): AtoRule | undefined {
  ensureAtoLoaded();
  const p = getAtoProfile(profile);
  const set = (p[kind] && p[kind]!.rules) || {};
  return set[code];
}

/** Dump everything (for a tool/UI) */
export function dumpAto(): AtoProfiles {
  ensureAtoLoaded();
  return LOADED!;
}