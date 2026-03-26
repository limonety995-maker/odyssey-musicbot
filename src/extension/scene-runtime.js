import {
  TRANSPORT_PAUSED,
  TRANSPORT_PLAYING,
  TRANSPORT_STOPPED,
  deepClone,
  makeId,
  safeNow,
} from "./shared.js";
import {
  DEFAULT_GLOBAL_FADE_MS,
  LAUNCH_MODE_ADD,
  LAUNCH_MODE_REPLACE,
  MAX_ACTIVE_SCENES,
  MAX_TRACKS_PER_SCENE,
  SCENE_STATUS_FADING_IN,
  SCENE_STATUS_FADING_OUT,
  SCENE_STATUS_PAUSED,
  SCENE_STATUS_PLAYING,
  SCENE_STATUS_STOPPED,
  TRACK_STATUS_FADING_IN,
  TRACK_STATUS_FADING_OUT,
  TRACK_STATUS_PAUSED,
  TRACK_STATUS_PLAYING,
  TRACK_STATUS_QUEUED,
  TRACK_STATUS_STOPPED,
  ensureLibraryPack,
  ensureRoomRuntime,
  ensureScene,
  ensureSceneTrack,
} from "./scene-model.js";

function cloneRuntime(runtime) {
  return deepClone(ensureRoomRuntime(runtime));
}

function cloneLibrary(library) {
  return deepClone(ensureLibraryPack(library));
}

function normalizeFadeMs(runtime) {
  return Math.max(1, Number(runtime.transport?.globalFadeMs) || DEFAULT_GLOBAL_FADE_MS);
}

function setTransportStatus(runtime, now = safeNow()) {
  const activeScenes = runtime.activeScenes.filter((scene) => scene.status !== SCENE_STATUS_STOPPED);
  if (!activeScenes.length) {
    runtime.transport.status = TRANSPORT_STOPPED;
    runtime.updatedAt = now;
    return runtime;
  }

  const anyScenePlaying = activeScenes.some((scene) => (
    scene.status === SCENE_STATUS_PLAYING
    || scene.status === SCENE_STATUS_FADING_IN
    || (scene.status === SCENE_STATUS_FADING_OUT && scene.nextStatus !== SCENE_STATUS_PAUSED)
  ));

  runtime.transport.status = anyScenePlaying ? TRANSPORT_PLAYING : TRANSPORT_PAUSED;
  runtime.updatedAt = now;
  return runtime;
}

function findSceneOrThrow(library, sceneId) {
  const scene = library.scenes.find((entry) => entry.id === sceneId);
  if (!scene) {
    throw new Error("Scene not found in library.");
  }
  return scene;
}

function findActiveScene(runtime, sceneId) {
  return runtime.activeScenes.find((scene) => scene.sceneId === sceneId);
}

function computeTrackBaseStatus(track) {
  return track.startDelayMs > 0 ? TRACK_STATUS_QUEUED : TRACK_STATUS_FADING_IN;
}

function createActiveTrack(sceneTrack, effectiveOrder, activationScenePositionMs, now, fadeMs, forcePaused = false) {
  const status = forcePaused
    ? TRACK_STATUS_PAUSED
    : computeTrackBaseStatus(sceneTrack);
  const nextStatus = forcePaused ? null : TRACK_STATUS_PLAYING;

  return {
    id: makeId("active-track-instance"),
    trackId: sceneTrack.id,
    title: sceneTrack.title,
    sourceType: sceneTrack.sourceType,
    mediaType: sceneTrack.mediaType,
    sourceId: sceneTrack.sourceId,
    volume: sceneTrack.volume,
    loop: sceneTrack.loop,
    startDelayMs: sceneTrack.startDelayMs,
    startOffsetSec: sceneTrack.startOffsetSec,
    fadeInMs: sceneTrack.fadeInMs,
    fadeOutMs: sceneTrack.fadeOutMs,
    effectiveOrder,
    activationScenePositionMs,
    status,
    nextStatus,
    fadeStartedAt: status === TRACK_STATUS_FADING_IN ? now : 0,
    fadeEndsAt: status === TRACK_STATUS_FADING_IN ? now + Math.max(1, sceneTrack.fadeInMs || fadeMs) : 0,
  };
}

