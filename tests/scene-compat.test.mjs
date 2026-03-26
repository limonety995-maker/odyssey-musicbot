import test from "node:test";
import assert from "node:assert/strict";

import {
  createEmptyRoomRuntime,
  ensureLibraryPack,
} from "../src/extension/scene-model.js";
import {
  ensureLiveSceneInLibrary,
  buildLegacyLibraryView,
  buildLegacyRoomStateView,
  collectCurrentMixTracks,
  createSceneTrackFromParsedTrack,
  findTrackReference,
  upsertLibraryScene,
  LIVE_SCENE_ID,
} from "../src/extension/scene-compat.js";
import { launchScene } from "../src/extension/scene-runtime.js";

function makeLibrary() {
  return ensureLibraryPack({
    scenes: [
      {
        id: "dungeon",
        name: "Dungeon",
        tracks: [
          {
            id: "dungeon-rain",
            sourceId: "abcdefghijk",
            sourceType: "youtube",
            title: "Rain",
            volume: 70,
          },
        ],
      },
    ],
  });
}

test("legacy room-state view falls back to the live scene draft when runtime is empty", () => {
  const track = createSceneTrackFromParsedTrack({
    title: "Waves",
    url: "https://www.youtube.com/watch?v=abcdefghijk",
    origin: "youtube",
    sourceType: "video",
    sourceId: "abcdefghijk",
  });

  const library = upsertLibraryScene({
    library: ensureLiveSceneInLibrary(makeLibrary(), 1000),
    sceneId: LIVE_SCENE_ID,
    name: "Live mix",
    tracks: [track],
    now: 2000,
  });

  const view = buildLegacyRoomStateView(createEmptyRoomRuntime(3000), library);
  assert.equal(view.layers.length, 1);
  assert.equal(view.layers[0].title, "Waves");
  assert.equal(view.transport.status, "stopped");
  assert.equal(view.activeScene?.id, LIVE_SCENE_ID);
});

test("legacy adapters flatten active scene runtime and resolve slot references", () => {
  const library = makeLibrary();
  const runtime = launchScene({
    library,
    runtime: createEmptyRoomRuntime(1000),
    sceneId: "dungeon",
    now: 1000,
  });

  const view = buildLegacyRoomStateView(runtime, library);
  const slotId = view.layers[0].id;
  const ref = findTrackReference(runtime, library, slotId);
  assert.equal(view.layers[0].runtime.status, "playing");
  assert.deepEqual(ref, {
    sceneId: "dungeon",
    trackId: "dungeon-rain",
    fromRuntime: true,
  });
});

test("legacy library view hides the live scene and current mix tracks can be collected", () => {
  const liveTrack = createSceneTrackFromParsedTrack({
    title: "Live Rain",
    url: "https://youtu.be/abcdefghijk",
    origin: "youtube",
    sourceType: "video",
    sourceId: "abcdefghijk",
  });

  const library = upsertLibraryScene({
    library: ensureLiveSceneInLibrary(makeLibrary(), 1000),
    sceneId: LIVE_SCENE_ID,
    name: "Live mix",
    tracks: [liveTrack],
    now: 2000,
  });

  const legacyLibrary = buildLegacyLibraryView(library);
  const mixTracks = collectCurrentMixTracks(createEmptyRoomRuntime(3000), library);

  assert.deepEqual(legacyLibrary.scenes.map((scene) => scene.id), ["dungeon"]);
  assert.equal(mixTracks.length, 1);
  assert.equal(mixTracks[0].title, "Live Rain");
});
