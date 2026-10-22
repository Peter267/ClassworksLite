import { useState, type FormEvent } from 'react'
import { Icon } from './Icon'
import { loginWithPassword } from '../lib/access'

/** 全屏访问密码门：站点启用访问密码时在加载数据前显示 */
export function AccessGate({ onUnlocked }: { onUnlocked: () => void }) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const value = password.trim()
    if (!value || busy) return
    setBusy(true)
    setError(null)
    try {
      await loginWithPassword(password)
      setPassword('')
      onUnlocked()
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法连接服务，请稍后重试')
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
          输入班级访问密码后查看/编辑作业
        </p>

        <label className="block mt-6">
          <span className="text-caption text-medium-emphasis">访问密码</span>
          <input
            id="access-password"
            name="password"
            className="v-field mt-2"
            type="password"
            autoFocus
            autoComplete="current-password"
            placeholder="输入访问密码"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={busy}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? 'access-password-error' : undefined}
          />
        </label>

        {error && (
          <div className="access-gate-error" id="access-password-error" role="alert">
            {error}
          </div>
        )}

        <button
          type="submit"
          className="v-btn v-btn--variant-flat v-btn--size-large w-full mt-5"
          data-color="primary"
          disabled={busy || password.trim().length === 0}
        >
          {busy ? '验证中…' : '进入作业板'}
        </button>
      </form>
    </div>
  )
}
