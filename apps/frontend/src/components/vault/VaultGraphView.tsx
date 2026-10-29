"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { Modal } from "@/components/ui/Modal";
import { api } from "@/lib/api";
import {
  layoutVaultGraph,
  type GraphLayout,
  type VaultGraphData,
} from "@/lib/vault-graph";

// The layout works in a fixed coordinate space and the SVG scales it, so the
// graph stays put across resizes and never needs a measuring pass or a
// ResizeObserver.
const VIEW_WIDTH = 640;
const VIEW_HEIGHT = 420;

interface VaultGraphViewProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectNote: (noteId: string) => void;
}

export function VaultGraphView({ isOpen, onClose, onSelectNote }: VaultGraphViewProps) {
  const [graph, setGraph] = useState<VaultGraphData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .get<VaultGraphData>("/vault/graph")
      .then((data) => {
        if (cancelled) return;
        setGraph({ nodes: data.nodes ?? [], edges: data.edges ?? [] });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setGraph(null);
        setError(cause instanceof Error ? cause.message : "Could not load the graph");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  const layout: GraphLayout = useMemo(
    () =>
      layoutVaultGraph(graph ?? { nodes: [], edges: [] }, VIEW_WIDTH, VIEW_HEIGHT),
    [graph]
  );

  const openNote = useCallback(
    (noteId: string) => {
      onClose();
      onSelectNote(noteId);
    },
    [onClose, onSelectNote]
  );

  const highlighted = hoverId;
  const neighbours = useMemo(() => {
    if (!highlighted) return null;
    const ids = new Set<string>([highlighted]);
    for (const edge of graph?.edges ?? []) {
      if (!edge.target) continue;
      if (edge.source === highlighted) ids.add(edge.target);
      if (edge.target === highlighted) ids.add(edge.source);
    }
    return ids;
  }, [graph, highlighted]);

  const empty = !loading && !error && layout.nodes.length === 0;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Note graph">
      <div className="space-y-3">
        <p className="text-xs text-secondary">
          Every note is a dot and every double-bracket link is a line. Bigger dots have more
          links. Click a note to open it.
        </p>

        {loading && <p className="text-xs text-muted">Loading the graph...</p>}
        {error && <p className="text-xs text-danger">{error}</p>}
        {empty && (
          <p className="text-xs text-secondary">
            No notes yet. Create two notes and link them with [[double brackets]] to see the
            graph.
          </p>
        )}

        {!loading && !error && layout.nodes.length > 0 && (
          <svg
            viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
            className="h-auto w-full rounded-xl border border-border bg-elevated"
            role="img"
            aria-label="Note graph"
            data-testid="vault-graph"
          >
            <g stroke="var(--border)" strokeWidth={1}>
              {layout.edges.map((edge, index) => {
                const active =
                  !highlighted ||
                  (neighbours?.has(edge.source) === true &&
                    neighbours?.has(edge.target) === true);
                return (
                  <line
                    key={`${edge.source}-${edge.target}-${index}`}
                    x1={edge.x1}
                    y1={edge.y1}
                    x2={edge.x2}
                    y2={edge.y2}
                    stroke={active && highlighted ? "var(--accent)" : "var(--border)"}
                    strokeOpacity={highlighted ? (active ? 0.55 : 0.15) : 0.35}
                  />
                );
              })}
            </g>
            <g>
              {layout.nodes.map((node) => {
                const dim = neighbours ? !neighbours.has(node.id) : false;
                return (
                  <g
                    key={node.id}
                    onMouseEnter={() => setHoverId(node.id)}
                    onMouseLeave={() => setHoverId(null)}
                    onClick={() => openNote(node.id)}
                    className="cursor-pointer"
                    opacity={dim ? 0.28 : 1}
                  >
                    <title>{node.title}</title>
                    <circle
                      cx={node.x}
                      cy={node.y}
                      r={node.radius}
                      fill={node.pinned ? "var(--accent)" : "var(--surface)"}
                      stroke="var(--accent)"
                      strokeWidth={node.pinned ? 1 : 1.4}
                    />
                    {hoverId === node.id && (
                      <text
                        x={node.x}
                        y={node.y - node.radius - 6}
                        textAnchor="middle"
                        className="pointer-events-none"
                        fill="var(--text-primary)"
                        fontSize={11}
                      >
                        {node.title}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          </svg>
        )}

        {!loading && !error && layout.nodes.length > 0 && (
          <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted">
            <span className="tnum">
              {layout.nodes.length} {layout.nodes.length === 1 ? "note" : "notes"}
            </span>
            <span className="tnum">
              {layout.edges.length} {layout.edges.length === 1 ? "link" : "links"}
            </span>
            {layout.unresolved > 0 && (
              <span className="tnum">{layout.unresolved} links to notes not created yet</span>
            )}
            {layout.hidden > 0 && (
              <span className="tnum">
                {layout.hidden} more notes not drawn, search to reach them
              </span>
            )}
          </div>
        )}

        <div className="flex justify-end">
          <button
            onClick={onClose}
            className="btn bg-elevated border border-border px-3 py-1.5 text-xs"
          >
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}
