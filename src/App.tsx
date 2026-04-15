import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import OBR from "@owlbear-rodeo/sdk";
import { PlaylistInspector } from "./components/PlaylistInspector";
import { TreeBranch } from "./components/LibraryTree";
import { useLibraryStore } from "./hooks/useLibraryStore";
import type { LibraryNode, NodeId, PlaylistNode } from "./types";
import {
  PLAYER_LOCAL_VOLUME_KEY,
  ROOM_SYNC_KEY,
  asSharedRoomState,
  buildSharedSignature,
  type LoadedPlaylist,
  type SharedLoadedPlaylist,
  type SharedRoomState,
} from "./sharedSync";
import spriteUrl from "./sprite/sprite.svg";

type RouteState =
  | { type: "root" }
  | { type: "folder"; nodeId: NodeId }
  | { type: "playlist"; nodeId: NodeId };

const SYNC_WRITE_DEBOUNCE_MS = 1200;
const SYNC_MIN_WRITE_INTERVAL_MS = 1200;
const SYNC_RATE_LIMIT_BACKOFF_MS = 5000;
const PLAYER_COLLAPSED_HEIGHT = 48;
const PLAYER_MAX_EXPANDED_HEIGHT = 210;

const spriteHref = new URL(spriteUrl, import.meta.url).toString();

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

function clampVolume(value: number) {
  return Math.min(100, Math.max(0, Math.round(value)));
}

function getStoredPlayerVolume() {
  const storedVolume = window.localStorage.getItem(PLAYER_LOCAL_VOLUME_KEY);
  if (storedVolume === null) {
    return 100;
  }

  const parsedVolume = Number(storedVolume);
  return Number.isFinite(parsedVolume) ? clampVolume(parsedVolume) : 100;
}

