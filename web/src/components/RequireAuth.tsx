import { Navigate, Outlet, useLocation } from "react-router-dom"

import { useAuth } from "@/lib/auth"

export function RequireAuth() {
  const location = useLocation()
  const { isAuthenticated, isLoading } = useAuth()

  if (isLoading) {
    return (
      <main className="flex h-full items-center justify-center bg-background">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="size-2 animate-pulse rounded-full bg-primary" />
          Opening Workbench
        </div>
      </main>
    )
  }
  if (!isAuthenticated) {
    return <Navigate to="/auth/login" state={{ from: location }} replace />
  }
  return <Outlet />
}

