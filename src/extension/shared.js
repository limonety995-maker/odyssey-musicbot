export const EXTENSION_ID = "com.limon.dnd.sync-music";
export const ROOM_STATE_KEY = `${EXTENSION_ID}/room-state`;
export const CLIENT_STATUS_KEY = `${EXTENSION_ID}/client-status`;
export const BROADCAST_CHANNEL = `${EXTENSION_ID}/room-state`;
export const LOCAL_CONTROL_CHANNEL = `${EXTENSION_ID}/local-control`;
export const HELPER_URL_STORAGE_KEY = `${EXTENSION_ID}/helper-url`;

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

function toNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function createLayer(source = {}) {
  const startSeconds = Math.max(0, toNumber(source.startSeconds, 0));
  const sourceType = source.sourceType === "playlist" ? "playlist" : "video";
  return {
    id: typeof source.id === "string" && source.id.trim() ? source.id.trim() : makeId("layer"),
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

export function ensureRoomState(value) {
  const base = createEmptyRoomState();
  if (!value || typeof value !== "object") {
    return base;
  }

  const transportStatus = value.transport?.status;
  const transport = {
    status: transportStatus === TRANSPORT_PLAYING
      ? TRANSPORT_PLAYING
      : transportStatus === TRANSPORT_PAUSED
        ? TRANSPORT_PAUSED
        : TRANSPORT_STOPPED,
    masterVolume: clamp(toNumber(value.transport?.masterVolume, 85), 0, 100),
    changedAt: Math.max(0, toNumber(value.transport?.changedAt, safeNow())),
  };

  return {
    version: 1,
    revision: Math.max(0, toNumber(value.revision, 0)),
    activeScene: value.activeScene && typeof value.activeScene === "object"
      ? {
          id: typeof value.activeScene.id === "string" ? value.activeScene.id : makeId("scene"),
          name: typeof value.activeScene.name === "string" && value.activeScene.name.trim()
            ? value.activeScene.name.trim()
            : "Live mix",
        }
      : null,
    transport,
    layers: Array.isArray(value.layers)
      ? value.layers.map(createLayer).filter((layer) => layer.sourceId)
      : [],
  };
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
    autoplayBlocked: Boolean(partial.autoplayBlocked),
    errors: Array.isArray(partial.errors) ? partial.errors.slice(0, 8) : [],
    transportStatus: partial.transportStatus || TRANSPORT_STOPPED,
    slotCount: Math.max(0, toNumber(partial.slotCount, 0)),
    lastAction: typeof partial.lastAction === "string" ? partial.lastAction : "",
    activeLayerTitles: Array.isArray(partial.activeLayerTitles)
      ? partial.activeLayerTitles.slice(0, 8)
      : [],
  };
}
