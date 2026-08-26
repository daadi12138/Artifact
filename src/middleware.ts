import { NextRequest, NextResponse } from 'next/server'

export function middleware(request: NextRequest) {
  const token = process.env.ARTIFACT_SESSION_TOKEN
  if (token && request.headers.get('x-artifact-session') !== token) {
    return Response.json({ error: 'Unauthorized local session' }, { status: 403 })
  }
  return NextResponse.next()
}

export const config = {
  matcher: '/api/:path*',
}
