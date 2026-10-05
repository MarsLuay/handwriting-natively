import esbuild from "esbuild";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const production = process.argv[2] === "production";
const root = dirname(fileURLToPath(import.meta.url));
const vaultPluginDir = resolve(root, "../../.obsidian/plugins/native-pdf-handwriting");
const pdfJsSourceDir = resolve(root, "node_modules/pdfjs-dist");
const pdfJsOutputDir = resolve(root, "pdfjs");

function stagePdfJsAssets() {
  const packageJson = JSON.parse(readFileSync(resolve(pdfJsSourceDir, "package.json"), "utf8"));
  rmSync(pdfJsOutputDir, { recursive: true, force: true });
  mkdirSync(pdfJsOutputDir, { recursive: true });
  for (const file of ["build/pdf.mjs", "build/pdf.worker.mjs"]) {
    const source = resolve(pdfJsSourceDir, file);
    if (!existsSync(source)) throw new Error(`Missing PDF.js runtime asset: ${file}`);
    const destination = resolve(pdfJsOutputDir, file.replace(/^build[\\/]/, ""));
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
  for (const directory of ["cmaps", "standard_fonts", "wasm"]) {
    const source = resolve(pdfJsSourceDir, directory);
    if (existsSync(source)) cpSync(source, resolve(pdfJsOutputDir, directory), { recursive: true });
  }
  for (const file of ["LICENSE", "webpack.mjs"]) {
    const source = resolve(pdfJsSourceDir, file);
    if (existsSync(source)) copyFileSync(source, resolve(pdfJsOutputDir, file));
  }
  writeFileSync(resolve(pdfJsOutputDir, "manifest.json"), JSON.stringify({
    name: "pdfjs-dist",
    version: packageJson.version,
    core: "pdf.mjs",
    worker: "pdf.worker.mjs",
    pdfLib: "pdf-lib.mjs",
    thumbnailActions: "pdf-thumbnail-actions.mjs",
    postZoomInput: "post-zoom-input.mjs",
    cMaps: "cmaps/",
    standardFonts: "standard_fonts/",
    wasm: "wasm/"
  }, null, 2) + "\n");
}

async function stagePdfLibAsset() {
  await esbuild.build({
    entryPoints: [resolve(root, "src/pdf/PdfLibAsset.ts")],
    bundle: true,
    external: ["obsidian", "electron", ...builtinModules],
    format: "esm",
    target: "es2021",
    minify: true,
    outfile: resolve(pdfJsOutputDir, "pdf-lib.mjs"),
    logLevel: "silent"
  });
  await esbuild.build({
    entryPoints: [resolve(root, "src/integration/PdfThumbnailAsset.ts")],
    bundle: true,
    external: ["obsidian", "electron", ...builtinModules],
    format: "esm",
    target: "es2021",
    minify: true,
    outfile: resolve(pdfJsOutputDir, "pdf-thumbnail-actions.mjs"),
    logLevel: "silent"
  });
  await esbuild.build({
    entryPoints: [resolve(root, "src/runtime/PostZoomInputAsset.ts")],
    bundle: true,
    external: ["obsidian", "electron", ...builtinModules],
    format: "esm",
    target: "es2021",
    minify: true,
    outfile: resolve(pdfJsOutputDir, "post-zoom-input.mjs"),
    logLevel: "silent"
  });
}

function enforceProductionBundleBudget() {
  const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const budget = packageJson.codeAnalysis?.pluginBundleBudgetBytes;
  if (typeof budget !== "number") return;
  const bytes = statSync(resolve(root, "main.js")).size;
  console.log(`[bundle] main.js ${bytes} bytes (budget ${budget})`);
  if (bytes > budget) throw new Error(`main.js is ${bytes} bytes, above the ${budget}-byte bundle budget`);
}

function deployToVaultPlugin() {
  if (!existsSync(vaultPluginDir)) mkdirSync(vaultPluginDir, { recursive: true });
  for (const file of ["main.js", "manifest.json", "styles.css"]) {
    const from = resolve(root, file);
    if (!existsSync(from)) continue;
    copyFileSync(from, resolve(vaultPluginDir, file));
  }
  const deployedPdfJs = resolve(vaultPluginDir, "pdfjs");
  rmSync(deployedPdfJs, { recursive: true, force: true });
  cpSync(pdfJsOutputDir, deployedPdfJs, { recursive: true });
  console.log(`[deploy] ${vaultPluginDir}`);
}

stagePdfJsAssets();
await stagePdfLibAsset();

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "pdf-lib", ...builtinModules],
  format: "cjs",
  target: "esnext",
  charset: "utf8",
  sourcemap: production ? false : "inline",
  minify: production,
  treeShaking: true,
  outfile: "main.js",
  logLevel: "info",
  plugins: [{
    name: "deploy-vault-plugin",
    setup(build) {
      build.onEnd((result) => {
        if (result.errors.length) return;
        try {
          deployToVaultPlugin();
        } catch (error) {
          console.warn("[deploy] failed:", error);
        }
      });
    }
  }]
});

if (production) {
  await context.rebuild();
  enforceProductionBundleBudget();
  await context.dispose();
} else {
  await context.watch();
}
