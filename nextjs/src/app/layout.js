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

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className={`${inter.variable} ${barlow.variable} font-sans`}>
        <ThemeProvider>
          <ToastProvider>{children}</ToastProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
