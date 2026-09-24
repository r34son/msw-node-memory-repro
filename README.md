# Standalone MSW memory reproduction

Only Node built-ins, `msw@2.15.0`, and `@mswjs/interceptors@0.41.9`. No framework, custom request handlers, body storage, patches, module-loading hooks, or application code. Installed from the public npm registry. Tested on macOS arm64, Node v22.18.0.

```sh
npm ci
npm test        # reproduces retained frames after failed fetch: expected exit 1
npm run control # identical requests without interception: expected exit 0
node --expose-gc repro.mjs interceptors fetch-reset # lower-level control: exit 0
```

`setupServer()` has no handlers and uses `onUnhandledRequest: 'bypass'`. A local server consumes each incoming request and destroys the socket instead of returning a response. Requests are awaited sequentially. The harness keeps no references to requests, responses or caught errors.

Each process warms up with 500 requests, runs three batches of 500, and forces GC after each batch. It also waits two additional seconds before the final snapshot. Heap snapshots are only counted locally and are not written or uploaded.

## Failed fetch result

1500 measured requests after warmup, heap growth after GC (decimal MB):

| Mode | Run 1 | Run 2 |
|---|---:|---:|
| Node, no interception | +0.43 | +0.43 |
| BatchInterceptor only | +0.55 | +0.55 |
| MSW | +11.25 | +11.25 |

A follow-up snapshot run with the exact frame constructor name found:

| Object | After warmup | After 1500 more requests | After server.close() |
|---|---:|---:|---:|
| InterceptorHttpNetworkFrame | 500 | 2000 | 0 |
| HTTPParser | 2 | 2 | 2 |
| MockHttpSocket | 0 | 0 | 0 |

The same run retained +11.23 MB heap. External memory and ArrayBuffers were stable. This isolates frame retention from the HTTPParser issue. Counts drop after closing MSW; a long-lived server does not normally close interception between requests.

## Separate HTTPParser scenarios

```sh
node --expose-gc repro.mjs none http-abort
node --expose-gc repro.mjs interceptors http-abort
node --expose-gc repro.mjs msw http-abort
node --expose-gc repro.mjs none http-ok
node --expose-gc repro.mjs interceptors http-ok
node --expose-gc repro.mjs msw http-ok
```

`http-abort`: destroy each ClientRequest on `socket`, before `end()`. `http-ok`: consume each successful response, `agent:false`.

| Scenario/mode | Heap growth MB | HTTPParser before → after | MockHttpSocket before → after |
|---|---:|---|---|
| abort / none | +0.12 | 4 → 4 | 0 → 0 |
| abort / interceptors | +12.53 | 1002 → 4002 | 500 → 2000 |
| abort / MSW | +12.52 | 1002 → 4002 | 500 → 2000 |
| success / none | +0.42 | 3 → 3 | 0 → 0 |
| success / interceptors | +1.52 | 1003 → 4003 | 0 → 0 |
| success / MSW | +1.60 | 1003 → 4003 | 0 → 0 |

Repeated runs produced the same object counts and similar heap growth. The assertions check both heap growth and parser growth: a small heap delta alone is not a passing result.

Related: https://github.com/mswjs/interceptors/issues/779 and https://github.com/mswjs/msw/issues/2735. These are bounded reproductions, not a claim that every application memory issue has the same cause.
