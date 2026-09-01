import { useMutation } from "@tanstack/react-query"
import { AlertTriangle, CheckCircle2, Eye, FileSpreadsheet, LoaderCircle, Upload } from "lucide-react"
import { useMemo, useRef, useState } from "react"
import type { DragEvent } from "react"

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
import type { CatalogTable, DatabaseTarget } from "@/lib/database"
import { cn } from "@/lib/utils"

type DataImportDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  target: DatabaseTarget
  databaseName: string
  tables: CatalogTable[]
  onImported: (result: ImportResult, table: CatalogTable) => void
}

export type ImportResult = {
  transfer_id: string
  row_count: number
  error_count: number
  errors: ImportRowError[]
}

type ImportRowError = {
  row: number
  message: string
}

type ImportPreview = {
  columns: string[]
  rows: string[][]
  row_count: number
  truncated: boolean
}

type ImportErrorPolicy = "abort" | "continue"

const maxFileBytes = 50 * 1024 * 1024

export function DataImportDialog({ open, onOpenChange, target, databaseName, tables, onImported }: DataImportDialogProps) {
  const writableTables = useMemo(
    () => tables.filter((table) => table.kind === "table" || table.kind === "partitioned_table"),
    [tables],
  )
  const [tableIndex, setTableIndex] = useState("0")
  const [file, setFile] = useState<File | null>(null)
  const [fileError, setFileError] = useState("")
  const [errorPolicy, setErrorPolicy] = useState<ImportErrorPolicy>("abort")
  const [dragging, setDragging] = useState(false)
  const [completedResult, setCompletedResult] = useState<ImportResult | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const selectedTable = writableTables[Number(tableIndex)]

  function importFormData(includePolicy: boolean) {
    if (!file || !selectedTable) throw new Error("Choose a destination table and CSV file")
    const body = new FormData()
    body.append("database_name", databaseName)
    body.append("schema", selectedTable.schema)
    body.append("table", selectedTable.name)
    if (includePolicy) body.append("error_policy", errorPolicy)
    body.append("file", file)
    return body
  }

  const previewMutation = useMutation({
    mutationFn: async () => (
      await api.post<ImportPreview>(`/targets/${target.id}/imports/preview`, importFormData(false))
    ).data,
  })
  const importMutation = useMutation({
    mutationFn: async () => (
      await api.post<ImportResult>(`/targets/${target.id}/imports`, importFormData(true))
    ).data,
    onSuccess: (result) => {
      if (!selectedTable) return
      onImported(result, selectedTable)
      if (result.error_count > 0) {
        setCompletedResult(result)
      } else {
        onOpenChange(false)
      }
    },
  })
  const preview = previewMutation.data ?? null

  function resetReview() {
    previewMutation.reset()
    importMutation.reset()
    setCompletedResult(null)
  }

  function chooseFile(nextFile?: File) {
    if (!nextFile) return
    if (nextFile.size > maxFileBytes) {
      setFile(null)
      setFileError("CSV files must be 50 MB or smaller")
      resetReview()
      return
    }
    if (!nextFile.name.toLowerCase().endsWith(".csv")) {
      setFile(null)
      setFileError("Choose a .csv file")
      resetReview()
      return
    }
    setFile(nextFile)
    setFileError("")
    resetReview()
  }

  function dropFile(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setDragging(false)
    if (previewMutation.isPending || importMutation.isPending || completedResult) return
    chooseFile(event.dataTransfer.files[0])
  }

  const requestError = fileError || (previewMutation.isError ? getErrorMessage(previewMutation.error) : "") ||
    (importMutation.isError ? getErrorMessage(importMutation.error) : "")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn(preview && "h-[min(760px,calc(100vh-2rem))] max-w-5xl grid-rows-[auto_minmax(0,1fr)_auto]")}>
        <DialogHeader>
          <DialogTitle>Import CSV data</DialogTitle>
          <DialogDescription>
            Preview and append rows to an existing table in {target.name} / {databaseName}.
          </DialogDescription>
        </DialogHeader>

        <div className={cn("grid gap-4", preview && "min-h-0 overflow-y-auto pr-1")}>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="grid gap-1.5 text-xs font-medium">
              Destination table
              <Select
                value={tableIndex}
                onValueChange={(value) => { setTableIndex(value); resetReview() }}
                disabled={writableTables.length === 0 || previewMutation.isPending || importMutation.isPending || completedResult !== null}
              >
                <SelectTrigger aria-label="Destination table">
                  <SelectValue placeholder="No writable tables" />
                </SelectTrigger>
                <SelectContent>
                  {writableTables.map((table, index) => (
                    <SelectItem key={`${table.schema}.${table.name}`} value={String(index)}>
                      {table.schema}.{table.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>

            <label className="grid gap-1.5 text-xs font-medium">
              Error handling
              <Select value={errorPolicy} onValueChange={(value) => setErrorPolicy(value as ImportErrorPolicy)} disabled={importMutation.isPending || completedResult !== null}>
                <SelectTrigger aria-label="Import error handling">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="abort">Rollback on first error</SelectItem>
                  <SelectItem value="continue">Skip invalid rows</SelectItem>
                </SelectContent>
              </Select>
            </label>
          </div>

          <div className="-mt-2 text-[11px] leading-relaxed text-muted-foreground">
            {errorPolicy === "abort"
              ? "The import commits atomically only after every row succeeds."
              : "Conversion and constraint errors are isolated; valid rows commit together and rejected rows are reported."}
          </div>

          <div
            className={cn(
              "grid min-h-28 place-items-center rounded-lg border border-dashed px-5 py-4 text-center transition-[border-color,background-color,transform] duration-150 motion-reduce:transition-none",
              dragging ? "scale-[1.01] border-gr-pink/70 bg-gr-pink/5" : "border-white/15 bg-black/15 hover:border-gr-purple/45",
            )}
            onDragEnter={(event) => { event.preventDefault(); setDragging(true) }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={() => setDragging(false)}
            onDrop={dropFile}
          >
            <input
              ref={fileInputRef}
              className="hidden"
              type="file"
              accept=".csv,text/csv"
              disabled={previewMutation.isPending || importMutation.isPending || completedResult !== null}
              onChange={(event) => chooseFile(event.target.files?.[0])}
            />
            {file ? (
              <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
                <FileSpreadsheet className="size-6 text-gr-pink" />
                <div className="max-w-80 text-left">
                  <p className="truncate text-sm font-medium">{file.name}</p>
                  <p className="text-xs text-muted-foreground">{formatFileSize(file.size)}</p>
                </div>
                <Button variant="ghost" size="sm" disabled={previewMutation.isPending || importMutation.isPending || completedResult !== null} onClick={() => fileInputRef.current?.click()}>
                  Choose another
                </Button>
              </div>
            ) : (
              <div>
                <Upload className="mx-auto size-6 text-gr-purple" />
                <p className="mt-2 text-sm font-medium">Drop a CSV here</p>
                <p className="mt-1 text-xs text-muted-foreground">Header names must match destination columns · 50 MB max</p>
                <Button className="mt-3" variant="secondary" size="sm" onClick={() => fileInputRef.current?.click()}>
                  Browse files
                </Button>
              </div>
            )}
          </div>

          {requestError && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {requestError}
            </div>
          )}

          {preview && <ImportPreviewTable preview={preview} />}
          {completedResult && <ImportErrorSummary result={completedResult} />}
        </div>

        <DialogFooter>
          {completedResult ? (
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button
                variant="secondary"
                disabled={!file || !selectedTable || previewMutation.isPending || importMutation.isPending}
                onClick={() => previewMutation.mutate()}
              >
                {previewMutation.isPending ? <LoaderCircle className="animate-spin" /> : <Eye />}
                {previewMutation.isPending ? "Checking…" : preview ? "Refresh preview" : "Preview file"}
              </Button>
              <Button
                disabled={!preview || preview.row_count === 0 || importMutation.isPending || previewMutation.isPending}
                onClick={() => importMutation.mutate()}
              >
                {importMutation.isPending && <LoaderCircle className="animate-spin" />}
                {importMutation.isPending ? "Importing…" : preview ? `Import ${preview.row_count.toLocaleString()} rows` : "Import rows"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ImportPreviewTable({ preview }: { preview: ImportPreview }) {
  return (
    <div className="overflow-hidden rounded-lg border bg-[#0b0a0e]">
      <div className="flex items-center gap-2 border-b bg-gr-purple/5 px-3 py-2 text-[11px] text-muted-foreground">
        <CheckCircle2 className="size-3.5 text-emerald-400" />
        <span>Header matches · {preview.row_count.toLocaleString()} data rows</span>
        {preview.truncated && <span className="ml-auto">Showing first {preview.rows.length}</span>}
      </div>
      <div className="max-h-72 overflow-auto">
        <table className="w-max min-w-full border-collapse font-mono text-[11px]">
          <thead className="sticky top-0 z-10 bg-[#15131a] text-left">
            <tr>
              <th className="border-r border-b px-3 py-2 font-medium text-muted-foreground">#</th>
              {preview.columns.map((column) => (
                <th key={column} className="border-r border-b px-3 py-2 font-medium whitespace-nowrap">{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.rows.length === 0 && (
              <tr><td colSpan={preview.columns.length + 1} className="px-4 py-8 text-center font-sans text-xs text-muted-foreground">No data rows found</td></tr>
            )}
            {preview.rows.map((row, rowIndex) => (
              <tr key={rowIndex} className="hover:bg-white/[0.025]">
                <td className="border-r border-b px-3 py-1.5 text-muted-foreground">{rowIndex + 2}</td>
                {row.map((value, columnIndex) => (
                  <td key={columnIndex} className="max-w-80 truncate border-r border-b px-3 py-1.5">
                    {value === "" ? <span className="italic text-muted-foreground">empty</span> : value}
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

function ImportErrorSummary({ result }: { result: ImportResult }) {
  return (
    <div className="overflow-hidden rounded-lg border border-amber-400/20 bg-amber-400/[0.04]">
      <div className="flex items-center gap-2 border-b border-amber-400/15 px-3 py-2 text-xs text-amber-200">
        <AlertTriangle className="size-3.5" />
        {result.row_count.toLocaleString()} rows imported · {result.error_count.toLocaleString()} skipped
      </div>
      <div className="max-h-40 overflow-auto p-2">
        {result.errors.map((error) => (
          <div key={`${error.row}:${error.message}`} className="grid grid-cols-[54px_minmax(0,1fr)] gap-2 border-b border-white/5 px-1 py-1.5 font-mono text-[10px] last:border-0">
            <span className="text-amber-300">Row {error.row}</span>
            <span className="text-muted-foreground">{error.message}</span>
          </div>
        ))}
        {result.error_count > result.errors.length && (
          <div className="px-1 py-2 text-[10px] text-muted-foreground">
            Showing the first {result.errors.length} rejected rows.
          </div>
        )}
      </div>
    </div>
  )
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
