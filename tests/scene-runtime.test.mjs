import test from "node:test";
import assert from "node:assert/strict";

import {
  LAUNCH_MODE_ADD,
  LAUNCH_MODE_REPLACE,
  SCENE_STATUS_FADING_IN,
  SCENE_STATUS_FADING_OUT,
  SCENE_STATUS_PAUSED,
  SCENE_STATUS_PLAYING,
  TRACK_STATUS_FADING_IN,
  TRACK_STATUS_FADING_OUT,
  TRACK_STATUS_QUEUED,
  createEmptyRoomRuntime,
  ensureLibraryPack,
} from "../src/extension/scene-model.js";
import {
  addTrackToScene,
  computeCurrentSceneLabel,
  computeSceneTimelinePosition,
  computeTrackPlayheadMs,
  createSceneInLibrary,
  countActiveScenes,
  deleteSceneFromLibrary,
  finalizeRuntimeTransitions,
  launchScene,
  pauseAllScenes,
  pressSceneFolder,
  reorderLibraryScenes,
  reorderSceneTracks,
  removeTrackFromScene,
  restartSceneLoop,
  resumeAllScenes,
  setLaunchMode,
  stopAllScenes,
  updateSceneSettings,
  updateTrackSettings,
} from "../src/extension/scene-runtime.js";

function makeLibrary() {
  return ensureLibraryPack({
    scenes: [
      {
        id: "dungeon",
        name: "Dungeon",
        color: "#111111",
        volume: 80,
        loop: true,
        tracks: [
          {
            id: "dungeon-rain",
            sourceId: "abcdefghijk",
            sourceType: "youtube",
            title: "Rain",
            volume: 70,
            startDelayMs: 0,
            startOffsetSec: 3,
            fadeInMs: 1200,
            fadeOutMs: 1400,
          },
          {
            id: "dungeon-drip",
            sourceId: "bbbbbbbbbbb",
            sourceType: "youtube_music",
            title: "Drips",
            volume: 55,
            startDelayMs: 4000,
            fadeInMs: 600,
            fadeOutMs: 900,
          },
        ],
      },
      {
        id: "battle",
        name: "Battle",
        color: "#222222",
        volume: 95,
        loop: false,
        tracks: [
          {
            id: "battle-main",
            sourceId: "ccccccccccc",
            sourceType: "youtube",
            title: "Battle Theme",
            volume: 90,
          },
        ],
      },
      {
        id: "forest",
        name: "Forest",
        color: "#333333",
        volume: 60,
        loop: true,
        tracks: [
          {
            id: "forest-birds",
            sourceId: "ddddddddddd",
            sourceType: "youtube",
            title: "Birds",
            volume: 50,
          },
        ],
      },
      {
        id: "sea",
        name: "Sea",
        color: "#444444",
        volume: 65,
        loop: false,
        tracks: [
          {
            id: "sea-wave",
            sourceId: "eeeeeeeeeee",
            sourceType: "youtube",
            title: "Waves",
            volume: 60,
          },
        ],
      },
    ],
  });
}

test("add launch starts a scene with fade-in and queued delayed tracks", () => {
  const runtime = launchScene({
    library: makeLibrary(),
    runtime: createEmptyRoomRuntime(1000),
    sceneId: "dungeon",
    mode: LAUNCH_MODE_ADD,
    now: 1000,
  });

  assert.equal(runtime.transport.status, "playing");
  assert.equal(countActiveScenes(runtime), 1);
  assert.equal(computeCurrentSceneLabel(runtime), "Dungeon");
  assert.equal(runtime.activeScenes[0].status, SCENE_STATUS_FADING_IN);
  assert.equal(runtime.activeScenes[0].tracks[0].status, TRACK_STATUS_FADING_IN);
  assert.equal(runtime.activeScenes[0].tracks[1].status, TRACK_STATUS_QUEUED);
});

test("replace launch fades old scenes out while fading the new one in", () => {
  let runtime = createEmptyRoomRuntime(1000);
  runtime = launchScene({
    library: makeLibrary(),
    runtime,
    sceneId: "dungeon",
    mode: LAUNCH_MODE_ADD,
    now: 1000,
  });

  runtime = launchScene({
    library: makeLibrary(),
    runtime,
    sceneId: "battle",
    mode: LAUNCH_MODE_REPLACE,
    now: 2000,
  });

  assert.equal(runtime.activeScenes.length, 2);
  const dungeon = runtime.activeScenes.find((scene) => scene.sceneId === "dungeon");
  const battle = runtime.activeScenes.find((scene) => scene.sceneId === "battle");
  assert.equal(dungeon.status, SCENE_STATUS_FADING_OUT);
  assert.equal(dungeon.nextStatus, "stopped");
  assert.equal(battle.status, SCENE_STATUS_FADING_IN);
});

