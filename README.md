# Homebridge Verano WiFi

Homebridge accessory plugin to control Verano VER-24 WiFi heaters via emodul.pl.

Features:
- Thermostat service (heat/off)
- Current and target temperature
- Periodic polling to keep HomeKit in sync
- Robust login with cookie reuse and auto-reauth

## Install

```sh
npm install -g homebridge-verano
```

## Configuration

Add an accessory block in your Homebridge config UI or JSON. Required fields: `username`, `password`.

Optional tuning parameters are shown with defaults.

```jsonc
{
  "accessories": [
    {
      "accessory": "VeranoAccessoryPlugin",
      "name": "Verano",
      "username": "you@example.com",
      "password": "••••••••",
      // optional
      "tileId": 58,
      "setpointIdo": 139,
      "temperatureDivider": 10,
      "offThresholdC": 10,
      "minC": 10,
      "maxC": 30,
      "stepC": 0.5,
      "pollIntervalSec": 30
    }
  ]
}
```

Notes:
- Only HEAT/OFF modes are supported.
- Temperatures are in Celsius.

## Development

```sh
npm ci
npm run build
```

Link locally into a dev Homebridge if desired:

```sh
npm link
```

## License

Apache-2.0
