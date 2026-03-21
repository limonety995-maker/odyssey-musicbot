import OBR from "@owlbear-rodeo/sdk";
import {
  BROADCAST_CHANNEL,
  CLIENT_STATUS_KEY,
  LOCAL_CONTROL_CHANNEL,
  ROOM_STATE_KEY,
  SEEK_TOLERANCE_SEC,
  SYNC_INTERVAL_MS,
  TRANSPORT_PAUSED,
  TRANSPORT_PLAYING,
  TRANSPORT_STOPPED,
  clamp,
  computeLayerPosition,
  createClientStatus,
  createEmptyRoomState,
  deepClone,
  ensureRoomState,
  safeNow,
} from "./shared.js";

const playerHost = document.getElementById("youtube-player-host");
const statusElement = document.getElementById("background-status");

let currentRoomState = createEmptyRoomState();
let isGm = false;
let syncIntervalHandle = null;
let statusState = createClientStatus();
let writeInFlight = false;
let youtubeApiPromise = null;

const slots = new Map();

function updateBackgroundStatus(text) {
  if (statusElement) {
    statusElement.textContent = text;
  }
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
    ...patch,
  });
  await OBR.player.setMetadata({
    [CLIENT_STATUS_KEY]: statusState,
  });
}

function clearScheduledPlay(slot) {
  if (slot.scheduledPlayHandle) {
    window.clearTimeout(slot.scheduledPlayHandle);
    slot.scheduledPlayHandle = 0;
  }
}

async function getPlayerSnapshot(slot) {
  await slot.readyPromise;
  const player = slot.player;
  const videoData = typeof player.getVideoData === "function" ? player.getVideoData() : {};
  return {
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
  };
}

function desiredSourceKey(layer) {
  return `${layer.sourceType}:${layer.sourceId}`;
}

async function createSlot(layerId) {
  const host = document.createElement("div");
  host.className = "youtube-player-slot";
  host.dataset.layerId = layerId;
  playerHost?.append(host);

  const slot = {
    layerId,
    host,
    player: null,
    readyPromise: null,
    sourceKey: "",
    playlistIndex: 0,
    lastCycle: 0,
    scheduledPlayHandle: 0,
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
          onStateChange: (event) => handlePlayerStateChange(layerId, event.data),
          onError: (event) => handlePlayerError(layerId, event.data),
          onAutoplayBlocked: () => handleAutoplayBlocked(layerId),
        },
      });
    });
  })();

  slots.set(layerId, slot);
  publishClientStatus({
    slotCount: slots.size,
    lastAction: `Created slot for ${layerId}`,
  }).catch(() => {
    // Ignore metadata update failures.
  });
  return slot;
}

async function getSlot(layerId) {
  if (slots.has(layerId)) {
    return slots.get(layerId);
  }
  return createSlot(layerId);
}

async function destroySlot(layerId) {
  const slot = slots.get(layerId);
  if (!slot) {
    return;
  }
  clearScheduledPlay(slot);
  try {
    await slot.readyPromise;
    if (typeof slot.player?.destroy === "function") {
      slot.player.destroy();
    }
  } catch {
    // Ignore destroy failures.
  }
  slot.host.remove();
  slots.delete(layerId);
  await publishClientStatus({
    slotCount: slots.size,
    lastAction: `Removed slot for ${layerId}`,
  });
}

async function ensureLayerLoaded(slot, layer, desiredPositionSec) {
  await slot.readyPromise;
  const player = slot.player;
  const sourceKey = desiredSourceKey(layer);
  const needsReload = slot.sourceKey !== sourceKey
    || slot.lastCycle !== layer.runtime.cycle
    || (layer.sourceType === "playlist" && slot.playlistIndex !== layer.runtime.playlistIndex);

  if (!needsReload) {
    return;
  }

  if (layer.sourceType === "playlist") {
    player.cuePlaylist({
      listType: "playlist",
      list: layer.sourceId,
      index: layer.runtime.playlistIndex,
      startSeconds: desiredPositionSec,
    });
    slot.playlistIndex = layer.runtime.playlistIndex;
  } else {
    player.cueVideoById({
      videoId: layer.sourceId,
      startSeconds: desiredPositionSec,
    });
  }

  slot.sourceKey = sourceKey;
  slot.lastCycle = layer.runtime.cycle;
}

