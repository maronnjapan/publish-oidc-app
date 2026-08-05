import assert from "node:assert/strict";
import test from "node:test";
import { importModules } from "./support/build.mjs";

/**
 * The form's own logic, tested directly.
 *
 * The rules, the reducer and the creation sequence are plain modules, so what used to be
 * asserted by pulling an inline <script> out of an HTML string and evaluating it in a
 * sandbox is now an ordinary unit test.
 */

// One bundle, so the modules share the instances they would share in the browser.
const { api, csv, rules, state, submit, shared, validation } = await importModules({
  api: "system/portal/src/ui/api.ts",
  csv: "system/portal/src/shared/csv.ts",
  rules: "system/portal/src/shared/rules.ts",
  shared: "system/portal/src/shared/validation.ts",
  state: "system/portal/src/ui/form-state.ts",
  submit: "system/portal/src/ui/submit.ts",
  validation: "system/portal/src/ui/validation.ts",
});

function reduce(initial, ...actions) {
  return actions.reduce(state.formReducer, initial);
}

function filledState(overrides = {}) {
  const base = state.initialFormState();
  return {
    ...base,
    redirectUrl: "https://client.example/callback",
    users: [{ id: 1, username: "alice", password: "correct-horse-battery" }],
    ...overrides,
  };
}

test("CSV parsing supports quoted fields, doubled quotes and every line ending", () => {
  assert.deepEqual(csv.parseCsv('alice,"long,password"\r\nbob,password-123\n'), [
    ["alice", "long,password"],
    ["bob", "password-123"],
  ]);
  assert.deepEqual(csv.parseCsv('alice,"say ""hi"" now"'), [["alice", 'say "hi" now']]);
  assert.throws(() => csv.parseCsv('alice,"unterminated'), /引用符/);
});

test("a CSV is judged row by row, and only a clean file is usable", () => {
  const clean = csv.readCsv("username,password\nalice,password-123\nbob,password-456\n");
  assert.equal(clean.usable, true);
  assert.deepEqual(
    clean.entries.map((entry) => entry.username),
    ["alice", "bob"],
  );

  const dirty = csv.readCsv("same,short\nsame,password-123\n");
  assert.equal(dirty.usable, false);
  assert.match(dirty.entries[0].errors.join(" "), /8〜128/);
  assert.match(dirty.entries[1].errors.join(" "), /重複/);

  const tooMany = csv.readCsv(
    Array.from({ length: 6 }, (_, index) => `user${index},password-123`).join("\n"),
  );
  assert.equal(tooMany.countError, csv.COUNT_MESSAGE);
  assert.equal(tooMany.usable, false);

  // A leading byte-order mark is common in spreadsheet exports and must not become part of
  // the first username.
  assert.equal(csv.readCsv("﻿alice,password-123").entries[0].username, "alice");
});

test("the browser and the Worker apply the same redirect URL rule", () => {
  for (const url of ["https://example.com/callback", "http://localhost:3000/callback", "http://127.0.0.1:8080/cb"]) {
    assert.equal(validation.redirectUrlError(url), "");
    assert.equal(shared.parseCreateApp({ ...body(), redirect_url: url }).ok, true);
  }
  for (const url of [
    "http://example.com/callback",
    "https://example.com/callback#fragment",
    "https://user:pass@example.com/callback",
    "not-a-url",
  ]) {
    assert.notEqual(validation.redirectUrlError(url), "");
    assert.equal(shared.parseCreateApp({ ...body(), redirect_url: url }).ok, false);
  }
});

function body() {
  return {
    name: "Demo OP",
    redirect_url: "https://client.example/callback",
    client_type: "public",
    scopes: ["openid"],
    features: { pkce: true, "refresh-token": true, introspection: true, revocation: true, "request-object": true },
    users: [{ username: "alice", password: "correct-horse-battery" }],
  };
}

test("display names accept multibyte text and reject control characters or overlong values", () => {
  assert.equal(shared.parseCreateApp({ ...body(), name: "テスト用OP" }).value.name, "テスト用OP");
  assert.equal(shared.parseCreateApp({ ...body(), name: "  余白付き  " }).value.name, "余白付き");
  assert.equal(shared.parseCreateApp({ ...body(), name: "あ".repeat(40) }).ok, true);
  assert.equal(shared.parseCreateApp({ ...body(), name: "あ".repeat(41) }).ok, false);
  assert.equal(shared.parseCreateApp({ ...body(), name: "line\nbreak" }).ok, false);
  assert.equal(validation.nameError("あ".repeat(41)), validation.NAME_HINT);
});

