import OBR from "@owlbear-rodeo/sdk";
import {
  BROADCAST_CHANNEL,
  CLIENT_STATUS_KEY,
  LOCAL_CONTROL_CHANNEL,
  ROOM_STATE_KEY,
  SEEK_TOLERANCE_SEC,
  TRANSPORT_PAUSED,
  TRANSPORT_PLAYING,
  TRANSPORT_STOPPED,
  clamp,
  createClientStatus,
  getLocalOutputVolume,
  safeNow,
  setLocalOutputVolume,
} from "./shared.js";
import {
  computeEffectiveTrackVolume,
  createEmptyRoomRuntime,
  ensureRoomRuntime,
} from "./scene-model.js";
import {
  finalizeRuntimeTransitions,
  computeSceneTimelinePosition,
} from "./scene-runtime.js";
import {
  buildPlaybackSlotId,
  computeSceneConfiguredLengthMs,
  computeScenePlaybackGain,
  computeTrackPlaybackGain,
} from "./scene-playback.js";
import { isConfirmedTrackEnd } from "./sync-logic.js";

const LOCAL_RECONCILE_INTERVAL_MS = 500;

const playerHost = document.getElementById("youtube-player-host");
const statusElement = document.getElementById("background-status");

let currentRuntime = createEmptyRoomRuntime();
let currentRuntimeKey = JSON.stringify(ensureRoomRuntime(currentRuntime));
let statusState = createClientStatus();
let youtubeApiPromise = null;
let reconcileIntervalHandle = null;
let reconcileInFlight = false;
let reconcilePending = false;
let pendingAnnounce = false;
let localOutputVolume = getLocalOutputVolume();
let lastStatusSummaryKey = "";
let currentPlanBySlotId = new Map();

const slots = new Map();

function updateBackgroundStatus(text) {
  if (statusElement) {
    statusElement.textContent = text;
  }
}

function normalizeRuntimeKey(runtime) {
  return JSON.stringify(ensureRoomRuntime(runtime));
}

function loadYouTubeApi() {
  if (window.YT?.Player) {
    publishClientStatus({
      youtubeApiReady: true,
      lastAction: "YouTube API already loaded",
    }).catch(() => {
      // Ignore metadata update failures.
    });
    return Promise.resolve(window.YT);
  }
  if (youtubeApiPromise) {
    return youtubeApiPromise;
  }
  youtubeApiPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-youtube-iframe-api="true"]');
    if (!existing) {
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.async = true;
      script.dataset.youtubeIframeApi = "true";
      script.onerror = () => reject(new Error("Failed to load YouTube IFrame API."));
      document.head.append(script);
    }
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      publishClientStatus({
        youtubeApiReady: true,
        lastAction: "YouTube API ready",
      }).catch(() => {
        // Ignore metadata update failures.
      });
      resolve(window.YT);
    };
  });
  return youtubeApiPromise;
}

function notifyLocal(message, variant = "INFO") {
  OBR.notification.show(message, variant).catch(() => {
    // Ignore notification failures.
  });
}

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function publishClientStatus(patch = {}) {
  statusState = createClientStatus({
    ...statusState,
    localOutputVolume,
    ...patch,
  });
  await OBR.player.setMetadata({
    [CLIENT_STATUS_KEY]: statusState,
  });
}

function clearScheduledPlayback(slot) {
  if (slot.scheduledPlayHandle) {
    window.clearTimeout(slot.scheduledPlayHandle);
    slot.scheduledPlayHandle = 0;
  }
  slot.scheduledActionKey = "";
}

async function getPlayerSnapshot(slot) {
  await slot.readyPromise;
  const player = slot.player;
  const videoData = typeof player.getVideoData === "function" ? player.getVideoData() : {};
  const snapshot = {
    currentTime: typeof player.getCurrentTime === "function"
      ? Number(player.getCurrentTime()) || 0
      : 0,
    playlistIndex: typeof player.getPlaylistIndex === "function"
      ? Math.max(0, Number(player.getPlaylistIndex()) || 0)
      : 0,
    playerState: typeof player.getPlayerState === "function"
      ? player.getPlayerState()
      : -1,
    videoId: typeof videoData?.video_id === "string" ? videoData.video_id : null,
    duration: typeof player.getDuration === "function"
      ? Math.max(0, Number(player.getDuration()) || 0)
      : 0,
  };
  if (snapshot.duration > 0) {
    slot.durationSec = snapshot.duration;
  }
  return snapshot;
}

