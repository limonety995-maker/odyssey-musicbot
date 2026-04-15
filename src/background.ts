import OBR from "@owlbear-rodeo/sdk";
import {
  PLAYER_LOCAL_VOLUME_KEY,
  ROOM_SYNC_KEY,
  asSharedRoomState,
  buildSharedSignature,
  isLibraryStateLike,
  type SharedRoomState,
} from "./sharedSync";
import { ensureYouTubeApi, extractVideoId, type YTApi, type YTPlayer } from "./youtube";

const statusElement = document.getElementById("background-status");
const GM_POPOVER_WIDTH = 585;
const GM_POPOVER_HEIGHT = 400;
const PLAYER_POPOVER_WIDTH = 585;
const PLAYER_POPOVER_HEIGHT = 48;

type PlayableEntry = {
  playlistId: string;
  videoId: string;
  isPlaying: boolean;
  volume: number;
  restartToken: number;
};

const playersByPlaylistId: Record<string, YTPlayer> = {};
const currentVideoIdsByPlaylistId: Record<string, string> = {};
const restartTokensByPlaylistId: Record<string, number> = {};
let latestSharedState: SharedRoomState | null = null;
let latestSignature = "";
let latestPlayableSignature = "";
let currentRole = "PLAYER";
let playerId = "background";

function setStatus(message: string) {
  if (statusElement) {
    statusElement.textContent = message;
  }
}

function getPlayerHost() {
  let host = document.getElementById("youtube-player-host");
  if (!host) {
    host = document.createElement("div");
    host.id = "youtube-player-host";
    host.setAttribute("aria-hidden", "true");
    document.body.appendChild(host);
  }

  return host;
}

function getPlayableEntries(sharedState: SharedRoomState): PlayableEntry[] {
  return sharedState.playback.loadedPlaylists
    .map((playlist) => {
      const node = sharedState.library.nodesById[playlist.id];
      if (node?.type !== "playlist") {
        return null;
      }

      const trackId = node.trackIds[
        Math.min(playlist.currentTrackIndex, Math.max(node.trackIds.length - 1, 0))
      ];
      const track = trackId ? sharedState.library.tracksById[trackId] : null;
      const videoId = track ? extractVideoId(track.url) : null;
      if (!videoId) {
        return null;
      }

      return {
        playlistId: playlist.id,
        videoId,
        isPlaying: playlist.isPlaying,
        volume: sharedState.playback.isMuted
          ? 0
          : Math.round((playlist.volume * sharedState.playback.masterVolume) / 100),
        restartToken: playlist.restartToken,
      };
    })
    .filter((entry): entry is PlayableEntry => entry !== null);
}

function buildPlayableSignature(entries: PlayableEntry[]) {
  return JSON.stringify(entries);
}

function getMountNode(playlistId: string) {
  const host = getPlayerHost();
  const elementId = `background-yt-player-${playlistId}`;
  let mountNode = document.getElementById(elementId);
  if (!mountNode) {
    mountNode = document.createElement("div");
    mountNode.id = elementId;
    host.appendChild(mountNode);
  }

  return mountNode;
}

function clampVolume(value: number) {
  return Math.min(100, Math.max(0, Math.round(value)));
}

function getPlayerLocalVolume() {
  if (currentRole === "GM") {
    return 100;
  }

  const storedVolume = window.localStorage.getItem(PLAYER_LOCAL_VOLUME_KEY);
  if (storedVolume === null) {
    return 100;
  }

  const parsedVolume = Number(storedVolume);
  return Number.isFinite(parsedVolume) ? clampVolume(parsedVolume) : 100;
}

function destroyStalePlayers(activeEntries: PlayableEntry[]) {
  const activePlaylistIds = new Set(activeEntries.map((entry) => entry.playlistId));

  for (const [playlistId, player] of Object.entries(playersByPlaylistId)) {
    if (activePlaylistIds.has(playlistId)) {
      continue;
    }

    player.destroy();
    document.getElementById(`background-yt-player-${playlistId}`)?.remove();
    delete playersByPlaylistId[playlistId];
    delete currentVideoIdsByPlaylistId[playlistId];
    delete restartTokensByPlaylistId[playlistId];
  }
}

function syncPlayerPlayback(player: YTPlayer, entry: PlayableEntry) {
  const effectiveVolume = Math.round((entry.volume * getPlayerLocalVolume()) / 100);

  if (effectiveVolume <= 0) {
    player.mute();
  } else {
    player.unMute();
    player.setVolume(effectiveVolume);
  }

  if (entry.isPlaying) {
    player.playVideo();
  } else {
    player.pauseVideo();
  }
}

