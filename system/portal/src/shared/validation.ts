import { z } from "zod";
import { type CatalogFeature, type OptInGroup, optInFeatures } from "./catalog";
import {
  CLIENT_TYPES,
  type ClientType,
  FEATURE_NAMES,
  type FeatureName,
  MAX_USERS,
  MIN_USERS,
  NAME_PATTERN,
  OPTIONAL_SCOPES,
  REQUIRED_SCOPE,
  inspectRedirectUrl,
  isValidPassword,
  isValidUsername,
  offlineAccessNeedsRefreshToken,
} from "./rules";

/**
 * The schema of `POST /api/apps`.
 *
 * The messages are deliberately field-specific: a rejected creation should tell the caller
 * which value to fix, not just that the body was wrong. Each field therefore reports the one
 * rule it broke and stops, which is why the checks are written as ordered transforms rather
 * than as a pile of independent refinements — the caller gets the first real problem, in the
 * order a person would read the form.
 */

export type FeatureSelection = Record<string, Record<string, boolean>>;

export interface PortalUser {
  username: string;
  password: string;
}

export interface CreateAppInput {
  name: string;
  redirectUrl: string;
  clientType: ClientType;
  scopes: string[];
  features: Record<FeatureName, boolean>;
  optional: FeatureSelection;
  experimental: FeatureSelection;
  users: PortalUser[];
}

const REDIRECT_URL_MESSAGE =
  "redirect URL must be an https URL (http is allowed only on localhost) without credentials or a fragment";
const DISPLAY_NAME_MESSAGE =
  "display name must be 40 characters or fewer and must not contain control characters";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Ends the field with one message. Zod carries it out; nothing downstream sees the value. */
function reject(ctx: z.RefinementCtx, message: string): never {
  ctx.addIssue({ code: "custom", message });
  return z.NEVER;
}

const displayName = z.unknown().transform((value, ctx): string => {
  if (value !== undefined && value !== null && typeof value !== "string") {
    return reject(ctx, "display name must be a string");
  }
  const name = (value ?? "").toString().trim();
  return NAME_PATTERN.test(name) ? name : reject(ctx, DISPLAY_NAME_MESSAGE);
});

const redirectUrl = z.unknown().transform((value, ctx): string => {
  if (typeof value !== "string") return reject(ctx, REDIRECT_URL_MESSAGE);
  const result = inspectRedirectUrl(value);
  return result.ok ? result.url : reject(ctx, REDIRECT_URL_MESSAGE);
});

const clientType = z.unknown().transform((value, ctx): ClientType => {
  return CLIENT_TYPES.includes(value as ClientType)
    ? (value as ClientType)
    : reject(ctx, "client type must be either public or confidential");
});

const scopes = z.unknown().transform((value, ctx): string[] => {
  if (!Array.isArray(value) || value[0] !== REQUIRED_SCOPE) {
    return reject(ctx, `scopes must be an array whose first entry is ${REQUIRED_SCOPE}`);
  }
  if (new Set(value).size !== value.length) return reject(ctx, "scopes must not contain duplicates");
  const unsupported = value.find(
    (scope) => scope !== REQUIRED_SCOPE && !(OPTIONAL_SCOPES as readonly unknown[]).includes(scope),
  );
  return unsupported === undefined
    ? (value as string[])
    : reject(ctx, `scope ${JSON.stringify(unsupported)} is not supported`);
});

const features = z.unknown().transform((value, ctx): Record<FeatureName, boolean> => {
  if (!isPlainObject(value)) return reject(ctx, "features must be an object");
  const unsupported = Object.keys(value).find((key) => !(FEATURE_NAMES as readonly string[]).includes(key));
  if (unsupported !== undefined) return reject(ctx, `feature ${JSON.stringify(unsupported)} is not supported`);
  const missing = FEATURE_NAMES.find((name) => typeof value[name] !== "boolean");
  return missing === undefined
    ? (value as Record<FeatureName, boolean>)
    : reject(ctx, `feature ${JSON.stringify(missing)} must be true or false`);
});

/**
 * Opt-in selections are validated against their catalog rather than passed through: an id
 * or option the generator cannot wire must fail here, not halfway through CI. Declared
 * options that are omitted fall back to their catalog default. The two groups are validated
 * separately, so an id may not cross over between them.
 */
