# Modern Volume Mixer

A GNOME Shell extension that brings **per-application volume control** directly into the Quick Settings panel — plus a floating, draggable full mixer window with vertical faders.

---

## Features

- **Per-app sliders** in the Quick Settings dropdown — adjust any app's volume without opening a dedicated tool
- **Floating Mixer window** — a Windows-style vertical fader board that can be dragged anywhere on screen
- **Mute / unmute** any stream by clicking its icon
- **Live updates** — sliders appear and disappear as apps start or stop playing audio
- **Optional volume percentage** label next to every slider
- **Optional app icons** next to stream names
- **Show recording / capture streams** alongside playback (configurable separately for panel and mixer window)
- **Per-tab audio control** for multi-stream apps like Chrome and Firefox
- Clean pill-style **Mixer** and **Settings** shortcut buttons at the bottom of the panel dropdown

---

## Screenshots

> _Coming soon_

---

## Requirements

| Requirement | Version |
|---|---|
| GNOME Shell | 50+ |
| GLib | 2.x (ships with GNOME) |

---

## Installation

### From GNOME Extensions website _(recommended)_

1. Visit the [extension page](https://extensions.gnome.org) _(link coming soon)_
2. Click **Install**

### From a release zip

1. Download the latest `.zip` from the [Releases](../../releases) page
2. Install with:

```bash
gnome-extensions install modern-volume-mixer@sickplanet.users.noreply.github.com.zip
```

3. Log out and back in (on X11 you can press **Alt + F2**, type `r`, press Enter)
4. Enable the extension:

```bash
gnome-extensions enable modern-volume-mixer@sickplanet.users.noreply.github.com
```

### From source

```bash
git clone https://github.com/sickplanet/Modern-Volume-Mixer.git
cd Modern-Volume-Mixer
glib-compile-schemas schemas/
cp -r . ~/.local/share/gnome-shell/extensions/modern-volume-mixer@sickplanet.users.noreply.github.com/
gnome-extensions enable modern-volume-mixer@sickplanet.users.noreply.github.com
```

---

## Settings

Open **Settings → Extensions → Modern Volume Mixer → Settings**, or click the **Settings** pill button inside the panel dropdown.

| Setting | Default | Description |
|---|---|---|
| Show per-tab controls | Off | Per-tab audio for multi-stream apps (Chrome, Firefox, …) |
| Show volume percentage | On | Displays `0–100 %` label next to each slider |
| Show application icon | Off | Shows the app icon beside stream names _(experimental)_ |
| Show all audio apps in Mixer window | Off | Includes capture/recording streams in the Mixer window |
| Show all audio apps in panel dropdown | Off | Includes capture/recording streams in the panel dropdown |

---

## Project structure

```
├── extension.js          # Main extension logic
├── prefs.js              # Preferences window
├── stylesheet.css        # All UI styling
├── metadata.json         # Extension manifest
└── schemas/
    └── org.gnome.shell.extensions.sickplanet.gschema.xml
```

---

## Contributing

1. Fork the repo
2. Work on the `dev` branch
3. Open a pull request into `main`

Merging into `main` automatically builds and publishes a release zip via GitHub Actions.

---

## License

[GPL-2.0](LICENSE)
