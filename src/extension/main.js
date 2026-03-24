import OBR from "@owlbear-rodeo/sdk";
import {
  BROADCAST_CHANNEL,
  CLIENT_STATUS_KEY,
  LOCAL_CONTROL_CHANNEL,
  ROOM_STATE_KEY,
  SCENE_LIBRARY_KEY,
  START_LEAD_MS,
  TRANSPORT_PAUSED,
  TRANSPORT_PLAYING,
  TRANSPORT_STOPPED,
  clamp,
  computeLayerPosition,
  createEmptyRoomState,
  createEmptySceneLibrary,
  createLayer,
  deepClone,
  ensureRoomState,
  ensureSceneLibrary,
  formatSourceType,
  getLocalOutputVolume,
  makeId,
  parseSupportedTrackUrl,
  safeNow,
  setLocalOutputVolume,
  stripLayerForScene,
  summarizeTransport,
} from "./shared.js";

const root = document.getElementById("app");

const state = {
  role: "PLAYER",
  roomState: createEmptyRoomState(),
  library: createEmptySceneLibrary(),
  loading: true,
  busy: false,
  draft: {
    url: "",
    title: "",
    sceneName: "",
  },
  localClientStatus: null,
  localOutputVolume: getLocalOutputVolume(),
  lastError: "",
  notices: [],
  view: "mix",
};

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function isGm() {
  return state.role === "GM";
}

function normalizeVolumeValue(value, fallback = 100) {
  const numeric = Number(value);
  return clamp(Number.isFinite(numeric) ? numeric : fallback, 0, 100);
}

function setBusy(value) {
  state.busy = value;
  render();
}

function setError(message) {
  state.lastError = message || "";
  render();
}

function clearError() {
  if (state.lastError) {
    state.lastError = "";
    render();
  }
}

function setNotices(messages = []) {
  state.notices = Array.isArray(messages) ? messages.filter(Boolean).slice(0, 4) : [];
}

async function refreshRoomData() {
  const metadata = await OBR.room.getMetadata();
  state.roomState = ensureRoomState(metadata[ROOM_STATE_KEY]);
  state.library = ensureSceneLibrary(metadata[SCENE_LIBRARY_KEY]);
}

async function refreshLocalClientStatus() {
  const metadata = await OBR.player.getMetadata();
  if (metadata[CLIENT_STATUS_KEY]) {
    state.localClientStatus = metadata[CLIENT_STATUS_KEY];
  }
  state.localOutputVolume = clamp(
    Number(state.localClientStatus?.localOutputVolume ?? getLocalOutputVolume()),
    0,
    100,
  );
}

function syncLocalStatusFromPlayer(player) {
  const nextStatus = player?.metadata?.[CLIENT_STATUS_KEY];
  if (nextStatus) {
    state.localClientStatus = nextStatus;
  }
  state.localOutputVolume = normalizeVolumeValue(
    state.localClientStatus?.localOutputVolume ?? getLocalOutputVolume(),
  );
}

async function pushRoomState(nextState) {
  const normalized = ensureRoomState(nextState);
  await OBR.room.setMetadata({
    [ROOM_STATE_KEY]: normalized,
  });
  await OBR.broadcast.sendMessage(
    BROADCAST_CHANNEL,
    { roomState: normalized },
    { destination: "ALL" },
  );
  state.roomState = normalized;
}

async function mutateRoomState(mutator) {
  const metadata = await OBR.room.getMetadata();
  const current = ensureRoomState(metadata[ROOM_STATE_KEY]);
  const draft = deepClone(current);
  const changed = mutator(draft, current);
  if (changed === false) {
    return;
  }
  draft.revision = current.revision + 1;
  await pushRoomState(draft);
}

async function pushSceneLibrary(nextLibrary) {
  const normalized = ensureSceneLibrary(nextLibrary);
  await OBR.room.setMetadata({
    [SCENE_LIBRARY_KEY]: normalized,
  });
  state.library = normalized;
}

