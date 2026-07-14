'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState, useEffect } from 'react'
import { Menu, X } from 'lucide-react'

const NAV_LINKS = [
  { href: '/library', label: 'Library' },
  { href: '/bazaar', label: 'Bazaar' },
  { href: '/scan', label: 'Scan' },
  { href: '/import', label: 'Import' },
  { href: '/profile', label: 'Profile' },
]

// Module-level cache so CartBadge fetches once per session even if DBBNav
// remounts across page navigations (since DBBNav lives in per-page components).
const cartCache = { count: null, fetchedAt: 0, pending: null }
const CART_TTL = 60_000 // revalidate after 1 minute

function CartBadge() {
  const [count, setCount] = useState(cartCache.count)

  useEffect(() => {
    const now = Date.now()
    if (cartCache.count !== null && now - cartCache.fetchedAt < CART_TTL) {
      setCount(cartCache.count)
      return
    }
    if (!cartCache.pending) {
      cartCache.pending = fetch('/api/cart/count')
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          cartCache.count = data?.count ?? 0
          cartCache.fetchedAt = Date.now()
          cartCache.pending = null
          return cartCache.count
        })
        .catch(() => { cartCache.pending = null; return 0 })
    }
    cartCache.pending.then(c => setCount(c))
  }, [])

  if (!count) return null
  return (
    <span className="ml-1 inline-flex items-center justify-center min-w-[18px] h-[18px] text-[10px] font-bold bg-dbb-accent text-white rounded-full px-1">
      {count > 99 ? '99+' : count}
    </span>
  )
}

export default function DBBNav({ userEmail, extra }) {
  const pathname = usePathname()
  const [drawerOpen, setDrawerOpen] = useState(false)

  useEffect(() => {
    setDrawerOpen(false)
  }, [pathname])

  useEffect(() => {
    if (drawerOpen) {
      document.body.style.overflow = 'hidden'
      return () => { document.body.style.overflow = '' }
    }
  }, [drawerOpen])

  const isActive = (href) => pathname?.startsWith(href)

  return (
    <>
      <header className="sticky top-0 z-40 bg-white/95 dark:bg-dbb-primary/95 backdrop-blur border-b border-gray-200 dark:border-dbb-tertiary/50">
        <div className="container mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href="/library" className="text-lg font-bold text-gray-900 dark:text-white hover:text-dbb-accent transition-colors tracking-tight">
              <span className="font-display text-xl">DBB</span>
              <span className="ml-1.5 text-sm font-medium text-gray-500 dark:text-gray-400 hidden sm:inline">Dan's Bizarre Bazaar</span>
            </Link>
            <nav className="hidden sm:flex items-center gap-1 text-sm">
              {NAV_LINKS.map(({ href, label }) => (
                <Link
                  key={href}
                  href={href}
                  className={`px-3 py-1.5 rounded-lg transition-colors ${
                    isActive(href)
                      ? 'text-gray-900 dark:text-white bg-dbb-accent/15 font-medium'
                      : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/5'
                  }`}
                >
                  {label}
                </Link>
              ))}
              {userEmail && (
                <Link
                  href="/cart"
                  className={`flex items-center px-3 py-1.5 rounded-lg transition-colors ${
                    isActive('/cart')
                      ? 'text-gray-900 dark:text-white bg-dbb-accent/15 font-medium'
                      : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/5'
                  }`}
                >
                  Cart
                  <CartBadge />
                </Link>
              )}
            </nav>
          </div>
          <div className="flex items-center gap-3">
            {extra}
            {userEmail ? (
              <>
                <span className="text-xs text-gray-500 hidden sm:inline">{userEmail}</span>
                <form action="/api/auth/signout" method="POST">
                  <button
                    type="submit"
                    className="btn btn-secondary btn-sm"
                  >
                    Sign out
                  </button>
                </form>
              </>
            ) : (
              <Link href="/login" className="btn btn-outline btn-sm">
                Sign in
              </Link>
            )}
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              className="sm:hidden flex items-center justify-center w-11 h-11 -mr-2 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
              aria-label="Open navigation menu"
              aria-expanded={drawerOpen}
            >
              <Menu size={24} />
            </button>
          </div>
        </div>
      </header>

      {/* Mobile slide-in drawer */}
      {drawerOpen && (
        <div className="sm:hidden fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Navigation menu">
          <div
            className="absolute inset-0 bg-black/60"
            onClick={() => setDrawerOpen(false)}
          />
          <div className="absolute right-0 top-0 h-full w-72 max-w-[80vw] bg-white dark:bg-dbb-primary border-l border-gray-200 dark:border-dbb-tertiary/50 shadow-2xl flex flex-col">
            <div className="flex items-center justify-between px-4 py-4 border-b border-gray-200 dark:border-dbb-tertiary/50">
              <span className="text-lg font-bold text-dbb-accent">Menu</span>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                className="flex items-center justify-center w-11 h-11 -mr-2 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
                aria-label="Close navigation menu"
              >
                <X size={24} />
              </button>
            </div>
            <nav className="flex-1 overflow-y-auto py-2">
              {NAV_LINKS.map(({ href, label }) => (
                <Link
                  key={href}
                  href={href}
                  className={`flex items-center min-h-[44px] px-4 py-3 text-base transition-colors ${
                    isActive(href)
                      ? 'text-gray-900 dark:text-white font-medium bg-dbb-accent/10 border-l-2 border-dbb-accent'
                      : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/5'
                  }`}
                >
                  {label}
                </Link>
              ))}
              {userEmail && (
                <Link
                  href="/cart"
                  className={`flex items-center min-h-[44px] px-4 py-3 text-base transition-colors ${
                    isActive('/cart')
                      ? 'text-gray-900 dark:text-white font-medium bg-dbb-accent/10 border-l-2 border-dbb-accent'
                      : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/5'
                  }`}
                >
                  Cart
                  <CartBadge />
                </Link>
              )}
            </nav>
            {userEmail && (
              <div className="border-t border-gray-200 dark:border-dbb-tertiary/50 px-4 py-4 space-y-3">
                <span className="block text-xs text-gray-500 truncate">{userEmail}</span>
                <form action="/api/auth/signout" method="POST">
                  <button
                    type="submit"
                    className="w-full btn btn-secondary btn-sm min-h-[44px]"
                  >
                    Sign out
                  </button>
                </form>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
