#!/usr/bin/env node
// Refuse to package this module while test residue is sitting in it.
//
// ⚠️ THE DEFECT THIS EXISTS FOR, measured 2026-09-29. `lib/` held TWELVE files
// named `.mut-<random>.js` / `.mutcred-<random>.js` — deliberately BROKEN copies
// of `auth.js` and `credentials.js`, written there by a negative-control harness
// that has to place a mutant beside its own `require("./accounts")` for the
// relative specifier to resolve. `package.json` declares `files: ["bin/","lib/"]`,
// which includes dotfiles, and `npm pack --dry-run` listed all twelve: a publish
// would have shipped ~350 KB of intentionally-defective library modules to every
// user of this package.
//
// The harness's cleanup is straight-line at the END of its script — so a die(),
// a throw, or a kill leaves every mutant behind, and residue accumulates across
// runs. Cleaning up afterwards is a PROMISE; refusing to package is a GUARANTEE.
// (`files` also carries explicit negations, so even a refusal that is somehow
// bypassed cannot put these in a tarball. Two independent barriers, because this
// one is the only one that can say WHY.)
//
// Runs as `prepack`, so it fires on `npm pack` AND on `npm publish`.
// ⚠️ It must never invoke `npm pack` to find out what would ship — that would
// re-enter `prepack` forever. It scans the declared directories directly.
//
//   exit 0 = clean · 1 = residue found (packaging refused) · 2 = could-not-run
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.env.PKG_ROOT ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let pkg;
try { pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")); }
catch (e) { console.error("COULD_NOT_RUN: package.json unreadable: " + e.message); process.exit(2); }

// Scan exactly what the package declares it ships. A hardcoded ["bin","lib"]
// would go stale the moment a directory is added, and would then report clean
// about a directory nobody is checking.
const declared = Array.isArray(pkg.files) ? pkg.files : null;
if (!declared) { console.error("COULD_NOT_RUN: package.json declares no `files` list"); process.exit(2); }
const dirs = declared
  .filter(f => typeof f === "string" && !f.startsWith("!"))
  .map(f => f.replace(/\/+$/, ""))
  .filter(f => { try { return fs.statSync(path.join(ROOT, f)).isDirectory(); } catch { return false; } });
if (!dirs.length) { console.error("COULD_NOT_RUN: none of the declared `files` entries is a directory"); process.exit(2); }

// Residue classes, each one paid for on this host:
//   .mut* / .mutcred*  — negative-control mutants of a real module
//   *.bak* / *.orig / *.rej — editor and patch leftovers (the extension zip
//                             shipped a full second copy of content.js this way)
//   *.tmp              — an interrupted atomic write
//   any other dotfile  — a module is never a dotfile, so one here is residue
const isResidue = (name) =>
  /^\.mut/.test(name) ||
  /\.bak(\.|$)/.test(name) || /\.orig$/.test(name) || /\.rej$/.test(name) ||
  /\.tmp$/.test(name) ||
  name.startsWith(".");

const found = [];
const walk = (rel) => {
  let entries;
  try { entries = fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const r = path.join(rel, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules") continue;
      walk(r);
    } else if (isResidue(e.name)) {
      let size = 0; try { size = fs.statSync(path.join(ROOT, r)).size; } catch {}
      found.push({ path: r, size });
    }
  }
};
for (const d of dirs) walk(d);

if (!found.length) {
  console.log("package residue check: clean (" + dirs.join(", ") + ")");
  process.exit(0);
}
console.error("REFUSING TO PACKAGE: " + found.length + " residue file(s) inside the published directories.");
console.error("These would ship to every user of this package. Remove them and retry.\n");
let total = 0;
for (const f of found) { total += f.size; console.error("  " + f.path + "  (" + f.size + " B)"); }
console.error("\ntotal " + total + " B");
process.exit(1);
