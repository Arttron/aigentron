/** A `?key=value` filter that is only honoured when the value is one of the known ones (so a stale/typed URL cannot break the list). */
export function readFilterParam<T extends string>(search: string, key: string, isValid: (v: string | null) => v is T): T | null {
  const v = new URLSearchParams(search).get(key);
  return isValid(v) ? v : null;
}

/** The same URL with `key` set to `value`, or removed when the value is empty (other params and the hash are kept). */
export function withFilterParam(href: string, key: string, value: string): URL {
  const url = new URL(href);
  if (value) url.searchParams.set(key, value);
  else url.searchParams.delete(key);
  return url;
}