function createActiveScene(scene, now, fadeMs) {
  return {
    sceneId: scene.id,
    name: scene.name,
    color: scene.color,
    order: scene.order,
    sceneVolume: scene.volume,
    loop: scene.loop,
    status: SCENE_STATUS_FADING_IN,
    nextStatus: SCENE_STATUS_PLAYING,
    positionMs: 0,
    startedAt: now,
    pausedAt: 0,
    fadeStartedAt: now,
    fadeEndsAt: now + fadeMs,
    tracks: scene.tracks.map((track, index) => createActiveTrack(track, index, 0, now, fadeMs)),
  };
}

function freezeScenePosition(scene, now) {
  scene.positionMs = computeSceneTimelinePosition(scene, now);
  scene.startedAt = 0;
  scene.pausedAt = now;
}

function markSceneTransition(scene, status, nextStatus, now, fadeMs) {
  scene.status = status;
  scene.nextStatus = nextStatus;
  scene.fadeStartedAt = now;
  scene.fadeEndsAt = now + Math.max(1, fadeMs);
}

function markTracksForSceneTransition(scene, status, nextStatus, now, fadeMs) {
  for (const track of scene.tracks) {
    if (status === TRACK_STATUS_STOPPED) {
      track.status = TRACK_STATUS_STOPPED;
      track.nextStatus = null;
      track.fadeStartedAt = 0;
      track.fadeEndsAt = 0;
      continue;
    }
    track.status = status;
    track.nextStatus = nextStatus;
    track.fadeStartedAt = now;
    track.fadeEndsAt = now + Math.max(1, fadeMs);
  }
}

function normalizeTrackOrder(tracks) {
  return tracks
    .slice()
    .sort((left, right) => left.effectiveOrder - right.effectiveOrder || left.title.localeCompare(right.title))
    .map((track, index) => ({
      ...track,
      effectiveOrder: index,
    }));
}

export function computeSceneTimelinePosition(sceneRuntime, now = safeNow()) {
  const scene = sceneRuntime || {};
  const basePosition = Math.max(0, Number(scene.positionMs) || 0);
  const startedAt = Math.max(0, Number(scene.startedAt) || 0);
  if (!startedAt) {
    return basePosition;
  }
  return Math.max(0, basePosition + (Math.max(now, startedAt) - startedAt));
}

export function computeTrackPlayheadMs(sceneRuntime, trackRuntime, now = safeNow()) {
  const scenePositionMs = computeSceneTimelinePosition(sceneRuntime, now);
  const activationScenePositionMs = Math.max(0, Number(trackRuntime?.activationScenePositionMs) || 0);
  const startDelayMs = Math.max(0, Number(trackRuntime?.startDelayMs) || 0);
  const startOffsetMs = Math.max(0, Number(trackRuntime?.startOffsetSec) || 0) * 1000;
  if (scenePositionMs < activationScenePositionMs + startDelayMs) {
    return 0;
  }
  return Math.max(0, scenePositionMs - activationScenePositionMs - startDelayMs + startOffsetMs);
}

export function isTrackReadyToStart(sceneRuntime, trackRuntime, now = safeNow()) {
  const scenePositionMs = computeSceneTimelinePosition(sceneRuntime, now);
  const boundaryMs = Math.max(0, Number(trackRuntime?.activationScenePositionMs) || 0)
    + Math.max(0, Number(trackRuntime?.startDelayMs) || 0);
  return scenePositionMs >= boundaryMs;
}

export function countActiveScenes(runtime) {
  return ensureRoomRuntime(runtime).activeScenes.length;
}

export function computeCurrentSceneLabel(runtime) {
  const normalizedRuntime = ensureRoomRuntime(runtime);
  if (!normalizedRuntime.activeScenes.length) {
    return "No active scenes";
  }
  if (normalizedRuntime.activeScenes.length === 1) {
    return normalizedRuntime.activeScenes[0].name;
  }
  return `${normalizedRuntime.activeScenes.length} scenes active`;
}