function desiredSourceKey(entry) {
  return `${entry.mediaType}:${entry.sourceId}`;
}

function buildScheduledActionKey(entry, startAtMs) {
  return [
    desiredSourceKey(entry),
    Math.round(startAtMs / 25),
    Math.round(entry.desiredPositionSec * 1000),
    Math.round(entry.effectiveVolume),
  ].join("|");
}

function shouldReloadSlot(slot, entry) {
  return slot.sourceKey !== desiredSourceKey(entry);
}

function applyEntryVolume(slot, volume) {
  slot.player.setVolume(clamp(Number(volume) || 0, 0, 100));
}

function isPlayingState(playerState) {
  return playerState === window.YT?.PlayerState?.PLAYING
    || playerState === window.YT?.PlayerState?.BUFFERING;
}

function normalizeVolumeValue(value, fallback = 100) {
  const numeric = Number(value);
  return clamp(Number.isFinite(numeric) ? numeric : fallback, 0, 100);
}

async function createSlot(slotId) {
  const host = document.createElement("div");
  host.className = "youtube-player-slot";
  host.dataset.slotId = slotId;
  playerHost?.append(host);

  const slot = {
    slotId,
    host,
    player: null,
    readyPromise: null,
    sourceKey: "",
    scheduledActionKey: "",
    scheduledPlayHandle: 0,
    durationSec: 0,
  };

  slot.readyPromise = (async () => {
    const YT = await loadYouTubeApi();
    await new Promise((resolve) => {
      slot.player = new YT.Player(host, {
        width: "200",
        height: "200",
        playerVars: {
          controls: 0,
          disablekb: 1,
          fs: 0,
          playsinline: 1,
          rel: 0,
          iv_load_policy: 3,
          modestbranding: 1,
          origin: window.location.origin,
        },
        events: {
          onReady: () => resolve(),
          onStateChange: (event) => handlePlayerStateChange(slotId, event.data),
          onError: (event) => handlePlayerError(slotId, event.data),
          onAutoplayBlocked: () => handleAutoplayBlocked(slotId),
        },
      });
    });
  })();

  slots.set(slotId, slot);
  await publishClientStatus({
    slotCount: slots.size,
    lastAction: `Created slot for ${slotId}`,
  });
  return slot;
}

async function getSlot(slotId) {
  if (slots.has(slotId)) {
    return slots.get(slotId);
  }
  return createSlot(slotId);
}

async function destroySlot(slotId) {
  const slot = slots.get(slotId);
  if (!slot) {
    return;
  }
  clearScheduledPlayback(slot);
  try {
    await slot.readyPromise;
    if (typeof slot.player?.destroy === "function") {
      slot.player.destroy();
    }
  } catch {
    // Ignore destroy failures.
  }
  slot.host.remove();
  slots.delete(slotId);
}

function markEntryPrepared(slot, entry) {
  slot.sourceKey = desiredSourceKey(entry);
}

function cueEntryPlayback(slot, entry, desiredPositionSec) {
  if (entry.mediaType === "playlist") {
    slot.player.cuePlaylist({
      listType: "playlist",
      list: entry.sourceId,
      index: 0,
      startSeconds: desiredPositionSec,
    });
  } else {
    slot.player.cueVideoById({
      videoId: entry.sourceId,
      startSeconds: desiredPositionSec,
    });
  }
  markEntryPrepared(slot, entry);
}

function loadEntryPlayback(slot, entry, desiredPositionSec) {
  if (entry.mediaType === "playlist") {
    slot.player.loadPlaylist({
      listType: "playlist",
      list: entry.sourceId,
      index: 0,
      startSeconds: desiredPositionSec,
    });
  } else {
    slot.player.loadVideoById({
      videoId: entry.sourceId,
      startSeconds: desiredPositionSec,
    });
  }
  markEntryPrepared(slot, entry);
}

async function ensureEntryPrepared(slot, entry, desiredPositionSec, mode = "cue") {
  await slot.readyPromise;
  if (!shouldReloadSlot(slot, entry)) {
    return false;
  }

  if (mode === "load") {
    loadEntryPlayback(slot, entry, desiredPositionSec);
  } else {
    cueEntryPlayback(slot, entry, desiredPositionSec);
  }
  return true;
}

