import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { ServerDatabase } from "@/lib/database"

type DatabasePickerProps = {
  databases: ServerDatabase[]
  value: string
  onValueChange: (value: string) => void
}

export function DatabasePicker({ databases, value, onValueChange }: DatabasePickerProps) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger className="h-7 min-w-32 border-transparent bg-transparent px-1.5 font-mono text-[11px] hover:bg-muted/50" aria-label="Active database">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {databases.map((database) => (
          <SelectItem key={database.name} value={database.name}>{database.name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
