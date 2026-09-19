import type { PermissionAction, PolicyVerdict, SecurityConfig } from "./policy.js";

export interface PermissionGate {
  request(action: PermissionAction, detail: string): Promise<PolicyVerdict>;
  resolveAsk(action: PermissionAction, detail: string): Promise<boolean>;
}

export function createPermissionGate(
  policy: SecurityConfig,
  resolveAsk?: (action: PermissionAction, detail: string) => Promise<boolean>,
): PermissionGate {
  return {
    async request(action, detail) {
      return policy[action] ?? policy.default;
    },
    async resolveAsk(action, detail) {
      if (resolveAsk) return resolveAsk(action, detail);
      console.error(`[OpenPluseXYZ] ask: ${action} ${detail}`);
      return false;
    },
  };
}
