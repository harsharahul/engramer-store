import * as React from "react"
import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

/**
 * The one icon-only button (was .icon-btn). It always carries a label for
 * assistive tech and, unless a title is given, the same words as a
 * tooltip. `sm` (32px) is the dense-row size, `md` (36px) the toolbar
 * capsule's, `lg` (40px) the touch size every smaller one grows to on
 * coarse pointers. A pressed toggle (aria-pressed) reads in the accent.
 */
const iconButtonVariants = cva(
  "tw:inline-flex tw:shrink-0 tw:items-center tw:justify-center tw:rounded-lg tw:text-(--paper-dim) tw:transition-[background-color,color] tw:duration-100 tw:outline-none tw:select-none tw:hover:bg-(--ink-3) tw:hover:text-(--paper) tw:focus-visible:ring-2 tw:focus-visible:ring-ring tw:focus-visible:ring-offset-2 tw:focus-visible:ring-offset-background tw:disabled:pointer-events-none tw:disabled:opacity-50 tw:aria-pressed:bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] tw:aria-pressed:text-(--accent) tw:[&_svg]:pointer-events-none tw:[&_svg]:shrink-0",
  {
    variants: {
      size: {
        sm: "tw:size-8 tw:pointer-coarse:size-10",
        md: "tw:size-9 tw:pointer-coarse:size-10",
        lg: "tw:size-10",
      },
      tone: {
        default: "",
        accent: "tw:text-(--accent) tw:hover:text-(--accent)",
        danger: "tw:hover:bg-(--danger-dim) tw:hover:text-(--danger)",
      },
    },
    defaultVariants: {
      size: "sm",
      tone: "default",
    },
  }
)

type IconButtonProps = ButtonPrimitive.Props &
  VariantProps<typeof iconButtonVariants> & {
    /** What the button does, for assistive tech and the default tooltip. */
    label: string
    children: React.ReactNode
  }

function IconButton({ className, size, tone, label, title, ...props }: IconButtonProps) {
  return (
    <ButtonPrimitive
      data-slot="icon-button"
      aria-label={label}
      title={title ?? label}
      className={cn(iconButtonVariants({ size, tone, className }))}
      {...props}
    />
  )
}

export { IconButton, iconButtonVariants }
