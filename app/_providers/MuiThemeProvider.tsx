"use client";

import { CssBaseline, ThemeProvider, createTheme } from "@mui/material";

const theme = createTheme({
  palette: {
    mode: "light",
    primary: {
      main: "#1d4ed8",
      dark: "#1e40af",
      light: "#60a5fa",
    },
    secondary: {
      main: "#0ea5e9",
      dark: "#0284c7",
      light: "#7dd3fc",
    },
    background: {
      default: "#f5f8ff",
      paper: "#ffffff",
    },
    text: {
      primary: "#0b1b3a",
      secondary: "#43506b",
    },
    divider: "#e4ecff",
  },
  shape: {
    borderRadius: 14,
  },
  typography: {
    fontFamily:
      "var(--font-geist-sans), system-ui, -apple-system, Segoe UI, sans-serif",
    h1: {
      fontWeight: 700,
      letterSpacing: "-0.02em",
    },
    h2: {
      fontWeight: 700,
      letterSpacing: "-0.02em",
    },
    h3: {
      fontWeight: 700,
      letterSpacing: "-0.01em",
    },
    button: {
      textTransform: "none",
      fontWeight: 600,
    },
  },
  components: {
    MuiChip: {
      styleOverrides: {
        root: {
          borderRadius: 999,
          fontWeight: 600,
        },
      },
    },
    MuiAppBar: {
      styleOverrides: {
        root: {
          backgroundColor: "#ffffff",
          color: "#0b1b3a",
          borderBottom: "1px solid #e4ecff",
          boxShadow: "none",
        },
      },
    },
    MuiButton: {
      styleOverrides: {
        root: {
          borderRadius: 12,
        },
      },
    },
    MuiTextField: {
      defaultProps: {
        size: "small",
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          border: "1px solid #e4ecff",
        },
      },
    },
  },
});

type Props = {
  children: React.ReactNode;
};

export default function MuiThemeProvider({ children }: Props) {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      {children}
    </ThemeProvider>
  );
}
