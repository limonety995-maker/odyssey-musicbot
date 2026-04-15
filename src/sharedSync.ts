import type { LibraryState, NodeId } from "./types";

export type LoadedPlaylist = {
  id: NodeId;
  name: string;
  volume: number;
  isPlaying: boolean;
  isRepeatingTrack: boolean;
  currentTrackIndex: number;
  restartToken: number;
};

export type SharedRoomState = {
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

export const ROOM_SYNC_KEY = "odyssey-music/sync-v1";
export const PLAYER_LOCAL_VOLUME_KEY = "odyssey-music/player-local-volume";

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

export function asSharedRoomState(value: unknown): SharedRoomState | null {
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

export function isLibraryStateLike(value: unknown): value is LibraryState {
  if (!isRecord(value)) {
    return false;
  }

  if (!Array.isArray(value.rootIds) || !isRecord(value.nodesById) || !isRecord(value.tracksById)) {
    return false;
  }

  return value.rootIds.every((id) => typeof id === "string");
}

export function buildSharedSignature(input: {
  library: LibraryState;
  playback: SharedRoomState["playback"];
}) {
  return JSON.stringify({
    library: input.library,
    playback: input.playback,
  });
}
