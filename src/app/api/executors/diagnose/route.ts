import { diagnoseExecutorInstallations } from '@artifact/core'

export async function POST() {
  return Response.json(await diagnoseExecutorInstallations())
}
