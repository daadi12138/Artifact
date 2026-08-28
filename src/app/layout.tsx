import type { Metadata } from 'next'
import './styles.css'
import './canvas.css'
import './executor-settings.css'
import './chrome.css'
import './mission-control.css'

export const metadata: Metadata = { title: 'artifact', description: 'Artifact-driven agent workflows' }

const themeBootstrapScript = `
  try {
    var savedTheme = window.localStorage.getItem('artifact.theme');
    var theme = savedTheme === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  } catch (_) {}
`

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{ __html: themeBootstrapScript }} /></head><body>{children}</body></html>
}
