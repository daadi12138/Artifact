import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  outputFileTracingExcludes: {
    '*': ['.artifact/**/*', '.artifact-desktop-dev/**/*', 'dist-cli/**/*', 'dist-electron/**/*', 'release/**/*'],
  },
}

export default nextConfig