async function mutateSceneLibrary(mutator) {
  const metadata = await OBR.room.getMetadata();
  const current = ensureSceneLibrary(metadata[SCENE_LIBRARY_KEY]);
  const draft = deepClone(current);
  const changed = mutator(draft, current);
  if (changed === false) {
    return;
  }
  draft.updatedAt = safeNow();
  await pushSceneLibrary(draft);
}

function buildPlayStateFromCurrent(currentState) {
  const now = safeNow();
  const startAt = now + START_LEAD_MS;
  const next = deepClone(currentState);
  next.transport.status = TRANSPORT_PLAYING;
  next.transport.changedAt = startAt;
  for (const layer of next.layers) {
    const currentPosition = currentState.transport.status === TRANSPORT_PLAYING
      ? computeLayerPosition(layer, now)
      : layer.runtime.status === TRANSPORT_STOPPED
        ? layer.startSeconds
        : layer.runtime.pauseOffsetSec;
    layer.runtime.status = TRANSPORT_PLAYING;
    layer.runtime.pauseOffsetSec = currentPosition;
    layer.runtime.playingSince = startAt;
    layer.runtime.lastSyncAt = now;
  }
  return next;
}

function buildPauseStateFromCurrent(currentState) {
  const now = safeNow();
  const next = deepClone(currentState);
  next.transport.status = TRANSPORT_PAUSED;
  next.transport.changedAt = now;
  for (const layer of next.layers) {
    layer.runtime.pauseOffsetSec = computeLayerPosition(layer, now);
    layer.runtime.status = TRANSPORT_PAUSED;
    layer.runtime.playingSince = null;
    layer.runtime.lastSyncAt = now;
  }
  return next;
}

function buildStopStateFromCurrent(currentState) {
  const now = safeNow();
  const next = deepClone(currentState);
  next.transport.status = TRANSPORT_STOPPED;
  next.transport.changedAt = now;
  for (const layer of next.layers) {
    layer.runtime.status = TRANSPORT_STOPPED;
    layer.runtime.pauseOffsetSec = layer.startSeconds;
    layer.runtime.playingSince = null;
    layer.runtime.playlistIndex = 0;
    layer.runtime.playlistVideoId = null;
    layer.runtime.lastSyncAt = now;
  }
  return next;
}

async function addResolvedTrack(track) {
  await mutateRoomState((draft, current) => {
    const nextLayer = createLayer(track);
    const now = safeNow();
    if (current.transport.status === TRANSPORT_PLAYING) {
      nextLayer.runtime.status = TRANSPORT_PLAYING;
      nextLayer.runtime.pauseOffsetSec = nextLayer.startSeconds;
      nextLayer.runtime.playingSince = now + START_LEAD_MS;
    } else if (current.transport.status === TRANSPORT_PAUSED) {
      nextLayer.runtime.status = TRANSPORT_PAUSED;
      nextLayer.runtime.pauseOffsetSec = nextLayer.startSeconds;
    } else {
      nextLayer.runtime.status = TRANSPORT_STOPPED;
      nextLayer.runtime.pauseOffsetSec = nextLayer.startSeconds;
    }
    nextLayer.runtime.lastSyncAt = now;
    draft.layers.push(nextLayer);
    if (!draft.activeScene) {
      draft.activeScene = {
        id: "live-mix",
        name: "Live mix",
      };
    }
    draft.transport.changedAt = current.transport.status === TRANSPORT_PLAYING
      ? now + START_LEAD_MS
      : now;
  });
}

