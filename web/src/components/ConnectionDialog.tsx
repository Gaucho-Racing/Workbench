import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import type { FormEvent } from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { api, getErrorMessage } from "@/lib/api"
import type { DatabaseTarget } from "@/lib/database"

type ConnectionDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (target: DatabaseTarget) => void
}

const initialForm = {
  name: "",
  environment: "DEV",
  host: "",
  port: "5432",
  database_name: "",
  username: "",
  password: "",
  ssl_mode: "require",
}

export function ConnectionDialog({ open, onOpenChange, onCreated }: ConnectionDialogProps) {
  const queryClient = useQueryClient()
  const [form, setForm] = useState(initialForm)
  const mutation = useMutation({
    mutationFn: async () =>
      (
        await api.post<DatabaseTarget>("/targets", {
          ...form,
          port: Number(form.port),
        })
      ).data,
    onSuccess: async (target) => {
      await queryClient.invalidateQueries({ queryKey: ["targets"] })
      setForm(initialForm)
      onOpenChange(false)
      onCreated(target)
    },
  })

  function update(field: keyof typeof form, value: string) {
    setForm((current) => ({ ...current, [field]: value }))
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    mutation.mutate()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New database connection</DialogTitle>
          <DialogDescription>
            Credentials are encrypted before they are stored. The connection is tested before it is saved.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit}>
          <div className="grid grid-cols-[1fr_120px] gap-3">
            <Field label="Name">
              <Input value={form.name} onChange={(event) => update("name", event.target.value)} placeholder="Sentinel" required />
            </Field>
            <Field label="Environment">
              <Select value={form.environment} onValueChange={(value) => update("environment", value)}>
                <SelectTrigger aria-label="Environment"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="DEV">DEV</SelectItem>
                  <SelectItem value="STAGING">STAGING</SelectItem>
                  <SelectItem value="PROD">PROD</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
          <div className="grid grid-cols-[1fr_100px] gap-3">
            <Field label="Host">
              <Input value={form.host} onChange={(event) => update("host", event.target.value)} placeholder="postgres.internal" required />
            </Field>
            <Field label="Port">
              <Input inputMode="numeric" pattern="[0-9]*" maxLength={5} value={form.port} onChange={(event) => update("port", event.target.value.replace(/\D/g, ""))} required />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Database">
              <Input value={form.database_name} onChange={(event) => update("database_name", event.target.value)} required />
            </Field>
            <Field label="User">
              <Input value={form.username} onChange={(event) => update("username", event.target.value)} required />
            </Field>
          </div>
          <div className="grid grid-cols-[1fr_140px] gap-3">
            <Field label="Password">
              <Input type="password" value={form.password} onChange={(event) => update("password", event.target.value)} required />
            </Field>
            <Field label="TLS mode">
              <Select value={form.ssl_mode} onValueChange={(value) => update("ssl_mode", value)}>
                <SelectTrigger aria-label="TLS mode"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="require">Require</SelectItem>
                  <SelectItem value="verify-full">Verify full</SelectItem>
                  <SelectItem value="verify-ca">Verify CA</SelectItem>
                  <SelectItem value="prefer">Prefer</SelectItem>
                  <SelectItem value="disable">Disable</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
          {mutation.isError && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {getErrorMessage(mutation.error)}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? "Testing connection…" : "Connect"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1.5">
      <Label>{label}</Label>
      {children}
    </label>
  )
}
