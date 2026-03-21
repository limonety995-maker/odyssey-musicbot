import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "data");
const libraryFile = path.join(dataDir, "library.json");

const HOST = process.env.MUSIC_HELPER_HOST || "127.0.0.1";
const PORT = Number(process.env.MUSIC_HELPER_PORT || 19345);

function createEmptyLibrary() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    scenes: [],
  };
}

async function ensureLibrary() {
  await fs.mkdir(dataDir, { recursive: true });
  try {
    await fs.access(libraryFile);
  } catch {
    await fs.writeFile(
      libraryFile,
      JSON.stringify(createEmptyLibrary(), null, 2),
      "utf8",
    );
  }
}

async function loadLibrary() {
  await ensureLibrary();
  const raw = await fs.readFile(libraryFile, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") {
    return createEmptyLibrary();
  }
  const scenes = Array.isArray(parsed.scenes)
    ? parsed.scenes.map(normalizeStoredScene).filter(Boolean)
    : [];
  return {
    version: 1,
    updatedAt: typeof parsed.updatedAt === "string"
      ? parsed.updatedAt
      : new Date().toISOString(),
    scenes,
  };
}

async function saveLibrary(library) {
  const normalized = {
    version: 1,
    updatedAt: new Date().toISOString(),
    scenes: Array.isArray(library.scenes)
      ? library.scenes.map(normalizeStoredScene).filter(Boolean)
      : [],
  };
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(libraryFile, JSON.stringify(normalized, null, 2), "utf8");
  return normalized;
}

function jsonHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json; charset=utf-8",
  };
}

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, jsonHeaders());
  response.end(JSON.stringify(data));
}

