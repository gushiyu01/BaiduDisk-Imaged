<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Connection,
  FolderOpened,
  Link,
  Refresh,
  RefreshRight,
  Search,
  SwitchButton,
  WarningFilled
} from '@element-plus/icons-vue'
import type { BaiduStatus, BrowseEntry, DiagnoseCheck, DiagnoseResult, SyncResult, SystemInfo } from '../types'
import {
  browse,
  diagnose,
  disconnect,
  getAuthorizeUrl,
  getBaiduStatus,
  refreshToken,
  submitToken
} from '../api/baidu'
import { clearCache, getSystemInfo } from '../api/system'
import { syncImages } from '../api/images'
import { getErrorMessage, toApiRequestError } from '../api/client'
import { formatBytes, formatDateTime, formatElapsed } from '../utils/format'
import { useImagesStore } from '../stores/images'
import { useTagsStore } from '../stores/tags'

const imagesStore = useImagesStore()
const tagsStore = useTagsStore()

/* ---------------- 授权状态 ---------------- */

const status = ref<BaiduStatus | null>(null)
const statusLoading = ref(false)
const statusError = ref('')

const configured = computed(() => status.value?.configured === true)
const authorized = computed(() => status.value?.authorized === true)

async function loadStatus(): Promise<void> {
  statusLoading.value = true
  statusError.value = ''
  try {
    status.value = await getBaiduStatus()
  } catch (err) {
    statusError.value = getErrorMessage(err)
  } finally {
    statusLoading.value = false
  }
}

/* ---------------- 开始授权 ---------------- */

const authorizeUrl = ref('')
const authorizeLoading = ref(false)
const authCode = ref('')
const tokenLoading = ref(false)
const tokenError = ref('')
const tokenErrorCode = ref('')

async function startAuthorize(): Promise<void> {
  authorizeLoading.value = true
  tokenError.value = ''
  try {
    const result = await getAuthorizeUrl()
    authorizeUrl.value = result.url
    window.open(result.url, '_blank', 'noopener,noreferrer')
    ElMessage.info('已在新窗口打开百度授权页，授权后把授权码粘贴到下方输入框')
  } catch (err) {
    tokenError.value = getErrorMessage(err)
    tokenErrorCode.value = toApiRequestError(err).code
  } finally {
    authorizeLoading.value = false
  }
}

async function copyAuthorizeUrl(): Promise<void> {
  if (!authorizeUrl.value) return
  try {
    await navigator.clipboard.writeText(authorizeUrl.value)
    ElMessage.success('授权链接已复制')
  } catch {
    ElMessage.warning('复制失败，请手动选中链接复制')
  }
}

async function submitAuthCode(): Promise<void> {
  const code = authCode.value.trim()
  if (!code) {
    ElMessage.warning('请先粘贴授权码')
    return
  }
  tokenLoading.value = true
  tokenError.value = ''
  tokenErrorCode.value = ''
  try {
    status.value = await submitToken({ code })
    authCode.value = ''
    authorizeUrl.value = ''
    ElMessage.success('授权成功')
  } catch (err) {
    const apiError = toApiRequestError(err)
    tokenErrorCode.value = apiError.code
    tokenError.value = apiError.message
  } finally {
    tokenLoading.value = false
  }
}

/* ---------------- 刷新 / 断开 ---------------- */

const refreshing = ref(false)

async function doRefresh(): Promise<void> {
  refreshing.value = true
  try {
    status.value = await refreshToken()
    ElMessage.success('令牌已刷新')
  } catch (err) {
    ElMessage.error(getErrorMessage(err))
  } finally {
    refreshing.value = false
  }
}

const disconnecting = ref(false)

