# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`homebridge-verano` — a Homebridge **accessory** plugin (alias `VeranoAccessoryPlugin`) exposing a Verano VER-24 WiFi heater as a HomeKit Thermostat. It talks to the cloud API at `https://emodul.pl` (no local device API). Only HEAT/OFF modes and Celsius are supported.

## Commands

```sh
npm ci              # install
npm run build       # rimraf dist && tsc  -> dist/index.js (package "main")
npm run lint        # eslint src/**.ts --max-warnings=0 (.eslintrc.json)
npm run watch       # build + npm link + nodemon, for running against a local Homebridge
```

There are no tests in this repo. `dist/` is gitignored; the npm tarball contents come from `files` in `package.json`.

## Release / CI

`.github/workflows/build-and-publish.yml` runs `npm ci && npm run lint && npm run build` on pushes to `main`, `v*` tags and PRs, and `npm publish` on **every push** (not on PRs). Publishing fails if `package.json` `version` was not bumped, so bump the version for any change meant to ship.

## Architecture

Everything lives in `src/index.ts` (single `VeranoAccessoryPlugin` class).

- **Config**: `VeranoAccessoryConfig` fields are normalized with defaults into `this.cfg` in the constructor. When adding/changing an option, keep three places in sync: the interface + defaults in `src/index.ts`, `config.schema.json` (Homebridge UI), and the README example.
- **emodul.pl API**:
  - `POST /login` → session cookie extracted from `set-cookie` and attached to every request via an axios request interceptor.
  - `GET /frontend/module_data` → `tiles[]`; the tile with `id === tileId` holds target temp in `params.widget1.value` and current temp in `params.widget2.value`, both scaled by `temperatureDivider`.
  - `POST /send_control_data` with `[{ ido: setpointIdo, params: round(targetC * temperatureDivider), module_index: 0 }]` sets the target.
  - axios uses `validateStatus` accepting `<500`, so HTTP errors never throw — status codes are checked manually. `executeWithReauth` logs in if needed and, on a 401/403 *response status*, re-logs in and retries once. Concurrent logins share `authPromise`.
- **Heating state is derived**, not read: `heating = targetTemperature > offThresholdC`. Turning OFF in HomeKit writes `offThresholdC` as the setpoint; turning HEAT on sets target to current + 2 °C (always above the threshold); re-sending the current mode is a no-op. `CurrentHeatingCoolingState` reports HEAT only while current < target (otherwise idle).
- **State sync / anti-flicker** (the subtle part — see recent commits "Fix temperature flickering"):
  - `thermostatState` is a local cache. `onGet` handlers go through `readState()`, which returns it immediately, triggers a background refresh (throttled to one per 30 s, guarded by `refreshInProgress`) and throws `SERVICE_COMMUNICATION_FAILURE` ("No Response") if no successful fetch happened in the last 3 poll intervals.
  - `onSet` handlers never await the network: `applyTargetLocally()` updates state + HomeKit optimistically and debounces the write (1 s, `pendingSetTimer`/`pendingTargetC`); `flushPendingWrite()` sends it, and a value arriving during an in-flight write is sent afterwards rather than dropped.
  - `lastRequestedTargetC` holds the optimistic target; `refreshStateSafe()` keeps the local target while a debounce is pending, a write is in flight, or the server hasn't echoed the value yet (gives up after 2 min or on a failed write). `requestThermostatState()` must stay a pure fetch, since this comparison relies on the old local state.
  - emodul.pl is a web frontend and changes take ~2–10 s (request timeout 20 s). A HomeKit change is "fire and forget": for up to `OPTIMISTIC_TARGET_TTL_MS` (5 min from the HomeKit set) the plugin retries failed writes (3/10/30/60 s…), re-reads the state after an accepted write until eModul echoes the setpoint, and resends it if it stays unapplied for `RESEND_AFTER_MS`. After the deadline `giveUp()`/`refreshStateSafe()` show the real eModul value (`lastServerTargetC` if the cloud is down). All of this runs on one `reconcileTimer`, cleared by every new HomeKit value; refreshes share one in-flight `refreshPromise`.
  - Data requests use `maxRedirects: 0`; a 3xx (redirect to the login page) or a 200 without `tiles[]` is treated as an expired session in `executeWithReauth`.
  - HEAT restores `lastHeatTargetC` (last setpoint above the threshold). A temperature written while an OFF is still debounced (scenes send both) is only remembered, not applied.
  - Logging is meant to explain the heater's state: initial state, write accepted/confirmed/not confirmed, setpoint changed outside HomeKit, one warning per outage plus an error when HomeKit switches to "No Response".
  - All target values sent to HomeKit go through `step()` (clamp to `minC..maxC`, round to `stepC`) to avoid HomeKit range warnings.
- **Lifecycle**: network work starts on `didFinishLaunching` (polling every `pollIntervalMin` minutes is started first, so the plugin recovers even if the initial refresh fails); polling stops on `shutdown`.
