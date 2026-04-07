import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { EmbeddedPlayer } from "./components/EmbeddedPlayer";
import { PlaylistInspector } from "./components/PlaylistInspector";
import { TreeBranch } from "./components/LibraryTree";
import { useLibraryStore } from "./hooks/useLibraryStore";
import type { LibraryNode, NodeId, PlaylistNode } from "./types";
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
    removeTrackFromPlaylist,
    updateNode,
  } = useLibraryStore();
  const [route, setRoute] = useState<RouteState>(() => parseRouteFromHash());
  const [loadedPlaylists, setLoadedPlaylists] = useState<LoadedPlaylist[]>([]);
  const [showLoadedTracks, setShowLoadedTracks] = useState(false);
  const [volume, setVolume] = useState(70);
  const [isMuted, setIsMuted] = useState(false);
  const [nodeModal, setNodeModal] = useState<NodeModalMode>({ type: "closed" });
  const [nodeNameDraft, setNodeNameDraft] = useState("");
  const [nodeColorDraft, setNodeColorDraft] = useState("#f4b463");
  const [spriteMarkup, setSpriteMarkup] = useState("");

  useEffect(() => {
    let cancelled = false;

    fetch(spriteUrl)
      .then((response) => {
        if (!response.ok) {
          throw new Error("Failed to load sprite.");
        }
        return response.text();
      })
      .then((markup) => {
        if (!cancelled) {
          setSpriteMarkup(markup.replace(/style="display:\s*none;?"/i, ""));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSpriteMarkup("");
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const handleHashChange = () => {
      setRoute(parseRouteFromHash());
    };

    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

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

  return (
    <div className="container">
      {spriteMarkup ? (
        <div
          aria-hidden="true"
          className="sprite-definitions"
          dangerouslySetInnerHTML={{ __html: spriteMarkup }}
        />
      ) : null}
      <nav className="navigation">
        <div className="header-container">
          <svg width="16" height="16" className="icon">
            <use xlinkHref={`#icon-folderempty`}></use>
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
            <use xlinkHref={`#icon-edit`}></use>
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
                      <use xlinkHref={`#icon-addfolder`}></use>
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
                      <use xlinkHref={`#icon-addfolder`}></use>
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

      <footer className="audioplayer-container">
        <div className="footer-main-row">
          <div className="song-name-container">
            <button
              className="icon-button"
              type="button"
              onClick={() => setShowLoadedTracks((current) => !current)}
            >
              <svg width="16" height="16" className="icon">
                <use
                  href={`#${showLoadedTracks ? "icon-up" : "icon-down"}`}
                ></use>
              </svg>
            </button>
            <svg
              height="28"
              width="28"
              className={`icon ${isDiskSpinning ? "disk-playing" : ""}`}
            >
              <use xlinkHref={`#icon-Subtract`}></use>
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
          <div className="play-bar">
            <button
              className="icon-button"
              type="button"
              onClick={resumePlayback}
            >
              <svg width="16" height="16" className="icon">
                <use xlinkHref={`#icon-play`}></use>
              </svg>
            </button>
            <button
              className="icon-button"
              type="button"
              onClick={pausePlayback}
            >
              <svg width="16" height="16" className="icon">
                <use xlinkHref={`#icon-pause`}></use>
              </svg>
            </button>
            <button
              className="icon-button"
              type="button"
              onClick={stopPlayback}
            >
              <svg width="16" height="16" className="icon">
                <use xlinkHref={`#icon-stop`}></use>
              </svg>
            </button>
          </div>
          <div className="volume-controls">
            <button
              className="icon-button"
              type="button"
              onClick={() => setIsMuted((current) => !current)}
            >
              <svg width="16" height="16" className="icon">
                <use
                  href={`#${isMuted ? "icon-mute" : "icon-loud"}`}
                ></use>
              </svg>
            </button>
            <input
              className="volume-slider"
              type="range"
              min="0"
              max="100"
              value={isMuted ? 0 : volume}
              style={
                { "--slider-fill": `${isMuted ? 0 : volume}%` } as CSSProperties
              }
              onChange={(event) => {
                const nextVolume = Number(event.target.value);
                setVolume(nextVolume);
                setIsMuted(nextVolume === 0);
              }}
            />
          </div>
        </div>
        {showLoadedTracks ? (
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
                            <button
                              className="icon-button playlist-inline-control"
                              type="button"
                              onClick={() => stepPlaylistTrack(playlist.id, -1)}
                              disabled={trackIds.length === 0}
                            >
                              <svg width="16" height="16" className="icon">
                                <use xlinkHref={`#icon-back`}></use>
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
                                <use xlinkHref={`#icon-play`}></use>
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
                                <use xlinkHref={`#icon-pause`}></use>
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
                                <use xlinkHref={`#icon-repeat`}></use>
                              </svg>
                            </button>
                            <button
                              className="icon-button playlist-inline-control"
                              type="button"
                              onClick={() => stepPlaylistTrack(playlist.id, 1)}
                              disabled={trackIds.length === 0}
                            >
                              <svg width="16" height="16" className="icon">
                                <use xlinkHref={`#icon-next`}></use>
                              </svg>
                            </button>
                          </div>
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
                              <use xlinkHref={`#icon-trash`}></use>
                            </svg>
                          </button>
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
          masterVolume={volume}
          isMuted={isMuted}
          onPlaylistEnded={advancePlaylistTrack}
        />
      </footer>

      {nodeModal.type !== "closed" ? (
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
                    <use xlinkHref={`#icon-trash`}></use>
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

