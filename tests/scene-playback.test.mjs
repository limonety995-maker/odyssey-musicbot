import test from "node:test";
import assert from "node:assert/strict";

import {
  SCENE_STATUS_FADING_IN,
  SCENE_STATUS_FADING_OUT,
  SCENE_STATUS_PAUSED,
  SCENE_STATUS_PLAYING,
  TRACK_STATUS_FADING_IN,
  TRACK_STATUS_FADING_OUT,
  TRACK_STATUS_PAUSED,
  TRACK_STATUS_PLAYING,
  TRACK_STATUS_QUEUED,
  createEmptyRoomRuntime,
  ensureLibraryPack,
} from "../src/extension/scene-model.js";
import {
  finalizeRuntimeTransitions,
  launchScene,
} from "../src/extension/scene-runtime.js";
import {
  buildActiveTrackPlaybackPlan,
  buildPlaybackSlotId,
  computeFadeGain,
  computeSceneConfiguredLengthMs,
  computeScenePlaybackGain,
  computeTrackPlaybackGain,
  shouldSceneLoopRestart,
  shouldSceneStop,
  shouldTrackSelfLoop,
} from "../src/extension/scene-playback.js";

function makeLibrary() {
  return ensureLibraryPack({
    scenes: [
      {
        id: "dungeon",
        name: "Dungeon",
        loop: true,
        tracks: [
          {
            id: "rain",
            sourceId: "abcdefghijk",
            sourceType: "youtube",
            title: "Rain",
            startDelayMs: 0,
            startOffsetSec: 5,
          },
          {
            id: "drip",
            sourceId: "bbbbbbbbbbb",
            sourceType: "youtube_music",
            title: "Drips",
            loop: true,
            startDelayMs: 4000,
            startOffsetSec: 0,
          },
        ],
      },
    ],
  });
}

test("fade gain curves progress correctly for fade in and fade out", () => {
  assert.equal(
    computeFadeGain({
      status: SCENE_STATUS_FADING_IN,
      fadeStartedAt: 1000,
      fadeEndsAt: 2000,
      now: 1500,
    }),
    0.5,
  );
  assert.equal(
    computeFadeGain({
      status: TRACK_STATUS_FADING_OUT,
      fadeStartedAt: 1000,
      fadeEndsAt: 2000,
      now: 1500,
    }),
    0.5,
  );
  assert.equal(
    computeFadeGain({
      status: SCENE_STATUS_PAUSED,
      now: 1500,
    }),
    0,
  );
});

test("configured scene length is based on the longest configured track span", () => {
  const scene = makeLibrary().scenes[0];
  const lengthMs = computeSceneConfiguredLengthMs(scene, {
    rain: 120,
    drip: 30,
  });
  assert.equal(lengthMs, 115000);
});

test("scene loop and stop checks use configured scene length", () => {
  const scene = makeLibrary().scenes[0];
  const sceneRuntime = {
    loop: true,
    positionMs: 0,
    startedAt: 1000,
  };

  assert.equal(
    shouldSceneLoopRestart(sceneRuntime, scene, { rain: 120, drip: 30 }, 116000),
    true,
  );
  assert.equal(
    shouldSceneStop({ ...sceneRuntime, loop: false }, scene, { rain: 120, drip: 30 }, 116000),
    true,
  );
});

test("individual track loop check is based on computed track playhead", () => {
  const sceneRuntime = {
    startedAt: 1000,
    positionMs: 0,
  };
  const trackRuntime = {
    loop: true,
    startDelayMs: 2000,
    startOffsetSec: 0,
    activationScenePositionMs: 0,
  };

  assert.equal(shouldTrackSelfLoop(sceneRuntime, trackRuntime, 10, 8000), false);
  assert.equal(shouldTrackSelfLoop(sceneRuntime, trackRuntime, 3, 8000), true);
});

test("playback plan flattens active runtime into stable slot entries", () => {
  const library = makeLibrary();
  let runtime = launchScene({
    library,
    runtime: createEmptyRoomRuntime(1000),
    sceneId: "dungeon",
    now: 1000,
  });
  runtime = finalizeRuntimeTransitions(runtime, 3000);

  const plan = buildActiveTrackPlaybackPlan(runtime, 3000);
  assert.equal(plan.length, 2);
  assert.equal(plan[0].slotId, buildPlaybackSlotId("dungeon", "rain"));
  assert.equal(plan[0].desiredStatus, TRACK_STATUS_PLAYING);
  assert.equal(plan[1].desiredStatus, TRACK_STATUS_QUEUED);
});

test("scene and track playback gains compose independently", () => {
  assert.equal(
    computeScenePlaybackGain({
      status: SCENE_STATUS_PLAYING,
    }, 1000),
    1,
  );
  assert.equal(
    computeTrackPlaybackGain({
      status: TRACK_STATUS_PAUSED,
    }, 1000),
    0,
  );
  assert.equal(
    computeTrackPlaybackGain({
      status: TRACK_STATUS_FADING_IN,
      fadeStartedAt: 1000,
      fadeEndsAt: 2000,
    }, 1500),
    0.5,
  );
});