test("a body missing a required field is rejected rather than half-parsed", () => {
  const { users, ...withoutUsers } = body();
  assert.match(shared.parseCreateApp(withoutUsers).message, /users must contain/);
  const { redirect_url, ...withoutRedirect } = body();
  assert.match(shared.parseCreateApp(withoutRedirect).message, /redirect URL/);
  assert.match(shared.parseCreateApp("not an object").message, /must be a JSON object/);
});

test("turning refresh tokens off takes offline_access with it", () => {
  const withScope = reduce(state.initialFormState(), { type: "toggle-scope", id: "offline_access", value: true });
  assert.equal(state.selectedScopes(withScope).includes("offline_access"), true);
  assert.equal(state.scopeDisabled(withScope, "offline_access"), false);

  const withoutRefresh = reduce(withScope, { type: "toggle-feature", id: "refresh-token", value: false });
  assert.equal(state.selectedScopes(withoutRefresh).includes("offline_access"), false);
  assert.equal(state.scopeDisabled(withoutRefresh, "offline_access"), true);

  // The combination the Worker rejects must therefore be unreachable from the form.
  assert.equal(
    rules.offlineAccessNeedsRefreshToken(state.selectedScopes(withoutRefresh), withoutRefresh.features),
    false,
  );
});

test("openid is always sent and is never a choice", () => {
  assert.equal(state.selectedScopes(state.initialFormState())[0], "openid");
  assert.equal("openid" in state.initialFormState().scopes, false);
});

test("accounts are capped at five and the last row cannot be removed", () => {
  let current = state.initialFormState();
  for (let index = 0; index < 10; index += 1) current = state.formReducer(current, { type: "add-user" });
  assert.equal(current.users.length, 5);

  const ids = current.users.map((user) => user.id);
  assert.equal(new Set(ids).size, 5, "row ids must stay unique so Preact keys are stable");

  for (const id of ids) current = state.formReducer(current, { type: "remove-user", id });
  assert.equal(current.users.length, 1);
});

test("a clean CSV replaces the account rows and clears the previous errors", () => {
  const shown = reduce(state.initialFormState(), { type: "show-errors" });
  const { entries } = csv.readCsv("alice,password-123\nbob,password-456");
  const applied = state.formReducer(shown, { type: "apply-csv", entries, feedback: { text: "ok", error: false } });
  assert.deepEqual(
    applied.users.map((user) => [user.username, user.password]),
    [
      ["alice", "password-123"],
      ["bob", "password-456"],
    ],
  );
  assert.equal(applied.showErrors, false);
  assert.equal(new Set(applied.users.map((user) => user.id)).size, 2);
});

test("opt-in options are only selectable through their feature", () => {
  const enabled = reduce(
    state.initialFormState(),
    { type: "toggle-opt-in", group: "experimental", id: "par", value: true },
    { type: "toggle-opt-in-option", group: "experimental", id: "par", option: "required", value: true },
  );
  assert.deepEqual(state.selectedOptIn(enabled, "experimental"), { par: { required: true } });

  // Turning the feature back off drops it from the request entirely, options and all.
  const disabled = state.formReducer(enabled, { type: "toggle-opt-in", group: "experimental", id: "par", value: false });
  assert.deepEqual(state.selectedOptIn(disabled, "experimental"), {});
});

test("the request body the form builds is one the Worker accepts", () => {
  const ready = reduce(
    filledState(),
    { type: "toggle-scope", id: "profile", value: true },
    { type: "toggle-opt-in", group: "optional", id: "transaction-binding", value: true },
  );
  const parsed = shared.parseCreateApp(state.toRequestBody(ready));
  assert.equal(parsed.ok, true, parsed.message);
  assert.deepEqual(parsed.value.scopes, ["openid", "profile"]);
  assert.deepEqual(parsed.value.optional, { "transaction-binding": {} });
});

test("field errors name the field, and a valid form reports none", () => {
  const errors = validation.formErrors(state.initialFormState());
  assert.equal(errors.valid, false);
  assert.equal(errors.redirectUrl, validation.redirectUrlError("nope"));
  assert.equal(errors.users[0].username, validation.USERNAME_HINT);
  assert.equal(errors.users[0].password, validation.PASSWORD_HINT);

  assert.equal(validation.formErrors(filledState()).valid, true);

  const duplicates = filledState({
    users: [
      { id: 1, username: "same", password: "password-123" },
      { id: 2, username: "same", password: "password-456" },
    ],
  });
  assert.equal(validation.formErrors(duplicates).users[1].username, validation.DUPLICATE_USERNAME_HINT);
});

/** A dispatcher that records every action and keeps the reduced state, like the component. */
function recorder(initial) {
  const actions = [];
  let current = initial;
  return {
    actions,
    dispatch(action) {
      actions.push(action);
      current = state.formReducer(current, action);
    },
    get state() {
      return current;
    },
    messages() {
      return actions
        .filter((action) => action.type === "set-submission")
        .map((action) => action.submission.message ?? action.submission.phase);
    },
  };
}