async function seekIfNeeded(slot, desiredPositionSec) {
  const snapshot = await getPlayerSnapshot(slot);
  if (Math.abs(snapshot.currentTime - desiredPositionSec) > SEEK_TOLERANCE_SEC) {
    slot.player.seekTo(desiredPositionSec, true);
  }
}

async function schedulePlayback(slot, layer) {
  clearScheduledPlay(slot);
  const startAt = layer.runtime.playingSince || safeNow();
  const now = safeNow();
  const delay = Math.max(0, startAt - now);
  await publishClientStatus({
    lastAction: `Scheduled play for ${layer.title} in ${delay}ms`,
  });
  slot.scheduledPlayHandle = window.setTimeout(async () => {
    const position = computeLayerPosition(layer, safeNow());
    try {
      await seekIfNeeded(slot, position);
      slot.player.playVideo();
      await publishClientStatus({
        autoplayBlocked: false,
        lastAction: `playVideo() called for ${layer.title}`,
      });
    } catch {
      // Ignore playback errors here. The player error handler will surface them.
    }
  }, delay);
}

async function primeLocalAudio(roomStateOverride = null) {
  const primeState = ensureRoomState(roomStateOverride || currentRoomState);
  if (!primeState.layers.length) {
    await publishClientStatus({
      lastAction: "Prime requested, but there are no queued layers",
    });
    return;
  }

  for (const layer of primeState.layers) {
    const slot = await getSlot(layer.id);
    const desiredPositionSec = Math.max(0, layer.startSeconds || 0);
    await ensureLayerLoaded(slot, layer, desiredPositionSec);
    try {
      slot.player.setVolume(0);
      slot.player.playVideo();
      await wait(250);
      slot.player.pauseVideo();
      slot.player.seekTo(desiredPositionSec, true);
      slot.player.setVolume(clamp((primeState.transport.masterVolume * layer.volume) / 100, 0, 100));
      await publishClientStatus({
        autoplayBlocked: false,
        slotCount: slots.size,
        lastAction: `Primed audio for ${layer.title}`,
      });
    } catch {
      // Errors are surfaced via YouTube callbacks.
    }
  }
}

async function applyLayerState(layer, transport) {
  const slot = await getSlot(layer.id);
  await slot.readyPromise;

  const effectiveVolume = clamp((transport.masterVolume * layer.volume) / 100, 0, 100);
  slot.player.setVolume(effectiveVolume);

  const desiredPositionSec = computeLayerPosition(layer, safeNow());
  await ensureLayerLoaded(slot, layer, desiredPositionSec);

  if (transport.status === TRANSPORT_STOPPED || layer.runtime.status === TRANSPORT_STOPPED) {
    clearScheduledPlay(slot);
    slot.player.stopVideo();
    try {
      slot.player.seekTo(layer.startSeconds, true);
    } catch {
      // Ignore seek failures while stopped.
    }
    return;
  }

  if (transport.status === TRANSPORT_PAUSED || layer.runtime.status === TRANSPORT_PAUSED) {
    clearScheduledPlay(slot);
    await seekIfNeeded(slot, desiredPositionSec);
    slot.player.pauseVideo();
    return;
  }

  await seekIfNeeded(slot, desiredPositionSec);
  await schedulePlayback(slot, layer);
}

async function applyRoomState(roomState) {
  currentRoomState = ensureRoomState(roomState);
  const activeLayerIds = new Set(currentRoomState.layers.map((layer) => layer.id));

  for (const slotId of Array.from(slots.keys())) {
    if (!activeLayerIds.has(slotId)) {
      await destroySlot(slotId);
    }
  }

  for (const layer of currentRoomState.layers) {
    await applyLayerState(layer, currentRoomState.transport);
  }

  await publishClientStatus({
    engineReady: true,
    backgroundConnected: true,
    youtubeApiReady: Boolean(window.YT?.Player),
    autoplayBlocked: statusState.autoplayBlocked,
    errors: statusState.errors,
    transportStatus: currentRoomState.transport.status,
    slotCount: slots.size,
    lastAction: `Applied room state revision ${currentRoomState.revision}`,
    activeLayerTitles: currentRoomState.layers.map((layer) => layer.title),
  });

  updateBackgroundStatus(
    currentRoomState.layers.length
      ? `Audio engine ready: ${currentRoomState.transport.status} (${currentRoomState.layers.length} active layer${currentRoomState.layers.length === 1 ? "" : "s"})`
      : "Audio engine ready: no active layers",
  );
}