async function seekIfNeeded(slot, desiredPositionSec) {
  const snapshot = await getPlayerSnapshot(slot);
  if (Math.abs(snapshot.currentTime - desiredPositionSec) > SEEK_TOLERANCE_SEC) {
    slot.player.seekTo(desiredPositionSec, true);
  }
}

async function startEntryPlayback(slot, entry, reason = "Playback start") {
  const desiredPositionSec = Math.max(0, Number(entry.desiredPositionSec) || 0);
  const sourceChanged = await ensureEntryPrepared(slot, entry, desiredPositionSec, "cue");

  if (!sourceChanged) {
    await seekIfNeeded(slot, desiredPositionSec);
  }

  applyEntryVolume(slot, entry.effectiveVolume);
  slot.player.playVideo();
  await publishClientStatus({
    autoplayBlocked: false,
    lastAction: `${reason} for ${entry.title}`,
  });

  await wait(300);
  let snapshot = await getPlayerSnapshot(slot);
  if (isPlayingState(snapshot.playerState)) {
    return;
  }

  if (Math.abs(snapshot.currentTime - desiredPositionSec) > SEEK_TOLERANCE_SEC) {
    slot.player.seekTo(desiredPositionSec, true);
  }
  if (!isPlayingState(snapshot.playerState)) {
    slot.player.playVideo();
  }

  await wait(250);
  snapshot = await getPlayerSnapshot(slot);
  if (isPlayingState(snapshot.playerState) || !sourceChanged) {
    return;
  }

  loadEntryPlayback(slot, entry, desiredPositionSec);
  slot.player.playVideo();
}

function computeResolvedTrackTiming(scene, track, scenePositionMs, durationSec = 0) {
  const activationMs = Math.max(0, Number(track.activationScenePositionMs) || 0)
    + Math.max(0, Number(track.startDelayMs) || 0);
  const startOffsetSec = Math.max(0, Number(track.startOffsetSec) || 0);
  const startOffsetMs = startOffsetSec * 1000;

  if (scenePositionMs < activationMs) {
    return {
      ready: false,
      ended: false,
      desiredPositionSec: startOffsetSec,
      nextStartDelayMs: activationMs - scenePositionMs,
    };
  }

  let playheadMs = scenePositionMs - activationMs + startOffsetMs;
  const durationMs = Math.max(0, Number(durationSec) || 0) * 1000;

  if (durationMs > 0) {
    if (track.loop) {
      playheadMs %= durationMs;
    } else if (playheadMs >= durationMs) {
      return {
        ready: false,
        ended: true,
        desiredPositionSec: durationSec,
        nextStartDelayMs: 0,
      };
    }
  }

  return {
    ready: true,
    ended: false,
    desiredPositionSec: Math.max(0, playheadMs / 1000),
    nextStartDelayMs: 0,
  };
}

function sortScenes(runtime) {
  return runtime.activeScenes
    .slice()
    .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name));
}

function sortTracks(scene) {
  return scene.tracks
    .slice()
    .sort((left, right) => left.effectiveOrder - right.effectiveOrder || left.title.localeCompare(right.title));
}

function buildRuntimePlaybackPlan(runtime, now = safeNow()) {
  const normalizedRuntime = finalizeRuntimeTransitions(runtime, now);
  const entries = [];

  for (const scene of sortScenes(normalizedRuntime)) {
    const durationByTrackId = {};
    for (const track of scene.tracks) {
      const slot = slots.get(buildPlaybackSlotId(scene.sceneId, track.trackId));
      if (slot?.durationSec > 0) {
        durationByTrackId[track.trackId] = slot.durationSec;
      }
    }

    const sceneLengthMs = computeSceneConfiguredLengthMs(
      { tracks: scene.tracks },
      durationByTrackId,
    );
    const absoluteScenePositionMs = computeSceneTimelinePosition(scene, now);
    const cycleScenePositionMs = scene.loop && sceneLengthMs > 0
      ? absoluteScenePositionMs % sceneLengthMs
      : absoluteScenePositionMs;
    const sceneGain = computeScenePlaybackGain(scene, now);
    const scenePaused = scene.status === TRANSPORT_PAUSED;

    for (const track of sortTracks(scene)) {
      const durationSec = Number(durationByTrackId[track.trackId] || 0) || 0;
      const timing = computeResolvedTrackTiming(scene, track, cycleScenePositionMs, durationSec);
      let desiredStatus = TRANSPORT_PLAYING;

      if (track.status === TRANSPORT_STOPPED || timing.ended) {
        desiredStatus = TRANSPORT_STOPPED;
      } else if (scenePaused || track.status === TRANSPORT_PAUSED) {
        desiredStatus = TRANSPORT_PAUSED;
      } else if (!timing.ready) {
        desiredStatus = "queued";
      }

      const baseVolume = computeEffectiveTrackVolume({
        masterVolume: normalizedRuntime.transport.masterVolume,
        sceneVolume: scene.sceneVolume,
        trackVolume: track.volume,
        localPlayerVolume: localOutputVolume,
      });
      const trackGain = computeTrackPlaybackGain(track, now);

      entries.push({
        slotId: buildPlaybackSlotId(scene.sceneId, track.trackId),
        sceneId: scene.sceneId,
        trackId: track.trackId,
        title: track.title,
        sourceType: track.sourceType,
        mediaType: track.mediaType || "video",
        sourceId: track.sourceId,
        desiredStatus,
        desiredPositionSec: timing.desiredPositionSec,
        nextStartDelayMs: timing.nextStartDelayMs,
        effectiveVolume: clamp(baseVolume * sceneGain * trackGain, 0, 100),
      });
    }
  }

  return {
    runtime: normalizedRuntime,
    entries,
  };
}

