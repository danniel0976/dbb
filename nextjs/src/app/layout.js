import './globals.css'
import { Inter, Barlow_Condensed } from 'next/font/google'
import { ToastProvider } from '@/components/Toast'
import { ThemeProvider } from '@/components/ThemeProvider'

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' })
const barlow = Barlow_Condensed({ subsets: ['latin'], weight: ['500', '700'], variable: '--font-barlow', preload: false })

export const metadata = {
  title: "DBB — Dan's Bizarre Bazaar",
  description: 'Magic: The Gathering marketplace and collection manager',
  keywords: ['MTG', 'Magic The Gathering', 'cards', 'marketplace', 'Malaysia', 'TCG'],
}

// Inline script to prevent FOUC: reads localStorage and sets dark class before first paint
const themeScript = `(function(){try{var t=localStorage.getItem('dbb-theme')||'system';if(t==='dark'||(t==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches)){document.documentElement.classList.add('dark');}}catch(e){}})();`

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className={`${inter.variable} ${barlow.variable} font-sans`}>
        <ThemeProvider>
          <ToastProvider>{children}</ToastProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