async function writeRoomState(nextState, shouldBroadcast = true) {
  const normalized = ensureRoomState(nextState);
  normalized.revision = currentRoomState.revision + 1;
  currentRoomState = normalized;
  await OBR.room.setMetadata({
    [ROOM_STATE_KEY]: normalized,
  });
  if (shouldBroadcast) {
    await OBR.broadcast.sendMessage(
      BROADCAST_CHANNEL,
      { roomState: normalized },
      { destination: "ALL" },
    );
  }
}

async function handlePlayerStateChange(layerId, playerState) {
  if (!isGm) {
    return;
  }
  const layer = currentRoomState.layers.find((entry) => entry.id === layerId);
  if (!layer) {
    return;
  }

  if (layer.sourceType === "playlist") {
    return;
  }

  if (window.YT?.PlayerState?.ENDED !== playerState) {
    return;
  }

  if (writeInFlight) {
    return;
  }
  writeInFlight = true;

  try {
    const next = deepClone(currentRoomState);
    const nextLayer = next.layers.find((entry) => entry.id === layerId);
    if (!nextLayer) {
      return;
    }

    if (nextLayer.loop) {
      const now = safeNow();
      next.transport.status = TRANSPORT_PLAYING;
      next.transport.changedAt = now + 1500;
      nextLayer.runtime.status = TRANSPORT_PLAYING;
      nextLayer.runtime.pauseOffsetSec = nextLayer.startSeconds;
      nextLayer.runtime.playingSince = now + 1500;
      nextLayer.runtime.cycle += 1;
      nextLayer.runtime.playlistIndex = 0;
      nextLayer.runtime.playlistVideoId = null;
      nextLayer.runtime.lastSyncAt = now;
      await writeRoomState(next);
      return;
    }

    nextLayer.runtime.status = TRANSPORT_STOPPED;
    nextLayer.runtime.pauseOffsetSec = nextLayer.startSeconds;
    nextLayer.runtime.playingSince = null;
    nextLayer.runtime.playlistIndex = 0;
    nextLayer.runtime.playlistVideoId = null;
    nextLayer.runtime.lastSyncAt = safeNow();
    if (next.layers.every((entry) => entry.runtime.status === TRANSPORT_STOPPED)) {
      next.transport.status = TRANSPORT_STOPPED;
      next.transport.changedAt = safeNow();
    }
    await writeRoomState(next);
  } finally {
    writeInFlight = false;
  }
}

async function handlePlayerError(layerId, code) {
  const message = code === 101 || code === 150
    ? `Layer ${layerId} cannot be embedded by YouTube (error ${code}).`
    : `Layer ${layerId} failed with YouTube error ${code}.`;

  const nextErrors = [...(statusState.errors || []), message].slice(-8);
  await publishClientStatus({
    ...statusState,
    errors: nextErrors,
    lastAction: `YouTube error ${code} for ${layerId}`,
  });
  notifyLocal(message, "WARNING");
}

async function handleAutoplayBlocked(layerId) {
  const message = `Autoplay was blocked for layer ${layerId}. Open the extension panel and retry audio on this browser.`;
  await publishClientStatus({
    ...statusState,
    autoplayBlocked: true,
    errors: [...(statusState.errors || []), message].slice(-8),
    lastAction: `Autoplay blocked for ${layerId}`,
  });
  notifyLocal(message, "WARNING");
}

