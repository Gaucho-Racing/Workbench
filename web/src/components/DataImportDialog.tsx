import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  FileSpreadsheet,
  LoaderCircle,
  Sparkles,
  Table2,
  Upload,
  XCircle,
} from "lucide-react"
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
  onImported: (imports: CompletedImport[]) => void
}

export type ImportResult = {
  transfer_id: string
  row_count: number
  error_count: number
  errors: ImportRowError[]
}

export type CompletedImport = {
  fileName: string
  table: CatalogTable
  result: ImportResult
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
type DetectionMethod = "filename" | "columns" | "manual" | "none"

type ImportFileItem = {
  id: string
  file: File
  header: string[]
  tableKey: string
  detection: DetectionMethod
  setupError: string
  preview: ImportPreview | null
  previewError: string
  result: ImportResult | null
  importError: string
}

const maxFileBytes = 50 * 1024 * 1024
const maxImportFiles = 50
const headerSampleBytes = 256 * 1024

function catalogTableKey(table: Pick<CatalogTable, "schema" | "name">) {
  return JSON.stringify([table.schema, table.name])
}

export function DataImportDialog({ open, onOpenChange, target, databaseName, tables, onImported }: DataImportDialogProps) {
  const writableTables = useMemo(
    () => tables.filter((table) => table.kind === "table" || table.kind === "partitioned_table"),
    [tables],
  )
  const tableByKey = useMemo(
    () => new Map(writableTables.map((table) => [catalogTableKey(table), table])),
    [writableTables],
  )
  const [items, setItems] = useState<ImportFileItem[]>([])
  const [activeItemID, setActiveItemID] = useState("")
  const [fileError, setFileError] = useState("")
  const [errorPolicy, setErrorPolicy] = useState<ImportErrorPolicy>("abort")
  const [dragging, setDragging] = useState(false)
  const [detecting, setDetecting] = useState(false)
  const [previewingItemID, setPreviewingItemID] = useState("")
  const [previewingAll, setPreviewingAll] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importFinished, setImportFinished] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const activeItem = items.find((item) => item.id === activeItemID) ?? items[0] ?? null
  const activeTable = activeItem ? tableByKey.get(activeItem.tableKey) ?? null : null
  const mappedCount = items.filter((item) => tableByKey.has(item.tableKey)).length
  const previewedCount = items.filter((item) => item.preview && !item.previewError).length
  const readyToImport = items.length > 0 && items.every((item) => (
    tableByKey.has(item.tableKey) && item.preview !== null && !item.previewError && !item.setupError
  ))

  function resetTransferState() {
    setImportFinished(false)
    setPreviewingItemID("")
    setPreviewingAll(false)
    setImporting(false)
  }

  async function chooseFiles(fileList: FileList | File[]) {
    const files = Array.from(fileList)
    if (files.length === 0) return
    if (files.length > maxImportFiles) {
      setFileError(`Choose no more than ${maxImportFiles} CSV files at once`)
      return
    }
    const invalidExtension = files.find((file) => !file.name.toLowerCase().endsWith(".csv"))
    if (invalidExtension) {
      setFileError(`${invalidExtension.name} is not a CSV file`)
      return
    }
    const oversized = files.find((file) => file.size > maxFileBytes)
    if (oversized) {
      setFileError(`${oversized.name} exceeds the 50 MB per-file limit`)
      return
    }

    setDetecting(true)
    setFileError("")
    resetTransferState()
    const detectedItems = await Promise.all(files.map(async (file, index) => {
      const id = `${file.name}:${file.size}:${file.lastModified}:${index}`
      try {
        const header = await readCSVHeader(file)
        const detection = detectTargetTable(file.name, header, writableTables)
        return newImportFileItem(id, file, header, detection.tableKey, detection.method, "")
      } catch (error) {
        return newImportFileItem(id, file, [], "", "none", getErrorMessage(error))
      }
    }))
    setItems(detectedItems)
    setActiveItemID(detectedItems[0]?.id ?? "")
    setDetecting(false)
  }

  function dropFiles(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setDragging(false)
    if (detecting || previewingAll || importing) return
    void chooseFiles(event.dataTransfer.files)
  }

  function updateItemTable(itemID: string, nextTableKey: string) {
    setItems((current) => current.map((item) => item.id === itemID
      ? {
          ...item,
          tableKey: nextTableKey,
          detection: "manual",
          preview: null,
          previewError: "",
          result: null,
          importError: "",
        }
      : item))
    setImportFinished(false)
  }

  async function requestPreview(item: ImportFileItem) {
    const table = tableByKey.get(item.tableKey)
    if (!table) throw new Error("Choose a destination table")
    if (item.setupError) throw new Error(item.setupError)
    const body = importFormData(item.file, table, databaseName, null)
    return (await api.post<ImportPreview>(`/targets/${target.id}/imports/preview`, body)).data
  }

  async function previewItem(item: ImportFileItem) {
    if (previewingItemID || previewingAll || importing) return
    setPreviewingItemID(item.id)
    setItems((current) => current.map((entry) => entry.id === item.id
      ? { ...entry, previewError: "", preview: null, result: null, importError: "" }
      : entry))
    try {
      const preview = await requestPreview(item)
      setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, preview } : entry))
    } catch (error) {
      setItems((current) => current.map((entry) => entry.id === item.id
        ? { ...entry, previewError: getErrorMessage(error) }
        : entry))
    } finally {
      setPreviewingItemID("")
    }
  }

  async function previewAll() {
    if (previewingItemID || previewingAll || importing || items.length === 0) return
    setPreviewingAll(true)
    setImportFinished(false)
    for (const item of items) {
      setPreviewingItemID(item.id)
      setItems((current) => current.map((entry) => entry.id === item.id
        ? { ...entry, previewError: "", preview: null, result: null, importError: "" }
        : entry))
      try {
        const preview = await requestPreview(item)
        setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, preview } : entry))
      } catch (error) {
        setItems((current) => current.map((entry) => entry.id === item.id
          ? { ...entry, previewError: getErrorMessage(error) }
          : entry))
      }
    }
    setPreviewingItemID("")
    setPreviewingAll(false)
  }

  async function importAll() {
    if (!readyToImport || importing) return
    setImporting(true)
    setImportFinished(false)
    const completed: CompletedImport[] = []
    for (const item of items) {
      const table = tableByKey.get(item.tableKey)
      if (!table) break
      setActiveItemID(item.id)
      setItems((current) => current.map((entry) => entry.id === item.id
        ? { ...entry, importError: "", result: null }
        : entry))
      try {
        const body = importFormData(item.file, table, databaseName, errorPolicy)
        const result = (await api.post<ImportResult>(`/targets/${target.id}/imports`, body)).data
        completed.push({ fileName: item.file.name, table, result })
        setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, result } : entry))
      } catch (error) {
        setItems((current) => current.map((entry) => entry.id === item.id
          ? { ...entry, importError: getErrorMessage(error) }
          : entry))
        break
      }
    }
    if (completed.length > 0) onImported(completed)
    setImporting(false)
    setImportFinished(true)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn(
        "max-w-6xl",
        items.length > 0 && "h-[min(800px,calc(100vh-2rem))] grid-rows-[auto_auto_minmax(0,1fr)_auto]",
      )}>
        <DialogHeader>
          <DialogTitle>Import table data</DialogTitle>
          <DialogDescription>
            Upload one or more CSVs to {target.name} / {databaseName}. Workbench detects target tables before anything is written.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_230px]">
          <div
            className={cn(
              "grid min-h-24 place-items-center rounded-lg border border-dashed px-4 py-3 text-center transition-[border-color,background-color,transform] duration-150 motion-reduce:transition-none",
              dragging ? "scale-[1.01] border-gr-pink/70 bg-gr-pink/5" : "border-white/15 bg-black/15 hover:border-gr-purple/45",
            )}
            onDragEnter={(event) => { event.preventDefault(); setDragging(true) }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={() => setDragging(false)}
            onDrop={dropFiles}
          >
            <input
              ref={fileInputRef}
              className="hidden"
              type="file"
              accept=".csv,text/csv"
              multiple
              disabled={detecting || previewingAll || importing}
              onChange={(event) => {
                if (event.target.files) void chooseFiles(event.target.files)
                event.target.value = ""
              }}
            />
            {detecting ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <LoaderCircle className="size-4 animate-spin text-gr-purple" /> Detecting table mappings…
              </div>
            ) : items.length > 0 ? (
              <div className="flex flex-wrap items-center justify-center gap-3">
                <FileSpreadsheet className="size-5 text-gr-pink" />
                <div className="text-left">
                  <p className="text-xs font-medium">{items.length} CSV file{items.length === 1 ? "" : "s"} ready</p>
                  <p className="text-[10px] text-muted-foreground">{formatFileSize(items.reduce((total, item) => total + item.file.size, 0))} total</p>
                </div>
                <Button variant="ghost" size="sm" disabled={previewingAll || importing} onClick={() => fileInputRef.current?.click()}>
                  Replace files
                </Button>
              </div>
            ) : (
              <div>
                <Upload className="mx-auto size-5 text-gr-purple" />
                <p className="mt-1.5 text-xs font-medium">Drop CSV files here</p>
                <p className="mt-0.5 text-[10px] text-muted-foreground">Up to {maxImportFiles} files · 50 MB each</p>
                <Button className="mt-2" variant="secondary" size="sm" onClick={() => fileInputRef.current?.click()}>
                  Browse files
                </Button>
              </div>
            )}
          </div>

          <label className="grid content-center gap-1.5 text-xs font-medium">
            Row error handling
            <Select value={errorPolicy} onValueChange={(value) => setErrorPolicy(value as ImportErrorPolicy)} disabled={importing || importFinished}>
              <SelectTrigger aria-label="Import error handling">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="abort">Rollback table on error</SelectItem>
                <SelectItem value="continue">Skip invalid rows</SelectItem>
              </SelectContent>
            </Select>
            <span className="font-normal leading-relaxed text-muted-foreground">
              Tables commit independently. A failed table stops the remaining bulk job.
            </span>
          </label>
        </div>

        {fileError && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {fileError}
          </div>
        )}

        {items.length > 0 && (
          <div className="grid min-h-0 overflow-hidden rounded-lg border bg-[#0b0a0e] md:grid-cols-[minmax(240px,0.8fr)_minmax(0,1.7fr)]">
            <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] border-b md:border-r md:border-b-0">
              <div className="flex h-10 items-center border-b bg-gr-purple/5 px-3 text-[11px] text-muted-foreground">
                <Sparkles className="mr-2 size-3.5 text-gr-purple" />
                {mappedCount} of {items.length} targets detected
                <span className="ml-auto">{previewedCount} previewed</span>
              </div>
              <div className="min-h-0 overflow-y-auto p-1.5">
                {items.map((item) => {
                  const table = tableByKey.get(item.tableKey)
                  const active = item.id === activeItem?.id
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={cn(
                        "flex w-full items-start gap-2 rounded-md border px-2.5 py-2 text-left transition-[background-color,border-color] duration-150 motion-reduce:transition-none",
                        active ? "border-gr-pink/25 bg-gr-pink/[0.06]" : "border-transparent hover:bg-white/[0.025]",
                      )}
                      onClick={() => setActiveItemID(item.id)}
                    >
                      <ImportItemStatus item={item} active={active} previewing={previewingItemID === item.id} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium" title={item.file.name}>{item.file.name}</span>
                        <span className={cn("mt-0.5 block truncate font-mono text-[9px]", table ? "text-muted-foreground" : "text-amber-300")}>
                          {table ? `${table.schema}.${table.name}` : "Target required"}
                        </span>
                      </span>
                      <DetectionBadge method={item.detection} />
                    </button>
                  )
                })}
              </div>
            </div>

            {activeItem && (
              <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)]">
                <div className="grid gap-3 border-b px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                  <label className="grid gap-1.5 text-[10px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
                    Destination table
                    <Select
                      value={activeItem.tableKey}
                      onValueChange={(value) => updateItemTable(activeItem.id, value)}
                      disabled={importing || importFinished}
                    >
                      <SelectTrigger aria-label={`Destination table for ${activeItem.file.name}`}>
                        <SelectValue placeholder="Choose a target table" />
                      </SelectTrigger>
                      <SelectContent>
                        {writableTables.map((table) => (
                          <SelectItem key={catalogTableKey(table)} value={catalogTableKey(table)}>
                            {table.schema}.{table.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!activeTable || Boolean(activeItem.setupError) || previewingAll || importing || importFinished}
                    onClick={() => void previewItem(activeItem)}
                  >
                    {previewingItemID === activeItem.id ? <LoaderCircle className="animate-spin" /> : <Eye />}
                    {activeItem.preview ? "Refresh preview" : "Preview file"}
                  </Button>
                </div>

                <div className="min-h-0 overflow-auto p-3">
                  {activeItem.setupError ? (
                    <ImportMessage message={activeItem.setupError} />
                  ) : activeItem.importError ? (
                    <ImportMessage message={activeItem.importError} />
                  ) : activeItem.result ? (
                    <ImportErrorSummary result={activeItem.result} fileName={activeItem.file.name} table={activeTable} />
                  ) : activeItem.previewError ? (
                    <ImportMessage message={activeItem.previewError} />
                  ) : activeItem.preview ? (
                    <ImportPreviewTable preview={activeItem.preview} />
                  ) : (
                    <div className="grid h-full min-h-44 place-items-center text-center">
                      <div>
                        <Table2 className="mx-auto size-5 text-muted-foreground" />
                        <p className="mt-2 text-xs font-medium">{activeTable ? `${activeTable.schema}.${activeTable.name}` : "Choose a destination table"}</p>
                        <p className="mt-1 max-w-sm text-[10px] leading-relaxed text-muted-foreground">
                          {activeTable
                            ? `${activeItem.header.length} CSV columns detected. Preview validates the mapping against PostgreSQL before import.`
                            : "Workbench could not make an unambiguous match from the filename and column header."}
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {importFinished ? (
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          ) : (
            <>
              <Button variant="ghost" disabled={importing} onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button
                variant="secondary"
                disabled={items.length === 0 || mappedCount !== items.length || previewingAll || Boolean(previewingItemID) || importing}
                onClick={() => void previewAll()}
              >
                {previewingAll ? <LoaderCircle className="animate-spin" /> : <Eye />}
                {previewingAll ? "Previewing files…" : `Preview all${items.length > 0 ? ` (${items.length})` : ""}`}
              </Button>
              <Button disabled={!readyToImport || importing || previewingAll} onClick={() => void importAll()}>
                {importing && <LoaderCircle className="animate-spin" />}
                {importing ? "Importing tables…" : `Import ${items.length || ""} table${items.length === 1 ? "" : "s"}`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function newImportFileItem(id: string, file: File, header: string[], tableKey: string, detection: DetectionMethod, setupError: string): ImportFileItem {
  return { id, file, header, tableKey, detection, setupError, preview: null, previewError: "", result: null, importError: "" }
}

function importFormData(file: File, table: CatalogTable, databaseName: string, errorPolicy: ImportErrorPolicy | null) {
  const body = new FormData()
  body.append("database_name", databaseName)
  body.append("schema", table.schema)
  body.append("table", table.name)
  if (errorPolicy) body.append("error_policy", errorPolicy)
  body.append("file", file)
  return body
}

function detectTargetTable(fileName: string, header: string[], tables: CatalogTable[]) {
  const compatibleTables = tables.filter((table) => header.every((column) => table.columns.some((candidate) => candidate.name === column)))
  const nameCandidates = compatibleTables.length > 0 ? compatibleTables : tables
  const stem = normalizedFileStem(fileName)
  const schemaMatches = nameCandidates.filter((table) => stemEndsWith(stem, `${slug(table.schema)}-${slug(table.name)}`))
  if (schemaMatches.length === 1) return { tableKey: catalogTableKey(schemaMatches[0]), method: "filename" as const }
  const tableMatches = nameCandidates.filter((table) => stemEndsWith(stem, slug(table.name)))
  if (tableMatches.length === 1) return { tableKey: catalogTableKey(tableMatches[0]), method: "filename" as const }
  const exactColumnMatches = compatibleTables.filter((table) => table.columns.length === header.length)
  if (exactColumnMatches.length === 1) return { tableKey: catalogTableKey(exactColumnMatches[0]), method: "columns" as const }
  if (compatibleTables.length === 1) return { tableKey: catalogTableKey(compatibleTables[0]), method: "columns" as const }
  return { tableKey: "", method: "none" as const }
}

function normalizedFileStem(fileName: string) {
  return slug(fileName.replace(/\.csv$/i, "")).replace(/-\d{8}-\d{6}$/, "")
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
}

function stemEndsWith(stem: string, suffix: string) {
  return stem === suffix || stem.endsWith(`-${suffix}`)
}

async function readCSVHeader(file: File) {
  const sample = await file.slice(0, headerSampleBytes).text()
  if (sample.length === 0) throw new Error("CSV file is empty")
  const columns: string[] = []
  let value = ""
  let quoted = false
  for (let index = 0; index < sample.length; index += 1) {
    const character = sample[index]
    if (quoted) {
      if (character === '"' && sample[index + 1] === '"') {
        value += '"'
        index += 1
      } else if (character === '"') {
        quoted = false
      } else {
        value += character
      }
      continue
    }
    if (character === '"' && value.length === 0) quoted = true
    else if (character === ",") { columns.push(value); value = "" }
    else if (character === "\n" || character === "\r") { columns.push(value); return normalizeHeader(columns) }
    else value += character
  }
  if (quoted || file.size > sample.length) throw new Error("CSV header exceeds the 256 KB detection limit")
  columns.push(value)
  return normalizeHeader(columns)
}

function normalizeHeader(columns: string[]) {
  if (columns.length === 0) throw new Error("CSV header must contain at least one column")
  columns[0] = columns[0].replace(/^\uFEFF/, "")
  if (columns.some((column) => column.length === 0)) throw new Error("CSV header contains a blank column")
  if (new Set(columns).size !== columns.length) throw new Error("CSV header contains duplicate columns")
  return columns
}

function ImportItemStatus({ item, active, previewing }: { item: ImportFileItem; active: boolean; previewing: boolean }) {
  if (previewing) return <LoaderCircle className="mt-0.5 size-3.5 shrink-0 animate-spin text-gr-purple" />
  if (item.setupError || item.previewError || item.importError) return <XCircle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
  if (item.result) return <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-400" />
  if (item.preview) return <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-gr-purple" />
  return <FileSpreadsheet className={cn("mt-0.5 size-3.5 shrink-0", active ? "text-gr-pink" : "text-muted-foreground")} />
}

function DetectionBadge({ method }: { method: DetectionMethod }) {
  if (method === "none") return null
  const label = method === "filename" ? "NAME" : method === "columns" ? "COLUMNS" : "MANUAL"
  return (
    <span className={cn(
      "mt-0.5 rounded border px-1 py-0.5 font-mono text-[8px]",
      method === "manual" ? "border-white/10 text-muted-foreground" : "border-gr-purple/25 bg-gr-purple/10 text-purple-200",
    )}>
      {label}
    </span>
  )
}

function ImportMessage({ message }: { message: string }) {
  return <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{message}</div>
}

function ImportPreviewTable({ preview }: { preview: ImportPreview }) {
  return (
    <div className="overflow-hidden rounded-lg border bg-[#0b0a0e]">
      <div className="flex items-center gap-2 border-b bg-gr-purple/5 px-3 py-2 text-[11px] text-muted-foreground">
        <CheckCircle2 className="size-3.5 text-emerald-400" />
        <span>Header matches · {preview.row_count.toLocaleString()} data rows</span>
        {preview.truncated && <span className="ml-auto">Showing first {preview.rows.length}</span>}
      </div>
      <div className="max-h-[430px] overflow-auto">
        <table className="w-max min-w-full border-collapse font-mono text-[11px]">
          <thead className="sticky top-0 z-10 bg-[#15131a] text-left">
            <tr>
              <th className="border-r border-b px-3 py-2 font-medium text-muted-foreground">#</th>
              {preview.columns.map((column) => <th key={column} className="border-r border-b px-3 py-2 font-medium whitespace-nowrap">{column}</th>)}
            </tr>
          </thead>
          <tbody>
            {preview.rows.length === 0 && <tr><td colSpan={preview.columns.length + 1} className="px-4 py-8 text-center font-sans text-xs text-muted-foreground">No data rows found</td></tr>}
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

function ImportErrorSummary({ result, fileName, table }: { result: ImportResult; fileName: string; table: CatalogTable | null }) {
  return (
    <div className={cn("overflow-hidden rounded-lg border", result.error_count > 0 ? "border-amber-400/20 bg-amber-400/[0.04]" : "border-emerald-400/20 bg-emerald-400/[0.04]")}>
      <div className={cn("flex items-center gap-2 border-b px-3 py-2 text-xs", result.error_count > 0 ? "border-amber-400/15 text-amber-200" : "border-emerald-400/15 text-emerald-300")}>
        {result.error_count > 0 ? <AlertTriangle className="size-3.5" /> : <CheckCircle2 className="size-3.5" />}
        {fileName} → {table ? `${table.schema}.${table.name}` : "table"}
      </div>
      <div className="px-3 py-2 text-[11px] text-muted-foreground">
        {result.row_count.toLocaleString()} rows imported · {result.error_count.toLocaleString()} skipped
      </div>
      {result.errors.length > 0 && (
        <div className="max-h-40 overflow-auto border-t border-amber-400/10 p-2">
          {result.errors.map((error) => (
            <div key={`${error.row}:${error.message}`} className="grid grid-cols-[54px_minmax(0,1fr)] gap-2 border-b border-white/5 px-1 py-1.5 font-mono text-[10px] last:border-0">
              <span className="text-amber-300">Row {error.row}</span>
              <span className="text-muted-foreground">{error.message}</span>
            </div>
          ))}
          {result.error_count > result.errors.length && <div className="px-1 py-2 text-[10px] text-muted-foreground">Showing the first {result.errors.length} rejected rows.</div>}
        </div>
      )}
    </div>
  )
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
