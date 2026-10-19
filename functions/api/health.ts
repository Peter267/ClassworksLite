import { healthResponse } from '../../server/kv-core'

/** 健康检查：用于部署后确认 Functions 已生效 */
export async function onRequest(context: { env: { CORS_ORIGIN?: string } }): Promise<Response> {
  return healthResponse(context.env?.CORS_ORIGIN ?? '*')
}
