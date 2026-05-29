#!/usr/bin/env node
// Walks the projects root and writes hub/fleet.md — Jarvis's map of everything you're building.
// For each project: what it is (from its CLAUDE.md), git branch/dirty/last commit, last touched.

import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.env.PROJECTS_ROOT || join(process.env.HOME, "Documents/projects");
const SELF = "jarvis";
const IGNORE = new Set(["node_modules", ".git", ".DS_Store", "drive", SELF]);
const HUB = join(dirname(fileURLToPath(import.meta.url)), "..", "hub");

const git = (cwd, args) => {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};

// Pull the first meaningful description line out of a project's CLAUDE.md / README.
function describe(dir) {
  for (const f of ["CLAUDE.md", "README.md", "readme.md"]) {
    const p = join(dir, f);
    if (!existsSync(p)) continue;
    const lines = readFileSync(p, "utf8").split("\n");
    for (const raw of lines) {
      const l = raw.replace(/^#+\s*/, "").trim();
      if (!l || l.startsWith("<!--") || l.length <= 8) continue;
      if (/^@?[\w.-]+\.(md|txt)$/i.test(l)) continue; // skip "CLAUDE.md" / "@AGENTS.md" headings
      return l.slice(0, 160);
    }
  }
  return "";
}

const projects = readdirSync(ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !IGNORE.has(d.name) && !d.name.startsWith("."))
  .map((d) => {
    const dir = join(ROOT, d.name);
    const isRepo = existsSync(join(dir, ".git"));
    const branch = isRepo ? git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]) : "";
    const dirty = isRepo ? git(dir, ["status", "--porcelain"]).split("\n").filter(Boolean).length : 0;
    const last = isRepo ? git(dir, ["log", "-1", "--format=%cr|%s"]) : "";
    const [ago = "", subject = ""] = last.split("|");
    let mtime = 0;
    try { mtime = statSync(dir).mtimeMs; } catch {}
    return {
      name: d.name,
      desc: describe(dir),
      branch,
      dirty,
      ago,
      subject: subject.slice(0, 70),
      hasClaudeMd: existsSync(join(dir, "CLAUDE.md")),
      mtime,
    };
  })
  .sort((a, b) => b.mtime - a.mtime);

const stamp = new Date().toISOString();
let md = `# Fleet — live status of every project\n\n`;
md += `_Generated ${stamp} • ${projects.length} projects • most recently touched first._\n\n`;
md += `| Project | What it is | Branch | Uncommitted | Last commit |\n`;
md += `|---|---|---|---|---|\n`;
for (const p of projects) {
  const dirty = p.dirty ? `⚠️ ${p.dirty} files` : p.branch ? "clean" : "—";
  const commit = p.ago ? `${p.ago}: ${p.subject}` : "—";
  md += `| **${p.name}** | ${p.desc || "_no CLAUDE.md_"} | ${p.branch || "—"} | ${dirty} | ${commit} |\n`;
}

const noDocs = projects.filter((p) => !p.hasClaudeMd).map((p) => p.name);
if (noDocs.length) {
  md += `\n## Projects missing a CLAUDE.md\n${noDocs.join(", ")}\n`;
}
const stale = projects.filter((p) => p.dirty > 0);
if (stale.length) {
  md += `\n## Has uncommitted work right now\n${stale.map((p) => `${p.name} (${p.dirty})`).join(", ")}\n`;
}

writeFileSync(join(HUB, "fleet.md"), md);
console.log(`fleet.md written — ${projects.length} projects scanned.`);
