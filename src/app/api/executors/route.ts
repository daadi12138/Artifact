import { scanLocalExecutors } from '@artifact/core'

export async function GET() {
  return Response.json(await scanLocalExecutors())
}
