// The status strip: whatever is currently wrong, all of it at once.
//
// Driven by condition *records*, not by a hardcoded list of things that can
// break. Ticket 020's degraded-guard banner is a consumer of this, not a
// special case in the shell — it raises a condition and this renders it. So
// does the socket client, and so will anything later that needs to say "the
// board you are looking at may not be current".
//
// Any number of conditions coexist and clear independently. That matters
// because the interesting failures overlap: a guard running degraded *and*
// a dropped socket is a worse situation than either alone, and a strip that
// shows only the most recent one hides exactly that.
import { useCallback, useMemo, useState } from "react";

export type ConditionSeverity = "info" | "warning" | "error";

export interface HealthCondition {
  /** Stable identity. Raising the same key twice updates rather than
   * duplicates — a reconnect loop must not stack fifty banners. */
  readonly key: string;
  readonly severity: ConditionSeverity;
  readonly message: string;
  /** Optional detail, shown smaller. */
  readonly detail?: string;
}

export interface HealthConditions {
  readonly conditions: readonly HealthCondition[];
  readonly raise: (condition: HealthCondition) => void;
  readonly clear: (key: string) => void;
}

/**
 * Condition state, as a hook so any component can raise one.
 *
 * Deliberately not a global singleton: the shell owns the set and passes
 * `raise`/`clear` down, which keeps the strip testable without a module
 * reset between tests.
 */
export function useHealthConditions(
  initial: readonly HealthCondition[] = [],
): HealthConditions {
  const [conditions, setConditions] = useState<readonly HealthCondition[]>(initial);

  const raise = useCallback((condition: HealthCondition) => {
    setConditions((current) => {
      const without = current.filter((existing) => existing.key !== condition.key);
      return [...without, condition];
    });
  }, []);

  const clear = useCallback((key: string) => {
    setConditions((current) => current.filter((existing) => existing.key !== key));
  }, []);

  return useMemo(() => ({ conditions, raise, clear }), [conditions, raise, clear]);
}

const SEVERITY_ORDER: Record<ConditionSeverity, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

export function SystemStatus({
  conditions,
}: {
  readonly conditions: readonly HealthCondition[];
}): React.ReactElement | null {
  // Nothing wrong, nothing rendered: a permanently-present "all good" strip
  // is a strip people stop reading.
  if (conditions.length === 0) return null;

  const ordered = [...conditions].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.key.localeCompare(b.key),
  );

  return (
    <div className="system-status" role="status" aria-live="polite">
      {ordered.map((condition) => (
        <div
          key={condition.key}
          className={`system-status__item system-status__item--${condition.severity}`}
          data-condition={condition.key}
          data-severity={condition.severity}
        >
          <span className="system-status__message">{condition.message}</span>
          {condition.detail ? (
            <span className="system-status__detail">{condition.detail}</span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** The key the socket client's condition uses. Exported so the shell and
 * any test refer to the same string rather than two spellings of it. */
export const SOCKET_CONDITION_KEY = "socket";
