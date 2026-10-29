import { describe, expect, it } from "vitest";

import {
  GRAPH_NODE_LIMIT,
  layoutVaultGraph,
  type VaultGraphData,
} from "./vault-graph";

function makeGraph(count: number, links: [number, number][]): VaultGraphData {
  const nodes = Array.from({ length: count }, (_, index) => ({
    id: `n${index}`,
    title: `Note ${index}`,
    pinned: false,
  }));
  const edges = links.map(([from, to]) => ({
    source: `n${from}`,
    target: `n${to}`,
    target_title: `Note ${to}`,
  }));
  return { nodes, edges };
}

describe("layoutVaultGraph", () => {
  it("keeps every node inside the viewport", () => {
    const layout = layoutVaultGraph(makeGraph(40, [[0, 1], [1, 2], [2, 3]]), 320, 200);
    for (const node of layout.nodes) {
      expect(Number.isFinite(node.x)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.x).toBeLessThanOrEqual(320);
      expect(node.y).toBeGreaterThanOrEqual(0);
      expect(node.y).toBeLessThanOrEqual(200);
    }
  });

  it("puts the most connected note in the centre", () => {
    const links: [number, number][] = [
      [0, 1],
      [0, 2],
      [0, 3],
      [1, 2],
    ];
    const layout = layoutVaultGraph(makeGraph(6, links), 400, 300);
    const hub = layout.nodes.find((node) => node.id === "n0");
    expect(hub?.x).toBe(200);
    expect(hub?.y).toBe(150);
    expect(hub?.degree).toBeGreaterThan(1);
  });

  it("is deterministic for the same input", () => {
    const graph = makeGraph(30, [[0, 5], [5, 9], [9, 2], [2, 0]]);
    const first = layoutVaultGraph(graph, 500, 380);
    const second = layoutVaultGraph(structuredClone(graph), 500, 380);
    expect(first.nodes.map((node) => [node.id, node.x, node.y])).toEqual(
      second.nodes.map((node) => [node.id, node.x, node.y])
    );
  });

  it("caps the drawn nodes and reports the rest as hidden", () => {
    const layout = layoutVaultGraph(makeGraph(GRAPH_NODE_LIMIT + 25, [[0, 1]]), 600, 400);
    expect(layout.nodes).toHaveLength(GRAPH_NODE_LIMIT);
    expect(layout.hidden).toBe(25);
  });

  it("drops edges whose target note does not exist yet", () => {
    const graph: VaultGraphData = {
      nodes: [{ id: "a", title: "A", pinned: false }],
      edges: [
        { source: "a", target: null, target_title: "Missing" },
        { source: "a", target: "ghost", target_title: "Ghost" },
      ],
    };
    const layout = layoutVaultGraph(graph, 300, 200);
    expect(layout.edges).toHaveLength(0);
    expect(layout.unresolved).toBe(1);
  });

  it("survives a zero sized container and an empty vault", () => {
    const empty = layoutVaultGraph({ nodes: [], edges: [] }, 0, 0);
    expect(empty.nodes).toHaveLength(0);
    expect(empty.edges).toHaveLength(0);
  });
});
