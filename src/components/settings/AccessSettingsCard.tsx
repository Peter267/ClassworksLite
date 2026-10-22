import { useState, useSyncExternalStore } from 'react'
import { Icon } from '../Icon'
import { MdiIcon } from '../MdiIcon'
import { SettingsCard } from './SettingsCard'
import { SettingItem } from './SettingItem'
import {
  clearAccessToken,
  getAccessStatus,
  refreshAccessStatus,
  subscribeAccess,
} from '../../lib/access'
import { useSetting } from '../../lib/hooks'
import { settings } from '../../lib/settings'
import { toast } from '../../lib/toast'

export function AccessSettingsCard() {
  const status = useSyncExternalStore(subscribeAccess, getAccessStatus, getAccessStatus)
  const [provider] = useSetting<string>('server.provider')
  const [checking, setChecking] = useState(false)
  const cloud = provider === 'cloud'

  async function check() {
    setChecking(true)
    try {
      const next = await refreshAccessStatus()
      if (!next) {
        toast.error('检测失败', '无法连接站点，请检查站点地址与网络')
        return
      }
      if (next.unsupported) {
        toast.warning('站点未启用访问控制', '当前站点暂不支持访问密码，请联系管理员')
        return
      }
      if (next.passwordRequired && !next.authenticated) {
        toast.warning('需要访问密码', '刷新页面后输入访问密码')
        return
      }
      if (next.editRequired && !next.editAuthenticated) {
        toast.warning('编辑令牌无效', '请核对编辑令牌后重试')
        return
      }
      toast.success(
        '权限已更新',
        next.editRequired ? '已获得编辑权限' : '当前站点未启用编辑令牌',
      )
    } finally {
      setChecking(false)
    }
  }

  function logout() {
    if (!window.confirm('退出访问后需要重新输入访问密码，确定继续吗？')) return
    clearAccessToken()
    // 旧版静态令牌也属于访问凭证，不清掉会导致“退出”后仍然免密进入
    if (settings.get<string>('server.siteKey').trim()) {
      settings.set('server.siteKey', '')
    }
    toast.success('已退出访问', '正在刷新…')
    window.setTimeout(() => window.location.reload(), 400)
  }

  const viewText = !cloud
    ? '仅在线模式生效'
    : !status
      ? '正在检测…'
      : status.unsupported
        ? '未启用'
        : status.authenticated
          ? status.passwordRequired
            ? '已获得访问权限'
            : '未启用访问密码'
          : status.passwordRequired
            ? '需要访问密码'
            : '需要网站令牌'

  const editText = !cloud
    ? '仅在线模式生效'
    : !status
      ? '正在检测…'
      : status.unsupported
        ? '未启用'
        : !status.editRequired
          ? '未启用编辑令牌'
          : status.editAuthenticated
            ? '已获得编辑权限'
            : '只读（需要编辑令牌）'

  const viewOk = cloud && Boolean(status && !status.unsupported && status.authenticated)
  const editOk =
    cloud &&
    Boolean(status && !status.unsupported && (!status.editRequired || status.editAuthenticated))

  return (
    <SettingsCard
      title="访问权限"
      icon="shield-lock-outline"
      subtitle="访问密码用于查看作业，编辑令牌用于修改作业"
    >
      {!cloud && (
        <div className="v-alert v-alert--variant-tonal rounded-lg mb-3" data-color="info">
          <MdiIcon name="information" size={20} />
          <div>当前为本机模式，访问密码与编辑令牌仅在线模式生效。</div>
        </div>
      )}

      {cloud && status?.unsupported && (
        <div className="v-alert v-alert--variant-tonal rounded-lg mb-3" data-color="warning">
          <MdiIcon name="alert-circle-outline" size={20} />
          <div>当前站点暂不支持访问密码，可能版本较旧；请联系管理员升级后使用。</div>
        </div>
      )}

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

      <div className="v-list mt-3">
        <SettingItem
          settingKey="server.editToken"
          description="需与站点设置的编辑令牌一致，保存修改时会自动携带；修改后会自动校验。"
        />
      </div>

      <div className="d-flex flex-wrap mt-4" style={{ gap: 8 }}>
        <button
          type="button"
          className="v-btn v-btn--size-small v-btn--variant-tonal"
          data-color="primary"
          onClick={() => void check()}
          disabled={!cloud || checking}
        >
          <MdiIcon name="shield-check" size={18} />
          {checking ? '校验中…' : '重新校验'}
        </button>
        {cloud && status?.passwordRequired && (
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