async function handleAddTrack() {
  const url = state.draft.url.trim();
  if (!url) {
    setError("Paste a YouTube or YouTube Music link first.");
    return;
  }
  setBusy(true);
  clearError();
  try {
    const resolved = parseSupportedTrackUrl(url);
    setNotices(resolved.warnings);
    await addResolvedTrack({
      title: state.draft.title.trim() || resolved.fallbackTitle,
      url: resolved.url,
      sourceType: resolved.sourceType,
      sourceId: resolved.sourceId,
      origin: resolved.origin,
      volume: 100,
      loop: false,
      startSeconds: 0,
    });
    state.draft.url = "";
    state.draft.title = "";
    render();
  } catch (error) {
    setError(error instanceof Error ? error.message : "Failed to add track.");
  } finally {
    setBusy(false);
  }
}

async function handlePlayMix() {
  await unlockLocalAudio();
  await mutateRoomState((draft, current) => {
    if (!draft.layers.length) {
      return false;
    }
    Object.assign(draft, buildPlayStateFromCurrent(current));
  });
}

async function handlePauseMix() {
  await mutateRoomState((draft, current) => {
    if (!draft.layers.length) {
      return false;
    }
    Object.assign(draft, buildPauseStateFromCurrent(current));
  });
}

async function handleStopMix() {
  await mutateRoomState((draft, current) => {
    if (!draft.layers.length) {
      return false;
    }
    Object.assign(draft, buildStopStateFromCurrent(current));
  });
}

async function handleRemoveLayer(layerId) {
  await mutateRoomState((draft) => {
    draft.layers = draft.layers.filter((layer) => layer.id !== layerId);
    if (!draft.layers.length) {
      draft.transport.status = TRANSPORT_STOPPED;
      draft.transport.changedAt = safeNow();
      draft.activeScene = null;
    }
  });
}

async function handleLayerVolume(layerId, volume) {
  await mutateRoomState((draft) => {
    const layer = draft.layers.find((item) => item.id === layerId);
    if (!layer) {
      return false;
    }
    layer.volume = clamp(Number(volume), 0, 100);
  });
}

async function handleLayerLoop(layerId, loop) {
  await mutateRoomState((draft) => {
    const layer = draft.layers.find((item) => item.id === layerId);
    if (!layer) {
      return false;
    }
    layer.loop = Boolean(loop);
  });
}

async function handleMasterVolume(volume) {
  await mutateRoomState((draft) => {
    draft.transport.masterVolume = clamp(Number(volume), 0, 100);
  });
}

async function handlePlayScene(sceneId) {
  const scene = state.library.scenes.find((entry) => entry.id === sceneId);
  if (!scene) {
    setError("Scene not found in this room.");
    return;
  }
  await mutateRoomState((draft) => {
    const now = safeNow();
    const startAt = now + START_LEAD_MS;
    draft.activeScene = { id: scene.id, name: scene.name };
    draft.transport.status = TRANSPORT_PLAYING;
    draft.transport.changedAt = startAt;
    draft.layers = scene.layers.map((layer) => {
      const nextLayer = createLayer(layer);
      nextLayer.runtime.status = TRANSPORT_PLAYING;
      nextLayer.runtime.pauseOffsetSec = nextLayer.startSeconds;
      nextLayer.runtime.playingSince = startAt;
      nextLayer.runtime.lastSyncAt = now;
      return nextLayer;
    });
  });
}

async function handleSaveCurrentScene() {
  const sceneName = state.draft.sceneName.trim()
    || state.roomState.activeScene?.name
    || "New scene";
  if (!state.roomState.layers.length) {
    setError("There is no active mix to save.");
    return;
  }
  setBusy(true);
  clearError();
  try {
    await mutateSceneLibrary((draft, current) => {
      const existingId = current.scenes.some((entry) => entry.id === state.roomState.activeScene?.id)
        ? state.roomState.activeScene.id
        : makeId("scene");
      const nextScene = {
        id: existingId,
        name: sceneName,
        updatedAt: safeNow(),
        layers: state.roomState.layers.map(stripLayerForScene),
      };
      const existingIndex = draft.scenes.findIndex((entry) => entry.id === existingId);
      if (existingIndex >= 0) {
        draft.scenes[existingIndex] = nextScene;
      } else {
        draft.scenes.unshift(nextScene);
      }
    });
    state.draft.sceneName = "";
    setNotices(["Scenes are now stored inside the Owlbear room, so no local helper is required."]);
    render();
  } catch (error) {
    setError(error instanceof Error ? error.message : "Failed to save scene.");
  } finally {
    setBusy(false);
  }
}

