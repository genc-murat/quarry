/**
 * Smoke test of the packaged app against a live local model: build a bundle
 * that carries a probe, launch it with a demo SQLite database, and check that
 * the editor's completion list opened in the language's own order and then put
 * the model's pick first.
 *
 * Nobody looks at the screen. The one thing a script cannot do is type, so the
 * probe (`src/lib/rankProbe.ts`) types the last character of the SQL, watches
 * the list and the assistant indicator, and posts every observation back to this
 * run's server — the same arrangement `scripts/e2e-update.mjs` uses to click
 * Install. What the script asserts is that *sequence*: a list led by something
 * other than `orders` first, and by `orders` afterwards. A run where the ranking
 * never happened, or happened before the list was ever shown, fails instead of
 * looking identical to a good one. Those rules are `scripts/smokeRanking.mjs`,
 * checked without a machine that can run this (`smokeRanking.test.mjs`).
 *
 * The demo database is built for the question: its tables all contain `ord`, so
 * `SELECT * FROM ord` is a real choice, and the table the SQL names is not the
 * one the list would show first.
 *
 * Requires Ollama on this machine with a decision model pulled (`nimble` by
 * default, `QUARRY_SMOKE_MODEL` to choose another). Without one the run exits 2
 * before building anything, because a smoke test with no model is not a pass.
 *
 * Usage:
 *
 * ```sh
 * npm run smoke:app                 # debug bundle: fastest, the usual loop
 * npm run smoke:app -- --release    # the profile a shipped bundle is built in
 * ```
 *
 * A probe build is not a build to keep: both the probe and the widened CSP are
 * build-time choices, so the run puts whatever bundle was in the target
 * directory back the way it found it before it exits.
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { listLabels, problems } from "./smokeRanking.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const CONF = path.join(ROOT, "src-tauri", "tauri.conf.json");

/** The question the run asks, and the answer a person would act on. */
const CONNECTION = "Ranking demo (SQLite)";
const SQL = "SELECT * FROM or";
const TYPED = "d";
const PICK = "orders";

/**
 * The failure phase's question: a table `order_items` mistyped into one the demo
 * schema does not have, and the name a person would act on. SQLite's own error
 * names the typo (`no such table: oder_items`), which is what the editor scores
 * the schema's names against — so the hint has to come back as the real table.
 */
const FAILURE_SQL = "SELECT * FROM oder_items";
const FAILURE_NAME = "order_items";

/**
 * The demo schema. `orders` is the table the SQL names and the last of the three
 * `order*` names the list will offer, so a ranking that leads with it has moved
 * something rather than agreed with the language.
 */
const SCHEMA = [
  "CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, email TEXT)",
  "CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, total NUMERIC, placed_at TEXT)",
  "CREATE TABLE order_items (id INTEGER PRIMARY KEY, order_id INTEGER, sku TEXT, qty INTEGER)",
  "CREATE TABLE order_archive (id INTEGER PRIMARY KEY, original_order_id INTEGER, archived_at TEXT)",
  "CREATE TABLE work_orders (id INTEGER PRIMARY KEY, technician TEXT, scheduled_for TEXT)",
  "CREATE TABLE orchards (id INTEGER PRIMARY KEY, name TEXT, acres REAL)",
];

/** The release profile is the one a shipped bundle uses; debug is faster. */
const release = process.argv.includes("--release");
const model = process.env.QUARRY_SMOKE_MODEL || "nimble";
const OLLAMA = process.env.QUARRY_OLLAMA_URL || "http://127.0.0.1:11434";

let child = null;
let server = null;
let work = null;

// --- the demo ---------------------------------------------------------------

/** Writes the database the run completes against, and returns its path. */
function writeDemoDatabase(file) {
  const database = new DatabaseSync(file);
  try {
    for (const statement of SCHEMA) database.exec(statement);
    database.exec("INSERT INTO orders (customer_id, total) VALUES (1, 249.90), (2, 89.00)");
  } finally {
    database.close();
  }
  return file;
}

/**
 * A home of its own for the run: an app that writes nothing of the user's and
 * cannot be confused by what the user has. The app keeps its data in
 * `app_config_dir()`, which is `$HOME/Library/Application Support/{identifier}`
 * on macOS, so launching with `HOME` pointed here isolates it.
 */
async function seedHome(identifier) {
  const home = path.join(work, "home");
  const data = path.join(home, "Library", "Application Support", identifier);
  await mkdir(data, { recursive: true });

  const database = writeDemoDatabase(path.join(work, "demo.sqlite"));
  await writeFile(
    path.join(data, "connections.json"),
    JSON.stringify(
      [
        {
          id: "smoke-rank-demo",
          name: CONNECTION,
          driver: "sqlite",
          host: "",
          port: 0,
          username: "",
          database: null,
          sslMode: "disabled",
          options: { path: database, createIfMissing: "true" },
          hasPassword: false,
        },
      ],
      null,
      2,
    ),
  );
  // The switch the settings panel would turn on, and the model it would name.
  await writeFile(
    path.join(data, "settings.json"),
    JSON.stringify(
      { theme: { mode: "light", palette: "sunset" }, settings: { assistant: { smartAutocomplete: true, model } } },
      null,
      2,
    ),
  );
  return home;
}

