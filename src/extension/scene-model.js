import {
  TRANSPORT_PAUSED,
  TRANSPORT_PLAYING,
  TRANSPORT_STOPPED,
  buildStableFallbackId,
  clamp,
  safeNow,
} from "./shared.js";

export const LIBRARY_PACK_VERSION = 2;
export const ROOM_RUNTIME_VERSION = 2;
export const MAX_TRACKS_PER_SCENE = 10;
export const MAX_ACTIVE_SCENES = 3;
export const DEFAULT_GLOBAL_FADE_MS = 1500;
export const DEFAULT_SCENE_COLOR = "#6b5cff";
export const LAUNCH_MODE_ADD = "add";
export const LAUNCH_MODE_REPLACE = "replace";
export const SCENE_STATUS_PLAYING = "playing";
export const SCENE_STATUS_PAUSED = "paused";
export const SCENE_STATUS_STOPPED = "stopped";
export const SCENE_STATUS_FADING_IN = "fading_in";
export const SCENE_STATUS_FADING_OUT = "fading_out";
export const TRACK_STATUS_QUEUED = "queued";
export const TRACK_STATUS_PLAYING = "playing";
export const TRACK_STATUS_PAUSED = "paused";
export const TRACK_STATUS_STOPPED = "stopped";
export const TRACK_STATUS_FADING_IN = "fading_in";
export const TRACK_STATUS_FADING_OUT = "fading_out";

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeText(value, fallback = "") {
  const text = typeof value === "string" ? value.trim() : "";
  return text || fallback;
}

function normalizePositiveInt(value, fallback = 0) {
  return Math.max(0, Math.round(toNumber(value, fallback)));
}

function normalizeSceneSourceType(value) {
  if (value?.sourceType === "youtube_music" || value?.origin === "youtube-music") {
    return "youtube_music";
  }
  if (value?.sourceType === "youtube" || value?.origin === "youtube") {
    return "youtube";
  }
  return value?.origin === "youtube-music" ? "youtube_music" : "youtube";
}

function normalizeMediaType(value) {
  if (value?.mediaType === "playlist" || value?.sourceType === "playlist") {
    return "playlist";
  }
  return "video";
}

function normalizeLaunchMode(value) {
  return value === LAUNCH_MODE_REPLACE ? LAUNCH_MODE_REPLACE : LAUNCH_MODE_ADD;
}

function normalizeTransportStatus(value) {
  if (value === TRANSPORT_PLAYING) {
    return TRANSPORT_PLAYING;
  }
  if (value === TRANSPORT_PAUSED) {
    return TRANSPORT_PAUSED;
  }
  return TRANSPORT_STOPPED;
}

function normalizeSceneStatus(value) {
  switch (value) {
    case SCENE_STATUS_PLAYING:
    case SCENE_STATUS_PAUSED:
    case SCENE_STATUS_FADING_IN:
    case SCENE_STATUS_FADING_OUT:
      return value;
    default:
      return SCENE_STATUS_STOPPED;
  }
}

function normalizeTrackStatus(value) {
  switch (value) {
    case TRACK_STATUS_PLAYING:
    case TRACK_STATUS_PAUSED:
    case TRACK_STATUS_FADING_IN:
    case TRACK_STATUS_FADING_OUT:
    case TRACK_STATUS_QUEUED:
      return value;
    default:
      return TRACK_STATUS_STOPPED;
  }
}

function normalizeOptionalStatus(value, fallback = null) {
  if (value == null || value === "") {
    return fallback;
  }
  return value;
}

export function createEmptyLibraryPack(now = safeNow()) {
  return {
    version: LIBRARY_PACK_VERSION,
    exportedAt: normalizePositiveInt(now, 0),
    scenes: [],
  };
}

export function createEmptyRoomRuntime(now = safeNow()) {
  return {
    version: ROOM_RUNTIME_VERSION,
    updatedAt: normalizePositiveInt(now, 0),
    transport: {
      status: TRANSPORT_STOPPED,
      launchMode: LAUNCH_MODE_ADD,
      masterVolume: 85,
      globalFadeMs: DEFAULT_GLOBAL_FADE_MS,
    },
    activeScenes: [],
  };
}

