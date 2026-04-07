import { useEffect, useMemo, useState } from "react";
import type {
  FolderNode,
  LibraryNode,
  LibraryState,
  NodeId,
  PlaylistNode,
  Track,
} from "../types";

const initialLibraryState: LibraryState = {
  rootIds: ["folder-ambience", "playlist-battle"],
  nodesById: {
    "folder-ambience": {
      id: "folder-ambience",
      type: "folder",
      name: "Ambience",
      parentId: null,
      childIds: ["playlist-rain", "playlist-tavern"],
    },
    "playlist-rain": {
      id: "playlist-rain",
      type: "playlist",
      name: "Rainy Forest",
      parentId: "folder-ambience",
      trackIds: ["track-rain-1", "track-rain-2", "track-rain-3"],
    },
    "playlist-tavern": {
      id: "playlist-tavern",
      type: "playlist",
      name: "Tavern Night",
      parentId: "folder-ambience",
      trackIds: ["track-tavern-1", "track-tavern-2", "track-tavern-3", "track-tavern-4", "track-tavern-5"],
    },
    "playlist-battle": {
      id: "playlist-battle",
      type: "playlist",
      name: "Boss Battle",
      parentId: null,
      trackIds: ["track-battle-1", "track-battle-2", "track-battle-3", "track-battle-4"],
    },
  },
  tracksById: {
    "track-rain-1": createPlaceholderTrack("track-rain-1", "Distant Rain"),
    "track-rain-2": createPlaceholderTrack("track-rain-2", "Birdsong"),
    "track-rain-3": createPlaceholderTrack("track-rain-3", "Wind Through Trees"),
    "track-tavern-1": createPlaceholderTrack("track-tavern-1", "Lute Theme"),
    "track-tavern-2": createPlaceholderTrack("track-tavern-2", "Crowd Walla"),
    "track-tavern-3": createPlaceholderTrack("track-tavern-3", "Dice Table"),
    "track-tavern-4": createPlaceholderTrack("track-tavern-4", "Fireplace"),
    "track-tavern-5": createPlaceholderTrack("track-tavern-5", "Bard Chorus"),
    "track-battle-1": createPlaceholderTrack("track-battle-1", "War Drums"),
    "track-battle-2": createPlaceholderTrack("track-battle-2", "Choir Rise"),
    "track-battle-3": createPlaceholderTrack("track-battle-3", "Low Strings"),
    "track-battle-4": createPlaceholderTrack("track-battle-4", "Final Strike"),
  },
};

const LIBRARY_STORAGE_KEY = "odyssey-music:library";
const UI_STORAGE_KEY = "odyssey-music:library-ui";

