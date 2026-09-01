import { createBrowserRouter } from "react-router-dom"

import { RequireAuth } from "@/components/RequireAuth"
import LoginPage from "@/pages/LoginPage"
import WorkbenchPage from "@/pages/WorkbenchPage"

export const router = createBrowserRouter([
  {
    element: <RequireAuth />,
    children: [{ path: "*", element: <WorkbenchPage /> }],
  },
  { path: "/auth/login", element: <LoginPage /> },
])