async function doDisconnect(): Promise<void> {
  try {
    await ElMessageBox.confirm(
      '断开后本地令牌会被清除，缩略图与原图预览将不可用，需要重新授权。确定继续吗？',
      '断开百度网盘授权',
      { confirmButtonText: '断开授权', cancelButtonText: '取消', type: 'warning' }
    )
  } catch {
    return
  }
  disconnecting.value = true
  try {
    await disconnect()
    ElMessage.success('已断开授权')
    await loadStatus()
  } catch (err) {
    ElMessage.error(getErrorMessage(err))
  } finally {
    disconnecting.value = false
  }
}

/* ---------------- 同步索引 ---------------- */

const syncDir = ref('')
const syncing = ref(false)
const syncResult = ref<SyncResult | null>(null)
const syncError = ref('')

async function doSync(): Promise<void> {
  syncing.value = true
  syncResult.value = null
  syncError.value = ''
  try {
    const dir = syncDir.value.trim()
    syncResult.value = await syncImages({ dir: dir || undefined })
    ElMessage.success('同步完成')
    await imagesStore.fetch().catch(() => undefined)
    await tagsStore.fetchTags().catch(() => undefined)
  } catch (err) {
    syncError.value = getErrorMessage(err)
  } finally {
    syncing.value = false
  }
}

/* ---------------- 接口体检 ---------------- */

const diagnosing = ref(false)
const diagnoseResult = ref<DiagnoseResult | null>(null)
const diagnoseError = ref('')

async function doDiagnose(): Promise<void> {
  diagnosing.value = true
  diagnoseResult.value = null
  diagnoseError.value = ''
  try {
    // 只渲染后端真实返回的结果，前端不做任何补全或伪造
    diagnoseResult.value = await diagnose()
  } catch (err) {
    diagnoseError.value = getErrorMessage(err)
  } finally {
    diagnosing.value = false
  }
}

function statusTagType(value: DiagnoseCheck['status']): 'success' | 'danger' | 'info' {
  if (value === 'PASS') return 'success'
  if (value === 'FAIL') return 'danger'
  return 'info'
}

/** 只渲染后端返回的内容，缺失字段按空处理，不补全 */
const diagnoseChecks = computed<DiagnoseCheck[]>(() =>
  Array.isArray(diagnoseResult.value?.checks) ? (diagnoseResult.value?.checks ?? []) : []
)
const diagnoseSummary = computed(() => diagnoseResult.value?.summary ?? '')
const diagnoseHasFail = computed(() => diagnoseChecks.value.some((check) => check.status === 'FAIL'))

/* ---------------- 目录浏览 ---------------- */

const browseDir = ref('/')
const browseEntries = ref<BrowseEntry[]>([])
const browseLoading = ref(false)
const browseError = ref('')

function parentDir(dir: string): string {
  if (!dir || dir === '/') return '/'
  const trimmed = dir.replace(/\/+$/, '')
  const index = trimmed.lastIndexOf('/')
  if (index <= 0) return '/'
  return trimmed.slice(0, index)
}

async function loadBrowse(dir: string): Promise<void> {
  browseLoading.value = true
  browseError.value = ''
  try {
    const result = await browse(dir)
    browseDir.value = result.dir
    browseEntries.value = Array.isArray(result.entries) ? result.entries : []
  } catch (err) {
    browseError.value = getErrorMessage(err)
    browseEntries.value = []
  } finally {
    browseLoading.value = false
  }
}

function enterEntry(entry: BrowseEntry): void {
  if (entry.isdir) void loadBrowse(entry.path)
}

function openBaseDir(): void {
  const dir = status.value?.baseDir
  if (dir) void loadBrowse(dir)
}

/* ---------------- 系统信息 ---------------- */

const systemInfo = ref<SystemInfo | null>(null)
const systemError = ref('')
const systemLoading = ref(false)
const clearing = ref(false)

async function loadSystemInfo(): Promise<void> {
  systemLoading.value = true
  systemError.value = ''
  try {
    systemInfo.value = await getSystemInfo()
  } catch (err) {
    systemError.value = getErrorMessage(err)
  } finally {
    systemLoading.value = false
  }
}