function toLocalLoadedPlaylists(playlists: SharedLoadedPlaylist[]): LoadedPlaylist[] {
  return playlists.map(({ tracks: _tracks, ...playlist }) => playlist);
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
    removeTrackFromPlaylist,
    updateNode,
  } = useLibraryStore();
  const [route, setRoute] = useState<RouteState>(() => parseRouteFromHash());
  const [loadedPlaylists, setLoadedPlaylists] = useState<LoadedPlaylist[]>([]);
  const [remoteLoadedPlaylists, setRemoteLoadedPlaylists] = useState<SharedLoadedPlaylist[]>([]);
  const [showLoadedTracks, setShowLoadedTracks] = useState(false);
  const [volume, setVolume] = useState(70);
  const [playerVolume, setPlayerVolume] = useState(getStoredPlayerVolume);
  const [isMuted, setIsMuted] = useState(false);
  const [syncError, setSyncError] = useState("");
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
  const playerFooterRef = useRef<HTMLElement | null>(null);
  
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
      const incomingSignature = buildSharedSignature(sharedState.playback);
      if (incomingSignature === lastSharedSignatureRef.current) {
        return;
      }

      applyingRemoteStateRef.current = true;
      try {
        setRemoteLoadedPlaylists(sharedState.playback.loadedPlaylists);
        setLoadedPlaylists(toLocalLoadedPlaylists(sharedState.playback.loadedPlaylists));
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
  }, []);

  useEffect(() => {
    if (!isOwlbearReady || !isGm || applyingRemoteStateRef.current) {
      return;
    }

    const sharedLoadedPlaylists = loadedPlaylists.map((playlist): SharedLoadedPlaylist => {
      const playlistNode = library.nodesById[playlist.id];
      const tracks = playlistNode?.type === "playlist"
        ? playlistNode.trackIds
            .map((trackId) => library.tracksById[trackId])
            .filter(Boolean)
            .map((track) => ({
              id: track.id,
              title: track.title,
              url: track.url,
            }))
        : [];

      return {
        ...playlist,
        tracks,
      };
    });

    const playback: SharedRoomState["playback"] = {
      loadedPlaylists: sharedLoadedPlaylists,
      masterVolume: volume,
      isMuted,
    };

    const nextShared: SharedRoomState = {
      version: 2,
      playback,
      updatedAt: Date.now(),
      updatedBy: playerIdRef.current,
    };

    const signature = buildSharedSignature(nextShared.playback);
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
      const nextSignature = buildSharedSignature(pendingSharedState.playback);

      void OBR.room
        .setMetadata({ [ROOM_SYNC_KEY]: pendingSharedState })
        .then(() => {
          setSyncError("");
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
          setSyncError(
            "Music sync could not be shared to the room. Try unloading playlists or using fewer tracks.",
          );
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

  useEffect(() => {
    if (!isGm) {
      return;
    }

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
  }, [isGm, library.nodesById, library.tracksById]);

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

  const isPlayerView = isOwlbearReady && !isGm;
  const localSharedLoadedPlaylists = useMemo(
    () =>
      loadedPlaylists.map((playlist): SharedLoadedPlaylist => {
        const playlistNode = library.nodesById[playlist.id];
        const tracks = playlistNode?.type === "playlist"
          ? playlistNode.trackIds
              .map((trackId) => library.tracksById[trackId])
              .filter(Boolean)
              .map((track) => ({
                id: track.id,
                title: track.title,
                url: track.url,
              }))
          : [];

        return {
          ...playlist,
          tracks,
        };
      }),
    [library.nodesById, library.tracksById, loadedPlaylists],
  );
  const displayedLoadedPlaylists = isPlayerView
    ? remoteLoadedPlaylists
    : localSharedLoadedPlaylists;
  const primaryPlaylist = displayedLoadedPlaylists[0] ?? null;
  const primaryTrackTitle =
    primaryPlaylist?.tracks[primaryPlaylist.currentTrackIndex]?.title ?? null;
  const isDiskSpinning = displayedLoadedPlaylists.some((playlist) => playlist.isPlaying);
  const canCreatePlaylist =
    route.type === "folder" && activeNode?.type === "folder";
  const isLoadedPanelOpen = showLoadedTracks;
  const displayedVolume = isPlayerView ? playerVolume : isMuted ? 0 : volume;

  useEffect(() => {
    document.body.classList.toggle("player-view-body", isPlayerView);
    return () => {
      document.body.classList.remove("player-view-body");
    };
  }, [isPlayerView]);

  useEffect(() => {
    if (!isPlayerView) {
      return;
    }

    window.localStorage.setItem(PLAYER_LOCAL_VOLUME_KEY, String(playerVolume));
  }, [isPlayerView, playerVolume]);

  useEffect(() => {
    const handleStorageChange = (event: StorageEvent) => {
      if (event.key !== PLAYER_LOCAL_VOLUME_KEY || event.newValue === null) {
        return;
      }

      const nextVolume = Number(event.newValue);
      if (Number.isFinite(nextVolume)) {
        setPlayerVolume(clampVolume(nextVolume));
      }
    };

    window.addEventListener("storage", handleStorageChange);
    return () => window.removeEventListener("storage", handleStorageChange);
  }, []);

  useEffect(() => {
    if (!isPlayerView || !isOwlbearReady) {
      return;
    }

    const resizePlayerPopover = () => {
      const footer = playerFooterRef.current;
      const footerStyles = footer ? window.getComputedStyle(footer) : null;
      const footerPadding =
        (Number.parseFloat(footerStyles?.paddingTop ?? "0") || 0)
        + (Number.parseFloat(footerStyles?.paddingBottom ?? "0") || 0);
      const footerGap = Number.parseFloat(footerStyles?.rowGap ?? footerStyles?.gap ?? "0") || 0;
      const contentHeight = footer
        ? Array.from(footer.children).reduce(
            (totalHeight, child, index) =>
              totalHeight + child.getBoundingClientRect().height + (index > 0 ? footerGap : 0),
            footerPadding,
          )
        : PLAYER_COLLAPSED_HEIGHT;
      const nextHeight = showLoadedTracks
        ? Math.min(Math.ceil(contentHeight), PLAYER_MAX_EXPANDED_HEIGHT)
        : PLAYER_COLLAPSED_HEIGHT;

      void OBR.action.setHeight(nextHeight);
    };

    resizePlayerPopover();
    const resizeFrame = window.requestAnimationFrame(resizePlayerPopover);
    return () => window.cancelAnimationFrame(resizeFrame);
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

      <footer className="audioplayer-container" ref={playerFooterRef}>
        <div className="footer-main-row">
          <div className="song-name-container">
            <button
              className="icon-button"
              type="button"
              aria-label={showLoadedTracks ? "Hide loaded playlists" : "Show loaded playlists"}
              onClick={() => setShowLoadedTracks((current) => !current)}
            >
              <svg width="16" height="16" className="icon">
                <use
                  xlinkHref={`${spriteHref}#${showLoadedTracks ? "icon-up" : "icon-down"}`}
                ></use>
              </svg>
            </button>
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
                {displayedLoadedPlaylists.length > 0
                  ? primaryPlaylist
                    ? `${primaryPlaylist.name} - ${displayedLoadedPlaylists.length} playlist${displayedLoadedPlaylists.length === 1 ? "" : "s"} loaded`
                    : `${displayedLoadedPlaylists.length} playlist${displayedLoadedPlaylists.length === 1 ? "" : "s"} loaded`
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
              value={displayedVolume}
              style={
                { "--slider-fill": `${displayedVolume}%` } as CSSProperties
              }
              onChange={(event) => {
                const nextVolume = Number(event.target.value);
                if (isPlayerView) {
                  setPlayerVolume(clampVolume(nextVolume));
                  return;
                }

                setVolume(nextVolume);
                setIsMuted(nextVolume === 0);
              }}
            />
          </div>
        </div>
        {!isPlayerView && syncError ? (
          <p className="form-error">{syncError}</p>
        ) : null}
        {isLoadedPanelOpen ? (
          <div className="loaded-track-panel">
            {displayedLoadedPlaylists.length > 0 ? (
              <>
                <ul className="loaded-track-list">
                  {displayedLoadedPlaylists.map((playlist) => {
                    const trackCount = playlist.tracks.length;
                    const currentTrackTitle =
                      playlist.tracks[playlist.currentTrackIndex]?.title ?? null;

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
                                  disabled={trackCount === 0}
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
                                  disabled={trackCount === 0}
                                >
                                  <svg width="16" height="16" className="icon">
                                    <use xlinkHref={`${spriteHref}#icon-next`}></use>
                                  </svg>
                                </button>
                              </>
                            ) : null}
                          </div>
                          {!isPlayerView ? (
                            <>
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


