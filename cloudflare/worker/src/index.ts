import type { Env } from './env'
import { handleApi } from './routes/api'

/** Durable Object 类必须从入口导出，wrangler 才能绑定 */
export { BaiduTokenObject } from './baidu/token-object'

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    // /api/* 走业务路由，其余交给静态资源绑定（前端构建产物）
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return handleApi(request, env)
    }

    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>
