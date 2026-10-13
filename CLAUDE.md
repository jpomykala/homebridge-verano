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

`.github/workflows/build-and-publish.yml` runs `npm ci && npm run lint && npm run build` on pushes to `main`, `v*` tags and PRs, and `npm publish` on **every push** (not on PRs) via npm Trusted Publishing (OIDC, `id-token: write`; no `NPM_TOKEN`). Publishing fails if `package.json` `version` was not bumped, so bump the version for any change meant to ship.

## Architecture

Everything lives in `src/index.ts` (single `VeranoAccessoryPlugin` class). Since 3.2.0 the code is deliberately back to the simple 2.1.4 logic (the last version confirmed working against emodul.pl); the 3.0–3.1 rewrite (optimistic state, debounced writes, background refresh) broke temperature changes and was dropped. Prefer small, verified changes on top of this base.

- **Config**: optional fields of `VeranoAccessoryConfig` are normalized with defaults (identical to the old hardcoded values) into `this.cfg`. When adding/changing an option, keep three places in sync: the interface + defaults in `src/index.ts`, `config.schema.json` (Homebridge UI), and the README example.
- **emodul.pl API** (plain `axios` 0.19 calls, same requests as 2.1.4):
  - `POST /login` with `rememberMe: true, languageId: 'en'` → the `set-cookie` entry containing `session` is sent as the `Cookie` header.
  - `GET /frontend/module_data` → `tiles[]`; the tile with `id === tileId` holds target temp in `params.widget1.value` and current temp in `params.widget2.value`, both scaled by `temperatureDivider`. A failed fetch resets `isAuthorized`, so the next request logs in again.
  - `POST /send_control_data` with `[{ ido: setpointIdo, params: targetC * temperatureDivider, module_index: 0 }]` sets the target.
- **HomeKit**: `onGet` handlers answer from the `thermostatState` cache (`readState()`; "No Response" only until the first successful fetch) and trigger a background refresh at most every `REFRESH_INTERVAL_MS` (10 s, one in flight via `refreshPromise`); refreshes push changes with `updateCharacteristic` and log only when the state changed. `onSet` awaits the write (`setTargetTemperature`), then holds the written setpoint for `HOLD_AFTER_WRITE_MS` (60 s) or until eModul echoes it, because eModul reports the old value for a few seconds. Write errors become `SERVICE_COMMUNICATION_FAILURE`. `heating = targetTemperature > offThresholdC`; OFF writes `offThresholdC` as the setpoint, HEAT (when currently off) writes current temperature + `HEAT_ON_OFFSET_C` (3 °C), rounded to `stepC`, clamped to `minC..maxC` and kept above `offThresholdC`; HEAT while already heating is a no-op. `requestThermostatState()` is a pure fetch.
