import OBR from "@owlbear-rodeo/sdk";
import {
  BROADCAST_CHANNEL,
  CLIENT_STATUS_KEY,
  DEFAULT_HELPER_URL,
  LOCAL_CONTROL_CHANNEL,
  ROOM_STATE_KEY,
  START_LEAD_MS,
  TRANSPORT_PAUSED,
  TRANSPORT_PLAYING,
  TRANSPORT_STOPPED,
  clamp,
  computeLayerPosition,
  createEmptyRoomState,
  createLayer,
  deepClone,
  ensureRoomState,
  formatSourceType,
  getLocalOutputVolume,
  getHelperUrl,
  safeNow,
  setHelperUrl,
  setLocalOutputVolume,
  stripLayerForScene,
  summarizeTransport,
} from "./shared.js";

const root = document.getElementById("app");

const state = {
  role: "PLAYER",
  helperUrl: getHelperUrl(),
  helperOnline: false,
  helperMessage: "Helper not checked yet.",
  helperWarnings: [],
  roomState: createEmptyRoomState(),
  library: { scenes: [] },
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

async function helperFetch(path, options = {}) {
  const baseUrl = options.baseUrl || state.helperUrl || DEFAULT_HELPER_URL;
  const headers = {
    ...(options.headers || {}),
  };

  if (options.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(new URL(path, `${baseUrl}/`), {
    ...options,
    headers,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `Helper request failed with status ${response.status}.`);
  }
  return data;
}

function buildHelperUrlCandidates(rawUrl) {
  const trimmed = String(rawUrl || DEFAULT_HELPER_URL).trim() || DEFAULT_HELPER_URL;
  const candidates = [trimmed];

  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname === "127.0.0.1") {
      parsed.hostname = "localhost";
      candidates.push(parsed.toString().replace(/\/$/, ""));
    } else if (parsed.hostname === "localhost") {
      parsed.hostname = "127.0.0.1";
      candidates.push(parsed.toString().replace(/\/$/, ""));
    }
  } catch {
    // Ignore invalid URLs here; the request will fail with a helpful error later.
  }

  return [...new Set(candidates)];
}

function setPlayerHelperState() {
  state.helperOnline = false;
  state.helperWarnings = [];
  state.helperMessage = "Players do not need a local helper on this device.";
}

async function refreshHelper() {
  if (!isGm()) {
    setPlayerHelperState();
    render();
    return;
  }

  let lastError = null;

  for (const candidate of buildHelperUrlCandidates(state.helperUrl)) {
    try {
      const [health, libraryPayload] = await Promise.all([
        helperFetch("/api/health", { baseUrl: candidate }),
        helperFetch("/api/library", { baseUrl: candidate }),
      ]);
      state.helperOnline = true;
      state.helperUrl = candidate;
      setHelperUrl(candidate);
      state.helperMessage = `Helper online on ${health.host}:${health.port}`;
      state.library = libraryPayload.library;
      state.helperWarnings = [];
      render();
      return;
    } catch (error) {
      lastError = error;
    }
  }

  state.helperOnline = false;
  state.helperMessage = lastError instanceof Error ? lastError.message : "Helper is offline.";
  state.helperWarnings = [];
  render();
}

