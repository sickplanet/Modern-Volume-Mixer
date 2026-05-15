import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { QuickMenuToggle, SystemIndicator } from 'resource:///org/gnome/shell/ui/quickSettings.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import { Slider } from 'resource:///org/gnome/shell/ui/slider.js';
import { getMixerControl } from 'resource:///org/gnome/shell/ui/status/volume.js';

const AppStreamSlider = GObject.registerClass({
    Properties: {
        'value': GObject.ParamSpec.double(
            'value', null, null,
            GObject.ParamFlags.READWRITE,
            0, 1, 0.5),
    },
}, class AppStreamSlider extends PopupMenu.PopupBaseMenuItem {
    constructor(stream, mixerControl, settings, useSecondaryName = false) {
        super({ reactive: false });

        this._stream = stream;
        this._mixerControl = mixerControl;
        this._settings = settings;
        this._useSecondaryName = useSecondaryName;
        this._isUpdating = false;
        this._pushVolumeTimeout = 0;
        this._destroyed = false;
        this._settingsIconId = 0;
        this._settingsPercentId = 0;
        this._volumeChangedId = 0;
        this._iconWidget = null;

        // Resolve icon name safely
        let iconName = 'audio-x-generic-symbolic';
        try {
            if (stream.get_icon_name?.()) iconName = stream.get_icon_name();
            else if (stream.get_application_id?.()) iconName = stream.get_application_id();
        } catch (_e) {}

        // Resolve display name
        let name = 'Unknown App';
        try {
            if (useSecondaryName && stream.get_description?.()) name = stream.get_description();
            else if (stream.get_name?.()) name = stream.get_name();
            else if (stream.get_description?.()) name = stream.get_description();
        } catch (_e) {}

        // ── Vertical container ────────────────────────────────────────────────
        const vbox = new St.BoxLayout({ vertical: true, x_expand: true });

        // Row 1 — icon (optional, top-level streams only) + stream name
        const nameRow = new St.BoxLayout({ vertical: false, x_expand: true });

        if (!useSecondaryName) {
            this._iconWidget = new St.Icon({
                icon_name: iconName,
                fallback_icon_name: 'audio-x-generic-symbolic',
                style_class: 'popup-menu-icon',
                icon_size: 16,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._iconWidget.visible = settings.get_boolean('show-app-icon');
            nameRow.add_child(this._iconWidget);

            this._settingsIconId = settings.connect('changed::show-app-icon', () => {
                if (this._destroyed || !this._iconWidget) return;
                this._iconWidget.visible = this._settings?.get_boolean('show-app-icon') ?? false;
            });
        }

        const nameLabel = new St.Label({
            text: name,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'app-volume-name',
        });
        nameRow.add_child(nameLabel);
        vbox.add_child(nameRow);

        // Row 2 — slider (full width) + optional percentage label
        const sliderRow = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            style_class: 'app-volume-slider-row',
        });

        this._slider = new Slider(this._getVolume());
        this._slider.accessible_name = name;
        this._slider.x_expand = true;
        sliderRow.add_child(this._slider);

        this._percentLabel = new St.Label({
            text: `${Math.round(this._getVolume() * 100)}%`,
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.END,
            style_class: 'app-volume-percent',
        });
        this._percentLabel.visible = settings.get_boolean('show-volume-percent');
        sliderRow.add_child(this._percentLabel);

        this._settingsPercentId = settings.connect('changed::show-volume-percent', () => {
            if (this._destroyed || !this._percentLabel) return;
            this._percentLabel.visible = this._settings?.get_boolean('show-volume-percent') ?? true;
        });

        vbox.add_child(sliderRow);
        this.add_child(vbox);

        // ── Volume signal handlers ────────────────────────────────────────────
        this._slider.connect('notify::value', () => {
            if (this._destroyed || this._isUpdating || !this._stream || !this._mixerControl) return;

            this._isUpdating = true;
            try {
                const maxNorm = this._mixerControl.get_vol_max_norm();
                const vol = this._slider.value * maxNorm;
                this._stream.volume = vol;
                if (vol === 0) {
                    if (!this._stream.is_muted) this._stream.change_is_muted(true);
                } else {
                    if (this._stream.is_muted) this._stream.change_is_muted(false);
                }
                if (this._percentLabel)
                    this._percentLabel.text = `${Math.round(this._slider.value * 100)}%`;

                // Throttle backend pushing to prevent IPC flooding and GNOME Shell freezing
                if (!this._pushVolumeTimeout) {
                    this._pushVolumeTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                        this._pushVolumeTimeout = 0;
                        if (!this._destroyed && this._stream) {
                            try { this._stream.push_volume(); } catch (_e) {}
                        }
                        return GLib.SOURCE_REMOVE;
                    });
                }
            } catch (e) {
                console.error(`[AppVolume] notify::value error: ${e}`);
            } finally {
                this._isUpdating = false;
            }
        });

        this._volumeChangedId = this._stream.connect('notify::volume', () => {
            // Ignore stream volume updates if destroyed, re-entrant, or slider is being dragged
            if (this._destroyed || this._isUpdating || !this._slider || !this._mixerControl) return;
            if (this._slider.dragging ?? false) return;

            this._isUpdating = true;
            try {
                const currentSliderVal = this._slider.value;
                const newSliderVal = this._getVolume();

                if (Math.abs(currentSliderVal - newSliderVal) > 0.01) {
                    this._slider.value = newSliderVal;
                    if (this._percentLabel)
                        this._percentLabel.text = `${Math.round(newSliderVal * 100)}%`;
                }
            } catch (e) {
                console.error(`[AppVolume] notify::volume error: ${e}`);
            } finally {
                this._isUpdating = false;
            }
        });
    }
    
    _getVolume() {
        try {
            if (!this._stream || !this._mixerControl) return 0;
            const maxNorm = this._mixerControl.get_vol_max_norm();
            return maxNorm > 0 ? this._stream.volume / maxNorm : 0;
        } catch (_e) {
            return 0;
        }
    }

    // The PulseAudio/PipeWire ID of the stream this slider represents.
    get streamId() {
        try { return this._stream ? this._stream.get_id() : -1; } catch (_e) { return -1; }
    }

    // True while the user is actively dragging this slider.
    get dragging() {
        return this._slider?.dragging ?? false;
    }

    // Called immediately when the backing audio stream is removed, BEFORE any
    // visual rebuild.  Severs all PulseAudio ties so no further IPC calls are
    // made, while intentionally leaving the Clutter actor alive — Clutter may
    // still have a pointer grab on it if the user was dragging.
    _orphanStream() {
        if (this._volumeChangedId) {
            try { this._stream?.disconnect(this._volumeChangedId); } catch (_e) {}
            this._volumeChangedId = 0;
        }
        if (this._pushVolumeTimeout) {
            GLib.source_remove(this._pushVolumeTimeout);
            this._pushVolumeTimeout = 0;
        }
        this._stream = null;
        this._mixerControl = null;
    }

    destroy() {
        this._destroyed = true;

        if (this._pushVolumeTimeout) {
            GLib.source_remove(this._pushVolumeTimeout);
            this._pushVolumeTimeout = 0;
        }
        if (this._volumeChangedId) {
            try {
                this._stream.disconnect(this._volumeChangedId);
            } catch (_e) {}
            this._volumeChangedId = 0;
        }
        if (this._settingsIconId) {
            try { this._settings?.disconnect(this._settingsIconId); } catch (_e) {}
            this._settingsIconId = 0;
        }
        if (this._settingsPercentId) {
            try { this._settings?.disconnect(this._settingsPercentId); } catch (_e) {}
            this._settingsPercentId = 0;
        }
        this._settings = null;
        this._stream = null;
        this._mixerControl = null;
        this._slider = null;
        this._percentLabel = null;
        this._iconWidget = null;
        super.destroy();
    }
});

