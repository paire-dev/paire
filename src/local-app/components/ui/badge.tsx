import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "../../lib/utils";

const badgeVariants = cva("ui-badge", {
  variants: {
    variant: {
      default: "ui-badge-default",
      secondary: "ui-badge-secondary",
      destructive: "ui-badge-destructive",
      outline: "ui-badge-outline",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