export function ensureSceneTrack(value, fallbackIndex = 0, sceneName = "Scene") {
  if (!value || typeof value !== "object") {
    return null;
  }
  const sourceId = normalizeText(value.sourceId);
  if (!sourceId) {
    return null;
  }
  const sourceType = normalizeSceneSourceType(value);
  const title = normalizeText(value.title, `Track ${sourceId}`);
  return {
    id: normalizeText(
      value.id,
      buildStableFallbackId(
        "scene-track",
        [sceneName, title, sourceType, sourceId],
        fallbackIndex,
      ),
    ),
    title,
    url: normalizeText(value.url),
    sourceType,
    mediaType: normalizeMediaType(value),
    sourceId,
    order: normalizePositiveInt(value.order, fallbackIndex),
    volume: clamp(toNumber(value.volume, 100), 0, 100),
    loop: Boolean(value.loop),
    startDelayMs: normalizePositiveInt(value.startDelayMs ?? value.startDelay, 0),
    startOffsetSec: Math.max(
      0,
      toNumber(value.startOffsetSec ?? value.startSeconds ?? value.startOffset, 0),
    ),
    fadeInMs: normalizePositiveInt(value.fadeInMs, DEFAULT_GLOBAL_FADE_MS),
    fadeOutMs: normalizePositiveInt(value.fadeOutMs, DEFAULT_GLOBAL_FADE_MS),
  };
}

export function ensureScene(value, fallbackIndex = 0) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const sceneName = normalizeText(value.name, "Untitled scene");
  const rawTracks = Array.isArray(value.tracks)
    ? value.tracks
    : Array.isArray(value.layers)
      ? value.layers
      : [];
  const tracks = rawTracks
    .map((track, index) => ensureSceneTrack(track, index, sceneName))
    .filter(Boolean)
    .sort((left, right) => left.order - right.order || left.title.localeCompare(right.title))
    .slice(0, MAX_TRACKS_PER_SCENE)
    .map((track, index) => ({
      ...track,
      order: index,
    }));

  return {
    id: normalizeText(
      value.id,
      buildStableFallbackId("scene", [sceneName], fallbackIndex),
    ),
    name: sceneName,
    color: normalizeText(value.color, DEFAULT_SCENE_COLOR),
    order: normalizePositiveInt(value.order, fallbackIndex),
    volume: clamp(toNumber(value.volume, 100), 0, 100),
    loop: Boolean(value.loop),
    updatedAt: normalizePositiveInt(value.updatedAt, 0),
    tracks,
  };
}

function ensureActiveTrack(value, fallbackIndex = 0) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const sourceId = normalizeText(value.sourceId);
  if (!sourceId) {
    return null;
  }
  return {
    trackId: normalizeText(
      value.trackId ?? value.id,
      buildStableFallbackId(
        "active-track",
        [value.title, value.sourceType, sourceId],
        fallbackIndex,
      ),
    ),
    title: normalizeText(value.title, `Track ${sourceId}`),
    sourceType: normalizeSceneSourceType(value),
    mediaType: normalizeMediaType(value),
    sourceId,
    volume: clamp(toNumber(value.volume, 100), 0, 100),
    loop: Boolean(value.loop),
    startDelayMs: normalizePositiveInt(value.startDelayMs, 0),
    startOffsetSec: Math.max(0, toNumber(value.startOffsetSec, 0)),
    fadeInMs: normalizePositiveInt(value.fadeInMs, DEFAULT_GLOBAL_FADE_MS),
    fadeOutMs: normalizePositiveInt(value.fadeOutMs, DEFAULT_GLOBAL_FADE_MS),
    effectiveOrder: normalizePositiveInt(value.effectiveOrder ?? value.order, fallbackIndex),
    activationScenePositionMs: normalizePositiveInt(value.activationScenePositionMs, 0),
    status: normalizeTrackStatus(value.status),
    nextStatus: normalizeOptionalStatus(value.nextStatus),
    fadeStartedAt: normalizePositiveInt(value.fadeStartedAt, 0),
    fadeEndsAt: normalizePositiveInt(value.fadeEndsAt, 0),
  };
}

