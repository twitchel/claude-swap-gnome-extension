import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from
    'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class ClaudeSwapPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage();
        window.add(page);

        const panelGroup = new Adw.PreferencesGroup({title: 'Panel'});
        page.add(panelGroup);

        const panelTextRow = new Adw.ComboRow({
            title: 'Percentages beside the icon',
            model: Gtk.StringList.new([
                'None', 'Tightest window', '5-hour', '7-day', 'Both',
            ]),
        });
        const panelTextValues = ['none', 'tightest', '5h', '7d', 'both'];
        panelTextRow.selected =
            panelTextValues.indexOf(settings.get_string('panel-text'));
        panelTextRow.connect('notify::selected', row =>
            settings.set_string('panel-text', panelTextValues[row.selected]));
        panelGroup.add(panelTextRow);

        const nameRow = new Adw.SwitchRow({title: 'Show account name'});
        settings.bind('show-account-name', nameRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        panelGroup.add(nameRow);

        const colourRow = new Adw.SwitchRow({
            title: 'Colour the icon by usage',
            subtitle: 'Amber above 80%, red above 95%',
        });
        settings.bind('colour-code-icon', colourRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        panelGroup.add(colourRow);

        const behaviourGroup = new Adw.PreferencesGroup({title: 'Behaviour'});
        page.add(behaviourGroup);

        const intervalRow = new Adw.SpinRow({
            title: 'Refresh interval',
            subtitle: 'Seconds between usage reads',
            adjustment: new Gtk.Adjustment({
                lower: 30, upper: 600, step_increment: 30, page_increment: 60,
            }),
        });
        settings.bind('refresh-interval', intervalRow, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        behaviourGroup.add(intervalRow);

        const notifyRow = new Adw.SwitchRow({
            title: 'Notify on auto-switch',
            subtitle: 'Manual switches are never announced',
        });
        settings.bind('notify-on-switch', notifyRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        behaviourGroup.add(notifyRow);

        const advancedGroup = new Adw.PreferencesGroup({
            title: 'Advanced',
            description:
                'GNOME Shell does not search ~/.local/bin, so the cswap ' +
                'binary is resolved by absolute path. Leave this empty to ' +
                'auto-detect.',
        });
        page.add(advancedGroup);

        const pathRow = new Adw.EntryRow({title: 'Path to cswap'});
        settings.bind('cswap-path', pathRow, 'text',
            Gio.SettingsBindFlags.DEFAULT);
        advancedGroup.add(pathRow);
    }
}