function featureSelection(group: OptInGroup) {
  return z.unknown().transform((value, ctx): FeatureSelection => {
    if (value === undefined || value === null) return {};
    if (!isPlainObject(value)) return reject(ctx, `${group} must be an object`);
    const catalog: CatalogFeature[] = optInFeatures(group);
    const selection: FeatureSelection = {};
    for (const [id, rawOptions] of Object.entries(value)) {
      const feature = catalog.find((item) => item.id === id);
      if (!feature) return reject(ctx, `${group} feature ${JSON.stringify(id)} is not supported`);
      if (!isPlainObject(rawOptions)) {
        return reject(ctx, `${group} feature ${JSON.stringify(id)} options must be an object`);
      }
      const declared = feature.options ?? [];
      const options: Record<string, boolean> = {};
      for (const [optionId, optionValue] of Object.entries(rawOptions)) {
        const where = JSON.stringify(`${id}.${optionId}`);
        if (!declared.some((item) => item.id === optionId)) {
          return reject(ctx, `${group} option ${where} is not supported`);
        }
        if (typeof optionValue !== "boolean") {
          return reject(ctx, `${group} option ${where} must be true or false`);
        }
        options[optionId] = optionValue;
      }
      for (const option of declared) if (!(option.id in options)) options[option.id] = option.default === true;
      selection[id] = options;
    }
    return selection;
  });
}

const users = z.unknown().transform((value, ctx): PortalUser[] => {
  if (!Array.isArray(value) || value.length < MIN_USERS || value.length > MAX_USERS) {
    return reject(ctx, `users must contain between ${MIN_USERS} and ${MAX_USERS} accounts`);
  }
  const seen = new Set<string>();
  const parsed: PortalUser[] = [];
  for (const [index, item] of value.entries()) {
    const position = `user ${index + 1}`;
    if (!isPlainObject(item)) return reject(ctx, `${position} must be an object`);
    if (typeof item.username !== "string") return reject(ctx, `${position} must have a username`);
    const username = item.username.trim();
    if (!isValidUsername(username)) {
      return reject(
        ctx,
        `${position} username must be 1-64 characters of a-z, A-Z, 0-9, dot, underscore, at sign, or hyphen`,
      );
    }
    if (seen.has(username)) return reject(ctx, `username ${JSON.stringify(username)} is registered twice`);
    if (typeof item.password !== "string" || !isValidPassword(item.password)) {
      return reject(ctx, `${position} password must be between 8 and 128 characters`);
    }
    seen.add(username);
    parsed.push({ username, password: item.password });
  }
  return parsed;
});

const body = z
  .object({
    name: displayName,
    redirect_url: redirectUrl,
    client_type: clientType,
    scopes,
    features,
    optional: featureSelection("optional"),
    experimental: featureSelection("experimental"),
    users,
  })
  .superRefine((value, ctx) => {
    if (offlineAccessNeedsRefreshToken(value.scopes, value.features)) {
      ctx.addIssue({ code: "custom", message: "the offline_access scope requires the refresh-token feature" });
    }
  })
  .transform(
    (value): CreateAppInput => ({
      name: value.name,
      redirectUrl: value.redirect_url,
      clientType: value.client_type,
      scopes: value.scopes,
      features: value.features,
      optional: value.optional,
      experimental: value.experimental,
      users: value.users,
    }),
  );

/**
 * Spreading the body into a fixed key set before the object schema runs is what makes an
 * omitted field reach its own validator as `undefined` rather than being skipped, so
 * `{"name": "x"}` is rejected for its missing redirect URL instead of parsing to a
 * half-populated object.
 */
export const createAppRequestSchema = z
  .unknown()
  .transform((value, ctx) => {
    if (!isPlainObject(value)) return reject(ctx, "request body must be a JSON object");
    return {
      name: value.name,
      redirect_url: value.redirect_url,
      client_type: value.client_type,
      scopes: value.scopes,
      features: value.features,
      optional: value.optional,
      experimental: value.experimental,
      users: value.users,
    };
  })
  .pipe(body);

export type ParsedCreateApp = { ok: true; value: CreateAppInput } | { ok: false; message: string };

/** The first issue is the one worth reporting: every field stops at the rule it broke. */
export function parseCreateApp(value: unknown): ParsedCreateApp {
  const result = createAppRequestSchema.safeParse(value);
  if (result.success) return { ok: true, value: result.data };
  const message = result.error.issues[0]?.message ?? "request body is invalid";
  return { ok: false, message };
}

/** The JSON the browser sends, derived from the schema so the form cannot drift from it. */
export type CreateAppRequestBody = z.input<typeof body>;

export interface CreateAppResponse {
  request_id: string;
  client_id: string;
  client_secret?: string;
}

export interface QuotaResponse {
  limit: number;
  used: number;
  remaining: number;
}

export interface RequestStatusResponse {
  request_id: string;
  status: "pending" | "generating" | "deployed" | "failed";
  op_id: string;
  url: string | null;
  error: string | null;
  created_at: string;
}

export interface ApiErrorResponse {
  error: string;
  message: string;
}
