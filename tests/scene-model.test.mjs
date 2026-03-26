import test from "node:test";
import assert from "node:assert/strict";

import {
  LAUNCH_MODE_ADD,
  LIBRARY_PACK_VERSION,
  ROOM_RUNTIME_VERSION,
  computeEffectiveTrackVolume,
  ensureLibraryPack,
  exportLibraryPack,
  importLibraryPack,
  replaceLibraryAndStopRuntime,
} from "../src/extension/scene-model.js";

test("library pack normalization sorts scenes and tracks deterministically", () => {
  const normalized = ensureLibraryPack({
    exportedAt: 123,
    scenes: [
      {
        name: "B scene",
        order: 10,
        tracks: [
          { sourceId: "bbbbbbbbbbb", title: "Track B", order: 5, origin: "youtube", volume: 30 },
          { sourceId: "aaaaaaaaaaa", title: "Track A", order: 1, origin: "youtube-music", volume: 90 },
        ],
      },
      {
        name: "A scene",
        order: 1,
        layers: [
          { sourceId: "ccccccccccc", title: "Legacy Layer", sourceType: "video", origin: "youtube", volume: 80 },
        ],
      },
    ],
  });

  assert.equal(normalized.version, LIBRARY_PACK_VERSION);
  assert.deepEqual(normalized.scenes.map((scene) => scene.name), ["A scene", "B scene"]);
  assert.deepEqual(normalized.scenes[1].tracks.map((track) => track.title), ["Track A", "Track B"]);
  assert.equal(normalized.scenes[1].tracks[0].sourceType, "youtube_music");
  assert.equal(normalized.scenes[0].tracks[0].sourceType, "youtube");
  assert.equal(normalized.scenes[0].tracks[0].mediaType, "video");
  assert.equal(normalized.scenes[0].tracks[0].sourceId, "ccccccccccc");
});

test("export and import preserve the normalized library structure", () => {
  const library = ensureLibraryPack({
    scenes: [
      {
        name: "Dungeon",
        color: "#333333",
        tracks: [
          { sourceId: "abcdefghijk", title: "Rain", sourceType: "youtube", volume: 70 },
        ],
      },
    ],
  });

  const json = exportLibraryPack(library, 777);
  const imported = importLibraryPack(json);

  assert.equal(imported.exportedAt, 777);
  assert.deepEqual(imported.scenes, library.scenes);
});

test("import replacement clears runtime and keeps transport preferences", () => {
  const result = replaceLibraryAndStopRuntime(
    JSON.stringify({
      scenes: [
        {
          name: "Forest",
          tracks: [
            { sourceId: "abcdefghijk", title: "Birds", sourceType: "youtube" },
          ],
        },
      ],
    }),
    {
      transport: {
        status: "playing",
        launchMode: "replace",
        masterVolume: 66,
        globalFadeMs: 2500,
      },
      activeScenes: [
        {
          sceneId: "old-scene",
          name: "Old scene",
          status: "playing",
          tracks: [
            {
              trackId: "old-track",
              title: "Old",
              sourceType: "youtube",
              sourceId: "abcdefghijk",
              status: "playing",
            },
          ],
        },
      ],
    },
    999,
  );

  assert.equal(result.library.scenes[0].name, "Forest");
  assert.equal(result.runtime.version, ROOM_RUNTIME_VERSION);
  assert.equal(result.runtime.transport.status, "stopped");
  assert.equal(result.runtime.transport.launchMode, "replace");
  assert.equal(result.runtime.transport.masterVolume, 66);
  assert.equal(result.runtime.transport.globalFadeMs, 2500);
  assert.equal(result.runtime.activeScenes.length, 0);
  assert.equal(result.runtime.updatedAt, 999);
});

test("effective track volume respects master, scene, track and local levels", () => {
  assert.equal(
    computeEffectiveTrackVolume({
      masterVolume: 80,
      sceneVolume: 50,
      trackVolume: 50,
      localPlayerVolume: 50,
    }),
    10,
  );
  assert.equal(
    computeEffectiveTrackVolume({
      masterVolume: 100,
      sceneVolume: 100,
      trackVolume: 100,
      localPlayerVolume: 100,
    }),
    100,
  );
});

test("empty runtime replacement still defaults to add launch mode", () => {
  const result = replaceLibraryAndStopRuntime('{"scenes":[]}', null, 321);
  assert.equal(result.runtime.transport.launchMode, LAUNCH_MODE_ADD);
});
