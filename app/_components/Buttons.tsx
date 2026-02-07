"use client";

import { Button, ButtonProps } from "@mui/material";

type Props = ButtonProps & {
  label?: string;
};

export function PrimaryButton({ label, children, ...props }: Props) {
  return (
    <Button variant="contained" disableElevation {...props}>
      {label || children}
    </Button>
  );
}

export function SecondaryButton({ label, children, ...props }: Props) {
  return (
    <Button variant="outlined" {...props}>
      {label || children}
    </Button>
  );
}
