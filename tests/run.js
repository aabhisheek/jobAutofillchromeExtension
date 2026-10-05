// Runs every tests/verify-*.js in its own process and exits non-zero if any fail.
//
//   node tests/run.js
//
// No dependencies, matching the rest of the repo. Each file is a standalone
// script, so a crash in one cannot take the others down with it.

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const dir = __dirname;
const files = fs.readdirSync(dir)
  .filter((f) => /^verify-.*\.js$/.test(f))
  .sort();

if (!files.length) {
  console.error("No verify-*.js files found in tests/");
  process.exit(1);
}

let failed = 0;
const totals = [];

for (const file of files) {
  console.log(`\n${"=".repeat(60)}\n${file}\n${"=".repeat(60)}`);

  // Pipe rather than inherit, so the child's output is still readable here for
  // the tally below. (With `stdio: "inherit"` res.stdout is null.)
  const res = spawnSync(process.execPath, [path.join(dir, file)], { encoding: "utf8" });
  const ok = res.status === 0;
  const out = `${res.stdout || ""}${res.stderr || ""}`;
  process.stdout.write(res.stdout || "");
  if (res.stderr) process.stderr.write(res.stderr);

  // Each harness prints "<name>: N passed, M failed" as its last line.
  const counts = [...out.matchAll(/(\d+) passed, (\d+) failed/g)].pop();
  if (counts) {
    totals.push({ file, pass: +counts[1], fail: +counts[2], ok });
  } else if (!ok) {
    failed += 1;
    console.log(`${file}: CRASHED (exit ${res.status})`);
  }
}

console.log(`\n${"=".repeat(60)}`);
let pass = 0;
let bad = 0;
for (const t of totals) {
  pass += t.pass;
  bad += t.fail;
  console.log(`  ${t.ok ? "PASS" : "FAIL"}  ${t.file.padEnd(24)} ${t.pass} passed, ${t.fail} failed`);
}
console.log(`${"=".repeat(60)}`);
console.log(`  ${pass} assertions passed, ${bad} failed`);

process.exit(bad > 0 || failed > 0 ? 1 : 0);
