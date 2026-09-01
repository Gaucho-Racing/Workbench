import Editor, { type OnMount } from "@monaco-editor/react"
import { useQueryClient } from "@tanstack/react-query"
import type { languages } from "monaco-editor"
import {
  ChevronDown,
  ChevronRight,
  CircleStop,
  Clock3,
  Columns3,
  Database,
  DatabaseZap,
  GitFork,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Plus,
  RefreshCw,
  Search,
  Server,
  Table2,
  Trash2,
  X,
} from "lucide-react"
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"

import { ConfirmationDialog } from "@/components/ConfirmationDialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { api, getErrorMessage } from "@/lib/api"
import { useAuth } from "@/lib/auth"
import {
  type CatalogTable,
  type DatabaseTarget,
  type QueryResult,
  type QueryRun,
  type ServerDatabase,
  useCatalog,
  useDatabases,
  useQueryHistory,
  useTargets,
} from "@/lib/database"
import { cn } from "@/lib/utils"

const initialStatement = `select
  current_database() as database,
  current_user as user,
  now() as connected_at;`

const SchemaDiagram = lazy(() =>
  import("@/components/SchemaDiagram").then((module) => ({ default: module.SchemaDiagram })),
)
const ConnectionDialog = lazy(() =>
  import("@/components/ConnectionDialog").then((module) => ({ default: module.ConnectionDialog })),
)

