import type { Metadata } from 'next'
import './styles.css'
import './canvas.css'
import './executor-settings.css'
import './chrome.css'

export const metadata: Metadata = { title: 'artifact', description: 'Artifact-driven agent workflows' }

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>
}
