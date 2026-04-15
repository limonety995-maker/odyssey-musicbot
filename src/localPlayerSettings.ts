export const LOCAL_VOLUME_STORAGE_KEY = "odyssey-music:local-volume";
const LOCAL_SETTINGS_CHANNEL = "odyssey-music:local-settings";

function clampVolume(value: number) {
  if (!Number.isFinite(value)) {
    return 100;
  }

  return Math.min(Math.max(Math.round(value), 0), 100);
}

export function readLocalVolume() {
  try {
    const storedValue = window.localStorage.getItem(LOCAL_VOLUME_STORAGE_KEY);
    return storedValue === null ? 100 : clampVolume(Number(storedValue));
  } catch {
    return 100;
  }
}

export function writeLocalVolume(volume: number) {
  const nextVolume = clampVolume(volume);
  try {
    window.localStorage.setItem(LOCAL_VOLUME_STORAGE_KEY, String(nextVolume));
  } catch {
    // Local volume is optional; playback can continue without persisted storage.
  }

  try {
    const channel = new BroadcastChannel(LOCAL_SETTINGS_CHANNEL);
    channel.postMessage({ type: "local-volume", volume: nextVolume });
    channel.close();
  } catch {
    // BroadcastChannel is optional; storage still keeps the latest value.
  }

  return nextVolume;
}

export function onLocalVolumeChange(callback: (volume: number) => void) {
  const handleStorage = (event: StorageEvent) => {
    if (event.key === LOCAL_VOLUME_STORAGE_KEY) {
      callback(readLocalVolume());
    }
  };

  window.addEventListener("storage", handleStorage);

  let channel: BroadcastChannel | null = null;
  try {
    channel = new BroadcastChannel(LOCAL_SETTINGS_CHANNEL);
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const data = event.data;
      if (
        typeof data === "object"
        && data !== null
        && "type" in data
        && data.type === "local-volume"
        && "volume" in data
        && typeof data.volume === "number"
      ) {
        callback(clampVolume(data.volume));
      }
    };
  } catch {
    channel = null;
  }

  return () => {
    window.removeEventListener("storage", handleStorage);
    channel?.close();
  };
}
