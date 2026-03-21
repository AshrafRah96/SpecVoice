import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' })

export const metadata: Metadata = {
  title: 'Spec Voice',
  description: 'Code-aware voice agent for structured PR specs',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body
        className="overflow-hidden"
        style={{ background: '#0a0a0b', color: '#e5e5e5', fontFamily: 'var(--font-inter), sans-serif' }}
      >
        {children}
      </body>
    </html>
  )
}
