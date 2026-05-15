import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { QuickMenuToggle, SystemIndicator } from 'resource:///org/gnome/shell/ui/quickSettings.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import { Slider } from 'resource:///org/gnome/shell/ui/slider.js';
import { getMixerControl } from 'resource:///org/gnome/shell/ui/status/volume.js';

// ─────────────────────────────────────────────────────────────────────────────
//  resolveStreamIconName — Best-practice icon resolution pipeline
//
//  1. Use PulseAudio's own icon-name property (app set this when opening stream)
//  2. Get the application_id → locate its .desktop file via XDG dirs
//     (Gio.DesktopAppInfo handles the full XDG_DATA_DIRS search internally)
//  3. Extract Icon= from the .desktop entry and resolve through the icon theme
//  4. Fall back to the generic audio symbolic icon
// ─────────────────────────────────────────────────────────────────────────────
function resolveStreamIconName(stream) {
    // Step 1 — PulseAudio / PipeWire may already carry a correct icon name
    try {
        const direct = stream.get_icon_name?.();
        if (direct) return direct;
    } catch (_e) {}

    // Step 2-4 — app_id → .desktop entry → Icon= → theme icon name
    try {
        const appId = stream.get_application_id?.();
        if (appId) {
            const desktopId = appId.endsWith('.desktop') ? appId : `${appId}.desktop`;
            const info = Gio.DesktopAppInfo.new(desktopId);
            if (info) {
                const icon = info.get_icon();
                if (icon) return icon.to_string();
            }
        }
    } catch (_e) {}

    return 'audio-x-generic-symbolic';
}

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

        // Resolve icon name via the best-practice pipeline
        const iconName = resolveStreamIconName(stream);

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
            } catch (_e) {
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
            } catch (_e) {
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

// ─────────────────────────────────────────────────────────────────────────────
//  MixerColumn — one vertical channel strip per audio stream
//  Layout (top → bottom):  vertical slider  |  app icon (mute button)  |  name
// ─────────────────────────────────────────────────────────────────────────────
const MixerColumn = GObject.registerClass(
class MixerColumn extends St.BoxLayout {
    constructor(stream, mixerControl, useDescriptionLabel = false) {
        super({
            vertical: true,
            style_class: 'mixer-column',
            x_align: Clutter.ActorAlign.CENTER,
        });

        this._stream = stream;
        this._mixerControl = mixerControl;
        this._isUpdating = false;
        this._destroyed = false;
        this._volumeChangedId = 0;
        this._muteChangedId = 0;

        // ── Vertical slider ──────────────────────────────────────────────────
        // The built-in Slider is horizontal; rotating it 90° clockwise gives us
        // a vertical fader where dragging UP increases volume (Win 7 style).
        const TRACK_H = 150; // visual height of the fader track
        const TRACK_W = 32;  // visual thickness of the track
        const COL_W   = 64;  // total column width

        const sliderArea = new St.Widget({
            width: COL_W,
            height: TRACK_H,
            clip_to_allocation: true,
            style_class: 'mixer-slider-area',
        });

        this._slider = new Slider(this._getVolume());
        // Pre-rotation the Slider is TRACK_H wide × TRACK_W tall.
        this._slider.width  = TRACK_H;
        this._slider.height = TRACK_W;
        // Place so its centre aligns with the centre of sliderArea, then rotate.
        this._slider.x = COL_W / 2 - TRACK_H / 2;   // 32 − 75 = −43
        this._slider.y = TRACK_H / 2 - TRACK_W / 2;  // 75 − 16 =  59
        this._slider.set_pivot_point(0.5, 0.5);
        this._slider.rotation_angle_z = -90; // CCW → top = max (100 %), bottom = min (0 %)

        sliderArea.add_child(this._slider);
        this.add_child(sliderArea);

        // ── App icon — tap to mute/unmute ────────────────────────────────────
        this._appIconName = resolveStreamIconName(stream);

        const isMutedNow = !!stream.is_muted;
        this._iconWidget = new St.Icon({
            icon_name: isMutedNow ? 'audio-volume-muted-symbolic' : this._appIconName,
            fallback_icon_name: 'audio-x-generic-symbolic',
            icon_size: 24,
            style_class: 'mixer-app-icon',
            reactive: true,
            track_hover: true,
            x_align: Clutter.ActorAlign.CENTER,
        });

        if (isMutedNow)
            this._iconWidget.add_style_class('mixer-muted');

        this._iconWidget.connect('button-press-event', () => {
            if (!this._destroyed && this._stream)
                this._stream.change_is_muted(!this._stream.is_muted);
            return Clutter.EVENT_STOP;
        });
        this.add_child(this._iconWidget);

        // ── App name ─────────────────────────────────────────────────────────
        let name = 'Unknown';
        try {
            if (useDescriptionLabel)
                name = stream.get_description?.() || stream.get_name?.() || 'Unknown';
            else
                name = stream.get_name?.() || stream.get_description?.() || 'Unknown';
        } catch (_e) {}

        this.add_child(new St.Label({
            text: name,
            style_class: 'mixer-app-name',
            x_align: Clutter.ActorAlign.CENTER,
        }));

        // ── Stream description (song / tab / role) ───────────────────────────
        try {
            const desc = stream.get_description?.() ?? '';
            if (desc && desc !== name) {
                this.add_child(new St.Label({
                    text: desc,
                    style_class: 'mixer-stream-desc',
                    x_align: Clutter.ActorAlign.CENTER,
                }));
            }
        } catch (_e) {}

        // ── Signal connections ────────────────────────────────────────────────
        this._slider.connect('notify::value', () => this._onSliderChanged());
        this._volumeChangedId = this._stream.connect('notify::volume',   () => this._onStreamVolumeChanged());
        this._muteChangedId   = this._stream.connect('notify::is-muted', () => this._onMuteChanged());
    }

    _getVolume() {
        try {
            if (!this._stream || !this._mixerControl) return 0;
            const maxNorm = this._mixerControl.get_vol_max_norm();
            return maxNorm > 0 ? this._stream.volume / maxNorm : 0;
        } catch (_e) { return 0; }
    }

    _onSliderChanged() {
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
            this._stream.push_volume();
        } catch (_e) {
        } finally {
            this._isUpdating = false;
        }
    }

    _onStreamVolumeChanged() {
        if (this._destroyed || this._isUpdating || !this._slider || !this._mixerControl) return;
        if (this._slider.dragging ?? false) return;
        this._isUpdating = true;
        try {
            const newVal = this._getVolume();
            if (Math.abs(this._slider.value - newVal) > 0.01)
                this._slider.value = newVal;
        } catch (_e) {} finally {
            this._isUpdating = false;
        }
    }

    _onMuteChanged() {
        if (this._destroyed || !this._iconWidget || !this._stream) return;
        try {
            if (this._stream.is_muted) {
                this._iconWidget.icon_name = 'audio-volume-muted-symbolic';
                this._iconWidget.add_style_class('mixer-muted');
            } else {
                this._iconWidget.icon_name = this._appIconName ?? 'audio-x-generic-symbolic';
                this._iconWidget.remove_style_class('mixer-muted');
            }
        } catch (_e) {}
    }

    destroy() {
        this._destroyed = true;
        if (this._volumeChangedId && this._stream) {
            try { this._stream.disconnect(this._volumeChangedId); } catch (_e) {}
            this._volumeChangedId = 0;
        }
        if (this._muteChangedId && this._stream) {
            try { this._stream.disconnect(this._muteChangedId); } catch (_e) {}
            this._muteChangedId = 0;
        }
        this._stream = null;
        this._mixerControl = null;
        this._slider = null;
        this._iconWidget = null;
        super.destroy();
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  AppGroup — all MixerColumns from the same app, with a shared header label
// ─────────────────────────────────────────────────────────────────────────────
const AppGroup = GObject.registerClass(
class AppGroup extends St.BoxLayout {
    constructor(appName, streams, mixerControl) {
        super({ vertical: true, style_class: 'mixer-app-group' });
        this._columns = [];

        // Header only when the app has more than one active stream
        if (streams.length > 1) {
            this.add_child(new St.Label({
                text: appName,
                style_class: 'mixer-group-header',
                x_align: Clutter.ActorAlign.CENTER,
            }));
        }

        const row = new St.BoxLayout({ vertical: false, style_class: 'mixer-group-columns' });
        for (const stream of streams) {
            try {
                const col = new MixerColumn(stream, mixerControl, streams.length > 1);
                this._columns.push(col);
                row.add_child(col);
            } catch (_e) {}
        }
        this.add_child(row);
    }

    destroy() {
        this._columns.forEach(c => { try { c.destroy(); } catch (_e) {} });
        this._columns = [];
        super.destroy();
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  VolumeMixerWindow — floating draggable window, not modal
//  Added to Main.uiGroup; shown/hidden with open() / close()
// ─────────────────────────────────────────────────────────────────────────────
const VolumeMixerWindow = GObject.registerClass(
class VolumeMixerWindow extends St.BoxLayout {
    constructor(mixerControl, settings) {
        super({
            vertical: true,
            visible: false,
            reactive: true,
            style_class: 'volume-mixer-window',
        });

        this._mixerControl     = mixerControl;
        this._settings         = settings;
        this._groups           = [];
        this._streamAddedId    = 0;
        this._streamRemovedId  = 0;
        this._rebuildTimeout   = 0;
        this._positioned       = false;
        this._dragActive       = false;
        this._dragStartX       = 0;
        this._dragStartY       = 0;
        this._stageDragId      = 0;
        this._settingsChangeId = 0;

        // ── Title bar / drag handle ───────────────────────────────────────────
        const titleBar = new St.BoxLayout({
            vertical: false,
            style_class: 'volume-mixer-titlebar',
            reactive: true,
            track_hover: true,
        });
        titleBar.add_child(new St.Icon({
            icon_name: 'audio-volume-high-symbolic',
            icon_size: 16,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'volume-mixer-title-icon',
        }));
        titleBar.add_child(new St.Label({
            text: 'Volume Mixer',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            style_class: 'volume-mixer-title',
        }));
        const closeBtn = new St.Button({ style_class: 'volume-mixer-close-btn', y_align: Clutter.ActorAlign.CENTER });
        closeBtn.set_child(new St.Icon({ icon_name: 'window-close-symbolic', icon_size: 16 }));
        // Stop the press from bubbling to the titleBar drag handler, then close on release.
        closeBtn.connect('button-press-event', () => Clutter.EVENT_STOP);
        closeBtn.connect('button-release-event', (_actor, event) => {
            if (event.get_button() === 1) this.close();
            return Clutter.EVENT_STOP;
        });
        titleBar.add_child(closeBtn);
        this.add_child(titleBar);

        // Drag: capture all pointer events on the stage while dragging so fast
        // mouse movements cannot escape the title-bar actor bounds.
        titleBar.connect('button-press-event', (_actor, event) => {
            if (event.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
            const [ex, ey] = event.get_coords();
            this._dragActive = true;
            this._dragStartX = ex - this.x;
            this._dragStartY = ey - this.y;
            if (this._stageDragId)
                try { global.stage.disconnect(this._stageDragId); } catch (_e) {}
            this._stageDragId = global.stage.connect('captured-event', (_stage, evt) => {
                const t = evt.type();
                if (t === Clutter.EventType.MOTION) {
                    if (this._dragActive) {
                        const [mx, my] = evt.get_coords();
                        this.set_position(Math.round(mx - this._dragStartX),
                                          Math.round(my - this._dragStartY));
                    }
                    return Clutter.EVENT_STOP;
                }
                if (t === Clutter.EventType.BUTTON_RELEASE) {
                    this._dragActive = false;
                    if (this._stageDragId) {
                        try { global.stage.disconnect(this._stageDragId); } catch (_e) {}
                        this._stageDragId = 0;
                    }
                }
                return Clutter.EVENT_PROPAGATE;
            });
            return Clutter.EVENT_STOP;
        });

        // ── Separator ─────────────────────────────────────────────────────────
        this.add_child(new St.Widget({ style_class: 'volume-mixer-sep', height: 1 }));

        // ── Scrollable channel area ────────────────────────────────────────────
        this._scrollView = new St.ScrollView({
            style_class: 'volume-mixer-scroll',
            x_expand: true,
            overlay_scrollbars: true,
            hscrollbar_policy: St.PolicyType.AUTOMATIC,
            vscrollbar_policy: St.PolicyType.NEVER,
        });
        this._streamsBox = new St.BoxLayout({ vertical: false, style_class: 'volume-mixer-streams' });
        this._scrollView.set_child(this._streamsBox);
        this.add_child(this._scrollView);

        // ── Live updates ──────────────────────────────────────────────────────
        if (this._mixerControl) {
            this._streamAddedId   = this._mixerControl.connect('stream-added',
                () => { if (this.visible) this._scheduleRebuild(); });
            this._streamRemovedId = this._mixerControl.connect('stream-removed',
                () => { if (this.visible) this._scheduleRebuild(); });
        }
        if (this._settings) {
            this._settingsChangeId = this._settings.connect(
                'changed::show-all-audio-apps-mixer',
                () => { if (this.visible) this._scheduleRebuild(); });
        }

        try { Main.uiGroup.add_child(this); } catch (e) {
            console.error(`[AppVolume] Failed to add mixer window to uiGroup: ${e}`);
        }
    }

    open() {
        if (this.visible) {
            try { Main.uiGroup.set_child_above_sibling(this, null); } catch (_e) {}
            return;
        }
        this.visible = true;
        try { Main.uiGroup.set_child_above_sibling(this, null); } catch (_e) {}
        this._rebuild();
        if (!this._positioned) {
            this._positioned = true;
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                try {
                    const mon = Main.layoutManager.primaryMonitor;
                    if (mon && this.width > 0)
                        this.set_position(
                            Math.round(mon.x + (mon.width  - this.width)  / 2),
                            Math.round(mon.y + (mon.height - this.height) / 2));
                } catch (_e) {}
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    close() { this.visible = false; }

    _scheduleRebuild() {
        if (this._rebuildTimeout) GLib.source_remove(this._rebuildTimeout);
        this._rebuildTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            this._rebuildTimeout = 0;
            this._rebuild();
            return GLib.SOURCE_REMOVE;
        });
    }

    _rebuild() {
        this._groups.forEach(g => { try { g.destroy(); } catch (_e) {} });
        this._groups = [];
        try { this._streamsBox.remove_all_children(); } catch (_e) { return; }
        if (!this._mixerControl) return;

        const showAll = this._settings?.get_boolean('show-all-audio-apps-mixer') ?? false;
        let streams = [];
        try {
            streams.push(...(this._mixerControl.get_sink_inputs() ?? []));
            if (showAll)
                streams.push(...(this._mixerControl.get_source_outputs?.() ?? []));
        } catch (_e) { return; }

        if (streams.length === 0) {
            try {
                this._streamsBox.add_child(new St.Label({
                    text: 'No active audio streams',
                    style_class: 'volume-mixer-empty',
                    x_align: Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.CENTER,
                }));
            } catch (_e) {}
            return;
        }

        // Group by app name
        const groups = new Map();
        for (const stream of streams) {
            let n = 'Unknown';
            try { n = stream.get_name?.() || 'Unknown'; } catch (_e) {}
            if (!groups.has(n)) groups.set(n, []);
            groups.get(n).push(stream);
        }

        let first = true;
        for (const [appName, appStreams] of groups) {
            try {
                if (!first)
                    this._streamsBox.add_child(
                        new St.Widget({ style_class: 'mixer-group-divider', width: 1 }));
                const grp = new AppGroup(appName, appStreams, this._mixerControl);
                this._groups.push(grp);
                this._streamsBox.add_child(grp);
                first = false;
            } catch (_e) {}
        }
    }

    destroy() {
        if (this._rebuildTimeout) { GLib.source_remove(this._rebuildTimeout); this._rebuildTimeout = 0; }
        if (this._stageDragId) {
            try { global.stage.disconnect(this._stageDragId); } catch (_e) {}
            this._stageDragId = 0;
        }
        if (this._settingsChangeId && this._settings) {
            try { this._settings.disconnect(this._settingsChangeId); } catch (_e) {}
            this._settingsChangeId = 0;
        }
        if (this._mixerControl) {
            if (this._streamAddedId)   { try { this._mixerControl.disconnect(this._streamAddedId);   } catch (_e) {} this._streamAddedId   = 0; }
            if (this._streamRemovedId) { try { this._mixerControl.disconnect(this._streamRemovedId); } catch (_e) {} this._streamRemovedId = 0; }
        }
        this._groups.forEach(g => { try { g.destroy(); } catch (_e) {} });
        this._groups  = [];
        this._streamsBox = null;
        this._scrollView = null;
        try { if (Main.uiGroup.contains(this)) Main.uiGroup.remove_child(this); } catch (_e) {}
        super.destroy();
    }
});

const AppVolumeMenuToggle = GObject.registerClass(
class AppVolumeMenuToggle extends QuickMenuToggle {
    constructor(settings, openPrefs = null) {
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

        this._openPrefs = openPrefs;
        this._rebuildDebounce = 0;
        this._mixerDialog = null;
        this._menuOpenId = 0;
        // Tracks every AppStreamSlider currently shown so we can orphan streams
        // immediately on removal and check drag state before rebuilding.
        this._activeSliders = new Set();

        this._menuOpenId = this.menu.connect('open-state-changed', (_menu, isOpen) => {
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

        this._settingsPanelId = 0;
        if (this._settings) {
            this._settingsPanelId = this._settings.connect(
                'changed::show-all-audio-apps-panel',
                () => { if (this.menu.isOpen) this._scheduleUpdateStreams(); });
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

        const showAll = this._settings?.get_boolean('show-all-audio-apps-panel') ?? false;
        let streams = [];
        try {
            streams.push(...(this._mixerControl.get_sink_inputs() ?? []));
            if (showAll)
                streams.push(...(this._mixerControl.get_source_outputs?.() ?? []));
        } catch (e) {
            console.error(`[AppVolume] get streams failed: ${e}`);
            return;
        }

        // Discard stale references; menu.removeAll() will destroy the actors.
        this._activeSliders.clear();
        this.menu.removeAll();

        if (streams.length === 0) {
            this.menu.addMenuItem(
                new PopupMenu.PopupMenuItem('No active audio streams', { reactive: false }));
        } else {
            const groups = new Map();
            for (const stream of streams) {
                let appName = 'Unknown App';
                try { appName = stream.get_name() || 'Unknown App'; } catch (_e) {}
                if (!groups.has(appName)) groups.set(appName, []);
                groups.get(appName).push(stream);
            }

            let isFirst = true;
            for (const [appName, appStreams] of groups) {
                if (!isFirst)
                    this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                if (appStreams.length === 1) {
                    const sliderItem = new AppStreamSlider(
                        appStreams[0], this._mixerControl, this._settings, false);
                    this._activeSliders.add(sliderItem);
                    this.menu.addMenuItem(sliderItem);
                } else {
                    const submenu = new PopupMenu.PopupSubMenuMenuItem(appName);
                    for (const stream of appStreams) {
                        const sliderItem = new AppStreamSlider(
                            stream, this._mixerControl, this._settings, true);
                        this._activeSliders.add(sliderItem);
                        submenu.menu.addMenuItem(sliderItem);
                    }
                    this.menu.addMenuItem(submenu);
                }
                isFirst = false;
            }
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // ── Pill-style action buttons in a single row ─────────────────────────
        const btnRow = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        const btnBox = new St.BoxLayout({ vertical: false, x_expand: true, style_class: 'mixer-pill-box' });

        const mkPill = (iconName, label, action) => {
            const btn = new St.Button({
                style_class: 'mixer-pill-btn',
                x_expand: true,
                reactive: true,
                can_focus: true,
                track_hover: true,
            });
            const inner = new St.BoxLayout({ vertical: false, style_class: 'mixer-pill-inner' });
            inner.add_child(new St.Icon({ icon_name: iconName, icon_size: 14, y_align: Clutter.ActorAlign.CENTER }));
            inner.add_child(new St.Label({ text: label, y_align: Clutter.ActorAlign.CENTER }));
            btn.set_child(inner);
            btn.connect('clicked', () => { try { action(); } catch (_e) {} });
            return btn;
        };

        btnBox.add_child(mkPill('audio-volume-high-symbolic', 'Mixer', () => {
            this._openMixerDialog();
            Main.panel.closeQuickSettings();
        }));
        if (this._openPrefs) {
            btnBox.add_child(mkPill('preferences-system-symbolic', 'Settings', () => {
                this._openPrefs();
                Main.panel.closeQuickSettings();
            }));
        }
        btnRow.add_child(btnBox);
        this.menu.addMenuItem(btnRow);
    }
    
    _openMixerDialog() {
        if (!this._mixerDialog) {
            try {
                this._mixerDialog = new VolumeMixerWindow(this._mixerControl, this._settings);
            } catch (e) {
                console.error(`[AppVolume] Failed to create mixer window: ${e}`);
                return;
            }
        }
        try { this._mixerDialog.open(); } catch (e) {
            console.error(`[AppVolume] Failed to open mixer window: ${e}`);
        }
    }

    destroy() {
        if (this._rebuildDebounce) {
            GLib.source_remove(this._rebuildDebounce);
            this._rebuildDebounce = 0;
        }
        if (this._menuOpenId) {
            try { this.menu.disconnect(this._menuOpenId); } catch (_e) {}
            this._menuOpenId = 0;
        }
        if (this._settingsPanelId && this._settings) {
            try { this._settings.disconnect(this._settingsPanelId); } catch (_e) {}
            this._settingsPanelId = 0;
        }
        if (this._mixerDialog) {
            try { this._mixerDialog.destroy(); } catch (_e) {}
            this._mixerDialog = null;
        }
        //Just to satisfy shexli
        for (const slider of this._activeSliders) {
            try { slider.destroy(); } catch (_e) {}
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
    constructor(settings, openPrefs = null) {
        super();
        this._indicator = this._addIndicator();
        this._indicator.iconName = 'audio-volume-high-symbolic';
        this._indicator.visible = false;

        const toggle = new AppVolumeMenuToggle(settings, openPrefs);
        this.quickSettingsItems.push(toggle);
    }
});

export default class QuickSettingsExampleExtension extends Extension {
    enable() {
        this._indicator = new AppVolumeIndicator(
            this.getSettings('org.gnome.shell.extensions.sickplanet'),
            () => { try { this.openPreferences(); } catch (_e) {} });
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