export function finalizeRuntimeTransitions(runtime, now = safeNow()) {
  const nextRuntime = cloneRuntime(runtime);

  nextRuntime.activeScenes = nextRuntime.activeScenes.flatMap((scene) => {
    if (scene.fadeEndsAt && scene.fadeEndsAt <= now && scene.nextStatus) {
      scene.status = scene.nextStatus;
      scene.nextStatus = null;
      scene.fadeStartedAt = 0;
      scene.fadeEndsAt = 0;
    }

    scene.tracks = scene.tracks.flatMap((track) => {
      if (track.fadeEndsAt && track.fadeEndsAt <= now && track.nextStatus) {
        track.status = track.nextStatus;
        track.nextStatus = null;
        track.fadeStartedAt = 0;
        track.fadeEndsAt = 0;
      }
      return track.status === TRACK_STATUS_STOPPED ? [] : [track];
    });

    if (scene.status === SCENE_STATUS_STOPPED) {
      return [];
    }
    return [scene];
  });

  return setTransportStatus(nextRuntime, now);
}

export function setLaunchMode(runtime, mode, now = safeNow()) {
  const nextRuntime = cloneRuntime(runtime);
  nextRuntime.transport.launchMode = mode === LAUNCH_MODE_REPLACE ? LAUNCH_MODE_REPLACE : LAUNCH_MODE_ADD;
  return setTransportStatus(nextRuntime, now);
}

export function setMasterVolume(runtime, volume, now = safeNow()) {
  const nextRuntime = cloneRuntime(runtime);
  nextRuntime.transport.masterVolume = Math.max(0, Math.min(100, Number(volume) || 0));
  return setTransportStatus(nextRuntime, now);
}

export function launchScene({
  library,
  runtime,
  sceneId,
  mode = null,
  now = safeNow(),
} = {}) {
  const nextLibrary = ensureLibraryPack(library);
  const nextRuntime = finalizeRuntimeTransitions(runtime, now);
  const scene = findSceneOrThrow(nextLibrary, sceneId);
  const launchMode = mode || nextRuntime.transport.launchMode || LAUNCH_MODE_ADD;
  const fadeMs = normalizeFadeMs(nextRuntime);

  if (findActiveScene(nextRuntime, sceneId)) {
    throw new Error("This scene is already active.");
  }

  if (launchMode === LAUNCH_MODE_ADD && nextRuntime.activeScenes.length >= MAX_ACTIVE_SCENES) {
    throw new Error(`Only ${MAX_ACTIVE_SCENES} scenes can be active at the same time.`);
  }

  if (launchMode === LAUNCH_MODE_REPLACE) {
    for (const activeScene of nextRuntime.activeScenes) {
      freezeScenePosition(activeScene, now);
      markSceneTransition(activeScene, SCENE_STATUS_FADING_OUT, SCENE_STATUS_STOPPED, now, fadeMs);
      markTracksForSceneTransition(activeScene, TRACK_STATUS_FADING_OUT, TRACK_STATUS_STOPPED, now, fadeMs);
    }
  }

  nextRuntime.activeScenes.push(createActiveScene(scene, now, fadeMs));
  return setTransportStatus(nextRuntime, now);
}

export function pauseScene(runtime, sceneId, now = safeNow()) {
  const nextRuntime = cloneRuntime(runtime);
  const scene = findActiveScene(nextRuntime, sceneId);
  if (!scene) {
    return nextRuntime;
  }
  const fadeMs = normalizeFadeMs(nextRuntime);
  freezeScenePosition(scene, now);
  markSceneTransition(scene, SCENE_STATUS_FADING_OUT, SCENE_STATUS_PAUSED, now, fadeMs);
  markTracksForSceneTransition(scene, TRACK_STATUS_FADING_OUT, TRACK_STATUS_PAUSED, now, fadeMs);
  return setTransportStatus(nextRuntime, now);
}

