import { Router } from '../http/router';
import { registerAdminRoutes } from './admin';
import { registerPublicRoutes } from './public';
import { registerResourceRoutes } from './resources';

/**
 * Route table.
 *
 * Grouped by the authorization each route needs: public routes authenticate nothing, admin
 * routes require an administrator, resource routes scope every query to the caller.
 */
export function createRouter(): Router {
  const router = new Router();

  registerPublicRoutes(router);
  registerAdminRoutes(router);
  registerResourceRoutes(router);

  return router;
}