function ensureActiveScene(value, fallbackIndex = 0) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const sceneName = normalizeText(value.name, "Active scene");
  return {
    sceneId: normalizeText(
      value.sceneId ?? value.id,
      buildStableFallbackId("active-scene", [sceneName], fallbackIndex),
    ),
    name: sceneName,
    color: normalizeText(value.color, DEFAULT_SCENE_COLOR),
    order: normalizePositiveInt(value.order, fallbackIndex),
    sceneVolume: clamp(toNumber(value.sceneVolume ?? value.volume, 100), 0, 100),
    loop: Boolean(value.loop),
    status: normalizeSceneStatus(value.status),
    nextStatus: normalizeOptionalStatus(value.nextStatus),
    positionMs: normalizePositiveInt(value.positionMs, 0),
    startedAt: normalizePositiveInt(value.startedAt, 0),
    pausedAt: normalizePositiveInt(value.pausedAt, 0),
    fadeStartedAt: normalizePositiveInt(value.fadeStartedAt, 0),
    fadeEndsAt: normalizePositiveInt(value.fadeEndsAt, 0),
    tracks: Array.isArray(value.tracks)
      ? value.tracks
        .map((track, index) => ensureActiveTrack(track, index))
        .filter(Boolean)
        .sort((left, right) => left.effectiveOrder - right.effectiveOrder || left.title.localeCompare(right.title))
        .slice(0, MAX_TRACKS_PER_SCENE)
      : [],
  };
}

export function ensureLibraryPack(value) {
  if (!value || typeof value !== "object") {
    return createEmptyLibraryPack(0);
  }
  const scenes = Array.isArray(value.scenes)
    ? value.scenes
      .map((scene, index) => ensureScene(scene, index))
      .filter(Boolean)
      .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name))
      .map((scene, index) => ({
        ...scene,
        order: index,
      }))
    : [];

  return {
    version: LIBRARY_PACK_VERSION,
    exportedAt: normalizePositiveInt(value.exportedAt, 0),
    scenes,
  };
}

export function ensureRoomRuntime(value) {
  if (!value || typeof value !== "object") {
    return createEmptyRoomRuntime(0);
  }
  const activeScenes = Array.isArray(value.activeScenes)
    ? value.activeScenes
      .map((scene, index) => ensureActiveScene(scene, index))
      .filter(Boolean)
      .slice(0, MAX_ACTIVE_SCENES)
    : [];

  return {
    version: ROOM_RUNTIME_VERSION,
    updatedAt: normalizePositiveInt(value.updatedAt, 0),
    transport: {
      status: normalizeTransportStatus(value.transport?.status),
      launchMode: normalizeLaunchMode(value.transport?.launchMode),
      masterVolume: clamp(toNumber(value.transport?.masterVolume, 85), 0, 100),
      globalFadeMs: normalizePositiveInt(value.transport?.globalFadeMs, DEFAULT_GLOBAL_FADE_MS) || DEFAULT_GLOBAL_FADE_MS,
    },
    activeScenes,
  };
}

export function exportLibraryPack(libraryPack, now = safeNow()) {
  const normalized = ensureLibraryPack({
    ...libraryPack,
    exportedAt: normalizePositiveInt(now, 0),
  });
  return JSON.stringify(normalized, null, 2);
}

export function importLibraryPack(rawValue) {
  if (typeof rawValue === "string") {
    let parsed;
    try {
      parsed = JSON.parse(rawValue);
    } catch {
      throw new Error("Library file is not valid JSON.");
    }
    return ensureLibraryPack(parsed);
  }
  return ensureLibraryPack(rawValue);
}

export function replaceLibraryAndStopRuntime(rawValue, runtime, now = safeNow()) {
  const nextLibrary = importLibraryPack(rawValue);
  const currentRuntime = ensureRoomRuntime(runtime);
  return {
    library: nextLibrary,
    runtime: {
      version: ROOM_RUNTIME_VERSION,
      updatedAt: normalizePositiveInt(now, 0),
      transport: {
        ...currentRuntime.transport,
        status: TRANSPORT_STOPPED,
      },
      activeScenes: [],
    },
  };
}

export function computeEffectiveTrackVolume({
  masterVolume = 100,
  sceneVolume = 100,
  trackVolume = 100,
  localPlayerVolume = 100,
} = {}) {
  return clamp(
    (toNumber(masterVolume, 100)
      * toNumber(sceneVolume, 100)
      * toNumber(trackVolume, 100)
      * toNumber(localPlayerVolume, 100)) / 1000000,
    0,
    100,
  );
}
