"use client";

import { Box, Paper, Stack, Typography } from "@mui/material";
import type { SxProps, Theme } from "@mui/material/styles";

type Props = {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  icon?: React.ReactNode;
  fullHeight?: boolean;
  sx?: SxProps<Theme>;
  children: React.ReactNode;
};

export default function SectionCard({
  title,
  subtitle,
  actions,
  icon,
  fullHeight,
  sx,
  children,
}: Props) {
  return (
    <Paper
      variant="outlined"
      sx={{ p: 3, ...(fullHeight ? { height: "100%" } : null), ...sx }}
    >
      <Stack spacing={2}>
        <Stack
          direction={{ xs: "column", sm: "row" }}
          spacing={1.5}
          justifyContent="space-between"
          alignItems={{ sm: "center" }}
        >
          <Stack direction="row" spacing={1.5} alignItems="center">
            {icon ? <Box sx={{ color: "primary.main" }}>{icon}</Box> : null}
            <Box>
              <Typography fontWeight={700}>{title}</Typography>
            {subtitle ? (
              <Typography variant="caption" color="text.secondary">
                {subtitle}
              </Typography>
            ) : null}
            </Box>
          </Stack>
          {actions ? <Box>{actions}</Box> : null}
        </Stack>
        {children}
      </Stack>
    </Paper>
  );
}
