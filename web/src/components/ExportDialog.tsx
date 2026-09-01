import { Download, LoaderCircle } from "lucide-react"
import { useQuery } from "@tanstack/react-query"
import { useMemo, useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { api, getErrorMessage } from "@/lib/api"
import type { DatabaseTarget, QueryColumn } from "@/lib/database"

export type ExportFormat = "csv" | "json" | "parquet" | "sql"

type ExportDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  target: DatabaseTarget
  databaseName: string
  statement: string
  sourceName: string
  format: ExportFormat
  onFormatChange: (format: ExportFormat) => void
}

type ExportPreview = {
  columns: QueryColumn[]
  rows: unknown[][]
  row_count: number
  truncated: boolean
}

const formatLabels: Record<ExportFormat, string> = {
  csv: "CSV",
  json: "JSON",
  parquet: "Parquet",
  sql: "SQL",
}

export function ExportDialog({ open, onOpenChange, target, databaseName, statement, sourceName, format, onFormatChange }: ExportDialogProps) {
  const [downloading, setDownloading] = useState(false)
  const previewQuery = useQuery({
    queryKey: ["exportPreview", target.id, databaseName, statement],
    queryFn: async ({ signal }) => (
      await api.post<ExportPreview>(
        "/exports/preview",
        { target_id: target.id, database_name: databaseName, statement },
        { signal },
      )
    ).data,
    enabled: open,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  })
  const preview = previewQuery.data ?? null
  const previewing = previewQuery.isPending || previewQuery.isFetching
  const previewError = previewQuery.isError ? getErrorMessage(previewQuery.error) : ""

  const textPreview = useMemo(() => {
    if (!preview || format === "parquet") return ""
    if (format === "csv") return csvPreview(preview)
    if (format === "json") return jsonPreview(preview)
    return sqlPreview(preview)
  }, [format, preview])

  async function download() {
    if (downloading) return
    setDownloading(true)
    try {
      const response = await api.post<Blob>(
        "/exports",
        { target_id: target.id, database_name: databaseName, statement, source_name: sourceName, format },
        { responseType: "blob" },
      )
      const disposition = String(response.headers["content-disposition"] ?? "")
      const fileName = disposition.match(/filename="?([^";]+)"?/i)?.[1] ?? `${target.name}-${databaseName}-${sourceName}-export.${format}`
      const url = URL.createObjectURL(response.data)
      const link = document.createElement("a")
      link.href = url
      link.download = fileName
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      toast.success(`${formatLabels[format]} export ready`)
    } catch (error) {
      toast.error(await exportErrorMessage(error))
    } finally {
      setDownloading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[min(680px,calc(100vh-2rem))] max-w-4xl grid-rows-[auto_auto_minmax(0,1fr)_auto]">
        <DialogHeader>
          <DialogTitle>Preview export</DialogTitle>
          <DialogDescription>
            Review the selected query from {target.name} / {databaseName} before downloading it.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-end justify-between gap-4">
          <div>
            <div className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">Format</div>
            <Select value={format} onValueChange={(value) => onFormatChange(value as ExportFormat)}>
              <SelectTrigger className="mt-1 w-36" aria-label="Export format">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(formatLabels).map(([value, label]) => (
                  <SelectItem key={value} value={value}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {preview && (
            <div className="pb-1 text-right font-mono text-[10px] text-muted-foreground">
              {preview.columns.length} columns · {preview.row_count} preview rows{preview.truncated ? " · more available" : ""}
            </div>
          )}
        </div>

        <div className="min-h-0 overflow-hidden rounded-lg border bg-[#0b0a0e] shadow-inner shadow-black/25">
          {previewing ? (
            <div className="grid h-full place-items-center text-xs text-muted-foreground">
              <div className="flex items-center gap-2"><LoaderCircle className="size-3.5 animate-spin" /> Running read-only preview…</div>
            </div>
          ) : previewError ? (
            <div className="grid h-full place-items-center p-6 text-center">
              <div>
                <p className="max-w-xl text-xs text-destructive">{previewError}</p>
                <Button className="mt-3" variant="secondary" size="sm" onClick={() => void previewQuery.refetch()}>Try again</Button>
              </div>
            </div>
          ) : preview ? (
            format === "parquet" ? <ParquetPreview preview={preview} /> : (
              <pre className="h-full overflow-auto p-4 font-mono text-[11px] leading-5 text-[#d7d3dc]">{textPreview}</pre>
            )
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!preview || previewing || downloading} onClick={() => void download()}>
            <Download /> {downloading ? "Exporting…" : `Download ${formatLabels[format]}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ParquetPreview({ preview }: { preview: ExportPreview }) {
  return (
    <div className="grid h-full min-w-0 grid-rows-[auto_minmax(0,1fr)]">
      <div className="border-b bg-gr-purple/5 px-4 py-2.5 text-[11px] text-muted-foreground">
        Parquet is a binary columnar file. This preview shows its nullable UTF-8 columns and representative rows.
      </div>
      <div className="min-h-0 overflow-auto">
        <table className="w-max min-w-full border-collapse font-mono text-[11px]">
          <thead className="sticky top-0 z-10 bg-[#15131a] text-left">
            <tr>
              {preview.columns.map((column) => (
                <th key={column.name} className="border-r border-b px-3 py-2 font-medium whitespace-nowrap">
                  {column.name}<span className="ml-2 font-normal text-muted-foreground">UTF8 · oid:{column.data_type_oid}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.rows.length === 0 && (
              <tr>
                <td colSpan={preview.columns.length} className="px-4 py-10 text-center font-sans text-xs text-muted-foreground">Query returned no rows</td>
              </tr>
            )}
            {preview.rows.map((row, rowIndex) => (
              <tr key={rowIndex} className="hover:bg-white/[0.025]">
                {row.map((value, columnIndex) => (
                  <td key={columnIndex} className="max-w-80 truncate border-r border-b px-3 py-1.5">
                    {value === null ? <span className="italic text-muted-foreground">NULL</span> : String(value)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function csvPreview(preview: ExportPreview) {
  return [
    preview.columns.map((column) => csvValue(column.name)).join(","),
    ...preview.rows.map((row) => row.map(csvValue).join(",")),
  ].join("\n")
}

function csvValue(value: unknown) {
  if (value === null || value === undefined) return ""
  const text = String(value)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function jsonPreview(preview: ExportPreview) {
  const rows = preview.rows.map((row) => Object.fromEntries(preview.columns.map((column, index) => [column.name, row[index]])))
  return JSON.stringify(rows, null, 2)
}

function sqlPreview(preview: ExportPreview) {
  const tableName = '"workbench_export"'
  const columns = preview.columns.map((column) => quoteIdentifier(column.name))
  const createStatement = `CREATE TABLE ${tableName} (\n  ${columns.map((column) => `${column} text`).join(",\n  ")}\n);`
  const inserts = preview.rows.map((row) => (
    `INSERT INTO ${tableName} (${columns.join(", ")}) VALUES (${row.map(sqlValue).join(", ")});`
  ))
  return [createStatement, "", ...inserts].join("\n")
}

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`
}

function sqlValue(value: unknown) {
  return value === null || value === undefined ? "NULL" : `'${String(value).replaceAll("'", "''")}'`
}

async function exportErrorMessage(error: unknown) {
  const data = (error as { response?: { data?: unknown } })?.response?.data
  if (data instanceof Blob) {
    try {
      const parsed = JSON.parse(await data.text()) as { error?: string }
      if (parsed.error) return parsed.error
    } catch {
      return "Export failed"
    }
  }
  return getErrorMessage(error)
}