export function resumeScene(runtime, sceneId, now = safeNow()) {
  const nextRuntime = cloneRuntime(runtime);
  const scene = findActiveScene(nextRuntime, sceneId);
  if (!scene) {
    return nextRuntime;
  }
  const fadeMs = normalizeFadeMs(nextRuntime);
  scene.startedAt = now;
  scene.pausedAt = 0;
  markSceneTransition(scene, SCENE_STATUS_FADING_IN, SCENE_STATUS_PLAYING, now, fadeMs);
  for (const track of scene.tracks) {
    const ready = isTrackReadyToStart(scene, track, now);
    track.status = ready ? TRACK_STATUS_FADING_IN : TRACK_STATUS_QUEUED;
    track.nextStatus = TRACK_STATUS_PLAYING;
    track.fadeStartedAt = ready ? now : 0;
    track.fadeEndsAt = ready ? now + Math.max(1, track.fadeInMs || fadeMs) : 0;
  }
  return setTransportStatus(nextRuntime, now);
}

export function pressSceneFolder({
  library,
  runtime,
  sceneId,
  now = safeNow(),
} = {}) {
  const nextRuntime = finalizeRuntimeTransitions(runtime, now);
  const activeScene = findActiveScene(nextRuntime, sceneId);
  if (!activeScene) {
    return launchScene({ library, runtime: nextRuntime, sceneId, mode: nextRuntime.transport.launchMode, now });
  }

  const pausedState = activeScene.status === SCENE_STATUS_PAUSED
    || (activeScene.status === SCENE_STATUS_FADING_OUT && activeScene.nextStatus === SCENE_STATUS_PAUSED);

  return pausedState
    ? resumeScene(nextRuntime, sceneId, now)
    : pauseScene(nextRuntime, sceneId, now);
}

export function pauseAllScenes(runtime, now = safeNow()) {
  const nextRuntime = cloneRuntime(runtime);
  const fadeMs = normalizeFadeMs(nextRuntime);
  for (const scene of nextRuntime.activeScenes) {
    freezeScenePosition(scene, now);
    markSceneTransition(scene, SCENE_STATUS_FADING_OUT, SCENE_STATUS_PAUSED, now, fadeMs);
    markTracksForSceneTransition(scene, TRACK_STATUS_FADING_OUT, TRACK_STATUS_PAUSED, now, fadeMs);
  }
  return setTransportStatus(nextRuntime, now);
}

export function resumeAllScenes(runtime, now = safeNow()) {
  const nextRuntime = cloneRuntime(runtime);
  const fadeMs = normalizeFadeMs(nextRuntime);
  for (const scene of nextRuntime.activeScenes) {
    scene.startedAt = now;
    scene.pausedAt = 0;
    markSceneTransition(scene, SCENE_STATUS_FADING_IN, SCENE_STATUS_PLAYING, now, fadeMs);
    for (const track of scene.tracks) {
      const ready = isTrackReadyToStart(scene, track, now);
      track.status = ready ? TRACK_STATUS_FADING_IN : TRACK_STATUS_QUEUED;
      track.nextStatus = TRACK_STATUS_PLAYING;
      track.fadeStartedAt = ready ? now : 0;
      track.fadeEndsAt = ready ? now + Math.max(1, track.fadeInMs || fadeMs) : 0;
    }
  }
  return setTransportStatus(nextRuntime, now);
}

export function stopAllScenes(runtime, now = safeNow()) {
  const nextRuntime = cloneRuntime(runtime);
  const fadeMs = normalizeFadeMs(nextRuntime);
  for (const scene of nextRuntime.activeScenes) {
    freezeScenePosition(scene, now);
    markSceneTransition(scene, SCENE_STATUS_FADING_OUT, SCENE_STATUS_STOPPED, now, fadeMs);
    markTracksForSceneTransition(scene, TRACK_STATUS_FADING_OUT, TRACK_STATUS_STOPPED, now, fadeMs);
  }
  return setTransportStatus(nextRuntime, now);
}

