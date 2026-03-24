import { buildRoomStateApplyKey as buildRoomStateKeyFromShared } from "./shared.js";

const END_CONFIRM_TOLERANCE_SEC = 1.5;

export function buildRoomStateApplyKey(roomState) {
  return buildRoomStateKeyFromShared(roomState);
}

export function isActivePlaybackState(playerState, playerStates = {}) {
  return playerState === playerStates.PLAYING
    || playerState === playerStates.BUFFERING;
}

export function shouldSkipRedundantPlaybackApply({
  hadSamePlan,
  sourceChanged,
  playerState,
}, playerStates = {}) {
  return !sourceChanged
    && hadSamePlan
    && isActivePlaybackState(playerState, playerStates);
}

export function shouldRecoverPlayback({
  sourceChanged,
  playerState,
}, playerStates = {}) {
  return sourceChanged || !isActivePlaybackState(playerState, playerStates);
}

export function shouldResetSyncLoopForRoleChange(currentIsGm, nextRole) {
  return currentIsGm !== (nextRole === "GM");
}

export function shouldWritePeriodicSyncUpdate(layer, snapshot) {
  return layer?.sourceType === "playlist"
    && (
      snapshot?.playlistIndex !== layer.runtime?.playlistIndex
      || snapshot?.videoId !== layer.runtime?.playlistVideoId
    );
}

export function isConfirmedTrackEnd(snapshot, toleranceSec = END_CONFIRM_TOLERANCE_SEC) {
  const duration = Number(snapshot?.duration) || 0;
  const currentTime = Math.max(0, Number(snapshot?.currentTime) || 0);
  if (duration <= 0) {
    return false;
  }
  return currentTime >= Math.max(0, duration - toleranceSec);
}