function sendError(response, statusCode, message, details = null) {
  sendJson(response, statusCode, {
    ok: false,
    error: message,
    details,
  });
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  if (!chunks.length) {
    return {};
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

function makeId(prefix) {
  if (typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function toPositiveNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

function normalizeStoredLayer(layer) {
  if (!layer || typeof layer !== "object") {
    return null;
  }
  const sourceType = layer.sourceType === "playlist" ? "playlist" : "video";
  if (typeof layer.sourceId !== "string" || !layer.sourceId.trim()) {
    return null;
  }
  return {
    id: typeof layer.id === "string" && layer.id.trim() ? layer.id : makeId("layer"),
    title: typeof layer.title === "string" && layer.title.trim()
      ? layer.title.trim()
      : sourceType === "playlist"
        ? `Playlist ${layer.sourceId}`
        : `Track ${layer.sourceId}`,
    url: typeof layer.url === "string" ? layer.url : "",
    sourceType,
    sourceId: layer.sourceId.trim(),
    origin: layer.origin === "youtube-music" ? "youtube-music" : "youtube",
    volume: clamp(toPositiveNumber(layer.volume, 100), 0, 100),
    loop: Boolean(layer.loop),
    startSeconds: toPositiveNumber(layer.startSeconds, 0),
  };
}

function normalizeStoredScene(scene) {
  if (!scene || typeof scene !== "object") {
    return null;
  }
  const layers = Array.isArray(scene.layers)
    ? scene.layers.map(normalizeStoredLayer).filter(Boolean)
    : [];
  if (!layers.length) {
    return null;
  }
  return {
    id: typeof scene.id === "string" && scene.id.trim() ? scene.id.trim() : makeId("scene"),
    name: typeof scene.name === "string" && scene.name.trim() ? scene.name.trim() : "Untitled scene",
    createdAt: typeof scene.createdAt === "string" ? scene.createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    layers,
  };
}

function isYouTubeVideoId(value) {
  return /^[A-Za-z0-9_-]{11}$/.test(value);
}

function isYouTubeListId(value) {
  return /^[A-Za-z0-9_-]{10,}$/.test(value);
}

function normalizeCanonicalUrl(parsed) {
  if (parsed.sourceType === "playlist") {
    return `https://www.youtube.com/playlist?list=${parsed.sourceId}`;
  }
  return `https://www.youtube.com/watch?v=${parsed.sourceId}`;
}

function parseDirectYouTubeUrl(rawInput) {
  const trimmed = String(rawInput || "").trim();
  if (!trimmed) {
    throw new Error("Paste a YouTube or YouTube Music link first.");
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(trimmed);
  } catch {
    throw new Error("This does not look like a valid URL.");
  }

  const host = parsedUrl.hostname.replace(/^www\./, "").toLowerCase();
  const pathname = parsedUrl.pathname;
  const musicHost = host === "music.youtube.com";

  if (host === "youtu.be") {
    const maybeVideoId = pathname.replace(/^\/+/, "").split("/")[0];
    if (!isYouTubeVideoId(maybeVideoId)) {
      throw new Error("Could not find a YouTube video ID in this short link.");
    }
    return {
      sourceType: "video",
      sourceId: maybeVideoId,
      origin: "youtube",
      url: trimmed,
      canonicalUrl: `https://www.youtube.com/watch?v=${maybeVideoId}`,
      resolution: "direct",
      warnings: [],
    };
  }

  if (!host.endsWith("youtube.com")) {
    throw new Error("Only YouTube and YouTube Music links are supported in this MVP.");
  }

  const listId = parsedUrl.searchParams.get("list");
  const videoId = parsedUrl.searchParams.get("v");
  const shortsMatch = pathname.match(/^\/shorts\/([A-Za-z0-9_-]{11})/);
  const embedMatch = pathname.match(/^\/embed\/([A-Za-z0-9_-]{11})/);

  if (pathname === "/playlist" && isYouTubeListId(listId)) {
    return {
      sourceType: "playlist",
      sourceId: listId,
      origin: musicHost ? "youtube-music" : "youtube",
      url: trimmed,
      canonicalUrl: `https://www.youtube.com/playlist?list=${listId}`,
      resolution: "direct",
      warnings: [],
    };
  }

  if (pathname === "/watch" && isYouTubeVideoId(videoId)) {
    return {
      sourceType: "video",
      sourceId: videoId,
      origin: musicHost ? "youtube-music" : "youtube",
      url: trimmed,
      canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
      resolution: "direct",
      warnings: listId && musicHost
        ? [
            "This YouTube Music watch link also contains a playlist ID. The MVP treats it as a single track by default.",
          ]
        : [],
    };
  }

  if (shortsMatch && isYouTubeVideoId(shortsMatch[1])) {
    return {
      sourceType: "video",
      sourceId: shortsMatch[1],
      origin: "youtube",
      url: trimmed,
      canonicalUrl: `https://www.youtube.com/watch?v=${shortsMatch[1]}`,
      resolution: "direct",
      warnings: [],
    };
  }

  if (embedMatch && isYouTubeVideoId(embedMatch[1])) {
    return {
      sourceType: "video",
      sourceId: embedMatch[1],
      origin: musicHost ? "youtube-music" : "youtube",
      url: trimmed,
      canonicalUrl: `https://www.youtube.com/watch?v=${embedMatch[1]}`,
      resolution: "direct",
      warnings: [],
    };
  }

  throw new Error("This link does not expose a direct playable video or playlist ID.");
}

async function tryResolveFromPage(rawInput) {
  const response = await fetch(rawInput, {
    redirect: "follow",
    headers: {
      "Accept-Language": "en-US,en;q=0.8",
      "User-Agent": "Mozilla/5.0 OwlbearSyncMusicHelper/0.1",
    },
  });

  if (!response.ok) {
    throw new Error(`Remote page returned ${response.status}.`);
  }

  const html = await response.text();
  const canonicalMatch = html.match(/<link\s+rel="canonical"\s+href="([^"]+)"/i);
  if (canonicalMatch?.[1]) {
    try {
      const parsed = parseDirectYouTubeUrl(canonicalMatch[1]);
      return {
        ...parsed,
        url: rawInput,
        resolution: "page-scrape",
        warnings: [
          "The helper had to inspect the page to find a playable YouTube target. This may be less reliable than a direct watch or playlist link.",
          ...parsed.warnings,
        ],
      };
    } catch {
      // Ignore and continue to heuristic matches.
    }
  }

  const playlistIdMatch = html.match(/"playlistId":"([A-Za-z0-9_-]{10,})"/);
  const videoIdMatch = html.match(/"videoId":"([A-Za-z0-9_-]{11})"/);

  if (playlistIdMatch?.[1] && String(rawInput).includes("playlist")) {
    return {
      sourceType: "playlist",
      sourceId: playlistIdMatch[1],
      origin: String(rawInput).includes("music.youtube.com") ? "youtube-music" : "youtube",
      url: rawInput,
      canonicalUrl: `https://www.youtube.com/playlist?list=${playlistIdMatch[1]}`,
      resolution: "page-scrape",
      warnings: [
        "This link was resolved heuristically from page data. If playback fails, use the direct Share link for the playlist.",
      ],
    };
  }

  if (videoIdMatch?.[1]) {
    return {
      sourceType: "video",
      sourceId: videoIdMatch[1],
      origin: String(rawInput).includes("music.youtube.com") ? "youtube-music" : "youtube",
      url: rawInput,
      canonicalUrl: `https://www.youtube.com/watch?v=${videoIdMatch[1]}`,
      resolution: "page-scrape",
      warnings: [
        "This link was resolved heuristically from page data. If playback fails, use the direct Share link for the song or video.",
      ],
    };
  }

  throw new Error("Could not resolve this page into a direct playable YouTube target.");
}

async function resolveYouTubeInput(rawInput) {
  try {
    return parseDirectYouTubeUrl(rawInput);
  } catch (directError) {
    const text = String(rawInput || "");
    if (!text.includes("youtube.com") && !text.includes("youtu.be")) {
      throw directError;
    }
    try {
      return await tryResolveFromPage(rawInput);
    } catch (fallbackError) {
      throw new Error(
        `${directError.message} ${fallbackError.message} Use a direct Share link from YouTube or YouTube Music.`,
      );
    }
  }
}

function fallbackTrackTitle(parsed) {
  if (parsed.sourceType === "playlist") {
    return `Playlist ${parsed.sourceId}`;
  }
  return `Track ${parsed.sourceId}`;
}

async function loadTrackMetadata(parsed) {
  if (parsed.sourceType !== "video") {
    return {
      title: fallbackTrackTitle(parsed),
      thumbnailUrl: null,
    };
  }

  const oEmbedUrl = new URL("https://www.youtube.com/oembed");
  oEmbedUrl.searchParams.set("url", normalizeCanonicalUrl(parsed));
  oEmbedUrl.searchParams.set("format", "json");

  const response = await fetch(oEmbedUrl, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "Mozilla/5.0 OwlbearSyncMusicHelper/0.1",
    },
  });

  if (!response.ok) {
    return {
      title: fallbackTrackTitle(parsed),
      thumbnailUrl: null,
    };
  }

  const data = await response.json();
  return {
    title: typeof data.title === "string" && data.title.trim()
      ? data.title.trim()
      : fallbackTrackTitle(parsed),
    thumbnailUrl: typeof data.thumbnail_url === "string" ? data.thumbnail_url : null,
  };
}

async function handleResolveTrack(payload) {
  const parsed = await resolveYouTubeInput(payload.url);
  const metadata = await loadTrackMetadata(parsed);
  const customTitle = typeof payload.title === "string" && payload.title.trim()
    ? payload.title.trim()
    : metadata.title;
  return {
    ok: true,
    track: {
      id: makeId("layer"),
      title: customTitle,
      url: parsed.url,
      sourceType: parsed.sourceType,
      sourceId: parsed.sourceId,
      origin: parsed.origin,
      volume: clamp(toPositiveNumber(payload.volume, 100), 0, 100),
      loop: Boolean(payload.loop),
      startSeconds: toPositiveNumber(payload.startSeconds, 0),
      thumbnailUrl: metadata.thumbnailUrl,
    },
    resolution: parsed.resolution,
    warnings: parsed.warnings,
  };
}

function pathSceneId(urlPathname) {
  const parts = urlPathname.split("/").filter(Boolean);
  if (parts.length === 3 && parts[0] === "api" && parts[1] === "scenes") {
    return decodeURIComponent(parts[2]);
  }
  return null;
}

const server = http.createServer(async (request, response) => {
  if (!request.url) {
    sendError(response, 400, "Missing request URL.");
    return;
  }

  if (request.method === "OPTIONS") {
    response.writeHead(204, jsonHeaders());
    response.end();
    return;
  }

  const url = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);

  try {
    if (request.method === "GET" && url.pathname === "/api/health") {
      const library = await loadLibrary();
      sendJson(response, 200, {
        ok: true,
        host: HOST,
        port: PORT,
        sceneCount: library.scenes.length,
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/library") {
      const library = await loadLibrary();
      sendJson(response, 200, {
        ok: true,
        library,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/resolve") {
      const payload = await readJsonBody(request);
      const resolved = await handleResolveTrack(payload);
      sendJson(response, 200, resolved);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/scenes") {
      const payload = await readJsonBody(request);
      if (!payload.scene || typeof payload.scene !== "object") {
        sendError(response, 400, "Request must include a scene object.");
        return;
      }

      const scene = normalizeStoredScene(payload.scene);
      if (!scene) {
        sendError(response, 400, "Scene must have a name and at least one valid layer.");
        return;
      }

      const library = await loadLibrary();
      const existingIndex = library.scenes.findIndex((item) => item.id === scene.id);
      if (existingIndex >= 0) {
        library.scenes[existingIndex] = {
          ...library.scenes[existingIndex],
          ...scene,
          updatedAt: new Date().toISOString(),
        };
      } else {
        library.scenes.unshift(scene);
      }

      const saved = await saveLibrary(library);
      sendJson(response, 200, {
        ok: true,
        library: saved,
        scene,
      });
      return;
    }

    if (request.method === "DELETE" && url.pathname.startsWith("/api/scenes/")) {
      const sceneId = pathSceneId(url.pathname);
      if (!sceneId) {
        sendError(response, 400, "Missing scene ID.");
        return;
      }

      const library = await loadLibrary();
      const nextScenes = library.scenes.filter((scene) => scene.id !== sceneId);
      const saved = await saveLibrary({
        ...library,
        scenes: nextScenes,
      });
      sendJson(response, 200, {
        ok: true,
        library: saved,
      });
      return;
    }

    sendError(response, 404, "Route not found.");
  } catch (error) {
    sendError(
      response,
      500,
      error instanceof Error ? error.message : "Unexpected server error.",
    );
  }
});

server.listen(PORT, HOST, async () => {
  await ensureLibrary();
  console.log(`Owlbear Sync Music helper listening on http://${HOST}:${PORT}`);
  console.log(`Library file: ${libraryFile}`);
});
