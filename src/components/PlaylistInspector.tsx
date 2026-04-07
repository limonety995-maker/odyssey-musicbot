import { useState } from "react";
import type { PlaylistNode, Track } from "../types";

export function PlaylistInspector({
  selectedPlaylist,
  trackCount,
  tracks,
  onAddTrack,
  onRemoveTrack,
}: {
  selectedPlaylist: PlaylistNode | null;
  trackCount: number;
  tracks: Track[];
  onAddTrack: (title: string, url: string) => void;
  onRemoveTrack: (trackId: string) => void;
}) {
  const [trackTitleDraft, setTrackTitleDraft] = useState("");
  const [trackUrlDraft, setTrackUrlDraft] = useState("");

  if (!selectedPlaylist) {
    return (
      <div className="empty-state">
        <p className="muted">Pick a playlist in the tree to continue.</p>
      </div>
    );
  }

  return (
    <div className="inspector-card">
      <h3>{selectedPlaylist.name}</h3>
      <p className="muted">{trackCount} tracks in this playlist.</p>
      <div className="inspector-form">
        <label className="field-label" htmlFor="track-title">
          Track title
        </label>
        <input
          id="track-title"
          className="text-input"
          type="text"
          value={trackTitleDraft}
          onChange={(event) => setTrackTitleDraft(event.target.value)}
          placeholder="Rain loop, Tavern music, Boss intro..."
        />
        <label className="field-label" htmlFor="track-url">
          Track URL
        </label>
        <input
          id="track-url"
          className="text-input"
          type="url"
          value={trackUrlDraft}
          onChange={(event) => setTrackUrlDraft(event.target.value)}
          placeholder="https://youtube.com/watch?v=..."
        />
      </div>
      <div className="button-row">
        <button className="action-button" type="button">
          Load Playlist
        </button>
        <button
          className="ghost-button"
          type="button"
          onClick={() => {
            onAddTrack(trackTitleDraft, trackUrlDraft);
            setTrackTitleDraft("");
            setTrackUrlDraft("");
          }}
        >
          Add Track
        </button>
      </div>
      <div className="track-list">
        {tracks.map((track) => (
          <article key={track.id} className="track-list-item">
            <div>
              <h4>{track.title}</h4>
              <p className="muted">{track.url || "No URL yet"}</p>
            </div>
            <div className="track-actions">
              <span className="tree-meta">{track.volume}%</span>
              <button
                className="ghost-button danger-button-subtle"
                type="button"
                onClick={() => onRemoveTrack(track.id)}
              >
                Remove
              </button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
