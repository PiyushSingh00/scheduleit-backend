const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SKIP_DIRS = new Set([".git", "node_modules"]);

function collectJsFiles(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".github") continue;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collectJsFiles(path.join(dir, entry.name), files);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".js")) files.push(path.join(dir, entry.name));
  }
  return files;
}

const files = collectJsFiles(ROOT);
let failed = false;

for (const file of files) {
  const label = path.relative(ROOT, file);
  const source = fs.readFileSync(file, "utf8");
  const isModule = /^\s*(import|export)\s/m.test(source);
  const args = isModule ? ["--check", "--input-type=module"] : ["--check", file];
  const options = isModule ? { input: source, stdio: ["pipe", "inherit", "inherit"] } : { stdio: "inherit" };
  if (isModule) console.log(`Checking ${label} as module`);
  const result = spawnSync(process.execPath, args, options);
  if (result.status !== 0) failed = true;
}

if (failed) process.exit(1);
console.log(`Checked ${files.length} JavaScript files.`);
