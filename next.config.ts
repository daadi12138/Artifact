import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  distDir: process.env.ARTIFACT_NEXT_DIST_DIR || '.next',
  outputFileTracingExcludes: {
    '*': ['.artifact/**/*', '.artifact-desktop-dev/**/*', '.next-electron-dev/**/*', 'dist-cli/**/*', 'dist-electron/**/*', 'release/**/*'],
  },
}

export default nextConfig