test("folder press toggles active scenes between pause and resume", () => {
  const library = makeLibrary();
  let runtime = launchScene({
    library,
    runtime: createEmptyRoomRuntime(1000),
    sceneId: "dungeon",
    now: 1000,
  });
  runtime = finalizeRuntimeTransitions(runtime, 3000);
  assert.equal(runtime.activeScenes[0].status, SCENE_STATUS_PLAYING);

  runtime = pressSceneFolder({
    library,
    runtime,
    sceneId: "dungeon",
    now: 4000,
  });
  assert.equal(runtime.activeScenes[0].status, SCENE_STATUS_FADING_OUT);
  assert.equal(runtime.activeScenes[0].nextStatus, SCENE_STATUS_PAUSED);

  runtime = finalizeRuntimeTransitions(runtime, 6000);
  assert.equal(runtime.activeScenes[0].status, SCENE_STATUS_PAUSED);

  runtime = pressSceneFolder({
    library,
    runtime,
    sceneId: "dungeon",
    now: 7000,
  });
  assert.equal(runtime.activeScenes[0].status, SCENE_STATUS_FADING_IN);
  assert.equal(runtime.activeScenes[0].nextStatus, SCENE_STATUS_PLAYING);
});

test("add launch rejects a fourth simultaneous scene", () => {
  const library = makeLibrary();
  let runtime = createEmptyRoomRuntime(1000);
  runtime = launchScene({ library, runtime, sceneId: "dungeon", now: 1000 });
  runtime = launchScene({ library, runtime, sceneId: "battle", now: 2000 });
  runtime = launchScene({ library, runtime, sceneId: "forest", now: 3000 });

  assert.throws(
    () => launchScene({ library, runtime, sceneId: "sea", now: 4000 }),
    /Only 3 scenes can be active/,
  );
});

test("global pause, resume and stop apply to all active scenes", () => {
  const library = makeLibrary();
  let runtime = createEmptyRoomRuntime(1000);
  runtime = launchScene({ library, runtime, sceneId: "dungeon", now: 1000 });
  runtime = launchScene({ library, runtime, sceneId: "battle", now: 2000 });

  runtime = pauseAllScenes(runtime, 3000);
  assert.equal(runtime.activeScenes.every((scene) => scene.status === SCENE_STATUS_FADING_OUT), true);

  runtime = finalizeRuntimeTransitions(runtime, 5000);
  assert.equal(runtime.transport.status, "paused");
  assert.equal(runtime.activeScenes.every((scene) => scene.status === SCENE_STATUS_PAUSED), true);

  runtime = resumeAllScenes(runtime, 6000);
  assert.equal(runtime.activeScenes.every((scene) => scene.status === SCENE_STATUS_FADING_IN), true);

  runtime = stopAllScenes(runtime, 7000);
  assert.equal(runtime.activeScenes.every((scene) => scene.nextStatus === "stopped"), true);

  runtime = finalizeRuntimeTransitions(runtime, 9000);
  assert.equal(runtime.activeScenes.length, 0);
  assert.equal(runtime.transport.status, "stopped");
});

test("adding a track to an active scene starts it from zero at the current scene timeline", () => {
  const library = makeLibrary();
  let runtime = launchScene({
    library,
    runtime: createEmptyRoomRuntime(1000),
    sceneId: "dungeon",
    now: 1000,
  });
  runtime = finalizeRuntimeTransitions(runtime, 3000);

  const result = addTrackToScene({
    library,
    runtime,
    sceneId: "dungeon",
    track: {
      id: "dungeon-echo",
      sourceId: "fffffffffff",
      sourceType: "youtube",
      title: "Echo",
      startDelayMs: 2000,
    },
    now: 6000,
  });

  const activeScene = result.runtime.activeScenes[0];
  const newTrack = activeScene.tracks.find((track) => track.trackId === "dungeon-echo");
  assert.equal(result.library.scenes[0].tracks.length, 3);
  assert.equal(newTrack.activationScenePositionMs, 5000);
  assert.equal(newTrack.status, TRACK_STATUS_QUEUED);
});

test("track and scene edits apply live without restarting the scene", () => {
  const library = makeLibrary();
  let runtime = launchScene({
    library,
    runtime: createEmptyRoomRuntime(1000),
    sceneId: "dungeon",
    now: 1000,
  });
  runtime = finalizeRuntimeTransitions(runtime, 4000);

  let result = updateSceneSettings({
    library,
    runtime,
    sceneId: "dungeon",
    patch: { volume: 45, loop: false, color: "#999999" },
    now: 5000,
  });
  assert.equal(result.library.scenes[0].volume, 45);
  assert.equal(result.runtime.activeScenes[0].sceneVolume, 45);
  assert.equal(result.runtime.activeScenes[0].color, "#999999");

  result = updateTrackSettings({
    library: result.library,
    runtime: result.runtime,
    sceneId: "dungeon",
    trackId: "dungeon-rain",
    patch: { volume: 25, startDelayMs: 3333, fadeOutMs: 2100 },
    now: 6000,
  });
  const activeTrack = result.runtime.activeScenes[0].tracks.find((track) => track.trackId === "dungeon-rain");
  assert.equal(activeTrack.volume, 25);
  assert.equal(activeTrack.startDelayMs, 3333);
  assert.equal(activeTrack.fadeOutMs, 2100);
});

