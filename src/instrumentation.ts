import type { Instrumentation } from "next";

// The platform may attach request metadata to its own invocation logs. This
// application signal deliberately excludes request, error, and user values.
export const onRequestError: Instrumentation.onRequestError = (_error, _request, context) => {
  const area = ["render", "route", "action", "proxy"].includes(context.routeType)
    ? context.routeType : "unknown";
  console.error(`vaultx_unhandled_request_error area=${area}`);
};
