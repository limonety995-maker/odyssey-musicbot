import OBR from "@owlbear-rodeo/sdk";
import {
  BROADCAST_CHANNEL,
  CLIENT_STATUS_KEY,
  EXTENSION_ID,
  LOCAL_CONTROL_CHANNEL,
  ROOM_STATE_KEY,
  SCENE_LIBRARY_KEY,
  TRANSPORT_PAUSED,
  TRANSPORT_PLAYING,
  TRANSPORT_STOPPED,
  clamp,
  formatSourceType,
  getLocalOutputVolume,
  parseSupportedTrackUrl,
  safeNow,
  setLocalOutputVolume,
  summarizeTransport,
} from "./shared.js";
import {
  createEmptyLibraryPack,
  createEmptyRoomRuntime,
  ensureLibraryPack,
  ensureRoomRuntime,
} from "./scene-model.js";
import {
  addTrackToScene,
  deleteSceneFromLibrary,
  launchScene,
  pauseAllScenes,
  removeTrackFromScene,
  resumeAllScenes,
  setMasterVolume,
  stopAllScenes,
  updateTrackSettings,
} from "./scene-runtime.js";
import {
  LIVE_SCENE_ID,
  LIVE_SCENE_NAME,
  buildLegacyLibraryView,
  buildLegacyRoomStateView,
  collectCurrentMixTracks,
  createSceneTrackFromParsedTrack,
  ensureLiveSceneInLibrary,
  findTrackReference,
  getLiveScene,
  upsertLibraryScene,
} from "./scene-compat.js";

const root = document.getElementById("app");
const LIBRARY_STORAGE_KEY = `${EXTENSION_ID}/library-pack`;

const initialLibraryPack = ensureLiveSceneInLibrary(createEmptyLibraryPack(0), 0);
const initialRuntime = createEmptyRoomRuntime(0);