async function retryLocalAudio() {
  const transport = currentRoomState.transport;
  if (transport.status !== TRANSPORT_PLAYING) {
    return;
  }
  for (const layer of currentRoomState.layers) {
    if (layer.runtime.status !== TRANSPORT_PLAYING) {
      continue;
    }
    const slot = slots.get(layer.id);
    if (!slot) {
      continue;
    }
    clearScheduledPlay(slot);
    await schedulePlayback(slot, layer);
  }
  await publishClientStatus({
    ...statusState,
    autoplayBlocked: false,
    lastAction: "Manual retry requested",
  });
}

async function gmPeriodicSync() {
  if (!isGm || currentRoomState.transport.status !== TRANSPORT_PLAYING || writeInFlight) {
    return;
  }

  writeInFlight = true;
  try {
    const next = deepClone(currentRoomState);
    const now = safeNow();
    let changed = false;

    for (const layer of next.layers) {
      if (layer.runtime.status !== TRANSPORT_PLAYING) {
        continue;
      }
      const slot = slots.get(layer.id);
      if (!slot) {
        continue;
      }
      const snapshot = await getPlayerSnapshot(slot);
      if (window.YT?.PlayerState?.ENDED === snapshot.playerState) {
        if (layer.loop) {
          layer.runtime.pauseOffsetSec = layer.startSeconds;
          layer.runtime.playingSince = now + 1500;
          layer.runtime.cycle += 1;
          layer.runtime.playlistIndex = 0;
          layer.runtime.playlistVideoId = null;
          layer.runtime.lastSyncAt = now;
        } else {
          layer.runtime.status = TRANSPORT_STOPPED;
          layer.runtime.pauseOffsetSec = layer.startSeconds;
          layer.runtime.playingSince = null;
          layer.runtime.playlistIndex = 0;
          layer.runtime.playlistVideoId = null;
          layer.runtime.lastSyncAt = now;
        }
        changed = true;
        continue;
      }
      const expectedPosition = computeLayerPosition(layer, now);
      if (
        Math.abs(snapshot.currentTime - expectedPosition) > 0.8
        || snapshot.playlistIndex !== layer.runtime.playlistIndex
        || snapshot.videoId !== layer.runtime.playlistVideoId
      ) {
        layer.runtime.pauseOffsetSec = snapshot.currentTime;
        layer.runtime.playingSince = now;
        layer.runtime.playlistIndex = snapshot.playlistIndex;
        layer.runtime.playlistVideoId = snapshot.videoId;
        layer.runtime.lastSyncAt = now;
        changed = true;
      }
    }

    if (changed) {
      if (next.layers.every((entry) => entry.runtime.status === TRANSPORT_STOPPED)) {
        next.transport.status = TRANSPORT_STOPPED;
      }
      next.transport.changedAt = now;
      await writeRoomState(next);
    }
  } finally {
    writeInFlight = false;
  }
}

function resetSyncLoop() {
  if (syncIntervalHandle) {
    window.clearInterval(syncIntervalHandle);
    syncIntervalHandle = null;
  }
  if (!isGm) {
    return;
  }
  syncIntervalHandle = window.setInterval(() => {
    gmPeriodicSync().catch(() => {
      // Ignore sync loop failures so the interval can continue.
    });
  }, SYNC_INTERVAL_MS);
}

OBR.onReady(async () => {
  isGm = (await OBR.player.getRole()) === "GM";
  await publishClientStatus({
    engineReady: true,
    backgroundConnected: true,
    youtubeApiReady: Boolean(window.YT?.Player),
    slotCount: slots.size,
    lastAction: "Background engine initialized",
  });
  const metadata = await OBR.room.getMetadata();
  await applyRoomState(metadata[ROOM_STATE_KEY]);
  resetSyncLoop();

  OBR.room.onMetadataChange((nextMetadata) => {
    applyRoomState(nextMetadata[ROOM_STATE_KEY]).catch(() => {
      // Ignore transient room-state errors.
    });
  });

  OBR.broadcast.onMessage(BROADCAST_CHANNEL, (event) => {
    if (!event.data?.roomState) {
      return;
    }
    applyRoomState(event.data.roomState).catch(() => {
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
      primeLocalAudio(event.data?.roomState).catch(() => {
        // Ignore local prime failures.
      });
    }
  });

  OBR.player.onChange((player) => {
    isGm = player.role === "GM";
    resetSyncLoop();
  });
});
