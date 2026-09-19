import type { RequestContext } from './context';

export type RouteHandler = (ctx: RequestContext) => Promise<Response> | Response;

export interface Route {
  method: string;
  pattern: string;
  handler: RouteHandler;
}

export interface RouteMatch {
  handler: RouteHandler;
  params: Record<string, string>;
}

/**
 * A very small path router.
 *
 * Patterns are literal segments plus `:name` captures. Matching is exact on segment count,
 * so `/api/decks` never matches `/api/decks/abc/cards`.
 */
export class Router {
  private readonly routes: Route[] = [];

  add(method: string, pattern: string, handler: RouteHandler): this {
    this.routes.push({ method: method.toUpperCase(), pattern, handler });
    return this;
  }

  get(pattern: string, handler: RouteHandler): this {
    return this.add('GET', pattern, handler);
  }

  post(pattern: string, handler: RouteHandler): this {
    return this.add('POST', pattern, handler);
  }

  patch(pattern: string, handler: RouteHandler): this {
    return this.add('PATCH', pattern, handler);
  }

  put(pattern: string, handler: RouteHandler): this {
    return this.add('PUT', pattern, handler);
  }

  delete(pattern: string, handler: RouteHandler): this {
    return this.add('DELETE', pattern, handler);
  }

  match(method: string, pathname: string): RouteMatch | null {
    const requested = splitPath(pathname);
    const upperMethod = method.toUpperCase();

    for (const route of this.routes) {
      if (route.method !== upperMethod) continue;

      const segments = splitPath(route.pattern);
      if (segments.length !== requested.length) continue;

      const params: Record<string, string> = {};
      let matched = true;

      for (let index = 0; index < segments.length; index++) {
        const segment = segments[index];
        if (segment.startsWith(':')) {
          params[segment.slice(1)] = decodeURIComponent(requested[index]);
          continue;
        }
        if (segment !== requested[index]) {
          matched = false;
          break;
        }
      }

      if (matched) return { handler: route.handler, params };
    }

    return null;
  }

  /** Used to answer 405 correctly instead of pretending the path does not exist. */
  allowedMethods(pathname: string): string[] {
    const requested = splitPath(pathname);
    const methods = new Set<string>();

    for (const route of this.routes) {
      const segments = splitPath(route.pattern);
      if (segments.length !== requested.length) continue;
      if (segments.some((segment, index) => !segment.startsWith(':') && segment !== requested[index])) {
        continue;
      }
      methods.add(route.method);
    }

    return [...methods].sort();
  }
}

function splitPath(pathname: string): string[] {
  return pathname.split('/').filter(segment => segment.length > 0);
}
