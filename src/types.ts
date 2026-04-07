export type NodeId = string;
export type TrackId = string;

export type FolderNode = {
  id: NodeId;
  type: "folder";
  name: string;
  parentId: NodeId | null;
  childIds: NodeId[];
};

export type PlaylistNode = {
  id: NodeId;
  type: "playlist";
  name: string;
  parentId: NodeId | null;
  trackIds: TrackId[];
};

export type LibraryNode = FolderNode | PlaylistNode;

export type Track = {
  id: TrackId;
  title: string;
  url: string;
  sourceId: string;
  mediaType: "video" | "playlist";
  origin: "youtube" | "youtube-music";
  volume: number;
  loop: boolean;
  startOffsetSec: number;
  startDelayMs: number;
};

export type LibraryState = {
  rootIds: NodeId[];
  nodesById: Record<NodeId, LibraryNode>;
  tracksById: Record<TrackId, Track>;
};
