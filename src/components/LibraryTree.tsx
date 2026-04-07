import type { LibraryNode, NodeId, PlaylistNode } from "../types";

type TreeBranchProps = {
  nodeId: NodeId;
  getNode: (nodeId: NodeId) => LibraryNode | null;
  isActive: boolean;
  onNavigate: (nodeId: NodeId) => void;
  onLoadPlaylist: (playlist: PlaylistNode) => void;
};

export function TreeBranch({
  nodeId,
  getNode,
  isActive,
  onNavigate,
  onLoadPlaylist,
}: TreeBranchProps) {
  const node = getNode(nodeId);
  if (!node) return null;

  if (node.type === "playlist") {
    return (
      <li className="list-item">
        <div className={`folder playlist-card ${isActive ? "is-active" : ""}`}>
          <button
            className="icon-button playlist-main-button"
            type="button"
            onClick={() => onLoadPlaylist(node)}
          >
            <svg
              width="72"
              height="72"
              className="icon node-icon playlist-icon-default"
              style={{ fill: node.iconColor }}
            >
              <use xlinkHref={`#icon-folder`} />
            </svg>
            <svg
              width="72"
              height="72"
              className="icon node-icon playlist-icon-hover"
              style={{ fill: node.iconColor }}
            >
              <use xlinkHref={`#icon-playfolder`} />
            </svg>
            {node.name}
          </button>
          <button
            className="icon-button playlist-edit-button"
            type="button"
            onClick={() => onNavigate(node.id)}
            aria-label={`Edit playlist ${node.name}`}
          >
            <svg width="18" height="18" className="icon">
              <use xlinkHref={`#icon-edit`} />
            </svg>
          </button>
        </div>
      </li>
    );
  }

  return (
    <li className="list-item">
      <button
        className={`icon-button folder ${isActive ? "is-active" : ""}`}
        type="button"
        onClick={() => onNavigate(node.id)}
      >
        <svg
          width="72"
          height="72"
          className="icon node-icon"
          style={{ fill: node.iconColor }}
        >
          <use xlinkHref={`#icon-folder`} />
        </svg>
        {node.name}
      </button>
    </li>
  );
}

