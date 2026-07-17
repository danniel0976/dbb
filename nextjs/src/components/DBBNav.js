'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState, useEffect, useRef } from 'react'
import { Library, Store, Package, ShoppingCart, User, ChevronDown, Upload, LogOut } from 'lucide-react'

// Primary destinations — desktop top bar + mobile bottom tab bar.
// Import intentionally lives off this list; it's reachable from Library's
// Add flow / the account menu overflow, not as a top-level destination.
const PRIMARY_LINKS = [
  { href: '/library', label: 'Library', icon: Library },
  { href: '/bazaar', label: 'Bazaar', icon: Store },
  { href: '/orders', label: 'Orders', icon: Package },
]

// Module-level cache so CartBadge fetches once per session even if DBBNav
// remounts across page navigations (since DBBNav lives in per-page components).
const cartCache = { count: null, fetchedAt: 0, pending: null }
const CART_TTL = 60_000 // revalidate after 1 minute

function useCartCount(userEmail) {
  const [count, setCount] = useState(cartCache.count)

  useEffect(() => {
    if (!userEmail) return
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
  }, [userEmail])

  return count
}

function CartBadge({ count }) {
  if (!count) return null
  return (
    <span className="absolute -top-1 -right-1 inline-flex items-center justify-center min-w-[16px] h-[16px] text-[10px] font-bold bg-dbb-accent text-white rounded-full px-1 leading-none">
      {count > 99 ? '99+' : count}
    </span>
  )
}

/**
 * Single account menu — dropdown from an avatar/icon. Houses profile,
 * account email, and sign-out, so the top bar itself only ever shows
 * Library / Bazaar / Orders + a trailing Cart icon.
 */
function AccountMenu({ userEmail }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const pathname = usePathname()

  useEffect(() => { setOpen(false) }, [pathname])

  useEffect(() => {
    if (!open) return
    const onClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!userEmail) {
    return (
      <Link href="/login" className="btn btn-outline btn-sm">
        Sign in
      </Link>
    )
  }

  const initial = userEmail.charAt(0).toUpperCase()

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        className="flex items-center gap-1 rounded-full pl-1 pr-2 py-1 min-h-[44px] hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
      >
        <span className="flex items-center justify-center w-8 h-8 rounded-full bg-dbb-accent/15 text-dbb-accent text-sm font-semibold">
          {initial}
        </span>
        <ChevronDown size={14} className={`text-gray-500 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-2 w-56 rounded-dbb-md shadow-dbb-md overflow-hidden dbb-glass-sheet border border-black/5 dark:border-white/10 z-50"
        >
          <div className="px-4 py-3 border-b border-black/5 dark:border-white/10">
            <p className="text-xs text-gray-500 dark:text-gray-400">Signed in as</p>
            <p className="text-sm font-medium text-gray-900 dark:text-white truncate">{userEmail}</p>
          </div>
          <Link
            href="/profile"
            role="menuitem"
            className="flex items-center gap-2 px-4 py-2.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
          >
            <User size={16} /> Profile
          </Link>
          <Link
            href="/import"
            role="menuitem"
            className="flex items-center gap-2 px-4 py-2.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
          >
            <Upload size={16} /> Import
          </Link>
          <form action="/api/auth/signout" method="POST">
            <button
              type="submit"
              role="menuitem"
              className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-dbb-accent hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
            >
              <LogOut size={16} /> Sign out
            </button>
          </form>
        </div>
      )}
    </div>
  )
}

function TopBarLink({ href, label, icon: Icon, active }) {
  return (
    <Link
      href={href}
      className={`relative flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm transition-colors ${
        active
          ? 'font-semibold text-gray-900 dark:text-white bg-black/[0.06] dark:bg-white/[0.10]'
          : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-black/[0.04] dark:hover:bg-white/[0.06]'
      }`}
    >
      <Icon size={16} strokeWidth={active ? 2.25 : 2} />
      {label}
    </Link>
  )
}

function TabBarLink({ href, label, icon: Icon, active, badge }) {
  return (
    <Link
      href={href}
      className="relative flex flex-col items-center justify-center gap-0.5 min-w-[48px] flex-1 h-full active:scale-[0.97] transition-transform"
      aria-current={active ? 'page' : undefined}
    >
      <span className="relative">
        <Icon
          size={24}
          strokeWidth={active ? 2.25 : 1.75}
          className={active ? 'text-dbb-accent' : 'text-gray-500 dark:text-gray-400'}
        />
        {badge}
      </span>
      <span className={`text-[10px] leading-none ${active ? 'font-semibold text-dbb-accent' : 'text-gray-500 dark:text-gray-400'}`}>
        {label}
      </span>
    </Link>
  )
}

export default function DBBNav({ userEmail, extra }) {
  const pathname = usePathname()
  const cartCount = useCartCount(userEmail)

  const isActive = (href) => pathname?.startsWith(href)

  // Reserve room for the fixed mobile bottom tab bar so page content never
  // sits underneath it. Applied via a body class instead of touching every
  // page shell that renders <DBBNav>.
  useEffect(() => {
    document.body.classList.add('dbb-has-tabbar')
    return () => { document.body.classList.remove('dbb-has-tabbar') }
  }, [])

  return (
    <>
      <header className="sticky top-0 z-40 dbb-glass-chrome">
        <div className="container mx-auto px-4 h-14 sm:h-[60px] flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href="/library" className="text-lg font-bold text-gray-900 dark:text-white hover:text-dbb-accent transition-colors tracking-heading">
              <span className="font-display text-xl">DBB</span>
              <span className="ml-1.5 text-sm font-medium text-gray-500 dark:text-gray-400 hidden lg:inline">Dan's Bizarre Bazaar</span>
            </Link>
            <nav className="hidden sm:flex items-center gap-1">
              {PRIMARY_LINKS.map(({ href, label, icon }) => (
                <TopBarLink key={href} href={href} label={label} icon={icon} active={isActive(href)} />
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-2">
            {extra}
            {userEmail && (
              <Link
                href="/cart"
                aria-label="Cart"
                className={`relative flex items-center justify-center w-10 h-10 rounded-full transition-colors ${
                  isActive('/cart')
                    ? 'bg-black/[0.06] dark:bg-white/[0.10] text-gray-900 dark:text-white'
                    : 'text-gray-600 dark:text-gray-400 hover:bg-black/[0.04] dark:hover:bg-white/[0.06]'
                }`}
              >
                <ShoppingCart size={20} />
                <CartBadge count={cartCount} />
              </Link>
            )}
            <AccountMenu userEmail={userEmail} />
          </div>
        </div>
      </header>

      {/* Mobile bottom tab bar — replaces the hamburger/drawer entirely */}
      <nav
        className="sm:hidden fixed bottom-0 left-0 right-0 z-40 dbb-glass-chrome dbb-glass-chrome--edge-top flex items-stretch"
        style={{ height: 'calc(64px + env(safe-area-inset-bottom))', paddingBottom: 'env(safe-area-inset-bottom)' }}
        aria-label="Primary"
      >
        {PRIMARY_LINKS.map(({ href, label, icon }) => (
          <TabBarLink key={href} href={href} label={label} icon={icon} active={isActive(href)} />
        ))}
        <TabBarLink
          href={userEmail ? '/cart' : '/login'}
          label="Cart"
          icon={ShoppingCart}
          active={isActive('/cart')}
          badge={<CartBadge count={cartCount} />}
        />
      </nav>
    </>
  )
}