async function scheduleEntryPlayback(slot, entry) {
  const startAtMs = safeNow() + Math.max(0, Number(entry.nextStartDelayMs) || 0);
  const actionKey = buildScheduledActionKey(entry, startAtMs);
  if (slot.scheduledActionKey === actionKey && slot.scheduledPlayHandle) {
    return;
  }

  clearScheduledPlayback(slot);
  slot.scheduledActionKey = actionKey;
  const delay = Math.max(0, startAtMs - safeNow());

  if (delay <= 75) {
    await startEntryPlayback(slot, entry, "Immediate play");
    return;
  }

  slot.scheduledPlayHandle = window.setTimeout(async () => {
    slot.scheduledPlayHandle = 0;
    slot.scheduledActionKey = "";
    try {
      await startEntryPlayback(slot, entry, "Scheduled play");
    } catch {
      // Ignore playback errors here; the player error handler will surface them.
    }
  }, delay);
}

async function applyEntryState(entry) {
  const slot = await getSlot(entry.slotId);
  await slot.readyPromise;
  applyEntryVolume(slot, entry.effectiveVolume);

  if (entry.desiredStatus === TRANSPORT_STOPPED) {
    clearScheduledPlayback(slot);
    await ensureEntryPrepared(slot, entry, entry.desiredPositionSec, "cue");
    slot.player.pauseVideo();
    try {
      await seekIfNeeded(slot, entry.desiredPositionSec);
    } catch {
      // Ignore seek failures while stopping a slot.
    }
    return;
  }

  if (entry.desiredStatus === "queued") {
    await ensureEntryPrepared(slot, entry, entry.desiredPositionSec, "cue");
    slot.player.pauseVideo();
    try {
      await seekIfNeeded(slot, entry.desiredPositionSec);
    } catch {
      // Ignore seek failures while queueing a slot.
    }
    if (entry.nextStartDelayMs > 0) {
      await scheduleEntryPlayback(slot, entry);
    } else {
      clearScheduledPlayback(slot);
    }
    return;
  }

  if (entry.desiredStatus === TRANSPORT_PAUSED) {
    clearScheduledPlayback(slot);
    await ensureEntryPrepared(slot, entry, entry.desiredPositionSec, "cue");
    await seekIfNeeded(slot, entry.desiredPositionSec);
    slot.player.pauseVideo();
    return;
  }

  if (entry.nextStartDelayMs > 75) {
    await ensureEntryPrepared(slot, entry, entry.desiredPositionSec, "cue");
    await scheduleEntryPlayback(slot, entry);
    return;
  }

  clearScheduledPlayback(slot);
  await startEntryPlayback(slot, entry, "Runtime play");
}