// --- the server the probe reports to ----------------------------------------

/**
 * Collects the probe's steps in arrival order. The run is over when the probe
 * says it is — `done`, `timeout:…` or `error:…` — or when nothing arrives at
 * all, which is what a bundle that never started looks like.
 */
function startServer() {
  const seen = { steps: [], finished: null };
  let settle = () => {};
  const finished = new Promise((resolve) => {
    settle = resolve;
  });

  server = createServer((request, response) => {
    const { pathname } = new URL(request.url, "http://127.0.0.1");
    response.writeHead(204, { "access-control-allow-origin": "*" }).end();
    if (!pathname.startsWith("/probe/")) return;

    const [, , ms, step] = pathname.split("/").map(decodeURIComponent);
    seen.steps.push({ ms: Number(ms) || 0, step });
    if (/^(done|timeout:|error:)/.test(step)) {
      seen.finished = step;
      settle();
    }
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ origin: `http://127.0.0.1:${server.address().port}`, seen, finished }));
  });
}

// --- building and launching -------------------------------------------------

/**
 * The bundler's config for this run: the probe's origin added to the CSP
 * `connect-src`, and the updater artifact switched off so a run needs no signing
 * key. Written to a file rather than into `tauri.conf.json`, so a run leaves the
 * repository alone. `scripts/e2e-update.mjs` widens the same directive for its
 * own probe; the two are kept apart so neither run can break the other.
 */
async function overrideConfig(origin) {
  const conf = JSON.parse(await readFile(CONF, "utf8"));
  const csp = conf.app?.security?.csp;
  if (!csp) throw setup("tauri.conf.json has no CSP for the probe's reports to pass");
  const directives = csp.split(";").map((part) => part.trim()).filter(Boolean);
  const connect = directives.find((part) => part.startsWith("connect-src "));
  if (!connect) throw setup("the app CSP has no connect-src directive to widen");
  const sources = connect.slice("connect-src ".length).split(/\s+/);
  if (!sources.includes(origin)) sources.push(origin);
  const widened = directives
    .map((part) => (part === connect ? `connect-src ${sources.join(" ")}` : part))
    .join("; ");

  const file = path.join(work, "smoke.conf.json");
  await writeFile(
    file,
    JSON.stringify(
      { bundle: { createUpdaterArtifacts: false }, app: { security: { csp: `${widened};` } } },
      null,
      2,
    ),
  );
  return file;
}

/** Builds the bundle the run drives, with the probe compiled into it. */
async function buildBundle(origin) {
  const config = await overrideConfig(origin);
  const profile = release ? [] : ["--debug"];
  console.log(`\nbuilding the ${release ? "release" : "debug"} bundle with the probe…`);
  await logged("npx", ["tauri", "build", ...profile, "--bundles", "app", "--config", config], {
    log: path.join(work, "logs", "build.log"),
    env: {
      VITE_RANK_PROBE: "1",
      VITE_RANK_PROBE_URL: origin,
      VITE_RANK_PROBE_CONNECTION: CONNECTION,
      VITE_RANK_PROBE_SQL: SQL,
      VITE_RANK_PROBE_TYPED: TYPED,
      VITE_RANK_PROBE_FAILURE: FAILURE_SQL,
    },
  });
}

function bundlesDirectory() {
  return path.join(ROOT, "src-tauri", "target", release ? "release" : "debug", "bundle", "macos");
}

/** The app inside a bundle, whose executable is named after the binary. */
async function executable(app) {
  const macos = path.join(app, "Contents", "MacOS");
  const [name] = await readdir(macos);
  if (!name) throw setup(`${app} holds no executable`);
  return path.join(macos, name);
}

/**
 * Launches the app with the run's own home. Detached, so the whole thing can be
 * taken down at once, and with its output in a file, because a packaged app that
 * fails before the webview loads says so nowhere else.
 */
function launch(exe, home) {
  const out = openSync(path.join(work, "logs", "app.log"), "w");
  child = spawn(exe, [], { detached: true, stdio: ["ignore", out, out], env: { ...process.env, HOME: home } });
  child.on("error", (error) => console.error(`  the app did not start: ${error.message}`));
  child.unref();
  closeSync(out);
  return child;
}

// --- judging the run --------------------------------------------------------

/**
 * What the run has to show for itself. The rules are `./smokeRanking.mjs`, which
 * is checked on its own in `smokeRanking.test.mjs`; what is left here is telling
 * them the question this run asked.
 */
function foundProblems(seen) {
  return problems(seen, {
    sql: SQL,
    typed: TYPED,
    pick: PICK,
    repair: { sql: FAILURE_SQL, name: FAILURE_NAME },
  });
}

