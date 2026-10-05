// Bundles dist/ into a single self-contained HTML file (`preview.html`) so the
// UI can be reviewed in environments where only a static file can be served.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dist = "dist";
const assets = join(dist, "assets");

const indexHtml = readFileSync(join(dist, "index.html"), "utf8");
const files = readdirSync(assets);

const jsFile = files.find((f) => f.endsWith(".js"));
const cssFile = files.find((f) => f.endsWith(".css"));

if (!jsFile) throw new Error("no JS bundle found in dist/assets");

const js = readFileSync(join(assets, jsFile), "utf8").replace(/<\/script/gi, "<\\/script");
const css = cssFile ? readFileSync(join(assets, cssFile), "utf8") : "";

// NOTE: use function replacers — the bundle contains `$` sequences that would
// otherwise be interpreted as replacement patterns (e.g. `$&`, `$1`).
const html = indexHtml
  .replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/g, "")
  .replace(/<link[^>]*rel="stylesheet"[^>]*>/g, "")
  .replace("</head>", () => `<style>${css}</style>\n  <script type="module">${js}</script>\n  </head>`)
  .replace(/ crossorigin/g, "");

writeFileSync("preview.html", html);
console.log(`wrote preview.html (${(html.length / 1024).toFixed(0)} KB)`);
