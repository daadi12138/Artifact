import type { Metadata } from 'next'
import './styles.css'
import './executor-settings.css'
import './chrome.css'
import './mission-control.css'
import '@xterm/xterm/css/xterm.css'
import './workbench.css'

export const metadata: Metadata = { title: 'artifact', description: 'Artifact-driven agent workflows' }

const themeBootstrapScript = `
  try {
    var savedTheme = window.artifactDesktop && window.artifactDesktop.getPreference
      ? window.artifactDesktop.getPreference('artifact.theme')
      : window.localStorage.getItem('artifact.theme');
    var preference = savedTheme === 'system' || savedTheme === 'light' ? savedTheme : 'dark';
    var theme = preference === 'system'
      ? window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
      : preference;
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.themePreference = preference;
    document.documentElement.style.colorScheme = theme;
  } catch (_) {}
`

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{ __html: themeBootstrapScript }} /></head><body>{children}</body></html>
}
