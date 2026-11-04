import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  Background,
  Controls,
  ReactFlow,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Edge as FlowEdge,
  type Node,
  type OnSelectionChangeParams,
} from "@xyflow/react";
import { WidgetNode, type WidgetNodeData } from "./WidgetNode";
import { useCanvas, useDocVersion } from "./hooks";

const nodeTypes = { widget: WidgetNode };

type WNode = Node<WidgetNodeData, "widget">;

/** The infinite canvas. The Loro document is the source of truth; React Flow state mirrors it. */
export function Board({ onSelect }: { onSelect: (ids: string[]) => void }) {
  const { doc, session, author } = useCanvas();
  const version = useDocVersion(doc);
  const flow = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);
  const dragging = useRef(new Set<string>());
  const [nodes, setNodes, onNodesChange] = useNodesState<WNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>([]);

  // Document → React Flow. Keep local selection, and the position of widgets being dragged.
  useEffect(() => {
    setNodes((prev) => {
      const old = new Map(prev.map((n) => [n.id, n]));
      return doc.widgets().map((w) => {
        const o = old.get(w.id);
        const held = o && dragging.current.has(w.id);
        return {
          id: w.id,
          type: "widget",
          position: held ? o.position : { x: w.x, y: w.y },
          width: w.w,
          height: w.h,
          zIndex: w.z,
          selected: o?.selected ?? false,
          dragHandle: ".widget-header",
          data: { widget: w },
        };
      });
    });
    setEdges(doc.edges().map((e) => ({ id: e.id, source: e.from, target: e.to, label: e.label || undefined })));
  }, [version, doc, setNodes, setEdges]);

  const onSelectionChange = useCallback(
    ({ nodes }: OnSelectionChangeParams) => {
      const ids = nodes.map((n) => n.id);
      onSelect(ids);
      session?.setPresence({ selectedIds: ids });
    },
    [session, onSelect],
  );

  // Share what this browser sees, so an agent knows where "here" is.
  const sendViewport = useMemo(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const el = wrapper.current;
        if (!el || !session) return;
        const { x, y, zoom } = flow.getViewport();
        const r = el.getBoundingClientRect();
        session.setPresence({ viewport: { x: Math.round(-x / zoom), y: Math.round(-y / zoom), w: Math.round(r.width / zoom), h: Math.round(r.height / zoom), zoom: Math.round(zoom * 100) / 100 } });
      }, 250);
    };
  }, [flow, session]);
  useEffect(sendViewport, [sendViewport]);

  return (
    <div className="board" ref={wrapper}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStart={(_, __, dragged) => dragged.forEach((n) => dragging.current.add(n.id))}
        onNodeDragStop={(_, __, dragged) => {
          doc.moveWidgets(dragged.map((n) => ({ id: n.id, x: n.position.x, y: n.position.y })), author);
          dragged.forEach((n) => dragging.current.delete(n.id));
        }}
        onNodesDelete={(del) => doc.deleteWidgets(del.map((n) => n.id), author)}
        onEdgesDelete={(del) => doc.disconnect(del.map((e) => e.id), author)}
        onConnect={(c) => c.source && c.target && c.source !== c.target && doc.connect(c.source, c.target, "", author)}
        onSelectionChange={onSelectionChange}
        onMoveEnd={sendViewport}
        onInit={sendViewport}
        deleteKeyCode={["Backspace", "Delete"]}
        minZoom={0.1}
        maxZoom={3}
        fitView
        fitViewOptions={{ maxZoom: 1, padding: 0.2 }}
        proOptions={{ hideAttribution: false }}
      >
        <Background gap={24} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
