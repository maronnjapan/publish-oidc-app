import { type FormAction, type FormState, enabledSummary, toRequestBody } from "./form-state";
import { ApiError, type PortalApi } from "./api";
import { formErrors } from "./validation";

/**
 * Creating an OP, from the button press to the credentials panel.
 *
 * Written against a clock and an API object rather than `window` so the whole sequence —
 * including the poll interval, the ten-minute ceiling and the retry on a failed status
 * check — is exercised in tests without a browser or real time passing.
 */

export const POLL_INTERVAL_MS = 3_000;
export const POLL_TIMEOUT_MS = 10 * 60 * 1000;

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

async function refreshQuota(api: PortalApi, dispatch: (action: FormAction) => void): Promise<void> {
  try {
    const quota = await api.quota();
    dispatch({
      type: "set-quota",
      quota: { loaded: true, limit: quota.limit, remaining: quota.remaining, failed: false },
    });
  } catch {
    dispatch({ type: "set-quota", quota: { loaded: true, limit: 0, remaining: 0, failed: true } });
  }
}

export function loadQuota(api: PortalApi, dispatch: (action: FormAction) => void): Promise<void> {
  return refreshQuota(api, dispatch);
}

export async function createOp({
  state,
  api,
  dispatch,
  clock = realClock,
}: {
  state: FormState;
  api: PortalApi;
  dispatch: (action: FormAction) => void;
  clock?: Clock;
}): Promise<void> {
  dispatch({ type: "show-errors" });
  const errors = formErrors(state);
  if (!errors.valid) {
    dispatch({ type: "set-submission", submission: { phase: "error", message: errors.form || errors.redirectUrl || "入力内容を確認してください。" } });
    return;
  }

  dispatch({ type: "set-submission", submission: { phase: "busy", message: "作成リクエストを送信しています…" } });
  const enabled = enabledSummary(state);
  let created: Awaited<ReturnType<PortalApi["create"]>>;
  try {
    created = await api.create(toRequestBody(state));
  } catch (error) {
    const rateLimited = error instanceof ApiError && error.status === 429;
    if (rateLimited) {
      dispatch({ type: "set-quota", quota: { loaded: true, limit: state.quota.limit, remaining: 0, failed: false } });
    }
    const message = rateLimited ? "本日の作成上限に達しました" : error instanceof Error ? error.message : String(error);
    dispatch({ type: "set-submission", submission: { phase: "error", message: `作成に失敗しました（${message}）` } });
    await refreshQuota(api, dispatch);
    return;
  }

  dispatch({ type: "set-submission", submission: { phase: "busy", message: "OPを作成しています…" } });
  await refreshQuota(api, dispatch);

  const startedAt = clock.now();
  const credentials = { clientId: created.client_id, clientSecret: created.client_secret };
  for (;;) {
    if (clock.now() - startedAt > POLL_TIMEOUT_MS) {
      dispatch({ type: "set-submission", submission: { phase: "error", message: "作成状況の確認がタイムアウトしました。" } });
      return;
    }
    try {
      const status = await api.status(created.request_id);
      if (status.status === "deployed") {
        dispatch({
          type: "set-submission",
          submission: { phase: "done", url: status.url ?? "", credentials, enabled },
        });
        return;
      }
      if (status.status === "failed") {
        dispatch({
          type: "set-submission",
          submission: { phase: "error", message: `作成に失敗しました（${status.error || "ci_failed"}）` },
        });
        return;
      }
      dispatch({
        type: "set-submission",
        submission: { phase: "busy", message: `OPを作成しています… 現在: ${status.status}` },
      });
    } catch {
      dispatch({
        type: "set-submission",
        submission: { phase: "busy", message: "状態を取得できませんでした。再試行しています…" },
      });
    }
    await clock.sleep(POLL_INTERVAL_MS);
  }
}