function updateActiveSceneFromLibrary(activeScene, libraryScene) {
  activeScene.name = libraryScene.name;
  activeScene.color = libraryScene.color;
  activeScene.order = libraryScene.order;
}

export function createSceneInLibrary({
  library,
  name,
  color,
  volume = 100,
  loop = false,
  tracks = [],
  now = safeNow(),
} = {}) {
  const nextLibrary = cloneLibrary(library);
  const nextScene = ensureScene({
    id: makeId("scene"),
    name,
    color,
    volume,
    loop,
    updatedAt: now,
    tracks,
  }, nextLibrary.scenes.length);

  if (!nextScene) {
    throw new Error("Could not create scene.");
  }

  nextLibrary.scenes.push(nextScene);
  nextLibrary.scenes = nextLibrary.scenes
    .slice()
    .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name))
    .map((scene, index) => ({
      ...scene,
      order: index,
    }));
  nextLibrary.exportedAt = now;
  return nextLibrary;
}

export function deleteSceneFromLibrary({
  library,
  runtime,
  sceneId,
  now = safeNow(),
} = {}) {
  const nextLibrary = cloneLibrary(library);
  const nextRuntime = cloneRuntime(runtime);
  const nextScenes = nextLibrary.scenes.filter((scene) => scene.id !== sceneId);
  if (nextScenes.length === nextLibrary.scenes.length) {
    return {
      library: nextLibrary,
      runtime: setTransportStatus(nextRuntime, now),
    };
  }

  nextLibrary.scenes = nextScenes.map((scene, index) => ({
    ...scene,
    order: index,
  }));
  nextLibrary.exportedAt = now;
  nextRuntime.activeScenes = nextRuntime.activeScenes.filter((scene) => scene.sceneId !== sceneId);

  return {
    library: nextLibrary,
    runtime: setTransportStatus(nextRuntime, now),
  };
}

export function reorderLibraryScenes({
  library,
  runtime,
  orderedSceneIds = [],
  now = safeNow(),
} = {}) {
  const nextLibrary = cloneLibrary(library);
  const nextRuntime = cloneRuntime(runtime);
  const wantedIds = orderedSceneIds.filter(Boolean);
  const scenesById = new Map(nextLibrary.scenes.map((scene) => [scene.id, scene]));
  const reordered = [];

  for (const sceneId of wantedIds) {
    if (scenesById.has(sceneId)) {
      reordered.push(scenesById.get(sceneId));
      scenesById.delete(sceneId);
    }
  }

  for (const scene of nextLibrary.scenes) {
    if (scenesById.has(scene.id)) {
      reordered.push(scene);
    }
  }

  nextLibrary.scenes = reordered.map((scene, index) => ({
    ...scene,
    order: index,
  }));
  nextLibrary.exportedAt = now;

  for (const activeScene of nextRuntime.activeScenes) {
    const updatedScene = nextLibrary.scenes.find((scene) => scene.id === activeScene.sceneId);
    if (updatedScene) {
      activeScene.order = updatedScene.order;
    }
  }

  return {
    library: nextLibrary,
    runtime: setTransportStatus(nextRuntime, now),
  };
}

export function updateSceneSettings({
  library,
  runtime,
  sceneId,
  patch = {},
  now = safeNow(),
} = {}) {
  const nextLibrary = cloneLibrary(library);
  const nextRuntime = cloneRuntime(runtime);
  const scene = findSceneOrThrow(nextLibrary, sceneId);

  scene.name = typeof patch.name === "string" && patch.name.trim() ? patch.name.trim() : scene.name;
  scene.color = typeof patch.color === "string" && patch.color.trim() ? patch.color.trim() : scene.color;
  if (patch.volume != null) {
    scene.volume = Math.max(0, Math.min(100, Number(patch.volume) || 0));
  }
  if (patch.loop != null) {
    scene.loop = Boolean(patch.loop);
  }
  scene.updatedAt = now;

  const activeScene = findActiveScene(nextRuntime, sceneId);
  if (activeScene) {
    updateActiveSceneFromLibrary(activeScene, scene);
    activeScene.sceneVolume = scene.volume;
    activeScene.loop = scene.loop;
  }

  return {
    library: nextLibrary,
    runtime: setTransportStatus(nextRuntime, now),
  };
}

