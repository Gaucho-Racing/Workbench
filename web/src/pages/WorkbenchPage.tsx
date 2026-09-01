import Editor, { type Monaco, type OnMount } from "@monaco-editor/react"
import { useQueryClient } from "@tanstack/react-query"
import type { editor, languages } from "monaco-editor"
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleStop,
  Clock3,
  Columns3,
  Copy,
  Database,
  DatabaseZap,
  Download,
  FileCode2,
  GitFork,
  LockKeyhole,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  PenLine,
  Play,
  Plus,
  RefreshCw,
  Search,
  Server,
  Table2,
  Trash2,
  Upload,
  X,
} from "lucide-react"
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react"
import { toast } from "sonner"

import { ConfirmationDialog } from "@/components/ConfirmationDialog"
import type { CompletedImport } from "@/components/DataImportDialog"
import type { ExportFormat } from "@/components/ExportDialog"
import { Button } from "@/components/ui/button"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { api, getErrorCode, getErrorMessage } from "@/lib/api"
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
import {
  qualifiedSQLIdentifier,
  selectStatementForTable,
  sqlStatementRanges,
  statementForEditor,
  statementRangeAtOffset,
  statementRangeForEditor,
  type SQLStatementRange,
} from "@/lib/sql"

type StatementIndicatorStatus = "idle" | "success" | "error"
type RunAllPolicy = "abort" | "continue"
type SessionMode = "read" | "write"
type BatchRunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "skipped"

type SQLEditorTab = {
  id: string
  name: string
  path: string
  value: string
}

type BatchQueryRun = {
  statementNumber: number
  statement: string
  status: BatchRunStatus
  result: QueryResult | null
  error: string
}

const initialStatement = `select
  current_database() as database,
  current_user as user,
  now() as connected_at;`

const initialEditorTab: SQLEditorTab = {
  id: "sql-tab-1",
  name: "query.sql",
  path: "file:///workbench/sql-tab-1.sql",
  value: initialStatement,
}

const maxDroppedSQLFiles = 20
const maxDroppedSQLFileBytes = 10 * 1024 * 1024

const SchemaDiagram = lazy(() =>
  import("@/components/SchemaDiagram").then((module) => ({ default: module.SchemaDiagram })),
)
const ConnectionDialog = lazy(() =>
  import("@/components/ConnectionDialog").then((module) => ({ default: module.ConnectionDialog })),
)
const BulkExportDialog = lazy(() =>
  import("@/components/BulkExportDialog").then((module) => ({ default: module.BulkExportDialog })),
)
const DataImportDialog = lazy(() =>
  import("@/components/DataImportDialog").then((module) => ({ default: module.DataImportDialog })),
)
const ExportDialog = lazy(() =>
  import("@/components/ExportDialog").then((module) => ({ default: module.ExportDialog })),
)
const DDLDialog = lazy(() =>
  import("@/components/DDLDialog").then((module) => ({ default: module.DDLDialog })),
)

