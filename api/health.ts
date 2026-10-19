import { healthResponse } from '../server/kv-core'

export const config = { runtime: 'edge' }

export default async function handler(): Promise<Response> {
  return healthResponse(process.env.CORS_ORIGIN ?? '*')
}
