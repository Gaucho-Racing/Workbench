import type { editor } from "monaco-editor"

export type SQLStatementRange = {
  start: number
  end: number
}

export function qualifiedSQLIdentifier(schema: string, relation: string) {
  return `${quoteSQLIdentifier(schema)}.${quoteSQLIdentifier(relation)}`
}

export function selectStatementForTable(schema: string, relation: string, limit?: number) {
  const limitClause = limit === undefined ? ";" : `\nlimit ${limit};`
  return `select *\nfrom ${qualifiedSQLIdentifier(schema, relation)}${limitClause}`
}

function quoteSQLIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`
}

export function statementForEditor(instance: editor.IStandaloneCodeEditor | null, fallback: string) {
  const model = instance?.getModel()
  if (!instance || !model) return fallback.trim()
  const range = statementRangeForEditor(instance)
  return range ? model.getValue().slice(range.start, range.end).trim() : fallback.trim()
}

export function statementRangeForEditor(instance: editor.IStandaloneCodeEditor | null): SQLStatementRange | null {
  const model = instance?.getModel()
  if (!instance || !model) return null

  const selection = instance.getSelection()
  if (selection && !selection.isEmpty() && model.getValueInRange(selection).trim()) {
    return trimRange(
      model.getValue(),
      model.getOffsetAt(selection.getStartPosition()),
      model.getOffsetAt(selection.getEndPosition()),
    )
  }

  const position = instance.getPosition()
  return position ? statementRangeAtOffset(model.getValue(), model.getOffsetAt(position)) : null
}

export function statementRangeAtOffset(sql: string, offset: number): SQLStatementRange | null {
  const ranges = sqlStatementRanges(sql)
  if (ranges.length === 0) return null

  const boundedOffset = Math.min(sql.length, Math.max(0, offset))
  let nearest = ranges[0]
  let nearestDistance = distanceToRange(boundedOffset, nearest)
  for (let index = 1; index < ranges.length; index += 1) {
    const distance = distanceToRange(boundedOffset, ranges[index])
    if (distance < nearestDistance) {
      nearest = ranges[index]
      nearestDistance = distance
    }
  }
  return nearest
}

export function sqlStatementRanges(sql: string): SQLStatementRange[] {
  const ranges: SQLStatementRange[] = []
  let statementStart = 0
  let hasExecutableContent = false
  let index = 0
  let blockCommentDepth = 0
  let dollarDelimiter = ""
  let state: "normal" | "single-quote" | "double-quote" | "line-comment" | "block-comment" | "dollar-quote" = "normal"

  while (index < sql.length) {
    const current = sql[index]
    const next = sql[index + 1]

    if (state === "line-comment") {
      if (current === "\n") state = "normal"
      index += 1
      continue
    }

    if (state === "block-comment") {
      if (current === "/" && next === "*") {
        blockCommentDepth += 1
        index += 2
      } else if (current === "*" && next === "/") {
        blockCommentDepth -= 1
        index += 2
        if (blockCommentDepth === 0) state = "normal"
      } else {
        index += 1
      }
      continue
    }

    if (state === "single-quote") {
      if (current === "'" && next === "'") {
        index += 2
      } else if (current === "\\") {
        index += Math.min(2, sql.length - index)
      } else {
        index += 1
        if (current === "'") state = "normal"
      }
      continue
    }

    if (state === "double-quote") {
      if (current === '"' && next === '"') {
        index += 2
      } else {
        index += 1
        if (current === '"') state = "normal"
      }
      continue
    }

    if (state === "dollar-quote") {
      if (sql.startsWith(dollarDelimiter, index)) {
        index += dollarDelimiter.length
        state = "normal"
      } else {
        index += 1
      }
      continue
    }

    if (current === "-" && next === "-") {
      state = "line-comment"
      index += 2
      continue
    }
    if (current === "/" && next === "*") {
      state = "block-comment"
      blockCommentDepth = 1
      index += 2
      continue
    }
    if (current === "'") {
      state = "single-quote"
      hasExecutableContent = true
      index += 1
      continue
    }
    if (current === '"') {
      state = "double-quote"
      hasExecutableContent = true
      index += 1
      continue
    }
    if (current === "$") {
      const delimiter = dollarQuoteDelimiter(sql, index)
      if (delimiter) {
        state = "dollar-quote"
        dollarDelimiter = delimiter
        hasExecutableContent = true
        index += delimiter.length
        continue
      }
    }
    if (current === ";") {
      if (hasExecutableContent) ranges.push(trimRange(sql, statementStart, index + 1))
      statementStart = index + 1
      hasExecutableContent = false
      index += 1
      continue
    }
    if (!/\s/.test(current)) hasExecutableContent = true
    index += 1
  }

  if (hasExecutableContent) ranges.push(trimRange(sql, statementStart, sql.length))
  return ranges
}

function dollarQuoteDelimiter(sql: string, offset: number) {
  const closingDollar = sql.indexOf("$", offset + 1)
  if (closingDollar === -1) return ""
  const tag = sql.slice(offset + 1, closingDollar)
  if (tag !== "" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tag)) return ""
  return sql.slice(offset, closingDollar + 1)
}

function trimRange(sql: string, start: number, end: number): SQLStatementRange {
  while (start < end && /\s/.test(sql[start])) start += 1
  while (end > start && /\s/.test(sql[end - 1])) end -= 1
  return { start, end }
}

function distanceToRange(offset: number, range: SQLStatementRange) {
  if (offset < range.start) return range.start - offset
  if (offset > range.end) return offset - range.end
  return 0
}