export function addTrackToScene({
  library,
  runtime,
  sceneId,
  track,
  now = safeNow(),
} = {}) {
  const nextLibrary = cloneLibrary(library);
  const nextRuntime = cloneRuntime(runtime);
  const scene = findSceneOrThrow(nextLibrary, sceneId);

  if (scene.tracks.length >= MAX_TRACKS_PER_SCENE) {
    throw new Error(`A scene can contain at most ${MAX_TRACKS_PER_SCENE} tracks.`);
  }

  const nextTrack = ensureSceneTrack({
    ...track,
    order: scene.tracks.length,
  }, scene.tracks.length, scene.name);
  if (!nextTrack) {
    throw new Error("Track is missing a valid source ID.");
  }

  scene.tracks.push(nextTrack);
  scene.updatedAt = now;

  const activeScene = findActiveScene(nextRuntime, sceneId);
  if (activeScene) {
    const scenePositionMs = computeSceneTimelinePosition(activeScene, now);
    const fadeMs = normalizeFadeMs(nextRuntime);
    const scenePaused = activeScene.status === SCENE_STATUS_PAUSED
      || (activeScene.status === SCENE_STATUS_FADING_OUT && activeScene.nextStatus === SCENE_STATUS_PAUSED);
    activeScene.tracks.push(
      createActiveTrack(nextTrack, activeScene.tracks.length, scenePositionMs, now, fadeMs, scenePaused),
    );
    activeScene.tracks = normalizeTrackOrder(activeScene.tracks);
  }

  return {
    library: nextLibrary,
    runtime: setTransportStatus(nextRuntime, now),
  };
}

export function updateTrackSettings({
  library,
  runtime,
  sceneId,
  trackId,
  patch = {},
  now = safeNow(),
} = {}) {
  const nextLibrary = cloneLibrary(library);
  const nextRuntime = cloneRuntime(runtime);
  const scene = findSceneOrThrow(nextLibrary, sceneId);
  const track = scene.tracks.find((entry) => entry.id === trackId);
  if (!track) {
    throw new Error("Track not found in scene.");
  }

  if (patch.title != null) {
    track.title = String(patch.title).trim() || track.title;
  }
  if (patch.url != null) {
    track.url = String(patch.url).trim() || track.url;
  }
  if (patch.volume != null) {
    track.volume = Math.max(0, Math.min(100, Number(patch.volume) || 0));
  }
  if (patch.loop != null) {
    track.loop = Boolean(patch.loop);
  }
  if (patch.startDelayMs != null) {
    track.startDelayMs = Math.max(0, Math.round(Number(patch.startDelayMs) || 0));
  }
  if (patch.startOffsetSec != null) {
    track.startOffsetSec = Math.max(0, Number(patch.startOffsetSec) || 0);
  }
  if (patch.fadeInMs != null) {
    track.fadeInMs = Math.max(1, Math.round(Number(patch.fadeInMs) || 0));
  }
  if (patch.fadeOutMs != null) {
    track.fadeOutMs = Math.max(1, Math.round(Number(patch.fadeOutMs) || 0));
  }
  scene.updatedAt = now;

  const activeScene = findActiveScene(nextRuntime, sceneId);
  const activeTrack = activeScene?.tracks.find((entry) => entry.trackId === trackId);
  if (activeTrack) {
    activeTrack.title = track.title;
    activeTrack.volume = track.volume;
    activeTrack.loop = track.loop;
    activeTrack.mediaType = track.mediaType;
    activeTrack.startDelayMs = track.startDelayMs;
    activeTrack.startOffsetSec = track.startOffsetSec;
    activeTrack.fadeInMs = track.fadeInMs;
    activeTrack.fadeOutMs = track.fadeOutMs;
  }

  return {
    library: nextLibrary,
    runtime: setTransportStatus(nextRuntime, now),
  };
}