function applyEntriesToPlayers(YT: YTApi, entries: PlayableEntry[]) {
  destroyStalePlayers(entries);

  for (const entry of entries) {
    const existingPlayer = playersByPlaylistId[entry.playlistId];
    if (!existingPlayer) {
      const mountNode = getMountNode(entry.playlistId);
      playersByPlaylistId[entry.playlistId] = new YT.Player(mountNode, {
        videoId: entry.videoId,
        playerVars: {
          autoplay: 0,
          controls: 0,
          playsinline: 1,
        },
        events: {
          onReady: ({ target }) => {
            currentVideoIdsByPlaylistId[entry.playlistId] = entry.videoId;
            restartTokensByPlaylistId[entry.playlistId] = entry.restartToken;
            syncPlayerPlayback(target, entry);
          },
          onStateChange: ({ data }) => {
            if (data === YT.PlayerState.ENDED) {
              void advancePlaylistTrack(entry.playlistId);
            }
          },
        },
      });
      continue;
    }

    if (currentVideoIdsByPlaylistId[entry.playlistId] !== entry.videoId) {
      if (entry.isPlaying) {
        existingPlayer.loadVideoById(entry.videoId);
      } else {
        existingPlayer.cueVideoById(entry.videoId);
      }

      currentVideoIdsByPlaylistId[entry.playlistId] = entry.videoId;
      restartTokensByPlaylistId[entry.playlistId] = entry.restartToken;
    } else if (restartTokensByPlaylistId[entry.playlistId] !== entry.restartToken) {
      if (entry.isPlaying) {
        existingPlayer.loadVideoById(entry.videoId);
      } else {
        existingPlayer.cueVideoById(entry.videoId);
      }

      restartTokensByPlaylistId[entry.playlistId] = entry.restartToken;
    }

    syncPlayerPlayback(existingPlayer, entry);
  }
}

function applySharedState(sharedState: SharedRoomState) {
  if (!isLibraryStateLike(sharedState.library)) {
    return;
  }

  const signature = buildSharedSignature({
    library: sharedState.library,
    playback: sharedState.playback,
  });
  if (signature === latestSignature) {
    return;
  }

  latestSharedState = sharedState;
  latestSignature = signature;
  const entries = getPlayableEntries(sharedState);
  const playableSignature = buildPlayableSignature(entries);
  if (playableSignature === latestPlayableSignature) {
    return;
  }

  latestPlayableSignature = playableSignature;
  void ensureYouTubeApi().then((YT) => {
    if (!YT?.Player) {
      setStatus("YouTube audio engine unavailable.");
      return;
    }

    applyEntriesToPlayers(YT, entries);
    setStatus(`Background audio ready (${currentRole})`);
  });
}

function reapplyLatestPlayback() {
  if (!latestSharedState) {
    return;
  }

  const entries = getPlayableEntries(latestSharedState);
  latestPlayableSignature = buildPlayableSignature(entries);
  void ensureYouTubeApi().then((YT) => {
    if (YT?.Player) {
      applyEntriesToPlayers(YT, entries);
    }
  });
}

async function advancePlaylistTrack(playlistIdToAdvance: string) {
  if (currentRole !== "GM" || !latestSharedState) {
    return;
  }

  const nextLoadedPlaylists = latestSharedState.playback.loadedPlaylists.map((playlist) => {
    if (playlist.id !== playlistIdToAdvance) {
      return playlist;
    }

    const playlistNode = latestSharedState?.library.nodesById[playlist.id];
    if (playlistNode?.type !== "playlist") {
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
    return {
      ...playlist,
      currentTrackIndex: playlist.currentTrackIndex < lastTrackIndex
        ? playlist.currentTrackIndex + 1
        : 0,
      isPlaying: true,
      restartToken: 0,
    };
  });

  const nextSharedState: SharedRoomState = {
    ...latestSharedState,
    playback: {
      ...latestSharedState.playback,
      loadedPlaylists: nextLoadedPlaylists,
    },
    updatedAt: Date.now(),
    updatedBy: playerId,
  };

  await OBR.room.setMetadata({ [ROOM_SYNC_KEY]: nextSharedState });
  applySharedState(nextSharedState);
}

OBR.onReady(() => {
  const applyActionSize = async () => {
    const role = await OBR.player.getRole();
    currentRole = role;
    const isGm = role === "GM";
    const width = isGm ? GM_POPOVER_WIDTH : PLAYER_POPOVER_WIDTH;
    const height = isGm ? GM_POPOVER_HEIGHT : PLAYER_POPOVER_HEIGHT;
    await OBR.action.setWidth(width);
    await OBR.action.setHeight(height);
    setStatus(`Background audio ready (${role})`);
  };

  void (async () => {
    playerId = OBR.player.id;
    await applyActionSize();

    const initialMetadata = await OBR.room.getMetadata();
    const initialSharedState = asSharedRoomState(initialMetadata[ROOM_SYNC_KEY]);
    if (initialSharedState) {
      applySharedState(initialSharedState);
    }

    OBR.room.onMetadataChange((metadata) => {
      const nextSharedState = asSharedRoomState(metadata[ROOM_SYNC_KEY]);
      if (nextSharedState) {
        applySharedState(nextSharedState);
      }
    });
  })();

  OBR.action.onOpenChange((isOpen) => {
    if (isOpen) {
      void applyActionSize();
    }
  });
  OBR.player.onChange(() => {
    void applyActionSize();
  });

  window.addEventListener("storage", (event) => {
    if (event.key === PLAYER_LOCAL_VOLUME_KEY && latestSharedState) {
      reapplyLatestPlayback();
    }
  });
});