async function publishRuntimeSummary(runtime, entries, forceLastAction = null) {
  const summaryKey = JSON.stringify({
    transportStatus: runtime.transport.status,
    slotCount: slots.size,
    activeTitles: entries.map((entry) => entry.title),
  });
  if (!forceLastAction && summaryKey === lastStatusSummaryKey) {
    return;
  }
  lastStatusSummaryKey = summaryKey;
  await publishClientStatus({
    engineReady: true,
    backgroundConnected: true,
    youtubeApiReady: Boolean(window.YT?.Player),
    audioPrimed: statusState.audioPrimed,
    autoplayBlocked: statusState.autoplayBlocked,
    errors: statusState.errors,
    transportStatus: runtime.transport.status,
    slotCount: slots.size,
    lastAction: forceLastAction || statusState.lastAction,
    activeLayerTitles: entries.map((entry) => entry.title),
  });
}

async function performReconcile(announce = false) {
  const { runtime, entries } = buildRuntimePlaybackPlan(currentRuntime, safeNow());
  currentPlanBySlotId = new Map(entries.map((entry) => [entry.slotId, entry]));

  const activeSlotIds = new Set(entries.map((entry) => entry.slotId));
  for (const slotId of Array.from(slots.keys())) {
    if (!activeSlotIds.has(slotId)) {
      await destroySlot(slotId);
    }
  }

  for (const entry of entries) {
    await applyEntryState(entry);
  }

  await publishRuntimeSummary(
    runtime,
    entries,
    announce
      ? `Applied runtime update (${entries.length} active slot${entries.length === 1 ? "" : "s"})`
      : null,
  );

  updateBackgroundStatus(
    entries.length
      ? `Audio engine ready: ${runtime.transport.status} (${entries.length} active slot${entries.length === 1 ? "" : "s"})`
      : "Audio engine ready: no active slots",
  );
}

async function reconcilePlayback(announce = false) {
  pendingAnnounce = pendingAnnounce || announce;
  if (reconcileInFlight) {
    reconcilePending = true;
    return;
  }

  reconcileInFlight = true;
  try {
    do {
      const runAnnounce = pendingAnnounce;
      reconcilePending = false;
      pendingAnnounce = false;
      await performReconcile(runAnnounce);
    } while (reconcilePending);
  } finally {
    reconcileInFlight = false;
  }
}

async function applyRuntime(runtime) {
  const normalizedRuntime = ensureRoomRuntime(runtime);
  const nextKey = normalizeRuntimeKey(normalizedRuntime);
  currentRuntime = normalizedRuntime;
  if (nextKey === currentRuntimeKey) {
    await reconcilePlayback(false);
    return;
  }
  currentRuntimeKey = nextKey;
  await reconcilePlayback(true);
}

function pickPrimeEntry(runtimeOverride = null) {
  const { entries } = buildRuntimePlaybackPlan(runtimeOverride || currentRuntime, safeNow());
  return entries.find((entry) => entry.desiredStatus === TRANSPORT_PLAYING)
    || entries.find((entry) => entry.desiredStatus === "queued")
    || entries[0]
    || null;
}

async function primeLocalAudio(runtimeOverride = null) {
  const entry = pickPrimeEntry(runtimeOverride);
  if (!entry) {
    await publishClientStatus({
      lastAction: "Prime requested, but there are no queued tracks",
    });
    return;
  }

  const slot = await getSlot(entry.slotId);
  await ensureEntryPrepared(slot, entry, entry.desiredPositionSec, "cue");

  try {
    if (typeof slot.player.mute === "function") {
      slot.player.mute();
    }
    slot.player.setVolume(0);
    slot.player.playVideo();
    await wait(250);
    slot.player.pauseVideo();
    slot.player.seekTo(entry.desiredPositionSec, true);
    if (typeof slot.player.unMute === "function") {
      slot.player.unMute();
    }
    applyEntryVolume(slot, entry.effectiveVolume);
    await publishClientStatus({
      audioPrimed: true,
      autoplayBlocked: false,
      slotCount: slots.size,
      lastAction: `Primed audio with ${entry.title}`,
    });
  } catch {
    // Errors are surfaced via YouTube callbacks.
  }
}

async function handlePlayerStateChange(slotId, playerState) {
  if (window.YT?.PlayerState?.ENDED !== playerState) {
    return;
  }

  const slot = slots.get(slotId);
  if (!slot) {
    return;
  }

  const snapshot = await getPlayerSnapshot(slot);
  if (!isConfirmedTrackEnd(snapshot)) {
    const entry = currentPlanBySlotId.get(slotId);
    if (entry?.desiredStatus === TRANSPORT_PLAYING) {
      await startEntryPlayback(slot, entry, "Recovered from false ENDED");
    }
    return;
  }

  const entry = currentPlanBySlotId.get(slotId);
  if (!entry) {
    return;
  }

  await reconcilePlayback(false);
  const nextEntry = currentPlanBySlotId.get(slotId);
  if (nextEntry?.desiredStatus === TRANSPORT_PLAYING) {
    await startEntryPlayback(slot, nextEntry, "Loop recovery");
  }
}

