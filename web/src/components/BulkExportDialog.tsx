import { Archive, Check, Download, LoaderCircle, Search, Table2 } from "lucide-react"
import { useMemo, useState } from "react"
import { toast } from "sonner"

import type { ExportFormat } from "@/components/ExportDialog"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { api, getErrorMessage } from "@/lib/api"
import type { CatalogTable, DatabaseTarget } from "@/lib/database"
import { cn } from "@/lib/utils"

type BulkExportDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  target: DatabaseTarget
  databaseName: string
  tables: CatalogTable[]
  format: ExportFormat
  onFormatChange: (format: ExportFormat) => void
}

const formatLabels: Record<ExportFormat, string> = {
  csv: "CSV",
  json: "JSON",
  parquet: "Parquet",
  sql: "SQL",
}

function tableKey(table: Pick<CatalogTable, "schema" | "name">) {
  return `${table.schema}\u0000${table.name}`
}

export function BulkExportDialog({
  open,
  onOpenChange,
  target,
  databaseName,
  tables,
  format,
  onFormatChange,
}: BulkExportDialogProps) {
  const exportableTables = useMemo(
    () => tables.filter((table) => table.kind === "table" || table.kind === "partitioned_table"),
    [tables],
  )
  const [selectedKeys, setSelectedKeys] = useState(() => new Set(exportableTables.map(tableKey)))
  const [filter, setFilter] = useState("")
  const [downloading, setDownloading] = useState(false)
  const normalizedFilter = filter.trim().toLowerCase()
  const visibleTables = exportableTables.filter((table) => (
    `${table.schema}.${table.name}`.toLowerCase().includes(normalizedFilter)
  ))
  const selectedTables = exportableTables.filter((table) => selectedKeys.has(tableKey(table)))

  function toggleTable(table: CatalogTable) {
    setSelectedKeys((current) => {
      const next = new Set(current)
      const key = tableKey(table)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  async function download() {
    if (downloading || selectedTables.length === 0) return
    setDownloading(true)
    try {
      const response = await api.post<Blob>(
        "/exports/tables",
        {
          target_id: target.id,
          database_name: databaseName,
          format,
          tables: selectedTables.map((table) => ({ schema: table.schema, name: table.name })),
        },
        { responseType: "blob" },
      )
      const disposition = String(response.headers["content-disposition"] ?? "")
      const fileName = disposition.match(/filename="?([^";]+)"?/i)?.[1]
        ?? `${target.name}-${databaseName}-tables-export.zip`
      const url = URL.createObjectURL(response.data)
      const link = document.createElement("a")
      link.href = url
      link.download = fileName
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      toast.success(`${selectedTables.length} table${selectedTables.length === 1 ? "" : "s"} exported as ${formatLabels[format]}`)
      onOpenChange(false)
    } catch (error) {
      toast.error(await bulkExportErrorMessage(error))
    } finally {
      setDownloading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[min(720px,calc(100vh-2rem))] max-w-3xl grid-rows-[auto_auto_minmax(0,1fr)_auto]">
        <DialogHeader>
          <DialogTitle>Export database tables</DialogTitle>
          <DialogDescription>
            Package selected tables from {target.name} / {databaseName} into one ZIP archive.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_150px]">
          <div className="relative">
            <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-8"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter tables"
            />
          </div>
          <Select value={format} onValueChange={(value) => onFormatChange(value as ExportFormat)} disabled={downloading}>
            <SelectTrigger aria-label="Bulk export format">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(formatLabels).map(([value, label]) => (
                <SelectItem key={value} value={value}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="min-h-0 overflow-hidden rounded-lg border bg-[#0b0a0e]">
          <div className="flex h-10 items-center border-b bg-gr-purple/5 px-3">
            <Archive className="mr-2 size-3.5 text-gr-pink" />
            <span className="text-xs font-medium">{selectedTables.length} of {exportableTables.length} tables selected</span>
            <div className="ml-auto flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                disabled={downloading || selectedTables.length === exportableTables.length}
                onClick={() => setSelectedKeys(new Set(exportableTables.map(tableKey)))}
              >
                Select all
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={downloading || selectedTables.length === 0}
                onClick={() => setSelectedKeys(new Set())}
              >
                Clear
              </Button>
            </div>
          </div>
          <div className="h-[calc(100%-2.5rem)] overflow-y-auto p-1.5">
            {visibleTables.map((table) => {
              const selected = selectedKeys.has(tableKey(table))
              return (
                <button
                  key={tableKey(table)}
                  type="button"
                  aria-pressed={selected}
                  disabled={downloading}
                  className={cn(
                    "flex h-9 w-full items-center gap-2 rounded-md border border-transparent px-2.5 text-left text-xs transition-[color,background-color,border-color] duration-150 motion-reduce:transition-none",
                    selected
                      ? "border-gr-purple/20 bg-gr-purple/[0.07] text-foreground"
                      : "text-muted-foreground hover:bg-white/[0.025] hover:text-foreground",
                  )}
                  onClick={() => toggleTable(table)}
                >
                  <span className={cn(
                    "grid size-4 place-items-center rounded border transition-colors",
                    selected ? "border-gr-pink/50 bg-gr-pink/15 text-pink-200" : "border-white/15 bg-black/20",
                  )}>
                    {selected && <Check className="size-3" />}
                  </span>
                  <Table2 className={cn("size-3.5", selected && "text-gr-pink")} />
                  <span className="font-mono text-[11px] text-muted-foreground">{table.schema}.</span>
                  <span className="font-medium">{table.name}</span>
                  <span className="ml-auto font-mono text-[9px] text-muted-foreground">{table.columns.length} cols</span>
                </button>
              )
            })}
            {visibleTables.length === 0 && (
              <div className="grid h-full min-h-40 place-items-center text-xs text-muted-foreground">
                {exportableTables.length === 0 ? "No writable tables are available" : "No tables match the filter"}
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="items-center sm:justify-between">
          <p className="mr-auto max-w-md text-[10px] leading-relaxed text-muted-foreground">
            Each table is exported as a separate {formatLabels[format]} file. The archive also includes schema.sql with the selected tables&apos; DDL.
          </p>
          <Button variant="ghost" disabled={downloading} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={downloading || selectedTables.length === 0} onClick={() => void download()}>
            {downloading ? <LoaderCircle className="animate-spin" /> : <Download />}
            {downloading ? "Building archive…" : `Export ${selectedTables.length || ""} table${selectedTables.length === 1 ? "" : "s"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

async function bulkExportErrorMessage(error: unknown) {
  const data = (error as { response?: { data?: unknown } })?.response?.data
  if (data instanceof Blob) {
    try {
      const parsed = JSON.parse(await data.text()) as { error?: string }
      if (parsed.error) return parsed.error
    } catch {
      return "Bulk export failed"
    }
  }
  return getErrorMessage(error)
}
