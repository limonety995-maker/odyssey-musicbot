import esbuild from "esbuild";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionSrcDir = path.join(__dirname, "src", "extension");
const srcDir = existsSync(extensionSrcDir)
  ? extensionSrcDir
  : path.join(__dirname, "src");
const outDir = path.join(__dirname, "dist", "extension");
const watchMode = process.argv.includes("--watch");

const staticFiles = [
  "manifest.json",
  "index.html",
  "background.html",
  "styles.css",
  "icon.svg",
];

const bundleOptions = {
  entryPoints: {
    main: path.join(srcDir, "main.tsx"),
    background: path.join(srcDir, "background.ts"),
  },
  bundle: true,
  format: "esm",
  target: "es2022",
  platform: "browser",
  jsx: "automatic",
  loader: {
    ".svg": "file",
  },
  outdir: path.join(outDir, "assets"),
  sourcemap: false,
  logLevel: "info",
};

function copyStaticFiles() {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(path.join(outDir, "assets"), { recursive: true });
  for (const file of staticFiles) {
    copyFileSync(path.join(srcDir, file), path.join(outDir, file));
  }
}

async function runBuild() {
  copyStaticFiles();
  if (watchMode) {
    const context = await esbuild.context(bundleOptions);
    await context.watch();
    console.log(`Watching extension sources in ${srcDir}`);
    return;
  }
  await esbuild.build(bundleOptions);
}

runBuild().catch((error) => {
  console.error(error);
  process.exit(1);
});
