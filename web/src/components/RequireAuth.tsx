import { Navigate, Outlet, useLocation } from "react-router-dom"

import { DatabaseZap } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useAuth } from "@/lib/auth"

export function RequireAuth() {
  const location = useLocation()
  const { hasWorkbenchAccess, isAuthenticated, isLoading, logout } = useAuth()

  if (isLoading) {
    return (
      <main className="relative flex h-full items-center justify-center overflow-hidden bg-black">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_34%_26%,rgba(132,18,252,0.22),transparent_35%),radial-gradient(circle_at_69%_68%,rgba(225,5,163,0.16),transparent_38%)]" />
        <div className="relative flex items-center gap-2 text-sm text-muted-foreground">
          <span className="size-2 animate-pulse rounded-full bg-gradient-to-r from-gr-purple to-gr-pink shadow-[0_0_18px_rgba(225,5,163,0.45)]" />
          Opening Workbench
        </div>
      </main>
    )
  }
  if (!isAuthenticated) {
    return <Navigate to="/auth/login" state={{ from: location }} replace />
  }
  if (!hasWorkbenchAccess) {
    return (
      <main className="relative flex h-full items-center justify-center overflow-hidden bg-black px-6">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_34%_26%,rgba(132,18,252,0.18),transparent_35%),radial-gradient(circle_at_69%_68%,rgba(225,5,163,0.13),transparent_38%)]" />
        <div className="relative flex max-w-sm flex-col items-center text-center">
          <div className="mb-5 grid size-12 place-items-center rounded-xl border border-white/10 bg-gradient-to-br from-gr-purple to-gr-pink shadow-2xl shadow-gr-purple/20">
            <DatabaseZap className="size-6 text-white" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">Workbench access required</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Your Sentinel account is not a member of WorkbenchViewers or WorkbenchAdmins.
          </p>
          <Button className="mt-6" variant="secondary" onClick={logout}>Sign in again</Button>
        </div>
      </main>
    )
  }
  return <Outlet />
}
