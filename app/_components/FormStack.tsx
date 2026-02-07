"use client";

import { Stack, StackProps } from "@mui/material";

type Props = StackProps & {
  dense?: boolean;
};

export default function FormStack({ children, dense, ...props }: Props) {
  return (
    <Stack spacing={dense ? 1.5 : 2.5} {...props}>
      {children}
    </Stack>
  );
}
