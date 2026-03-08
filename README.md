# homebridge-kohler-generator

Homebridge dynamic platform plugin for monitoring Kohler / Rehlko generators.

## Features

- Polls generator status using the Rehlko cloud API helper script.
- Exposes HomeKit accessories/services for:
  - Generator on/running state
  - Exercise run state
  - Outage run state
  - Utility power present
  - Fault status
  - Battery level
  - Utility voltage (Eve Voltage characteristic)
- Includes retry/backoff handling for transient poll timeouts.

## Requirements

- Node.js 20+
- Homebridge 1.8+ (or 2.x beta)
- A valid Kohler/Rehlko account
- Python helper script and venv on host:
  - `/var/lib/homebridge/rehlko_status.py`
  - `/var/lib/homebridge/venv-kohler/bin/python`

## Install

From npm (when published):

```bash
sudo npm install -g homebridge-kohler-generator
```

From local tarball:

```bash
sudo npm install -g /path/to/homebridge-kohler-generator-<version>.tgz
```

## Homebridge Config

```json
{
  "platform": "KohlerGenerator",
  "name": "Kohler Generator",
  "email": "you@example.com",
  "password": "your-password",
  "pollSeconds": 30,
  "debug": false
}
```

## Development

```bash
npm install
npm run lint
npm run build
```

Package a tarball:

```bash
npm pack
```

## Verification Checklist (Homebridge Verified)

Before submission:

- Publish package publicly on npm.
- Ensure this GitHub repository is public.
- Enable GitHub Issues.
- Create GitHub releases with notes.
- Confirm config schema is implemented (`config.schema.json`).
- Confirm plugin handles errors gracefully without crashing Homebridge.

Submit verification request at:

- https://github.com/homebridge/plugins
- Requirements: https://github.com/homebridge/verified#requirements

## License

Apache-2.0
