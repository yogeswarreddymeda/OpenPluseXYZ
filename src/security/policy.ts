export type PermissionAction = "read" | "write" | "execute";

export type PolicyVerdict = "allow" | "deny" | "ask";

export interface SecurityConfig {
  default: PolicyVerdict;
  read: PolicyVerdict;
  write: PolicyVerdict;
  execute: PolicyVerdict;
}

type RawSecurityConfig = Partial<Record<"default" | PermissionAction, string>>;

function normalize(value: unknown): PolicyVerdict {
  return value === "allow" || value === "deny" || value === "ask" ? value : "ask";
}

export function parseSecurityConfig(raw: RawSecurityConfig | undefined): SecurityConfig {
  return {
    default: normalize(raw?.default ?? "ask"),
    read: normalize(raw?.read ?? "allow"),
    write: normalize(raw?.write ?? "ask"),
    execute: normalize(raw?.execute ?? "ask"),
  };
}

export function evaluatePolicy(
  policy: SecurityConfig,
  action: PermissionAction,
): PolicyVerdict {
  return policy[action] ?? policy.default;
}

const BLOCKED_SHELL_PATTERNS: RegExp[] = [
  /bin\/bash.*dev\/tcp/i,
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*)\s+(\/|\/\*|~)/i,
  /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+\/~?\/?(?=\s|$)/i,
  /\bmkfs(\.\w+)?\s/i,
  /\bdd\s+if=/i,
  /\b:\(\)\s*\{/i,
  /\b(^|\s)(shutdown|reboot|poweroff|halt)(\s|$)/i,
  /\bformat\s+[a-z]:/i,
  /\bdel\s+\/f\s+\/s/i,
  /\bgit\s+push\s+(--force|-f)/i,
  /\bgit\s+commits?\s+--(amend\s+--no-edit)?.*/i,
  /\bgit\s+reset\s+--hard\s+(HEAD~|--)/i,
  /\bbase64\s+--decode.*\|\s*(bash|sh|zsh)/i,
  /\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh)\b/i,
  /\bsudo\s+rm\s+-rf/i,
  /\bchown\s+-R\s+.*\s+\//i,
  /\bchmod\s+-R\s+777\s+\//i,
];

export function isBlockedShellCommand(command: string): boolean {
  const normalized = command.replace(/\s+/g, " ").trim();
  return BLOCKED_SHELL_PATTERNS.some((re) => re.test(normalized));
}