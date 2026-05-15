import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class ModernVolumeMixerPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings('org.gnome.shell.extensions.lucianradu');

        // ═══════════════════════════════════════════════════════════════════
        //  SETTINGS PAGE
        // ═══════════════════════════════════════════════════════════════════
        const settingsPage = new Adw.PreferencesPage({
            title: 'Settings',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(settingsPage);

        // ── System Requirements ──────────────────────────────────────────
        const depGroup = new Adw.PreferencesGroup({
            title: 'System Requirements',
            description: 'External packages required for the volume mixer to function',
        });
        settingsPage.add(depGroup);

        const isPavuInstalled = !!GLib.find_program_in_path('pavucontrol');
        const pavuRow = new Adw.ActionRow({
            title: 'pavucontrol',
            subtitle: isPavuInstalled
                ? 'Installed and ready'
                : 'Not found — the extension will not start until this is installed.',
        });
        depGroup.add(pavuRow);

        if (isPavuInstalled) {
            const ok = new Gtk.Image({
                icon_name: 'emblem-ok-symbolic',
                valign: Gtk.Align.CENTER,
            });
            ok.add_css_class('success');
            pavuRow.add_suffix(ok);
        } else {
            let cmd = 'pavucontrol', pm = 'Install';
            if      (GLib.find_program_in_path('apt'))    { cmd = 'sudo apt install pavucontrol';    pm = 'APT';    }
            else if (GLib.find_program_in_path('dnf'))    { cmd = 'sudo dnf install pavucontrol';    pm = 'DNF';    }
            else if (GLib.find_program_in_path('pacman')) { cmd = 'sudo pacman -S pavucontrol';       pm = 'Pacman'; }
            else if (GLib.find_program_in_path('zypper')) { cmd = 'sudo zypper install pavucontrol'; pm = 'Zypper'; }

            const btn = new Gtk.Button({
                label: `Copy ${pm} Command`,
                valign: Gtk.Align.CENTER,
            });
            btn.add_css_class('suggested-action');
            btn.connect('clicked', () => {
                window.get_display().get_clipboard().set_text(cmd);
                window.add_toast(new Adw.Toast({ title: 'Command copied to clipboard!' }));
            });
            pavuRow.add_suffix(btn);
        }

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
            label: `Version ${this.metadata.version ?? '—'}`,
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

        // To enable these links add a "url" key to metadata.json, e.g.:
        //   "url": "https://github.com/yourname/gnome-app-volume-mixer"
        const repoUrl = this.metadata.url ?? null;
        linksGroup.add(makeURLRow(
            'Source Code',
            repoUrl ?? 'Add a "url" key to metadata.json to enable this link',
            repoUrl
        ));
        linksGroup.add(makeURLRow(
            'Report a Bug',
            repoUrl ? `${repoUrl}/issues` : 'Add a "url" key to metadata.json to enable this link',
            repoUrl ? `${repoUrl}/issues` : null
        ));

        // ── Legal ─────────────────────────────────────────────────────────
        const legalGroup = new Adw.PreferencesGroup({ title: 'Legal' });
        aboutPage.add(legalGroup);

        legalGroup.add(makeURLRow(
            'License',
            'GNU General Public License, version 2 or later',
            'https://www.gnu.org/licenses/gpl-2.0.html'
        ));

        const uuidRow = new Adw.ActionRow({
            title: 'Extension ID',
            subtitle: this.metadata.uuid ?? '',
        });
        legalGroup.add(uuidRow);
    }
}