async function handleDeleteScene(sceneId) {
  setBusy(true);
  clearError();
  try {
    await mutateSceneLibrary((draft) => {
      const nextScenes = draft.scenes.filter((scene) => scene.id !== sceneId);
      if (nextScenes.length === draft.scenes.length) {
        return false;
      }
      draft.scenes = nextScenes;
    });
  } catch (error) {
    setError(error instanceof Error ? error.message : "Failed to delete scene.");
  } finally {
    setBusy(false);
  }
}

async function retryLocalAudio() {
  await OBR.broadcast.sendMessage(
    LOCAL_CONTROL_CHANNEL,
    { type: "retry-local-audio" },
    { destination: "LOCAL" },
  );
}

async function unlockLocalAudio() {
  await OBR.broadcast.sendMessage(
    LOCAL_CONTROL_CHANNEL,
    {
      type: "prime-local-audio",
      roomState: state.roomState,
    },
    { destination: "LOCAL" },
  );
  if (state.roomState.transport.status === TRANSPORT_PLAYING) {
    await retryLocalAudio();
  }
}

function syncLocalOutputVolume(volume) {
  state.localOutputVolume = normalizeVolumeValue(volume);
  setLocalOutputVolume(state.localOutputVolume);
}

async function handleLocalOutputVolume(volume) {
  syncLocalOutputVolume(volume);
  await OBR.broadcast.sendMessage(
    LOCAL_CONTROL_CHANNEL,
    {
      type: "set-local-volume",
      volume: state.localOutputVolume,
    },
    { destination: "LOCAL" },
  );
}

function getCurrentView() {
  return isGm() && state.view === "scenes" ? "scenes" : "mix";
}

function countPlayingLayers() {
  return state.roomState.layers.filter((layer) => layer.runtime.status === TRANSPORT_PLAYING).length;
}

function renderNoticePanel() {
  if (!state.notices.length) {
    return "";
  }
  return `
    <section class="panel warning-box">
      ${state.notices.map((entry) => `<p>${escapeHtml(entry)}</p>`).join("")}
    </section>
  `;
}

function renderCommandDeck() {
  const roleClass = isGm() ? "pill accent" : "pill";
  const transportClass = state.roomState.transport.status === TRANSPORT_PLAYING
    ? "pill success"
    : state.roomState.transport.status === TRANSPORT_PAUSED
      ? "pill warning"
      : "pill";
  const disabled = !isGm() || !state.roomState.layers.length || state.busy;
  const currentView = getCurrentView();

  return `
    <section class="panel command-deck">
      <div class="command-copy">
        <p class="eyebrow">Sync Music MVP</p>
        <h1>${escapeHtml(state.roomState.activeScene?.name || "Live mix")}</h1>
        <p>${escapeHtml(summarizeTransport(state.roomState))}</p>
      </div>
      <div class="hero-pills">
        <span class="pill success">No helper mode</span>
        <span class="${roleClass}">${escapeHtml(state.role)}</span>
        <span class="${transportClass}">${escapeHtml(state.roomState.transport.status)}</span>
      </div>
      <div class="command-actions">
        ${isGm()
          ? `
            <div class="transport-cluster">
              <button class="action-button" data-action="play-mix" ${disabled ? "disabled" : ""}>Play</button>
              <button class="action-button secondary-button" data-action="pause-mix" ${disabled ? "disabled" : ""}>Pause</button>
              <button class="action-button danger-button" data-action="stop-mix" ${disabled ? "disabled" : ""}>Stop</button>
            </div>
            <div class="deck-slider">
              <label class="field-label" for="master-volume">Master volume</label>
              <div class="range-row">
                <input id="master-volume" data-range="master-volume" type="range" min="0" max="100" value="${state.roomState.transport.masterVolume}" ${disabled ? "disabled" : ""} />
                <span>${state.roomState.transport.masterVolume}%</span>
              </div>
            </div>
          `
          : `
            <div class="deck-summary">
              <span>${escapeHtml(`GM transport: ${state.roomState.transport.status}`)}</span>
              <span>${escapeHtml(`${countPlayingLayers()} live layer${countPlayingLayers() === 1 ? "" : "s"}`)}</span>
            </div>
          `}
      </div>
      <div class="view-tabs" role="tablist" aria-label="Workspace view">
        <button class="tab-button ${currentView === "mix" ? "is-active" : ""}" data-action="set-view" data-view="mix">Mix</button>
        ${isGm()
          ? `<button class="tab-button ${currentView === "scenes" ? "is-active" : ""}" data-action="set-view" data-view="scenes">Scenes</button>`
          : ""}
      </div>
    </section>
  `;
}

