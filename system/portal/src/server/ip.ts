/**
 * The key a creation is counted against.
 *
 * IPv4 addresses count individually. IPv6 counts by /64 because a single subscriber is
 * routinely handed a whole /64, so counting individual addresses would make the per-IP limit
 * meaningless there. Anything unparseable collapses into one shared bucket rather than being
 * waved through.
 */

function expandIpv6(input: string): number[] | null {
  let address = input.toLowerCase().split("%", 1)[0];
  const ipv4 = address.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (ipv4) {
    const parts = ipv4[1].split(".").map(Number);
    if (parts.some((part) => part < 0 || part > 255)) return null;
    address = `${address.slice(0, -ipv4[1].length)}${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
  }
  if (!/^[0-9a-f:]+$/.test(address) || address.includes(":::")) return null;
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  return [...left, ...Array(missing).fill("0"), ...right].map((part) => Number.parseInt(part, 16));
}

function compressIpv6(parts: number[]): string {
  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < parts.length; ) {
    if (parts[index] !== 0) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < parts.length && parts[end] === 0) end += 1;
    if (end - index > bestLength && end - index >= 2) {
      bestStart = index;
      bestLength = end - index;
    }
    index = end;
  }
  if (bestStart < 0) return parts.map((part) => part.toString(16)).join(":");
  const left = parts.slice(0, bestStart).map((part) => part.toString(16)).join(":");
  const right = parts.slice(bestStart + bestLength).map((part) => part.toString(16)).join(":");
  return `${left}::${right}`;
}

export function ipKey(value: string | null): string {
  if (!value) return "unknown";
  const trimmed = value.trim();
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(trimmed)) {
    const parts = trimmed.split(".").map(Number);
    return parts.every((part) => part >= 0 && part <= 255) ? trimmed : "invalid";
  }
  const expanded = expandIpv6(trimmed);
  return expanded ? `${compressIpv6([...expanded.slice(0, 4), 0, 0, 0, 0])}/64` : "invalid";
}
