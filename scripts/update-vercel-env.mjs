import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

const [file = ".env.vercel", ...extra] = process.argv.slice(2);
if (extra.length || !/^\.env\.vercel(?:-[a-zA-Z0-9_-]+)?$/.test(file)) {
  console.error("Usage: npm run vercel:env -- [.env.vercel | .env.vercel-live]");
  process.exit(1);
}

let variables;
try {
  variables = parseEnv(readFileSync(file, "utf8"));
} catch {
  console.error(`Cannot read ${file}. Generate it with npm run build:env -- ${file}.`);
  process.exit(1);
}

let updated = 0;
for (const [name, value] of Object.entries(variables)) {
  if (!value.trim()) {
    console.log(`Skipping empty ${name}`);
    continue;
  }
  const result = spawnSync("npx", [
    "--yes", "vercel", "env", "add", name, "--environment", "production", "--force",
  ], { input: value, stdio: ["pipe", "inherit", "inherit"] });
  if (result.status !== 0) {
    console.error(`Stopped at ${name} after ${updated} successful updates. You can rerun this command.`);
    process.exit(result.status ?? 1);
  }
  updated++;
}
console.log(`Updated ${updated} variables in the linked Vercel project's Production environment.`);
