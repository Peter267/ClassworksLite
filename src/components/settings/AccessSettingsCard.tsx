import { useState, useSyncExternalStore } from 'react'
import { Icon } from '../Icon'
import { MdiIcon } from '../MdiIcon'
import { SettingsCard } from './SettingsCard'
import {
  clearAccessToken,
  getAccessStatus,
  refreshAccessStatus,
  subscribeAccess,
} from '../../lib/access'
import { store } from '../../lib/store'
import { toast } from '../../lib/toast'

export function AccessSettingsCard() {
  const status = useSyncExternalStore(subscribeAccess, getAccessStatus, getAccessStatus)
  const [checking, setChecking] = useState(false)

  async function check() {
    setChecking(true)
    try {
      const next = await refreshAccessStatus()
      if (!next) {
        toast.error('检测失败', '无法连接服务器，请检查网络')
        return
      }
      if (next.passwordRequired && !next.authenticated) {
        toast.warning('需要访问密码', '刷新页面后输入访问密码')
        return
      }
      toast.success(
        '权限已更新',
        next.canEdit ? '当前可以查看并修改作业' : '当前为只读访问',
      )
      void store.reinitialize()
    } finally {
      setChecking(false)
    }
  }

  function logout() {
    if (!window.confirm('退出访问后需要重新输入访问密码，确定继续吗？')) return
    clearAccessToken()
    toast.success('已退出访问', '正在刷新…')
    window.setTimeout(() => window.location.reload(), 400)
  }

  const viewText = !status
    ? '正在检测…'
    : status.authenticated
      ? '已获得访问权限'
      : '需要访问密码'

  const editText = !status
    ? '正在检测…'
    : !status.authenticated
      ? '需要访问密码'
      : status.canEdit
        ? '已获得编辑权限'
        : '只读（使用可写密码可编辑）'

  const viewOk = Boolean(status?.authenticated)
  const editOk = Boolean(status?.canEdit)

  return (
    <SettingsCard
      title="访问权限"
      icon="shield-lock-outline"
      subtitle="同一个密码框，只读密码只能查看，可写密码可以修改"
    >
      <div className="access-status-grid">
        <div className="access-status-item">
          <span className={`access-status-dot ${viewOk ? 'is-ok' : ''}`} />
          <div>
            <div className="text-caption text-medium-emphasis">查看作业</div>
            <div className="text-body-2 font-weight-medium">{viewText}</div>
          </div>
        </div>
        <div className="access-status-item">
          <span className={`access-status-dot ${editOk ? 'is-ok' : ''}`} />
          <div>
            <div className="text-caption text-medium-emphasis">编辑作业</div>
            <div className="text-body-2 font-weight-medium">{editText}</div>
          </div>
        </div>
      </div>

      <div className="d-flex flex-wrap mt-4" style={{ gap: 8 }}>
        <button
          type="button"
          className="v-btn v-btn--size-small v-btn--variant-tonal"
          data-color="primary"
          onClick={() => void check()}
          disabled={checking}
        >
          <MdiIcon name="shield-check" size={18} />
          {checking ? '校验中…' : '重新校验'}
        </button>
        {status?.passwordRequired && (
          <button
            type="button"
            className="v-btn v-btn--size-small v-btn--variant-outlined"
            onClick={logout}
          >
            <Icon name="external" size={18} />
            退出访问
          </button>
        )}
      </div>
    </SettingsCard>
  )
}