export default function WorkbenchPage() {
  const queryClient = useQueryClient()
  const { user, logout } = useAuth()
  const targetsQuery = useTargets()
  const [selectedTargetID, setSelectedTargetID] = useState<string | null>(null)
  const [databaseSelection, setDatabaseSelection] = useState<{ targetID: string; databaseName: string } | null>(null)
  const [statement, setStatement] = useState(initialStatement)
  const [result, setResult] = useState<QueryResult | null>(null)
  const [queryError, setQueryError] = useState("")
  const [running, setRunning] = useState(false)
  const [connectionDialogOpen, setConnectionDialogOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [bottomTab, setBottomTab] = useState<"results" | "history">("results")
  const [filter, setFilter] = useState("")
  const [workspaceView, setWorkspaceView] = useState<"query" | "diagram">("query")
  const [targetPendingDeletion, setTargetPendingDeletion] = useState<DatabaseTarget | null>(null)
  const [deletingTarget, setDeletingTarget] = useState(false)
  const abortController = useRef<AbortController | null>(null)

  const targets = useMemo(() => targetsQuery.data ?? [], [targetsQuery.data])
  const activeTargetID = selectedTargetID && targets.some((target) => target.id === selectedTargetID)
    ? selectedTargetID
    : targets[0]?.id ?? null
  const selectedTarget = targets.find((target) => target.id === activeTargetID) ?? null
  const databasesQuery = useDatabases(activeTargetID)
  const databases = useMemo(() => {
    const discovered = databasesQuery.data ?? []
    if (!selectedTarget || discovered.some((database) => database.name === selectedTarget.database_name)) return discovered
    return [{ name: selectedTarget.database_name }, ...discovered]
  }, [databasesQuery.data, selectedTarget])
  const activeDatabaseName = databaseSelection?.targetID === activeTargetID &&
    databases.some((database) => database.name === databaseSelection.databaseName)
    ? databaseSelection.databaseName
    : selectedTarget?.database_name ?? null
  const catalogQuery = useCatalog(activeTargetID, activeDatabaseName)
  const historyQuery = useQueryHistory()

  const execute = useCallback(async () => {
    if (!activeTargetID || !statement.trim() || running) return
    const controller = new AbortController()
    abortController.current = controller
    setRunning(true)
    setQueryError("")
    setBottomTab("results")
    try {
      const response = await api.post<QueryResult>(
        "/queries",
        { target_id: activeTargetID, database_name: activeDatabaseName, statement },
        { signal: controller.signal },
      )
      setResult(response.data)
      await queryClient.invalidateQueries({ queryKey: ["queryHistory"] })
    } catch (error) {
      if (!controller.signal.aborted) setQueryError(getErrorMessage(error))
    } finally {
      abortController.current = null
      setRunning(false)
    }
  }, [activeDatabaseName, activeTargetID, queryClient, running, statement])

  const executeRef = useRef(execute)
  const catalogRef = useRef<CatalogTable[]>([])
  const completionDisposable = useRef<{ dispose: () => void } | null>(null)

  useEffect(() => {
    executeRef.current = execute
  }, [execute])

  useEffect(() => {
    catalogRef.current = catalogQuery.data?.tables ?? []
  }, [catalogQuery.data])

  useEffect(() => () => completionDisposable.current?.dispose(), [])

  const mountEditor: OnMount = (editor, monaco) => {
    editor.addAction({
      id: "workbench.execute-query",
      label: "Execute query",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      run: () => executeRef.current(),
    })
    const completionProvider: languages.CompletionItemProvider = {
      provideCompletionItems(model, position) {
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: model.getWordUntilPosition(position).startColumn,
          endColumn: position.column,
        }
        const suggestions = catalogRef.current.flatMap((table) => [
          {
            label: `${table.schema}.${table.name}`,
            insertText: `"${table.schema}"."${table.name}"`,
            kind: monaco.languages.CompletionItemKind.Struct,
            detail: table.kind,
            range,
          },
          ...table.columns.map((column) => ({
            label: column.name,
            insertText: `"${column.name}"`,
            kind: monaco.languages.CompletionItemKind.Field,
            detail: `${table.name} · ${column.data_type}`,
            range,
          })),
        ])
        return { suggestions }
      },
    }
    completionDisposable.current?.dispose()
    completionDisposable.current = monaco.languages.registerCompletionItemProvider("pgsql", completionProvider)
  }

  async function deleteTarget(target: DatabaseTarget) {
    setDeletingTarget(true)
    try {
      await api.delete(`/targets/${target.id}`)
      await queryClient.invalidateQueries({ queryKey: ["targets"] })
      setTargetPendingDeletion(null)
      toast.success(`${target.name} removed`)
    } catch (error) {
      toast.error(getErrorMessage(error))
    } finally {
      setDeletingTarget(false)
    }
  }

  function openTable(table: CatalogTable) {
    setStatement(`select *\nfrom "${table.schema}"."${table.name}"\nlimit 100;`)
  }

  function selectDatabase(targetID: string, databaseName: string) {
    setSelectedTargetID(targetID)
    setDatabaseSelection({ targetID, databaseName })
    setResult(null)
    setQueryError("")
  }

  return (
    <div className="grid h-full grid-rows-[46px_minmax(0,1fr)] bg-background">
      <header className="flex items-center gap-3 border-b bg-[#0f0e13] px-2.5 shadow-[inset_0_-1px_0_rgba(225,5,163,0.06)]">
        <Button variant="ghost" size="icon-sm" className="lg:hidden" onClick={() => setSidebarOpen(!sidebarOpen)}>
          <Menu />
          <span className="sr-only">Toggle connections</span>
        </Button>
        <div className="flex items-center gap-2 pr-3">
          <div className="grid size-7 place-items-center rounded-md bg-gradient-to-br from-gr-purple to-gr-pink shadow-sm shadow-gr-purple/20">
            <DatabaseZap className="size-4 text-white" />
          </div>
          <span className="font-brand text-sm font-semibold tracking-tight">Workbench</span>
        </div>
        <div className="h-5 w-px bg-border" />
        <div className="flex items-center gap-2 text-xs">
          <span className={cn("size-1.5 rounded-full", selectedTarget ? "bg-emerald-400" : "bg-muted-foreground")} />
          <span className="whitespace-nowrap font-medium">{selectedTarget?.name ?? "No connection"}</span>
          {selectedTarget && <EnvironmentBadge environment={selectedTarget.environment} />}
          {selectedTarget && activeDatabaseName && (
            <>
              <span className="text-muted-foreground/50">/</span>
              <span className="flex items-center gap-1.5 whitespace-nowrap font-mono text-[11px] text-muted-foreground">
                <Database className="size-3.5 text-gr-pink" />
                {activeDatabaseName}
              </span>
            </>
          )}
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          {running ? (
            <Button variant="destructive" size="sm" onClick={() => abortController.current?.abort()}>
              <CircleStop /> Stop
            </Button>
          ) : (
            <Button size="sm" disabled={!selectedTarget || !statement.trim()} onClick={() => void execute()}>
              <Play className="fill-current" /> Run
              <kbd className="ml-1 hidden rounded bg-black/20 px-1 font-mono text-[10px] sm:inline">⌘↵</kbd>
            </Button>
          )}
          <div className="mx-1 h-5 w-px bg-border" />
          <div className="hidden items-center gap-2 px-1 sm:flex">
            {user?.avatar_url ? (
              <img className="size-6 rounded-full" src={user.avatar_url} alt="" />
            ) : (
              <div className="grid size-6 place-items-center rounded-full bg-secondary text-[10px] font-semibold">
                {(user?.first_name?.[0] ?? user?.username?.[0] ?? "W").toUpperCase()}
              </div>
            )}
            <span className="max-w-28 truncate text-xs text-muted-foreground">{user?.first_name || user?.username}</span>
          </div>
          <Button variant="ghost" size="icon-sm" onClick={logout}>
            <LogOut />
            <span className="sr-only">Sign out</span>
          </Button>
        </div>
      </header>

      <div className={cn("grid min-h-0", sidebarOpen ? "grid-cols-[280px_minmax(0,1fr)]" : "grid-cols-[minmax(0,1fr)]")}>
        {sidebarOpen && (
          <aside className="absolute inset-y-[46px] left-0 z-20 flex w-[280px] flex-col border-r bg-[#0f0e13] lg:static lg:inset-auto lg:z-auto">
            <div className="flex h-10 items-center border-b px-2.5">
              <span className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">Explorer</span>
              <div className="ml-auto flex gap-0.5">
                <Button variant="ghost" size="icon-sm" onClick={() => setConnectionDialogOpen(true)}>
                  <Plus />
                  <span className="sr-only">New connection</span>
                </Button>
                <Button variant="ghost" size="icon-sm" onClick={() => void Promise.all([databasesQuery.refetch(), catalogQuery.refetch()])} disabled={!activeTargetID}>
                  <RefreshCw className={cn((databasesQuery.isFetching || catalogQuery.isFetching) && "animate-spin")} />
                  <span className="sr-only">Refresh catalog</span>
                </Button>
                <Button variant="ghost" size="icon-sm" className="hidden lg:inline-flex" onClick={() => setSidebarOpen(false)}>
                  <PanelLeftClose />
                  <span className="sr-only">Hide explorer</span>
                </Button>
                <Button variant="ghost" size="icon-sm" className="lg:hidden" onClick={() => setSidebarOpen(false)}>
                  <X />
                  <span className="sr-only">Close explorer</span>
                </Button>
              </div>
            </div>
            <div className="border-b p-2">
              <div className="relative">
                <Search className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input className="h-7 pl-7 text-xs" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter database objects" />
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto py-1.5">
              {targetsQuery.isLoading && <SidebarMessage>Loading connections…</SidebarMessage>}
              {!targetsQuery.isLoading && targets.length === 0 && (
                <div className="px-4 py-10 text-center">
                  <Database className="mx-auto mb-3 size-5 text-muted-foreground" />
                  <p className="text-xs font-medium">No connections yet</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">Connect a PostgreSQL database to start exploring.</p>
                  <Button className="mt-4" size="sm" onClick={() => setConnectionDialogOpen(true)}>
                    <Plus /> Connect database
                  </Button>
                </div>
              )}
              {targets.map((target) => (
                <TargetTree
                  key={target.id}
                  target={target}
                  selected={target.id === activeTargetID}
                  databases={target.id === activeTargetID ? databases : []}
                  databasesLoading={target.id === activeTargetID && databasesQuery.isLoading}
                  activeDatabaseName={target.id === activeTargetID ? activeDatabaseName : null}
                  catalog={target.id === activeTargetID ? catalogQuery.data?.tables ?? [] : []}
                  catalogLoading={target.id === activeTargetID && catalogQuery.isLoading}
                  filter={filter}
                  onSelect={() => setSelectedTargetID(target.id)}
                  onSelectDatabase={(databaseName) => selectDatabase(target.id, databaseName)}
                  onOpenTable={openTable}
                  onDelete={() => setTargetPendingDeletion(target)}
                />
              ))}
            </div>
          </aside>
        )}

        <main className="relative grid min-h-0 grid-rows-[minmax(220px,58%)_minmax(180px,42%)] overflow-hidden">
          {!sidebarOpen && (
            <Button variant="ghost" size="icon-sm" className="absolute top-2 left-2 z-10" onClick={() => setSidebarOpen(true)}>
              <PanelLeftOpen />
              <span className="sr-only">Show explorer</span>
            </Button>
          )}
          <section className="min-h-0 border-b bg-[#0d0c11] pt-1">
            <div className="flex h-8 items-center border-b px-3 text-xs">
              <button className={cn("flex h-full items-center gap-1.5 border-b-2 px-3 font-mono text-[11px]", workspaceView === "query" ? "border-gr-pink text-foreground" : "border-transparent text-muted-foreground")} onClick={() => setWorkspaceView("query")}>query.sql</button>
              <button className={cn("flex h-full items-center gap-1.5 border-b-2 px-3 text-[11px]", workspaceView === "diagram" ? "border-gr-pink text-foreground" : "border-transparent text-muted-foreground")} onClick={() => setWorkspaceView("diagram")}><GitFork className="size-3" /> Diagram</button>
              <span className="ml-2 text-muted-foreground">{activeDatabaseName ?? "disconnected"}</span>
            </div>
            <div className="h-[calc(100%-2rem)]">
              {workspaceView === "query" ? (
                <Editor
                  language="pgsql"
                  theme="vs-dark"
                  value={statement}
                  onChange={(value) => setStatement(value ?? "")}
                  onMount={mountEditor}
                  options={{
                    automaticLayout: true,
                    fontFamily: "Geist Mono Variable, SFMono-Regular, monospace",
                    fontSize: 13,
                    lineHeight: 21,
                    minimap: { enabled: false },
                    padding: { top: 14 },
                    renderLineHighlight: "gutter",
                    scrollBeyondLastLine: false,
                    smoothScrolling: true,
                    suggest: { showWords: false },
                  }}
                />
              ) : catalogQuery.data ? (
                <Suspense fallback={<CenteredMessage>Loading schema diagram…</CenteredMessage>}>
                  <SchemaDiagram catalog={catalogQuery.data} />
                </Suspense>
              ) : (
                <CenteredMessage>Load a connection to view its schema</CenteredMessage>
              )}
            </div>
          </section>

          <section className="grid min-h-0 grid-rows-[36px_minmax(0,1fr)] bg-[#0f0e13]">
            <div className="flex items-center border-b px-2">
              <BottomTab active={bottomTab === "results"} onClick={() => setBottomTab("results")}>
                <Columns3 /> Results {result && <span className="text-muted-foreground">{result.row_count}</span>}
              </BottomTab>
              <BottomTab active={bottomTab === "history"} onClick={() => setBottomTab("history")}>
                <Clock3 /> History
              </BottomTab>
              <div className="ml-auto pr-2 text-[11px] text-muted-foreground">
                {result && bottomTab === "results" && `${result.database_name} · ${result.command_tag || "Query"} · ${result.duration_ms} ms`}
              </div>
            </div>
            <div className="min-h-0 overflow-auto">
              {bottomTab === "results" ? (
                <ResultsPanel result={result} error={queryError} running={running} />
              ) : (
                <HistoryPanel
                  runs={historyQuery.data ?? []}
                  loading={historyQuery.isLoading}
                  onSelect={(run) => {
                    setSelectedTargetID(run.target_id)
                    setDatabaseSelection({ targetID: run.target_id, databaseName: run.database_name })
                    setStatement(run.statement)
                    setBottomTab("results")
                  }}
                />
              )}
            </div>
          </section>
        </main>
      </div>

      {connectionDialogOpen && (
        <Suspense fallback={null}>
          <ConnectionDialog
            open
            onOpenChange={setConnectionDialogOpen}
            onCreated={(target) => setSelectedTargetID(target.id)}
          />
        </Suspense>
      )}
      <ConfirmationDialog
        open={targetPendingDeletion !== null}
        title="Remove database connection?"
        description={targetPendingDeletion
          ? `Workbench will forget ${targetPendingDeletion.name} and its saved credentials. Existing query history will remain available.`
          : ""}
        confirmLabel="Remove connection"
        pending={deletingTarget}
        onOpenChange={(open) => !open && setTargetPendingDeletion(null)}
        onConfirm={() => targetPendingDeletion && void deleteTarget(targetPendingDeletion)}
      />
    </div>
  )
}