export default function WorkbenchPage() {
  const queryClient = useQueryClient()
  const { user, isAdmin, logout } = useAuth()
  const targetsQuery = useTargets()
  const [selectedTargetID, setSelectedTargetID] = useState<string | null>(null)
  const [databaseSelection, setDatabaseSelection] = useState<{ targetID: string; databaseName: string } | null>(null)
  const [editorTabs, setEditorTabs] = useState<SQLEditorTab[]>([initialEditorTab])
  const [activeEditorTabID, setActiveEditorTabID] = useState(initialEditorTab.id)
  const [sqlFileDragging, setSQLFileDragging] = useState(false)
  const [result, setResult] = useState<QueryResult | null>(null)
  const [queryError, setQueryError] = useState("")
  const [batchRuns, setBatchRuns] = useState<BatchQueryRun[]>([])
  const [selectedBatchRunIndex, setSelectedBatchRunIndex] = useState(0)
  const [runAllPolicy, setRunAllPolicy] = useState<RunAllPolicy>("abort")
  const [sessionMode, setSessionMode] = useState<SessionMode>("read")
  const [sessionModeError, setSessionModeError] = useState("")
  const [sessionModeAttention, setSessionModeAttention] = useState(0)
  const [running, setRunning] = useState(false)
  const [connectionDialogOpen, setConnectionDialogOpen] = useState(false)
  const [connectionTarget, setConnectionTarget] = useState<DatabaseTarget | null>(null)
  const [bulkExportDialogOpen, setBulkExportDialogOpen] = useState(false)
  const [importDialogOpen, setImportDialogOpen] = useState(false)
  const [exportDialogOpen, setExportDialogOpen] = useState(false)
  const [exportFormat, setExportFormat] = useState<ExportFormat>("csv")
  const [exportStatement, setExportStatement] = useState("")
  const [exportSourceName, setExportSourceName] = useState("query")
  const [ddlTable, setDDLTable] = useState<CatalogTable | null>(null)
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
  const monacoRef = useRef<Monaco | null>(null)
  const nextEditorTabNumber = useRef(2)
  const sqlFileDragDepth = useRef(0)
  const statementDecoration = useRef<editor.IEditorDecorationsCollection | null>(null)
  const statementRailElement = useRef<HTMLDivElement | null>(null)
  const statementIndicatorDisposables = useRef<{ dispose: () => void }[]>([])
  const statementIndicatorStatus = useRef<StatementIndicatorStatus>("idle")
  const statementIndicatorRevision = useRef(0)
  const updateStatementIndicatorRef = useRef<() => void>(() => undefined)
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
  const selectedBatchRun = batchRuns[selectedBatchRunIndex] ?? null
  const finishedBatchRunCount = batchRuns.filter((run) => run.status !== "queued" && run.status !== "running").length
  const writeMode = isAdmin && sessionMode === "write"
  const activeEditorTab = editorTabs.find((tab) => tab.id === activeEditorTabID) ?? editorTabs[0] ?? initialEditorTab
  const statement = activeEditorTab.value

  const signalReadOnlyViolation = useCallback(() => {
    setSessionModeError("Write blocked. Switch this session to Write mode to run it.")
    setSessionModeAttention((current) => current + 1)
  }, [])

  const execute = useCallback(async () => {
    if (!activeTargetID || !statement.trim() || running) return
    const executableStatement = statementForEditor(editorRef.current, statement)
    if (!executableStatement) return
    const executedRange = statementRangeForEditor(editorRef.current)
    const executedRangeKey = statementRangeKey(executedRange)
    const executedRevision = statementIndicatorRevision.current
    const controller = new AbortController()
    abortController.current = controller
    statementIndicatorStatus.current = "idle"
    updateStatementIndicatorRef.current()
    setBatchRuns([])
    setRunning(true)
    setQueryError("")
    setSessionModeError("")
    setBottomTab("results")
    try {
      const response = await api.post<QueryResult>(
        "/queries",
        { target_id: activeTargetID, database_name: activeDatabaseName, statement: executableStatement, read_only: !writeMode },
        { signal: controller.signal },
      )
      setResult(response.data)
      setSessionModeError("")
      if (statementIndicatorRevision.current === executedRevision && statementRangeKey(statementRangeForEditor(editorRef.current)) === executedRangeKey) {
        statementIndicatorStatus.current = "success"
        updateStatementIndicatorRef.current()
      }
      setBottomPaneCollapsed(false)
      void queryClient.invalidateQueries({ queryKey: ["queryHistory"] })
    } catch (error) {
      if (!controller.signal.aborted) {
        const errorMessage = getErrorMessage(error)
        if (getErrorCode(error) === "read_only_violation") signalReadOnlyViolation()
        setQueryError(errorMessage)
        if (statementIndicatorRevision.current === executedRevision && statementRangeKey(statementRangeForEditor(editorRef.current)) === executedRangeKey) {
          statementIndicatorStatus.current = "error"
          updateStatementIndicatorRef.current()
        }
        setBottomPaneCollapsed(false)
      }
    } finally {
      abortController.current = null
      setRunning(false)
    }
  }, [activeDatabaseName, activeTargetID, queryClient, running, signalReadOnlyViolation, statement, writeMode])

  const executeAll = useCallback(async () => {
    if (!activeTargetID || !statement.trim() || running) return
    const editor = editorRef.current
    const model = editor?.getModel()
    const source = model?.getValue() ?? statement
    const ranges = sqlStatementRanges(source)
    const cursorPosition = editor?.getPosition()
    const cursorRange = model && cursorPosition ? statementRangeAtOffset(source, model.getOffsetAt(cursorPosition)) : ranges[0]
    const cursorRangeIndex = cursorRange
      ? ranges.findIndex((range) => range.start === cursorRange.start && range.end === cursorRange.end)
      : 0
    const statements = ranges.slice(Math.max(0, cursorRangeIndex)).map((range) => source.slice(range.start, range.end).trim())
    if (statements.length === 0) return

    const executedRevision = statementIndicatorRevision.current
    const controller = new AbortController()
    abortController.current = controller
    statementIndicatorStatus.current = "idle"
    updateStatementIndicatorRef.current()
    const initialRuns = statements.map<BatchQueryRun>((batchStatement, index) => ({
      statementNumber: Math.max(0, cursorRangeIndex) + index + 1,
      statement: batchStatement,
      status: "queued",
      result: null,
      error: "",
    }))
    setBatchRuns(initialRuns)
    setSelectedBatchRunIndex(0)
    setResult(null)
    setQueryError("")
    setSessionModeError("")
    setBottomTab("results")
    setRunning(true)

    const updateRun = (index: number, update: Partial<BatchQueryRun>) => {
      setBatchRuns((current) => current.map((run, runIndex) => runIndex === index ? { ...run, ...update } : run))
    }
    const skipRemaining = (afterIndex: number) => {
      setBatchRuns((current) => current.map((run, runIndex) => (
        runIndex > afterIndex && run.status === "queued" ? { ...run, status: "skipped" } : run
      )))
    }

    try {
      for (let index = 0; index < statements.length; index += 1) {
        setSelectedBatchRunIndex(index)
        updateRun(index, { status: "running" })
        try {
          const response = await api.post<QueryResult>(
            "/queries",
            { target_id: activeTargetID, database_name: activeDatabaseName, statement: statements[index], read_only: !writeMode },
            { signal: controller.signal },
          )
          updateRun(index, { status: "succeeded", result: response.data })
          setSessionModeError("")
          if (index === 0 && statementIndicatorRevision.current === executedRevision) {
            statementIndicatorStatus.current = "success"
            updateStatementIndicatorRef.current()
          }
          setBottomPaneCollapsed(false)
        } catch (error) {
          if (controller.signal.aborted) {
            updateRun(index, { status: "cancelled" })
            skipRemaining(index)
            break
          }
          const errorMessage = getErrorMessage(error)
          if (getErrorCode(error) === "read_only_violation") signalReadOnlyViolation()
          updateRun(index, { status: "failed", error: errorMessage })
          if (index === 0 && statementIndicatorRevision.current === executedRevision) {
            statementIndicatorStatus.current = "error"
            updateStatementIndicatorRef.current()
          }
          setBottomPaneCollapsed(false)
          if (runAllPolicy === "abort") {
            skipRemaining(index)
            break
          }
        }
      }
      setBottomPaneCollapsed(false)
      void queryClient.invalidateQueries({ queryKey: ["queryHistory"] })
    } finally {
      abortController.current = null
      setRunning(false)
    }
  }, [activeDatabaseName, activeTargetID, queryClient, runAllPolicy, running, signalReadOnlyViolation, statement, writeMode])

  const executeRef = useRef(execute)
  const executeAllRef = useRef(executeAll)
  const catalogRef = useRef<CatalogTable[]>([])
  const completionDisposable = useRef<{ dispose: () => void } | null>(null)

  useEffect(() => {
    executeRef.current = execute
  }, [execute])

  useEffect(() => {
    executeAllRef.current = executeAll
  }, [executeAll])

  useEffect(() => {
    catalogRef.current = catalogQuery.data?.tables ?? []
  }, [catalogQuery.data])

  useEffect(() => {
    if (workspaceView !== "query") editorRef.current = null
  }, [workspaceView])

  useEffect(() => () => {
    completionDisposable.current?.dispose()
    statementDecoration.current?.clear()
    statementRailElement.current?.remove()
    statementIndicatorDisposables.current.forEach((disposable) => disposable.dispose())
  }, [])

  const mountEditor: OnMount = (editor, monaco) => {
    editorRef.current = editor
    monacoRef.current = monaco
    editor.addAction({
      id: "workbench.execute-query",
      label: "Execute query",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      run: () => executeRef.current(),
    })
    editor.addAction({
      id: "workbench.execute-following-queries",
      label: "Execute current and following queries",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter],
      run: () => executeAllRef.current(),
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

    statementDecoration.current?.clear()
    statementRailElement.current?.remove()
    statementIndicatorDisposables.current.forEach((disposable) => disposable.dispose())
    const decoration = editor.createDecorationsCollection()
    const rail = document.createElement("div")
    rail.className = "workbench-statement-rail"
    rail.setAttribute("aria-hidden", "true")
    editor.getDomNode()?.appendChild(rail)
    statementDecoration.current = decoration
    statementRailElement.current = rail
    const updateStatementIndicator = () => {
      const model = editor.getModel()
      const range = statementRangeForEditor(editor)
      if (!model || !range) {
        decoration.clear()
        rail.hidden = true
        return
      }
      const start = model.getPositionAt(range.start)
      const end = model.getPositionAt(Math.max(range.start, range.end - 1))
      const layout = editor.getLayoutInfo()
      const top = editor.getTopForLineNumber(start.lineNumber) - editor.getScrollTop()
      const bottom = editor.getTopForLineNumber(end.lineNumber) - editor.getScrollTop()
      const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight)
      rail.hidden = false
      rail.dataset.status = statementIndicatorStatus.current
      rail.style.left = `${Math.max(2, layout.lineNumbersLeft - 7)}px`
      rail.style.top = `${top}px`
      rail.style.height = `${bottom - top + lineHeight}px`
      decoration.set([{
        range: new monaco.Range(start.lineNumber, 1, end.lineNumber, model.getLineMaxColumn(end.lineNumber)),
        options: {
          isWholeLine: true,
          lineNumberClassName: "workbench-statement-line-number",
        },
      }])
    }
    const resetStatementIndicator = () => {
      statementIndicatorRevision.current += 1
      statementIndicatorStatus.current = "idle"
      updateStatementIndicator()
    }
    updateStatementIndicatorRef.current = updateStatementIndicator
    statementIndicatorDisposables.current = [
      editor.onDidChangeCursorSelection(resetStatementIndicator),
      editor.onDidChangeModelContent(resetStatementIndicator),
      editor.onDidChangeModel(resetStatementIndicator),
      editor.onDidScrollChange(updateStatementIndicator),
      editor.onDidLayoutChange(updateStatementIndicator),
    ]
    updateStatementIndicator()
  }

  function buildSQLTab(value = "", fileName?: string): SQLEditorTab {
    const tabNumber = nextEditorTabNumber.current
    nextEditorTabNumber.current += 1
    const id = `sql-tab-${tabNumber}`
    return {
      id,
      name: fileName || `query-${tabNumber}.sql`,
      path: `file:///workbench/${id}.sql`,
      value,
    }
  }

  function openSQLTab(value = "", fileName?: string) {
    const tab = buildSQLTab(value, fileName)
    setEditorTabs((current) => [...current, tab])
    setActiveEditorTabID(tab.id)
    setWorkspaceView("query")
    setBatchRuns([])
    setQueryError("")
    return tab
  }

  function updateActiveSQL(value: string) {
    setEditorTabs((current) => current.map((tab) => tab.id === activeEditorTabID ? { ...tab, value } : tab))
  }

  function closeSQLTab(tabID: string) {
    if (running) return
    const closingIndex = editorTabs.findIndex((tab) => tab.id === tabID)
    if (closingIndex < 0) return
    const closingTab = editorTabs[closingIndex]
    let remaining = editorTabs.filter((tab) => tab.id !== tabID)
    if (remaining.length === 0) remaining = [buildSQLTab()]
    if (activeEditorTabID === tabID) {
      const nextActive = remaining[Math.min(closingIndex, remaining.length - 1)]
      setActiveEditorTabID(nextActive.id)
    }
    setEditorTabs(remaining)
    window.setTimeout(() => {
      const monaco = monacoRef.current
      if (!monaco) return
      monaco.editor.getModel(monaco.Uri.parse(closingTab.path))?.dispose()
    }, 0)
  }

  async function openDroppedSQLFiles(fileList: FileList) {
    const droppedFiles = Array.from(fileList)
    const limitedFiles = droppedFiles.slice(0, maxDroppedSQLFiles)
    const validFiles = limitedFiles.filter((file) => (
      file.name.toLowerCase().endsWith(".sql") && file.size <= maxDroppedSQLFileBytes
    ))
    const skippedCount = droppedFiles.length - validFiles.length
    if (skippedCount > 0) {
      toast.warning(`Skipped ${skippedCount} file${skippedCount === 1 ? "" : "s"}; use .sql files up to 10 MB each`)
    }
    if (validFiles.length === 0) return

    const loadedFiles = await Promise.all(validFiles.map(async (file) => {
      try {
        return { file, value: await file.text(), error: "" }
      } catch (error) {
        return { file, value: "", error: getErrorMessage(error) }
      }
    }))
    const readableFiles = loadedFiles.filter((loaded) => !loaded.error)
    const readErrorCount = loadedFiles.length - readableFiles.length
    if (readErrorCount > 0) toast.error(`Could not read ${readErrorCount} SQL file${readErrorCount === 1 ? "" : "s"}`)
    if (readableFiles.length === 0) return

    const tabs = readableFiles.map(({ file, value }) => buildSQLTab(value, file.name))
    setEditorTabs((current) => [...current, ...tabs])
    setActiveEditorTabID(tabs[tabs.length - 1].id)
    setWorkspaceView("query")
    setBatchRuns([])
    setQueryError("")
    toast.success(`${tabs.length} SQL file${tabs.length === 1 ? "" : "s"} opened`)
  }

  function startSQLFileDrag(event: ReactDragEvent<HTMLDivElement>) {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return
    event.preventDefault()
    sqlFileDragDepth.current += 1
    setSQLFileDragging(true)
  }

  function continueSQLFileDrag(event: ReactDragEvent<HTMLDivElement>) {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return
    event.preventDefault()
    event.dataTransfer.dropEffect = "copy"
  }

  function endSQLFileDrag(event: ReactDragEvent<HTMLDivElement>) {
    if (sqlFileDragDepth.current === 0) return
    event.preventDefault()
    sqlFileDragDepth.current = Math.max(0, sqlFileDragDepth.current - 1)
    if (sqlFileDragDepth.current === 0) setSQLFileDragging(false)
  }

  function dropSQLFiles(event: ReactDragEvent<HTMLDivElement>) {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return
    event.preventDefault()
    sqlFileDragDepth.current = 0
    setSQLFileDragging(false)
    void openDroppedSQLFiles(event.dataTransfer.files)
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
    openSQLTab(selectStatementForTable(table.schema, table.name, 100), `${table.name}.sql`)
  }

  function openTableExport(table: CatalogTable) {
    if (!isAdmin || !activeTargetID || !activeDatabaseName) return
    setExportStatement(selectStatementForTable(table.schema, table.name))
    setExportSourceName(table.name)
    setExportDialogOpen(true)
  }

  async function copyTableText(value: string, successMessage: string) {
    try {
      await navigator.clipboard.writeText(value)
      toast.success(successMessage)
    } catch {
      toast.error("Could not access the clipboard")
    }
  }

  function selectDatabase(targetID: string, databaseName: string) {
    setSelectedTargetID(targetID)
    setDatabaseSelection({ targetID, databaseName })
    setResult(null)
    setQueryError("")
    setBatchRuns([])
  }

  function openNewConnection() {
    setConnectionTarget(null)
    setConnectionDialogOpen(true)
  }

  function openEditConnection(target: DatabaseTarget) {
    setConnectionTarget(target)
    setConnectionDialogOpen(true)
  }

  function openExportPreview() {
    if (!isAdmin || !activeTargetID || !activeDatabaseName) return
    const executableStatement = statementForEditor(editorRef.current, statement)
    if (!executableStatement) return
    setExportStatement(executableStatement)
    setExportSourceName("query")
    setExportDialogOpen(true)
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
          <span className={cn(
            "mr-1 overflow-hidden rounded border px-1.5 py-0.5 font-mono text-[9px] font-semibold tracking-wide transition-[color,background-color,border-color,box-shadow] duration-500 ease-out",
            writeMode
              ? "border-gr-pink/30 bg-gr-pink/10 text-pink-200 shadow-[0_0_12px_rgba(225,5,163,0.08)]"
              : "border-gr-purple/30 bg-gr-purple/10 text-purple-200 shadow-[0_0_12px_rgba(132,18,252,0.08)]",
          )}>
            <span key={writeMode ? "write" : "read"} className="workbench-mode-status-enter inline-block">
              {writeMode ? "WRITE MODE" : "READ ONLY"}
            </span>
          </span>
          {running ? (
            <Button variant="destructive" size="sm" onClick={() => abortController.current?.abort()}>
              <CircleStop /> Stop
            </Button>
          ) : (
            <>
              <Select value={runAllPolicy} onValueChange={(value) => setRunAllPolicy(value as RunAllPolicy)}>
                <SelectTrigger className="h-7 w-[126px] bg-black/20 text-[10px]" aria-label="Run from here error policy">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="abort">Stop on error</SelectItem>
                  <SelectItem value="continue">Continue on error</SelectItem>
                </SelectContent>
              </Select>
              <Button size="sm" disabled={!selectedTarget || !statement.trim()} onClick={() => void execute()}>
                <Play className="fill-current" /> Run
                <kbd className="ml-1 hidden rounded bg-black/20 px-1 font-mono text-[10px] sm:inline">⌘↵</kbd>
              </Button>
              <Button variant="secondary" size="sm" disabled={!selectedTarget || !statement.trim()} onClick={() => void executeAll()}>
                <Play /> Run from here
                <kbd className="ml-1 hidden rounded bg-black/20 px-1 font-mono text-[10px] xl:inline">⇧⌘↵</kbd>
              </Button>
            </>
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
                  <>
                    <Button variant="ghost" size="icon-sm" onClick={openNewConnection}>
                      <Plus />
                      <span className="sr-only">New connection</span>
                    </Button>
                    <Button variant="ghost" size="icon-sm" disabled={!selectedTarget || !activeDatabaseName} onClick={() => setBulkExportDialogOpen(true)}>
                      <Download />
                      <span className="sr-only">Bulk export tables</span>
                    </Button>
                    <Button variant="ghost" size="icon-sm" disabled={!selectedTarget || !activeDatabaseName} onClick={() => setImportDialogOpen(true)}>
                      <Upload />
                      <span className="sr-only">Import CSV</span>
                    </Button>
                  </>
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
                  onBulkExportDatabase={(databaseName) => {
                    selectDatabase(target.id, databaseName)
                    setBulkExportDialogOpen(true)
                  }}
                  onImportDatabase={(databaseName) => {
                    selectDatabase(target.id, databaseName)
                    setImportDialogOpen(true)
                  }}
                  onOpenTable={openTable}
                  onViewDDL={setDDLTable}
                  onExportTable={openTableExport}
                  onCopyQualifiedName={(table) => void copyTableText(qualifiedSQLIdentifier(table.schema, table.name), "Qualified name copied")}
                  onCopySelect={(table) => void copyTableText(selectStatementForTable(table.schema, table.name, 100), "SELECT statement copied")}
                  canExport={isAdmin}
                  canManage={isAdmin}
                  onEdit={() => openEditConnection(target)}
                  onDelete={() => setTargetPendingDeletion(target)}
                />
              ))}
            </div>
            <SessionModeControl
              mode={writeMode ? "write" : "read"}
              isAdmin={isAdmin}
              disabled={running}
              error={sessionModeError}
              attentionKey={sessionModeAttention}
              onModeChange={(mode) => {
                if (mode === "write" && !isAdmin) return
                setSessionMode(mode)
                setSessionModeError("")
              }}
            />
        </aside>

        <main
          ref={workspaceRef}
          className={cn(
            "relative grid min-h-0 overflow-hidden motion-reduce:transition-none",
            bottomPaneResizing ? "cursor-row-resize transition-none" : "transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
          )}
          style={{ gridTemplateRows: `minmax(0, 1fr) ${bottomPaneCollapsed ? "36px" : `${bottomPaneRatio * 100}%`}` }}
        >
          <section className="min-h-0 border-b bg-[#0d0c11] pt-1">
            <div className="flex h-8 min-w-0 items-center border-b text-xs">
              <div
                aria-hidden={sidebarOpen}
                className={cn(
                  "grid h-full shrink-0 place-items-center overflow-hidden transition-[width,opacity,margin] duration-200 ease-out motion-reduce:transition-none",
                  sidebarOpen ? "pointer-events-none w-0 opacity-0" : "ml-1 w-7 opacity-100 delay-150",
                )}
              >
                <Button variant="ghost" size="icon-sm" tabIndex={sidebarOpen ? -1 : 0} onClick={() => setSidebarOpen(true)}>
                  <PanelLeftOpen />
                  <span className="sr-only">Show explorer</span>
                </Button>
              </div>
              <div role="tablist" aria-label="Workbench views" className="flex h-full min-w-0 flex-1">
                <button
                  role="tab"
                  aria-selected={workspaceView === "diagram"}
                  className={cn(
                    "flex h-full shrink-0 items-center gap-1.5 border-b-2 px-3 text-[11px] transition-[color,border-color,background-color] duration-150 motion-reduce:transition-none",
                    workspaceView === "diagram"
                      ? "border-gr-pink bg-gr-pink/[0.04] text-foreground"
                      : "border-transparent text-muted-foreground hover:bg-white/[0.025] hover:text-foreground",
                  )}
                  onClick={() => setWorkspaceView("diagram")}
                >
                  <GitFork className="size-3" /> Diagram
                </button>
                <div className="h-4 w-px shrink-0 self-center bg-border" />
                <div className="flex h-full min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                  {editorTabs.map((tab) => {
                    const active = workspaceView === "query" && tab.id === activeEditorTabID
                    return (
                      <div
                        key={tab.id}
                        className={cn(
                          "group flex h-full min-w-32 max-w-52 shrink-0 items-center border-b-2 transition-[color,border-color,background-color] duration-150 motion-reduce:transition-none",
                          active
                            ? "border-gr-pink bg-gr-pink/[0.04] text-foreground"
                            : "border-transparent text-muted-foreground hover:bg-white/[0.025] hover:text-foreground",
                        )}
                        onAuxClick={(event) => {
                          if (event.button !== 1) return
                          event.preventDefault()
                          closeSQLTab(tab.id)
                        }}
                      >
                        <button
                          role="tab"
                          aria-selected={active}
                          className="min-w-0 flex-1 truncate self-stretch pl-3 text-left font-mono text-[11px] outline-none focus-visible:text-foreground"
                          title={tab.name}
                          onClick={() => {
                            setActiveEditorTabID(tab.id)
                            setWorkspaceView("query")
                          }}
                        >
                          {tab.name}
                        </button>
                        <button
                          type="button"
                          disabled={running}
                          className={cn(
                            "mr-1 grid size-5 shrink-0 place-items-center rounded text-muted-foreground opacity-0 outline-none transition-[color,background-color,opacity,transform] hover:bg-white/[0.06] hover:text-foreground active:scale-90 focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-gr-pink/45 disabled:pointer-events-none motion-reduce:transform-none motion-reduce:transition-none group-hover:opacity-100",
                            active && "opacity-60",
                          )}
                          onClick={() => closeSQLTab(tab.id)}
                        >
                          <X className="size-3" />
                          <span className="sr-only">Close {tab.name}</span>
                        </button>
                      </div>
                    )
                  })}
                </div>
              </div>
              <Button variant="ghost" size="icon-sm" className="mx-1 shrink-0" onClick={() => openSQLTab()}>
                <Plus />
                <span className="sr-only">New SQL tab</span>
              </Button>
            </div>
            <div className="h-[calc(100%-2rem)]">
              {workspaceView === "query" ? (
                <div
                  className="relative h-full"
                  onDragEnter={startSQLFileDrag}
                  onDragOver={continueSQLFileDrag}
                  onDragLeave={endSQLFileDrag}
                  onDrop={dropSQLFiles}
                >
                  <Editor
                    language="pgsql"
                    theme="vs-dark"
                    path={activeEditorTab.path}
                    value={statement}
                    saveViewState
                    keepCurrentModel
                    onChange={(value) => updateActiveSQL(value ?? "")}
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
                  <div
                    aria-hidden={!sqlFileDragging}
                    className={cn(
                      "pointer-events-none absolute inset-3 z-30 grid place-items-center rounded-xl border-2 border-dashed bg-[#100d16]/88 opacity-0 shadow-2xl shadow-gr-purple/15 backdrop-blur-sm transition-[opacity,transform,border-color] duration-150 motion-reduce:transition-none",
                      sqlFileDragging && "scale-[0.995] border-gr-pink/70 opacity-100",
                    )}
                  >
                    <div className="text-center">
                      <FileCode2 className="mx-auto size-8 text-gr-pink drop-shadow-[0_0_14px_rgba(225,5,163,0.25)]" />
                      <p className="mt-3 text-sm font-medium">Drop SQL files to open tabs</p>
                      <p className="mt-1 text-[11px] text-muted-foreground">Each file opens in its own editor buffer</p>
                    </div>
                  </div>
                </div>
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
                <Columns3 /> Results
                {batchRuns.length > 0
                  ? <span className="text-muted-foreground">{finishedBatchRunCount}/{batchRuns.length}</span>
                  : result && <span className="text-muted-foreground">{result.row_count}</span>}
              </BottomTab>
              <BottomTab active={bottomTab === "history"} onClick={() => selectBottomTab("history")}>
                <Clock3 /> History
              </BottomTab>
              <div className="ml-auto min-w-0 truncate px-2 text-[11px] text-muted-foreground">
                {bottomTab === "results" && selectedBatchRun
                  ? `Statement ${selectedBatchRun.statementNumber} · ${batchRunStatusLabel(selectedBatchRun.status)}`
                  : result && bottomTab === "results" && `${result.database_name} · ${result.command_tag || "Query"} · ${result.duration_ms} ms`}
              </div>
              <div className={cn("flex h-7 shrink-0 overflow-hidden rounded-md border", !isAdmin && "opacity-45")}>
                <Button
                  variant="ghost"
                  size="sm"
                  className="rounded-none border-r"
                  disabled={!isAdmin || !selectedTarget || !activeDatabaseName || workspaceView !== "query" || !statement.trim()}
                  onClick={openExportPreview}
                >
                  <Download />
                  <span className="hidden sm:inline">Export</span>
                  <span className="sr-only sm:hidden">Preview export</span>
                </Button>
                <Select value={exportFormat} onValueChange={(value) => setExportFormat(value as ExportFormat)} disabled={!isAdmin || workspaceView !== "query"}>
                  <SelectTrigger className="h-7 w-[76px] rounded-none border-0 bg-transparent px-2 font-mono text-[9px] uppercase focus:ring-0" aria-label="Export format">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="csv">CSV</SelectItem>
                    <SelectItem value="json">JSON</SelectItem>
                    <SelectItem value="parquet">Parquet</SelectItem>
                    <SelectItem value="sql">SQL</SelectItem>
                  </SelectContent>
                </Select>
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
                <div key={batchRuns.length > 0 ? "batch" : running ? "running" : result?.run_id ?? queryError} className="h-full motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-200">
                  <ResultsPanel
                    result={result}
                    error={queryError}
                    running={running}
                    batchRuns={batchRuns}
                    selectedBatchRunIndex={selectedBatchRunIndex}
                    onSelectBatchRun={setSelectedBatchRunIndex}
                  />
                </div>
              ) : (
                <HistoryPanel
                  runs={historyQuery.data ?? []}
                  loading={historyQuery.isLoading}
                  onSelect={(run) => {
                    setSelectedTargetID(run.target_id)
                    setDatabaseSelection({ targetID: run.target_id, databaseName: run.database_name })
                    openSQLTab(run.statement, "history.sql")
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
      {importDialogOpen && selectedTarget && activeDatabaseName && (
        <Suspense fallback={null}>
          <DataImportDialog
            key={`${selectedTarget.id}:${activeDatabaseName}`}
            open
            onOpenChange={setImportDialogOpen}
            target={selectedTarget}
            databaseName={activeDatabaseName}
            tables={catalogQuery.data?.tables ?? []}
            onImported={(imports: CompletedImport[]) => {
              const rowCount = imports.reduce((total, item) => total + item.result.row_count, 0)
              const errorCount = imports.reduce((total, item) => total + item.result.error_count, 0)
              const message = `${rowCount.toLocaleString()} rows imported across ${imports.length} table${imports.length === 1 ? "" : "s"}`
              if (errorCount > 0) toast.warning(`${message} · ${errorCount.toLocaleString()} skipped`)
              else toast.success(message)
            }}
          />
        </Suspense>
      )}
      {bulkExportDialogOpen && selectedTarget && activeDatabaseName && (
        <Suspense fallback={null}>
          <BulkExportDialog
            key={`${selectedTarget.id}:${activeDatabaseName}`}
            open
            onOpenChange={setBulkExportDialogOpen}
            target={selectedTarget}
            databaseName={activeDatabaseName}
            tables={catalogQuery.data?.tables ?? []}
            format={exportFormat}
            onFormatChange={setExportFormat}
          />
        </Suspense>
      )}
      {exportDialogOpen && selectedTarget && activeDatabaseName && exportStatement && (
        <Suspense fallback={null}>
          <ExportDialog
            open
            onOpenChange={setExportDialogOpen}
            target={selectedTarget}
            databaseName={activeDatabaseName}
            statement={exportStatement}
            sourceName={exportSourceName}
            format={exportFormat}
            onFormatChange={setExportFormat}
          />
        </Suspense>
      )}
      {ddlTable && selectedTarget && activeDatabaseName && (
        <Suspense fallback={null}>
          <DDLDialog
            open
            onOpenChange={(open) => !open && setDDLTable(null)}
            target={selectedTarget}
            databaseName={activeDatabaseName}
            table={ddlTable}
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

function SessionModeControl({
  mode,
  isAdmin,
  disabled,
  error,
  attentionKey,
  onModeChange,
}: {
  mode: SessionMode
  isAdmin: boolean
  disabled: boolean
  error: string
  attentionKey: number
  onModeChange: (mode: SessionMode) => void
}) {
  const helperVisible = Boolean(error) || !isAdmin || mode === "write"
  const helperMessage = error
    || (!isAdmin
      ? "WorkbenchAdmins membership is required for writes."
      : "Writes and schema changes are enabled for this session.")

  return (
    <div className="shrink-0 border-t bg-[#0d0c11] p-2">
      <div
        key={attentionKey}
        className={cn(
          "rounded-lg border bg-black/20 p-2 transition-[border-color,background-color,box-shadow] duration-500 ease-out",
          mode === "write"
            ? "border-gr-pink/20 shadow-[0_0_20px_rgba(225,5,163,0.045)]"
            : "border-gr-purple/20 shadow-[0_0_20px_rgba(132,18,252,0.04)]",
          error && "workbench-mode-shake border-destructive/40 bg-destructive/[0.06] shadow-[0_0_18px_rgba(255,91,113,0.08)]",
        )}
      >
        <div className="mb-2 flex items-center gap-2 px-0.5">
          <div
            key={mode}
            className={cn(
              "workbench-mode-dot-enter size-1.5 rounded-full transition-[background-color,box-shadow] duration-500",
              mode === "write"
                ? "bg-gr-pink shadow-[0_0_9px_rgba(225,5,163,0.55)]"
                : "bg-gr-purple shadow-[0_0_9px_rgba(132,18,252,0.5)]",
            )}
          />
          <span className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">Query session</span>
          <span
            key={`label-${mode}`}
            className={cn(
              "workbench-mode-status-enter ml-auto font-mono text-[9px] font-semibold",
              mode === "write" ? "text-pink-200" : "text-purple-200",
            )}
          >
            {mode === "write" ? "WRITE" : "READ ONLY"}
          </span>
        </div>
        <div
          role="group"
          aria-label="Query session mode"
          className="relative isolate grid grid-cols-2 overflow-hidden rounded-md border bg-black/25 p-0.5"
        >
          <span
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute top-0.5 bottom-0.5 left-0.5 z-0 w-[calc(50%_-_0.125rem)] rounded-[5px] transition-[translate,background-color,box-shadow] duration-500 [transition-timing-function:cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
              mode === "write"
                ? "translate-x-full bg-gr-pink/15 shadow-[inset_0_0_0_1px_rgba(225,5,163,0.18),0_0_14px_rgba(225,5,163,0.09)]"
                : "translate-x-0 bg-gr-purple/15 shadow-[inset_0_0_0_1px_rgba(132,18,252,0.18),0_0_14px_rgba(132,18,252,0.08)]",
            )}
          />
          <button
            type="button"
            aria-pressed={mode === "read"}
            disabled={disabled}
            className={cn(
              "relative z-10 flex h-7 items-center justify-center gap-1.5 rounded text-[10px] font-medium text-muted-foreground outline-none transition-[color,transform] duration-300 hover:text-foreground active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-gr-purple/45 disabled:pointer-events-none disabled:opacity-50 motion-reduce:transform-none motion-reduce:transition-none [&_svg]:transition-transform [&_svg]:duration-500",
              mode === "read" && "text-purple-100 [&_svg]:scale-110",
            )}
            onClick={() => onModeChange("read")}
          >
            <LockKeyhole className="size-3" /> Read only
          </button>
          <button
            type="button"
            aria-pressed={mode === "write"}
            aria-disabled={!isAdmin || disabled}
            disabled={!isAdmin || disabled}
            className={cn(
              "relative z-10 flex h-7 items-center justify-center gap-1.5 rounded text-[10px] font-medium text-muted-foreground outline-none transition-[color,transform] duration-300 hover:text-foreground active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-gr-pink/45 disabled:pointer-events-none disabled:opacity-35 motion-reduce:transform-none motion-reduce:transition-none [&_svg]:transition-transform [&_svg]:duration-500",
              mode === "write" && "text-pink-100 [&_svg]:scale-110",
            )}
            onClick={() => onModeChange("write")}
          >
            <PenLine className="size-3" /> Write
          </button>
        </div>
        <div
          className={cn(
            "grid transition-[grid-template-rows,opacity,margin-top] duration-400 [transition-timing-function:cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
            helperVisible ? "mt-2 grid-rows-[1fr] opacity-100" : "mt-0 grid-rows-[0fr] opacity-0",
          )}
        >
          <div className="min-h-0 overflow-hidden">
            <p
              role={error ? "alert" : undefined}
              aria-hidden={!helperVisible}
              className={cn(
                "px-0.5 text-[10px] leading-relaxed",
                error ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {helperMessage}
            </p>
          </div>
        </div>
      </div>
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
  onBulkExportDatabase,
  onImportDatabase,
  onOpenTable,
  onViewDDL,
  onExportTable,
  onCopyQualifiedName,
  onCopySelect,
  canExport,
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
  onBulkExportDatabase: (databaseName: string) => void
  onImportDatabase: (databaseName: string) => void
  onOpenTable: (table: CatalogTable) => void
  onViewDDL: (table: CatalogTable) => void
  onExportTable: (table: CatalogTable) => void
  onCopyQualifiedName: (table: CatalogTable) => void
  onCopySelect: (table: CatalogTable) => void
  canExport: boolean
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
                <ContextMenu>
                  <ContextMenuTrigger asChild>
                    <button
                      className={cn("flex h-8 w-full items-center gap-1.5 pr-2 pl-6 text-xs text-muted-foreground transition-colors duration-150 hover:bg-muted/40 hover:text-foreground data-[state=open]:bg-muted/55 data-[state=open]:text-foreground motion-reduce:transition-none", active && "sticky top-8 z-20 bg-[#121017]/95 text-foreground shadow-sm backdrop-blur-md")}
                      onClick={() => onSelectDatabase(database.name)}
                    >
                      <ChevronRight className={cn("size-3.5 transition-transform duration-200 ease-out motion-reduce:transition-none", active && "rotate-90")} />
                      <Database className={cn("size-3.5", active && "text-gr-pink")} />
                      <span className="truncate font-mono text-[11px]" title={database.name}>{database.name}</span>
                    </button>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem disabled={!canExport} onSelect={() => onBulkExportDatabase(database.name)}>
                      <Download /> Export tables
                      {!canExport && <ContextMenuShortcut>ADMIN</ContextMenuShortcut>}
                    </ContextMenuItem>
                    <ContextMenuItem disabled={!canExport} onSelect={() => onImportDatabase(database.name)}>
                      <Upload /> Import CSV files
                      {!canExport && <ContextMenuShortcut>ADMIN</ContextMenuShortcut>}
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
                {active && (
                  <div className="pl-10">
                    {catalogLoading && <SidebarMessage>Loading objects…</SidebarMessage>}
                    {!catalogLoading && Array.from(schemas.entries()).map(([schema, tables]) => (
                      <SchemaTree
                        key={schema}
                        schema={schema}
                        tables={tables}
                        onOpenTable={onOpenTable}
                        onViewDDL={onViewDDL}
                        onExportTable={onExportTable}
                        onCopyQualifiedName={onCopyQualifiedName}
                        onCopySelect={onCopySelect}
                        canExport={canExport}
                      />
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

function SchemaTree({
  schema,
  tables,
  onOpenTable,
  onViewDDL,
  onExportTable,
  onCopyQualifiedName,
  onCopySelect,
  canExport,
}: {
  schema: string
  tables: CatalogTable[]
  onOpenTable: (table: CatalogTable) => void
  onViewDDL: (table: CatalogTable) => void
  onExportTable: (table: CatalogTable) => void
  onCopyQualifiedName: (table: CatalogTable) => void
  onCopySelect: (table: CatalogTable) => void
  canExport: boolean
}) {
  const [expanded, setExpanded] = useState(true)
  return (
    <div>
      <button className="sticky top-16 z-10 flex h-7 w-full items-center gap-1.5 bg-[#0f0e13]/95 px-1 text-xs text-muted-foreground shadow-sm backdrop-blur-md transition-colors duration-150 hover:text-foreground motion-reduce:transition-none" onClick={() => setExpanded(!expanded)}>
        <ChevronRight className={cn("size-3.5 transition-transform duration-200 ease-out motion-reduce:transition-none", expanded && "rotate-90")} />
        <span className="font-mono text-[11px]">{schema}</span>
      </button>
      {expanded &&
        tables.map((table) => (
          <ContextMenu key={table.name}>
            <ContextMenuTrigger asChild>
              <button className="flex h-7 w-full items-center gap-2 pr-2 pl-6 text-xs text-muted-foreground transition-colors duration-150 hover:bg-muted/40 hover:text-foreground data-[state=open]:bg-muted/55 data-[state=open]:text-foreground motion-reduce:transition-none" onClick={() => onOpenTable(table)}>
                <Table2 className="size-3.5" />
                <span className="truncate">{table.name}</span>
              </button>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onSelect={() => onOpenTable(table)}>
                <Play /> Open query
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => onViewDDL(table)}>
                <FileCode2 /> View DDL
              </ContextMenuItem>
              <ContextMenuItem disabled={!canExport} onSelect={() => onExportTable(table)}>
                <Download /> Export table
                {!canExport && <ContextMenuShortcut>ADMIN</ContextMenuShortcut>}
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => onCopyQualifiedName(table)}>
                <Copy /> Copy qualified name
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => onCopySelect(table)}>
                <Copy /> Copy SELECT statement
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        ))}
    </div>
  )
}

function ResultsPanel({
  result,
  error,
  running,
  batchRuns,
  selectedBatchRunIndex,
  onSelectBatchRun,
}: {
  result: QueryResult | null
  error: string
  running: boolean
  batchRuns: BatchQueryRun[]
  selectedBatchRunIndex: number
  onSelectBatchRun: (index: number) => void
}) {
  if (batchRuns.length > 0) {
    return (
      <BatchResultsPanel
        runs={batchRuns}
        selectedIndex={selectedBatchRunIndex}
        onSelect={onSelectBatchRun}
      />
    )
  }
  if (running) return <CenteredMessage>Running query…</CenteredMessage>
  if (error) return <div className="m-4 rounded-md border border-destructive/30 bg-destructive/10 p-3 font-mono text-xs text-destructive">{error}</div>
  if (!result) return <CenteredMessage>Run a query to see results</CenteredMessage>
  return <QueryResultView result={result} />
}

function BatchResultsPanel({ runs, selectedIndex, onSelect }: { runs: BatchQueryRun[]; selectedIndex: number; onSelect: (index: number) => void }) {
  const selectedRun = runs[selectedIndex] ?? runs[0]
  return (
    <div className="grid h-full min-h-0 grid-rows-[38px_minmax(0,1fr)]">
      <div className="flex min-w-0 gap-1 overflow-x-auto border-b bg-[#0d0c11] px-2 py-1.5">
        {runs.map((run, index) => (
          <button
            key={index}
            className={cn(
              "flex max-w-48 shrink-0 items-center gap-2 rounded-md px-2.5 text-left font-mono text-[10px] transition-colors duration-150 motion-reduce:transition-none",
              index === selectedIndex ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/45 hover:text-foreground",
            )}
            onClick={() => onSelect(index)}
          >
            <span className={cn("size-1.5 shrink-0 rounded-full", batchRunStatusColor(run.status))} />
            <span className="shrink-0 font-semibold">{run.statementNumber}</span>
            <span className="truncate">{run.statement.replace(/\s+/g, " ")}</span>
          </button>
        ))}
      </div>
      <div className="min-h-0 overflow-auto">
        {selectedRun.status === "running" && <CenteredMessage>Running statement {selectedRun.statementNumber}…</CenteredMessage>}
        {selectedRun.status === "queued" && <CenteredMessage>Waiting to run</CenteredMessage>}
        {selectedRun.status === "skipped" && <CenteredMessage>Skipped after an earlier statement failed</CenteredMessage>}
        {selectedRun.status === "cancelled" && <CenteredMessage>Cancelled</CenteredMessage>}
        {selectedRun.status === "failed" && (
          <div className="m-4 rounded-md border border-destructive/30 bg-destructive/10 p-3 font-mono text-xs text-destructive">{selectedRun.error}</div>
        )}
        {selectedRun.status === "succeeded" && selectedRun.result && <QueryResultView result={selectedRun.result} />}
      </div>
    </div>
  )
}

function QueryResultView({ result }: { result: QueryResult }) {
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

function batchRunStatusLabel(status: BatchRunStatus) {
  const labels: Record<BatchRunStatus, string> = {
    queued: "Queued",
    running: "Running",
    succeeded: "Succeeded",
    failed: "Failed",
    cancelled: "Cancelled",
    skipped: "Skipped",
  }
  return labels[status]
}

function batchRunStatusColor(status: BatchRunStatus) {
  if (status === "succeeded") return "bg-emerald-400"
  if (status === "failed") return "bg-destructive"
  if (status === "running") return "animate-pulse bg-gr-pink"
  if (status === "cancelled") return "bg-amber-300"
  return "bg-muted-foreground/45"
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

function statementRangeKey(range: SQLStatementRange | null) {
  return range ? `${range.start}:${range.end}` : ""
}
