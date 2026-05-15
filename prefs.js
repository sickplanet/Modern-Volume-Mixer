import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class ModernVolumeMixerPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings('org.gnome.shell.extensions.sickplanet');

        // ═══════════════════════════════════════════════════════════════════
        //  SETTINGS PAGE
        // ═══════════════════════════════════════════════════════════════════
        const settingsPage = new Adw.PreferencesPage({
            title: 'Settings',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(settingsPage);

        // ── Display ──────────────────────────────────────────────────────
        const displayGroup = new Adw.PreferencesGroup({
            title: 'Display',
            description: 'Customize what is visible in the quick-settings volume mixer',
        });
        settingsPage.add(displayGroup);

        const addSwitch = (key, title, subtitle) => {
            const row = new Adw.SwitchRow({ title, subtitle });
            displayGroup.add(row);
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        };

        addSwitch('show-per-tab',
            'Show "per tab" controls',
            'Enables per-tab audio control for applications like Chrome or Firefox');
        addSwitch('show-volume-percent',
            'Show volume percentage',
            'Displays the volume level as a percentage to the right of each slider');
        addSwitch('show-app-icon',
            'Show application icon  (experimental)',
            'Tries to display the app icon next to stream names — may not work for all apps');
        addSwitch('show-all-audio-apps-mixer',
            'Show all audio apps in Mixer window',
            'Include recording and capture streams in the floating Volume Mixer window, not just playback');
        addSwitch('show-all-audio-apps-panel',
            'Show all audio apps in panel dropdown',
            'Include recording and capture streams in the quick-settings dropdown, not just playback');

        // ═══════════════════════════════════════════════════════════════════
        //  ABOUT PAGE
        // ═══════════════════════════════════════════════════════════════════
        const aboutPage = new Adw.PreferencesPage({
            title: 'About',
            icon_name: 'help-about-symbolic',
        });
        window.add(aboutPage);

        // ── Banner ───────────────────────────────────────────────────────
        const bannerGroup = new Adw.PreferencesGroup();
        aboutPage.add(bannerGroup);

        const banner = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            halign: Gtk.Align.CENTER,
            margin_top: 32,
            margin_bottom: 24,
        });

        banner.append(new Gtk.Image({
            icon_name: 'audio-volume-high-symbolic',
            pixel_size: 64,
        }));

        const nameLabel = new Gtk.Label({
            label: this.metadata.name ?? 'Modern Volume Mixer',
        });
        nameLabel.add_css_class('title-1');
        banner.append(nameLabel);

        const versionLabel = new Gtk.Label({
            label: `Version ${this.metadata['version-name'] ?? this.metadata.version ?? '—'}`,
        });
        versionLabel.add_css_class('dim-label');
        banner.append(versionLabel);

        if (this.metadata.description) {
            const descLabel = new Gtk.Label({
                label: this.metadata.description,
                wrap: true,
                halign: Gtk.Align.CENTER,
                justify: Gtk.Justification.CENTER,
                margin_top: 4,
            });
            descLabel.add_css_class('dim-label');
            banner.append(descLabel);
        }

        bannerGroup.add(banner);

        // ── Links ────────────────────────────────────────────────────────
        const linksGroup = new Adw.PreferencesGroup({ title: 'Links' });
        aboutPage.add(linksGroup);

        // Helper: builds an activatable row that opens a URL in the default browser.
        // If url is null the row is shown but disabled with a greyed icon.
        const makeURLRow = (title, subtitle, url) => {
            const row = new Adw.ActionRow({ title, subtitle, activatable: !!url });
            row.add_suffix(new Gtk.Image({
                icon_name: url ? 'adw-external-link-symbolic' : 'action-unavailable-symbolic',
                valign: Gtk.Align.CENTER,
            }));
            if (url) {
                row.connect('activated', () => {
                    Gio.AppInfo.launch_default_for_uri_async(url, null, null, null);
                });
            }
            return row;
        };

        const REPO_URL = 'https://github.com/sickplanet/Modern-Volume-Mixer';
        linksGroup.add(makeURLRow('Source Code', REPO_URL, REPO_URL));
        linksGroup.add(makeURLRow('Report a Bug', `${REPO_URL}/issues`, `${REPO_URL}/issues`));

        // ── Legal ─────────────────────────────────────────────────────────
        const legalGroup = new Adw.PreferencesGroup({ title: 'Legal' });
        aboutPage.add(legalGroup);

        legalGroup.add(makeURLRow(
            'License',
            'GNU General Public License, Version 3',
            'https://github.com/sickplanet/Modern-Volume-Mixer/blob/main/LICENSE'
        ));

        const uuidRow = new Adw.ActionRow({
            title: 'Extension ID',
            subtitle: this.metadata.uuid ?? '',
        });
        legalGroup.add(uuidRow);
    }
}
