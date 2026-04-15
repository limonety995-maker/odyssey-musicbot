import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import OBR from "@owlbear-rodeo/sdk";
import { EmbeddedPlayer } from "./components/EmbeddedPlayer";
import { PlaylistInspector } from "./components/PlaylistInspector";
import { TreeBranch } from "./components/LibraryTree";
import { useLibraryStore } from "./hooks/useLibraryStore";
import type { LibraryNode, LibraryState, NodeId, PlaylistNode } from "./types";
import { readLocalVolume, writeLocalVolume } from "./localPlayerSettings";
import spriteUrl from "./sprite/sprite.svg";

type RouteState =
  | { type: "root" }
  | { type: "folder"; nodeId: NodeId }
  | { type: "playlist"; nodeId: NodeId };

type LoadedPlaylist = {
  id: NodeId;
  name: string;
  volume: number;
  isPlaying: boolean;
  isRepeatingTrack: boolean;
  currentTrackIndex: number;
  restartToken: number;
};

type SharedRoomState = {
  version: 1;
  library: LibraryState;
  playback: {
    loadedPlaylists: LoadedPlaylist[];
    masterVolume: number;
    isMuted: boolean;
  };
  updatedAt: number;
  updatedBy: string;
};

const ROOM_SYNC_KEY = "odyssey-music/sync-v1";
const SYNC_WRITE_DEBOUNCE_MS = 1200;
const SYNC_MIN_WRITE_INTERVAL_MS = 1200;
const SYNC_RATE_LIMIT_BACKOFF_MS = 5000;
const ACTION_WIDTH = 585;
const GM_POPOVER_HEIGHT = 400;
const PLAYER_COLLAPSED_HEIGHT = 52;
const PLAYER_EMPTY_EXPANDED_HEIGHT = 88;
const PLAYER_EXPANDED_HEIGHT = 150;

const spriteHref = new URL(spriteUrl, import.meta.url).toString();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isLoadedPlaylist(value: unknown): value is LoadedPlaylist {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.name === "string"
    && typeof value.volume === "number"
    && typeof value.isPlaying === "boolean"
    && typeof value.isRepeatingTrack === "boolean"
    && typeof value.currentTrackIndex === "number"
    && typeof value.restartToken === "number";
}

function asSharedRoomState(value: unknown): SharedRoomState | null {
  if (!isRecord(value) || value.version !== 1) {
    return null;
  }

  const playback = value.playback;
  if (!isRecord(playback)) {
    return null;
  }

  if (
    !Array.isArray(playback.loadedPlaylists)
    || !playback.loadedPlaylists.every(isLoadedPlaylist)
    || typeof playback.masterVolume !== "number"
    || typeof playback.isMuted !== "boolean"
    || !isRecord(value.library)
    || typeof value.updatedAt !== "number"
    || typeof value.updatedBy !== "string"
  ) {
    return null;
  }

  return value as SharedRoomState;
}

function isLibraryStateLike(value: unknown): value is LibraryState {
  if (!isRecord(value)) {
    return false;
  }

  if (!Array.isArray(value.rootIds) || !isRecord(value.nodesById) || !isRecord(value.tracksById)) {
    return false;
  }

  return value.rootIds.every((id) => typeof id === "string");
}

function buildSharedSignature(input: {
  library: LibraryState;
  playback: SharedRoomState["playback"];
}) {
  return JSON.stringify({
    library: input.library,
    playback: input.playback,
  });
}

type NodeModalMode =
  | { type: "closed" }
  | { type: "edit"; nodeId: NodeId }
  | { type: "create"; nodeType: "folder" | "playlist" };

