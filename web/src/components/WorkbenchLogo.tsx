import type { ComponentProps } from "react"

import { cn } from "@/lib/utils"

type WorkbenchLogoProps = Omit<ComponentProps<"img">, "alt" | "src">

export function WorkbenchLogo({ className, ...props }: WorkbenchLogoProps) {
  return (
    <img
      src="/workbench.png"
      alt=""
      aria-hidden="true"
      draggable={false}
      className={cn("shrink-0 select-none", className)}
      {...props}
    />
  )
}
