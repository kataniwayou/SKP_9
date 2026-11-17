import type { ApiError } from './client';

/** One line for any failed request, as the page and the Inspector show it. */
export function describeError(error: ApiError): string {
  switch (error.kind) {
    case 'notFound': return 'This workflow no longer exists.';
    case 'network': return `Network error: ${error.message}`;
    default: return error.status === 0 ? error.detail : `${error.status}: ${error.detail}`;
  }
}