function renderMixOverview() {
  const totalLayers = state.roomState.layers.length;
  const playingLayers = countPlayingLayers();
  const pausedLayers = state.roomState.layers.filter((layer) => layer.runtime.status === TRANSPORT_PAUSED).length;
  const sceneCount = Array.isArray(state.library.scenes) ? state.library.scenes.length : 0;

  return `
    <section class="mix-overview">
      <article class="panel stat-card">
        <span class="stat-label">Live layers</span>
        <strong>${totalLayers}</strong>
        <span class="muted">${playingLayers} playing now</span>
      </article>
      <article class="panel stat-card">
        <span class="stat-label">Paused layers</span>
        <strong>${pausedLayers}</strong>
        <span class="muted">${escapeHtml(state.roomState.transport.status)}</span>
      </article>
      <article class="panel stat-card">
        <span class="stat-label">Saved scenes</span>
        <strong>${sceneCount}</strong>
        <span class="muted">Shared with this room</span>
      </article>
    </section>
  `;
}

function renderBrowserStatusPanel() {
  const localStatus = state.localClientStatus;
  if (!localStatus) {
    return `
      <section class="panel browser-console">
        <div class="section-row">
          <div>
            <h2>This browser</h2>
            <p class="muted">Background audio engine has not reported in yet.</p>
          </div>
          <button class="action-button secondary-button" data-action="unlock-audio">Enable audio here</button>
        </div>
      </section>
    `;
  }

  return `
    <section class="panel browser-console">
      <div class="section-row">
        <div>
          <h2>This browser</h2>
          <p class="muted">Transport: ${escapeHtml(localStatus.transportStatus || TRANSPORT_STOPPED)} | Audio unlock: ${escapeHtml(localStatus.audioPrimed ? "done" : "needed")}</p>
        </div>
        <div class="button-row compact-row">
          <button class="action-button secondary-button" data-action="unlock-audio">${escapeHtml(localStatus.audioPrimed ? "Audio unlocked" : "Enable audio here")}</button>
          ${localStatus.autoplayBlocked
            ? `<button class="action-button secondary-button" data-action="retry-audio">Retry audio here</button>`
            : ""}
        </div>
      </div>
      <div class="status-grid">
        <div class="status-chip">
          <span class="status-label">Engine</span>
          <strong>${escapeHtml(localStatus.engineReady ? "ready" : "starting")}</strong>
        </div>
        <div class="status-chip">
          <span class="status-label">YouTube API</span>
          <strong>${escapeHtml(localStatus.youtubeApiReady ? "ready" : "not ready")}</strong>
        </div>
        <div class="status-chip">
          <span class="status-label">Slots</span>
          <strong>${escapeHtml(String(localStatus.slotCount || 0))}</strong>
        </div>
      </div>
      ${localStatus.lastAction
        ? `<p class="muted status-trace">Last action: ${escapeHtml(localStatus.lastAction)}</p>`
        : ""}
      ${localStatus.autoplayBlocked
        ? `<div class="warning-box">
            <p>Autoplay is blocked on this browser. Press unlock once, then try Play again.</p>
          </div>`
        : ""}
      ${Array.isArray(localStatus.errors) && localStatus.errors.length
        ? `<div class="warning-box">${localStatus.errors.map((entry) => `<p>${escapeHtml(entry)}</p>`).join("")}</div>`
        : ""}
    </section>
  `;
}

