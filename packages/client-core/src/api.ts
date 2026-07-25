import type { Contract } from '@loom/api-contract'
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import type { ContractRouterClient } from '@orpc/contract'

export type LoomApi = ContractRouterClient<Contract>

/**
 * The only module allowed to know a network exists (PLAN.md §4c). Every client —
 * browser, terminal, script — goes through this, so no view layer ever holds a
 * URL or a fetch call.
 */
export const createApi = (options: {
  rpcUrl: string
  headers?: Record<string, string>
}): LoomApi =>
  createORPCClient(
    new RPCLink({
      url: options.rpcUrl,
      headers: () => options.headers ?? {},
      // The RPC server and the browser app are cross-origin by default (see
      // WEB_ORIGIN/RPC_URL in apps/web) — the session cookie only rides along
      // if every request explicitly asks for it.
      fetch: (request, init) => globalThis.fetch(request, { ...init, credentials: 'include' }),
    }),
  )