async function refreshRoomState() {
  const metadata = await OBR.room.getMetadata();
  state.roomState = ensureRoomState(metadata[ROOM_STATE_KEY]);
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
    const resolved = await helperFetch("/api/resolve", {
      method: "POST",
      body: JSON.stringify({
        url,
        title: state.draft.title.trim(),
      }),
    });
    state.helperWarnings = Array.isArray(resolved.warnings) ? resolved.warnings : [];
    await addResolvedTrack(resolved.track);
    state.draft.url = "";
    state.draft.title = "";
    await refreshHelper();
  } catch (error) {
    setError(error instanceof Error ? error.message : "Failed to resolve track.");
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
    setError("Scene not found in helper library.");
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
    const payload = {
      scene: {
        id: state.library.scenes.some((entry) => entry.id === state.roomState.activeScene?.id)
          ? state.roomState.activeScene.id
          : undefined,
        name: sceneName,
        layers: state.roomState.layers.map(stripLayerForScene),
      },
    };
    await helperFetch("/api/scenes", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    state.draft.sceneName = "";
    await refreshHelper();
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
    await helperFetch(`/api/scenes/${encodeURIComponent(sceneId)}`, {
      method: "DELETE",
    });
    await refreshHelper();
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

function renderCommandDeck() {
  const helperClass = state.helperOnline ? "pill success" : "pill warning";
  const roleClass = isGm() ? "pill accent" : "pill";
  const transportClass = state.roomState.transport.status === TRANSPORT_PLAYING
    ? "pill success"
    : state.roomState.transport.status === TRANSPORT_PAUSED
      ? "pill warning"
      : "pill";
  const disabled = !isGm() || !state.roomState.layers.length || state.busy;
  const currentView = getCurrentView();
  const helperPill = isGm()
    ? `<span class="${helperClass}">${escapeHtml(state.helperOnline ? "Helper online" : "Helper offline")}</span>`
    : `<span class="pill">Local player</span>`;

  return `
    <section class="panel command-deck">
      <div class="command-copy">
        <p class="eyebrow">Sync Music MVP</p>
        <h1>${escapeHtml(state.roomState.activeScene?.name || "Live mix")}</h1>
        <p>${escapeHtml(summarizeTransport(state.roomState))}</p>
      </div>
      <div class="hero-pills">
        ${helperPill}
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
        <span class="muted">${escapeHtml(state.roomState.activeScene?.name || "Live mix")}</span>
      </article>
    </section>
  `;
}

function renderMixView() {
  return `
    ${renderMixOverview()}
    ${renderBrowserStatusPanel()}
    ${renderHelperPanel()}
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
    ${renderBrowserStatusPanel()}
    ${renderHelperPanel()}
    ${renderScenesPanel()}
    ${renderLimitationsPanel()}
  `;
}

function renderHeader() {
  const helperClass = state.helperOnline ? "pill success" : "pill warning";
  const roleClass = isGm() ? "pill accent" : "pill";
  return `
    <section class="panel hero-panel">
      <div class="hero-copy">
        <h1>Sync Music MVP</h1>
        <p>${escapeHtml(summarizeTransport(state.roomState))}</p>
      </div>
      <div class="hero-pills">
        <span class="${helperClass}">${escapeHtml(state.helperOnline ? "Helper online" : "Helper offline")}</span>
        <span class="${roleClass}">${escapeHtml(state.role)}</span>
      </div>
    </section>
  `;
}

function renderHelperPanel() {
  if (!isGm()) {
    return "";
  }

  return `
    <section class="panel helper-panel">
      <div class="section-row">
        <div>
          <h2>GM helper</h2>
          <p class="muted">${escapeHtml(state.helperMessage)}</p>
        </div>
        <button class="ghost-button" data-action="refresh-helper">Reconnect</button>
      </div>
      <label class="field-label" for="helper-url">Helper URL</label>
      <input id="helper-url" name="helperUrl" type="url" value="${escapeHtml(state.helperUrl)}" placeholder="${escapeHtml(DEFAULT_HELPER_URL)}" />
      ${state.helperWarnings.length
        ? `<div class="warning-box">${state.helperWarnings.map((warning) => `<p>${escapeHtml(warning)}</p>`).join("")}</div>`
        : ""}
    </section>
  `;
}

function renderStatusPanel() {
  const localStatus = state.localClientStatus;
  if (!localStatus) {
    return `
      <section class="panel">
        <h2>Playback status on this browser</h2>
        <div class="warning-box">
          <p>Background audio engine has not reported in yet. Reload the room once and reopen the extension.</p>
          <button class="action-button secondary-button" data-action="unlock-audio">Enable audio here</button>
        </div>
      </section>
    `;
  }
  return `
    <section class="panel">
      <h2>Playback status on this browser</h2>
      <p class="muted">Transport: ${escapeHtml(localStatus.transportStatus || TRANSPORT_STOPPED)}</p>
      <p class="muted">Audio unlock: ${escapeHtml(localStatus.audioPrimed ? "done" : "needed")}</p>
      <p class="muted">Engine: ${escapeHtml(localStatus.engineReady ? "ready" : "starting")} • YouTube API: ${escapeHtml(localStatus.youtubeApiReady ? "ready" : "not ready")} • Slots: ${escapeHtml(String(localStatus.slotCount || 0))}</p>
      ${localStatus.lastAction
        ? `<p class="muted">Last action: ${escapeHtml(localStatus.lastAction)}</p>`
        : ""}
      <div class="button-row">
        <button class="action-button secondary-button" data-action="unlock-audio">${escapeHtml(localStatus.audioPrimed ? "Audio unlocked" : "Enable audio here")}</button>
        ${localStatus.autoplayBlocked
          ? `<button class="action-button secondary-button" data-action="retry-audio">Retry audio here</button>`
          : ""}
      </div>
      <div class="warning-box">
        <p>Эта кнопка только разблокирует звук в браузере. Она не запускает трек сама. После неё нужно нажать Play в блоке Transport.</p>
      </div>
      ${localStatus.autoplayBlocked
        ? `<div class="warning-box">
            <p>Autoplay is blocked on this browser. Press the button above once, then try Play again.</p>
          </div>`
        : ""}
      ${Array.isArray(localStatus.errors) && localStatus.errors.length
        ? `<div class="warning-box">${localStatus.errors.map((entry) => `<p>${escapeHtml(entry)}</p>`).join("")}</div>`
        : ""}
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
      <label class="field-label" for="local-output-volume">Volume on this browser</label>
      <div class="range-row">
        <input
          id="local-output-volume"
          name="localOutputVolume"
          data-range="local-output-volume"
          type="range"
          min="0"
          max="100"
          value="${state.localOutputVolume}"
        />
        <span>${state.localOutputVolume}%</span>
      </div>
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

function renderLoadingState() {
  return `
    <div class="loading-state">
      <div class="spinner"></div>
      <p>Loading Sync Music MVP...</p>
    </div>
  `;
}

function renderTransportPanel() {
  const disabled = !isGm() || !state.roomState.layers.length || state.busy;
  return `
    <section class="panel">
      <div class="section-row">
        <h2>Transport</h2>
        <p class="muted">${escapeHtml(state.roomState.activeScene?.name || "Live mix")}</p>
      </div>
      <div class="button-row">
        <button class="action-button" data-action="play-mix" ${disabled ? "disabled" : ""}>Play</button>
        <button class="action-button secondary-button" data-action="pause-mix" ${disabled ? "disabled" : ""}>Pause</button>
        <button class="action-button danger-button" data-action="stop-mix" ${disabled ? "disabled" : ""}>Stop</button>
      </div>
      <label class="field-label" for="master-volume">Master volume</label>
      <div class="range-row">
        <input id="master-volume" data-range="master-volume" type="range" min="0" max="100" value="${state.roomState.transport.masterVolume}" ${!isGm() ? "disabled" : ""} />
        <span>${state.roomState.transport.masterVolume}%</span>
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
          <p class="muted">Drop in a YouTube or YouTube Music link and add it straight to the live mix.</p>
        </div>
        <button class="action-button" data-action="add-track" ${state.busy ? "disabled" : ""}>Add to mix</button>
      </div>
      <label class="field-label" for="track-url">Track URL</label>
      <input id="track-url" name="draftUrl" type="url" value="${escapeHtml(state.draft.url)}" placeholder="https://www.youtube.com/watch?v=..." />
      <label class="field-label" for="track-title">Custom title</label>
      <input id="track-title" name="draftTitle" type="text" value="${escapeHtml(state.draft.title)}" placeholder="Optional scene-friendly title" />
      <p class="muted">Best support is for direct watch links and playlist links that expose a <code>v=</code> or <code>list=</code> ID.</p>
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
          <p class="muted">Reusable presets for ambience stacks, music combos, and encounter setups.</p>
        </div>
        <button class="ghost-button" data-action="refresh-helper">Refresh</button>
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
        <li>YouTube playback works through the official IFrame API.</li>
        <li>YouTube Music works when the helper can resolve the link to a normal YouTube video or playlist ID.</li>
        <li>YouTube ads on embedded videos are controlled by YouTube. This extension can reduce reload churn, but it cannot force ad-free playback.</li>
        <li>If a video forbids embeds, YouTube will return error 101 or 150 and this browser will show a warning.</li>
        <li>If autoplay is blocked, each affected browser needs one click in this panel to unlock audio locally.</li>
      </ul>
    </section>
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

  if (state.loading) {
    root.innerHTML = `
      <div class="loading-state">
        <div class="spinner"></div>
        <p>Loading Sync Music MVP…</p>
      </div>
    `;
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
  if (target.name === "helperUrl") {
    state.helperUrl = target.value.trim() || DEFAULT_HELPER_URL;
    setHelperUrl(state.helperUrl);
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
      case "refresh-helper":
        await refreshHelper();
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
  if (!isGm()) {
    setPlayerHelperState();
  }
  await Promise.all([
    refreshRoomState(),
    refreshLocalClientStatus(),
  ]);

  OBR.room.onMetadataChange((metadata) => {
    state.roomState = ensureRoomState(metadata[ROOM_STATE_KEY]);
    render();
  });

  OBR.player.onChange((player) => {
    state.role = player.role;
    syncLocalStatusFromPlayer(player);
    if (state.role === "GM") {
      refreshHelper().catch(() => {
        // Ignore helper refresh failures on role changes.
      });
    } else {
      setPlayerHelperState();
    }
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
  if (isGm()) {
    await refreshHelper();
  }
});