function createPlaceholderTrack(id: string, title: string) {
  return {
    id,
    title,
    url: "",
    sourceId: id,
    mediaType: "video" as const,
    origin: "youtube" as const,
    volume: 100,
    loop: false,
    startOffsetSec: 0,
    startDelayMs: 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFolderNode(value: unknown): value is FolderNode {
  return isRecord(value)
    && value.type === "folder"
    && typeof value.id === "string"
    && typeof value.name === "string"
    && (typeof value.parentId === "string" || value.parentId === null)
    && Array.isArray(value.childIds)
    && value.childIds.every((entry) => typeof entry === "string");
}

function isPlaylistNode(value: unknown): value is PlaylistNode {
  return isRecord(value)
    && value.type === "playlist"
    && typeof value.id === "string"
    && typeof value.name === "string"
    && (typeof value.parentId === "string" || value.parentId === null)
    && Array.isArray(value.trackIds)
    && value.trackIds.every((entry) => typeof entry === "string");
}

function isTrack(value: unknown): value is Track {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.title === "string"
    && typeof value.url === "string"
    && typeof value.sourceId === "string"
    && (value.mediaType === "video" || value.mediaType === "playlist")
    && (value.origin === "youtube" || value.origin === "youtube-music")
    && typeof value.volume === "number"
    && typeof value.loop === "boolean"
    && typeof value.startOffsetSec === "number"
    && typeof value.startDelayMs === "number";
}

function isLibraryState(value: unknown): value is LibraryState {
  if (!isRecord(value) || !Array.isArray(value.rootIds) || !isRecord(value.nodesById) || !isRecord(value.tracksById)) {
    return false;
  }

  const rootIdsAreStrings = value.rootIds.every((entry) => typeof entry === "string");
  const nodesAreValid = Object.values(value.nodesById).every((entry) => isFolderNode(entry) || isPlaylistNode(entry));
  const tracksAreValid = Object.values(value.tracksById).every((entry) => isTrack(entry));
  return rootIdsAreStrings && nodesAreValid && tracksAreValid;
}

function loadStoredLibraryState() {
  try {
    const rawValue = window.localStorage.getItem(LIBRARY_STORAGE_KEY);
    if (!rawValue) {
      return initialLibraryState;
    }

    const parsedValue: unknown = JSON.parse(rawValue);
    return isLibraryState(parsedValue) ? parsedValue : initialLibraryState;
  } catch {
    return initialLibraryState;
  }
}

function loadStoredUiState() {
  try {
    const rawValue = window.localStorage.getItem(UI_STORAGE_KEY);
    if (!rawValue) {
      return {
        selectedId: findFirstPlaylistId(initialLibraryState),
        expandedIds: new Set<NodeId>(["folder-ambience"]),
      };
    }

    const parsedValue: unknown = JSON.parse(rawValue);
    if (!isRecord(parsedValue)) {
      throw new Error("Invalid UI state.");
    }

    const selectedId = typeof parsedValue.selectedId === "string" ? parsedValue.selectedId : findFirstPlaylistId(initialLibraryState);
    const expandedIds = Array.isArray(parsedValue.expandedIds)
      ? new Set<NodeId>(parsedValue.expandedIds.filter((entry): entry is NodeId => typeof entry === "string"))
      : new Set<NodeId>(["folder-ambience"]);

    return { selectedId, expandedIds };
  } catch {
    return {
      selectedId: findFirstPlaylistId(initialLibraryState),
      expandedIds: new Set<NodeId>(["folder-ambience"]),
    };
  }
}

function createTrackFromDraft(id: string, title: string, url: string): Track {
  return {
    id,
    title: title.trim() || "Untitled track",
    url: url.trim(),
    sourceId: id,
    mediaType: "video",
    origin: "youtube",
    volume: 100,
    loop: false,
    startOffsetSec: 0,
    startDelayMs: 0,
  };
}

function createId(prefix: string) {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function findFirstPlaylistId(library: LibraryState): NodeId | null {
  const visit = (nodeId: NodeId): NodeId | null => {
    const node = library.nodesById[nodeId];
    if (!node) {
      return null;
    }
    if (node.type === "playlist") {
      return node.id;
    }
    for (const childId of node.childIds) {
      const result = visit(childId);
      if (result) {
        return result;
      }
    }
    return null;
  };

  for (const rootId of library.rootIds) {
    const result = visit(rootId);
    if (result) {
      return result;
    }
  }

  return null;
}

export function useLibraryStore() {
  const [library, setLibrary] = useState<LibraryState>(() => loadStoredLibraryState());
  const [selectedId, setSelectedId] = useState<NodeId | null>(() => loadStoredUiState().selectedId);
  const [expandedIds, setExpandedIds] = useState<Set<NodeId>>(() => loadStoredUiState().expandedIds);

  const selectedNode = useMemo(
    () => (selectedId ? library.nodesById[selectedId] ?? null : null),
    [library, selectedId],
  );

  useEffect(() => {
    try {
      window.localStorage.setItem(LIBRARY_STORAGE_KEY, JSON.stringify(library));
    } catch {
      // Ignore storage write failures during local development.
    }
  }, [library]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        UI_STORAGE_KEY,
        JSON.stringify({
          selectedId,
          expandedIds: Array.from(expandedIds),
        }),
      );
    } catch {
      // Ignore storage write failures during local development.
    }
  }, [expandedIds, selectedId]);

  useEffect(() => {
    if (selectedId && library.nodesById[selectedId]) {
      return;
    }

    const fallbackSelectedId = findFirstPlaylistId(library);
    setSelectedId(fallbackSelectedId);
  }, [library, selectedId]);

  function toggleFolder(nodeId: NodeId) {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  }

  function selectNode(nodeId: NodeId) {
    setSelectedId(nodeId);
  }

  function createFolder(parentId: NodeId | null, name: string) {
    const trimmedName = name.trim();
    if (!trimmedName) {
      return;
    }

    const folderId = createId("folder");

    setLibrary((current) => {
      const nextFolder: FolderNode = {
        id: folderId,
        type: "folder",
        name: trimmedName,
        parentId,
        childIds: [],
      };

      const nextState: LibraryState = {
        ...current,
        nodesById: {
          ...current.nodesById,
          [folderId]: nextFolder,
        },
      };

      if (parentId) {
        const parentNode = nextState.nodesById[parentId];
        if (parentNode?.type === "folder") {
          nextState.nodesById[parentId] = {
            ...parentNode,
            childIds: [...parentNode.childIds, folderId],
          };
        } else {
          nextState.rootIds = [...nextState.rootIds, folderId];
          nextFolder.parentId = null;
        }
      } else {
        nextState.rootIds = [...nextState.rootIds, folderId];
      }

      return nextState;
    });

    setExpandedIds((current) => {
      const next = new Set(current);
      if (parentId) {
        next.add(parentId);
      }
      next.add(folderId);
      return next;
    });
    setSelectedId(folderId);
  }

  function createPlaylist(parentId: NodeId | null, name: string) {
    const trimmedName = name.trim();
    if (!trimmedName) {
      return;
    }

    const playlistId = createId("playlist");

    setLibrary((current) => {
      const nextPlaylist: PlaylistNode = {
        id: playlistId,
        type: "playlist",
        name: trimmedName,
        parentId,
        trackIds: [],
      };

      const nextState: LibraryState = {
        ...current,
        nodesById: {
          ...current.nodesById,
          [playlistId]: nextPlaylist,
        },
      };

      if (parentId) {
        const parentNode = nextState.nodesById[parentId];
        if (parentNode?.type === "folder") {
          nextState.nodesById[parentId] = {
            ...parentNode,
            childIds: [...parentNode.childIds, playlistId],
          };
        } else {
          nextState.rootIds = [...nextState.rootIds, playlistId];
          nextPlaylist.parentId = null;
        }
      } else {
        nextState.rootIds = [...nextState.rootIds, playlistId];
      }

      return nextState;
    });

    if (parentId) {
      setExpandedIds((current) => {
        const next = new Set(current);
        next.add(parentId);
        return next;
      });
    }
    setSelectedId(playlistId);
  }

  function getNode(nodeId: NodeId): LibraryNode | null {
    return library.nodesById[nodeId] ?? null;
  }

  function getSelectedFolderId() {
    return selectedNode?.type === "folder" ? selectedNode.id : null;
  }

  function getTrackCount(nodeId: NodeId) {
    const node = getNode(nodeId);
    if (!node || node.type !== "playlist") {
      return 0;
    }
    return node.trackIds.length;
  }

  function getTracksForPlaylist(nodeId: NodeId) {
    const node = getNode(nodeId);
    if (!node || node.type !== "playlist") {
      return [];
    }

    return node.trackIds
      .map((trackId) => library.tracksById[trackId])
      .filter(Boolean);
  }

  function addTrackToPlaylist(playlistId: NodeId, title: string, url: string) {
    const trimmedTitle = title.trim();
    const trimmedUrl = url.trim();
    if (!trimmedTitle && !trimmedUrl) {
      return;
    }

    const trackId = createId("track");

    setLibrary((current) => {
      const playlistNode = current.nodesById[playlistId];
      if (!playlistNode || playlistNode.type !== "playlist") {
        return current;
      }

      return {
        ...current,
        nodesById: {
          ...current.nodesById,
          [playlistId]: {
            ...playlistNode,
            trackIds: [...playlistNode.trackIds, trackId],
          },
        },
        tracksById: {
          ...current.tracksById,
          [trackId]: createTrackFromDraft(trackId, trimmedTitle, trimmedUrl),
        },
      };
    });
  }

  function removeTrackFromPlaylist(playlistId: NodeId, trackId: string) {
    setLibrary((current) => {
      const playlistNode = current.nodesById[playlistId];
      if (!playlistNode || playlistNode.type !== "playlist") {
        return current;
      }

      return {
        ...current,
        nodesById: {
          ...current.nodesById,
          [playlistId]: {
            ...playlistNode,
            trackIds: playlistNode.trackIds.filter((currentTrackId) => currentTrackId !== trackId),
          },
        },
        tracksById: Object.fromEntries(
          Object.entries(current.tracksById).filter(([currentTrackId]) => currentTrackId !== trackId),
        ),
      };
    });
  }

  return {
    library,
    selectedId,
    selectedNode,
    expandedIds,
    toggleFolder,
    selectNode,
    createFolder,
    createPlaylist,
    getNode,
    getSelectedFolderId,
    getTrackCount,
    getTracksForPlaylist,
    addTrackToPlaylist,
    removeTrackFromPlaylist,
  };
}