const state = {
  role: "PLAYER",
  runtime: initialRuntime,
  libraryPack: initialLibraryPack,
  roomState: buildLegacyRoomStateView(initialRuntime, initialLibraryPack),
  library: buildLegacyLibraryView(initialLibraryPack),
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
let localOutputVolumeSyncHandle = 0;
let localOutputVolumeInteractionActive = false;
let localOutputVolumeRenderPending = false;

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

function formatVolumeLabel(value) {
  const normalized = normalizeVolumeValue(value);
  return Number.isInteger(normalized)
    ? `${normalized}%`
    : `${normalized.toFixed(1)}%`;
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

function syncDerivedState() {
  state.roomState = buildLegacyRoomStateView(state.runtime, state.libraryPack);
  state.library = buildLegacyLibraryView(state.libraryPack);
}

function loadStoredLibraryPack(roomLibraryMetadata = null) {
  try {
    const raw = localStorage.getItem(LIBRARY_STORAGE_KEY);
    if (raw) {
      return ensureLiveSceneInLibrary(JSON.parse(raw));
    }
  } catch {
    // Ignore localStorage parse failures and fall back to migration/defaults.
  }

  const migrated = ensureLibraryPack(roomLibraryMetadata);
  if (migrated.scenes.length) {
    const nextLibrary = ensureLiveSceneInLibrary(migrated);
    try {
      localStorage.setItem(LIBRARY_STORAGE_KEY, JSON.stringify(nextLibrary));
    } catch {
      // Ignore localStorage write failures.
    }
    return nextLibrary;
  }

  return ensureLiveSceneInLibrary(createEmptyLibraryPack());
}

function persistLibraryPack(nextLibrary) {
  state.libraryPack = ensureLiveSceneInLibrary(nextLibrary);
  try {
    localStorage.setItem(LIBRARY_STORAGE_KEY, JSON.stringify(state.libraryPack));
  } catch {
    // Ignore localStorage write failures.
  }
}

async function refreshRoomData() {
  const metadata = await OBR.room.getMetadata();
  state.runtime = ensureRoomRuntime(metadata[ROOM_STATE_KEY]);
  state.libraryPack = loadStoredLibraryPack(metadata[SCENE_LIBRARY_KEY]);
  syncDerivedState();
}

async function refreshLocalClientStatus() {
  const metadata = await OBR.player.getMetadata();
  if (metadata[CLIENT_STATUS_KEY]) {
    state.localClientStatus = metadata[CLIENT_STATUS_KEY];
  }
  if (!localOutputVolumeInteractionActive) {
    state.localOutputVolume = clamp(
      Number(state.localClientStatus?.localOutputVolume ?? getLocalOutputVolume()),
      0,
      100,
    );
  }
}

async function pushRuntime(nextRuntime) {
  const normalized = ensureRoomRuntime(nextRuntime);
  await OBR.room.setMetadata({
    [ROOM_STATE_KEY]: normalized,
  });
  await OBR.broadcast.sendMessage(
    BROADCAST_CHANNEL,
    { roomState: normalized },
    { destination: "ALL" },
  );
  state.runtime = normalized;
  syncDerivedState();
}

async function mutateRuntime(mutator) {
  const metadata = await OBR.room.getMetadata();
  const current = ensureRoomRuntime(metadata[ROOM_STATE_KEY]);
  const nextRuntime = mutator(current);
  if (!nextRuntime) {
    return;
  }
  await pushRuntime(nextRuntime);
}

function mutateLibrary(mutator) {
  const nextLibrary = mutator(ensureLiveSceneInLibrary(state.libraryPack));
  if (!nextLibrary) {
    return false;
  }
  persistLibraryPack(nextLibrary);
  syncDerivedState();
  return true;
}

function syncLocalStatusFromPlayer(player) {
  const nextStatus = player?.metadata?.[CLIENT_STATUS_KEY];
  if (nextStatus) {
    state.localClientStatus = nextStatus;
  }
  if (!localOutputVolumeInteractionActive) {
    state.localOutputVolume = normalizeVolumeValue(
      state.localClientStatus?.localOutputVolume ?? getLocalOutputVolume(),
    );
  }
}

async function addResolvedTrack(track) {
  let nextLibrary = state.libraryPack;
  if (!getLiveScene(nextLibrary)) {
    nextLibrary = ensureLiveSceneInLibrary(nextLibrary);
  }

  const nextTrack = createSceneTrackFromParsedTrack(track);
  if (!nextTrack) {
    throw new Error("Could not turn this link into a playable scene track.");
  }

  const liveScene = getLiveScene(nextLibrary);
  const currentTracks = liveScene?.tracks || [];
  const updatedLiveScene = upsertLibraryScene({
    library: nextLibrary,
    sceneId: LIVE_SCENE_ID,
    name: LIVE_SCENE_NAME,
    tracks: [...currentTracks, nextTrack],
    now: safeNow(),
  });
  persistLibraryPack(updatedLiveScene);

  const activeLiveScene = state.runtime.activeScenes.find((scene) => scene.sceneId === LIVE_SCENE_ID);
  if (activeLiveScene) {
    const result = addTrackToScene({
      library: state.libraryPack,
      runtime: state.runtime,
      sceneId: LIVE_SCENE_ID,
      track: nextTrack,
      now: safeNow(),
    });
    persistLibraryPack(result.library);
    await pushRuntime(result.runtime);
    return;
  }

  syncDerivedState();
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
  if (state.runtime.activeScenes.length) {
    if (state.runtime.transport.status === TRANSPORT_PLAYING) {
      return;
    }
    await mutateRuntime((current) => resumeAllScenes(current, safeNow()));
    return;
  }

  const liveScene = getLiveScene(state.libraryPack);
  if (!liveScene?.tracks?.length) {
    setError("There are no tracks in the live mix yet.");
    return;
  }

  await pushRuntime(launchScene({
    library: state.libraryPack,
    runtime: state.runtime,
    sceneId: LIVE_SCENE_ID,
    mode: "replace",
    now: safeNow(),
  }));
}

async function handlePauseMix() {
  if (!state.runtime.activeScenes.length || state.runtime.transport.status !== TRANSPORT_PLAYING) {
    return;
  }
  await mutateRuntime((current) => pauseAllScenes(current, safeNow()));
}

async function handleStopMix() {
  if (!state.runtime.activeScenes.length || state.runtime.transport.status === TRANSPORT_STOPPED) {
    return;
  }
  await mutateRuntime((current) => stopAllScenes(current, safeNow()));
}

async function handleRemoveLayer(layerId) {
  const trackRef = findTrackReference(state.runtime, state.libraryPack, layerId);
  if (!trackRef) {
    return;
  }
  const result = removeTrackFromScene({
    library: state.libraryPack,
    runtime: state.runtime,
    sceneId: trackRef.sceneId,
    trackId: trackRef.trackId,
    now: safeNow(),
  });
  persistLibraryPack(result.library);
  if (state.runtime.activeScenes.some((scene) => scene.sceneId === trackRef.sceneId)) {
    await pushRuntime(result.runtime);
    return;
  }
  syncDerivedState();
  render();
}

async function handleLayerVolume(layerId, volume) {
  const trackRef = findTrackReference(state.runtime, state.libraryPack, layerId);
  if (!trackRef) {
    return;
  }
  const result = updateTrackSettings({
    library: state.libraryPack,
    runtime: state.runtime,
    sceneId: trackRef.sceneId,
    trackId: trackRef.trackId,
    patch: {
      volume: clamp(Number(volume), 0, 100),
    },
    now: safeNow(),
  });
  persistLibraryPack(result.library);
  if (state.runtime.activeScenes.some((scene) => scene.sceneId === trackRef.sceneId)) {
    await pushRuntime(result.runtime);
    return;
  }
  syncDerivedState();
  render();
}

async function handleLayerLoop(layerId, loop) {
  const trackRef = findTrackReference(state.runtime, state.libraryPack, layerId);
  if (!trackRef) {
    return;
  }
  const result = updateTrackSettings({
    library: state.libraryPack,
    runtime: state.runtime,
    sceneId: trackRef.sceneId,
    trackId: trackRef.trackId,
    patch: {
      loop: Boolean(loop),
    },
    now: safeNow(),
  });
  persistLibraryPack(result.library);
  if (state.runtime.activeScenes.some((scene) => scene.sceneId === trackRef.sceneId)) {
    await pushRuntime(result.runtime);
    return;
  }
  syncDerivedState();
  render();
}

async function handleMasterVolume(volume) {
  await mutateRuntime((current) => setMasterVolume(current, clamp(Number(volume), 0, 100), safeNow()));
}

async function handlePlayScene(sceneId) {
  const scene = state.libraryPack.scenes.find((entry) => entry.id === sceneId);
  if (!scene) {
    setError("Scene not found in this browser library.");
    return;
  }
  await unlockLocalAudio();
  await pushRuntime(launchScene({
    library: state.libraryPack,
    runtime: state.runtime,
    sceneId,
    mode: "replace",
    now: safeNow(),
  }));
}

async function handleSaveCurrentScene() {
  const sceneName = state.draft.sceneName.trim()
    || state.roomState.activeScene?.name
    || "New scene";
  const nextTracks = collectCurrentMixTracks(state.runtime, state.libraryPack);
  if (!nextTracks.length) {
    setError("There is no active mix to save.");
    return;
  }
  setBusy(true);
  clearError();
  try {
    const reusableSceneId = state.runtime.activeScenes.length === 1
      && state.runtime.activeScenes[0].sceneId !== LIVE_SCENE_ID
      ? state.runtime.activeScenes[0].sceneId
      : null;
    persistLibraryPack(upsertLibraryScene({
      library: state.libraryPack,
      sceneId: reusableSceneId,
      name: sceneName,
      tracks: nextTracks,
      now: safeNow(),
    }));
    syncDerivedState();
    state.draft.sceneName = "";
    setNotices(["Scene saved to this browser library. File import/export will be added later on top of the same runtime logic."]);
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
    const result = deleteSceneFromLibrary({
      library: state.libraryPack,
      runtime: state.runtime,
      sceneId,
      now: safeNow(),
    });
    persistLibraryPack(result.library);
    if (state.runtime.activeScenes.some((scene) => scene.sceneId === sceneId)) {
      await pushRuntime(result.runtime);
    } else {
      syncDerivedState();
      render();
    }
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
      roomRuntime: state.runtime,
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
}

function beginLocalOutputVolumeInteraction() {
  localOutputVolumeInteractionActive = true;
}

function finishLocalOutputVolumeInteraction() {
  const shouldRender = localOutputVolumeRenderPending;
  localOutputVolumeInteractionActive = false;
  localOutputVolumeRenderPending = false;
  if (shouldRender) {
    render();
  }
}

async function handleLocalOutputVolume(volume) {
  syncLocalOutputVolume(volume);
  setLocalOutputVolume(state.localOutputVolume);
  if (localOutputVolumeSyncHandle) {
    window.clearTimeout(localOutputVolumeSyncHandle);
    localOutputVolumeSyncHandle = 0;
  }
  await OBR.broadcast.sendMessage(
    LOCAL_CONTROL_CHANNEL,
    {
      type: "set-local-volume",
      volume: state.localOutputVolume,
    },
    { destination: "LOCAL" },
  );
}

function updateLocalVolumePreview(target) {
  const valueElement = target.parentElement?.querySelector("[data-local-volume-value]");
  if (valueElement) {
    valueElement.textContent = formatVolumeLabel(state.localOutputVolume);
  }
}

function queueLocalOutputVolumeSync() {
  if (localOutputVolumeSyncHandle) {
    window.clearTimeout(localOutputVolumeSyncHandle);
  }
  localOutputVolumeSyncHandle = window.setTimeout(() => {
    localOutputVolumeSyncHandle = 0;
    handleLocalOutputVolume(state.localOutputVolume).catch(() => {
      setError("Failed to update local player volume.");
    });
  }, 40);
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
                <span class="range-value">${state.roomState.transport.masterVolume}%</span>
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
        <span class="muted">Stored on this browser</span>
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
          step="0.1"
          value="${state.localOutputVolume}"
        />
        <span class="range-value" data-local-volume-value>${formatVolumeLabel(state.localOutputVolume)}</span>
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
          <p class="muted">Paste a direct YouTube or YouTube Music watch link and add it straight to the local live mix.</p>
        </div>
        <button class="action-button" data-action="add-track" ${state.busy ? "disabled" : ""}>Add to mix</button>
      </div>
      <label class="field-label" for="track-url">Track URL</label>
      <input id="track-url" name="draftUrl" type="url" value="${escapeHtml(state.draft.url)}" placeholder="https://www.youtube.com/watch?v=..." />
      <label class="field-label" for="track-title">Custom title</label>
      <input id="track-title" name="draftTitle" type="text" value="${escapeHtml(state.draft.title)}" placeholder="Optional scene-friendly title" />
      <p class="muted">No helper is required now. Use a direct YouTube or YouTube Music link with a playable ID.</p>
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
          <span class="range-value">${layer.volume}%</span>
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
          <p class="muted">Scenes are currently stored on this browser. File import/export will be wired on top of this logic later.</p>
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

  if (localOutputVolumeInteractionActive) {
    localOutputVolumeRenderPending = true;
    return;
  }

  localOutputVolumeRenderPending = false;

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
    beginLocalOutputVolumeInteraction();
    syncLocalOutputVolume(target.value);
    updateLocalVolumePreview(target);
    queueLocalOutputVolumeSync();
  }
});

root?.addEventListener("focusin", (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement && target.name === "localOutputVolume") {
    beginLocalOutputVolumeInteraction();
  }
});

