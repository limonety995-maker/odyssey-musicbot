import {
  TRANSPORT_PAUSED,
  TRANSPORT_PLAYING,
  TRANSPORT_STOPPED,
  buildStableFallbackId,
  safeNow,
} from "./shared.js";
import {
  DEFAULT_SCENE_COLOR,
  TRACK_STATUS_STOPPED,
  ensureLibraryPack,
  ensureScene,
  ensureSceneTrack,
  ensureRoomRuntime,
} from "./scene-model.js";
import { buildPlaybackSlotId } from "./scene-playback.js";

export const LIVE_SCENE_ID = "scene-live-mix";
export const LIVE_SCENE_NAME = "Live mix";

function clone(value) {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function mapOrigin(sourceType) {
  return sourceType === "youtube_music" ? "youtube-music" : "youtube";
}

function mapMediaType(track) {
  return track?.mediaType === "playlist" ? "playlist" : "video";
}

function mapLegacyTrackStatus(scene, track) {
  const sceneStatus = scene?.status || TRANSPORT_STOPPED;
  const trackStatus = track?.status || TRANSPORT_STOPPED;

  if (sceneStatus === "paused" || trackStatus === "paused") {
    return TRANSPORT_PAUSED;
  }
  if (trackStatus === "queued" || trackStatus === "fading_in" || trackStatus === "playing") {
    return TRANSPORT_PLAYING;
  }
  if (sceneStatus === "fading_in" || sceneStatus === "playing") {
    return TRANSPORT_PLAYING;
  }
  if (sceneStatus === "fading_out" && scene?.nextStatus === "paused") {
    return TRANSPORT_PAUSED;
  }
  return TRANSPORT_STOPPED;
}

function toLegacyLayer(track, scene, fallbackIndex = 0) {
  return {
    id: buildPlaybackSlotId(scene.sceneId || scene.id, track.trackId || track.id),
    sceneId: scene.sceneId || scene.id,
    trackId: track.trackId || track.id,
    title: track.title,
    url: track.url || "",
    sourceType: mapMediaType(track),
    sourceId: track.sourceId,
    origin: mapOrigin(track.sourceType),
    volume: track.volume,
    loop: track.loop,
    startSeconds: track.startOffsetSec || 0,
    order: Number.isFinite(track.effectiveOrder) ? track.effectiveOrder : fallbackIndex,
    runtime: {
      status: mapLegacyTrackStatus(scene, track),
      pauseOffsetSec: Math.max(0, Number(track.startOffsetSec) || 0),
      playingSince: Number.isFinite(scene.startedAt) && scene.startedAt > 0 ? scene.startedAt : null,
      playlistIndex: 0,
      playlistVideoId: null,
      cycle: 0,
      lastSyncAt: Number.isFinite(scene.startedAt) ? scene.startedAt : 0,
    },
  };
}

export function isLiveSceneId(sceneId) {
  return sceneId === LIVE_SCENE_ID;
}

export function ensureLiveSceneInLibrary(library, now = safeNow()) {
  const normalized = clone(ensureLibraryPack(library));
  if (normalized.scenes.some((scene) => scene.id === LIVE_SCENE_ID)) {
    return normalized;
  }
  const liveScene = ensureScene({
    id: LIVE_SCENE_ID,
    name: LIVE_SCENE_NAME,
    color: DEFAULT_SCENE_COLOR,
    order: -1,
    volume: 100,
    loop: false,
    updatedAt: now,
    tracks: [],
  }, 0);
  normalized.scenes.unshift(liveScene);
  normalized.scenes = normalized.scenes.map((scene, index) => ({
    ...scene,
    order: scene.id === LIVE_SCENE_ID ? -1 : index - 1,
  }));
  normalized.exportedAt = now;
  return normalized;
}

export function getLiveScene(library) {
  return ensureLiveSceneInLibrary(library).scenes.find((scene) => scene.id === LIVE_SCENE_ID) || null;
}

export function stripLiveSceneFromLibrary(library) {
  const normalized = ensureLiveSceneInLibrary(library);
  return {
    ...normalized,
    scenes: normalized.scenes
      .filter((scene) => scene.id !== LIVE_SCENE_ID)
      .map((scene, index) => ({
        ...scene,
        order: index,
      })),
  };
}

export function createSceneTrackFromParsedTrack(track, now = safeNow()) {
  return ensureSceneTrack({
    id: buildStableFallbackId(
      "scene-track",
      [track.title, track.origin, track.sourceType, track.sourceId, now],
      0,
    ),
    title: track.title,
    url: track.url,
    sourceType: track.origin === "youtube-music" ? "youtube_music" : "youtube",
    mediaType: track.sourceType === "playlist" ? "playlist" : "video",
    sourceId: track.sourceId,
    volume: track.volume ?? 100,
    loop: Boolean(track.loop),
    startDelayMs: track.startDelayMs ?? 0,
    startOffsetSec: track.startOffsetSec ?? track.startSeconds ?? 0,
    fadeInMs: track.fadeInMs,
    fadeOutMs: track.fadeOutMs,
  }, 0, LIVE_SCENE_NAME);
}

export function buildLegacyLibraryView(library) {
  const normalized = stripLiveSceneFromLibrary(library);
  return {
    version: 1,
    updatedAt: normalized.exportedAt,
    scenes: normalized.scenes.map((scene) => ({
      id: scene.id,
      name: scene.name,
      updatedAt: scene.updatedAt,
      layers: scene.tracks.map((track, index) => ({
        id: track.id,
        title: track.title,
        url: track.url,
        sourceType: mapMediaType(track),
        sourceId: track.sourceId,
        origin: mapOrigin(track.sourceType),
        volume: track.volume,
        loop: track.loop,
        startSeconds: track.startOffsetSec,
        order: Number.isFinite(track.order) ? track.order : index,
      })),
    })),
  };
}

export function buildLegacyRoomStateView(runtime, library) {
  const normalizedRuntime = ensureRoomRuntime(runtime);
  const normalizedLibrary = ensureLiveSceneInLibrary(library);
  const activeScenes = normalizedRuntime.activeScenes
    .slice()
    .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name));

  let layers = [];
  let activeScene = null;

  if (activeScenes.length) {
    layers = activeScenes.flatMap((scene) => scene.tracks
      .slice()
      .sort((left, right) => left.effectiveOrder - right.effectiveOrder || left.title.localeCompare(right.title))
      .map((track, index) => toLegacyLayer(track, scene, index)));
    activeScene = activeScenes.length === 1
      ? {
          id: activeScenes[0].sceneId,
          name: activeScenes[0].name,
        }
      : {
          id: "active-scenes",
          name: `${activeScenes.length} scenes active`,
        };
  } else {
    const liveScene = getLiveScene(normalizedLibrary);
    if (liveScene) {
      layers = liveScene.tracks.map((track, index) => toLegacyLayer(
        {
          ...track,
          trackId: track.id,
          effectiveOrder: track.order,
          status: TRACK_STATUS_STOPPED,
        },
        {
          sceneId: liveScene.id,
          name: liveScene.name,
          startedAt: 0,
          status: TRANSPORT_STOPPED,
        },
        index,
      ));
      activeScene = {
        id: liveScene.id,
        name: liveScene.name,
      };
    }
  }

  return {
    version: 1,
    revision: normalizedRuntime.updatedAt || 0,
    activeScene,
    transport: {
      status: normalizedRuntime.transport.status,
      masterVolume: normalizedRuntime.transport.masterVolume,
      changedAt: normalizedRuntime.updatedAt || 0,
    },
    layers,
  };
}

