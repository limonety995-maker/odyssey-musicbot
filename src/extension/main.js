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
  getHelperUrl,
  safeNow,
  setHelperUrl,
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
  lastError: "",
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
  const baseUrl = state.helperUrl || DEFAULT_HELPER_URL;
  const response = await fetch(new URL(path, `${baseUrl}/`), {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `Helper request failed with status ${response.status}.`);
  }
  return data;
}

async function refreshHelper() {
  try {
    const [health, libraryPayload] = await Promise.all([
      helperFetch("/api/health"),
      helperFetch("/api/library"),
    ]);
    state.helperOnline = true;
    state.helperMessage = `Helper online on ${health.host}:${health.port}`;
    state.library = libraryPayload.library;
    state.helperWarnings = [];
  } catch (error) {
    state.helperOnline = false;
    state.helperMessage = error instanceof Error ? error.message : "Helper is offline.";
    state.helperWarnings = [];
  }
  render();
}

async function refreshRoomState() {
  const metadata = await OBR.room.getMetadata();
  state.roomState = ensureRoomState(metadata[ROOM_STATE_KEY]);
}

async function refreshLocalClientStatus() {
  const metadata = await OBR.player.getMetadata();
  state.localClientStatus = metadata[CLIENT_STATUS_KEY] || null;
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
    return `
      <section class="panel">
        <h2>Local status</h2>
        <p class="muted">${escapeHtml(state.helperMessage)}</p>
      </section>
    `;
  }

  return `
    <section class="panel">
      <div class="section-row">
        <h2>GM helper</h2>
        <button class="ghost-button" data-action="refresh-helper">Reconnect</button>
      </div>
      <label class="field-label" for="helper-url">Helper URL</label>
      <input id="helper-url" name="helperUrl" type="url" value="${escapeHtml(state.helperUrl)}" placeholder="${escapeHtml(DEFAULT_HELPER_URL)}" />
      <p class="muted">${escapeHtml(state.helperMessage)}</p>
      ${state.helperWarnings.length
        ? `<div class="warning-box">${state.helperWarnings.map((warning) => `<p>${escapeHtml(warning)}</p>`).join("")}</div>`
        : ""}
    </section>
  `;
}

function renderStatusPanel() {
  const localStatus = state.localClientStatus;
  if (!localStatus) {
    return "";
  }
  return `
    <section class="panel">
      <h2>Playback status on this browser</h2>
      <p class="muted">Transport: ${escapeHtml(localStatus.transportStatus || TRANSPORT_STOPPED)}</p>
      ${localStatus.autoplayBlocked
        ? `<div class="warning-box">
            <p>Autoplay is blocked on this browser. Open this panel and press the button below once.</p>
            <button class="action-button secondary-button" data-action="retry-audio">Retry audio here</button>
          </div>`
        : ""}
      ${Array.isArray(localStatus.errors) && localStatus.errors.length
        ? `<div class="warning-box">${localStatus.errors.map((entry) => `<p>${escapeHtml(entry)}</p>`).join("")}</div>`
        : ""}
    </section>
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
    <section class="panel">
      <h2>Add track</h2>
      <label class="field-label" for="track-url">YouTube or YouTube Music URL</label>
      <input id="track-url" name="draftUrl" type="url" value="${escapeHtml(state.draft.url)}" placeholder="https://www.youtube.com/watch?v=..." />
      <label class="field-label" for="track-title">Custom title (optional)</label>
      <input id="track-title" name="draftTitle" type="text" value="${escapeHtml(state.draft.title)}" placeholder="Leave blank to auto-fill" />
      <div class="button-row">
        <button class="action-button" data-action="add-track" ${state.busy ? "disabled" : ""}>Add to active mix</button>
      </div>
      <p class="muted">Best support is for direct watch links and playlist links that expose a <code>v=</code> or <code>list=</code> ID.</p>
    </section>
  `;
}

function renderActiveLayers() {
  if (!state.roomState.layers.length) {
    return `
      <section class="panel">
        <h2>Active layers</h2>
        <p class="muted">No tracks are active right now.</p>
      </section>
    `;
  }

  const cards = state.roomState.layers.map((layer) => `
    <article class="layer-card">
      <div class="layer-head">
        <div>
          <h3>${escapeHtml(layer.title)}</h3>
          <p class="muted">${escapeHtml(formatSourceType(layer))}</p>
        </div>
        ${isGm()
          ? `<button class="ghost-button danger-text" data-action="remove-layer" data-layer-id="${escapeHtml(layer.id)}">Remove</button>`
          : ""}
      </div>
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
        <span>Loop this layer</span>
      </label>
    </article>
  `).join("");

  return `
    <section class="panel">
      <h2>Active layers</h2>
      <div class="layer-stack">${cards}</div>
    </section>
  `;
}

function renderScenesPanel() {
  const scenes = Array.isArray(state.library.scenes) ? state.library.scenes : [];
  const sceneCards = scenes.length
    ? scenes.map((scene) => `
        <article class="scene-card">
          <div>
            <h3>${escapeHtml(scene.name)}</h3>
            <p class="muted">${scene.layers.length} layer${scene.layers.length === 1 ? "" : "s"}</p>
          </div>
          ${isGm()
            ? `<div class="button-row compact-row">
                <button class="ghost-button" data-action="play-scene" data-scene-id="${escapeHtml(scene.id)}">Play scene</button>
                <button class="ghost-button danger-text" data-action="delete-scene" data-scene-id="${escapeHtml(scene.id)}">Delete</button>
              </div>`
            : ""}
        </article>
      `).join("")
    : `<p class="muted">No saved scenes yet.</p>`;

  return `
    <section class="panel">
      <div class="section-row">
        <h2>Saved scenes</h2>
        <button class="ghost-button" data-action="refresh-helper">Refresh</button>
      </div>
      ${isGm()
        ? `<label class="field-label" for="scene-name">Save current mix as scene</label>
           <div class="inline-form">
             <input id="scene-name" name="draftSceneName" type="text" value="${escapeHtml(state.draft.sceneName)}" placeholder="Rainy forest, Tavern, Boss fight..." />
             <button class="action-button" data-action="save-scene" ${state.busy ? "disabled" : ""}>Save</button>
           </div>`
        : ""}
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
        <li>If a video forbids embeds, YouTube will return error 101 or 150 and this browser will show a warning.</li>
        <li>If autoplay is blocked, each affected browser needs one click in this panel to retry audio locally.</li>
      </ul>
    </section>
  `;
}

function render() {
  if (!root) {
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
      ${renderHeader()}
      ${state.lastError ? `<section class="panel error-box"><p>${escapeHtml(state.lastError)}</p></section>` : ""}
      ${renderHelperPanel()}
      ${renderStatusPanel()}
      ${renderTransportPanel()}
      ${renderAddTrackPanel()}
      ${renderActiveLayers()}
      ${renderScenesPanel()}
      ${renderLimitationsPanel()}
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
    refreshRoomState(),
    refreshLocalClientStatus(),
  ]);

  OBR.room.onMetadataChange((metadata) => {
    state.roomState = ensureRoomState(metadata[ROOM_STATE_KEY]);
    render();
  });

  OBR.player.onChange((player) => {
    state.role = player.role;
    state.localClientStatus = player.metadata?.[CLIENT_STATUS_KEY] || null;
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
  await refreshHelper();
});
