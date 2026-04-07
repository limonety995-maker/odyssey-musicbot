import type { LibraryNode, NodeId } from "../types";

function TreeBranch({
  nodeId,
  depth,
  expandedIds,
  selectedId,
  getNode,
  getTrackCount,
  onToggle,
  onSelect,
}: {
  nodeId: NodeId;
  depth: number;
  expandedIds: Set<NodeId>;
  selectedId: NodeId | null;
  getNode: (nodeId: NodeId) => LibraryNode | null;
  getTrackCount: (nodeId: NodeId) => number;
  onToggle: (nodeId: NodeId) => void;
  onSelect: (nodeId: NodeId) => void;
}) {
  const node = getNode(nodeId);
  if (!node) {
    return null;
  }

  if (node.type === "folder") {
    const expanded = expandedIds.has(node.id);
    return (
      <div className="tree-node">
        <div
          className={`tree-row ${selectedId === node.id ? "is-selected" : ""}`}
          style={{ paddingLeft: `${depth * 14}px` }}
        >
          <button
            className="tree-toggle"
            type="button"
            onClick={() => onToggle(node.id)}
          >
            {expanded ? "-" : "+"}
          </button>
          <button
            className="tree-label"
            type="button"
            onClick={() => onSelect(node.id)}
          >
            {node.name}
          </button>
        </div>
        {expanded ? (
          <div className="tree-children">
            {node.childIds.map((childId) => (
              <TreeBranch
                key={childId}
                nodeId={childId}
                depth={depth + 1}
                expandedIds={expandedIds}
                selectedId={selectedId}
                getNode={getNode}
                getTrackCount={getTrackCount}
                onToggle={onToggle}
                onSelect={onSelect}
              />
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className={`tree-row ${selectedId === node.id ? "is-selected" : ""}`}
      style={{ paddingLeft: `${depth * 14}px` }}
    >
      <span className="tree-toggle tree-toggle-placeholder" />
      <button
        className="tree-label"
        type="button"
        onClick={() => onSelect(node.id)}
      >
        <span>{node.name}</span>
        <span className="tree-meta">{getTrackCount(node.id)} tracks</span>
      </button>
    </div>
  );
}

export function LibraryTree({
  rootIds,
  expandedIds,
  selectedId,
  getNode,
  getTrackCount,
  onToggle,
  onSelect,
}: {
  rootIds: NodeId[];
  expandedIds: Set<NodeId>;
  selectedId: NodeId | null;
  getNode: (nodeId: NodeId) => LibraryNode | null;
  getTrackCount: (nodeId: NodeId) => number;
  onToggle: (nodeId: NodeId) => void;
  onSelect: (nodeId: NodeId) => void;
}) {
  return (
    <div className="tree-shell">
      {rootIds.map((nodeId) => (
        <TreeBranch
          key={nodeId}
          nodeId={nodeId}
          depth={0}
          expandedIds={expandedIds}
          selectedId={selectedId}
          getNode={getNode}
          getTrackCount={getTrackCount}
          onToggle={onToggle}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}
