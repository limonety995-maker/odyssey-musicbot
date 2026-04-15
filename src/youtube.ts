export type YTPlayer = {
  cueVideoById: (videoId: string) => void;
  loadVideoById: (videoId: string) => void;
  destroy: () => void;
  mute: () => void;
  unMute: () => void;
  setVolume: (volume: number) => void;
  playVideo: () => void;
  pauseVideo: () => void;
};

export type YTApi = {
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

declare global {
  interface Window {
    YT?: YTApi;
    onYouTubeIframeAPIReady?: () => void;
  }
}

export function extractVideoId(url: string) {
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

export function ensureYouTubeApi() {
  if (window.YT?.Player) {
    return Promise.resolve(window.YT);
  }

  return new Promise<YTApi | undefined>((resolve) => {
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
