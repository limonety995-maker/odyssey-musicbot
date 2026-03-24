import test from "node:test";
import assert from "node:assert/strict";

import {
  isConfirmedTrackEnd,
  shouldRecoverPlayback,
  shouldResetSyncLoopForRoleChange,
  shouldSkipRedundantPlaybackApply,
  shouldWritePeriodicSyncUpdate,
} from "../src/extension/sync-logic.js";

const playerStates = {
  PLAYING: 1,
  BUFFERING: 3,
  PAUSED: 2,
};

test("redundant same-plan playback applies are skipped while player is active", () => {
  assert.equal(
    shouldSkipRedundantPlaybackApply(
      {
        hadSamePlan: true,
        sourceChanged: false,
        playerState: playerStates.PLAYING,
      },
      playerStates,
    ),
    true,
  );
  assert.equal(
    shouldSkipRedundantPlaybackApply(
      {
        hadSamePlan: true,
        sourceChanged: false,
        playerState: playerStates.BUFFERING,
      },
      playerStates,
    ),
    true,
  );
});

test("playback recovery is not requested for active same-source states", () => {
  assert.equal(
    shouldRecoverPlayback(
      {
        sourceChanged: false,
        playerState: playerStates.PLAYING,
      },
      playerStates,
    ),
    false,
  );
  assert.equal(
    shouldRecoverPlayback(
      {
        sourceChanged: false,
        playerState: playerStates.BUFFERING,
      },
      playerStates,
    ),
    false,
  );
  assert.equal(
    shouldRecoverPlayback(
      {
        sourceChanged: false,
        playerState: playerStates.PAUSED,
      },
      playerStates,
    ),
    true,
  );
});

test("sync loop only resets on actual role changes", () => {
  assert.equal(shouldResetSyncLoopForRoleChange(true, "GM"), false);
  assert.equal(shouldResetSyncLoopForRoleChange(false, "PLAYER"), false);
  assert.equal(shouldResetSyncLoopForRoleChange(false, "GM"), true);
  assert.equal(shouldResetSyncLoopForRoleChange(true, "PLAYER"), true);
});

test("periodic sync only writes for playlist progression", () => {
  const videoLayer = {
    sourceType: "video",
    runtime: {
      playlistIndex: 0,
      playlistVideoId: null,
    },
  };
  const playlistLayer = {
    sourceType: "playlist",
    runtime: {
      playlistIndex: 0,
      playlistVideoId: "track-a",
    },
  };

  assert.equal(
    shouldWritePeriodicSyncUpdate(videoLayer, {
      playlistIndex: 0,
      videoId: "track-a",
    }),
    false,
  );
  assert.equal(
    shouldWritePeriodicSyncUpdate(playlistLayer, {
      playlistIndex: 0,
      videoId: "track-a",
    }),
    false,
  );
  assert.equal(
    shouldWritePeriodicSyncUpdate(playlistLayer, {
      playlistIndex: 1,
      videoId: "track-b",
    }),
    true,
  );
});

test("ENDED is only trusted near the real track duration", () => {
  assert.equal(
    isConfirmedTrackEnd({
      currentTime: 7,
      duration: 180,
    }),
    false,
  );
  assert.equal(
    isConfirmedTrackEnd({
      currentTime: 179.2,
      duration: 180,
    }),
    true,
  );
  assert.equal(
    isConfirmedTrackEnd({
      currentTime: 0,
      duration: 0,
    }),
    false,
  );
});
