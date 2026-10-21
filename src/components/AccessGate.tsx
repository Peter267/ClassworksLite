import { useState, type FormEvent } from 'react'
import { Icon } from './Icon'
import { loginWithPassword } from '../lib/access'

/** 全屏访问密码门：服务端启用 SITE_PASSWORD 时在加载数据前显示 */
export function AccessGate({ onUnlocked }: { onUnlocked: () => void }) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!password || busy) return
    setBusy(true)
    setError(null)
    try {
      await loginWithPassword(password)
      setPassword('')
      onUnlocked()
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法连接服务器，请稍后重试')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="access-gate-wrap">
      <form className="access-gate-card" onSubmit={handleSubmit}>
        <span className="access-gate-icon">
          <Icon name="lock" size={30} />
        </span>
        <h1 className="text-h5">需要访问密码</h1>
        <p className="text-body-2 text-medium-emphasis mt-2">
          输入班级访问密码后查看作业。若服务端启用了编辑令牌，修改作业还需要在
          「设置 → 服务器 → 访问权限」中填写同值。
        </p>

        <label className="block mt-6">
          <span className="text-caption text-medium-emphasis">访问密码</span>
          <input
            className="v-field mt-2"
            type="password"
            autoFocus
            autoComplete="current-password"
            placeholder="输入访问密码"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={busy}
          />
        </label>

        {error && (
          <div className="access-gate-error" role="alert">
            {error}
          </div>
        )}

        <button
          type="submit"
          className="v-btn v-btn--variant-flat v-btn--size-large w-full mt-5"
          data-color="primary"
          disabled={busy || password.length === 0}
        >
          {busy ? '验证中…' : '进入作业板'}
        </button>

        <div className="access-gate-foot">
          访问状态会保留 7 天；连续 5 次密码错误会锁定当前 IP 10 分钟。
        </div>
      </form>
    </div>
  )
}
