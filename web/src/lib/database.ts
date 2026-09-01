import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"

export type DatabaseTarget = {
  id: string
  name: string
  environment: string
  host: string
  port: number
  database_name: string
  username: string
  ssl_mode: string
  created_at: string
  updated_at: string
}

export type CatalogColumn = {
  name: string
  data_type: string
  nullable: boolean
  primary_key: boolean
}

export type CatalogTable = {
  schema: string
  name: string
  kind: string
  columns: CatalogColumn[]
}

export type CatalogForeignKey = {
  name: string
  source_schema: string
  source_table: string
  source_column: string
  target_schema: string
  target_table: string
  target_column: string
}

export type Catalog = {
  tables: CatalogTable[]
  foreign_keys: CatalogForeignKey[]
}

export type QueryColumn = {
  name: string
  data_type_oid: number
}

export type QueryResult = {
  run_id: string
  columns: QueryColumn[]
  rows: (string | number | boolean | null)[][]
  command_tag: string
  row_count: number
  duration_ms: number
  truncated: boolean
}

export type QueryRun = {
  id: string
  target_id: string
  target_name: string
  statement: string
  status: string
  command_tag: string
  row_count: number
  duration_ms: number
  error_message: string
  created_at: string
}

export function useTargets() {
  return useQuery({
    queryKey: ["targets"],
    queryFn: async () => (await api.get<DatabaseTarget[]>("/targets")).data,
  })
}

export function useCatalog(targetID: string | null) {
  return useQuery({
    queryKey: ["catalog", targetID],
    queryFn: async () => (await api.get<Catalog>(`/targets/${targetID}/catalog`)).data,
    enabled: !!targetID,
    staleTime: 60_000,
  })
}

export function useQueryHistory() {
  return useQuery({
    queryKey: ["queryHistory"],
    queryFn: async () => (await api.get<QueryRun[]>("/queries")).data,
  })
}
