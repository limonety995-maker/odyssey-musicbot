import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, "dist", "extension");
const port = Number(process.env.PORT || 4173);

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function getContentType(filePath) {
  return contentTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function resolveRequestPath(urlPath) {
  const pathname = decodeURIComponent((urlPath || "/").split("?")[0]);
  const normalized = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(distDir, normalized));
  if (!filePath.startsWith(distDir)) {
    return null;
  }
  return filePath;
}

async function serveFile(filePath, response) {
  const fileStat = await stat(filePath);
  if (fileStat.isDirectory()) {
    return false;
  }

  response.writeHead(200, {
    "Content-Type": getContentType(filePath),
    "Cache-Control": "no-store",
  });
  createReadStream(filePath).pipe(response);
  return true;
}

const buildProcess = spawn(process.execPath, ["build.mjs", "--watch"], {
  cwd: __dirname,
  stdio: "inherit",
});

buildProcess.on("exit", (code) => {
  if (code !== 0) {
    process.exit(code ?? 1);
  }
});

const server = http.createServer(async (request, response) => {
  const filePath = resolveRequestPath(request.url || "/");
  if (!filePath) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    if (!existsSync(filePath)) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    const served = await serveFile(filePath, response);
    if (!served) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
    }
  } catch {
    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Server error");
  }
});

server.listen(port, () => {
  console.log(`Dev server running at http://127.0.0.1:${port}`);
  console.log(`Serving files from ${distDir}`);
});

function shutdown(exitCode = 0) {
  server.close(() => {
    if (!buildProcess.killed) {
      buildProcess.kill();
    }
    process.exit(exitCode);
  });
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
