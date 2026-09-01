import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react"
import { KeyRound, Table2 } from "lucide-react"
import { useMemo } from "react"

import type { Catalog, CatalogTable } from "@/lib/database"

type TableNode = Node<{ table: CatalogTable }, "databaseTable">

const nodeTypes = { databaseTable: DatabaseTableNode }

export function SchemaDiagram({ catalog }: { catalog: Catalog }) {
  const graph = useMemo(() => buildGraph(catalog), [catalog])
  if (catalog.tables.length === 0) {
    return <div className="grid h-full place-items-center text-xs text-muted-foreground">No tables to diagram</div>
  }
  return (
    <ReactFlow
      nodes={graph.nodes}
      edges={graph.edges}
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.15 }}
      minZoom={0.15}
      maxZoom={1.5}
      nodesDraggable
      nodesConnectable={false}
      elementsSelectable
      onlyRenderVisibleElements
      colorMode="dark"
    >
      <Background color="rgba(255,255,255,0.06)" gap={24} size={1} />
      <Controls showInteractive={false} />
    </ReactFlow>
  )
}

function DatabaseTableNode({ data }: NodeProps<TableNode>) {
  return (
    <div className="w-64 overflow-hidden rounded-lg border border-white/10 bg-[#17151d] font-mono text-[11px] shadow-xl shadow-black/25">
      <div className="flex items-center gap-2 border-b border-white/10 bg-white/[0.025] px-3 py-2">
        <Table2 className="size-3.5 text-primary" />
        <span className="truncate font-semibold text-foreground">{data.table.name}</span>
        <span className="ml-auto text-[9px] text-muted-foreground">{data.table.schema}</span>
      </div>
      <div className="py-1">
        {data.table.columns.map((column) => (
          <div key={column.name} className="relative flex h-6 items-center gap-2 px-3 text-muted-foreground">
            <Handle type="target" id={column.name} position={Position.Left} className="!size-1.5 !border-0 !bg-primary/70" />
            {column.primary_key ? <KeyRound className="size-3 text-amber-300" /> : <span className="w-3" />}
            <span className="min-w-0 flex-1 truncate text-foreground/90">{column.name}</span>
            <span className="truncate text-[9px]">{column.data_type}</span>
            <Handle type="source" id={column.name} position={Position.Right} className="!size-1.5 !border-0 !bg-primary/70" />
          </div>
        ))}
      </div>
    </div>
  )
}

function buildGraph(catalog: Catalog): { nodes: TableNode[]; edges: Edge[] } {
  const laneCount = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(catalog.tables.length))))
  const laneHeights = Array.from({ length: laneCount }, () => 0)
  const nodes = catalog.tables.map((table): TableNode => {
    let lane = 0
    for (let index = 1; index < laneHeights.length; index += 1) {
      if (laneHeights[index] < laneHeights[lane]) lane = index
    }
    const position = { x: lane * 330, y: laneHeights[lane] }
    laneHeights[lane] += 82 + table.columns.length * 24
    return {
      id: tableID(table.schema, table.name),
      type: "databaseTable",
      position,
      data: { table },
    }
  })
  const edges = catalog.foreign_keys.map((foreignKey, index): Edge => ({
    id: `${foreignKey.name}-${index}`,
    source: tableID(foreignKey.source_schema, foreignKey.source_table),
    sourceHandle: foreignKey.source_column,
    target: tableID(foreignKey.target_schema, foreignKey.target_table),
    targetHandle: foreignKey.target_column,
    type: "smoothstep",
    markerEnd: { type: MarkerType.ArrowClosed, color: "#9f4cff" },
    style: { stroke: "#9f4cff", strokeWidth: 1.25, opacity: 0.7 },
  }))
  return { nodes, edges }
}

function tableID(schema: string, table: string) {
  return `${schema}.${table}`
}