function renderPlayerVolumePanel() {
  if (isGm()) {
    return "";
  }

  return `
    <section class="panel player-volume-panel">
      <div class="section-row">
        <div>
          <h2>Player volume</h2>
          <p class="muted">Changes the broadcast volume only on this player's browser.</p>
        </div>
      </div>
      <label class="field-label" for="player-local-output-volume">Broadcast volume</label>
      <div class="range-row">
        <input
          id="player-local-output-volume"
          name="localOutputVolume"
          data-range="local-output-volume"
          type="range"
          min="0"
          max="100"
          value="${state.localOutputVolume}"
        />
        <span>${state.localOutputVolume}%</span>
      </div>
    </section>
  `;
}

function renderAddTrackPanel() {
  if (!isGm()) {
    return "";
  }
  return `
    <section class="panel composer-panel">
      <div class="section-row">
        <div>
          <h2>Queue a new layer</h2>
          <p class="muted">Paste a direct YouTube or YouTube Music watch link and add it straight to the live mix.</p>
        </div>
        <button class="action-button" data-action="add-track" ${state.busy ? "disabled" : ""}>Add to mix</button>
      </div>
      <label class="field-label" for="track-url">Track URL</label>
      <input id="track-url" name="draftUrl" type="url" value="${escapeHtml(state.draft.url)}" placeholder="https://www.youtube.com/watch?v=..." />
      <label class="field-label" for="track-title">Custom title</label>
      <input id="track-title" name="draftTitle" type="text" value="${escapeHtml(state.draft.title)}" placeholder="Optional scene-friendly title" />
      <p class="muted">No helper is required now, but the link must expose a playable <code>v=</code> or <code>list=</code> ID.</p>
    </section>
  `;
}

function renderActiveLayers() {
  if (!state.roomState.layers.length) {
    return `
      <section class="panel">
        <h2>Live mix</h2>
        <p class="muted">No layers are loaded yet. Add a track or launch a saved scene.</p>
      </section>
    `;
  }

  const cards = state.roomState.layers.map((layer) => {
    const layerState = layer.runtime.status || TRANSPORT_STOPPED;
    const badgeClass = layerState === TRANSPORT_PLAYING
      ? "pill success"
      : layerState === TRANSPORT_PAUSED
        ? "pill warning"
        : "pill";

    return `
      <article class="layer-card">
        <div class="layer-head">
          <div>
            <div class="layer-title-row">
              <h3>${escapeHtml(layer.title)}</h3>
              <span class="${badgeClass}">${escapeHtml(layerState)}</span>
            </div>
            <p class="muted">${escapeHtml(formatSourceType(layer))}</p>
          </div>
          ${isGm()
            ? `<button class="ghost-button danger-text" data-action="remove-layer" data-layer-id="${escapeHtml(layer.id)}">Remove</button>`
            : ""}
        </div>
        <div class="layer-meta">
          <span>${escapeHtml(layer.loop ? "Loop enabled" : "Loop off")}</span>
          <span>${escapeHtml(`Start ${Math.round(layer.startSeconds)}s`)}</span>
        </div>
        <label class="field-label">Layer volume</label>
        <div class="range-row">
          <input
            data-range="layer-volume"
            data-layer-id="${escapeHtml(layer.id)}"
            type="range"
            min="0"
            max="100"
            value="${layer.volume}"
            ${!isGm() ? "disabled" : ""}
          />
          <span>${layer.volume}%</span>
        </div>
        <label class="toggle-row">
          <input
            type="checkbox"
            data-toggle="layer-loop"
            data-layer-id="${escapeHtml(layer.id)}"
            ${layer.loop ? "checked" : ""}
            ${!isGm() ? "disabled" : ""}
          />
          <span>Keep this layer looping</span>
        </label>
      </article>
    `;
  }).join("");

  return `
    <section class="panel">
      <div class="section-row">
        <div>
          <h2>Live mix</h2>
          <p class="muted">${state.roomState.layers.length} layer${state.roomState.layers.length === 1 ? "" : "s"} loaded</p>
        </div>
      </div>
      <div class="layer-stack">${cards}</div>
    </section>
  `;
}

