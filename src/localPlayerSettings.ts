export const LOCAL_VOLUME_STORAGE_KEY = "odyssey-music:local-volume";

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
    // Local player volume is optional; playback can continue without storage.
  }

  return nextVolume;
}
