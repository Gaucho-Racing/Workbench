import Editor, { type OnMount } from "@monaco-editor/react"
import { useQueryClient } from "@tanstack/react-query"
import type { editor, languages } from "monaco-editor"
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
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
  Pencil,
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
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react"
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
import { statementForEditor } from "@/lib/sql"

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
  const { user, isAdmin, logout } = useAuth()
  const targetsQuery = useTargets()
  const [selectedTargetID, setSelectedTargetID] = useState<string | null>(null)
  const [databaseSelection, setDatabaseSelection] = useState<{ targetID: string; databaseName: string } | null>(null)
  const [statement, setStatement] = useState(initialStatement)
  const [result, setResult] = useState<QueryResult | null>(null)
  const [queryError, setQueryError] = useState("")
  const [running, setRunning] = useState(false)
  const [connectionDialogOpen, setConnectionDialogOpen] = useState(false)
  const [connectionTarget, setConnectionTarget] = useState<DatabaseTarget | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [bottomTab, setBottomTab] = useState<"results" | "history">("results")
  const [bottomPaneCollapsed, setBottomPaneCollapsed] = useState(false)
  const [bottomPaneRatio, setBottomPaneRatio] = useState(0.42)
  const [bottomPaneResizing, setBottomPaneResizing] = useState(false)
  const [filter, setFilter] = useState("")
  const [workspaceView, setWorkspaceView] = useState<"query" | "diagram">("query")
  const [targetPendingDeletion, setTargetPendingDeletion] = useState<DatabaseTarget | null>(null)
  const [deletingTarget, setDeletingTarget] = useState(false)
  const abortController = useRef<AbortController | null>(null)
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const workspaceRef = useRef<HTMLElement | null>(null)
  const bottomPaneResizingRef = useRef(false)

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
    const executableStatement = statementForEditor(editorRef.current, statement)
    if (!executableStatement) return
    const controller = new AbortController()
    abortController.current = controller
    setRunning(true)
    setQueryError("")
    setBottomTab("results")
    try {
      const response = await api.post<QueryResult>(
        "/queries",
        { target_id: activeTargetID, database_name: activeDatabaseName, statement: executableStatement },
        { signal: controller.signal },
      )
      setResult(response.data)
      setBottomPaneCollapsed(false)
      void queryClient.invalidateQueries({ queryKey: ["queryHistory"] })
    } catch (error) {
      if (!controller.signal.aborted) {
        setQueryError(getErrorMessage(error))
        setBottomPaneCollapsed(false)
      }
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

  useEffect(() => {
    if (workspaceView !== "query") editorRef.current = null
  }, [workspaceView])

  useEffect(() => () => completionDisposable.current?.dispose(), [])

  const mountEditor: OnMount = (editor, monaco) => {
    editorRef.current = editor
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

  function openNewConnection() {
    setConnectionTarget(null)
    setConnectionDialogOpen(true)
  }

  function openEditConnection(target: DatabaseTarget) {
    setConnectionTarget(target)
    setConnectionDialogOpen(true)
  }

  function selectBottomTab(tab: "results" | "history") {
    setBottomTab(tab)
    setBottomPaneCollapsed(false)
  }

  function setBottomPaneFromPointer(clientY: number) {
    const bounds = workspaceRef.current?.getBoundingClientRect()
    if (!bounds || bounds.height === 0) return
    const ratio = (bounds.bottom - clientY) / bounds.height
    setBottomPaneRatio(Math.min(0.68, Math.max(0.18, ratio)))
  }

  function startBottomPaneResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture(event.pointerId)
    bottomPaneResizingRef.current = true
    setBottomPaneResizing(true)
    setBottomPaneCollapsed(false)
    setBottomPaneFromPointer(event.clientY)
  }

  function moveBottomPaneResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (bottomPaneResizingRef.current) setBottomPaneFromPointer(event.clientY)
  }

  function stopBottomPaneResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    bottomPaneResizingRef.current = false
    setBottomPaneResizing(false)
  }

  function resizeBottomPaneWithKeyboard(event: ReactKeyboardEvent<HTMLDivElement>) {
    const adjustments: Record<string, number> = { ArrowUp: 0.04, ArrowDown: -0.04 }
    const adjustment = adjustments[event.key]
    if (!adjustment && event.key !== "Home" && event.key !== "End") return
    event.preventDefault()
    setBottomPaneCollapsed(false)
    if (event.key === "Home") {
      setBottomPaneRatio(0.18)
    } else if (event.key === "End") {
      setBottomPaneRatio(0.68)
    } else {
      setBottomPaneRatio((current) => Math.min(0.68, Math.max(0.18, current + adjustment)))
    }
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
          {!isAdmin && (
            <span className="mr-1 rounded border border-gr-purple/25 bg-gr-purple/10 px-1.5 py-0.5 font-mono text-[9px] font-semibold tracking-wide text-purple-300">
              READ ONLY
            </span>
          )}
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

      <div
        className={cn(
          "grid min-h-0 grid-cols-[minmax(0,1fr)] transition-[grid-template-columns] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none lg:grid-cols-[0px_minmax(0,1fr)]",
          sidebarOpen && "lg:grid-cols-[280px_minmax(0,1fr)]",
        )}
      >
        <aside
          aria-hidden={!sidebarOpen}
          inert={!sidebarOpen}
          className={cn(
            "fixed top-[46px] bottom-0 left-0 z-20 flex min-h-0 w-[280px] flex-col overflow-hidden border-r bg-[#0f0e13] shadow-2xl shadow-black/40 transition-[transform,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none lg:static lg:z-auto lg:w-full lg:shadow-none [&>*]:min-w-[280px]",
            sidebarOpen ? "translate-x-0 opacity-100" : "pointer-events-none -translate-x-full opacity-0 lg:translate-x-0",
          )}
        >
            <div className="flex h-10 items-center border-b px-2.5">
              <span className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">Explorer</span>
              <div className="ml-auto flex gap-0.5">
                {isAdmin && (
                  <Button variant="ghost" size="icon-sm" onClick={openNewConnection}>
                    <Plus />
                    <span className="sr-only">New connection</span>
                  </Button>
                )}
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
            <div className="min-h-0 flex-1 touch-pan-y overflow-x-hidden overflow-y-auto overscroll-contain pb-1.5 [scrollbar-gutter:stable]">
              {targetsQuery.isLoading && <SidebarMessage>Loading connections…</SidebarMessage>}
              {!targetsQuery.isLoading && targets.length === 0 && (
                <div className="px-4 py-10 text-center">
                  <Database className="mx-auto mb-3 size-5 text-muted-foreground" />
                  <p className="text-xs font-medium">No connections yet</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                    {isAdmin ? "Connect a PostgreSQL database to start exploring." : "No database connections have been configured yet."}
                  </p>
                  {isAdmin && (
                    <Button className="mt-4" size="sm" onClick={openNewConnection}>
                      <Plus /> Connect database
                    </Button>
                  )}
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
                  canManage={isAdmin}
                  onEdit={() => openEditConnection(target)}
                  onDelete={() => setTargetPendingDeletion(target)}
                />
              ))}
            </div>
        </aside>

        <main
          ref={workspaceRef}
          className={cn(
            "relative grid min-h-0 overflow-hidden motion-reduce:transition-none",
            bottomPaneResizing ? "cursor-row-resize transition-none" : "transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
          )}
          style={{ gridTemplateRows: `minmax(0, 1fr) ${bottomPaneCollapsed ? "36px" : `${bottomPaneRatio * 100}%`}` }}
        >
          <Button
            variant="ghost"
            size="icon-sm"
            aria-hidden={sidebarOpen}
            tabIndex={sidebarOpen ? -1 : 0}
            className={cn(
              "absolute top-2 left-2 z-10 transition-[transform,opacity] duration-200 ease-out motion-reduce:transition-none",
              sidebarOpen ? "pointer-events-none -translate-x-2 opacity-0" : "translate-x-0 opacity-100 delay-150",
            )}
            onClick={() => setSidebarOpen(true)}
          >
            <PanelLeftOpen />
            <span className="sr-only">Show explorer</span>
          </Button>
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

          <section className="relative grid min-h-0 grid-rows-[36px_minmax(0,1fr)] bg-[#0f0e13]">
            <div
              role="separator"
              aria-label="Resize results pane"
              aria-orientation="horizontal"
              aria-valuemin={0}
              aria-valuemax={68}
              aria-valuenow={bottomPaneCollapsed ? 0 : Math.round(bottomPaneRatio * 100)}
              aria-valuetext={bottomPaneCollapsed ? "Collapsed" : `${Math.round(bottomPaneRatio * 100)} percent`}
              tabIndex={0}
              className="group absolute -top-1.5 right-0 left-0 z-20 h-3 touch-none cursor-row-resize outline-none after:absolute after:top-1/2 after:left-1/2 after:h-0.5 after:w-10 after:-translate-x-1/2 after:-translate-y-1/2 after:rounded-full after:bg-transparent after:transition-[width,background-color,box-shadow] after:duration-150 hover:after:w-14 hover:after:bg-gr-pink/55 hover:after:shadow-[0_0_12px_rgba(225,5,163,0.28)] focus-visible:after:w-14 focus-visible:after:bg-gr-pink/70 motion-reduce:after:transition-none"
              onPointerDown={startBottomPaneResize}
              onPointerMove={moveBottomPaneResize}
              onPointerUp={stopBottomPaneResize}
              onPointerCancel={stopBottomPaneResize}
              onLostPointerCapture={stopBottomPaneResize}
              onKeyDown={resizeBottomPaneWithKeyboard}
            />
            <div className="flex items-center border-b px-2">
              <BottomTab active={bottomTab === "results"} onClick={() => selectBottomTab("results")}>
                <Columns3 /> Results {result && <span className="text-muted-foreground">{result.row_count}</span>}
              </BottomTab>
              <BottomTab active={bottomTab === "history"} onClick={() => selectBottomTab("history")}>
                <Clock3 /> History
              </BottomTab>
              <div className="ml-auto min-w-0 truncate px-2 text-[11px] text-muted-foreground">
                {result && bottomTab === "results" && `${result.database_name} · ${result.command_tag || "Query"} · ${result.duration_ms} ms`}
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                className="shrink-0"
                onClick={() => setBottomPaneCollapsed((collapsed) => !collapsed)}
              >
                {bottomPaneCollapsed ? <ChevronUp /> : <ChevronDown />}
                <span className="sr-only">{bottomPaneCollapsed ? "Expand results pane" : "Collapse results pane"}</span>
              </Button>
            </div>
            <div
              className={cn(
                "min-h-0 overflow-auto transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none",
                bottomPaneCollapsed ? "pointer-events-none translate-y-1 opacity-0" : "translate-y-0 opacity-100 delay-75",
              )}
            >
              {bottomTab === "results" ? (
                <div key={running ? "running" : result?.run_id ?? queryError} className="h-full motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-200">
                  <ResultsPanel result={result} error={queryError} running={running} />
                </div>
              ) : (
                <HistoryPanel
                  runs={historyQuery.data ?? []}
                  loading={historyQuery.isLoading}
                  onSelect={(run) => {
                    setSelectedTargetID(run.target_id)
                    setDatabaseSelection({ targetID: run.target_id, databaseName: run.database_name })
                    setStatement(run.statement)
                    selectBottomTab("results")
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
            key={connectionTarget?.id ?? "new"}
            open
            onOpenChange={setConnectionDialogOpen}
            target={connectionTarget}
            onSaved={(target) => {
              setSelectedTargetID(target.id)
              toast.success(connectionTarget ? `${target.name} updated` : `${target.name} connected`)
            }}
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
  canManage,
  onEdit,
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
  canManage: boolean
  onEdit: () => void
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
        className={cn("group flex h-8 items-center gap-1.5 border-l-2 px-2 text-xs transition-colors duration-150 motion-reduce:transition-none", selected ? "sticky top-0 z-30 border-gr-pink bg-[#181122]/95 text-foreground shadow-sm backdrop-blur-md" : "border-transparent text-muted-foreground hover:bg-muted/50")}
      >
        <button className="grid size-5 place-items-center" onClick={() => { setExpanded(!expanded); if (!selected) onSelect() }}>
          <ChevronRight className={cn("size-3.5 transition-transform duration-200 ease-out motion-reduce:transition-none", expanded && "rotate-90")} />
        </button>
        <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={onSelect}>
          <Server className={cn("size-3.5", selected && "text-gr-purple")} />
          <span className="truncate font-medium" title={target.name}>{target.name}</span>
          <EnvironmentBadge environment={target.environment} />
        </button>
        {canManage && (
          <>
            <Button variant="ghost" size="icon-sm" className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100" onClick={onEdit}>
              <Pencil />
              <span className="sr-only">Edit connection</span>
            </Button>
            <Button variant="ghost" size="icon-sm" className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100" onClick={onDelete}>
              <Trash2 />
              <span className="sr-only">Remove connection</span>
            </Button>
          </>
        )}
      </div>
      {selected && expanded && (
        <div className="pb-1">
          {databasesLoading && <SidebarMessage>Discovering databases…</SidebarMessage>}
          {databases.map((database) => {
            const active = database.name === activeDatabaseName
            return (
              <div key={database.name}>
                <button
                  className={cn("flex h-8 w-full items-center gap-1.5 pr-2 pl-6 text-xs text-muted-foreground transition-colors duration-150 hover:bg-muted/40 hover:text-foreground motion-reduce:transition-none", active && "sticky top-8 z-20 bg-[#121017]/95 text-foreground shadow-sm backdrop-blur-md")}
                  onClick={() => onSelectDatabase(database.name)}
                >
                  <ChevronRight className={cn("size-3.5 transition-transform duration-200 ease-out motion-reduce:transition-none", active && "rotate-90")} />
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
      <button className="sticky top-16 z-10 flex h-7 w-full items-center gap-1.5 bg-[#0f0e13]/95 px-1 text-xs text-muted-foreground shadow-sm backdrop-blur-md transition-colors duration-150 hover:text-foreground motion-reduce:transition-none" onClick={() => setExpanded(!expanded)}>
        <ChevronRight className={cn("size-3.5 transition-transform duration-200 ease-out motion-reduce:transition-none", expanded && "rotate-90")} />
        <span className="font-mono text-[11px]">{schema}</span>
      </button>
      {expanded &&
        tables.map((table) => (
          <button key={table.name} className="flex h-7 w-full items-center gap-2 pr-2 pl-6 text-xs text-muted-foreground transition-colors duration-150 hover:bg-muted/40 hover:text-foreground motion-reduce:transition-none" onDoubleClick={() => onOpenTable(table)} onClick={() => onOpenTable(table)}>
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
          <tr key={rowIndex} className="transition-colors duration-100 hover:bg-white/[0.025] motion-reduce:transition-none">
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
        <button key={run.id} className="grid w-full grid-cols-[120px_1fr_auto] items-center gap-3 px-3 py-2 text-left text-xs transition-colors duration-150 hover:bg-muted/35 motion-reduce:transition-none" onClick={() => onSelect(run)}>
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
    <button className={cn("flex h-full items-center gap-1.5 border-b-2 px-3 text-xs transition-[color,border-color] duration-200 motion-reduce:transition-none", active ? "border-gr-pink text-foreground" : "border-transparent text-muted-foreground hover:text-foreground", "[&_svg]:size-3.5")} onClick={onClick}>
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