function renderScenesPanel() {
  const scenes = Array.isArray(state.library.scenes) ? state.library.scenes : [];
  const sceneCards = scenes.length
    ? scenes.map((scene) => `
        <article class="scene-card">
          <div class="scene-copy">
            <h3>${escapeHtml(scene.name)}</h3>
            <p class="muted">${scene.layers.length} layer${scene.layers.length === 1 ? "" : "s"}</p>
          </div>
          <div class="button-row compact-row">
            <button class="ghost-button" data-action="play-scene" data-scene-id="${escapeHtml(scene.id)}" ${state.busy ? "disabled" : ""}>Load</button>
            <button class="ghost-button danger-text" data-action="delete-scene" data-scene-id="${escapeHtml(scene.id)}" ${state.busy ? "disabled" : ""}>Delete</button>
          </div>
        </article>
      `).join("")
    : `<p class="muted">No saved scenes yet. Build a live mix and save it here.</p>`;

  return `
    <section class="panel">
      <div class="section-row">
        <div>
          <h2>Scene library</h2>
          <p class="muted">Scenes are now stored inside the Owlbear room, so any GM opening this room can use them.</p>
        </div>
      </div>
      <label class="field-label" for="scene-name">Save current mix as a scene</label>
      <div class="inline-form">
        <input id="scene-name" name="draftSceneName" type="text" value="${escapeHtml(state.draft.sceneName)}" placeholder="Rainy forest, Tavern, Boss fight..." />
        <button class="action-button" data-action="save-scene" ${state.busy || !state.roomState.layers.length ? "disabled" : ""}>Save</button>
      </div>
      <div class="scene-stack">${sceneCards}</div>
    </section>
  `;
}

function renderLimitationsPanel() {
  return `
    <section class="panel">
      <h2>Reality check</h2>
      <ul class="plain-list">
        <li>No helper is required anymore. Everything important now runs inside the Owlbear extension.</li>
        <li>Only direct YouTube and YouTube Music links that expose a video ID or playlist ID are supported.</li>
        <li>Some YouTube Music share links that rely on page resolution may no longer work without manual cleanup.</li>
        <li>YouTube ads on embedded videos are still controlled by YouTube.</li>
        <li>If a video forbids embeds, YouTube will return error 101 or 150 and this browser will show a warning.</li>
      </ul>
    </section>
  `;
}

function renderMixView() {
  return `
    ${renderMixOverview()}
    ${renderNoticePanel()}
    ${renderPlayerVolumePanel()}
    ${renderBrowserStatusPanel()}
    ${renderAddTrackPanel()}
    ${renderActiveLayers()}
    ${renderLimitationsPanel()}
  `;
}

function renderScenesView() {
  if (!isGm()) {
    return renderMixView();
  }

  return `
    ${renderNoticePanel()}
    ${renderBrowserStatusPanel()}
    ${renderScenesPanel()}
    ${renderLimitationsPanel()}
  `;
}

