'use client'

import { useState, useEffect, useRef } from 'react'
import { ScanLine, Tag, ArrowLeft } from 'lucide-react'
import DBBNav from '@/components/DBBNav'
import OCRCardScanner from '@/components/OCRCardScanner'
import ClaimSaleImageGenerator from '@/components/ClaimSaleImageGenerator'
import { createClient } from '@/lib/supabaseClient'

export default function ScanPage() {
  const [mode, setMode] = useState('select') // 'select' | 'ocr' | 'claim'
  const [binders, setBinders] = useState([])
  const [authReady, setAuthReady] = useState(false)
  const [authenticated, setAuthenticated] = useState(false)
  const [toast, setToast] = useState(null)

  useEffect(() => {
    const sb = createClient()
    if (!sb) {
      setAuthReady(true)
      return
    }

    // Check current session
    sb.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        setAuthenticated(true)
        // Fetch binders
        sb.from('binders')
          .select('id, name')
          .order('created_at', { ascending: true })
          .then(({ data }) => {
            if (data) setBinders(data)
          })
      }
      setAuthReady(true)
    })

    // Listen for auth changes
    const { data: { subscription } } = sb.auth.onAuthStateChange((_event, session) => {
      setAuthenticated(!!session)
      if (session) {
        sb.from('binders').select('id, name').order('created_at', { ascending: true })
          .then(({ data }) => { if (data) setBinders(data) })
      } else {
        setBinders([])
      }
    })

    return () => subscription.unsubscribe()
  }, [])

  const handleAdded = (result) => {
    setToast({ type: 'success', message: `Added ${result.card_name} to library` })
    setTimeout(() => setToast(null), 3000)
  }

  // Not authenticated
  if (authReady && !authenticated) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-dbb-primary">
        <DBBNav />
        <div className="max-w-md mx-auto pt-20 px-4 text-center">
          <ScanLine className="w-12 h-12 text-gray-300 dark:text-gray-600 mx-auto mb-4" />
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Please sign in to use the card scanner.
          </p>
        </div>
      </div>
    )
  }

  // Loading auth
  if (!authReady) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-dbb-primary">
        <DBBNav />
        <div className="max-w-md mx-auto pt-20 px-4 text-center">
          <p className="text-sm text-gray-400">Loading...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-dbb-primary">
      <DBBNav />
      <div className="max-w-md mx-auto pt-20 px-4 pb-12">
        {/* Toast */}
        {toast && (
          <div className="fixed top-20 left-1/2 -translate-x-1/2 z-50 px-4 py-2 bg-green-600 text-white rounded-lg text-sm shadow-lg">
            {toast.message}
          </div>
        )}

        {mode === 'select' && (
          <div className="space-y-4 pt-4">
            <h1 className="text-xl font-bold text-gray-900 dark:text-white text-center">Scan</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 text-center">
              Choose a scanning mode to get started.
            </p>
            <div className="space-y-3 pt-4">
              <button
                onClick={() => setMode('ocr')}
                className="w-full flex items-center gap-4 p-4 bg-white dark:bg-dbb-secondary border border-gray-200 dark:border-gray-700 rounded-xl hover:border-dbb-accent transition-colors text-left"
              >
                <div className="w-12 h-12 rounded-lg bg-dbb-accent/10 flex items-center justify-center flex-shrink-0">
                  <ScanLine className="w-6 h-6 text-dbb-accent" />
                </div>
                <div className="flex-1">
                  <p className="text-sm font-medium text-gray-900 dark:text-white">OCR Card Add</p>
                  <p className="text-xs text-gray-400">Scan a card name to search and add to your library</p>
                </div>
              </button>
              <button
                onClick={() => setMode('claim')}
                className="w-full flex items-center gap-4 p-4 bg-white dark:bg-dbb-secondary border border-gray-200 dark:border-gray-700 rounded-xl hover:border-dbb-accent transition-colors text-left"
              >
                <div className="w-12 h-12 rounded-lg bg-dbb-accent/10 flex items-center justify-center flex-shrink-0">
                  <Tag className="w-6 h-6 text-dbb-accent" />
                </div>
                <div className="flex-1">
                  <p className="text-sm font-medium text-gray-900 dark:text-white">Claim Sale Image</p>
                  <p className="text-xs text-gray-400">Scan, match, and generate a price-overlay image for claim sales</p>
                </div>
              </button>
            </div>
          </div>
        )}

        {mode === 'ocr' && (
          <div className="space-y-4 pt-4">
            <button
              onClick={() => setMode('select')}
              className="flex items-center gap-1 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              Back
            </button>
            <div className="bg-white dark:bg-dbb-secondary border border-gray-200 dark:border-gray-700 rounded-xl p-4">
              <OCRCardScanner
                binders={binders}
                onAdded={handleAdded}
                onCancel={() => setMode('select')}
              />
            </div>
          </div>
        )}

        {mode === 'claim' && (
          <div className="space-y-4 pt-4">
            <button
              onClick={() => setMode('select')}
              className="flex items-center gap-1 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              Back
            </button>
            <div className="bg-white dark:bg-dbb-secondary border border-gray-200 dark:border-gray-700 rounded-xl p-4">
              <ClaimSaleImageGenerator
                onCancel={() => setMode('select')}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}