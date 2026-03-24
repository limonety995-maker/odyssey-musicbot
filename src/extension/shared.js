export const EXTENSION_ID = "com.limon.dnd.sync-music";
export const ROOM_STATE_KEY = `${EXTENSION_ID}/room-state`;
export const SCENE_LIBRARY_KEY = `${EXTENSION_ID}/scene-library`;
export const CLIENT_STATUS_KEY = `${EXTENSION_ID}/client-status`;
export const BROADCAST_CHANNEL = `${EXTENSION_ID}/room-state`;
export const LOCAL_CONTROL_CHANNEL = `${EXTENSION_ID}/local-control`;
export const HELPER_URL_STORAGE_KEY = `${EXTENSION_ID}/helper-url`;
export const LOCAL_OUTPUT_VOLUME_KEY = `${EXTENSION_ID}/local-output-volume`;

export const TRANSPORT_PLAYING = "playing";
export const TRANSPORT_PAUSED = "paused";
export const TRANSPORT_STOPPED = "stopped";

export const DEFAULT_HELPER_URL = "http://127.0.0.1:19345";
export const START_LEAD_MS = 2500;
export const SYNC_INTERVAL_MS = 5000;
export const SEEK_TOLERANCE_SEC = 1.35;

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function safeNow() {
  return Date.now();
}