async function doClearCache(): Promise<void> {
  try {
    await ElMessageBox.confirm('将清空后端本地的缩略图缓存，下次浏览会重新生成。确定继续吗？', '清空缩略图缓存', {
      confirmButtonText: '清空',
      cancelButtonText: '取消',
      type: 'warning'
    })
  } catch {
    return
  }
  clearing.value = true
  try {
    await clearCache()
    ElMessage.success('缩略图缓存已清空')
    await loadSystemInfo()
  } catch (err) {
    ElMessage.error(getErrorMessage(err))
  } finally {
    clearing.value = false
  }
}

/* ---------------- 生命周期 ---------------- */

onMounted(async () => {
  await loadStatus()
  await loadBrowse('/')
  await loadSystemInfo()
})
</script>

<template>
  <div class="picman-page">
    <div class="picman-page-head">
      <div>
        <h1 class="picman-page-title">百度网盘</h1>
        <p class="picman-page-subtitle">授权、索引同步与接口体检</p>
      </div>
      <el-button :icon="Refresh" :loading="statusLoading" @click="loadStatus">刷新状态</el-button>
    </div>

    <!-- 状态 -->
    <div class="picman-card" v-loading="statusLoading">
      <h2 class="picman-card-title">授权状态</h2>

      <el-alert
        v-if="statusError"
        type="error"
        show-icon
        :closable="false"
        title="获取授权状态失败"
      >
        <template #default>
          <div class="picman-alert-body">
            <span>{{ statusError }}</span>
            <el-button size="small" type="primary" @click="loadStatus">重试</el-button>
          </div>
        </template>
      </el-alert>

      <template v-else-if="status">
        <el-descriptions :column="2" border>
          <el-descriptions-item label="后端凭证配置">
            <el-tag :type="configured ? 'success' : 'danger'" effect="light">
              {{ configured ? '已配置' : '未配置' }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="授权状态">
            <el-tag :type="authorized ? 'success' : 'warning'" effect="light">
              {{ authorized ? '已授权' : '未授权' }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="令牌有效期">
            {{ status.expiresAt ? formatDateTime(status.expiresAt) : '-' }}
          </el-descriptions-item>
          <el-descriptions-item label="授权范围">{{ status.scope || '-' }}</el-descriptions-item>
          <el-descriptions-item label="百度账号">{{ status.accountName || '-' }}</el-descriptions-item>
          <el-descriptions-item label="用户 uk">{{ status.uk || '-' }}</el-descriptions-item>
          <el-descriptions-item label="基础目录" :span="2">
            {{ status.baseDir || '-' }}
          </el-descriptions-item>
        </el-descriptions>
      </template>

      <el-skeleton v-else :rows="3" animated />
    </div>

    <!-- 未配置凭证 -->
    <el-alert
      v-if="status && !configured"
      class="picman-section-alert"
      type="error"
      show-icon
      :closable="false"
      title="后端未配置百度网盘应用凭证"
    >
      <template #default>
        <div class="picman-alert-body picman-alert-column">
          <span>
            需要配置 <code>BAIDU_DISK_APP_KEY</code> 与 <code>BAIDU_DISK_SECRET_KEY</code>。
            先在
            <a
              class="picman-alert-link"
              href="https://pan.baidu.com/union/console/applist"
              target="_blank"
              rel="noopener noreferrer"
            >
              百度网盘开放平台 → 应用列表
            </a>
            里创建应用，然后到「应用详情 → 应用凭证」取这两个值。设置位置按部署方式不同：
          </span>
          <span>
            · <strong>Cloudflare 版</strong>：在 <code>cloudflare/worker</code> 下执行
            <code>npx wrangler secret put BAIDU_DISK_APP_KEY</code>（SecretKey 同理），
            下发后立即生效；或直接重跑 <code>node cloudflare/deploy.mjs</code>。
          </span>
          <span>
            · <strong>自建版</strong>：在 <code>.env</code> 里配置后<strong>重启后端服务</strong>。
          </span>
          <span>配置完成后点击右上角「刷新状态」，即可进行授权与同步操作。</span>
        </div>
      </template>
    </el-alert>

    <!-- 未授权 → 授权流程 -->
    <div v-if="status && configured && !authorized" class="picman-card">
      <h2 class="picman-card-title">开始授权</h2>
      <el-steps :active="authorizeUrl ? 1 : 0" simple class="picman-steps">
        <el-step title="打开百度授权页" />
        <el-step title="复制授权码" />
        <el-step title="粘贴并提交" />
      </el-steps>

      <div class="picman-auth-steps">
        <div class="picman-step-block">
          <el-button
            type="primary"
            :icon="Link"
            :loading="authorizeLoading"
            @click="startAuthorize"
          >
            开始授权
          </el-button>
          <span class="picman-step-hint">将在新窗口打开百度网盘授权页面</span>
        </div>

        <div v-if="authorizeUrl" class="picman-step-block picman-step-block-column">
          <span class="picman-step-hint">
            若浏览器拦截了弹窗，请手动复制下面的授权链接在浏览器打开：
          </span>
          <div class="picman-url-row">
            <el-input :model-value="authorizeUrl" readonly />
            <el-button @click="copyAuthorizeUrl">复制链接</el-button>
          </div>
        </div>

        <div class="picman-step-block picman-step-block-column">
          <span class="picman-step-hint">
            在百度授权页完成授权后，页面会显示一串<strong>授权码</strong>，复制并粘贴到这里：
          </span>
          <div class="picman-url-row">
            <el-input
              v-model="authCode"
              placeholder="粘贴授权码"
              clearable
              :disabled="tokenLoading"
              @keyup.enter="submitAuthCode"
            />
            <el-button type="primary" :loading="tokenLoading" @click="submitAuthCode">
              提交授权码
            </el-button>
          </div>
        </div>

        <el-alert
          v-if="tokenError"
          type="error"
          show-icon
          :closable="false"
          :title="tokenErrorCode === 'OAUTH_FAILED' ? '授权失败（OAUTH_FAILED）' : '授权失败'"
          :description="tokenError"
        />
      </div>
    </div>

    <!-- 已授权操作 -->
    <div v-if="status && authorized" class="picman-card">
      <h2 class="picman-card-title">令牌操作</h2>
      <div class="picman-action-row">
        <el-button :icon="RefreshRight" :loading="refreshing" @click="doRefresh">刷新令牌</el-button>
        <el-button
          type="danger"
          plain
          :icon="SwitchButton"
          :loading="disconnecting"
          @click="doDisconnect"
        >
          断开授权
        </el-button>
        <span class="picman-step-hint">
          令牌由后端保存，前端无法也不接触任何百度网盘令牌。
        </span>
      </div>
    </div>

    <!-- 同步索引 -->
    <div class="picman-card">
      <h2 class="picman-card-title">同步索引</h2>
      <div class="picman-url-row picman-sync-row">
        <el-input
          v-model="syncDir"
          placeholder="可选：指定同步目录，留空则使用后端默认基础目录"
          clearable
          :disabled="syncing"
        />
        <el-button type="primary" :icon="FolderOpened" :loading="syncing" @click="doSync">
          同步索引
        </el-button>
      </div>

      <el-alert
        v-if="syncError"
        class="picman-section-alert"
        type="error"
        show-icon
        :closable="false"
        title="同步失败"
        :description="syncError"
      />

      <template v-if="syncResult">
        <el-descriptions class="picman-result" :column="3" border>
          <el-descriptions-item label="扫描文件">{{ syncResult.scanned }}</el-descriptions-item>
          <el-descriptions-item label="新增">{{ syncResult.added }}</el-descriptions-item>
          <el-descriptions-item label="更新">{{ syncResult.updated }}</el-descriptions-item>
          <el-descriptions-item label="移除">{{ syncResult.removed }}</el-descriptions-item>
          <el-descriptions-item label="失败">{{ syncResult.failed }}</el-descriptions-item>
          <el-descriptions-item label="耗时">
            {{ formatElapsed(syncResult.elapsedMs) }}
          </el-descriptions-item>
        </el-descriptions>
      </template>
    </div>

    <!-- 接口体检 -->
    <div class="picman-card">
      <h2 class="picman-card-title">接口体检</h2>
      <div class="picman-action-row">
        <el-button type="primary" :icon="Search" :loading="diagnosing" @click="doDiagnose">
          接口体检
        </el-button>
        <span class="picman-step-hint">
          逐项真实调用百度网盘开放平台接口，结果与耗时均由后端返回，前端不做任何加工。
        </span>
      </div>

      <el-alert
        v-if="diagnoseError"
        class="picman-section-alert"
        type="error"
        show-icon
        :closable="false"
        title="体检请求失败"
        :description="diagnoseError"
      />

      <template v-if="diagnoseResult">
        <el-alert
          class="picman-result"
          :type="diagnoseHasFail ? 'warning' : 'success'"
          show-icon
          :closable="false"
          :title="diagnoseSummary"
        />

        <el-table :data="diagnoseChecks" border style="width: 100%">
          <el-table-column prop="name" label="检查项" width="140" />
          <el-table-column prop="key" label="key" width="120" />
          <el-table-column label="结果" width="100">
            <template #default="{ row }">
              <el-tag :type="statusTagType(row.status)" effect="light">{{ row.status }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="detail" label="详情" min-width="260">
            <template #default="{ row }">
              <span class="picman-detail-cell">{{ row.detail === '' ? '（后端未返回详情）' : row.detail }}</span>
            </template>
          </el-table-column>
          <el-table-column label="耗时" width="110">
            <template #default="{ row }">{{ formatElapsed(row.elapsedMs) }}</template>
          </el-table-column>
        </el-table>
      </template>
    </div>

    <!-- 目录浏览 -->
    <div class="picman-card">
      <h2 class="picman-card-title">网盘目录浏览</h2>
      <el-alert
        class="picman-section-alert"
        type="info"
        show-icon
        :closable="false"
        title="此浏览仅用于查看网盘目录结构"
        description="实际生效的基础目录由后端环境变量配置，前端无法修改；如需变更请调整后端配置并重启服务。"
      />

      <div class="picman-action-row">
        <el-button :icon="Refresh" :loading="browseLoading" @click="loadBrowse(browseDir)">
          刷新当前目录
        </el-button>
        <el-button :disabled="browseDir === '/'" @click="loadBrowse(parentDir(browseDir))">
          上一级
        </el-button>
        <el-input
          :model-value="browseDir"
          class="picman-dir-input"
          readonly
          placeholder="当前目录"
        />
        <el-button :disabled="!status?.baseDir" @click="openBaseDir">
          打开后端基础目录
        </el-button>
      </div>

      <el-alert
        v-if="browseError"
        class="picman-section-alert"
        type="error"
        show-icon
        :closable="false"
        title="目录加载失败"
        :description="browseError"
      />

      <el-table
        v-loading="browseLoading"
        :data="browseEntries"
        border
        max-height="420"
        style="width: 100%"
      >
        <el-table-column label="名称" min-width="220">
          <template #default="{ row }">
            <span class="picman-entry-name" :class="{ 'is-dir': row.isdir }" @click="enterEntry(row)">
              <el-icon><FolderOpened v-if="row.isdir" /><Document v-else /></el-icon>
              <span>{{ row.name }}</span>
            </span>
          </template>
        </el-table-column>
        <el-table-column prop="path" label="路径" min-width="260" show-overflow-tooltip />
        <el-table-column label="类型" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="row.isdir ? 'primary' : 'info'" effect="plain">
              {{ row.isdir ? '目录' : '文件' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="大小" width="120">
          <template #default="{ row }">{{ row.isdir ? '-' : formatBytes(row.size) }}</template>
        </el-table-column>

        <template #empty>
          <el-empty description="该目录下没有内容" />
        </template>
      </el-table>
    </div>

    <!-- 系统信息 -->
    <div class="picman-card" v-loading="systemLoading">
      <h2 class="picman-card-title">系统信息</h2>

      <el-alert
        v-if="systemError"
        class="picman-section-alert"
        type="error"
        show-icon
        :closable="false"
        title="系统信息加载失败"
        :description="systemError"
      />

      <template v-if="systemInfo">
        <el-descriptions :column="2" border>
          <el-descriptions-item label="版本">{{ systemInfo.version }}</el-descriptions-item>
          <el-descriptions-item label="索引图片数">{{ systemInfo.imageCount }}</el-descriptions-item>
          <el-descriptions-item label="标签数">{{ systemInfo.tagCount }}</el-descriptions-item>
          <el-descriptions-item label="缩略图缓存">
            {{ formatBytes(systemInfo.cacheSizeBytes) }}
          </el-descriptions-item>
          <el-descriptions-item label="基础目录" :span="2">
            {{ systemInfo.baseDir }}
          </el-descriptions-item>
          <el-descriptions-item label="缓存目录" :span="2">
            {{ systemInfo.cacheDir }}
          </el-descriptions-item>
          <el-descriptions-item label="数据库" :span="2">{{ systemInfo.dbPath }}</el-descriptions-item>
        </el-descriptions>

        <div class="picman-action-row picman-result">
          <el-button :icon="WarningFilled" :loading="clearing" plain type="warning" @click="doClearCache">
            清空缩略图缓存
          </el-button>
          <el-button :icon="Connection" @click="loadSystemInfo">刷新系统信息</el-button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.picman-card {
  padding: 16px;
  margin-bottom: 16px;
  background: #fff;
  border-radius: 8px;
  box-shadow: var(--el-box-shadow-light);
}

.picman-section-alert {
  margin-bottom: 12px;
}

.picman-alert-body {
  display: flex;
  gap: 10px;
  align-items: center;
  justify-content: space-between;
}

.picman-alert-column {
  flex-direction: column;
  align-items: flex-start;
}

/* 提示里的外链：报错时用户最需要的就是「去哪申请凭证」 */
.picman-alert-link {
  color: var(--el-color-primary);
  text-decoration: underline;
}

.picman-alert-link:hover {
  opacity: 0.8;
}

.picman-steps {
  margin-bottom: 14px;
}

.picman-auth-steps {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.picman-step-block {
  display: flex;
  gap: 12px;
  align-items: center;
}

.picman-step-block-column {
  flex-direction: column;
  align-items: stretch;
}

.picman-step-hint {
  font-size: 12px;
  line-height: 1.6;
  color: var(--el-text-color-secondary);
}

.picman-url-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.picman-sync-row {
  margin-bottom: 12px;
}

.picman-action-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}

.picman-result {
  margin-top: 12px;
}

.picman-detail-cell {
  word-break: break-all;
  white-space: normal;
}

.picman-dir-input {
  width: 260px;
}

.picman-entry-name {
  display: inline-flex;
  gap: 6px;
  align-items: center;
}

.picman-entry-name.is-dir {
  color: var(--el-color-primary);
  cursor: pointer;
}

.picman-entry-name.is-dir:hover {
  text-decoration: underline;
}

code {
  padding: 0 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: var(--el-fill-color-light);
  border-radius: 3px;
}

@media (max-width: 768px) {
  .picman-url-row {
    flex-direction: column;
    align-items: stretch;
  }

  .picman-dir-input {
    width: 100%;
  }
}
</style>
