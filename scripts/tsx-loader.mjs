/**
 * Lets `node --test` load React components, so component regressions are
 * asserted in the test suite instead of by hand in a browser.
 *
 * Node strips types from `.ts` on its own but refuses JSX, and it knows neither
 * the `@/` alias nor Vite's extensionless imports. Component tests therefore
 * need exactly one transform. TypeScript is already a dev dependency for `npm
 * run typecheck`, so this borrows it rather than introducing a second
 * toolchain, and tests keep running under the `node:test` runner the rest of
 * `src/lib` already uses.
 *
 * Usage: `node --import ./scripts/tsx-loader.mjs --test "src/**\/*.test.tsx"`.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

/** Extensions Vite resolves for an import written without one. */
const CANDIDATES = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

/** `@/foo/bar` -> `src/foo/bar`; a relative specifier keeps its importer's directory. */
function basePath(specifier, parentURL) {
  if (specifier.startsWith("@/")) return SRC + specifier.slice(2);
  if (specifier.startsWith(".") && parentURL) {
    return fileURLToPath(new URL(specifier, parentURL));
  }
  return null;
}

/** The first candidate that exists as a file, or null to leave resolution alone. */
function existingFile(path) {
  for (const extension of CANDIDATES) {
    const candidate = path + extension;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const base = basePath(specifier, context.parentURL);
    const file = base ? existingFile(base) : null;
    if (!file) return nextResolve(specifier, context);
    return { url: pathToFileURL(file).href, shortCircuit: true };
  },

  load(url, context, nextLoad) {
    // A stylesheet only contributes class names at build time; tests assert the
    // markup those class names sit on, so an empty module is the honest stand-in.
    if (url.endsWith(".css")) {
      return { format: "module", source: "", shortCircuit: true };
    }
    if (!url.endsWith(".tsx")) return nextLoad(url, context);
    const file = fileURLToPath(url);
    const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
      fileName: file,
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        sourceMap: true,
        inlineSources: true,
      },
    });
    return { format: "module", source: outputText, shortCircuit: true };
  },
});
