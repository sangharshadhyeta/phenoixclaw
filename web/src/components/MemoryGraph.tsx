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

  const placed: Placed[] = nodes.map((node) => {
    const h = seed(node.id);
    const angle = (h % 360) * (Math.PI / 180);
    const radius = 80 + ((h >> 9) % 180);
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
    // Repulsion, so nodes do not sit on top of each other.
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i];
        const b = placed[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d2 = dx * dx + dy * dy || 1;
        const force = 900 / d2;
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
      const force = 0.004;
      a.vx += dx * force;
      a.vy += dy * force;
      b.vx -= dx * force;
      b.vy -= dy * force;
    }
    // Damping and a gentle pull to centre, or the whole thing drifts off-screen.
    for (const p of placed) {
      p.vx = (p.vx + (WIDTH / 2 - p.x) * 0.001) * 0.82;
      p.vy = (p.vy + (HEIGHT / 2 - p.y) * 0.001) * 0.82;
      p.x = Math.max(24, Math.min(WIDTH - 24, p.x + p.vx));
      p.y = Math.max(24, Math.min(HEIGHT - 24, p.y + p.vy));
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