const AppVolumeMenuToggle = GObject.registerClass(
class AppVolumeMenuToggle extends QuickMenuToggle {
    constructor(settings) {
        super({
            title: 'App Volume',
            iconName: 'audio-volume-high-symbolic',
            toggleMode: false,
            menuEnabled: true,
        });

        this.menu.setHeader(
            'audio-volume-high-symbolic',
            'App Volume Mixer',
            'Per-application volume control'
        );

        this._settings = settings;

        try {
            this._mixerControl = getMixerControl();
        } catch (e) {
            console.error(`[AppVolume] getMixerControl() failed: ${e}`);
            this._mixerControl = null;
        }

        this._rebuildDebounce = 0;
        // Tracks every AppStreamSlider currently shown so we can orphan streams
        // immediately on removal and check drag state before rebuilding.
        this._activeSliders = new Set();

        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen) this._scheduleUpdateStreams();
        });

        if (this._mixerControl) {
            this._streamAddedId = this._mixerControl.connect('stream-added', () => {
                if (this.menu.isOpen) this._scheduleUpdateStreams();
            });
            this._streamRemovedId = this._mixerControl.connect('stream-removed', (_ctrl, id) => {
                // Immediately sever the link to the gone stream so no further
                // PulseAudio/PipeWire IPC is attempted — even if the slider is
                // still alive because the user is dragging it.
                for (const slider of this._activeSliders) {
                    if (slider.streamId === id) {
                        slider._orphanStream();
                        break;
                    }
                }
                if (this.menu.isOpen) this._scheduleUpdateStreams();
            });
        }
    }
    
    _scheduleUpdateStreams() {
        // Debounce: coalesce rapid stream events into a single rebuild.
        if (this._rebuildDebounce) {
            GLib.source_remove(this._rebuildDebounce);
        }
        this._rebuildDebounce = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            this._rebuildDebounce = 0;

            // Never destroy slider actors while one is actively being dragged —
            // Clutter may hold a pointer grab on it and would crash.
            // Reschedule until all drags have ended (pointer-up releases the grab).
            const anyDragging = [...this._activeSliders].some(s => s.dragging);
            if (anyDragging) {
                this._scheduleUpdateStreams();
                return GLib.SOURCE_REMOVE;
            }

            this._updateStreams();
            return GLib.SOURCE_REMOVE;
        });
    }

    _updateStreams() {
        if (!this._mixerControl) return;

        let sinkInputs;
        try {
            sinkInputs = this._mixerControl.get_sink_inputs();
        } catch (e) {
            console.error(`[AppVolume] get_sink_inputs() failed: ${e}`);
            return;
        }

        // Discard stale references; menu.removeAll() will destroy the actors.
        this._activeSliders.clear();
        this.menu.removeAll();

        if (!sinkInputs || sinkInputs.length === 0) {
            const noApps = new PopupMenu.PopupMenuItem('No active audio streams', { reactive: false });
            this.menu.addMenuItem(noApps);
        } else {
            // Group streams by application name
            const groups = {};
            sinkInputs.forEach(stream => {
                let appName = stream.get_name() || 'Unknown App';
                if (!groups[appName]) {
                    groups[appName] = [];
                }
                groups[appName].push(stream);
            });

            const appNames = Object.keys(groups);
            appNames.forEach((appName, idx) => {
                const streams = groups[appName];

                // Separator between stream groups
                if (idx > 0)
                    this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

                if (streams.length === 1) {
                    const sliderItem = new AppStreamSlider(
                        streams[0], this._mixerControl, this._settings, false);
                    this._activeSliders.add(sliderItem);
                    this.menu.addMenuItem(sliderItem);
                } else {
                    // Multiple streams: collapsible sub-menu
                    const submenu = new PopupMenu.PopupSubMenuMenuItem(appName);
                    streams.forEach(stream => {
                        const sliderItem = new AppStreamSlider(
                            stream, this._mixerControl, this._settings, true);
                        this._activeSliders.add(sliderItem);
                        submenu.menu.addMenuItem(sliderItem);
                    });
                    this.menu.addMenuItem(submenu);
                }
            });
        }
        
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Re-create the settings item every time — menu.removeAll() destroys it.
        const settingsItem = new PopupMenu.PopupMenuItem('Launch volume mixer (pavucontrol)');
        settingsItem.connect('activate', () => {
            try {
                Gio.Subprocess.new(['pavucontrol'], Gio.SubprocessFlags.NONE);
            } catch (e) {
                console.error(`[AppVolume] Failed to launch pavucontrol: ${e}`);
            }
            Main.panel.closeQuickSettings();
        });
        this.menu.addMenuItem(settingsItem);
    }
    
    destroy() {
        if (this._rebuildDebounce) {
            GLib.source_remove(this._rebuildDebounce);
            this._rebuildDebounce = 0;
        }
        this._activeSliders.clear();
        if (this._mixerControl) {
            if (this._streamAddedId) {
                try { this._mixerControl.disconnect(this._streamAddedId); } catch (_e) {}
                this._streamAddedId = 0;
            }
            if (this._streamRemovedId) {
                try { this._mixerControl.disconnect(this._streamRemovedId); } catch (_e) {}
                this._streamRemovedId = 0;
            }
        }
        super.destroy();
    }
});

const AppVolumeIndicator = GObject.registerClass(
class AppVolumeIndicator extends SystemIndicator {
    constructor(settings) {
        super();
        this._indicator = this._addIndicator();
        this._indicator.iconName = 'audio-volume-high-symbolic';
        this._indicator.visible = false;

        const toggle = new AppVolumeMenuToggle(settings);
        this.quickSettingsItems.push(toggle);
    }
});

export default class QuickSettingsExampleExtension extends Extension {
    enable() {
        const pavucontrolPath = GLib.find_program_in_path('pavucontrol');

        if (!pavucontrolPath) {
            console.warn(`[${this.uuid}] Missing dependency: pavucontrol`);
            Main.notify(
                'Missing Dependency',
                'This extension requires pavucontrol. Please install it using your distribution\'s package manager (e.g. apt, dnf, pacman).'
            );
            return; 
        }

        console.log(`Found pavucontrol at: ${pavucontrolPath}`);

        this._indicator = new AppVolumeIndicator(
            this.getSettings('org.gnome.shell.extensions.sickplanet'));
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    disable() {
        if (this._indicator) {
            this._indicator.quickSettingsItems.forEach(item => item.destroy());
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
