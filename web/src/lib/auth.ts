import { useQuery, useQueryClient } from "@tanstack/react-query"

import { api } from "@/lib/api"

const SESSION_KEY = "workbench_session"

export const WORKBENCH_VIEWER_GROUP = "WorkbenchViewers"
export const WORKBENCH_ADMIN_GROUP = "WorkbenchAdmins"

export type Session = {
  accessToken: string
  refreshToken: string
  expiresIn: number
}

export type CurrentUser = {
  id: string
  entity_id: string
  username: string
  first_name: string
  last_name: string
  email: string
  avatar_url: string
  groups: string[]
}

type WorkbenchSession = {
  entity_id: string
  user_id: string
  client_id: string
  groups: string[]
}

export function saveSession(session: Session) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session))
}

export function loadSession(): Session | null {
  const raw = localStorage.getItem(SESSION_KEY)
  if (!raw) return null
  try {
    const session = JSON.parse(raw) as Partial<Session>
    if (!session.accessToken || !session.refreshToken) {
      clearSession()
      return null
    }
    return {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresIn: Number(session.expiresIn) || 0,
    }
  } catch {
    clearSession()
    return null
  }
}

export function clearSession() {
  localStorage.removeItem(SESSION_KEY)
}

export function useAuth() {
  const queryClient = useQueryClient()
  const tokenSession = loadSession()
  const userQuery = useQuery({
    queryKey: ["currentUser", tokenSession?.accessToken],
    queryFn: async () => (await api.get<CurrentUser>("/users/@me")).data,
    enabled: !!tokenSession?.accessToken,
    retry: false,
    staleTime: 5 * 60 * 1000,
  })
  const sessionQuery = useQuery({
    queryKey: ["authSession", tokenSession?.accessToken],
    queryFn: async () => (await api.get<WorkbenchSession>("/auth/session")).data,
    enabled: !!tokenSession?.accessToken,
    retry: false,
    staleTime: 5 * 60 * 1000,
  })

  function logout() {
    clearSession()
    queryClient.clear()
    window.location.href = "/auth/login"
  }

  const isAdmin = sessionQuery.data?.groups.includes(WORKBENCH_ADMIN_GROUP) ?? false
  const isViewer = sessionQuery.data?.groups.includes(WORKBENCH_VIEWER_GROUP) ?? false

  return {
    user: userQuery.data,
    isLoading: userQuery.isLoading || sessionQuery.isLoading,
    isAuthenticated: !!tokenSession,
    isAdmin,
    isViewer,
    hasWorkbenchAccess: isAdmin || isViewer,
    logout,
  }
}
