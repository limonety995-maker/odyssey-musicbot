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
  ensureRoomRuntime,
} from "./scene-model.js";
import {
  computeSceneTimelinePosition,
  computeTrackPlayheadMs,
  isTrackReadyToStart,
} from "./scene-runtime.js";
import { clamp, safeNow } from "./shared.js";

export function buildPlaybackSlotId(sceneId, trackId) {
  return `${sceneId}::${trackId}`;
}

export function computeFadeGain({
  status,
  fadeStartedAt = 0,
  fadeEndsAt = 0,
  now = safeNow(),
} = {}) {
  if (status === SCENE_STATUS_FADING_IN || status === TRACK_STATUS_FADING_IN) {
    if (!fadeEndsAt || fadeEndsAt <= fadeStartedAt) {
      return 1;
    }
    return clamp((now - fadeStartedAt) / (fadeEndsAt - fadeStartedAt), 0, 1);
  }

  if (status === SCENE_STATUS_FADING_OUT || status === TRACK_STATUS_FADING_OUT) {
    if (!fadeEndsAt || fadeEndsAt <= fadeStartedAt) {
      return 0;
    }
    return clamp((fadeEndsAt - now) / (fadeEndsAt - fadeStartedAt), 0, 1);
  }

  if (status === SCENE_STATUS_PAUSED || status === TRACK_STATUS_PAUSED) {
    return 0;
  }

  return 1;
}

export function computeScenePlaybackGain(sceneRuntime, now = safeNow()) {
  return computeFadeGain({
    status: sceneRuntime?.status,
    fadeStartedAt: sceneRuntime?.fadeStartedAt,
    fadeEndsAt: sceneRuntime?.fadeEndsAt,
    now,
  });
}

export function computeTrackPlaybackGain(trackRuntime, now = safeNow()) {
  return computeFadeGain({
    status: trackRuntime?.status,
    fadeStartedAt: trackRuntime?.fadeStartedAt,
    fadeEndsAt: trackRuntime?.fadeEndsAt,
    now,
  });
}

export function computeSceneConfiguredLengthMs(sceneDefinition, durationByTrackId = {}) {
  if (!Array.isArray(sceneDefinition?.tracks) || !sceneDefinition.tracks.length) {
    return 0;
  }
  let maxLengthMs = 0;
  for (const track of sceneDefinition.tracks) {
    const rawDurationSec = Number(durationByTrackId?.[track.id] ?? durationByTrackId?.[track.trackId] ?? 0) || 0;
    const durationMs = Math.max(0, rawDurationSec * 1000);
    const trackSpanMs = Math.max(
      0,
      (Number(track.startDelayMs) || 0) + Math.max(0, durationMs - ((Number(track.startOffsetSec) || 0) * 1000)),
    );
    maxLengthMs = Math.max(maxLengthMs, trackSpanMs);
  }
  return maxLengthMs;
}

export function shouldSceneLoopRestart(sceneRuntime, sceneDefinition, durationByTrackId = {}, now = safeNow()) {
  if (!sceneRuntime?.loop) {
    return false;
  }
  const sceneLengthMs = computeSceneConfiguredLengthMs(sceneDefinition, durationByTrackId);
  if (!sceneLengthMs) {
    return false;
  }
  return computeSceneTimelinePosition(sceneRuntime, now) >= sceneLengthMs;
}

export function shouldSceneStop(sceneRuntime, sceneDefinition, durationByTrackId = {}, now = safeNow()) {
  if (sceneRuntime?.loop) {
    return false;
  }
  const sceneLengthMs = computeSceneConfiguredLengthMs(sceneDefinition, durationByTrackId);
  if (!sceneLengthMs) {
    return false;
  }
  return computeSceneTimelinePosition(sceneRuntime, now) >= sceneLengthMs;
}

export function shouldTrackSelfLoop(sceneRuntime, trackRuntime, durationSec = 0, now = safeNow()) {
  if (!trackRuntime?.loop) {
    return false;
  }
  const durationMs = Math.max(0, Number(durationSec) || 0) * 1000;
  if (!durationMs) {
    return false;
  }
  return computeTrackPlayheadMs(sceneRuntime, trackRuntime, now) >= durationMs;
}

export function buildActiveTrackPlaybackPlan(runtime, now = safeNow()) {
  const normalizedRuntime = ensureRoomRuntime(runtime);
  const entries = [];

  for (const scene of normalizedRuntime.activeScenes) {
    const sceneGain = computeScenePlaybackGain(scene, now);
    const scenePositionMs = computeSceneTimelinePosition(scene, now);
    const scenePaused = scene.status === SCENE_STATUS_PAUSED;

    for (const track of scene.tracks) {
      const trackReady = isTrackReadyToStart(scene, track, now);
      const trackGain = computeTrackPlaybackGain(track, now);
      const status = !trackReady
        ? TRACK_STATUS_QUEUED
        : scenePaused || track.status === TRACK_STATUS_PAUSED
          ? TRACK_STATUS_PAUSED
          : track.status;

      entries.push({
        slotId: buildPlaybackSlotId(scene.sceneId, track.trackId),
        sceneId: scene.sceneId,
        trackId: track.trackId,
        title: track.title,
        sourceType: track.sourceType,
        mediaType: track.mediaType,
        sourceId: track.sourceId,
        effectiveOrder: track.effectiveOrder,
        desiredStatus: status,
        scenePositionMs,
        playheadMs: computeTrackPlayheadMs(scene, track, now),
        startOffsetSec: track.startOffsetSec,
        startDelayMs: track.startDelayMs,
        sceneGain,
        trackGain,
        combinedGain: clamp(sceneGain * trackGain, 0, 1),
        loop: Boolean(track.loop),
        sceneLoop: Boolean(scene.loop),
      });
    }
  }

  return entries
    .sort((left, right) => (
      left.sceneId.localeCompare(right.sceneId)
      || left.effectiveOrder - right.effectiveOrder
      || left.title.localeCompare(right.title)
    ));
}