const QUOTA = { limit: 10, used: 0, remaining: 10 };

function fakeClock() {
  let now = 0;
  return { now: () => now, sleep: async (ms) => { now += ms; } };
}

test("an invalid form is not sent, and the fields are asked to show why", async () => {
  const target = recorder(state.initialFormState());
  let created = false;
  await submit.createOp({
    state: state.initialFormState(),
    api: { quota: async () => QUOTA, create: async () => { created = true; }, status: async () => {} },
    dispatch: target.dispatch,
    clock: fakeClock(),
  });
  assert.equal(created, false);
  assert.equal(target.actions[0].type, "show-errors");
  assert.equal(target.state.submission.phase, "error");
});

test("a creation polls until the OP is deployed and then shows the credentials once", async () => {
  const ready = reduce(filledState(), { type: "toggle-opt-in", group: "experimental", id: "par", value: true });
  const target = recorder(ready);
  const statuses = ["pending", "generating", "deployed"];
  await submit.createOp({
    state: ready,
    api: {
      quota: async () => QUOTA,
      create: async () => ({ request_id: "r1", client_id: "client_x", client_secret: "secret_y" }),
      status: async () => ({
        request_id: "r1",
        status: statuses.shift() ?? "deployed",
        op_id: "maronn-op-abc123defg",
        url: "https://maronn-op-abc123defg.example.workers.dev",
        error: null,
        created_at: "2026-07-23T00:00:00.000Z",
      }),
    },
    dispatch: target.dispatch,
    clock: fakeClock(),
  });

  const submission = target.state.submission;
  assert.equal(submission.phase, "done");
  assert.equal(submission.url, "https://maronn-op-abc123defg.example.workers.dev");
  assert.deepEqual(submission.credentials, { clientId: "client_x", clientSecret: "secret_y" });
  assert.deepEqual(submission.enabled.experimental, [
    { label: "PAR（Pushed Authorization Requests）", endpoints: "POST /par" },
  ]);
  assert.match(target.messages().join("\n"), /現在: generating/);
});

test("a failed status check is retried rather than reported as a failure", async () => {
  const target = recorder(filledState());
  let attempts = 0;
  await submit.createOp({
    state: filledState(),
    api: {
      quota: async () => QUOTA,
      create: async () => ({ request_id: "r1", client_id: "client_x" }),
      status: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("network");
        return { request_id: "r1", status: "deployed", op_id: "op", url: "https://op.example", error: null, created_at: "" };
      },
    },
    dispatch: target.dispatch,
    clock: fakeClock(),
  });
  assert.equal(attempts, 2);
  assert.match(target.messages().join("\n"), /再試行しています/);
  assert.equal(target.state.submission.phase, "done");
});

test("polling gives up after ten minutes instead of running forever", async () => {
  const target = recorder(filledState());
  let polls = 0;
  await submit.createOp({
    state: filledState(),
    api: {
      quota: async () => QUOTA,
      create: async () => ({ request_id: "r1", client_id: "client_x" }),
      status: async () => {
        polls += 1;
        return { request_id: "r1", status: "generating", op_id: "op", url: null, error: null, created_at: "" };
      },
    },
    dispatch: target.dispatch,
    clock: fakeClock(),
  });
  assert.equal(polls, submit.POLL_TIMEOUT_MS / submit.POLL_INTERVAL_MS + 1);
  assert.match(target.state.submission.message, /タイムアウト/);
});

test("a rate-limited creation says so and marks the quota as spent", async () => {
  const target = recorder(filledState());
  await submit.createOp({
    state: filledState(),
    api: {
      quota: async () => ({ limit: 10, used: 10, remaining: 0 }),
      create: async () => {
        throw new api.ApiError("daily OP creation limit reached", 429, "rate_limited");
      },
      status: async () => {},
    },
    dispatch: target.dispatch,
    clock: fakeClock(),
  });
  assert.match(target.state.submission.message, /本日の作成上限に達しました/);
  assert.equal(target.state.quota.remaining, 0);
});

test("a failed deployment reports the reason CI recorded", async () => {
  const target = recorder(filledState());
  await submit.createOp({
    state: filledState(),
    api: {
      quota: async () => QUOTA,
      create: async () => ({ request_id: "r1", client_id: "client_x" }),
      status: async () => ({ request_id: "r1", status: "failed", op_id: "op", url: null, error: "build_failed", created_at: "" }),
    },
    dispatch: target.dispatch,
    clock: fakeClock(),
  });
  assert.match(target.state.submission.message, /build_failed/);
});
