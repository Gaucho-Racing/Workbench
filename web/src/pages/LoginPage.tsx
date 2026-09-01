import { DatabaseZap, LoaderCircle } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useLocation, useNavigate, useSearchParams } from "react-router-dom"

import { api, getErrorMessage } from "@/lib/api"
import { clearSession, saveSession } from "@/lib/auth"

const sentinelURL = import.meta.env.VITE_SENTINEL_URL ?? "https://sso.gauchoracing.com"
const sentinelClientID = import.meta.env.VITE_SENTINEL_CLIENT_ID ?? ""
const oauthConfigurationError = sentinelClientID
  ? ""
  : "Workbench OAuth is not configured. Set VITE_SENTINEL_CLIENT_ID before building the web application."

type TokenResponse = {
  access_token: string
  refresh_token: string
  expires_in: number
}

export default function LoginPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const exchanged = useRef(false)
  const redirected = useRef(false)
  const [error, setError] = useState(
    searchParams.has("error") ? "Sentinel sign-on was not completed." : oauthConfigurationError,
  )
  const source = (location.state as { from?: { pathname: string } } | null)?.from?.pathname ?? "/"

  useEffect(() => {
    if (exchanged.current) return
    const code = searchParams.get("code")
    if (!code) {
      if (searchParams.has("error")) {
        return
      }
      if (!sentinelClientID) {
        return
      }
      if (redirected.current) return
      redirected.current = true
      const params = new URLSearchParams({
        client_id: sentinelClientID,
        response_type: "code",
        redirect_uri: `${window.location.origin}/auth/login`,
        scope: "user:read groups:read",
        prompt: "none",
        state: sanitizeReturnTo(source),
      })
      window.location.href = `${sentinelURL.replace(/\/+$/, "")}/oauth/authorize?${params.toString()}`
      return
    }
    exchanged.current = true
    void (async () => {
      try {
        const response = await api.post<TokenResponse>(`/auth/login?code=${encodeURIComponent(code)}`)
        saveSession({
          accessToken: response.data.access_token,
          refreshToken: response.data.refresh_token,
          expiresIn: response.data.expires_in,
        })
        navigate(sanitizeReturnTo(searchParams.get("state") || source), { replace: true })
      } catch (requestError) {
        clearSession()
        setError(getErrorMessage(requestError))
      }
    })()
  }, [navigate, searchParams, source])

  return (
    <main className="relative flex h-full items-center justify-center overflow-hidden bg-background px-6">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_30%,rgba(159,76,255,0.12),transparent_38%)]" />
      <div className="relative flex w-full max-w-sm flex-col items-center text-center">
        <div className="mb-5 grid size-12 place-items-center rounded-xl border bg-card shadow-2xl shadow-primary/10">
          <DatabaseZap className="size-6 text-primary" />
        </div>
        <h1 className="text-xl font-semibold tracking-tight">Workbench</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">Gaucho Racing database console</p>
        {error ? (
          <div className="mt-6 w-full rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        ) : (
          <div className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
            Connecting to Sentinel
          </div>
        )}
      </div>
    </main>
  )
}

function sanitizeReturnTo(value: string) {
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/api/")) return "/"
  return value
}