export function makeId(prefix = "id") {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${safeNow()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function deepClone(value) {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

export function getHelperUrl() {
  try {
    return localStorage.getItem(HELPER_URL_STORAGE_KEY) || DEFAULT_HELPER_URL;
  } catch {
    return DEFAULT_HELPER_URL;
  }
}

export function setHelperUrl(url) {
  try {
    localStorage.setItem(HELPER_URL_STORAGE_KEY, url || DEFAULT_HELPER_URL);
  } catch {
    // Ignore localStorage failures.
  }
}

export function getLocalOutputVolume() {
  try {
    return clamp(
      toNumber(localStorage.getItem(LOCAL_OUTPUT_VOLUME_KEY), 100),
      0,
      100,
    );
  } catch {
    return 100;
  }
}

export function setLocalOutputVolume(volume) {
  try {
    localStorage.setItem(
      LOCAL_OUTPUT_VOLUME_KEY,
      String(clamp(toNumber(volume, 100), 0, 100)),
    );
  } catch {
    // Ignore localStorage failures.
  }
}

function toNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function slugIdPart(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

export function buildStableFallbackId(prefix, parts = [], fallbackIndex = 0) {
  const slug = parts
    .map(slugIdPart)
    .filter(Boolean)
    .join("-");
  return `${prefix}-${slug || "item"}-${Math.max(0, toNumber(fallbackIndex, 0))}`;
}

export function createLayer(source = {}, fallbackIndex = 0) {
  const startSeconds = Math.max(0, toNumber(source.startSeconds, 0));
  const sourceType = source.sourceType === "playlist" ? "playlist" : "video";
  return {
    id: typeof source.id === "string" && source.id.trim()
      ? source.id.trim()
      : buildStableFallbackId(
          "layer",
          [source.origin, sourceType, source.sourceId, source.title, startSeconds],
          fallbackIndex,
        ),
    title: typeof source.title === "string" && source.title.trim()
      ? source.title.trim()
      : sourceType === "playlist"
        ? `Playlist ${source.sourceId || ""}`.trim()
        : `Track ${source.sourceId || ""}`.trim(),
    url: typeof source.url === "string" ? source.url : "",
    sourceType,
    sourceId: typeof source.sourceId === "string" ? source.sourceId.trim() : "",
    origin: source.origin === "youtube-music" ? "youtube-music" : "youtube",
    volume: clamp(toNumber(source.volume, 100), 0, 100),
    loop: Boolean(source.loop),
    startSeconds,
    runtime: {
      status: source.runtime?.status === TRANSPORT_PLAYING
        ? TRANSPORT_PLAYING
        : source.runtime?.status === TRANSPORT_PAUSED
          ? TRANSPORT_PAUSED
          : TRANSPORT_STOPPED,
      pauseOffsetSec: Math.max(0, toNumber(source.runtime?.pauseOffsetSec, startSeconds)),
      playingSince: Number.isFinite(source.runtime?.playingSince)
        ? Number(source.runtime.playingSince)
        : null,
      playlistIndex: Math.max(0, toNumber(source.runtime?.playlistIndex, 0)),
      playlistVideoId: typeof source.runtime?.playlistVideoId === "string"
        ? source.runtime.playlistVideoId
        : null,
      cycle: Math.max(0, toNumber(source.runtime?.cycle, 0)),
      lastSyncAt: Math.max(0, toNumber(source.runtime?.lastSyncAt, 0)),
    },
  };
}

export function createEmptyRoomState() {
  return {
    version: 1,
    revision: 0,
    activeScene: null,
    transport: {
      status: TRANSPORT_STOPPED,
      masterVolume: 85,
      changedAt: safeNow(),
    },
    layers: [],
  };
}

export function createEmptySceneLibrary() {
  return {
    version: 1,
    updatedAt: safeNow(),
    scenes: [],
  };
}

export function ensureRoomState(value) {
  if (!value || typeof value !== "object") {
    return {
      version: 1,
      revision: 0,
      activeScene: null,
      transport: {
        status: TRANSPORT_STOPPED,
        masterVolume: 85,
        changedAt: 0,
      },
      layers: [],
    };
  }

  const transportStatus = value.transport?.status;
  const transport = {
    status: transportStatus === TRANSPORT_PLAYING
      ? TRANSPORT_PLAYING
      : transportStatus === TRANSPORT_PAUSED
        ? TRANSPORT_PAUSED
        : TRANSPORT_STOPPED,
    masterVolume: clamp(toNumber(value.transport?.masterVolume, 85), 0, 100),
    changedAt: Math.max(0, toNumber(value.transport?.changedAt, 0)),
  };

  return {
    version: 1,
    revision: Math.max(0, toNumber(value.revision, 0)),
    activeScene: value.activeScene && typeof value.activeScene === "object"
      ? {
          id: typeof value.activeScene.id === "string" && value.activeScene.id.trim()
            ? value.activeScene.id.trim()
            : buildStableFallbackId("scene", [value.activeScene.name || "live-mix"]),
          name: typeof value.activeScene.name === "string" && value.activeScene.name.trim()
            ? value.activeScene.name.trim()
            : "Live mix",
        }
      : null,
    transport,
    layers: Array.isArray(value.layers)
      ? value.layers.map((layer, index) => createLayer(layer, index)).filter((layer) => layer.sourceId)
      : [],
  };
}

export function buildRoomStateApplyKey(roomState) {
  return JSON.stringify(ensureRoomState(roomState));
}

export function computeLayerPosition(layer, at = safeNow()) {
  if (!layer) {
    return 0;
  }
  const pauseOffset = Math.max(
    0,
    toNumber(layer.runtime?.pauseOffsetSec, toNumber(layer.startSeconds, 0)),
  );
  if (layer.runtime?.status !== TRANSPORT_PLAYING || !layer.runtime?.playingSince) {
    return pauseOffset;
  }
  const deltaMs = Math.max(0, at - Number(layer.runtime.playingSince));
  return Math.max(0, pauseOffset + deltaMs / 1000);
}

export function stripLayerForScene(layer) {
  return {
    id: layer.id,
    title: layer.title,
    url: layer.url,
    sourceType: layer.sourceType,
    sourceId: layer.sourceId,
    origin: layer.origin,
    volume: layer.volume,
    loop: layer.loop,
    startSeconds: layer.startSeconds,
  };
}

function normalizeScene(scene, fallbackIndex = 0) {
  if (!scene || typeof scene !== "object") {
    return null;
  }
  const layers = Array.isArray(scene.layers)
    ? scene.layers
      .map((layer, index) => stripLayerForScene(createLayer(layer, index)))
      .filter((layer) => layer.sourceId)
    : [];
  if (!layers.length) {
    return null;
  }
  return {
    id: typeof scene.id === "string" && scene.id.trim()
      ? scene.id.trim()
      : buildStableFallbackId("scene", [scene.name], fallbackIndex),
    name: typeof scene.name === "string" && scene.name.trim() ? scene.name.trim() : "Untitled scene",
    updatedAt: Math.max(0, toNumber(scene.updatedAt, 0)),
    layers,
  };
}

export function ensureSceneLibrary(value) {
  if (!value || typeof value !== "object") {
    return {
      version: 1,
      updatedAt: 0,
      scenes: [],
    };
  }
  return {
    version: 1,
    updatedAt: Math.max(0, toNumber(value.updatedAt, 0)),
    scenes: Array.isArray(value.scenes)
      ? value.scenes.map((scene, index) => normalizeScene(scene, index)).filter(Boolean)
      : [],
  };
}

function isYouTubeVideoId(value) {
  return /^[A-Za-z0-9_-]{11}$/.test(value);
}

function isYouTubeListId(value) {
  return /^[A-Za-z0-9_-]{10,}$/.test(value);
}

export function parseSupportedTrackUrl(rawInput) {
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
      fallbackTitle: `Track ${maybeVideoId}`,
      warnings: [],
    };
  }

  if (!host.endsWith("youtube.com")) {
    throw new Error("Only YouTube and YouTube Music links are supported.");
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
      fallbackTitle: `Playlist ${listId}`,
      warnings: [],
    };
  }

  if (pathname === "/watch" && isYouTubeVideoId(videoId)) {
    return {
      sourceType: "video",
      sourceId: videoId,
      origin: musicHost ? "youtube-music" : "youtube",
      url: trimmed,
      fallbackTitle: `Track ${videoId}`,
      warnings: listId && musicHost
        ? ["This YouTube Music link also contains a playlist ID, so it will be treated as a single track."]
        : [],
    };
  }

  if (pathname === "/watch" && isYouTubeListId(listId)) {
    return {
      sourceType: "playlist",
      sourceId: listId,
      origin: musicHost ? "youtube-music" : "youtube",
      url: trimmed,
      fallbackTitle: `Playlist ${listId}`,
      warnings: [],
    };
  }

  if (shortsMatch && isYouTubeVideoId(shortsMatch[1])) {
    return {
      sourceType: "video",
      sourceId: shortsMatch[1],
      origin: "youtube",
      url: trimmed,
      fallbackTitle: `Track ${shortsMatch[1]}`,
      warnings: [],
    };
  }

  if (embedMatch && isYouTubeVideoId(embedMatch[1])) {
    return {
      sourceType: "video",
      sourceId: embedMatch[1],
      origin: musicHost ? "youtube-music" : "youtube",
      url: trimmed,
      fallbackTitle: `Track ${embedMatch[1]}`,
      warnings: [],
    };
  }

  throw new Error("Use a direct YouTube or YouTube Music watch/playlist link that includes a video ID or playlist ID.");
}

export function formatSourceType(layer) {
  if (layer.sourceType === "playlist") {
    return layer.origin === "youtube-music" ? "YT Music playlist" : "YouTube playlist";
  }
  return layer.origin === "youtube-music" ? "YT Music track" : "YouTube track";
}

export function summarizeTransport(roomState) {
  const state = ensureRoomState(roomState);
  if (!state.layers.length) {
    return "No active layers";
  }
  if (state.transport.status === TRANSPORT_PLAYING) {
    return `Playing ${state.layers.length} layer${state.layers.length === 1 ? "" : "s"}`;
  }
  if (state.transport.status === TRANSPORT_PAUSED) {
    return `Paused ${state.layers.length} layer${state.layers.length === 1 ? "" : "s"}`;
  }
  return `Stopped ${state.layers.length} layer${state.layers.length === 1 ? "" : "s"}`;
}

export function createClientStatus(partial = {}) {
  return {
    updatedAt: safeNow(),
    engineReady: Boolean(partial.engineReady),
    backgroundConnected: Boolean(partial.backgroundConnected),
    youtubeApiReady: Boolean(partial.youtubeApiReady),
    audioPrimed: Boolean(partial.audioPrimed),
    autoplayBlocked: Boolean(partial.autoplayBlocked),
    localOutputVolume: clamp(toNumber(partial.localOutputVolume, 100), 0, 100),
    errors: Array.isArray(partial.errors) ? partial.errors.slice(0, 8) : [],
    transportStatus: partial.transportStatus || TRANSPORT_STOPPED,
    slotCount: Math.max(0, toNumber(partial.slotCount, 0)),
    lastAction: typeof partial.lastAction === "string" ? partial.lastAction : "",
    activeLayerTitles: Array.isArray(partial.activeLayerTitles)
      ? partial.activeLayerTitles.slice(0, 8)
      : [],
  };
}
