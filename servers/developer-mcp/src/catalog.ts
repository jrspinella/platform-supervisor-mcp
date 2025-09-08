import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { CatalogEntry, TemplateManifest } from "./types.js";
import { listFilesRecursive, rel } from "./utils.js";
import { callMcp, firstJson } from "./mcp.js";

const GITHUB_MCP_URL = process.env.GITHUB_MCP_URL || "";
const CATALOG_OWNER = process.env.CATALOG_OWNER || "";
const CATALOG_REPO  = process.env.CATALOG_REPO || "";
const CATALOG_REF   = process.env.CATALOG_REF || "main";
const CATALOG_DIR   = (process.env.CATALOG_DIR || "templates").replace(/^\/+|\/+$/g, ""); // trim slashes
const DEV_TEMPLATES_DIR = process.env.DEV_TEMPLATES_DIR || path.resolve(process.cwd(), "templates");

const isText = (p: string) =>
  /\.(hbs|md|ya?ml|json|gitignore|ts|js|tsx|jsx|yml|py|sh|toml|tf|bicep|Dockerfile)$/i.test(p);

// -------- GitHub-backed catalog (via GitHub MCP) --------
async function ghListDir(dir: string) {
  // expect tool "github.list_repo_tree" with args { owner, repo, ref, path, recursive }
  const res = await callMcp(GITHUB_MCP_URL, "github.list_repo_tree", {
    owner: CATALOG_OWNER, repo: CATALOG_REPO, ref: CATALOG_REF, path: dir, recursive: false
  });
  const j = firstJson(res.json);
  return Array.isArray(j?.items) ? j.items as Array<{ path: string; type: "blob"|"tree"; sha: string }> : [];
}

async function ghListDirRecursive(dir: string) {
  const res = await callMcp(GITHUB_MCP_URL, "github.list_repo_tree", {
    owner: CATALOG_OWNER, repo: CATALOG_REPO, ref: CATALOG_REF, path: dir, recursive: true
  });
  const j = firstJson(res.json);
  return Array.isArray(j?.items) ? j.items as Array<{ path: string; type: "blob"|"tree"; sha: string }> : [];
}

async function ghGetFile(pathInRepo: string) {
  // expect tool "github.get_file" with args { owner, repo, path, ref }
  const res = await callMcp(GITHUB_MCP_URL, "github.get_file", {
    owner: CATALOG_OWNER, repo: CATALOG_REPO, path: pathInRepo, ref: CATALOG_REF
  });
  const j = firstJson(res.json);
  // tool returns { path, encoding, content } or raw string; handle both
  return j?.content ?? j ?? "";
}

export async function loadGithubCatalog(): Promise<CatalogEntry[]> {
  if (!GITHUB_MCP_URL || !CATALOG_OWNER || !CATALOG_REPO) return [];
  const base = CATALOG_DIR; // e.g., "templates"
  const top = await ghListDir(base);
  const dirs = top.filter(i => i.type === "tree");
  const out: CatalogEntry[] = [];

  for (const d of dirs) {
    const manifestPath = `${d.path}/manifest.yaml`;
    try {
      const raw = await ghGetFile(manifestPath);
      const manifest = yaml.load(raw) as TemplateManifest;
      if (manifest?.id) out.push({ id: manifest.id, path: d.path, manifest });
    } catch {
      // ignore directories without manifest
    }
  }
  return out;
}

export async function loadGithubTemplateFiles(templatePath: string) {
  const all = await ghListDirRecursive(templatePath);
  const blobs = all.filter(i => i.type === "blob");
  const results: Array<{ path: string; content: string }> = [];
  for (const b of blobs) {
    const rp = b.path.replace(/^\/+/, "");
    if (rp.endsWith("/manifest.yaml") || rp === "manifest.yaml") continue;
    if (!isText(rp)) continue;
    const content = await ghGetFile(rp);
    results.push({ path: rp.substring(templatePath.length + 1), content });
  }
  return results;
}

// -------- Local fallback catalog --------
export function loadLocalCatalog(dir: string): CatalogEntry[] {
  if (!fs.existsSync(dir)) return [];
  const templates = fs.readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => path.join(dir, d.name));
  const out: CatalogEntry[] = [];
  for (const tdir of templates) {
    const manifestPath = path.join(tdir, "manifest.yaml");
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = yaml.load(fs.readFileSync(manifestPath, "utf8")) as TemplateManifest;
    if (!manifest?.id) continue;
    out.push({ id: manifest.id, path: tdir, manifest });
  }
  return out;
}

export function loadLocalTemplateFiles(tdir: string): Array<{ path: string; content: string }> {
  const all = listFilesRecursive(tdir);
  const payload: Array<{ path: string; content: string }> = [];
  for (const f of all) {
    const r = rel(tdir, f);
    if (r === "manifest.yaml") continue;
    if (!isText(f)) continue;
    payload.push({ path: r, content: fs.readFileSync(f, "utf8") });
  }
  return payload;
}

// -------- Public API --------
export async function catalogHybrid(): Promise<CatalogEntry[]> {
  const gh = await loadGithubCatalog();
  if (gh.length) return gh;
  return loadLocalCatalog(DEV_TEMPLATES_DIR);
}

export async function loadTemplateFilesHybrid(entry: CatalogEntry) {
  // Heuristic: if entry.path is absolute, it’s local; otherwise GitHub path under repo.
  const isLocal = path.isAbsolute(entry.path);
  if (isLocal) return loadLocalTemplateFiles(entry.path);
  return loadGithubTemplateFiles(entry.path);
}