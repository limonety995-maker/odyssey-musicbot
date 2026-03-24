import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRoomStateApplyKey,
  ensureRoomState,
  ensureSceneLibrary,
} from "../src/extension/shared.js";

test("legacy room state normalizes deterministically across repeated reads", () => {
  const legacyRoomState = {
    revision: 503,
    activeScene: { name: "Live mix" },
    transport: {
      status: "playing",
      masterVolume: 85,
    },
    layers: [
      {
        title: "Legacy track",
        sourceType: "video",
        sourceId: "abcdefghijk",
        origin: "youtube",
        volume: 100,
        loop: false,
        startSeconds: 0,
        runtime: {
          status: "playing",
          pauseOffsetSec: 0,
          playingSince: 1710000002500,
        },
      },
    ],
  };

  const first = ensureRoomState(legacyRoomState);
  const firstKey = buildRoomStateApplyKey(legacyRoomState);

  for (let index = 0; index < 10; index += 1) {
    assert.deepEqual(ensureRoomState(legacyRoomState), first);
    assert.equal(buildRoomStateApplyKey(legacyRoomState), firstKey);
  }
});

test("legacy scene library normalizes deterministically across repeated reads", () => {
  const legacyLibrary = {
    scenes: [
      {
        name: "Legacy scene",
        layers: [
          {
            title: "Scene layer",
            sourceType: "video",
            sourceId: "abcdefghijk",
            origin: "youtube",
            volume: 60,
            loop: true,
            startSeconds: 5,
          },
        ],
      },
    ],
  };

  const first = ensureSceneLibrary(legacyLibrary);

  for (let index = 0; index < 10; index += 1) {
    assert.deepEqual(ensureSceneLibrary(legacyLibrary), first);
  }
});

test("empty room-state apply key stays stable", () => {
  const emptyKeys = new Set();
  for (let index = 0; index < 10; index += 1) {
    emptyKeys.add(buildRoomStateApplyKey(null));
  }
  assert.equal(emptyKeys.size, 1);
});