async function handlePlayerError(slotId, code) {
  const message = code === 101 || code === 150
    ? `Layer ${slotId} cannot be embedded by YouTube (error ${code}).`
    : `Layer ${slotId} failed with YouTube error ${code}.`;

  const nextErrors = [...(statusState.errors || []), message].slice(-8);
  await publishClientStatus({
    ...statusState,
    errors: nextErrors,
    lastAction: `YouTube error ${code} for ${slotId}`,
  });
  notifyLocal(message, "WARNING");
}

async function handleAutoplayBlocked(slotId) {
  const message = `Autoplay was blocked for layer ${slotId}. Open the extension panel and retry audio on this browser.`;
  await publishClientStatus({
    ...statusState,
    audioPrimed: false,
    autoplayBlocked: true,
    errors: [...(statusState.errors || []), message].slice(-8),
    lastAction: `Autoplay blocked for ${slotId}`,
  });
  notifyLocal(message, "WARNING");
}

async function retryLocalAudio() {
  const activeEntries = Array.from(currentPlanBySlotId.values()).filter(
    (entry) => entry.desiredStatus === TRANSPORT_PLAYING,
  );
  for (const entry of activeEntries) {
    const slot = slots.get(entry.slotId);
    if (!slot) {
      continue;
    }
    clearScheduledPlayback(slot);
    await startEntryPlayback(slot, entry, "Manual retry");
  }
  await publishClientStatus({
    ...statusState,
    autoplayBlocked: false,
    audioPrimed: true,
    lastAction: "Manual retry requested",
  });
}

async function applyLocalVolumeToActiveSlots() {
  await reconcilePlayback(false);
}

function resetReconcileLoop() {
  if (reconcileIntervalHandle) {
    window.clearInterval(reconcileIntervalHandle);
    reconcileIntervalHandle = null;
  }
  reconcileIntervalHandle = window.setInterval(() => {
    reconcilePlayback(false).catch(() => {
      // Ignore local reconcile failures so the interval can continue.
    });
  }, LOCAL_RECONCILE_INTERVAL_MS);
}

OBR.onReady(async () => {
  await publishClientStatus({
    engineReady: true,
    backgroundConnected: true,
    youtubeApiReady: Boolean(window.YT?.Player),
    audioPrimed: statusState.audioPrimed,
    slotCount: slots.size,
    lastAction: "Background engine initialized",
  });

  const metadata = await OBR.room.getMetadata();
  await applyRuntime(metadata[ROOM_STATE_KEY]);
  resetReconcileLoop();

  OBR.room.onMetadataChange((nextMetadata) => {
    applyRuntime(nextMetadata[ROOM_STATE_KEY]).catch(() => {
      // Ignore transient room-runtime errors.
    });
  });

  OBR.broadcast.onMessage(BROADCAST_CHANNEL, (event) => {
    if (!event.data?.roomState) {
      return;
    }
    applyRuntime(event.data.roomState).catch(() => {
      // Ignore transient broadcast errors.
    });
  });

  OBR.broadcast.onMessage(LOCAL_CONTROL_CHANNEL, (event) => {
    if (event.data?.type === "retry-local-audio") {
      retryLocalAudio().catch(() => {
        // Ignore local retry failures.
      });
      return;
    }
    if (event.data?.type === "prime-local-audio") {
      const runtimeOverride = ensureRoomRuntime(event.data?.roomRuntime || currentRuntime);
      applyRuntime(runtimeOverride)
        .then(() => primeLocalAudio(runtimeOverride))
        .then(() => {
          if (event.data?.resumeIfPlaying === false || runtimeOverride.transport.status !== TRANSPORT_PLAYING) {
            return null;
          }
          return retryLocalAudio();
        })
        .catch(() => {
          // Ignore local prime failures.
        });
      return;
    }
    if (event.data?.type === "set-local-volume") {
      localOutputVolume = normalizeVolumeValue(event.data?.volume);
      setLocalOutputVolume(localOutputVolume);
      applyLocalVolumeToActiveSlots().catch(() => {
        // Ignore local volume update failures.
      });
    }
  });
});
