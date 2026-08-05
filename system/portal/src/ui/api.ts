import type {
  ApiErrorResponse,
  CreateAppRequestBody,
  CreateAppResponse,
  QuotaResponse,
  RequestStatusResponse,
} from "../shared/validation";

/** The portal's own HTTP API, as the form sees it. */
export interface PortalApi {
  quota(): Promise<QuotaResponse>;
  create(body: CreateAppRequestBody): Promise<CreateAppResponse>;
  status(requestId: string): Promise<RequestStatusResponse>;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function readJson<T>(response: Response): Promise<T> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const error = (payload ?? {}) as Partial<ApiErrorResponse>;
    throw new ApiError(error.message ?? error.error ?? "request failed", response.status, error.error);
  }
  return payload as T;
}

export const browserApi: PortalApi = {
  async quota() {
    return readJson<QuotaResponse>(await fetch("/api/quota"));
  },
  async create(body) {
    return readJson<CreateAppResponse>(
      await fetch("/api/apps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  },
  async status(requestId) {
    return readJson<RequestStatusResponse>(await fetch(`/api/requests/${encodeURIComponent(requestId)}`));
  },
};
