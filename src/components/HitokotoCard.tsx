import { useCallback, useEffect, useRef, useState } from 'react'
import { HITOKOTO_FALLBACK } from '../lib/defaults'
import { useSetting } from '../lib/hooks'

interface Quote {
  text: string
  author?: string
  origin?: string
}

interface ZhaoyuResponse {
  success?: boolean
  data?: {
    sentence?: string
    content?: string
    name?: string
    author?: string
    origin?: string
  }
}

interface HitokotoResponse {
  hitokoto?: string
  from?: string
  from_who?: string
}

function pickLocal(): Quote {
  return { text: HITOKOTO_FALLBACK[Math.floor(Math.random() * HITOKOTO_FALLBACK.length)] }
}

/**
 * 一言卡片：对齐 HitokotoCard.vue —— 正文 75% 字号、署名 45%、点击刷新。
 * 数据源优先使用上游默认的「一言·赵宇」句子接口，失败时回落到 hitokoto.cn。
 */
export function HitokotoCard() {
  const [online] = useSetting<boolean>('hitokoto.online')
  const [fontSize] = useSetting<number>('font.size')
  const [interval] = useSetting<number>('hitokoto.refreshInterval')
  const [quote, setQuote] = useState<Quote>(pickLocal)
  const [loading, setLoading] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const load = useCallback(async () => {
    if (!online) {
      setQuote(pickLocal())
      return
    }
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setLoading(true)
    try {
      let next: Quote | null = null
      try {
        const response = await fetch('https://hub.saintic.com/openservice/sentence/all.json', {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        })
        if (response.ok) {
          const data = (await response.json()) as ZhaoyuResponse
          if (data.success && data.data) {
            const text = data.data.sentence || data.data.content || data.data.name
            if (text) {
              next = {
                text,
                author: data.data.author,
                origin: data.data.origin || data.data.name || '未知',
              }
            }
          }
        }
      } catch {
        /* 继续尝试下一个源 */
      }

      if (!next) {
        const response = await fetch('https://v1.hitokoto.cn/', {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        })
        if (!response.ok) throw new Error('bad status')
        const data = (await response.json()) as HitokotoResponse
        if (!data.hitokoto) throw new Error('empty')
        next = {
          text: data.hitokoto,
          author: data.from_who,
          origin: data.from || '未知',
        }
      }

      setQuote(next)
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setQuote(pickLocal())
    } finally {
      setLoading(false)
    }
  }, [online])

  useEffect(() => {
    void load()
    return () => abortRef.current?.abort()
  }, [load])

  useEffect(() => {
    if (interval <= 0) return
    const timer = setInterval(() => void load(), interval * 1000)
    return () => clearInterval(timer)
  }, [interval, load])

  return (
    <article className="v-card border rounded-xl hitokoto-card cursor-pointer" onClick={() => void load()}>
      {loading && (
        <div className="v-progress-linear v-progress-linear--indeterminate hitokoto-loading">
          <div className="v-progress-linear__bar" />
        </div>
      )}
      <div className="v-card-text d-flex flex-column justify-center" style={{ padding: 24, height: '100%' }}>
        <div
          className="font-weight-medium mb-4 serif-font"
          style={{ fontSize: fontSize * 0.75, whiteSpace: 'pre-wrap', lineHeight: 1.6, textAlign: 'left' }}
        >
          {quote.text}
        </div>
        {(quote.author || quote.origin) && (
          <div className="text-medium-emphasis serif-font" style={{ fontSize: fontSize * 0.45, textAlign: 'left' }}>
            {quote.author && <span className="mr-2">{quote.author}</span>}
            {quote.origin && <span>《{quote.origin}》</span>}
          </div>
        )}
      </div>
    </article>
  )
}
