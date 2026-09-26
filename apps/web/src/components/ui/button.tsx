import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

/**
 * The one text button. Variants carry the app's existing looks: `default`
 * is the accent fill (was .btn-primary), `secondary` the raised neutral
 * (was .btn), `ghost` and `quiet` the flat ones, `destructive` the red
 * outline. Sizes are the control scale; on touch devices every button
 * grows to a 44px target. Icons inside read 16px with a firmer stroke.
 */
const buttonVariants = cva(
  "tw:group/button tw:inline-flex tw:shrink-0 tw:items-center tw:justify-center tw:gap-2 tw:rounded-lg tw:border tw:border-transparent tw:text-sm tw:font-medium tw:whitespace-nowrap tw:transition-[background-color,border-color,color,box-shadow] tw:duration-100 tw:outline-none tw:select-none tw:focus-visible:ring-2 tw:focus-visible:ring-ring tw:focus-visible:ring-offset-2 tw:focus-visible:ring-offset-background tw:active:translate-y-px tw:disabled:pointer-events-none tw:disabled:opacity-50 tw:pointer-coarse:min-h-11 tw:[&_svg]:pointer-events-none tw:[&_svg]:shrink-0 tw:[&_svg]:stroke-2 tw:[&_svg:not([class*=size-])]:size-4",
  {
    variants: {
      variant: {
        default:
          "tw:border-[color-mix(in_srgb,var(--accent)_55%,#000)] tw:bg-[color-mix(in_srgb,var(--accent)_90%,#000)] tw:text-white tw:shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_1px_1px_rgba(0,0,0,0.28)] tw:hover:bg-(--accent) tw:active:bg-[color-mix(in_srgb,var(--accent)_80%,#000)]",
        secondary:
          "tw:border-(--hairline-strong) tw:bg-(--ink-2) tw:text-(--paper) tw:hover:bg-(--ink-3)",
        ghost: "tw:text-(--paper-dim) tw:hover:bg-(--ink-2) tw:hover:text-(--paper)",
        quiet:
          "tw:text-(--paper-faint) tw:hover:border-(--hairline) tw:hover:text-(--paper-dim)",
        destructive:
          "tw:border-(--danger-dim) tw:bg-(--ink-2) tw:text-(--danger) tw:hover:bg-(--danger-dim)",
        link: "tw:h-auto tw:p-0 tw:text-(--accent) tw:underline-offset-4 tw:hover:underline tw:pointer-coarse:min-h-0",
      },
      size: {
        default: "tw:h-9 tw:px-3.5",
        sm: "tw:h-8 tw:px-3 tw:text-[13px]",
        xs: "tw:h-7 tw:gap-1.5 tw:px-2.5 tw:text-xs tw:[&_svg:not([class*=size-])]:size-3.5",
        lg: "tw:h-10 tw:px-4",
        icon: "tw:size-9",
        "icon-sm": "tw:size-8",
        "icon-lg": "tw:size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
