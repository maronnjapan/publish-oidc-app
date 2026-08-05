import {
  MAX_USERS,
  MIN_USERS,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  isValidPassword,
  isValidUsername,
} from "./rules";

/**
 * Reading a `username,password` CSV into the account rows of the form.
 *
 * This is its own module because the browser is not the only caller that matters: the parser
 * is what decides whether a file the person picked is usable, so it is unit-tested directly
 * instead of being extracted out of an inline script and evaluated in a sandbox.
 */

export const UNTERMINATED_QUOTE_MESSAGE = "引用符が閉じられていません";
export const COUNT_MESSAGE = `ユーザーは${MIN_USERS}〜${MAX_USERS}件にしてください`;

export interface CsvEntry {
  username: string;
  password: string;
  errors: string[];
}

/**
 * RFC 4180 enough for this form: quoted fields, doubled quotes inside them, CR / LF / CRLF
 * line endings, and a trailing newline that does not become an empty row.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted && character === '"' && text[index + 1] === '"') {
      cell += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell);
      if (row.length > 1 || cell.length > 0) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }
  if (quoted) throw new Error(UNTERMINATED_QUOTE_MESSAGE);
  row.push(cell);
  if (row.length > 1 || cell.length > 0) rows.push(row);
  return rows;
}

/** Drops the optional `username,password` header row. */
export function stripHeader(rows: string[][]): string[][] {
  const first = rows[0];
  if (first && first[0]?.trim().toLowerCase() === "username" && first[1]?.trim().toLowerCase() === "password") {
    return rows.slice(1);
  }
  return rows;
}

/**
 * Every row is judged, not just the first bad one: the preview table shows a verdict per row
 * so a person fixing a file can see all of it at once.
 */
export function validateCsvRows(rows: string[][]): CsvEntry[] {
  const seen = new Set<string>();
  return rows.map((row) => {
    const errors: string[] = [];
    const username = (row[0] || "").trim();
    const password = row[1] || "";
    if (row.length !== 2) errors.push("列数は2列にしてください");
    if (!isValidUsername(username)) errors.push("ユーザー名の形式が不正です");
    if (seen.has(username)) errors.push("ユーザー名が重複しています");
    if (username) seen.add(username);
    if (!isValidPassword(password)) {
      errors.push(`パスワードは${PASSWORD_MIN_LENGTH}〜${PASSWORD_MAX_LENGTH}文字にしてください`);
    }
    return { username, password, errors };
  });
}

export interface CsvReadResult {
  entries: CsvEntry[];
  /** Set when the file has the wrong number of rows; it applies to the file, not to a row. */
  countError: string;
  usable: boolean;
}

/** Parse, drop the header, judge every row, and decide whether the file may be applied. */
export function readCsv(text: string): CsvReadResult {
  const rows = stripHeader(parseCsv(text.replace(/^\uFEFF/, "")));
  const entries = validateCsvRows(rows);
  const countError = entries.length < MIN_USERS || entries.length > MAX_USERS ? COUNT_MESSAGE : "";
  return { entries, countError, usable: !countError && entries.every((entry) => entry.errors.length === 0) };
}