function parseRouteFromHash(): RouteState {
  const hash = window.location.hash.replace(/^#/, "");
  const segments = hash.split("/").filter(Boolean);

  if (
    segments.length === 2 &&
    (segments[0] === "folder" || segments[0] === "playlist")
  ) {
    return {
      type: segments[0],
      nodeId: decodeURIComponent(segments[1]),
    };
  }

  return { type: "root" };
}

function getNodeRoute(node: LibraryNode | null) {
  if (!node) {
    return "#/";
  }

  return `#/${node.type}/${encodeURIComponent(node.id)}`;
}

function getRouteForNodeId(type: "folder" | "playlist", nodeId: NodeId) {
  return `#/${type}/${encodeURIComponent(nodeId)}`;
}

function getParentFolderId(
  node: LibraryNode | null,
  getNode: (nodeId: NodeId) => LibraryNode | null,
) {
  if (!node?.parentId) {
    return null;
  }

  const parentNode = getNode(node.parentId);
  return parentNode?.type === "folder" ? parentNode.id : null;
}

export function App() {
  const {
    addTrackToPlaylist,
    createFolder,
    createPlaylist,
    deleteNode,
    getNode,
    getTrackCount,
    getTracksForPlaylist,
    library,
    replaceLibrary,
    removeTrackFromPlaylist,
    updateNode,
  } = useLibraryStore();
  const [route, setRoute] = useState<RouteState>(() => parseRouteFromHash());
  const [loadedPlaylists, setLoadedPlaylists] = useState<LoadedPlaylist[]>([]);
  const [showLoadedTracks, setShowLoadedTracks] = useState(false);
  const [volume, setVolume] = useState(70);
  const [localVolume, setLocalVolume] = useState(() => readLocalVolume());
  const [isMuted, setIsMuted] = useState(false);
  const [nodeModal, setNodeModal] = useState<NodeModalMode>({ type: "closed" });
  const [nodeNameDraft, setNodeNameDraft] = useState("");
  const [nodeColorDraft, setNodeColorDraft] = useState("#f4b463");
  const [isOwlbearReady, setIsOwlbearReady] = useState(false);
  const [isGm, setIsGm] = useState(true);
  const applyingRemoteStateRef = useRef(false);
  const playerIdRef = useRef<string>("local");
  const lastSharedSignatureRef = useRef<string>("");
  const pendingSharedStateRef = useRef<SharedRoomState | null>(null);
  const syncWriteTimerRef = useRef<number | null>(null);
  const lastSyncWriteAtRef = useRef(0);
  const nextSyncWriteAllowedAtRef = useRef(0);
  
  useEffect(() => {
    const handleHashChange = () => {
      setRoute(parseRouteFromHash());
    };

    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unsubscribeRoomMetadata: (() => void) | undefined;

    const applySharedState = (sharedState: SharedRoomState) => {
      if (!isLibraryStateLike(sharedState.library)) {
        return;
      }

      const incomingSignature = buildSharedSignature({
        library: sharedState.library,
        playback: sharedState.playback,
      });
      if (incomingSignature === lastSharedSignatureRef.current) {
        return;
      }

      applyingRemoteStateRef.current = true;
      try {
        replaceLibrary(sharedState.library);
        setLoadedPlaylists(sharedState.playback.loadedPlaylists);
        setVolume(sharedState.playback.masterVolume);
        setIsMuted(sharedState.playback.isMuted);
        lastSharedSignatureRef.current = incomingSignature;
      } finally {
        applyingRemoteStateRef.current = false;
      }
    };

    OBR.onReady(() => {
      if (cancelled) {
        return;
      }

      void (async () => {
        const [role, metadata] = await Promise.all([
          OBR.player.getRole(),
          OBR.room.getMetadata(),
        ]);
        if (cancelled) {
          return;
        }

        playerIdRef.current = OBR.player.id;
        setIsGm(role === "GM");
        setIsOwlbearReady(true);

        const initialShared = asSharedRoomState(metadata[ROOM_SYNC_KEY]);
        if (initialShared) {
          applySharedState(initialShared);
        }

        unsubscribeRoomMetadata = OBR.room.onMetadataChange((nextMetadata) => {
          if (cancelled) {
            return;
          }

          const nextShared = asSharedRoomState(nextMetadata[ROOM_SYNC_KEY]);
          if (!nextShared) {
            return;
          }

          if (nextShared.updatedBy === playerIdRef.current) {
            return;
          }

          applySharedState(nextShared);
        });
      })();
    });

    return () => {
      cancelled = true;
      unsubscribeRoomMetadata?.();
      if (syncWriteTimerRef.current !== null) {
        window.clearTimeout(syncWriteTimerRef.current);
        syncWriteTimerRef.current = null;
      }
    };
  }, [replaceLibrary]);

  useEffect(() => {
    if (!isOwlbearReady || !isGm || applyingRemoteStateRef.current) {
      return;
    }

    const nextShared: SharedRoomState = {
      version: 1,
      library,
      playback: {
        loadedPlaylists,
        masterVolume: volume,
        isMuted,
      },
      updatedAt: Date.now(),
      updatedBy: playerIdRef.current,
    };

    const signature = buildSharedSignature({
      library: nextShared.library,
      playback: nextShared.playback,
    });
    if (signature === lastSharedSignatureRef.current) {
      return;
    }

    pendingSharedStateRef.current = nextShared;
    if (syncWriteTimerRef.current !== null) {
      return;
    }

    const now = Date.now();
    const waitUntil = Math.max(
      now + SYNC_WRITE_DEBOUNCE_MS,
      lastSyncWriteAtRef.current + SYNC_MIN_WRITE_INTERVAL_MS,
      nextSyncWriteAllowedAtRef.current,
    );
    const waitMs = Math.max(waitUntil - now, 0);

    syncWriteTimerRef.current = window.setTimeout(() => {
      syncWriteTimerRef.current = null;
      const pendingSharedState = pendingSharedStateRef.current;
      if (!pendingSharedState || !isGm || !isOwlbearReady) {
        return;
      }

      pendingSharedStateRef.current = null;
      const nextSignature = buildSharedSignature({
        library: pendingSharedState.library,
        playback: pendingSharedState.playback,
      });

      void OBR.room
        .setMetadata({ [ROOM_SYNC_KEY]: pendingSharedState })
        .then(() => {
          lastSyncWriteAtRef.current = Date.now();
          lastSharedSignatureRef.current = nextSignature;
          nextSyncWriteAllowedAtRef.current = lastSyncWriteAtRef.current;
        })
        .catch((error: unknown) => {
          const message = typeof error === "string"
            ? error
            : error instanceof Error
              ? error.message
              : "";

          if (message.includes("4003") || message.toLowerCase().includes("rate")) {
            nextSyncWriteAllowedAtRef.current = Date.now() + SYNC_RATE_LIMIT_BACKOFF_MS;
          }

          // Keep pending data queued; next local change will attempt a write again.
          pendingSharedStateRef.current = pendingSharedState;
        });
    }, waitMs);
  }, [isGm, isMuted, isOwlbearReady, library, loadedPlaylists, volume]);

  const activeNode = useMemo(() => {
    if (route.type === "root") {
      return null;
    }

    return getNode(route.nodeId);
  }, [getNode, route]);

  useEffect(() => {
    if (route.type !== "root" && !activeNode) {
      window.location.hash = "#/";
      setNodeModal({ type: "closed" });
    }
  }, [activeNode, route]);

  useEffect(() => {
    if (nodeModal.type !== "edit" || !activeNode) {
      if (nodeModal.type === "edit" && !activeNode) {
        setNodeModal({ type: "closed" });
      }
      return;
    }

    setNodeNameDraft(activeNode.name);
    setNodeColorDraft(activeNode.iconColor);
  }, [activeNode, nodeModal]);

  const visibleNodeIds = useMemo(() => {
    if (route.type === "root") {
      return library.rootIds;
    }

    if (!activeNode) {
      return library.rootIds;
    }

    return activeNode.type === "folder" ? activeNode.childIds : [];
  }, [activeNode, library.rootIds, route]);

  const activeFolderId =
    activeNode?.type === "folder"
      ? activeNode.id
      : getParentFolderId(activeNode, getNode);

  const pathItems = useMemo(() => {
    const trail: Array<{ id: NodeId | null; label: string }> = [
      { id: null, label: "Main" },
    ];

    const lineage: LibraryNode[] = [];
    let currentNode = activeNode;
    while (currentNode) {
      lineage.unshift(currentNode);
      currentNode = currentNode.parentId ? getNode(currentNode.parentId) : null;
    }

    for (const node of lineage) {
      trail.push({ id: node.id, label: node.name });
    }

    return trail;
  }, [activeNode, getNode]);

  const activePlaylist = activeNode?.type === "playlist" ? activeNode : null;
  const activePlaylistTracks = activePlaylist
    ? getTracksForPlaylist(activePlaylist.id)
    : [];

  const loadedPlaylistPlayers = useMemo(
    () =>
      loadedPlaylists
        .map((playlist) => {
          const node = library.nodesById[playlist.id];
          const tracks =
            node?.type === "playlist"
              ? node.trackIds
                  .map((trackId: string) => library.tracksById[trackId])
                  .filter(Boolean)
              : [];

          return {
            playlistId: playlist.id,
            name: playlist.name,
            volume: playlist.volume,
            isPlaying: playlist.isPlaying,
            isRepeatingTrack: playlist.isRepeatingTrack,
            currentTrackIndex: Math.min(
              playlist.currentTrackIndex,
              Math.max(tracks.length - 1, 0),
            ),
            restartToken: playlist.restartToken,
            tracks,
          };
        })
        .filter((playlist) => playlist.tracks.length > 0),
    [library.nodesById, library.tracksById, loadedPlaylists],
  );

  useEffect(() => {
    setLoadedPlaylists((current) => {
      let changed = false;
      const next = current
        .filter((playlist) => library.nodesById[playlist.id]?.type === "playlist")
        .map((playlist) => {
          const node = library.nodesById[playlist.id];
          if (node?.type !== "playlist") {
            changed = true;
            return playlist;
          }

          const nextIndex = Math.min(
            playlist.currentTrackIndex,
            Math.max(node.trackIds.length - 1, 0),
          );

          if (nextIndex !== playlist.currentTrackIndex || playlist.name !== node.name) {
            changed = true;
            return {
              ...playlist,
              name: node.name,
              currentTrackIndex: nextIndex,
            };
          }

          return playlist;
        });

      return !changed && next.length === current.length ? current : next;
    });
  }, [library.nodesById, library.tracksById]);

  function navigateToNode(nodeId: NodeId) {
    const node = getNode(nodeId);
    window.location.hash = getNodeRoute(node);
  }

  function navigateToRoot() {
    window.location.hash = "#/";
  }

  function loadPlaylist(playlist: PlaylistNode) {
    setLoadedPlaylists((current) => {
      if (current.some((entry) => entry.id === playlist.id)) {
        return current;
      }

      return [
        ...current,
        {
          id: playlist.id,
          name: playlist.name,
          volume: 100,
          isPlaying: true,
          isRepeatingTrack: false,
          currentTrackIndex: 0,
          restartToken: 0,
        },
      ];
    });
  }

  function resumePlayback() {
    if (loadedPlaylists.length > 0) {
      setLoadedPlaylists((current) =>
        current.map((playlist) => ({ ...playlist, isPlaying: true })),
      );
    }
  }

  function pausePlayback() {
    if (loadedPlaylists.length > 0) {
      setLoadedPlaylists((current) =>
        current.map((playlist) => ({ ...playlist, isPlaying: false })),
      );
    }
  }

  function stopPlayback() {
    setLoadedPlaylists([]);
  }

  function stepPlaylistTrack(playlistId: NodeId, direction: -1 | 1) {
    const playlistNode = library.nodesById[playlistId];
    if (!playlistNode || playlistNode.type !== "playlist") {
      return;
    }

    const trackCount = playlistNode.trackIds.length;
    if (trackCount === 0) {
      return;
    }

    setLoadedPlaylists((current) =>
      current.map((playlist) => {
        if (playlist.id !== playlistId) {
          return playlist;
        }

        const nextTrackIndex =
          (playlist.currentTrackIndex + direction + trackCount) % trackCount;

        return {
          ...playlist,
          currentTrackIndex: nextTrackIndex,
          isPlaying: true,
          restartToken: 0,
        };
      }),
    );
  }

  function advancePlaylistTrack(playlistId: NodeId) {
    const playlistNode = library.nodesById[playlistId];
    if (!playlistNode || playlistNode.type !== "playlist") {
      return;
    }

    setLoadedPlaylists((current) =>
      current.map((playlist) => {
        if (playlist.id !== playlistId) {
          return playlist;
        }

        if (playlist.isRepeatingTrack) {
          return {
            ...playlist,
            isPlaying: true,
            restartToken: playlist.restartToken + 1,
          };
        }

        const lastTrackIndex = Math.max(playlistNode.trackIds.length - 1, 0);
        if (playlist.currentTrackIndex < lastTrackIndex) {
          return {
            ...playlist,
            currentTrackIndex: playlist.currentTrackIndex + 1,
            isPlaying: true,
            restartToken: 0,
          };
        }

        return {
          ...playlist,
          currentTrackIndex: 0,
          isPlaying: true,
          restartToken: 0,
        };
      }),
    );
  }

  function openEditModal() {
    if (!activeNode) {
      return;
    }

    setNodeNameDraft(activeNode.name);
    setNodeColorDraft(activeNode.iconColor);
    setNodeModal({ type: "edit", nodeId: activeNode.id });
  }

  function openCreateModal(nodeType: "folder" | "playlist") {
    setNodeNameDraft(nodeType === "folder" ? "New folder" : "New playlist");
    setNodeColorDraft(nodeType === "folder" ? "#f4b463" : "#7ed4ff");
    setNodeModal({ type: "create", nodeType });
  }

  function closeNodeModal() {
    setNodeModal({ type: "closed" });
  }

  function submitNodeModal() {
    if (nodeModal.type === "edit") {
      if (!activeNode) {
        return;
      }

      updateNode(activeNode.id, {
        name: nodeNameDraft,
        iconColor: nodeColorDraft,
      });
      window.location.hash = getNodeRoute(activeNode);
      closeNodeModal();
      return;
    }

    if (nodeModal.type === "create") {
      if (nodeModal.nodeType === "folder") {
        const folderId = createFolder(nodeNameDraft, nodeColorDraft);
        if (folderId) {
          closeNodeModal();
          window.location.hash = getRouteForNodeId("folder", folderId);
        }
        return;
      }

      if (!activeFolderId) {
        return;
      }

      const playlistId = createPlaylist(
        activeFolderId,
        nodeNameDraft,
        nodeColorDraft,
      );
      if (playlistId) {
        closeNodeModal();
        window.location.hash = getRouteForNodeId("folder", activeFolderId);
      }
    }
  }

  function deleteCurrentNode() {
    if (!activeNode) {
      return;
    }

    const parentRoute =
      activeNode.parentId && getNode(activeNode.parentId)?.type === "folder"
        ? getRouteForNodeId("folder", activeNode.parentId)
        : "#/";

    window.location.hash = parentRoute;
    deleteNode(activeNode.id);
    setLoadedPlaylists((current) =>
      current.filter((playlist) => playlist.id !== activeNode.id),
    );
    closeNodeModal();
  }

  const primaryPlaylist = loadedPlaylists[0] ?? null;
  const primaryPlaylistCandidate = primaryPlaylist
    ? library.nodesById[primaryPlaylist.id]
    : null;
  const primaryPlaylistNode =
    primaryPlaylistCandidate?.type === "playlist"
      ? primaryPlaylistCandidate
      : null;
  const primaryTrackId =
    primaryPlaylistNode?.trackIds[primaryPlaylist.currentTrackIndex] ?? null;
  const primaryTrackTitle = primaryTrackId
    ? library.tracksById[primaryTrackId]?.title
    : null;
  const isDiskSpinning = loadedPlaylists.some((playlist) => playlist.isPlaying);
  const canCreatePlaylist =
    route.type === "folder" && activeNode?.type === "folder";
  const isPlayerView = isOwlbearReady && !isGm;
  const isLoadedPanelOpen = showLoadedTracks;
  const visibleVolume = isPlayerView ? localVolume : isMuted ? 0 : volume;
  const playbackVolume = isPlayerView ? localVolume : volume;

  useEffect(() => {
    document.body.classList.toggle("player-view-body", isPlayerView);
    return () => {
      document.body.classList.remove("player-view-body");
    };
  }, [isPlayerView]);

  useEffect(() => {
    if (!isOwlbearReady) {
      return;
    }

    void OBR.action.setWidth(ACTION_WIDTH);
    void OBR.action.setHeight(
      isPlayerView
        ? showLoadedTracks
          ? loadedPlaylists.length > 0
            ? PLAYER_EXPANDED_HEIGHT
            : PLAYER_EMPTY_EXPANDED_HEIGHT
          : PLAYER_COLLAPSED_HEIGHT
        : GM_POPOVER_HEIGHT,
    );
  }, [isOwlbearReady, isPlayerView, loadedPlaylists.length, showLoadedTracks]);

  return (
    <div className={`container ${isPlayerView ? "player-view" : ""}`}>
      
      {!isPlayerView ? (
        <>
          <nav className="navigation">
            <div className="header-container">
              <svg width="16" height="16" className="icon">
                <use xlinkHref={`${spriteHref}#icon-folderempty`}></use>
              </svg>
              <div className="breadcrumb">
                {pathItems.map((item, index) => (
                  <button
                    key={item.id ?? "root"}
                    className={`breadcrumb-link ${index === pathItems.length - 1 ? "is-current" : ""}`}
                    type="button"
                    onClick={() => {
                      if (item.id) {
                        navigateToNode(item.id);
                        return;
                      }

                      navigateToRoot();
                    }}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
            <button
              className="icon-button"
              type="button"
              onClick={openEditModal}
              disabled={!activeNode}
            >
              <svg width="16" height="16" className="icon">
                <use xlinkHref={`${spriteHref}#icon-edit`}></use>
              </svg>
            </button>
          </nav>

          <section className="content-container">
            {activePlaylist ? (
              <PlaylistInspector
                selectedPlaylist={activePlaylist}
                trackCount={getTrackCount(activePlaylist.id)}
                tracks={activePlaylistTracks}
                onAddTrack={(title, url) =>
                  addTrackToPlaylist(activePlaylist.id, title, url)
                }
                onRemoveTrack={(trackId) =>
                  removeTrackFromPlaylist(activePlaylist.id, trackId)
                }
              />
            ) : (
              <>
                <ul className="folder-list">
                  {visibleNodeIds.map((nodeId) => (
                    <TreeBranch
                      key={nodeId}
                      nodeId={nodeId}
                      getNode={getNode}
                      isActive={activeNode?.id === nodeId}
                      onNavigate={navigateToNode}
                      onLoadPlaylist={loadPlaylist}
                    />
                  ))}
                  {route.type === "root" ? (
                    <li className="list-item">
                      <button
                        className="icon-button folder"
                        type="button"
                        onClick={() => {
                          openCreateModal("folder");
                        }}
                      >
                        <svg width="72" height="72" className="icon node-icon">
                          <use xlinkHref={`${spriteHref}#icon-addfolder`}></use>
                        </svg>
                        New folder
                      </button>
                    </li>
                  ) : null}
                  {canCreatePlaylist ? (
                    <li className="list-item">
                      <button
                        className="icon-button folder"
                        type="button"
                        onClick={() => {
                          openCreateModal("playlist");
                        }}
                      >
                        <svg
                          width="72"
                          height="72"
                          className="icon node-icon playlist-create-icon"
                        >
                          <use xlinkHref={`${spriteHref}#icon-addfolder`}></use>
                        </svg>
                        New playlist
                      </button>
                    </li>
                  ) : null}
                </ul>
                {visibleNodeIds.length === 0 ? (
                  <div className="empty-state">
                    <p className="muted">
                      {route.type === "root"
                        ? "Your main view starts with folders. Create one to organize your playlists."
                        : "This folder has no playlists yet. Create one to start adding tracks."}
                    </p>
                  </div>
                ) : null}
              </>
            )}
          </section>
        </>
      ) : null}

      <footer className="audioplayer-container">
        <div className="footer-main-row">
          <div className="song-name-container">
            {!isPlayerView ? (
              <button
                className="icon-button"
                type="button"
                onClick={() => setShowLoadedTracks((current) => !current)}
              >
                <svg width="16" height="16" className="icon">
                  <use
                    xlinkHref={`${spriteHref}#${showLoadedTracks ? "icon-up" : "icon-down"}`}
                  ></use>
                </svg>
              </button>
            ) : (
              <button
                className="icon-button player-panel-toggle"
                type="button"
                aria-label={showLoadedTracks ? "Hide loaded music" : "Show loaded music"}
                onClick={() => setShowLoadedTracks((current) => !current)}
              >
                <svg width="16" height="16" className="icon">
                  <use
                    xlinkHref={`${spriteHref}#${showLoadedTracks ? "icon-up" : "icon-down"}`}
                  ></use>
                </svg>
              </button>
            )}
            <svg
              height="28"
              width="28"
              className={`icon ${isDiskSpinning ? "disk-playing" : ""}`}
            >
              <use xlinkHref={`${spriteHref}#icon-Subtract`}></use>
            </svg>
            <div className="song-meta">
              <p>
                {primaryTrackTitle ?? primaryPlaylist?.name ?? activePlaylist?.name ?? "Song name"}
              </p>
              <p className="muted">
                {loadedPlaylists.length > 0
                  ? primaryPlaylist
                    ? `${primaryPlaylist.name} - ${loadedPlaylists.length} playlist${loadedPlaylists.length === 1 ? "" : "s"} loaded`
                    : `${loadedPlaylists.length} playlist${loadedPlaylists.length === 1 ? "" : "s"} loaded`
                  : "Nothing loaded"}
              </p>
            </div>
          </div>
          {!isPlayerView ? (
            <div className="play-bar">
              <button
                className="icon-button"
                type="button"
                onClick={resumePlayback}
              >
                <svg width="16" height="16" className="icon">
                  <use xlinkHref={`${spriteHref}#icon-play`}></use>
                </svg>
              </button>
              <button
                className="icon-button"
                type="button"
                onClick={pausePlayback}
              >
                <svg width="16" height="16" className="icon">
                  <use xlinkHref={`${spriteHref}#icon-pause`}></use>
                </svg>
              </button>
              <button
                className="icon-button"
                type="button"
                onClick={stopPlayback}
              >
                <svg width="16" height="16" className="icon">
                  <use xlinkHref={`${spriteHref}#icon-stop`}></use>
                </svg>
              </button>
            </div>
          ) : null}
          <div className="volume-controls">
            {!isPlayerView ? (
              <button
                className="icon-button"
                type="button"
                onClick={() => setIsMuted((current) => !current)}
              >
                <svg width="16" height="16" className="icon">
                  <use
                    xlinkHref={`${spriteHref}#${isMuted ? "icon-mute" : "icon-loud"}`}
                  ></use>
                </svg>
              </button>
            ) : null}
            <input
              className="volume-slider"
              type="range"
              min="0"
              max="100"
              value={visibleVolume}
              style={
                { "--slider-fill": `${visibleVolume}%` } as CSSProperties
              }
              onChange={(event) => {
                const nextVolume = Number(event.target.value);
                if (isPlayerView) {
                  setLocalVolume(writeLocalVolume(nextVolume));
                  return;
                }

                setVolume(nextVolume);
                setIsMuted(nextVolume === 0);
              }}
            />
          </div>
        </div>
        {isLoadedPanelOpen ? (
          <div className="loaded-track-panel">
            {loadedPlaylists.length > 0 ? (
              <>
                <ul className="loaded-track-list">
                  {loadedPlaylists.map((playlist) => {
                    const playlistNode = library.nodesById[playlist.id];
                    const trackIds =
                      playlistNode && playlistNode.type === "playlist"
                        ? playlistNode.trackIds
                        : [];
                    const currentTrackId =
                      trackIds[playlist.currentTrackIndex] ?? null;
                    const currentTrackTitle = currentTrackId
                      ? library.tracksById[currentTrackId]?.title
                      : null;

                    return (
                      <li
                        key={playlist.id}
                        className="loaded-track-item loaded-playlist-item"
                      >
                        <div className="loaded-playlist-meta">
                          <div className="loaded-playlist-copy">
                            <span>{playlist.name}</span>
                            <p className="muted">
                              {currentTrackTitle ?? "No track selected"}
                            </p>
                          </div>
                          <div className="playlist-controls-row">
                            {!isPlayerView ? (
                              <>
                                <button
                                  className="icon-button playlist-inline-control"
                                  type="button"
                                  onClick={() => stepPlaylistTrack(playlist.id, -1)}
                                  disabled={trackIds.length === 0}
                                >
                                  <svg width="16" height="16" className="icon">
                                    <use xlinkHref={`${spriteHref}#icon-back`}></use>
                                  </svg>
                                </button>
                                <button
                                  className="icon-button playlist-inline-control"
                                  type="button"
                                  onClick={() => {
                                    setLoadedPlaylists((current) =>
                                      current.map((entry) =>
                                        entry.id === playlist.id
                                          ? { ...entry, isPlaying: true }
                                          : entry,
                                      ),
                                    );
                                  }}
                                >
                                  <svg width="16" height="16" className="icon">
                                    <use xlinkHref={`${spriteHref}#icon-play`}></use>
                                  </svg>
                                </button>
                                <button
                                  className="icon-button playlist-inline-control"
                                  type="button"
                                  onClick={() => {
                                    setLoadedPlaylists((current) =>
                                      current.map((entry) =>
                                        entry.id === playlist.id
                                          ? { ...entry, isPlaying: false }
                                          : entry,
                                      ),
                                    );
                                  }}
                                >
                                  <svg width="16" height="16" className="icon">
                                    <use xlinkHref={`${spriteHref}#icon-pause`}></use>
                                  </svg>
                                </button>
                                <button
                                  className={`icon-button playlist-inline-control ${playlist.isRepeatingTrack ? "is-active" : ""}`}
                                  type="button"
                                  onClick={() => {
                                    setLoadedPlaylists((current) =>
                                      current.map((entry) =>
                                        entry.id === playlist.id
                                          ? {
                                              ...entry,
                                              isRepeatingTrack: !entry.isRepeatingTrack,
                                            }
                                          : entry,
                                      ),
                                    );
                                  }}
                                >
                                  <svg width="16" height="16" className="icon">
                                    <use xlinkHref={`${spriteHref}#icon-repeat`}></use>
                                  </svg>
                                </button>
                                <button
                                  className="icon-button playlist-inline-control"
                                  type="button"
                                  onClick={() => stepPlaylistTrack(playlist.id, 1)}
                                  disabled={trackIds.length === 0}
                                >
                                  <svg width="16" height="16" className="icon">
                                    <use xlinkHref={`${spriteHref}#icon-next`}></use>
                                  </svg>
                                </button>
                              </>
                            ) : null}
                          </div>
                          {!isPlayerView ? (
                            <input
                              className="volume-slider playlist-volume-slider"
                              type="range"
                              min="0"
                              max="100"
                              value={playlist.volume}
                              style={
                                {
                                  "--slider-fill": `${playlist.volume}%`,
                                } as CSSProperties
                              }
                              onChange={(event) => {
                                const nextVolume = Number(event.target.value);
                                setLoadedPlaylists((current) =>
                                  current.map((entry) =>
                                    entry.id === playlist.id
                                      ? { ...entry, volume: nextVolume }
                                      : entry,
                                  ),
                                );
                              }}
                            />
                          ) : null}
                          {!isPlayerView ? (
                            <>
                              <button
                                className="icon-button"
                                type="button"
                                onClick={() => {
                                  setLoadedPlaylists((current) =>
                                    current.filter(
                                      (entry) => entry.id !== playlist.id,
                                    ),
                                  );
                                }}
                              >
                                <svg width="20" height="20" className="trash">
                                  <use xlinkHref={`${spriteHref}#icon-trash`}></use>
                                </svg>
                              </button>
                            </>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </>
            ) : (
              <p className="muted">No playlists are loaded yet.</p>
            )}
          </div>
        ) : null}
        <EmbeddedPlayer
          playlists={loadedPlaylistPlayers}
          masterVolume={playbackVolume}
          isMuted={isMuted}
          onPlaylistEnded={advancePlaylistTrack}
        />
      </footer>

      {!isPlayerView && nodeModal.type !== "closed" ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={closeNodeModal}
        >
          <div
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-label={
              nodeModal.type === "edit"
                ? `Edit ${activeNode?.type ?? "node"}`
                : `Create ${nodeModal.nodeType}`
            }
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <div>
                <p className="section-eyebrow">
                  {nodeModal.type === "edit"
                    ? `Edit ${activeNode?.type ?? "node"}`
                    : `Create ${nodeModal.nodeType}`}
                </p>
                <h3 className="modal-title">
                  {nodeModal.type === "edit"
                    ? (activeNode?.name ?? "")
                    : nodeModal.nodeType === "folder"
                      ? "New folder"
                      : "New playlist"}
                </h3>
              </div>
              <button
                className="icon-button"
                type="button"
                onClick={closeNodeModal}
              >
                Close
              </button>
            </div>
            <div className="inspector-form">
              <label className="field-label" htmlFor="node-name">
                Name
              </label>
              <input
                id="node-name"
                className="text-input"
                type="text"
                value={nodeNameDraft}
                onChange={(event) => setNodeNameDraft(event.target.value)}
              />
              <label className="field-label" htmlFor="node-color">
                Icon color
              </label>
              <input
                id="node-color"
                className="color-input"
                type="color"
                value={nodeColorDraft}
                onChange={(event) => setNodeColorDraft(event.target.value)}
              />
            </div>
            <div className="modal-actions">
              <button
                className="action-button"
                type="button"
                onClick={submitNodeModal}
              >
                {nodeModal.type === "edit" ? "Save" : "Create"}
              </button>
              <button
                className="ghost-button"
                type="button"
                onClick={closeNodeModal}
              >
                Cancel
              </button>
              {nodeModal.type === "edit" ? (
                <button
                  className="ghost-button danger-button-subtle"
                  type="button"
                  onClick={deleteCurrentNode}
                >
                  <svg width="16" height="16" className="icon">
                    <use xlinkHref={`${spriteHref}#icon-trash`}></use>
                  </svg>
                  Delete
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}


