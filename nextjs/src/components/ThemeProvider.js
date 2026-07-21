'use client'

import { createContext, useContext } from 'react'

// Dark mode is retired product-wide (Pass C1, 2026-07-21) — the app is
// light-only now. This provider is kept as a no-op shim so any remaining
// `useTheme()` call sites don't need to be touched in this pass.
const ThemeContext = createContext({ theme: 'light', setTheme: () => {} })

export function useTheme() {
  return useContext(ThemeContext)
}

export function ThemeProvider({ children }) {
  return (
    <ThemeContext.Provider value={{ theme: 'light', setTheme: () => {} }}>
      {children}
    </ThemeContext.Provider>
  )
}