export function removeTrackFromScene({
  library,
  runtime,
  sceneId,
  trackId,
  now = safeNow(),
} = {}) {
  const nextLibrary = cloneLibrary(library);
  const nextRuntime = cloneRuntime(runtime);
  const scene = findSceneOrThrow(nextLibrary, sceneId);
  const removedTrack = scene.tracks.find((entry) => entry.id === trackId);
  if (!removedTrack) {
    return {
      library: nextLibrary,
      runtime: setTransportStatus(nextRuntime, now),
    };
  }

  scene.tracks = scene.tracks
    .filter((entry) => entry.id !== trackId)
    .map((entry, index) => ({
      ...entry,
      order: index,
    }));
  scene.updatedAt = now;

  const activeScene = findActiveScene(nextRuntime, sceneId);
  if (activeScene) {
    const activeTrack = activeScene.tracks.find((entry) => entry.trackId === trackId);
    if (activeTrack) {
      activeTrack.status = TRACK_STATUS_FADING_OUT;
      activeTrack.nextStatus = TRACK_STATUS_STOPPED;
      activeTrack.fadeStartedAt = now;
      activeTrack.fadeEndsAt = now + Math.max(1, activeTrack.fadeOutMs || normalizeFadeMs(nextRuntime));
    }
    activeScene.tracks = normalizeTrackOrder(activeScene.tracks);
  }

  return {
    library: nextLibrary,
    runtime: setTransportStatus(nextRuntime, now),
  };
}

export function reorderSceneTracks({
  library,
  runtime,
  sceneId,
  orderedTrackIds = [],
  now = safeNow(),
} = {}) {
  const nextLibrary = cloneLibrary(library);
  const nextRuntime = cloneRuntime(runtime);
  const scene = findSceneOrThrow(nextLibrary, sceneId);
  const wantedIds = orderedTrackIds.filter(Boolean);
  const sceneTracksById = new Map(scene.tracks.map((track) => [track.id, track]));
  const reordered = [];

  for (const trackId of wantedIds) {
    if (sceneTracksById.has(trackId)) {
      reordered.push(sceneTracksById.get(trackId));
      sceneTracksById.delete(trackId);
    }
  }

  for (const track of scene.tracks) {
    if (sceneTracksById.has(track.id)) {
      reordered.push(track);
    }
  }

  scene.tracks = reordered.map((track, index) => ({
    ...track,
    order: index,
  }));
  scene.updatedAt = now;

  const activeScene = findActiveScene(nextRuntime, sceneId);
  if (activeScene) {
    const nextTracks = [];
    const activeTracksById = new Map(activeScene.tracks.map((track) => [track.trackId, track]));
    for (const track of scene.tracks) {
      const activeTrack = activeTracksById.get(track.id);
      if (!activeTrack) {
        continue;
      }
      nextTracks.push({
        ...activeTrack,
        effectiveOrder: track.order,
      });
    }
    activeScene.tracks = normalizeTrackOrder(nextTracks);
  }

  return {
    library: nextLibrary,
    runtime: setTransportStatus(nextRuntime, now),
  };
}

export function restartSceneLoop({
  library,
  runtime,
  sceneId,
  now = safeNow(),
} = {}) {
  const nextLibrary = cloneLibrary(library);
  const nextRuntime = cloneRuntime(runtime);
  const scene = findSceneOrThrow(nextLibrary, sceneId);
  const activeScene = findActiveScene(nextRuntime, sceneId);
  if (!activeScene) {
    return nextRuntime;
  }

  const fadeMs = normalizeFadeMs(nextRuntime);
  activeScene.positionMs = 0;
  activeScene.startedAt = now;
  activeScene.pausedAt = 0;
  activeScene.status = SCENE_STATUS_FADING_IN;
  activeScene.nextStatus = SCENE_STATUS_PLAYING;
  activeScene.fadeStartedAt = now;
  activeScene.fadeEndsAt = now + fadeMs;
  activeScene.tracks = scene.tracks.map((track, index) => createActiveTrack(track, index, 0, now, fadeMs));
  return setTransportStatus(nextRuntime, now);
}
