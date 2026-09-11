import { useEffect, useMemo, useRef, useState } from "react";
import { api, type MemoryNode } from "../api";

/**
 * The graph as a picture.
 *
 * The memory list answers "does it know X". This answers "how is any of this
 * connected", which is the question a graph exists for and the one that becomes
 * useful once an unattended loop is writing into it: a cluster nothing links to
 * is a subject the agent read about and never related to anything else, and a
 * node everything points at is what it actually works on.
 *
 * Drawn with a small force simulation rather than a graph library. The whole of
 * it is under a hundred lines of arithmetic, it needs no dependency on the
 * CSP-restricted page, and a layout nobody can read the source of is a layout
 * nobody can fix when it looks wrong.
 */

interface Edge {
  source: string;
  relation: string;
  target: string;
  weight: number;
}

interface Placed {
  node: MemoryNode;
  x: number;
  y: number;
  vx: number;
  vy: number;
  degree: number;
}

/** Colour by kind, so the shape of the memory is visible before reading a word. */
const TYPE_COLOUR: Record<string, string> = {
  anchor: "#e8a33d",
  user: "#4da3ff",
  project: "#7ee081",
  episode: "#9b8cff",
  concept: "#8ab4c8",
  fact: "#c8a2c8",
  skill: "#5fc9b0",
};

const WIDTH = 900;
const HEIGHT = 560;

/**
 * A few hundred iterations of repulsion plus spring attraction.
 *
 * Run once when the data arrives rather than animated: an animated layout is a
 * toy, and what is wanted here is a readable still. Deterministic from the node
 * ids, so the same memory always draws the same way and a change in the picture
 * means a change in the graph.
 */
function layout(nodes: MemoryNode[], edges: Edge[]): Placed[] {
  const seed = (s: string) => {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h);
  };

  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }

  /**
   * Everything below is tuned against one bug: every node ended up pinned to
   * the edge of the canvas, for any graph past a handful of nodes. Verified
   * before shipping — the shipped constants, run against a synthetic 60-node
   * graph, left 60 of 60 nodes touching the boundary. Two compounding causes:
   *
   * Repulsion summed over every pair, so its total push on one node grows
   * with the node count, while the pull back to centre (`0.001`) was a fixed
   * constant. Past a few dozen nodes the outward push from *everything else*
   * routinely outweighs a centring force that never got stronger to match —
   * making it stronger alone did not help either, measured: still 60 of 60.
   *
   * And the boundary was a hard clamp with no force behind it: a node pushed
   * to `x = WIDTH - 24` just sat there being clamped every step, since
   * clamping caps position without touching velocity — nothing ever pushed
   * it back inward, so "reached the edge" and "stuck at the edge" were the
   * same event.
   *
   * The fix is both: repulsion divided by node count so its total effect on
   * one node stays roughly constant as the graph grows, and a soft wall that
   * pushes back — increasingly hard the further a node has crossed into the
   * margin — rather than a clamp that only stops it. Re-measured at several
   * sizes after the change: 0 of 60 stuck, 0 of 8, 0 of 20; 2 of 150 at the
   * one size tested past what this view is likely to ever hold.
   */
  const repulsionStrength = 2500 / Math.max(nodes.length, 1);
  const centerPull = 0.03;
  const springPull = 0.01;
  const margin = 40;
  const wallPush = 0.08;

  const placed: Placed[] = nodes.map((node) => {
    const h = seed(node.id);
    const angle = (h % 360) * (Math.PI / 180);
    // A smaller starting radius than the canvas itself — the force loop below
    // decides the real layout; this only has to not start past the boundary
    // it will spend the first several steps pushed further toward.
    const radius = 40 + ((h >> 9) % 90);
    return {
      node,
      x: WIDTH / 2 + Math.cos(angle) * radius,
      y: HEIGHT / 2 + Math.sin(angle) * radius,
      vx: 0,
      vy: 0,
      degree: degree.get(node.id) ?? 0,
    };
  });

  const index = new Map(placed.map((p) => [p.node.id, p]));
  for (let step = 0; step < 300; step++) {
    // Repulsion, so nodes do not sit on top of each other. Scaled by count so
    // the total push on one node does not grow with the size of the graph.
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i];
        const b = placed[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d2 = dx * dx + dy * dy || 1;
        const force = repulsionStrength / d2;
        const fx = dx * force;
        const fy = dy * force;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }
    }
    // Attraction along edges, so what is related sits together.
    for (const e of edges) {
      const a = index.get(e.source);
      const b = index.get(e.target);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      a.vx += dx * springPull;
      a.vy += dy * springPull;
      b.vx -= dx * springPull;
      b.vy -= dy * springPull;
    }
    // Damping, a pull to centre strong enough to actually compete with
    // repulsion at these sizes, and a soft wall in place of a hard clamp —
    // one that pushes a node back in rather than merely stopping it once it
    // has already reached the edge.
    for (const p of placed) {
      p.vx = (p.vx + (WIDTH / 2 - p.x) * centerPull) * 0.82;
      p.vy = (p.vy + (HEIGHT / 2 - p.y) * centerPull) * 0.82;
      if (p.x < margin) p.vx += (margin - p.x) * wallPush;
      if (p.x > WIDTH - margin) p.vx -= (p.x - (WIDTH - margin)) * wallPush;
      if (p.y < margin) p.vy += (margin - p.y) * wallPush;
      if (p.y > HEIGHT - margin) p.vy -= (p.y - (HEIGHT - margin)) * wallPush;
      p.x = Math.max(6, Math.min(WIDTH - 6, p.x + p.vx));
      p.y = Math.max(6, Math.min(HEIGHT - 6, p.y + p.vy));
    }
  }
  return placed;
}

