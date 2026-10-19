import type { Backend } from './kv-core'

/** Upstash Redis REST 后端：给 Vercel / Netlify 等无 KV 绑定的平台使用。 */
export class UpstashBackend implements Backend {
  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  private async command(args: (string | number)[]): Promise<unknown> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
    })
    if (!response.ok) {
      throw new Error(`Upstash 请求失败: ${response.status} ${await response.text()}`)
    }
    const data = (await response.json()) as { result?: unknown; error?: string }
    if (data.error) throw new Error(data.error)
    return data.result
  }

  async read(key: string): Promise<string | null> {
    const result = await this.command(['GET', key])
    return typeof result === 'string' ? result : null
  }

  async write(key: string, raw: string): Promise<void> {
    await this.command(['SET', key, raw])
  }

  async remove(key: string): Promise<void> {
    await this.command(['DEL', key])
  }

  async scan(prefix: string): Promise<string[]> {
    const keys: string[] = []
    let cursor = '0'
    let guard = 0
    do {
      const result = (await this.command([
        'SCAN',
        cursor,
        'MATCH',
        `${prefix}*`,
        'COUNT',
        500,
      ])) as [string, string[]]
      cursor = result[0]
      keys.push(...result[1])
      guard += 1
    } while (cursor !== '0' && guard < 20)
    return keys
  }
}
