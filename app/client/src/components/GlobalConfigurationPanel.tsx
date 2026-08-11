import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  activateSiteConfig,
  checkSiteConfig,
  cloneSiteConfig,
  createSiteConfig,
  deleteSiteConfig,
  fetchSiteConfig,
  fetchSiteConfigs,
  updateSiteConfig,
  type SiteConfigCheckDepth,
  type SiteConfigDetailResponse,
  type SiteConfigListResponse,
  type SiteMode,
} from '../services/site-config-api';
import { Panel } from './Panel';
import { RuntimeProfileManagementPanel } from './RuntimeProfileManagementPanel';

type GlobalConfigurationPanelProps = {
  canEdit: boolean;
};

type CreateDraft = {
  id: string;
  displayName: string;
  mode: SiteMode;
};

const EMPTY_DRAFT: CreateDraft = {
  id: '',
  displayName: '',
  mode: 'bkv',
};

function modeLabel(mode: SiteMode) {
  return mode === 'bkv' ? 'BKV 模式' : '相机直连模式';
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function checkStatusLabel(status: 'normal' | 'warning' | 'error') {
  if (status === 'normal') return '正常';
  if (status === 'warning') return '警告';
  return '错误';
}

function checkPriority(check: { status: 'normal' | 'warning' | 'error'; blocking: boolean }) {
  if (check.blocking) return 0;
  if (check.status === 'error') return 1;
  if (check.status === 'warning') return 2;
  return 3;
}

export function GlobalConfigurationPanel({
  canEdit,
}: GlobalConfigurationPanelProps) {
  const [catalog, setCatalog] = useState<SiteConfigListResponse | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState<SiteConfigDetailResponse | null>(null);
  const [createDraft, setCreateDraft] = useState<CreateDraft | null>(null);
  const [modeDraft, setModeDraft] = useState<SiteMode | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [busyAction, setBusyAction] = useState('');
  const [message, setMessage] = useState('');
  const [loadError, setLoadError] = useState('');

  const loadDetail = useCallback(async (id: string, signal?: AbortSignal) => {
    const response = await fetchSiteConfig(id, signal);
    setDetail(response);
    setModeDraft(response.document.mode);
    setNameDraft(response.document.displayName);
    setLoadError('');
  }, []);

  const loadCatalog = useCallback(async (
    preferredId?: string,
    signal?: AbortSignal,
  ) => {
    const response = await fetchSiteConfigs(signal);
    setCatalog(response);
    const nextId = preferredId
      || response.activeSiteId
      || response.pendingSiteId
      || response.sites[0]?.id
      || '';
    setSelectedId(nextId);
    if (nextId) {
      await loadDetail(nextId, signal);
    } else {
      setDetail(null);
      setModeDraft(null);
    }
    setLoadError('');
  }, [loadDetail]);

  useEffect(() => {
    const controller = new AbortController();
    loadCatalog(undefined, controller.signal).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        setLoadError(errorMessage(error, '现场配置读取失败'));
      }
    });
    return () => controller.abort();
  }, [loadCatalog]);

  const selectSite = async (id: string) => {
    if (id === selectedId && detail) return;
    setSelectedId(id);
    setCreateDraft(null);
    setBusyAction('select');
    setMessage('');
    try {
      await loadDetail(id);
    } catch (error) {
      setLoadError(errorMessage(error, '现场配置详情读取失败'));
    } finally {
      setBusyAction('');
    }
  };

  const runMutation = async (
    action: string,
    operation: () => Promise<void>,
    successMessage: string,
  ) => {
    setBusyAction(action);
    setMessage('');
    try {
      await operation();
      setMessage(successMessage);
    } catch (error) {
      setMessage(errorMessage(error, '操作失败'));
    } finally {
      setBusyAction('');
    }
  };

  const submitCreate = async () => {
    if (!createDraft) return;
    const id = createDraft.id.trim();
    const displayName = createDraft.displayName.trim();
    if (!id || !displayName) {
      setMessage('请填写配置标识和显示名称');
      return;
    }
    await runMutation('create', async () => {
      await createSiteConfig({ ...createDraft, id, displayName });
      setCreateDraft(null);
      await loadCatalog(id);
    }, '现场配置已新建');
  };

  const submitClone = async () => {
    if (!detail) return;
    const id = window.prompt('请输入新配置标识', `${detail.site.id}-copy`)?.trim();
    if (!id) return;
    const displayName = window.prompt(
      '请输入新配置名称',
      `${detail.site.displayName} 副本`,
    )?.trim();
    if (!displayName) return;
    await runMutation('clone', async () => {
      await cloneSiteConfig(detail.site.id, { id, displayName });
      await loadCatalog(id);
    }, '现场配置已复制');
  };

  const prepareModeChange = () => {
    if (!detail || !modeDraft || modeDraft === detail.document.mode) return;
    const suffix = modeDraft === 'bkv' ? 'bkv' : 'direct-camera';
    const baseId = `${detail.site.id}-${suffix}`;
    const existingIds = new Set(catalog?.sites.map((site) => site.id) ?? []);
    let id = baseId;
    let index = 2;
    while (existingIds.has(id)) {
      id = `${baseId}-${index}`;
      index += 1;
    }
    setCreateDraft({
      id,
      displayName: `${detail.site.displayName} · ${modeLabel(modeDraft)}`,
      mode: modeDraft,
    });
    setMessage(`已选择${modeLabel(modeDraft)}，请确认新建配置并切换`);
  };

  const saveName = async () => {
    if (!detail || !nameDraft.trim()) return;
    await runMutation('save', async () => {
      await updateSiteConfig(detail.site.id, { displayName: nameDraft.trim() });
      await loadCatalog(detail.site.id);
    }, '配置名称已保存');
  };

  const runCheck = async (depth: SiteConfigCheckDepth) => {
    if (!detail) return;
    await runMutation(`check-${depth}`, async () => {
      const checkedSiteId = detail.site.id;
      const result = await checkSiteConfig(checkedSiteId, depth);
      const response = await fetchSiteConfigs();
      const refreshedSite = response.sites.find((site) => site.id === checkedSiteId);
      setCatalog(response);
      setDetail((current) => current ? {
        ...current,
        site: refreshedSite ?? current.site,
        report: result.report,
      } : current);
    }, depth === 'deep' ? '深度检查已完成' : '默认检查已完成');
  };

  const activate = async () => {
    if (!detail || !window.confirm('切换配置后必须重启服务才能生效，确认继续？')) {
      return;
    }
    await runMutation('activate', async () => {
      await activateSiteConfig(detail.site.id);
      await loadCatalog(detail.site.id);
    }, '配置已切换，等待服务重启后生效');
  };

  const remove = async () => {
    if (!detail || !window.confirm(`确认删除“${detail.site.displayName}”？`)) {
      return;
    }
    await runMutation('delete', async () => {
      await deleteSiteConfig(detail.site.id);
      setSelectedId('');
      setDetail(null);
      await loadCatalog();
    }, '现场配置已删除');
  };

  const blockingCount = useMemo(
    () => detail?.report?.checks.filter((check) => check.blocking).length
      ?? detail?.site.availability?.blocking
      ?? 0,
    [detail],
  );
  const protectedSite = Boolean(detail?.site.active || detail?.site.pending);
  const busy = Boolean(busyAction);
  const activateDisabled = !canEdit
    || busy
    || !detail
    || protectedSite
    || blockingCount > 0;

  return (
    <div
      className="global-configuration-panel"
      data-testid="global-configuration-panel"
    >
      <Panel
        title="全局配置"
        className="parameter-card global-configuration-card"
        action={(
          <div className="site-config-toolbar">
            <button
              type="button"
              disabled={!canEdit || busy}
              onClick={() => {
                setCreateDraft({ ...EMPTY_DRAFT });
                setMessage('');
              }}
            >
              新建配置
            </button>
            <button
              type="button"
              disabled={!canEdit || busy || !detail}
              onClick={() => void submitClone()}
            >
              复制配置
            </button>
          </div>
        )}
      >
        <div className="site-config-intro">
          <div>
            <strong>现场配置包</strong>
            <span>统一管理运行模式、连接、采集与存储参数。</span>
          </div>
          {catalog?.restartRequired ? (
            <div className="site-config-restart-notice">
              已切换配置，需要重启服务后生效
            </div>
          ) : null}
        </div>

        {loadError ? <div className="site-config-message error">{loadError}</div> : null}
        {message ? <div className="site-config-message">{message}</div> : null}

        <div className="site-config-workspace">
          <aside className="site-config-list" aria-label="现场配置列表">
            {(catalog?.sites ?? []).map((site) => (
              <button
                key={site.id}
                type="button"
                className={site.id === selectedId ? 'selected' : ''}
                onClick={() => void selectSite(site.id)}
              >
                <span>
                  <strong>{site.displayName}</strong>
                  <em>{site.id}</em>
                </span>
                <span className="site-config-list-meta">
                  <small>{modeLabel(site.mode)} · {site.cameraCount} 相机</small>
                  <span>
                    {site.active ? <b className="active">运行中</b> : null}
                    {site.pending ? <b className="pending">待重启</b> : null}
                  </span>
                </span>
              </button>
            ))}
            {!catalog && !loadError ? (
              <div className="admin-empty-state">正在读取现场配置…</div>
            ) : null}
            {catalog && catalog.sites.length === 0 ? (
              <div className="admin-empty-state">暂无现场配置</div>
            ) : null}
          </aside>

          <section className="site-config-detail-area">
            {createDraft ? (
              <form
                className="site-config-form"
                data-testid="site-config-create-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitCreate();
                }}
              >
                <header>
                  <div>
                    <span>新建现场配置</span>
                    <strong>模式创建后不可修改</strong>
                  </div>
                </header>
                <div className="site-config-form-grid">
                  <label>
                    <span>配置标识</span>
                    <input
                      aria-label="配置标识"
                      value={createDraft.id}
                      disabled={!canEdit || busy}
                      placeholder="例如：bkv-line-2"
                      onChange={(event) => setCreateDraft((current) => current
                        ? { ...current, id: event.target.value }
                        : current)}
                    />
                  </label>
                  <label>
                    <span>显示名称</span>
                    <input
                      aria-label="显示名称"
                      value={createDraft.displayName}
                      disabled={!canEdit || busy}
                      placeholder="例如：二号线 BKV"
                      onChange={(event) => setCreateDraft((current) => current
                        ? { ...current, displayName: event.target.value }
                        : current)}
                    />
                  </label>
                  <label>
                    <span>运行模式</span>
                    <select
                      aria-label="运行模式"
                      value={createDraft.mode}
                      disabled={!canEdit || busy}
                      onChange={(event) => setCreateDraft((current) => current
                        ? { ...current, mode: event.target.value as SiteMode }
                        : current)}
                    >
                      <option value="bkv">BKV 模式</option>
                      <option value="direct-camera">相机直连模式</option>
                    </select>
                  </label>
                </div>
                <div className="site-config-actions">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setCreateDraft(null)}
                  >
                    取消
                  </button>
                  <button
                    className="primary"
                    type="submit"
                    disabled={!canEdit || busy}
                  >
                    创建配置
                  </button>
                </div>
              </form>
            ) : detail ? (
              <div className="site-config-detail" data-testid="site-config-detail">
                <header className="site-config-detail-header">
                  <div>
                    <span>{detail.site.id}</span>
                    <strong>{detail.site.displayName}</strong>
                  </div>
                  <div className="site-config-state-tags">
                    {detail.site.active ? <b className="active">当前运行</b> : null}
                    {detail.site.pending ? <b className="pending">待重启生效</b> : null}
                  </div>
                </header>

                <div className="site-config-facts">
                  <div className="site-config-mode-fact" data-testid="site-config-mode-setting">
                    <div className="site-config-mode-current">
                      <span>当前配置模式</span>
                      <strong>{modeLabel(detail.document.mode)}</strong>
                      <em>当前配置包创建后不可原地修改</em>
                    </div>
                    <label>
                      <span>设置为</span>
                      <select
                        aria-label="设置配置模式"
                        value={modeDraft ?? detail.document.mode}
                        disabled={!canEdit || busy}
                        onChange={(event) => setModeDraft(event.target.value as SiteMode)}
                      >
                        <option value="bkv">BKV 模式</option>
                        <option value="direct-camera">相机直连模式</option>
                      </select>
                    </label>
                    <button
                      type="button"
                      disabled={!canEdit || busy || !modeDraft
                        || modeDraft === detail.document.mode}
                      onClick={prepareModeChange}
                    >
                      按此模式新建配置
                    </button>
                  </div>
                  <div>
                    <span>相机数量</span>
                    <strong>{detail.site.cameraCount}</strong>
                    <em>由此配置包的运行参数决定</em>
                  </div>
                  <div>
                    <span>配置文件</span>
                    <strong>{detail.document.runtimeProfile}</strong>
                    <em>{detail.document.connectionConfig}</em>
                  </div>
                </div>

                <label className="site-config-name-field">
                  <span>显示名称</span>
                  <input
                    aria-label="显示名称"
                    value={nameDraft}
                    disabled={!canEdit || busy}
                    onChange={(event) => setNameDraft(event.target.value)}
                  />
                  <button
                    type="button"
                    disabled={!canEdit || busy || !nameDraft.trim()
                      || nameDraft.trim() === detail.document.displayName}
                    onClick={() => void saveName()}
                  >
                    保存名称
                  </button>
                </label>

                <section className="site-config-checks">
                  <header>
                    <div>
                      <span>配置可用性检查</span>
                      <strong>
                        {blockingCount > 0 ? '存在阻断项' : '未发现阻断项'}
                      </strong>
                    </div>
                    <div>
                      <button
                        type="button"
                        disabled={!canEdit || busy}
                        onClick={() => void runCheck('default')}
                      >
                        默认检查
                      </button>
                      <button
                        type="button"
                        disabled={!canEdit || busy}
                        onClick={() => void runCheck('deep')}
                      >
                        深度检查
                      </button>
                    </div>
                  </header>
                  <div className="site-config-check-list">
                    {(detail.report?.checks ?? [])
                      .slice()
                      .sort((left, right) => checkPriority(left) - checkPriority(right))
                      .map((check) => (
                        <div key={check.id} className={`status-${check.status}`}>
                          <span>{checkStatusLabel(check.status)}</span>
                          <strong>{check.label}</strong>
                          <em>{check.message}</em>
                          {check.blocking ? <b>阻断切换</b> : null}
                        </div>
                      ))}
                    {!detail.report?.checks.length ? (
                      <div className="admin-empty-state">尚未执行配置检查</div>
                    ) : null}
                  </div>
                </section>

                {blockingCount > 0 ? (
                  <div className="site-config-blocking-notice">存在阻断项，无法切换</div>
                ) : null}
                <div className="site-config-actions">
                  <button
                    type="button"
                    disabled={!canEdit || busy || protectedSite}
                    onClick={() => void remove()}
                  >
                    删除配置
                  </button>
                  <button
                    className="primary"
                    type="button"
                    disabled={activateDisabled}
                    onClick={() => void activate()}
                  >
                    切换到此配置
                  </button>
                </div>
              </div>
            ) : (
              <div className="admin-empty-state">选择一个现场配置查看详情</div>
            )}
          </section>
        </div>
      </Panel>
      <details className="site-config-compatibility-detail">
        <summary>当前运行配置兼容编辑器</summary>
        <RuntimeProfileManagementPanel canEdit={canEdit} />
      </details>
    </div>
  );
}
