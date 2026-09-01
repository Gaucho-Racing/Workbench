import { useQuery } from "@tanstack/react-query"
import { Copy, LoaderCircle } from "lucide-react"
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
import { api, getErrorMessage } from "@/lib/api"
import type { CatalogTable, DatabaseTarget } from "@/lib/database"

type DDLDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  target: DatabaseTarget
  databaseName: string
  table: CatalogTable
}

type DDLResponse = {
  ddl: string
}

export function DDLDialog({ open, onOpenChange, target, databaseName, table }: DDLDialogProps) {
  const ddlQuery = useQuery({
    queryKey: ["ddl", target.id, databaseName, table.schema, table.name],
    queryFn: async ({ signal }) => (
      await api.get<DDLResponse>(`/targets/${target.id}/ddl`, {
        params: { database: databaseName, schema: table.schema, relation: table.name },
        signal,
      })
    ).data,
    enabled: open,
    retry: false,
  })

  async function copyDDL() {
    if (!ddlQuery.data?.ddl) return
    try {
      await navigator.clipboard.writeText(ddlQuery.data.ddl)
      toast.success("DDL copied")
    } catch {
      toast.error("Could not access the clipboard")
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[min(680px,calc(100vh-2rem))] max-w-4xl grid-rows-[auto_minmax(0,1fr)_auto]">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm">{table.schema}.{table.name}</DialogTitle>
          <DialogDescription>
            Reconstructed {relationLabel(table.kind)} definition from {target.name} / {databaseName}.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 overflow-hidden rounded-lg border bg-[#0b0a0e] shadow-inner shadow-black/25">
          {ddlQuery.isPending || ddlQuery.isFetching ? (
            <div className="grid h-full place-items-center text-xs text-muted-foreground">
              <div className="flex items-center gap-2"><LoaderCircle className="size-3.5 animate-spin" /> Loading DDL…</div>
            </div>
          ) : ddlQuery.isError ? (
            <div className="grid h-full place-items-center p-6 text-center">
              <div>
                <p className="max-w-xl text-xs text-destructive">{getErrorMessage(ddlQuery.error)}</p>
                <Button className="mt-3" variant="secondary" size="sm" onClick={() => void ddlQuery.refetch()}>Try again</Button>
              </div>
            </div>
          ) : (
            <pre className="h-full overflow-auto p-4 font-mono text-[11px] leading-5 text-[#d7d3dc]">{ddlQuery.data?.ddl}</pre>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Close</Button>
          <Button disabled={!ddlQuery.data?.ddl} onClick={() => void copyDDL()}><Copy /> Copy DDL</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function relationLabel(kind: string) {
  if (kind === "materialized_view") return "materialized view"
  if (kind === "partitioned_table") return "partitioned table"
  return kind
}
