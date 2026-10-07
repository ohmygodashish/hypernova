# Hypernova Web Driver

A small web app that configures a Cosmic Byte Hypernova gaming mouse straight from your browser, using WebHID. There is nothing to install: open the page, connect the mouse, and change its settings.

This is an unofficial community project. It is not affiliated with, endorsed by, or sponsored by Cosmic Byte.

## Use it

1. Close the official Cosmic Byte app first. It may overwrite changes you make here.
2. Open <https://hypernova.ohmygodashish.workers.dev/>.
3. Click **Connect** and choose the mouse in the browser prompt.

The page reconnects by itself when you reload it. After you unplug the mouse or its dongle, or restart the browser, click **Connect** again: the mouse has no USB serial number, so the browser cannot remember it.

The app only sends four commands: read settings, write a known setting, read battery, and read version. It verifies every write by reading the value back.

Use the app in one tab or window at a time: two tabs, or the installed app and a tab, can both connect to the mouse and interleave their commands.

## Browser support

Chromium desktop browsers: Chrome, Edge, Opera, Brave, and Arc. Firefox and Safari do not implement WebHID, so they cannot run this app.

## Linux

Linux needs a udev rule so your user can open the mouse's hidraw device. Save this as `/etc/udev/rules.d/70-hypernova.rules`:

```
# /etc/udev/rules.d/70-hypernova.rules
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="3554", ATTRS{idProduct}=="f5fa|f5fb", TAG+="uaccess"
```

Then reload the rules:

```
sudo udevadm control --reload-rules && sudo udevadm trigger
```

Unplug and replug the mouse (or its dongle) afterwards.

## What it can change

- Report rate: 125-4000 Hz, plus 8000 Hz over the cable only
- DPI stages 1-6: value 50-26000 in steps of 50, an indicator colour per stage, and the active stage
- Lift-off distance: 1 mm or 2 mm
- Sensor mode: LP or HP over the dongle (shown as Corded over the cable)
- Motion sync, angle snapping, and ripple control
- Peak performance and its time
- Debounce: 0-20 ms
- Mouse sleep time: 10 s to 40 min
- Backup and restore of all settings to a JSON file
- Battery level and firmware version display

Not supported: button remapping, macros, RGB lighting and DPI LED effects, firmware updates, and dongle pairing.

## Development

No framework and no bundler: the site is static files in `public/`.

```
npm install
npm test
npm run dev
npm run icons
```

- `npm test` runs the unit tests with Node's built-in test runner.
- `npm run dev` serves the site at `http://localhost:8787`.
- `npm run icons` regenerates the PWA icons in `public/icons/`.

## Deployment

The site is served as static assets by Cloudflare Workers and deployed automatically from this GitHub repo with Workers Builds. Use these settings:

- Production branch: `main`
- Build command: `npm test`
- Deploy command: `npx wrangler deploy`

To deploy by hand, run `npm run deploy`.

## Documentation

- [Architecture and requirements spec](docs/spec-architecture-hypernova-web-driver.md)
- [HID protocol reference](docs/spec-data-hypernova-hid-protocol.md)

## License

MIT. See [LICENSE](LICENSE).
