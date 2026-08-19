import { createHmac } from 'node:crypto'
import {
  SUBSCRIPTION_TOKEN_TTL_MS,
  formatSubscriptionToken,
  subscriptionTokenSignedInput,
  type WorkspaceId,
} from '@loom/domain'

/**
 * The signing half of the realtime gateway's credential.
 *
 * This process signs and never verifies; apps/ws-gateway verifies and never signs. Keeping
 * them apart is what makes the shared secret's blast radius one direction: a gateway that is
 * compromised can read what it was already fanning out, and cannot mint a token for a
 * workspace it was never given.
 */

export interface SubscriptionTokenGrant {
  readonly token: string
  readonly expiresAt: Date
}

export type SubscriptionTokenMinter = (workspaceId: WorkspaceId) => SubscriptionTokenGrant

export const subscriptionTokenMinter =
  (secret: string, clock: () => number = Date.now): SubscriptionTokenMinter =>
  (workspaceId) => {
    const expiresAtMs = clock() + SUBSCRIPTION_TOKEN_TTL_MS
    /**
     * The workspace is taken from the resolved session by every caller and never from
     * input — the rule, and the one that matters most here, since a minted token is
     * exactly the authority this endpoint would otherwise hand out on request.
     */
    const signedInput = subscriptionTokenSignedInput({ workspaceId, expiresAtMs })
    const signature = createHmac('sha256', secret).update(signedInput).digest('base64url')
    return {
      token: formatSubscriptionToken({ workspaceId, expiresAtMs }, signature),
      expiresAt: new Date(expiresAtMs),
    }
  }