function TargetTree({
  target,
  selected,
  databases,
  databasesLoading,
  activeDatabaseName,
  catalog,
  catalogLoading,
  filter,
  onSelect,
  onSelectDatabase,
  onOpenTable,
  onDelete,
}: {
  target: DatabaseTarget
  selected: boolean
  databases: ServerDatabase[]
  databasesLoading: boolean
  activeDatabaseName: string | null
  catalog: CatalogTable[]
  catalogLoading: boolean
  filter: string
  onSelect: () => void
  onSelectDatabase: (databaseName: string) => void
  onOpenTable: (table: CatalogTable) => void
  onDelete: () => void
}) {
  const [expanded, setExpanded] = useState(true)
  const schemas = useMemo(() => {
    const normalizedFilter = filter.trim().toLowerCase()
    const filtered = catalog.filter((table) => `${table.schema}.${table.name}`.toLowerCase().includes(normalizedFilter))
    const grouped = new Map<string, CatalogTable[]>()
    for (const table of filtered) {
      const tables = grouped.get(table.schema) ?? []
      tables.push(table)
      grouped.set(table.schema, tables)
    }
    return grouped
  }, [catalog, filter])

  return (
    <div>
      <div
        className={cn("group flex h-8 items-center gap-1.5 border-l-2 px-2 text-xs", selected ? "border-gr-pink bg-gr-purple/10 text-foreground" : "border-transparent text-muted-foreground hover:bg-muted/50")}
      >
        <button className="grid size-5 place-items-center" onClick={() => { setExpanded(!expanded); if (!selected) onSelect() }}>
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
        <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={onSelect}>
          <Server className={cn("size-3.5", selected && "text-gr-purple")} />
          <span className="truncate font-medium" title={target.name}>{target.name}</span>
          <EnvironmentBadge environment={target.environment} />
        </button>
        <Button variant="ghost" size="icon-sm" className="opacity-0 group-hover:opacity-100" onClick={onDelete}>
          <Trash2 />
          <span className="sr-only">Remove connection</span>
        </Button>
      </div>
      {selected && expanded && (
        <div className="pb-1">
          {databasesLoading && <SidebarMessage>Discovering databases…</SidebarMessage>}
          {databases.map((database) => {
            const active = database.name === activeDatabaseName
            return (
              <div key={database.name}>
                <button
                  className={cn("flex h-8 w-full items-center gap-1.5 pr-2 pl-6 text-xs text-muted-foreground hover:bg-muted/40 hover:text-foreground", active && "text-foreground")}
                  onClick={() => onSelectDatabase(database.name)}
                >
                  {active ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                  <Database className={cn("size-3.5", active && "text-gr-pink")} />
                  <span className="truncate font-mono text-[11px]" title={database.name}>{database.name}</span>
                </button>
                {active && (
                  <div className="pl-10">
                    {catalogLoading && <SidebarMessage>Loading objects…</SidebarMessage>}
                    {!catalogLoading && Array.from(schemas.entries()).map(([schema, tables]) => (
                      <SchemaTree key={schema} schema={schema} tables={tables} onOpenTable={onOpenTable} />
                    ))}
                    {!catalogLoading && catalog.length === 0 && <SidebarMessage>No objects found</SidebarMessage>}
                  </div>
                )}
              </div>
            )
          })}
          {!databasesLoading && databases.length === 0 && <SidebarMessage>No databases available</SidebarMessage>}
        </div>
      )}
    </div>
  )
}

function SchemaTree({ schema, tables, onOpenTable }: { schema: string; tables: CatalogTable[]; onOpenTable: (table: CatalogTable) => void }) {
  const [expanded, setExpanded] = useState(true)
  return (
    <div>
      <button className="flex h-7 w-full items-center gap-1.5 px-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => setExpanded(!expanded)}>
        {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        <span className="font-mono text-[11px]">{schema}</span>
      </button>
      {expanded &&
        tables.map((table) => (
          <button key={table.name} className="flex h-7 w-full items-center gap-2 pl-6 pr-2 text-xs text-muted-foreground hover:bg-muted/40 hover:text-foreground" onDoubleClick={() => onOpenTable(table)} onClick={() => onOpenTable(table)}>
            <Table2 className="size-3.5" />
            <span className="truncate">{table.name}</span>
          </button>
        ))}
    </div>
  )
}

function ResultsPanel({ result, error, running }: { result: QueryResult | null; error: string; running: boolean }) {
  if (running) return <CenteredMessage>Running query…</CenteredMessage>
  if (error) return <div className="m-4 rounded-md border border-destructive/30 bg-destructive/10 p-3 font-mono text-xs text-destructive">{error}</div>
  if (!result) return <CenteredMessage>Run a query to see results</CenteredMessage>
  if (result.columns.length === 0) {
    return <CenteredMessage>{result.command_tag || "Statement completed"} · {result.row_count} affected rows</CenteredMessage>
  }
  return (
    <table className="w-max min-w-full border-collapse font-mono text-[11px]">
      <thead className="sticky top-0 z-10 bg-[#17151d] text-left text-muted-foreground">
        <tr>
          <th className="w-10 border-r border-b px-2 py-1.5 text-right font-normal">#</th>
          {result.columns.map((column, index) => (
            <th key={`${column.name}-${index}`} className="min-w-32 border-r border-b px-3 py-1.5 font-medium text-foreground">
              {column.name}
              <span className="ml-2 font-normal text-muted-foreground">oid:{column.data_type_oid}</span>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {result.rows.map((row, rowIndex) => (
          <tr key={rowIndex} className="hover:bg-white/[0.025]">
            <td className="border-r border-b px-2 py-1 text-right text-muted-foreground">{rowIndex + 1}</td>
            {row.map((value, columnIndex) => (
              <td key={columnIndex} className="max-w-96 truncate border-r border-b px-3 py-1.5" title={value === null ? "NULL" : String(value)}>
                {value === null ? <span className="italic text-muted-foreground">NULL</span> : String(value)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function HistoryPanel({ runs, loading, onSelect }: { runs: QueryRun[]; loading: boolean; onSelect: (run: QueryRun) => void }) {
  if (loading) return <CenteredMessage>Loading query history…</CenteredMessage>
  if (runs.length === 0) return <CenteredMessage>No query history yet</CenteredMessage>
  return (
    <div className="divide-y divide-border">
      {runs.map((run) => (
        <button key={run.id} className="grid w-full grid-cols-[120px_1fr_auto] items-center gap-3 px-3 py-2 text-left text-xs hover:bg-muted/35" onClick={() => onSelect(run)}>
          <div>
            <div className="font-medium">{run.target_name} <span className="font-mono font-normal text-muted-foreground">/ {run.database_name}</span></div>
            <div className="mt-0.5 text-[10px] text-muted-foreground">{new Date(run.created_at).toLocaleString()}</div>
          </div>
          <code className="truncate text-[11px] text-muted-foreground">{run.statement.replace(/\s+/g, " ")}</code>
          <div className="text-right">
            <div className={cn("text-[10px] font-semibold", run.status === "SUCCEEDED" ? "text-emerald-400" : "text-destructive")}>{run.status}</div>
            <div className="mt-0.5 text-[10px] text-muted-foreground">{run.duration_ms} ms</div>
          </div>
        </button>
      ))}
    </div>
  )
}

function BottomTab({ active, children, onClick }: { active: boolean; children: React.ReactNode; onClick: () => void }) {
  return (
    <button className={cn("flex h-full items-center gap-1.5 border-b-2 px-3 text-xs", active ? "border-gr-pink text-foreground" : "border-transparent text-muted-foreground hover:text-foreground", "[&_svg]:size-3.5")} onClick={onClick}>
      {children}
    </button>
  )
}

function EnvironmentBadge({ environment }: { environment: string }) {
  return (
    <span className={cn("rounded px-1.5 py-0.5 font-mono text-[9px] font-semibold", environment === "PROD" ? "bg-destructive/15 text-destructive" : environment === "STAGING" ? "bg-amber-400/10 text-amber-300" : "bg-emerald-400/10 text-emerald-300")}>
      {environment}
    </span>
  )
}

function SidebarMessage({ children }: { children: React.ReactNode }) {
  return <div className="px-3 py-4 text-center text-[11px] text-muted-foreground">{children}</div>
}

function CenteredMessage({ children }: { children: React.ReactNode }) {
  return <div className="grid h-full place-items-center text-xs text-muted-foreground">{children}</div>
}