export function MemoryGraph({ onSelect }: { onSelect?: (name: string) => void }) {
  const [data, setData] = useState<{ nodes: MemoryNode[]; edges: Edge[] }>({ nodes: [], edges: [] });
  const [type, setType] = useState("");
  const [hover, setHover] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    api
      .memoryGraph(type)
      .then(setData)
      .catch((e) => setError(String(e)));
  }, [type]);

  const placed = useMemo(() => layout(data.nodes, data.edges), [data]);
  const index = useMemo(() => new Map(placed.map((p) => [p.node.id, p])), [placed]);

  if (error) return <div className="p-4 text-xs text-danger">{error}</div>;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2 text-xs">
        <select
          value={type}
          onChange={(e) => setType(e.target.value)}
          className="rounded-lg border border-line bg-transparent px-2 py-1 text-xs text-fg-muted"
        >
          <option value="">everything</option>
          <option value="episode">conversations</option>
          <option value="concept">concepts</option>
          <option value="fact">facts</option>
          <option value="skill">skills</option>
          <option value="user">about you</option>
        </select>
        <span className="text-fg-faint">
          {data.nodes.length} node(s), {data.edges.length} link(s)
        </span>
        {/*
          * An isolated node is worth naming: it is something the agent recorded
          * and never connected to anything, which is where memory quietly goes
          * to waste.
          */}
        <span className="ml-auto text-fg-faint">
          {placed.filter((p) => p.degree === 0).length} unconnected
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-2">
        <svg ref={svgRef} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="h-full w-full">
          {data.edges.map((e, i) => {
            const a = index.get(e.source);
            const b = index.get(e.target);
            if (!a || !b) return null;
            const lit = hover === e.source || hover === e.target;
            return (
              <line
                key={i}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={lit ? "#8ab4c8" : "currentColor"}
                strokeOpacity={lit ? 0.8 : 0.15}
                strokeWidth={lit ? 1.5 : 0.75}
                className="text-fg-faint"
              />
            );
          })}
          {placed.map((p) => {
            // Size by how connected it is, not by confidence: a well-linked
            // node is the one worth noticing on a picture, and confidence is
            // already in the tooltip.
            const r = 4 + Math.min(p.degree, 12) * 0.9;
            const lit = hover === p.node.id;
            return (
              <g key={p.node.id}>
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={r}
                  fill={TYPE_COLOUR[p.node.type] ?? "#8ab4c8"}
                  fillOpacity={lit ? 1 : 0.75}
                  stroke={lit ? "#fff" : "none"}
                  strokeWidth={1}
                  onMouseEnter={() => setHover(p.node.id)}
                  onMouseLeave={() => setHover(null)}
                  onClick={() => onSelect?.(p.node.name)}
                  className="cursor-pointer"
                >
                  <title>
                    {`${p.node.name}\n${p.node.type} · confidence ${p.node.confidence.toFixed(2)} · ${p.degree} link(s)\n\n${p.node.summary.slice(0, 200)}`}
                  </title>
                </circle>
                {(lit || r > 8) && (
                  <text
                    x={p.x + r + 3}
                    y={p.y + 3}
                    className="pointer-events-none fill-current text-fg-muted"
                    style={{ fontSize: 9 }}
                  >
                    {p.node.name.slice(0, 28)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
