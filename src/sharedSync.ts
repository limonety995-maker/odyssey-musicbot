import type { NodeId, TrackId } from "./types";

export type LoadedPlaylist = {
  id: NodeId;
  name: string;
  volume: number;
  isPlaying: boolean;
  isRepeatingTrack: boolean;
  currentTrackIndex: number;
  restartToken: number;
};

export type SharedTrack = {
  id: TrackId;
  title: string;
  url: string;
};

export type SharedLoadedPlaylist = LoadedPlaylist & {
  tracks: SharedTrack[];
};

export type SharedRoomState = {
  version: 2;
  playback: {
    loadedPlaylists: SharedLoadedPlaylist[];
    masterVolume: number;
    isMuted: boolean;
  };
  updatedAt: number;
  updatedBy: string;
};

export const ROOM_SYNC_KEY = "odyssey-music/sync-v2";
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

function isSharedTrack(value: unknown): value is SharedTrack {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.title === "string"
    && typeof value.url === "string";
}

function isSharedLoadedPlaylist(value: unknown): value is SharedLoadedPlaylist {
  return isLoadedPlaylist(value)
    && Array.isArray(value.tracks)
    && value.tracks.every(isSharedTrack);
}

export function asSharedRoomState(value: unknown): SharedRoomState | null {
  if (!isRecord(value) || value.version !== 2) {
    return null;
  }

  const playback = value.playback;
  if (!isRecord(playback)) {
    return null;
  }

  if (
    !Array.isArray(playback.loadedPlaylists)
    || !playback.loadedPlaylists.every(isSharedLoadedPlaylist)
    || typeof playback.masterVolume !== "number"
    || typeof playback.isMuted !== "boolean"
    || typeof value.updatedAt !== "number"
    || typeof value.updatedBy !== "string"
  ) {
    return null;
  }

  return value as SharedRoomState;
}

export function buildSharedSignature(playback: SharedRoomState["playback"]) {
  return JSON.stringify(playback);
}