export function findTrackReference(runtime, library, slotId) {
  const normalizedRuntime = ensureRoomRuntime(runtime);
  for (const scene of normalizedRuntime.activeScenes) {
    for (const track of scene.tracks) {
      if (buildPlaybackSlotId(scene.sceneId, track.trackId) === slotId) {
        return {
          sceneId: scene.sceneId,
          trackId: track.trackId,
          fromRuntime: true,
        };
      }
    }
  }

  const liveScene = getLiveScene(library);
  for (const track of liveScene?.tracks || []) {
    if (buildPlaybackSlotId(LIVE_SCENE_ID, track.id) === slotId) {
      return {
        sceneId: LIVE_SCENE_ID,
        trackId: track.id,
        fromRuntime: false,
      };
    }
  }

  return null;
}

export function collectCurrentMixTracks(runtime, library) {
  const normalizedRuntime = ensureRoomRuntime(runtime);
  if (!normalizedRuntime.activeScenes.length) {
    return clone(getLiveScene(library)?.tracks || []);
  }

  return normalizedRuntime.activeScenes
    .slice()
    .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name))
    .flatMap((scene) => scene.tracks
      .slice()
      .sort((left, right) => left.effectiveOrder - right.effectiveOrder || left.title.localeCompare(right.title))
      .map((track, index) => ensureSceneTrack({
        id: buildStableFallbackId("scene-track", [scene.name, track.title, track.sourceId], index),
        title: track.title,
        url: track.url || "",
        sourceType: track.sourceType,
        mediaType: track.mediaType,
        sourceId: track.sourceId,
        order: index,
        volume: track.volume,
        loop: track.loop,
        startDelayMs: track.startDelayMs,
        startOffsetSec: track.startOffsetSec,
        fadeInMs: track.fadeInMs,
        fadeOutMs: track.fadeOutMs,
      }, index, scene.name)))
    .filter(Boolean);
}

export function upsertLibraryScene({
  library,
  sceneId = null,
  name,
  color = DEFAULT_SCENE_COLOR,
  volume = 100,
  loop = false,
  tracks = [],
  now = safeNow(),
} = {}) {
  const normalized = ensureLiveSceneInLibrary(library);
  const nextScene = ensureScene({
    id: sceneId || buildStableFallbackId("scene", [name, now], normalized.scenes.length),
    name,
    color,
    volume,
    loop,
    updatedAt: now,
    tracks,
  }, normalized.scenes.length);
  if (!nextScene) {
    throw new Error("Could not save scene.");
  }

  const filteredScenes = normalized.scenes.filter((scene) => scene.id !== nextScene.id);
  filteredScenes.push(nextScene);

  const liveScene = filteredScenes.find((scene) => scene.id === LIVE_SCENE_ID) || null;
  const regularScenes = filteredScenes
    .filter((scene) => scene.id !== LIVE_SCENE_ID)
    .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name))
    .map((scene, index) => ({
      ...scene,
      order: index,
    }));

  return {
    ...normalized,
    exportedAt: now,
    scenes: liveScene ? [liveScene, ...regularScenes] : regularScenes,
  };
}
