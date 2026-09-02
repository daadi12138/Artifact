'use client'

export function readPreference(key: string): string | null {
  if (typeof window === 'undefined') return null
  try {
    const desktopValue = window.artifactDesktop?.getPreference(key)
    if (desktopValue !== undefined && desktopValue !== null) return desktopValue
    const browserValue = window.localStorage.getItem(key)
    if (browserValue !== null && window.artifactDesktop) window.artifactDesktop.setPreference(key, browserValue)
    return browserValue
  } catch { return null }
}

export function writePreference(key: string, value: string): void {
  if (typeof window === 'undefined') return
  try { window.localStorage.setItem(key, value) } catch { /* Browser storage may be unavailable. */ }
  try { window.artifactDesktop?.setPreference(key, value) } catch { /* Desktop storage may be unavailable. */ }
}

export function removePreference(key: string): void {
  if (typeof window === 'undefined') return
  try { window.localStorage.removeItem(key) } catch { /* Browser storage may be unavailable. */ }
  try { window.artifactDesktop?.removePreference(key) } catch { /* Desktop storage may be unavailable. */ }
}
