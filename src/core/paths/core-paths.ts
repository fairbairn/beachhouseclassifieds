export const CORE_ROUTE_PATHS = {
  home: "/",
  login: "/login",
} as const;

export type CoreRoutePathKey = keyof typeof CORE_ROUTE_PATHS;
