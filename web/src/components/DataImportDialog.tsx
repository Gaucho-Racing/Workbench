import { useMutation } from "@tanstack/react-query"
import { FileSpreadsheet, Upload } from "lucide-react"
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
  onImported: (rowCount: number, table: CatalogTable) => void
}

type ImportResult = {
  transfer_id: string
  row_count: number
}

const maxFileBytes = 50 * 1024 * 1024

export function DataImportDialog({ open, onOpenChange, target, databaseName, tables, onImported }: DataImportDialogProps) {
  const writableTables = useMemo(
    () => tables.filter((table) => table.kind === "table" || table.kind === "partitioned_table"),
    [tables],
  )
  const [tableIndex, setTableIndex] = useState("0")
  const [file, setFile] = useState<File | null>(null)
  const [fileError, setFileError] = useState("")
  const [dragging, setDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const selectedTable = writableTables[Number(tableIndex)]
  const mutation = useMutation({
    mutationFn: async () => {
      if (!file || !selectedTable) throw new Error("Choose a destination table and CSV file")
      const body = new FormData()
      body.append("database_name", databaseName)
      body.append("schema", selectedTable.schema)
      body.append("table", selectedTable.name)
      body.append("file", file)
      return (await api.post<ImportResult>(`/targets/${target.id}/imports`, body)).data
    },
    onSuccess: (result) => {
      if (!selectedTable) return
      onOpenChange(false)
      onImported(result.row_count, selectedTable)
    },
  })

  function chooseFile(nextFile?: File) {
    if (!nextFile) return
    if (nextFile.size > maxFileBytes) {
      setFile(null)
      setFileError("CSV files must be 50 MB or smaller")
      return
    }
    if (!nextFile.name.toLowerCase().endsWith(".csv")) {
      setFile(null)
      setFileError("Choose a .csv file")
      return
    }
    setFile(nextFile)
    setFileError("")
    mutation.reset()
  }

  function dropFile(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setDragging(false)
    chooseFile(event.dataTransfer.files[0])
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import CSV data</DialogTitle>
          <DialogDescription>
            Append rows to an existing table in {target.name} / {databaseName}. The entire import commits atomically.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <label className="grid gap-1.5 text-xs font-medium">
            Destination table
            <Select value={tableIndex} onValueChange={setTableIndex} disabled={writableTables.length === 0}>
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

          <div
            className={cn(
              "grid min-h-36 place-items-center rounded-lg border border-dashed px-5 py-6 text-center transition-[border-color,background-color,transform] duration-150 motion-reduce:transition-none",
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
              onChange={(event) => chooseFile(event.target.files?.[0])}
            />
            {file ? (
              <div>
                <FileSpreadsheet className="mx-auto size-7 text-gr-pink" />
                <p className="mt-2 max-w-72 truncate text-sm font-medium">{file.name}</p>
                <p className="mt-1 text-xs text-muted-foreground">{formatFileSize(file.size)}</p>
                <Button className="mt-3" variant="ghost" size="sm" onClick={() => fileInputRef.current?.click()}>
                  Choose another file
                </Button>
              </div>
            ) : (
              <div>
                <Upload className="mx-auto size-7 text-gr-purple" />
                <p className="mt-2 text-sm font-medium">Drop a CSV here</p>
                <p className="mt-1 text-xs text-muted-foreground">Header names must match destination columns · 50 MB max</p>
                <Button className="mt-3" variant="secondary" size="sm" onClick={() => fileInputRef.current?.click()}>
                  Browse files
                </Button>
              </div>
            )}
          </div>

          {(fileError || mutation.isError) && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {fileError || getErrorMessage(mutation.error)}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!file || !selectedTable || mutation.isPending} onClick={() => mutation.mutate()}>
            {mutation.isPending ? "Importing…" : "Import rows"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
