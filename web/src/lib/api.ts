import axios, { AxiosError, type InternalAxiosRequestConfig } from "axios"

import { clearSession, loadSession, saveSession } from "@/lib/auth"

export const api = axios.create({
  baseURL: `${import.meta.env.VITE_API_URL ?? ""}/api`,
})

type RetriedConfig = InternalAxiosRequestConfig & { _retried?: boolean }

type TokenResponse = {
  access_token: string
  refresh_token: string
  expires_in: number
}

api.interceptors.request.use((request) => {
  const session = loadSession()
  if (session?.accessToken) request.headers.Authorization = `Bearer ${session.accessToken}`
  return request
})

let refreshing: Promise<string | null> | null = null

api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const request = error.config as RetriedConfig | undefined
    const url = request?.url ?? ""
    if (error.response?.status !== 401 || !request || request._retried || url.includes("/auth/")) {
      return Promise.reject(error)
    }
    request._retried = true
    const session = loadSession()
    if (!session?.refreshToken) {
      clearSession()
      window.location.href = "/auth/login"
      return Promise.reject(error)
    }

    refreshing ??= (async () => {
      try {
        const response = await api.post<TokenResponse>("/auth/refresh", {
          refresh_token: session.refreshToken,
        })
        saveSession({
          accessToken: response.data.access_token,
          refreshToken: response.data.refresh_token || session.refreshToken,
          expiresIn: response.data.expires_in,
        })
        return response.data.access_token
      } catch {
        return null
      } finally {
        refreshing = null
      }
    })()

    const accessToken = await refreshing
    if (!accessToken) {
      clearSession()
      window.location.href = "/auth/login"
      return Promise.reject(error)
    }
    request.headers.Authorization = `Bearer ${accessToken}`
    return api(request)
  },
)

export function getErrorMessage(error: unknown) {
  return (
    (error as { response?: { data?: { error?: string } } })?.response?.data?.error ??
    (error instanceof Error ? error.message : "Unexpected error")
  )
}

export function getErrorCode(error: unknown) {
  return (error as { response?: { data?: { code?: string } } })?.response?.data?.code ?? ""
}