root?.addEventListener("pointerdown", (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement && target.name === "localOutputVolume") {
    beginLocalOutputVolumeInteraction();
  }
});

root?.addEventListener("focusout", (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement && target.name === "localOutputVolume") {
    window.setTimeout(() => {
      if (document.activeElement instanceof HTMLInputElement && document.activeElement.name === "localOutputVolume") {
        return;
      }
      finishLocalOutputVolumeInteraction();
    }, 0);
  }
});

root?.addEventListener("pointerup", (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement && target.name === "localOutputVolume") {
    finishLocalOutputVolumeInteraction();
  }
});

root?.addEventListener("pointercancel", (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement && target.name === "localOutputVolume") {
    finishLocalOutputVolumeInteraction();
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
      updateLocalVolumePreview(target);
      finishLocalOutputVolumeInteraction();
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
    state.runtime = ensureRoomRuntime(metadata[ROOM_STATE_KEY]);
    syncDerivedState();
    render();
  });

  OBR.player.onChange((player) => {
    state.role = player.role;
    syncLocalStatusFromPlayer(player);
    render();
  });

  OBR.broadcast.onMessage(BROADCAST_CHANNEL, (event) => {
    if (event.data?.roomState) {
      state.runtime = ensureRoomRuntime(event.data.roomState);
      syncDerivedState();
      render();
    }
  });

  state.loading = false;
  render();
});
