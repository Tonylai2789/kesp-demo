export const RETURN_TO_PARAM = 'returnTo';

export function getReturnToFromSearch(search: string): string | null {
  const value = new URLSearchParams(search).get(RETURN_TO_PARAM);
  if (!value || !value.startsWith('/')) {
    return null;
  }
  return value;
}

export function appendReturnTo(path: string, returnTo: string | null): string {
  if (!returnTo) {
    return path;
  }

  const [pathname, existingSearch = ''] = path.split('?');
  const params = new URLSearchParams(existingSearch);
  params.set(RETURN_TO_PARAM, returnTo);
  const nextSearch = params.toString();

  return nextSearch ? `${pathname}?${nextSearch}` : pathname;
}
