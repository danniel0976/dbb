'use client'

import { createContext, useContext, useState, useCallback } from 'react'

const ToastContext = createContext(null)

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used inside ToastProvider')
  return ctx
}

let nextId = 0

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])

  const toast = useCallback((message, type = 'info') => {
    const id = ++nextId
    setToasts(prev => {
      const next = [...prev, { id, message, type }]
      return next.slice(-3) // max 3 toasts
    })
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id))
    }, 3000)
  }, [])

  const dismiss = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="fixed bottom-4 right-4 z-[9999] flex flex-col gap-2 pointer-events-none">
        {toasts.map(t => (
          <div
            key={t.id}
            onClick={() => dismiss(t.id)}
            className={`
              pointer-events-auto px-4 py-3 rounded-lg shadow-xl text-sm font-medium
              flex items-center gap-2 cursor-pointer toast
              ${t.type === 'success' ? 'bg-green-700 text-white' : ''}
              ${t.type === 'error' ? 'bg-red-700 text-white' : ''}
              ${t.type === 'info' ? 'bg-dbb-secondary border border-dbb-accent/40 text-white' : ''}
            `}
          >
            {t.type === 'success' && <span>✓</span>}
            {t.type === 'error' && <span>✕</span>}
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
