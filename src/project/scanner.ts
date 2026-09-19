import fsp from "node:fs/promises";
import path from "node:path";
import { DEFAULT_IGNORE } from "../tools/util.js";

export interface ScanOptions {
  cwd: string;
  ignore?: string[];
  maxTopLevelEntries?: number;
  maxExcerptLines?: number;
}

export interface ProjectContext {
  name: string;
  languages: string[];
  manifests: string[];
  docs: string[];
  topLevelEntries: string[];
  fileCount: number;
  agentsExcerpt?: string;
}

const EXT_LANGUAGE: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  mts: "TypeScript",
  cts: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  py: "Python",
  go: "Go",
  rs: "Rust",
  java: "Java",
  rb: "Ruby",
  php: "PHP",
  c: "C",
  h: "C",
  cc: "C++",
  cpp: "C++",
  cxx: "C++",
  cs: "C#",
  hs: "Haskell",
  ex: "Elixir",
  exs: "Elixir",
  swift: "Swift",
  kt: "Kotlin",
  kts: "Kotlin",
  scala: "Scala",
  sh: "Shell",
  zsh: "Shell",
  bash: "Shell",
  lua: "Lua",
  dart: "Dart",
  zig: "Zig",
  vue: "Vue",
  svelte: "Svelte",
  html: "HTML",
  css: "CSS",
  sql: "SQL",
  md: "Markdown",
  json: "JSON",
  yml: "YAML",
  yaml: "YAML",
  toml: "TOML",
};

const MANIFEST_NAMES = new Set([
  "package.json",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "tsconfig.json",
  "Cargo.toml",
  "pyproject.toml",
  "requirements.txt",
  "Pipfile",
  "go.mod",
  "Gopkg.toml",
  "pom.xml",
  "build.gradle",
  "settings.gradle",
  "Gemfile",
  "mix.exs",
  "composer.json",
  "pubspec.yaml",
  "build.zig",
  "CMakeLists.txt",
  "Makefile",
  "Justfile",
  "deno.json",
  "deno.jsonc",
  "vite.config.ts",
  "webpack.config.js",
  "rollup.config.js",
]);

const DOC_NAMES = /^(README.*|AGENTS\.md|LICENSE.*|CONTRIBUTING.*|CHANGELOG.*)$/i;

async function listTopLevel(dir: string, ignore: string[]): Promise<string[]> {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const names = entries
    .filter((e) => !ignore.includes(e.name))
    .filter((e) => !e.isSymbolicLink())
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort((a, b) => {
      const aDir = a.endsWith("/");
      const bDir = b.endsWith("/");
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a.localeCompare(b);
    });
  return names;
}

interface WalkCounts {
  languages: Record<string, number>;
  fileCount: number;
}

async function walkProject(dir: string, ignore: string[]): Promise<WalkCounts> {
  const languages: Record<string, number> = {};
  let fileCount = 0;
  let visited = 0;
  const stack: string[] = [""];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    const abs = path.join(dir, rel);
    let entries;
    try {
      entries = await fsp.readdir(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (visited++ > 50_000) return { languages, fileCount };
      if (e.isSymbolicLink()) continue;
      if (ignore.includes(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        stack.push(childRel);
      } else {
        fileCount++;
        const ext = e.name.includes(".")
          ? e.name.slice(e.name.lastIndexOf(".") + 1).toLowerCase()
          : "";
        const lang = EXT_LANGUAGE[ext];
        if (lang) languages[lang] = (languages[lang] ?? 0) + 1;
      }
    }
  }
  return { languages, fileCount };
}

export function extractAgentsExcerpt(text: string, maxLines: number): string {
  const lines = text.split("\n");
  const trimmed = lines.slice(0, maxLines);
  const excerpt = trimmed.join("\n").trim();
  if (lines.length <= maxLines) return excerpt;
  return `${excerpt}\n...[agents instructions continue; total ${lines.length} lines]`;
}

async function readAgentsExcerpt(dir: string, maxLines: number): Promise<string | undefined> {
  try {
    const buf = await fsp.readFile(path.join(dir, "AGENTS.md"));
    const text = buf.toString("utf8");
    if (text.includes("\0")) return undefined;
    return extractAgentsExcerpt(text, maxLines);
  } catch {
    return undefined;
  }
}

async function readProjectName(dir: string): Promise<string | undefined> {
  try {
    const pkg = JSON.parse(await fsp.readFile(path.join(dir, "package.json"), "utf8")) as {
      name?: string;
    };
    if (pkg.name) return pkg.name;
  } catch {
    // fall through to directory name
  }
  return undefined;
}

export async function scanProject(opts: ScanOptions): Promise<ProjectContext> {
  const ignore = opts.ignore ?? DEFAULT_IGNORE;
  const maxTopLevel = Math.max(1, opts.maxTopLevelEntries ?? 30);

  const name = (await readProjectName(opts.cwd)) ?? path.basename(opts.cwd);
  const topLevelRaw = await listTopLevel(opts.cwd, ignore);
  const topLevelEntries = topLevelRaw.slice(0, maxTopLevel);

  const manifests = topLevelRaw
    .filter((e) => MANIFEST_NAMES.has(e))
    .sort();
  const docs = topLevelRaw
    .filter((e) => DOC_NAMES.test(e))
    .sort();

  const maxExcerptLines = Math.max(1, opts.maxExcerptLines ?? 60);

  const { languages: languageCounts, fileCount } = await walkProject(opts.cwd, ignore);
  const languages = Object.entries(languageCounts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([lang]) => lang);

  const agentsExcerpt = await readAgentsExcerpt(opts.cwd, maxExcerptLines);

  return { name, languages, manifests, docs, topLevelEntries, fileCount, agentsExcerpt };
}