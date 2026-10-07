import * as Sentry from '@sentry/node';

// Sentry error tracking for the API and the worker. Imported first by server.ts and worker.ts.
// Does nothing until SENTRY_DSN is set. Sends the error and where it happened, but no request
// bodies, headers, cookies, query strings, database values or local variables: customer phone
// numbers and addresses stay out of Sentry.
const dsn = process.env.SENTRY_DSN || undefined;
Sentry.init({
  dsn,
  enabled: !!dsn,
  environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
  tracesSampleRate: 0,
  dataCollection: {
    userInfo: false,
    cookies: false,
    httpHeaders: false,
    httpBodies: [],
    urlQueryParams: false,
    databaseQueryData: false,
    stackFrameVariables: false,
  },
});
