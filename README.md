# Homebridge Verano WiFi

Homebridge accessory plugin to control Verano VER-24 WiFi heaters via emodul.pl.

Features:
- Thermostat service (heat/off)
- Current and target temperature
- Automatic re-login when the session expires

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
      "heatOnOffsetC": 3 // 0–5, HEAT sets room temperature + this offset
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
