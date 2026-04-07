import { useEffect, useMemo, useRef } from "react";
import type { Track } from "../types";

type LoadedPlaylistPlayer = {
  playlistId: string;
  name: string;
  volume: number;
  isPlaying: boolean;
  isRepeatingTrack: boolean;
  currentTrackIndex: number;
  restartToken: number;
  tracks: Track[];
};

type YTPlayer = {
  cueVideoById: (videoId: string) => void;
  loadVideoById: (videoId: string) => void;
  destroy: () => void;
  mute: () => void;
  unMute: () => void;
  setVolume: (volume: number) => void;
  playVideo: () => void;
  pauseVideo: () => void;
};

declare global {
  interface Window {
    YT?: {
      Player: new (
        elementId: string | HTMLElement,
        options: {
          videoId: string;
          playerVars?: Record<string, number>;
          events?: {
            onReady?: (event: { target: YTPlayer }) => void;
            onStateChange?: (event: { data: number }) => void;
            onError?: (event: { data: number }) => void;
          };
        },
      ) => YTPlayer;
      PlayerState: {
        ENDED: number;
      };
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

function extractVideoId(url: string) {
  const trimmedUrl = url.trim();
  if (!trimmedUrl) {
    return null;
  }

  try {
    const parsedUrl = new URL(trimmedUrl);
    const host = parsedUrl.hostname.replace(/^www\./, "");
    const hashParams = new URLSearchParams(parsedUrl.hash.replace(/^#/, ""));
    const videoId = parsedUrl.searchParams.get("v") ?? hashParams.get("v");

    if (host === "youtu.be") {
      return parsedUrl.pathname.replace("/", "") || null;
    }

    if (
      host === "youtube.com"
      || host === "m.youtube.com"
      || host === "music.youtube.com"
    ) {
      if (parsedUrl.pathname === "/watch" && videoId) {
        return videoId;
      }

      if (parsedUrl.pathname.startsWith("/shorts/")) {
        return parsedUrl.pathname.replace("/shorts/", "") || null;
      }

      if (parsedUrl.pathname.startsWith("/embed/")) {
        return parsedUrl.pathname.replace("/embed/", "") || null;
      }
    }
  } catch {
    return null;
  }

  return null;
}

function getYouTubeErrorMessage(errorCode: number) {
  switch (errorCode) {
    case 2:
      return "This link looks invalid. Please check the YouTube URL.";
    case 5:
      return "This YouTube track could not be loaded in the player.";
    case 100:
      return "This track is unavailable or has been removed from YouTube.";
    case 101:
    case 150:
      return "This track cannot be played here because YouTube blocks embedding for it.";
    default:
      return "This track could not be validated for playback.";
  }
}

function getPlayableTrack(track: Track | undefined) {
  if (!track) {
    return null;
  }

  const videoId = extractVideoId(track.url);
  if (!videoId) {
    return null;
  }

  return { track, videoId };
}

export function createEmbedSource(url: string, isLooping: boolean) {
  const videoId = extractVideoId(url);
  if (!videoId) {
    return null;
  }

  return `https://www.youtube.com/embed/${encodeURIComponent(videoId)}?playsinline=1${isLooping ? `&loop=1&playlist=${encodeURIComponent(videoId)}` : ""}`;
}

function ensureYouTubeApi() {
  if (window.YT?.Player) {
    return Promise.resolve(window.YT);
  }

  return new Promise<typeof window.YT>((resolve) => {
    const existingScript = document.querySelector(
      'script[data-youtube-iframe-api="true"]',
    );

    if (!existingScript) {
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.async = true;
      script.dataset.youtubeIframeApi = "true";
      document.body.appendChild(script);
    }

    const previousHandler = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previousHandler?.();
      resolve(window.YT);
    };
  });
}

export async function validatePlayableSource(url: string) {
  const videoId = extractVideoId(url);
  if (!videoId) {
    return {
      ok: false,
      message:
        "This link cannot be embedded. Please use a standard YouTube, YouTube Music, or youtu.be link.",
    };
  }

  const YT = await ensureYouTubeApi();
  if (!YT?.Player) {
    return {
      ok: false,
      message: "The YouTube player could not be loaded for validation.",
    };
  }

  return new Promise<{ ok: boolean; message?: string }>((resolve) => {
    const mountNode = document.createElement("div");
    mountNode.className = "player-validation-hidden";
    mountNode.id = `yt-validation-${videoId}-${Math.random().toString(36).slice(2)}`;
    document.body.appendChild(mountNode);

    let settled = false;
    let player: YTPlayer | undefined;
    let readyTimer = 0;
    const verificationTimer = window.setTimeout(() => {
      cleanup();
      resolve({
        ok: false,
        message: "This track could not be verified. Please try again in a moment.",
      });
    }, 5000);

    const cleanup = () => {
      if (settled) {
        return;
      }

      settled = true;
      window.clearTimeout(readyTimer);
      window.clearTimeout(verificationTimer);
      player?.destroy();
      mountNode.remove();
    };

    player = new YT.Player(mountNode.id, {
      videoId,
      playerVars: {
        autoplay: 0,
        controls: 0,
        playsinline: 1,
      },
      events: {
        onReady: ({ target }) => {
          target.cueVideoById(videoId);
          readyTimer = window.setTimeout(() => {
            cleanup();
            resolve({ ok: true });
          }, 1200);
        },
        onError: ({ data }) => {
          const message = getYouTubeErrorMessage(data);
          cleanup();
          resolve({ ok: false, message });
        },
      },
    });
  });
}

export function EmbeddedPlayer({
  playlists,
  masterVolume,
  isMuted,
  onPlaylistEnded,
}: {
  playlists: LoadedPlaylistPlayer[];
  masterVolume: number;
  isMuted: boolean;
  onPlaylistEnded: (playlistId: string) => void;
}) {
  const playersRef = useRef<Record<string, YTPlayer>>({});
  const currentVideoIdsRef = useRef<Record<string, string>>({});
  const restartTokensRef = useRef<Record<string, number>>({});

  const playableEntries = useMemo(
    () =>
      playlists
        .map((playlist) => {
          const playableTrack = getPlayableTrack(
            playlist.tracks[playlist.currentTrackIndex],
          );

          if (!playableTrack) {
            return null;
          }

          return {
            playlistId: playlist.playlistId,
            videoId: playableTrack.videoId,
            isPlaying: playlist.isPlaying,
            volume: Math.round((playlist.volume * masterVolume) / 100),
            restartToken: playlist.restartToken,
          };
        })
        .filter(
          (
            entry,
          ): entry is {
            playlistId: string;
            videoId: string;
            isPlaying: boolean;
            volume: number;
            restartToken: number;
          } => entry !== null,
        ),
    [masterVolume, playlists],
  );

  useEffect(() => {
    let cancelled = false;

    ensureYouTubeApi().then((YT) => {
      if (cancelled || !YT?.Player) {
        return;
      }

      const activePlaylistIds = new Set(playableEntries.map((entry) => entry.playlistId));

      for (const [playlistId, player] of Object.entries(playersRef.current)) {
        if (!activePlaylistIds.has(playlistId)) {
          player.destroy();
          const mountWrapper = document.getElementById(`yt-player-${playlistId}`);
          if (mountWrapper) {
            mountWrapper.innerHTML = "";
          }
          delete playersRef.current[playlistId];
          delete currentVideoIdsRef.current[playlistId];
          delete restartTokensRef.current[playlistId];
        }
      }

      for (const entry of playableEntries) {
        const elementId = `yt-player-${entry.playlistId}`;
        const existingPlayer = playersRef.current[entry.playlistId];

        if (!existingPlayer) {
          const mountWrapper = document.getElementById(elementId);
          if (!mountWrapper) {
            continue;
          }

          let mountHost = mountWrapper.querySelector<HTMLDivElement>(".yt-player-host");
          if (!mountHost) {
            mountHost = document.createElement("div");
            mountHost.className = "yt-player-host";
            mountWrapper.appendChild(mountHost);
          }

          playersRef.current[entry.playlistId] = new YT.Player(mountHost, {
            videoId: entry.videoId,
            playerVars: {
              autoplay: 0,
              controls: 0,
              playsinline: 1,
            },
            events: {
              onReady: ({ target }) => {
                currentVideoIdsRef.current[entry.playlistId] = entry.videoId;
                restartTokensRef.current[entry.playlistId] = entry.restartToken;

                if (isMuted) {
                  target.mute();
                } else {
                  target.unMute();
                  target.setVolume(entry.volume);
                }

                if (entry.isPlaying) {
                  target.playVideo();
                } else {
                  target.pauseVideo();
                }
              },
              onStateChange: ({ data }) => {
                if (data === YT.PlayerState.ENDED) {
                  onPlaylistEnded(entry.playlistId);
                }
              },
            },
          });
          continue;
        }

        if (currentVideoIdsRef.current[entry.playlistId] !== entry.videoId) {
          if (entry.isPlaying) {
            existingPlayer.loadVideoById(entry.videoId);
          } else {
            existingPlayer.cueVideoById(entry.videoId);
          }

          currentVideoIdsRef.current[entry.playlistId] = entry.videoId;
          restartTokensRef.current[entry.playlistId] = entry.restartToken;
        } else if (restartTokensRef.current[entry.playlistId] !== entry.restartToken) {
          if (entry.isPlaying) {
            existingPlayer.loadVideoById(entry.videoId);
          } else {
            existingPlayer.cueVideoById(entry.videoId);
          }

          restartTokensRef.current[entry.playlistId] = entry.restartToken;
        }

        if (isMuted) {
          existingPlayer.mute();
        } else {
          existingPlayer.unMute();
          existingPlayer.setVolume(entry.volume);
        }

        if (entry.isPlaying) {
          existingPlayer.playVideo();
        } else {
          existingPlayer.pauseVideo();
        }
      }
    });

    return () => {
      cancelled = true;
    };
  }, [isMuted, onPlaylistEnded, playableEntries]);

  useEffect(() => () => {
    for (const player of Object.values(playersRef.current)) {
      player.destroy();
    }
    playersRef.current = {};
    currentVideoIdsRef.current = {};
    restartTokensRef.current = {};
  }, []);

  return (
    <div className="player-rack" aria-hidden="true">
      {playlists.map((playlist) => (
        <div
          key={playlist.playlistId}
          id={`yt-player-${playlist.playlistId}`}
          className="player-iframe-hidden"
        />
      ))}
    </div>
  );
}