function transcript(seen) {
  for (const entry of seen.steps) {
    const when = entry.ms > 0 ? `+${entry.ms}ms` : "—";
    console.log(`  ${when.padStart(8)}  ${entry.step}`);
  }
}

/** Says why the app itself failed, when it did, from the log it wrote. */
async function explain() {
  try {
    const text = await readFile(path.join(work, "logs", "app.log"), "utf8");
    const tail = text.split("\n").slice(-20).join("\n").trim();
    if (tail) console.error(`\n  the app said:\n${tail.replace(/^/gm, "    ")}`);
  } catch {
    // No log: the app never started.
  }
}

// --- plumbing ---------------------------------------------------------------

/** Runs a command with its output in a file, and its environment extended. */
function logged(command, args, { log, env }) {
  return new Promise((done, fail) => {
    const out = openSync(log, "w");
    const running = spawn(command, args, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", out, out],
    });
    running.on("error", fail);
    running.on("exit", (code) => {
      closeSync(out);
      if (code === 0) done();
      else fail(new Error(`${command} ${args.join(" ")} exited ${code}: see ${log}`));
    });
  });
}

/** A precondition the run cannot do anything about, told apart from a failure. */
function setup(message) {
  const error = new Error(message);
  error.setup = true;
  return error;
}

async function stopRun() {
  if (child?.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // Already gone, or the group went with it.
    }
    child = null;
  }
  if (server) server.close();
}

/**
 * Puts the bundle that was in the target directory back. A probe build carries
 * the probe and a widened CSP, so leaving it behind would be leaving a bundle
 * nobody should launch — and rebuilding it would take as long as the run.
 */
async function restoreBundle(kept, app) {
  await rm(app, { recursive: true, force: true }).catch(() => {});
  if (kept) await cp(kept, app, { recursive: true }).catch(() => {});
}

// --- the run ----------------------------------------------------------------

async function main() {
  const conf = JSON.parse(await readFile(CONF, "utf8"));
  const identifier = conf.identifier;
  const product = conf.productName ?? "Quarry";

  work = path.join(tmpdir(), `quarry-smoke-${Date.now()}`);
  await mkdir(path.join(work, "logs"), { recursive: true });
  console.log(`work directory: ${work}`);

  // A model that is not there is a setup problem, not a failed run: say so
  // before spending a build on it.
  const tags = await fetch(`${OLLAMA}/api/tags`)
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);
  if (!tags) throw setup(`no Ollama at ${OLLAMA}: start it, or set QUARRY_OLLAMA_URL`);
  const names = (tags.models ?? []).map((entry) => entry.name);
  if (!names.some((name) => name === model || name === `${model}:latest`)) {
    throw setup(`the model ${model} is not pulled (have: ${names.join(", ") || "none"}) — run: ollama pull ${model}`);
  }
  console.log(`model: ${model}`);

  const home = await seedHome(identifier);
  const { origin, seen, finished } = await startServer();

  const app = path.join(bundlesDirectory(), `${product}.app`);
  const kept = existsSync(app) ? path.join(work, "shipping.app") : null;
  if (kept) await cp(app, kept, { recursive: true });

  try {
    await buildBundle(origin);
    const exe = await executable(app);
    console.log(`launching ${exe}`);
    launch(exe, home);

    // The probe gives up on its own after a minute; this is the patience for a
    // bundle that never got that far.
    await Promise.race([finished, new Promise((resolve) => setTimeout(resolve, 120_000))]);

    console.log("\nwhat the app reported\n");
    transcript(seen);
    const found = foundProblems(seen);
    if (found.length > 0) {
      await explain();
      console.error(`\nsmoke test failed\n${found.map((line) => `  · ${line}`).join("\n")}`);
      return 1;
    }
    const lists = seen.steps.filter((step) => step.step.startsWith("list:"));
    const opened = listLabels(lists[0].step).slice(0, 3).join(" > ");
    const ended = listLabels(lists[lists.length - 1].step).slice(0, 3).join(" > ");
    const hint = seen.steps.find((entry) => entry.step.startsWith("repair:"));
    const repaired = seen.steps.find((entry) => entry.step.startsWith("fixed:"));
    console.log(`\nsmoke test passed with the live model: the list opened ${opened}`);
    console.log(`and, once the answer landed, read ${ended}`);
    console.log(
      `and ${FAILURE_SQL} failed with the model suggesting ${hint ? hint.step.slice("repair:".length) : "—"}`,
    );
    console.log(
      `which the editor was left holding and ran: ${repaired ? repaired.step.slice("fixed:".length) : "—"}`,
    );
    return 0;
  } finally {
    await stopRun();
    await restoreBundle(kept, app);
  }
}

main()
  .then((code) => process.exit(code))
  .catch(async (error) => {
    await stopRun();
    console.error(`\n${error.setup ? "cannot run" : "smoke test failed"}: ${error.message}`);
    process.exit(error.setup ? 2 : 1);
  });
