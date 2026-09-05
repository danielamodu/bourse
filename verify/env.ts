import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Loads `.env` into `process.env` before the live checks run.
 *
 * Vitest does not read `.env` files into `process.env`, so without this the verify
 * scripts would keep reading public endpoints and sending the fallback
 * `x-client-id` while the deployed app uses `BASE_RPC_URL` and the real one. That
 * is the worst kind of green: checks passing against infrastructure nobody ships.
 *
 * Two variables depend on it today. `BASE_RPC_URL` is what `verify:chain` reads
 * through — `baseRpcUrls()` puts it first — and `KYBERSWAP_CLIENT_ID` is the header
 * `verify:quote` and `verify:build` send. `BOURSE_FEE_RECEIVER` would matter the day
 * a fee exists.
 *
 * A setup file rather than the config's own module scope, because Vitest runs each
 * test file in a worker: this way the assignment happens in the process that reads
 * it, rather than relying on how a given pool inherits its environment.
 *
 * Twenty lines instead of `dotenv`, deliberately. It parses what this repo's
 * `.env.example` actually documents — `KEY=value`, `#` comments, blank lines, and
 * quotes around a value — and nothing else. The offline suite never loads this file
 * at all: `vitest.config.ts` excludes `verify/`, so `npm test` cannot start
 * depending on a developer's local environment.
 *
 * A variable already set in the real environment wins, so
 * `BASE_RPC_URL=… npm run verify:chain` overrides the file rather than being
 * silently replaced by it.
 */

/*
 * Resolved from the working directory rather than from `__dirname`: npm runs
 * scripts with the package root as cwd, and that root is also Vitest's own default
 * root, while `__dirname` is not defined in every module format a setup file gets
 * transformed into.
 */
const ENV_PATH = path.resolve(process.cwd(), ".env");

/** `KEY=value`, with `export` tolerated and surrounding quotes stripped. */
const ENTRY = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

function readEnvFile(): string {
  try {
    return readFileSync(ENV_PATH, "utf8");
  } catch {
    // No `.env` is the ordinary case on a fresh clone and in CI. The verify
    // scripts then behave exactly as they did before this file existed, which is
    // why nothing here throws: a missing file is a configuration state, not an
    // error, and failing the run over it would say the chain was unreachable.
    return "";
  }
}

for (const line of readEnvFile().split(/\r?\n/)) {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#")) continue;

  const match = ENTRY.exec(trimmed);
  if (match === null) continue;

  const key = match[1];
  const raw = match[2];
  if (key === undefined || raw === undefined) continue;

  const value = raw.replace(/^(["'])(.*)\1$/, "$2").trim();

  // An empty assignment is what `.env.example` ships for every variable, so it
  // means "not configured" and must not overwrite anything.
  if (value === "" || process.env[key] !== undefined) continue;

  process.env[key] = value;
}