test("reordering tracks updates library order and runtime playback priority immediately", () => {
  const library = makeLibrary();
  let runtime = launchScene({
    library,
    runtime: createEmptyRoomRuntime(1000),
    sceneId: "dungeon",
    now: 1000,
  });
  runtime = finalizeRuntimeTransitions(runtime, 4000);

  const result = reorderSceneTracks({
    library,
    runtime,
    sceneId: "dungeon",
    orderedTrackIds: ["dungeon-drip", "dungeon-rain"],
    now: 5000,
  });

  assert.deepEqual(result.library.scenes[0].tracks.map((track) => track.id), ["dungeon-drip", "dungeon-rain"]);
  assert.deepEqual(result.runtime.activeScenes[0].tracks.map((track) => track.trackId), ["dungeon-drip", "dungeon-rain"]);
  assert.deepEqual(result.runtime.activeScenes[0].tracks.map((track) => track.effectiveOrder), [0, 1]);
});

test("removing a track fades it out in runtime and removes it from the library", () => {
  const library = makeLibrary();
  let runtime = launchScene({
    library,
    runtime: createEmptyRoomRuntime(1000),
    sceneId: "dungeon",
    now: 1000,
  });
  runtime = finalizeRuntimeTransitions(runtime, 4000);

  const result = removeTrackFromScene({
    library,
    runtime,
    sceneId: "dungeon",
    trackId: "dungeon-rain",
    now: 5000,
  });

  assert.equal(result.library.scenes[0].tracks.length, 1);
  const activeTrack = result.runtime.activeScenes[0].tracks.find((track) => track.trackId === "dungeon-rain");
  assert.equal(activeTrack.status, TRACK_STATUS_FADING_OUT);
  assert.equal(activeTrack.nextStatus, "stopped");
});

test("scene loop restart resets scene timeline and track activations", () => {
  const library = makeLibrary();
  let runtime = launchScene({
    library,
    runtime: createEmptyRoomRuntime(1000),
    sceneId: "dungeon",
    now: 1000,
  });
  runtime = finalizeRuntimeTransitions(runtime, 4000);

  runtime = restartSceneLoop({
    library,
    runtime,
    sceneId: "dungeon",
    now: 9000,
  });

  const activeScene = runtime.activeScenes[0];
  assert.equal(activeScene.positionMs, 0);
  assert.equal(activeScene.startedAt, 9000);
  assert.equal(activeScene.status, SCENE_STATUS_FADING_IN);
  assert.equal(activeScene.tracks[0].activationScenePositionMs, 0);
});

test("scene timeline and track playhead are derived from scene runtime", () => {
  const library = makeLibrary();
  let runtime = launchScene({
    library,
    runtime: createEmptyRoomRuntime(1000),
    sceneId: "dungeon",
    now: 1000,
  });
  runtime = finalizeRuntimeTransitions(runtime, 4000);

  const activeScene = runtime.activeScenes[0];
  const firstTrack = activeScene.tracks[0];
  const secondTrack = activeScene.tracks[1];

  assert.equal(computeSceneTimelinePosition(activeScene, 6500), 5500);
  assert.equal(computeTrackPlayheadMs(activeScene, firstTrack, 6500), 8500);
  assert.equal(computeTrackPlayheadMs(activeScene, secondTrack, 6500), 1500);
});

test("launch mode can be updated without touching active scenes", () => {
  const runtime = setLaunchMode(createEmptyRoomRuntime(1000), LAUNCH_MODE_REPLACE, 2000);
  assert.equal(runtime.transport.launchMode, LAUNCH_MODE_REPLACE);
});

test("scene library supports create, reorder and delete operations", () => {
  const library = makeLibrary();
  const runtime = createEmptyRoomRuntime(1000);

  let nextLibrary = createSceneInLibrary({
    library,
    name: "Village",
    color: "#555555",
    tracks: [
      { sourceId: "fffffffffff", sourceType: "youtube", title: "Square" },
    ],
    now: 2000,
  });
  const createdScene = nextLibrary.scenes.find((scene) => scene.name === "Village");
  assert.equal(Boolean(createdScene), true);

  let reordered = reorderLibraryScenes({
    library: nextLibrary,
    runtime,
    orderedSceneIds: ["battle", createdScene.id],
    now: 3000,
  });
  assert.equal(reordered.library.scenes[0].id, "battle");

  const deleted = deleteSceneFromLibrary({
    library: reordered.library,
    runtime: reordered.runtime,
    sceneId: createdScene.id,
    now: 4000,
  });
  assert.equal(deleted.library.scenes.some((scene) => scene.name === "Village"), false);
});
