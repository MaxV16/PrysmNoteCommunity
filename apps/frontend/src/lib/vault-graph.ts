// Deterministic, dependency-free layout for the Vault note graph.
//
// The graph is drawn as concentric rings: the most connected notes sit in the
// middle, their neighbours in the next ring, and everything unlinked collects
// on the outermost ring. That is a single O(n log n) pass (the cost is the sort)
// with no iteration to convergence, so a 2000-note vault still lays out in a
// few milliseconds on the small production VM. The layout is fully
// deterministic: the same notes always land in the same place, which keeps the
// view stable while you work instead of reshuffling on every open.

export interface VaultGraphNode {
  id: string;
  title: string;
  pinned: boolean;
}

export interface VaultGraphEdge {
  source: string;
  target: string | null;
  target_title: string;
}

export interface VaultGraphData {
  nodes: VaultGraphNode[];
  edges: VaultGraphEdge[];
}

export interface PositionedNode extends VaultGraphNode {
  x: number;
  y: number;
  degree: number;
  radius: number;
}

export interface PlacedEdge {
  source: string;
  target: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface GraphLayout {
  nodes: PositionedNode[];
  edges: PlacedEdge[];
  /** Notes the layout had to drop to stay readable. */
  hidden: number;
  /** Friendlier than a degree-0 dot: links whose target note does not exist. */
  unresolved: number;
}

/** Rendering cap: enough to read a real vault, small enough to stay smooth. */
export const GRAPH_NODE_LIMIT = 180;

const RING_GAP = 46;
const CENTRE_PADDING = 44;
const BASE_RADIUS = 3.4;
const MAX_RADIUS = 8;

/** Split the graph into rings: connected cluster first, isolated notes last. */
function rankNodes(nodes: VaultGraphNode[], degree: Map<string, number>) {
  const linked: VaultGraphNode[] = [];
  const isolated: VaultGraphNode[] = [];
  for (const node of nodes) {
    if ((degree.get(node.id) ?? 0) > 0 || node.pinned) linked.push(node);
    else isolated.push(node);
  }
  const byWeight = (a: VaultGraphNode, b: VaultGraphNode) => {
    const diff = (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0);
    if (diff !== 0) return diff;
    return a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
  };
  linked.sort(byWeight);
  isolated.sort(byWeight);
  return { linked, isolated };
}

/**
 * Lay the vault out inside `width` x `height`.
 *
 * Nodes are ordered by how many links they have, then placed ring by ring,
 * starting at the centre. Rings grow outwards until the circle is filled; when
 * the box is too small for another ring the outward radius is reused, so nodes
 * stay inside the viewport rather than spilling off it.
 */
export function layoutVaultGraph(
  graph: VaultGraphData,
  width: number,
  height: number
): GraphLayout {
  const safeWidth = Number.isFinite(width) && width > 0 ? width : 640;
  const safeHeight = Number.isFinite(height) && height > 0 ? height : 420;
  const cx = safeWidth / 2;
  const cy = safeHeight / 2;
  const maxRadius = Math.max(24, Math.min(safeWidth, safeHeight) / 2 - CENTRE_PADDING);

  const degree = new Map<string, number>();
  for (const edge of graph.edges) {
    if (!edge.target) continue;
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }

  const { linked, isolated } = rankNodes(graph.nodes ?? [], degree);
  const ordered = [...linked, ...isolated];
  const kept = ordered.slice(0, GRAPH_NODE_LIMIT);
  const hidden = ordered.length - kept.length;

  const positioned: PositionedNode[] = [];
  const placed = new Map<string, PositionedNode>();
  let ringIndex = 0;
  let capacityLeft = 1;
  let ringStart = 0;
  let radius = 0;

  for (let index = 0; index < kept.length; index += 1) {
    if (capacityLeft === 0) {
      ringIndex += 1;
      ringStart = index;
      capacityLeft = Math.max(6, Math.floor((2 * Math.PI * (RING_GAP * ringIndex)) / 26));
      radius = Math.min(maxRadius, RING_GAP * ringIndex);
    }
    const node = kept[index];
    const withinRing = index - ringStart;
    const nodeDegree = degree.get(node.id) ?? 0;
    const nodeRadius =
      BASE_RADIUS + Math.min(MAX_RADIUS - BASE_RADIUS, Math.log2(nodeDegree + 1) * 1.6);
    let x = cx;
    let y = cy;
    if (ringIndex > 0) {
      const angle = (withinRing / capacityLeft) * Math.PI * 2 - Math.PI / 2;
      x = cx + Math.cos(angle) * radius;
      y = cy + Math.sin(angle) * radius;
    }
    const placedNode: PositionedNode = { ...node, x, y, degree: nodeDegree, radius: nodeRadius };
    positioned.push(placedNode);
    placed.set(node.id, placedNode);
    capacityLeft -= 1;
  }

  const edges: PlacedEdge[] = [];
  let unresolved = 0;
  for (const edge of graph.edges) {
    if (!edge.target) {
      unresolved += 1;
      continue;
    }
    const from = placed.get(edge.source);
    const to = placed.get(edge.target);
    if (!from || !to) continue;
    edges.push({ source: from.id, target: to.id, x1: from.x, y1: from.y, x2: to.x, y2: to.y });
  }

  return { nodes: positioned, edges, hidden, unresolved };
}