function renderLoadingState() {
  return `
    <div class="loading-state">
      <div class="spinner"></div>
      <p>Loading Sync Music MVP...</p>
    </div>
  `;
}

function render() {
  if (!root) {
    return;
  }

  if (state.loading) {
    root.innerHTML = renderLoadingState();
    return;
  }

  root.innerHTML = `
    <main class="layout">
      ${renderCommandDeck()}
      ${state.lastError ? `<section class="panel error-box"><p>${escapeHtml(state.lastError)}</p></section>` : ""}
      <section class="workspace-stack">
        ${getCurrentView() === "scenes" ? renderScenesView() : renderMixView()}
      </section>
    </main>
  `;
}

root?.addEventListener("input", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) {
    return;
  }
  if (target.name === "draftUrl") {
    state.draft.url = target.value;
    return;
  }
  if (target.name === "draftTitle") {
    state.draft.title = target.value;
    return;
  }
  if (target.name === "draftSceneName") {
    state.draft.sceneName = target.value;
    return;
  }
  if (target.name === "localOutputVolume") {
    syncLocalOutputVolume(target.value);
    render();
  }
});

root?.addEventListener("change", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) {
    return;
  }
  try {
    if (target.dataset.range === "layer-volume" && target.dataset.layerId) {
      await handleLayerVolume(target.dataset.layerId, target.value);
      return;
    }
    if (target.dataset.range === "master-volume") {
      await handleMasterVolume(target.value);
      return;
    }
    if (target.dataset.range === "local-output-volume") {
      await handleLocalOutputVolume(target.value);
      return;
    }
    if (target.dataset.toggle === "layer-loop" && target.dataset.layerId) {
      await handleLayerLoop(target.dataset.layerId, target.checked);
    }
  } catch (error) {
    setError(error instanceof Error ? error.message : "Update failed.");
  }
});

root?.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const action = target.dataset.action;
  if (!action) {
    return;
  }

  clearError();

  try {
    switch (action) {
      case "set-view":
        if (target.dataset.view) {
          state.view = target.dataset.view === "scenes" ? "scenes" : "mix";
          render();
        }
        break;
      case "add-track":
        await handleAddTrack();
        break;
      case "play-mix":
        await handlePlayMix();
        break;
      case "pause-mix":
        await handlePauseMix();
        break;
      case "stop-mix":
        await handleStopMix();
        break;
      case "remove-layer":
        if (target.dataset.layerId) {
          await handleRemoveLayer(target.dataset.layerId);
        }
        break;
      case "play-scene":
        if (target.dataset.sceneId) {
          await handlePlayScene(target.dataset.sceneId);
        }
        break;
      case "save-scene":
        await handleSaveCurrentScene();
        break;
      case "delete-scene":
        if (target.dataset.sceneId) {
          await handleDeleteScene(target.dataset.sceneId);
        }
        break;
      case "retry-audio":
        await retryLocalAudio();
        break;
      case "unlock-audio":
        await unlockLocalAudio();
        break;
      default:
        break;
    }
  } catch (error) {
    setError(error instanceof Error ? error.message : "Action failed.");
  }
});

OBR.onReady(async () => {
  state.role = await OBR.player.getRole();
  await Promise.all([
    refreshRoomData(),
    refreshLocalClientStatus(),
  ]);

  OBR.room.onMetadataChange((metadata) => {
    state.roomState = ensureRoomState(metadata[ROOM_STATE_KEY]);
    state.library = ensureSceneLibrary(metadata[SCENE_LIBRARY_KEY]);
    render();
  });

  OBR.player.onChange((player) => {
    state.role = player.role;
    syncLocalStatusFromPlayer(player);
    render();
  });

  OBR.broadcast.onMessage(BROADCAST_CHANNEL, (event) => {
    if (event.data?.roomState) {
      state.roomState = ensureRoomState(event.data.roomState);
      render();
    }
  });

  state.loading = false;
  render();
});
